/**
 * Seller.IA — interceptor.js (mundo MAIN) · v0.1.0
 * Escuta as respostas que o Seller Centre ja entrega ao navegador
 * (fetch e XHR) e repassa ao coletor via CustomEvent.
 * Nao altera requisicoes. Nao automatiza acoes. So escuta.
 *
 * Rotas observadas:
 *   /api/pas/     -> Shopee Ads (campanhas, GMV Max, produtos, series)
 *   /api/mydata/  -> Informacoes Gerenciais (venda total, trafego, fontes)
 *   /api/v3/product/ e /api/marketing/ -> cadastro e programas (calibrar na beta)
 */
(function () {
  'use strict';

  var VERSAO = '0.8.0';
  // v0.2: observa TODA API da Shopee (qualquer host *.shopee.*), classificacao fica no coletor
  function observar(url) {
    if (!url) return false;
    if (url.indexOf('/api/') < 0 && url.indexOf('/datacenter/') < 0) return false;
    if (url.charAt(0) === '/') return true; // mesma origem (seller.shopee.com.br)
    return /^https:\/\/[^\/]*shopee\.[a-z.]+\//.test(url);
  }

  var coletorPronto = false;
  var fila = [];   // captura desde o milissegundo zero; despeja quando o coletor acordar
  var FILA_MAX = 400;

  function emitir(tipo, dados) {
    try {
      if (tipo === 'SIA_DADOS' && !coletorPronto) {
        if (fila.length < FILA_MAX) fila.push(dados);
        return;
      }
      window.dispatchEvent(new CustomEvent(tipo, { detail: JSON.stringify(dados) }));
    } catch (e) { /* silencioso */ }
  }

  function despejarFila() {
    coletorPronto = true;
    var pendentes = fila; fila = [];
    for (var i = 0; i < pendentes.length; i++) {
      try { window.dispatchEvent(new CustomEvent('SIA_DADOS', { detail: JSON.stringify(pendentes[i]) })); } catch (e) { /* noop */ }
    }
  }

  function urlDe(args) {
    try {
      if (typeof args[0] === 'string') return args[0];
      if (args[0] && args[0].url) return args[0].url;
    } catch (e) { /* noop */ }
    return '';
  }

  /* ---- fetch ---- */
  var fetchOriginal = window.fetch;
  // guarda os headers reais das chamadas mydata (pra reusar no coletor)
  var headersMydata = null;
  window.fetch = function () {
    var args = arguments;
    var url = urlDe(args);
    // captura headers de chamadas mydata reais (a Shopee exige alguns especificos)
    try {
      if (/\/api\/mydata\//.test(url) && args[1] && args[1].headers) {
        var h = args[1].headers;
        var capt = {};
        if (typeof h.forEach === 'function') { h.forEach(function (v, k) { capt[k] = v; }); }
        else { for (var k in h) capt[k] = h[k]; }
        if (Object.keys(capt).length) { headersMydata = capt; window.__SIA_HEADERS_MYDATA = capt; }
      }
    } catch (e) { /* noop */ }
    var promessa = fetchOriginal.apply(this, args);
    if (observar(url)) {
      var metodo = 'GET', corpo = null;
      try {
        if (args[1]) {
          if (args[1].method) metodo = String(args[1].method).toUpperCase();
          if (typeof args[1].body === 'string') corpo = args[1].body;
        }
      } catch (e) { /* noop */ }
      promessa.then(function (resp) {
        try {
          resp.clone().json().then(function (json) {
            emitir('SIA_DADOS', { url: url, metodo: metodo, corpo: corpo, dados: json, ts: Date.now() });
          }).catch(function () { /* resposta nao-JSON */ });
        } catch (e) { /* noop */ }
      }).catch(function () { /* noop */ });
    }
    return promessa;
  };

  /* ---- XHR ---- */
  var openOriginal = XMLHttpRequest.prototype.open;
  var sendOriginal = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (metodo, url) {
    this.__sia_url = url || '';
    this.__sia_metodo = metodo ? String(metodo).toUpperCase() : 'GET';
    return openOriginal.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (corpo) {
    var xhr = this;
    if (xhr.__sia_url && observar(xhr.__sia_url)) {
      xhr.addEventListener('load', function () {
        try {
          var json = JSON.parse(xhr.responseText);
          emitir('SIA_DADOS', {
            url: xhr.__sia_url,
            metodo: xhr.__sia_metodo,
            corpo: typeof corpo === 'string' ? corpo : null,
            dados: json,
            ts: Date.now()
          });
        } catch (e) { /* nao-JSON */ }
      });
    }
    return sendOriginal.apply(this, arguments);
  };

  /* ---- presenca ---- */
  window.addEventListener('SIA_PING', function () {
    emitir('SIA_PONG', { versao: VERSAO, represados: fila.length });
    despejarFila();
  });

  /* ---- ponte de busca ativa (coletor -> pagina, cookies da sessao) ----
   * Usada na cascata de resolucao por ID. Somente leitura, somente
   * rotas internas do Seller Centre, mesmo dominio. */
  window.addEventListener('SIA_BUSCAR', function (ev) {
    var req;
    try { req = JSON.parse(ev.detail); } catch (e) { return; }
    if (!req || !req.url || !req.id) return;
    var permitida = /^\/(api|datacenter)\//.test(req.url) ||
      /^https:\/\/seller\.shopee\.com\.br\/(api|datacenter)\//.test(req.url);
    // trava de escrita: qualquer rota com verbo de alteracao e recusada,
    // mesmo que um bug tente chama-la. A extensao NUNCA modifica a conta.
    if (/(update|save|edit|delete|create|set_|submit|publish|upload|modify|adjust|batch_operate)/i.test(req.url)) permitida = false;
    if (!permitida) {
      emitir('SIA_BUSCA_RESULTADO', { id: req.id, ok: false, erro: 'rota nao permitida' });
      return;
    }
    var opts = { method: req.metodo || 'GET', credentials: 'include', headers: { accept: 'application/json' } };
    // se for uma rota mydata e ja capturamos os headers reais da Shopee, reusa
    // (a Shopee exige headers especificos como x-traceid, x-region, etc)
    try {
      if (/\/api\/mydata\//.test(req.url) && headersMydata) {
        for (var hk in headersMydata) {
          var lk = hk.toLowerCase();
          // nao reusa content-length/host (o navegador recalcula)
          if (lk === 'content-length' || lk === 'host' || lk === 'cookie') continue;
          opts.headers[hk] = headersMydata[hk];
        }
      }
    } catch (e) { /* noop */ }
    if (opts.method !== 'GET' && req.corpo) {
      opts.headers['content-type'] = 'application/json';
      opts.body = req.corpo;
    }
    fetchOriginal(req.url, opts).then(function (r) {
      return r.json().then(function (json) {
        emitir('SIA_BUSCA_RESULTADO', { id: req.id, ok: r.ok, status: r.status, dados: json });
      });
    }).catch(function (err) {
      emitir('SIA_BUSCA_RESULTADO', { id: req.id, ok: false, erro: String(err) });
    });
  });
})();

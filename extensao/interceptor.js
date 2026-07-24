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

  var VERSAO = '0.1.0';
  var OBSERVA = /\/api\/(pas|mydata|v3\/product|marketing)\//;

  function emitir(tipo, dados) {
    try {
      window.dispatchEvent(new CustomEvent(tipo, { detail: JSON.stringify(dados) }));
    } catch (e) { /* silencioso */ }
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
  window.fetch = function () {
    var args = arguments;
    var url = urlDe(args);
    var promessa = fetchOriginal.apply(this, args);
    if (OBSERVA.test(url)) {
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
    if (xhr.__sia_url && OBSERVA.test(xhr.__sia_url)) {
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
    emitir('SIA_PONG', { versao: VERSAO });
  });

  /* ---- ponte de busca ativa (coletor -> pagina, cookies da sessao) ----
   * Usada na cascata de resolucao por ID. Somente leitura, somente
   * rotas internas do Seller Centre, mesmo dominio. */
  window.addEventListener('SIA_BUSCAR', function (ev) {
    var req;
    try { req = JSON.parse(ev.detail); } catch (e) { return; }
    if (!req || !req.url || !req.id) return;
    var permitida = /^\/api\/(pas|mydata|v3\/product|marketing)\//.test(req.url) ||
      /^https:\/\/seller\.shopee\.com\.br\/api\/(pas|mydata|v3\/product|marketing)\//.test(req.url);
    if (!permitida) {
      emitir('SIA_BUSCA_RESULTADO', { id: req.id, ok: false, erro: 'rota nao permitida' });
      return;
    }
    var opts = { method: req.metodo || 'GET', credentials: 'include', headers: { accept: 'application/json' } };
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

/**
 * Seller.IA — bg.js (service worker) · v0.6.0
 * Persistencia local + ponte com o Cerebro (Supabase Edge Function).
 * A chave abaixo e a ANON key (publica por desenho); as regras e os
 * segredos reais vivem no servidor. Licenciamento entra na Etapa 4.
 */
var SIA_CEREBRO_URL = 'https://mkfreezlizdbfpjjpxoo.supabase.co/functions/v1/cerebro';
var SIA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZnJlZXpsaXpkYmZwampweG9vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5MTczMTcsImV4cCI6MjEwMDQ5MzMxN30.ZavM7iPnecJdIfEyUMfStcShUEMjlUZf5GKfDaQ7zxQ';

function ler(chaves) { return new Promise(function (r) { chrome.storage.local.get(chaves, r); }); }
function gravar(obj) { return new Promise(function (r) { chrome.storage.local.set(obj, r); }); }

async function analisar(payload) {
  try {
    var r = await fetch(SIA_CEREBRO_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + SIA_ANON,
        'apikey': SIA_ANON
      },
      body: JSON.stringify(payload)
    });
    var data = null;
    try { data = await r.json(); } catch (e) { /* noop */ }
    if (!r.ok) return { ok: false, erro: (data && data.erro) || ('HTTP ' + r.status) };
    return data;
  } catch (e) {
    return { ok: false, erro: 'Cerebro Seller.IA indisponivel. Verifique a conexao.' };
  }
}

chrome.runtime.onMessage.addListener(function (msg, remetente, responder) {
  if (!msg || !msg.tipo) return;

  if (msg.tipo === 'sia:salvar') {
    // FUSAO: abas diferentes somam, nunca se apagam
    ler(['sia_coleta']).then(function (v) {
      var antigo = v.sia_coleta || {};
      var novo = msg.coleta || {};
      function fundirMapa(a, b) {
        var r = a || {};
        for (var k in (b || {})) {
          if (!r[k]) { r[k] = b[k]; continue; }
          var ra = r[k], rb = b[k];
          if (ra && rb && typeof ra === 'object' && typeof rb === 'object') {
            if ((rb.visto_em || 0) >= (ra.visto_em || 0)) {
              var met = Object.assign({}, ra.metricas || {}, rb.metricas || {});
              r[k] = Object.assign({}, ra, rb);
              r[k].metricas = met;
            } else {
              var met2 = Object.assign({}, rb.metricas || {}, ra.metricas || {});
              r[k] = Object.assign({}, rb, ra);
              r[k].metricas = met2;
            }
          } else r[k] = rb;
        }
        return r;
      }
      function fundirPainel(a, b) {
        a = a || { campos: {} }; b = b || { campos: {} };
        return {
          campos: Object.assign({}, a.campos || {}, b.campos || {}),
          atualizadoEm: Math.max(a.atualizadoEm || 0, b.atualizadoEm || 0) || null
        };
      }
      var fundido = {
        versao: novo.versao || antigo.versao,
        gerado_em: new Date().toISOString(),
        pagina: novo.pagina || antigo.pagina,
        auto_ts: Math.max(novo.auto_ts || 0, antigo.auto_ts || 0) || undefined,
        loja: novo.loja || antigo.loja,
        periodo_ads: novo.periodo_ads || antigo.periodo_ads,
        conta: fundirPainel(antigo.conta, novo.conta),
        afiliados: fundirPainel(antigo.afiliados, novo.afiliados),
        anuncio_publico: novo.anuncio_publico || antigo.anuncio_publico,
        cadastro: novo.cadastro || antigo.cadastro,
        campanhas: fundirMapa(antigo.campanhas, novo.campanhas),
        produtos: fundirMapa(antigo.produtos, novo.produtos)
      };
      gravar({ sia_coleta: fundido, sia_coleta_ts: Date.now() }).then(function () { responder({ ok: true }); });
    });
    return true;
  }
  if (msg.tipo === 'sia:carregar') {
    ler(['sia_coleta', 'sia_coleta_ts']).then(function (v) {
      responder({ ok: true, coleta: v.sia_coleta || null, ts: v.sia_coleta_ts || null });
    });
    return true;
  }
  if (msg.tipo === 'sia:limpar') {
    gravar({ sia_coleta: null, sia_coleta_ts: null, sia_diamantes: null }).then(function () { responder({ ok: true }); });
    return true;
  }

  // ---- DIAMANTES (Camada 1): fusao entre paginas/sites ----
  // Seller Central e Loja Shopee sao memorias separadas; aqui elas se somam.
  if (msg.tipo === 'sia:diamantes-salvar') {
    ler(['sia_diamantes']).then(function (v) {
      var a = v.sia_diamantes || {};
      var b = msg.cofre || {};
      function merge(x, y) { // y sobrescreve x campo a campo, sem apagar o que so existe em x
        var r = x || {};
        for (var k in (y || {})) {
          if (y[k] && typeof y[k] === 'object' && !Array.isArray(y[k]) && r[k] && typeof r[k] === 'object' && !Array.isArray(r[k])) {
            r[k] = merge(r[k], y[k]);
          } else if (y[k] !== undefined && y[k] !== null) {
            r[k] = y[k];
          }
        }
        return r;
      }
      // FINANCEIRO nao pode somar componentes duas vezes. Mantemos o cofre
      // que ja leu MAIS pedidos (mais completo); o outro e descartado.
      function fundirFinanceiro(x, y) {
        if (!x) return y || null;
        if (!y) return x;
        var nx = x.pedidosLidos ? Object.keys(x.pedidosLidos).length : (x.amostras || 0);
        var ny = y.pedidosLidos ? Object.keys(y.pedidosLidos).length : (y.amostras || 0);
        // se um leu pedidos que o outro nao tem, unimos os IDs e recontamos os que faltam.
        // simplificacao segura: fica com o mais completo (mais pedidos lidos).
        return ny >= nx ? y : x;
      }
      var fundido = {
        conta: merge(a.conta, b.conta),
        loja: merge(a.loja, b.loja),
        ads: merge(a.ads, b.ads),
        algoritmo: merge(a.algoritmo, b.algoritmo),
        incentivos: merge(a.incentivos, b.incentivos),
        gerenciais: merge(a.gerenciais, b.gerenciais),
        funil: merge(a.funil, b.funil),
        afiliados: merge(a.afiliados, b.afiliados),
        financeiro: fundirFinanceiro(a.financeiro, b.financeiro),
        porProduto: merge(a.porProduto, b.porProduto),
        porCampanha: merge(a.porCampanha, b.porCampanha),
        busca: merge(a.busca, b.busca),
        _atualizado: Date.now()
      };
      gravar({ sia_diamantes: fundido }).then(function () { responder({ ok: true }); });
    });
    return true;
  }
  if (msg.tipo === 'sia:diamantes-carregar') {
    ler(['sia_diamantes']).then(function (v) { responder({ ok: true, cofre: v.sia_diamantes || null }); });
    return true;
  }
  // ---- BUSCA PUBLICA (Espiao) ----
  // O fetch precisa sair do service worker: o content script roda em
  // seller.shopee.com.br e a busca vive em shopee.com.br (origem diferente).
  // O host_permissions do manifest cobre os dois, entao aqui passa com cookie.
  if (msg.tipo === 'sia:busca-publica') {
    (async function () {
      var kw = String(msg.termo || '').trim();
      if (!kw) { responder({ ok: false, erro: 'Digite um termo para espiar.' }); return; }
      var url = 'https://shopee.com.br/api/v4/search/search_items' +
        '?by=relevancy&keyword=' + encodeURIComponent(kw) +
        '&limit=60&newest=0&order=desc&page_type=search' +
        '&scenario=PAGE_GLOBAL_SEARCH&version=2';
      try {
        var r = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'x-api-source': 'pc',
            'x-shopee-language': 'pt-BR',
            'af-ac-enc-dat': ''
          }
        });
        var j = null;
        try { j = await r.json(); } catch (e) { /* noop */ }
        if (!r.ok) { responder({ ok: false, erro: 'A Shopee respondeu HTTP ' + r.status + '. Abra shopee.com.br logado numa aba e tente de novo.' }); return; }
        var itens = (j && j.items) || [];
        if (!itens.length) { responder({ ok: false, erro: 'Busca sem resultados para "' + kw + '".' }); return; }
        responder({ ok: true, termo: kw, itens: itens });
      } catch (e) {
        responder({ ok: false, erro: 'Nao consegui alcancar a busca da Shopee. Verifique a conexao.' });
      }
    })();
    return true;
  }

  if (msg.tipo === 'sia:analisar') {
    analisar(msg.payload).then(responder);
    return true;
  }
});

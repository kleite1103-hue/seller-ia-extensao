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

/* ===================== BUSCA PUBLICA (Espiao) =====================
   POR QUE NAO DA PRA BUSCAR DIRETO DAQUI: o service worker nao tem
   origem. A chamada sai sem Referer, sem Origin e com sec-fetch-site
   cross-site — e o WAF da Shopee devolve 403. A vitrine so responde
   pra quem parece estar navegando nela.
   SOLUCAO: o bg acha (ou abre, em segundo plano) uma aba shopee.com.br
   e pede pro content script de la fazer o fetch. Ali e same-origin,
   com cookie e Referer certos — igual quando voce pesquisa na mao.
   A aba fica guardada e e reaproveitada pelas 6 buscas do Radar. */
var SIA_ABA_BUSCA = null;

function urlBusca(kw) {
  return 'https://shopee.com.br/api/v4/search/search_items' +
    '?by=relevancy&keyword=' + encodeURIComponent(kw) +
    '&limit=60&newest=0&order=desc&page_type=search' +
    '&scenario=PAGE_GLOBAL_SEARCH&version=2';
}
function abaViva(id) {
  return new Promise(function (r) {
    if (!id) return r(false);
    chrome.tabs.get(id, function (t) { void chrome.runtime.lastError; r(!!(t && t.url && t.url.indexOf('shopee.com.br') >= 0)); });
  });
}
function acharAba() {
  return new Promise(function (r) {
    chrome.tabs.query({ url: 'https://shopee.com.br/*' }, function (tabs) {
      void chrome.runtime.lastError;
      r(tabs && tabs.length ? tabs[0] : null);
    });
  });
}
function abrirAba(kw) {
  return new Promise(function (r) {
    chrome.tabs.create({ url: 'https://shopee.com.br/search?keyword=' + encodeURIComponent(kw), active: false }, function (t) {
      void chrome.runtime.lastError;
      if (!t) return r(null);
      var pronto = false;
      function ouvir(id, info) {
        if (id !== t.id || info.status !== 'complete' || pronto) return;
        pronto = true;
        chrome.tabs.onUpdated.removeListener(ouvir);
        setTimeout(function () { r(t); }, 1800); // deixa o content script subir
      }
      chrome.tabs.onUpdated.addListener(ouvir);
      setTimeout(function () { if (!pronto) { pronto = true; chrome.tabs.onUpdated.removeListener(ouvir); r(t); } }, 15000);
    });
  });
}
function pedirNaAba(id, kw) {
  return new Promise(function (r) {
    var respondeu = false;
    chrome.tabs.sendMessage(id, { tipo: 'sia:busca-no-site', termo: kw, url: urlBusca(kw) }, function (resp) {
      void chrome.runtime.lastError;
      if (!respondeu) { respondeu = true; r(resp || null); }
    });
    setTimeout(function () { if (!respondeu) { respondeu = true; r(null); } }, 20000);
  });
}
async function buscaPublica(kw) {
  if (!kw) return { ok: false, erro: 'Digite um termo para espiar.' };
  var aba = null;
  if (await abaViva(SIA_ABA_BUSCA)) aba = { id: SIA_ABA_BUSCA };
  if (!aba) aba = await acharAba();
  if (!aba) aba = await abrirAba(kw);
  if (!aba) return { ok: false, erro: 'Nao consegui abrir a vitrine da Shopee em segundo plano.' };
  SIA_ABA_BUSCA = aba.id;

  var resp = await pedirNaAba(aba.id, kw);
  // Aba antiga sem o content script novo? Abre uma limpa e tenta de novo.
  if (!resp) {
    var nova = await abrirAba(kw);
    if (nova) { SIA_ABA_BUSCA = nova.id; resp = await pedirNaAba(nova.id, kw); }
  }
  if (!resp) return { ok: false, erro: 'A aba da vitrine nao respondeu. Deixe uma aba em shopee.com.br aberta e logada, e tente de novo.' };
  return resp;
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
  if (msg.tipo === 'sia:busca-publica') {
    buscaPublica(String(msg.termo || '').trim()).then(responder);
    return true;
  }

  if (msg.tipo === 'sia:analisar') {
    analisar(msg.payload).then(responder);
    return true;
  }
});

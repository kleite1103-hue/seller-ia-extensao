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
   POR QUE O 403: a rota de busca da Shopee exige headers de antifraude
   (af-ac-enc-dat, x-sap-ri, x-sap-sec) gerados pelo JS dela. Qualquer
   chamada que a gente monte — do service worker ou de dentro da propria
   pagina — cai no WAF. Nao era login e nao era origem.
   COMO FICOU: nao chamamos nada. Abrimos a pagina de busca numa aba em
   segundo plano, a Shopee faz a chamada assinada dela mesma, e o nosso
   interceptor escuta a resposta. E o mesmo principio clean-room do resto
   da extensao: nunca fabricamos requisicao, so lemos o que ja passou.
   A aba fica guardada e e reaproveitada pelas 6 buscas do Radar. */
var SIA_ABA_BUSCA = null;
var SIA_PEND = {};

function normKw(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

function abaViva(id) {
  return new Promise(function (r) {
    if (!id) return r(false);
    chrome.tabs.get(id, function (t) { void chrome.runtime.lastError; r(!!t); });
  });
}
function criarAba(url) {
  return new Promise(function (r) {
    chrome.tabs.create({ url: url, active: false }, function (t) { void chrome.runtime.lastError; r(t || null); });
  });
}

async function buscaPublica(kw) {
  if (!kw) return { ok: false, erro: 'Digite um termo para espiar.' };
  var chave = normKw(kw);
  var alvo = 'https://shopee.com.br/search?keyword=' + encodeURIComponent(kw);

  var espera = new Promise(function (res) {
    var t = setTimeout(function () {
      if (SIA_PEND[chave]) {
        delete SIA_PEND[chave];
        res({ ok: false, erro: 'A vitrine nao devolveu "' + kw + '" em 40s. Confira se voce esta logada em shopee.com.br.' });
      }
    }, 40000);
    SIA_PEND[chave] = { res: res, t: t };
  });

  // So reaproveita a aba que NOS abrimos. Nunca sequestra aba da usuaria.
  var viva = await abaViva(SIA_ABA_BUSCA);
  if (viva) {
    chrome.tabs.update(SIA_ABA_BUSCA, { url: alvo }, function () { void chrome.runtime.lastError; });
  } else {
    var nova = await criarAba(alvo);
    if (!nova) {
      if (SIA_PEND[chave]) { clearTimeout(SIA_PEND[chave].t); delete SIA_PEND[chave]; }
      return { ok: false, erro: 'Nao consegui abrir a vitrine em segundo plano.' };
    }
    SIA_ABA_BUSCA = nova.id;
  }
  return espera;
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
  // o interceptor viu a busca que a propria Shopee fez e mandou pra ca
  if (msg.tipo === 'sia:busca-capturada') {
    var ch = normKw(msg.termo);
    var alvo = SIA_PEND[ch];
    if (alvo) {
      clearTimeout(alvo.t); delete SIA_PEND[ch];
      alvo.res({ ok: true, termo: msg.termo, itens: msg.itens || [] });
    }
    responder({ ok: true });
    return true;
  }

  // ---- SNAPSHOT POR CONTA (multiconta de agencia) ----
  // Tres travas: so a camada compacta, no maximo MAX_CONTAS lojas, e expira
  // em DIAS_VALIDADE. Dado da Shopee e D-1: passou de uma semana ninguem quer
  // o numero velho de volta, quer coletar de novo.
  var MAX_CONTAS = 40;
  var DIAS_VALIDADE = 7;

  if (msg.tipo === 'sia:conta-salvar') {
    (async function () {
      var chave = 'sia_conta_' + msg.loja;
      var pacote = {}; pacote[chave] = { em: Date.now(), dados: msg.dados || {} };
      await gravar(pacote);
      // limpeza: derruba expirado e o excedente mais antigo
      try {
        var tudo = await ler(null);
        var lojas = [];
        var limite = Date.now() - DIAS_VALIDADE * 86400000;
        var apagar = [];
        for (var k in tudo) {
          if (k.indexOf('sia_conta_') !== 0) continue;
          var em = (tudo[k] && tudo[k].em) || 0;
          if (em < limite) apagar.push(k); else lojas.push({ k: k, em: em });
        }
        lojas.sort(function (a, b) { return b.em - a.em; });
        for (var i = MAX_CONTAS; i < lojas.length; i++) apagar.push(lojas[i].k);
        if (apagar.length) await new Promise(function (r) { chrome.storage.local.remove(apagar, r); });
      } catch (_e) { /* noop */ }
      responder({ ok: true });
    })();
    return true;
  }
  if (msg.tipo === 'sia:conta-carregar') {
    (async function () {
      var chave = 'sia_conta_' + msg.loja;
      var v = await ler([chave]);
      var g = v[chave];
      if (!g || (Date.now() - (g.em || 0)) > DIAS_VALIDADE * 86400000) { responder({ ok: true, dados: null }); return; }
      responder({ ok: true, dados: g.dados, em: g.em });
    })();
    return true;
  }
  if (msg.tipo === 'sia:contas-limpar') {
    (async function () {
      var tudo = await ler(null), apagar = [];
      for (var k in tudo) if (k.indexOf('sia_conta_') === 0 || k.indexOf('sia_cofre_') === 0) apagar.push(k);
      await new Promise(function (r) { chrome.storage.local.remove(apagar, r); });
      responder({ ok: true, apagadas: apagar.length });
    })();
    return true;
  }

  // ---- PREFERENCIAS ----
  if (msg.tipo === 'sia:pref-salvar') {
    var op = {}; op['sia_pref_' + msg.chave] = msg.valor;
    gravar(op).then(function () { responder({ ok: true }); });
    return true;
  }
  if (msg.tipo === 'sia:pref-carregar') {
    var ck = 'sia_pref_' + msg.chave;
    ler([ck]).then(function (v) { responder({ ok: true, valor: v[ck] }); });
    return true;
  }

  // ---- COFRE DE CUSTOS (por loja) ----
  if (msg.tipo === 'sia:cofre-salvar') {
    var ch = 'sia_cofre_' + (msg.loja || 'sem_loja');
    var o = {}; o[ch] = msg.cofre || {};
    gravar(o).then(function () { responder({ ok: true }); });
    return true;
  }
  if (msg.tipo === 'sia:cofre-carregar') {
    var ch2 = 'sia_cofre_' + (msg.loja || 'sem_loja');
    ler([ch2]).then(function (v) { responder({ ok: true, cofre: v[ch2] || null }); });
    return true;
  }

  if (msg.tipo === 'sia:analisar') {
    analisar(msg.payload).then(responder);
    return true;
  }
});

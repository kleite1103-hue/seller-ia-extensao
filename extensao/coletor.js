/**
 * Seller.IA — coletor.js · v0.2.0 (beta interna)
 * v0.2: garimpo com heranca de ID (metricas em objetos filhos passam a ser
 * atribuidas ao dono), leitura de Afiliados e de Performance de Produto
 * (funil), coercao de numeros em string e sacola de campos crus por produto
 * para calibragem.
 */
(function () {
  'use strict';
  if (window.__SIA_ATIVO__) return;
  window.__SIA_ATIVO__ = true;

  var VERSAO = '0.2.0';
  var MICRO = 100000;

  /* =============================== ESTADO =============================== */
  var estado = {
    interceptorVersao: null,
    chamadas: [],
    brutos: [],
    campanhas: {},
    produtos: {},
    conta: { campos: {}, atualizadoEm: null },
    afiliados: { campos: {}, atualizadoEm: null },
    paginaProduto: null,
    sujo: false
  };
  var LIMITE_BRUTOS = 200;
  var LIMITE_CHAMADAS = 500;
  var LIMITE_CAMPOS_PRODUTO = 60;

  /* ============================ NORMALIZACAO ============================ */
  var MAPA = {
    impression: 'impressoes', impressions: 'impressoes', imps: 'impressoes', impression_cnt: 'impressoes',
    click: 'cliques', clicks: 'cliques', click_cnt: 'cliques',
    ctr: 'ctr',
    cost: 'gasto', expense: 'gasto', spend: 'gasto', expenditure: 'gasto', cost_amount: 'gasto',
    gmv: 'gmv', broad_gmv: 'gmv', sales_amount: 'gmv', gmv_amount: 'gmv',
    direct_gmv: 'gmv_direto',
    order: 'pedidos', orders: 'pedidos', broad_order: 'pedidos', broad_order_amount: 'pedidos',
    checkout: 'pedidos', order_cnt: 'pedidos', placed_order_cnt: 'pedidos', paid_order_cnt: 'pedidos_pagos',
    conversions: 'pedidos', direct_order: 'pedidos_direto',
    roas: 'roas', broad_roas: 'roas', direct_roas: 'roas_direto',
    cr: 'conversao', conversion_rate: 'conversao', cvr: 'conversao', placed_cr: 'conversao',
    avg_rank: 'posicao', avg_ranking: 'posicao', rank: 'posicao',
    cpc: 'cpc', cpm: 'cpm', acos: 'acos',
    daily_budget: 'orcamento_dia', budget: 'orcamento', total_budget: 'orcamento',
    /* funil / datacenter */
    uv: 'visitantes', unique_visitors: 'visitantes', visitor: 'visitantes', visitors: 'visitantes', product_visitors: 'visitantes',
    pv: 'visualizacoes', page_views: 'visualizacoes', product_page_views: 'visualizacoes',
    add_to_cart_uv: 'carrinho', add_to_cart: 'carrinho', atc_uv: 'carrinho', cart_uv: 'carrinho',
    like_cnt: 'curtidas', likes: 'curtidas',
    bounce_rate: 'rejeicao',
    /* afiliados */
    commission: 'comissao', commission_amount: 'comissao', est_commission: 'comissao'
  };
  var CAMPOS_DINHEIRO = { gasto: 1, gmv: 1, gmv_direto: 1, cpc: 1, cpm: 1, orcamento: 1, orcamento_dia: 1, comissao: 1 };
  var CAMPOS_ID_PRODUTO = ['itemid', 'item_id', 'product_id', 'productid'];
  var CAMPOS_ID_CAMPANHA = ['campaignid', 'campaign_id'];
  var CAMPOS_NOME = ['name', 'title', 'campaign_name', 'item_name', 'product_name', 'shop_item_name'];

  function numero(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v !== '' && /^-?\d+([.,]\d+)?%?$/.test(v.trim())) {
      var s = v.trim().replace('%', '').replace(',', '.');
      var n = parseFloat(s);
      if (isFinite(n)) return n;
    }
    // padrao { value: n }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      var chaves = Object.keys(v);
      if (chaves.length <= 3 && v.value !== undefined) return numero(v.value);
    }
    return null;
  }

  function dinheiro(v) {
    if (v === null) return null;
    if (Number.isInteger(v) && Math.abs(v) >= 1000) return v / MICRO;
    return v;
  }

  function extrairMetricas(obj) {
    var m = {};
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var chave = MAPA[k.toLowerCase()];
      if (!chave) continue;
      var v = numero(obj[k]);
      if (v === null) continue;
      m[chave] = CAMPOS_DINHEIRO[chave] ? dinheiro(v) : v;
    }
    return m;
  }

  function camposNumericos(obj, saida) {
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = numero(obj[k]);
      if (v !== null && Object.keys(saida).length < LIMITE_CAMPOS_PRODUTO) saida[k] = v;
    }
  }

  function acharCampo(obj, lista) {
    for (var i = 0; i < lista.length; i++) {
      var k = lista[i];
      if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    }
    return null;
  }

  function entidadeProduto(id) {
    if (!estado.produtos[id]) estado.produtos[id] = { id: id, metricas: {}, campos: {} };
    return estado.produtos[id];
  }
  function entidadeCampanha(id) {
    if (!estado.campanhas[id]) estado.campanhas[id] = { id: id, metricas: {} };
    return estado.campanhas[id];
  }

  /* Garimpo v2 com HERANCA: o ID do pai vale para os filhos.
     {campaignid, report:{impression,...}} agora atribui certo. */
  function garimpar(no, ctx) {
    if (!no || typeof no !== 'object') return;
    if (Array.isArray(no)) {
      for (var i = 0; i < no.length; i++) garimpar(no[i], ctx);
      return;
    }
    var idProd = acharCampo(no, CAMPOS_ID_PRODUTO);
    var idCamp = acharCampo(no, CAMPOS_ID_CAMPANHA);
    var nome = acharCampo(no, CAMPOS_NOME);

    var novoCtx = {
      tag: ctx.tag,
      idProd: idProd !== null ? String(idProd) : ctx.idProd,
      idCamp: idCamp !== null ? String(idCamp) : ctx.idCamp,
      nome: (typeof nome === 'string' && nome.length > 1) ? nome : ctx.nome
    };

    var metricas = extrairMetricas(no);
    if (Object.keys(metricas).length) {
      if (novoCtx.idProd) {
        var p = entidadeProduto(novoCtx.idProd);
        for (var mk in metricas) p.metricas[mk] = metricas[mk];
        if (novoCtx.nome) p.nome = novoCtx.nome;
        if (novoCtx.idCamp) p.campanha = novoCtx.idCamp;
        p.origem = ctx.tag; p.visto_em = Date.now();
        if (ctx.tag === 'performance') camposNumericos(no, p.campos);
        estado.sujo = true;
      } else if (novoCtx.idCamp) {
        var c = entidadeCampanha(novoCtx.idCamp);
        for (var ck in metricas) c.metricas[ck] = metricas[ck];
        if (novoCtx.nome) c.nome = novoCtx.nome;
        c.origem = ctx.tag; c.visto_em = Date.now();
        estado.sujo = true;
      }
    } else if (novoCtx.idProd && novoCtx.nome && (idProd !== null || nome)) {
      // objeto so com identidade: registra nome/campanha mesmo sem metrica
      var p2 = entidadeProduto(novoCtx.idProd);
      if (novoCtx.nome) p2.nome = novoCtx.nome;
      if (novoCtx.idCamp) p2.campanha = novoCtx.idCamp;
      estado.sujo = true;
    }

    for (var k in no) {
      var v = no[k];
      if (v && typeof v === 'object') garimpar(v, novoCtx);
    }
  }

  function achatar(no, prefixo, saida, prof) {
    if (!no || typeof no !== 'object' || prof > 4) return;
    if (Array.isArray(no)) { for (var i = 0; i < Math.min(no.length, 20); i++) achatar(no[i], prefixo + '[' + i + ']', saida, prof + 1); return; }
    for (var k in no) {
      var v = no[k];
      var nomeC = prefixo ? prefixo + '.' + k : k;
      var n = numero(v);
      if (n !== null && typeof v !== 'object') saida[nomeC] = n;
      else if (v && typeof v === 'object') achatar(v, nomeC, saida, prof + 1);
    }
  }

  function absorverPainel(json, alvo) {
    var campos = {};
    achatar(json && json.data !== undefined ? json.data : json, '', campos, 0);
    if (Object.keys(campos).length) {
      for (var k in campos) alvo.campos[k] = campos[k];
      alvo.atualizadoEm = Date.now();
      estado.sujo = true;
    }
  }

  function classificar(url) {
    if (url.indexOf('/api/pas/') >= 0) return 'ads';
    if (url.indexOf('affiliate') >= 0) return 'afiliados';
    if (url.indexOf('datacenter') >= 0 || url.indexOf('product/performance') >= 0) return 'performance';
    if (url.indexOf('/api/mydata/') >= 0) return 'conta';
    if (url.indexOf('/api/v3/product/') >= 0 || url.indexOf('/api/v4/product/') >= 0) return 'cadastro';
    if (url.indexOf('/api/marketing/') >= 0) return 'marketing';
    return 'outra';
  }

  /* ============================== RECEPCAO ============================== */
  window.addEventListener('SIA_DADOS', function (ev) {
    var pacote;
    try { pacote = JSON.parse(ev.detail); } catch (e) { return; }
    if (!pacote || !pacote.url) return;
    var tag = classificar(pacote.url);
    var tamanho = 0;
    try { tamanho = JSON.stringify(pacote.dados).length; } catch (e) { /* noop */ }

    estado.chamadas.unshift({ ts: pacote.ts, url: pacote.url, metodo: pacote.metodo, tag: tag, tamanho: tamanho });
    if (estado.chamadas.length > LIMITE_CHAMADAS) estado.chamadas.length = LIMITE_CHAMADAS;

    estado.brutos.unshift({ ts: pacote.ts, url: pacote.url, metodo: pacote.metodo, corpo: pacote.corpo, dados: pacote.dados });
    if (estado.brutos.length > LIMITE_BRUTOS) estado.brutos.length = LIMITE_BRUTOS;

    if (tag === 'conta') { absorverPainel(pacote.dados, estado.conta); garimpar(pacote.dados, { tag: tag }); }
    else if (tag === 'afiliados') { absorverPainel(pacote.dados, estado.afiliados); garimpar(pacote.dados, { tag: tag }); }
    else if (tag === 'outra') { /* so registra no debug */ }
    else garimpar(pacote.dados, { tag: tag });
    estado.sujo = true;
  });

  window.addEventListener('SIA_PONG', function (ev) {
    try { estado.interceptorVersao = JSON.parse(ev.detail).versao; } catch (e) { /* noop */ }
  });
  try { window.dispatchEvent(new CustomEvent('SIA_PING')); } catch (e) { /* noop */ }

  function detectarPaginaProduto() {
    var m = location.pathname.match(/\/portal\/product\/(\d{6,})/) || location.search.match(/[?&](?:item_?id|product_?id)=(\d{6,})/);
    estado.paginaProduto = m ? m[1] : null;
  }
  detectarPaginaProduto();
  setInterval(detectarPaginaProduto, 1500);

  /* ============================ PERSISTENCIA ============================ */
  function fotoDoEstado() {
    return {
      versao: VERSAO,
      gerado_em: new Date().toISOString(),
      pagina: location.href,
      conta: estado.conta,
      afiliados: estado.afiliados,
      campanhas: estado.campanhas,
      produtos: estado.produtos
    };
  }
  setInterval(function () {
    if (!estado.sujo) return;
    try {
      chrome.runtime.sendMessage({ tipo: 'sia:salvar', coleta: fotoDoEstado() }, function () { void chrome.runtime.lastError; });
    } catch (e) { /* noop */ }
  }, 5000);
  try {
    chrome.runtime.sendMessage({ tipo: 'sia:carregar' }, function (resp) {
      void chrome.runtime.lastError;
      if (resp && resp.coleta) {
        estado.conta = resp.coleta.conta || estado.conta;
        estado.afiliados = resp.coleta.afiliados || estado.afiliados;
        estado.campanhas = resp.coleta.campanhas || {};
        estado.produtos = resp.coleta.produtos || {};
        estado.sujo = true;
      }
    });
  } catch (e) { /* noop */ }

  /* ================================ UI ================================= */
  var host = document.createElement('div');
  host.id = 'seller-ia-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;bottom:0;right:0;';
  document.documentElement.appendChild(host);
  var raiz = host.attachShadow({ mode: 'closed' });

  var LOGO = '<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff4d1c"/><stop offset="1" stop-color="#7B2FFF"/></linearGradient></defs><rect x="4" y="4" width="120" height="120" rx="30" fill="#07080a"/><rect x="4" y="4" width="120" height="120" rx="30" fill="none" stroke="url(#g)" stroke-width="5"/><path d="M 90 38 H 56 a 17 17 0 0 0 0 34 h 16 a 17 17 0 0 1 0 34 H 38" fill="none" stroke="url(#g)" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/><circle cx="93" cy="99" r="9" fill="#ff4d1c"/></svg>';

  raiz.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif}' +
    '.botao{position:fixed;bottom:22px;right:22px;width:52px;height:52px;border-radius:50%;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.45);transition:transform .15s;background:#07080a;border:none;padding:6px}' +
    '.botao:hover{transform:scale(1.08)}' +
    '.botao svg{width:100%;height:100%}' +
    '.painel{position:fixed;bottom:86px;right:22px;width:min(820px,95vw);height:min(620px,82vh);background:#0c0e12;border:1px solid #1d212a;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.6);display:none;flex-direction:column;overflow:hidden;color:#f2f2f4}' +
    '.painel.aberto{display:flex}' +
    '.cab{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #1d212a;background:#07080a}' +
    '.cab svg{width:26px;height:26px;flex:none}' +
    '.cab .titulo{font-weight:700;font-size:14px;letter-spacing:.04em}' +
    '.cab .titulo em{font-style:normal;color:#ff4d1c}' +
    '.cab .info{font-size:10px;color:#7d8290;margin-left:6px}' +
    '.cab .acoes{margin-left:auto;display:flex;gap:8px}' +
    '.cab button{background:#12151b;border:1px solid #1d212a;color:#b8bcc6;font-size:11px;padding:5px 10px;border-radius:6px;cursor:pointer}' +
    '.cab button:hover{border-color:#ff4d1c;color:#fff}' +
    '.abas{display:flex;gap:2px;background:#07080a;padding:0 10px;border-bottom:1px solid #1d212a;overflow-x:auto}' +
    '.aba{background:none;border:none;color:#7d8290;font-size:12px;font-weight:600;padding:10px 12px;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}' +
    '.aba.ativa{color:#fff;border-bottom-color:#ff4d1c}' +
    '.corpo{flex:1;overflow:auto;padding:14px 16px}' +
    'table{width:100%;border-collapse:collapse;font-size:12px}' +
    'th{text-align:left;color:#7d8290;font-size:10px;text-transform:uppercase;letter-spacing:.08em;padding:7px 8px;border-bottom:1px solid #ff4d1c;position:sticky;top:-14px;background:#0c0e12}' +
    'td{padding:7px 8px;border-bottom:1px solid #1d212a;color:#b8bcc6;white-space:nowrap}' +
    'td.nome{white-space:normal;min-width:160px;color:#f2f2f4}' +
    'tr:hover td{background:#12151b}' +
    '.num{text-align:right;font-variant-numeric:tabular-nums}' +
    '.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px}' +
    '.kpi{background:#12151b;border:1px solid #1d212a;border-radius:10px;padding:12px}' +
    '.kpi .v{font-size:20px;font-weight:700;color:#ff4d1c}' +
    '.kpi .l{font-size:10px;color:#7d8290;margin-top:4px;text-transform:uppercase;letter-spacing:.06em}' +
    '.vazio{color:#7d8290;font-size:13px;line-height:1.6;padding:30px 10px;text-align:center}' +
    '.selo{display:inline-block;font-size:9px;letter-spacing:.08em;text-transform:uppercase;border:1px solid #1d212a;border-radius:99px;padding:2px 8px;color:#7d8290;margin-left:8px}' +
    '.selo.ok{border-color:#2ecc71;color:#2ecc71}' +
    '.selo.off{border-color:#e74c3c;color:#e74c3c}' +
    '.nota{font-size:11px;color:#7d8290;margin:10px 0;line-height:1.5}' +
    '.tag-ads{color:#ff4d1c}.tag-conta{color:#7B2FFF}.tag-cadastro{color:#2ecc71}.tag-marketing{color:#f5b041}.tag-outra{color:#7d8290}.tag-afiliados{color:#e91e8c}.tag-performance{color:#3ab7f5}' +
    '</style>' +
    '<button class="botao" id="sia-abrir" title="Seller.IA">' + LOGO + '</button>' +
    '<div class="painel" id="sia-painel">' +
    '  <div class="cab">' + LOGO +
    '    <span class="titulo">SELLER<em>.IA</em> COLETOR</span>' +
    '    <span class="info" id="sia-info"></span>' +
    '    <div class="acoes">' +
    '      <button id="sia-exportar">Exportar coleta</button>' +
    '      <button id="sia-limpar">Limpar</button>' +
    '      <button id="sia-fechar">Fechar</button>' +
    '    </div>' +
    '  </div>' +
    '  <div class="abas" id="sia-abas"></div>' +
    '  <div class="corpo" id="sia-corpo"></div>' +
    '</div>';

  var $ = function (id) { return raiz.getElementById(id); };
  var abaAtiva = 'visao';
  var ABAS = [
    { id: 'visao', rotulo: 'Visao da Conta' },
    { id: 'campanhas', rotulo: 'Campanhas' },
    { id: 'produtos', rotulo: 'Produtos (Ads)' },
    { id: 'performance', rotulo: 'Performance' },
    { id: 'afiliados', rotulo: 'Afiliados' },
    { id: 'cadastro', rotulo: 'Cadastro' },
    { id: 'debug', rotulo: 'Debug' }
  ];

  $('sia-abrir').addEventListener('click', function () { $('sia-painel').classList.toggle('aberto'); render(); });
  $('sia-fechar').addEventListener('click', function () { $('sia-painel').classList.remove('aberto'); });
  $('sia-limpar').addEventListener('click', function () {
    estado.campanhas = {}; estado.produtos = {};
    estado.conta = { campos: {}, atualizadoEm: null };
    estado.afiliados = { campos: {}, atualizadoEm: null };
    estado.chamadas = []; estado.brutos = []; estado.sujo = true;
    try { chrome.runtime.sendMessage({ tipo: 'sia:limpar' }, function () { void chrome.runtime.lastError; }); } catch (e) { /* noop */ }
    render();
  });
  $('sia-exportar').addEventListener('click', function () {
    var pacote = fotoDoEstado();
    pacote.chamadas = estado.chamadas;
    pacote.brutos = estado.brutos;
    var blob = new Blob([JSON.stringify(pacote, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'seller-ia-coleta-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  });

  /* ------------------------------ render ------------------------------ */
  function fmt(n, casas) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return n.toLocaleString('pt-BR', { minimumFractionDigits: casas || 0, maximumFractionDigits: casas || 0 });
  }
  function reais(n) { return n === null || n === undefined ? '—' : 'R$ ' + fmt(n, 2); }
  function hora(ts) { var d = new Date(ts); return d.toTimeString().slice(0, 8); }
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; }); }

  function somaProdutos() {
    var t = { gasto: 0, gmv: 0, cliques: 0, impressoes: 0, pedidos: 0, n: 0 };
    for (var id in estado.produtos) {
      var m = estado.produtos[id].metricas;
      t.gasto += m.gasto || 0; t.gmv += m.gmv || 0;
      t.cliques += m.cliques || 0; t.impressoes += m.impressoes || 0;
      t.pedidos += m.pedidos || 0; t.n++;
    }
    return t;
  }

  function renderAbas() {
    var h = '';
    for (var i = 0; i < ABAS.length; i++) {
      var a = ABAS[i];
      h += '<button class="aba' + (a.id === abaAtiva ? ' ativa' : '') + '" data-aba="' + a.id + '">' + a.rotulo + '</button>';
    }
    $('sia-abas').innerHTML = h;
    var botoes = $('sia-abas').querySelectorAll('.aba');
    for (var b = 0; b < botoes.length; b++) {
      botoes[b].addEventListener('click', function () { abaAtiva = this.getAttribute('data-aba'); render(); });
    }
  }

  function linhaMetrica(m) {
    var roas = m.roas !== undefined ? m.roas : (m.gasto ? (m.gmv || 0) / m.gasto : null);
    var ctr = m.ctr !== undefined ? (m.ctr <= 1 ? m.ctr * 100 : m.ctr) : (m.impressoes ? (m.cliques || 0) / m.impressoes * 100 : null);
    return '<td class="num">' + reais(m.gasto) + '</td><td class="num">' + reais(m.gmv) + '</td>' +
      '<td class="num">' + (roas === null ? '—' : fmt(roas, 2) + 'x') + '</td>' +
      '<td class="num">' + fmt(m.impressoes) + '</td><td class="num">' + fmt(m.cliques) + '</td>' +
      '<td class="num">' + (ctr === null ? '—' : fmt(ctr, 2) + '%') + '</td>' +
      '<td class="num">' + fmt(m.pedidos) + '</td>' +
      '<td class="num">' + (m.posicao === undefined ? '—' : fmt(m.posicao, 1)) + '</td>';
  }

  function tabelaCampos(campos, atualizadoEm, titulo) {
    var chaves = Object.keys(campos);
    if (!chaves.length) return null;
    var h = '<div class="nota">' + titulo + ' (' + (atualizadoEm ? hora(atualizadoEm) : '') + ') — nomes crus da API, calibramos juntos na beta:</div>';
    h += '<table><tr><th>Campo</th><th class="num">Valor</th></tr>';
    chaves.sort();
    for (var i = 0; i < Math.min(chaves.length, 80); i++) {
      var c = chaves[i];
      h += '<tr><td class="nome">' + esc(c) + '</td><td class="num">' + fmt(campos[c], 2) + '</td></tr>';
    }
    return h + '</table>';
  }

  function render() {
    if (!$('sia-painel').classList.contains('aberto')) return;
    renderAbas();
    var corpo = $('sia-corpo');
    var nC = Object.keys(estado.campanhas).length;
    var nP = Object.keys(estado.produtos).length;
    $('sia-info').textContent = nC + ' campanhas · ' + nP + ' produtos · ' + estado.chamadas.length + ' chamadas';

    if (abaAtiva === 'visao') {
      var t = somaProdutos();
      var h = '<div class="kpis">' +
        '<div class="kpi"><div class="v">' + reais(t.gasto) + '</div><div class="l">Gasto (ads lidos)</div></div>' +
        '<div class="kpi"><div class="v">' + reais(t.gmv) + '</div><div class="l">GMV (ads lidos)</div></div>' +
        '<div class="kpi"><div class="v">' + (t.gasto ? fmt(t.gmv / t.gasto, 2) + 'x' : '—') + '</div><div class="l">ROAS blended</div></div>' +
        '<div class="kpi"><div class="v">' + fmt(t.pedidos) + '</div><div class="l">Pedidos via ads</div></div>' +
        '<div class="kpi"><div class="v">' + t.n + '</div><div class="l">Produtos lidos</div></div>' +
        '</div>';
      var tc = tabelaCampos(estado.conta.campos, estado.conta.atualizadoEm, 'Informacoes Gerenciais capturadas');
      h += tc || '<div class="vazio">Abra a area de <b>Informacoes Gerenciais</b> para a leitura da conta.</div>';
      corpo.innerHTML = h;

    } else if (abaAtiva === 'campanhas' || abaAtiva === 'produtos') {
      var mapa = abaAtiva === 'campanhas' ? estado.campanhas : estado.produtos;
      var ids = Object.keys(mapa);
      if (abaAtiva === 'produtos') ids = ids.filter(function (id) { return mapa[id].origem === 'ads' || mapa[id].metricas.gasto !== undefined || mapa[id].metricas.roas !== undefined; });
      if (!ids.length) {
        corpo.innerHTML = '<div class="vazio">Nada lido ainda. Navegue pela tela de <b>Shopee Ads</b>' + (abaAtiva === 'produtos' ? ' e entre em uma campanha' : '') + '.</div>';
        return;
      }
      ids.sort(function (a, b) { return (mapa[b].metricas.gasto || 0) - (mapa[a].metricas.gasto || 0); });
      var h2 = '<table><tr><th>' + (abaAtiva === 'campanhas' ? 'Campanha' : 'Produto') + '</th><th>ID</th>' +
        '<th class="num">Gasto</th><th class="num">GMV</th><th class="num">ROAS</th><th class="num">Impr.</th>' +
        '<th class="num">Cliques</th><th class="num">CTR</th><th class="num">Pedidos</th><th class="num">Pos.</th></tr>';
      for (var j = 0; j < ids.length; j++) {
        var item = mapa[ids[j]];
        h2 += '<tr><td class="nome">' + esc(item.nome || '(sem nome capturado)') + '</td>' +
          '<td>' + esc(item.id) + '</td>' + linhaMetrica(item.metricas) + '</tr>';
      }
      h2 += '</table><div class="nota">Ordenado por gasto. Micro-unidades convertidas (÷100.000). Se algo nao bater com a tela, exporte a coleta.</div>';
      corpo.innerHTML = h2;

    } else if (abaAtiva === 'performance') {
      var idsP = Object.keys(estado.produtos).filter(function (id) {
        var m = estado.produtos[id].metricas;
        return m.visitantes !== undefined || m.visualizacoes !== undefined || m.carrinho !== undefined || estado.produtos[id].origem === 'performance';
      });
      if (!idsP.length) {
        corpo.innerHTML = '<div class="vazio">Abra <b>Central de Dados → Performance de Produto</b> (datacenter) e navegue pela lista. O funil de cada produto aparece aqui.</div>';
        return;
      }
      idsP.sort(function (a, b) { return (estado.produtos[b].metricas.visitantes || 0) - (estado.produtos[a].metricas.visitantes || 0); });
      var h5 = '<table><tr><th>Produto</th><th>ID</th><th class="num">Visitantes</th><th class="num">Visualiz.</th><th class="num">Carrinho</th><th class="num">Pedidos</th><th class="num">Conversao</th><th class="num">GMV</th></tr>';
      for (var q = 0; q < idsP.length; q++) {
        var pp = estado.produtos[idsP[q]];
        var m5 = pp.metricas;
        var conv = m5.conversao !== undefined ? (m5.conversao <= 1 ? m5.conversao * 100 : m5.conversao) : (m5.visitantes ? (m5.pedidos || 0) / m5.visitantes * 100 : null);
        h5 += '<tr><td class="nome">' + esc(pp.nome || '(sem nome)') + '</td><td>' + esc(pp.id) + '</td>' +
          '<td class="num">' + fmt(m5.visitantes) + '</td><td class="num">' + fmt(m5.visualizacoes) + '</td>' +
          '<td class="num">' + fmt(m5.carrinho) + '</td><td class="num">' + fmt(m5.pedidos) + '</td>' +
          '<td class="num">' + (conv === null ? '—' : fmt(conv, 2) + '%') + '</td>' +
          '<td class="num">' + reais(m5.gmv) + '</td></tr>';
      }
      h5 += '</table><div class="nota">Funil por produto (Central de Dados). Campos ainda nao mapeados ficam na exportacao — mande o JSON para calibrarmos os nomes exatos.</div>';
      corpo.innerHTML = h5;

    } else if (abaAtiva === 'afiliados') {
      var ta = tabelaCampos(estado.afiliados.campos, estado.afiliados.atualizadoEm, 'Painel de Afiliados capturado');
      corpo.innerHTML = ta || '<div class="vazio">Abra o <b>painel de Afiliados</b> (web-seller-affiliate/dashboard) e navegue. Os campos capturados aparecem aqui para calibragem.</div>';

    } else if (abaAtiva === 'cadastro') {
      var h3 = '';
      if (estado.paginaProduto) {
        h3 += '<div class="kpis"><div class="kpi"><div class="v">' + esc(estado.paginaProduto) + '</div><div class="l">ID do produto (chave-mestra)</div></div></div>';
        var p = estado.produtos[estado.paginaProduto];
        if (p) {
          h3 += '<table><tr><th>Produto</th><th class="num">Gasto</th><th class="num">GMV</th><th class="num">ROAS</th><th class="num">Impr.</th><th class="num">Cliques</th><th class="num">CTR</th><th class="num">Pedidos</th><th class="num">Pos.</th></tr>' +
            '<tr><td class="nome">' + esc(p.nome || '') + '</td>' + linhaMetrica(p.metricas) + '</tr></table>' +
            '<div class="nota">Cruzamento por ID funcionando. Aqui entram a Calculadora e o Cofre de Custos (Etapa 3).</div>';
        } else {
          h3 += '<div class="nota">Este produto ainda nao apareceu na coleta. Na Etapa 2 a busca ativa resolve na hora.</div>';
        }
      } else {
        h3 = '<div class="vazio">Abra a pagina de um <b>produto</b> no portal para o coletor extrair o ID da URL.</div>';
      }
      corpo.innerHTML = h3;

    } else if (abaAtiva === 'debug') {
      var okInterceptor = !!estado.interceptorVersao;
      var h4 = '<div class="nota">Interceptor' +
        '<span class="selo ' + (okInterceptor ? 'ok' : 'off') + '">' + (okInterceptor ? 'ativo v' + esc(estado.interceptorVersao) : 'sem resposta') + '</span>' +
        ' · coletor v' + VERSAO + ' · pagina: ' + esc(location.pathname) + '</div>';
      if (!estado.chamadas.length) {
        h4 += '<div class="vazio">Nenhuma chamada capturada ainda nesta pagina.</div>';
      } else {
        h4 += '<table><tr><th>Hora</th><th>Tipo</th><th>Metodo</th><th>Rota</th><th class="num">Bytes</th></tr>';
        for (var d = 0; d < Math.min(estado.chamadas.length, 150); d++) {
          var ch = estado.chamadas[d];
          var rota = ch.url.replace(/^https:\/\/[^\/]+/, '').split('?')[0];
          h4 += '<tr><td>' + hora(ch.ts) + '</td><td class="tag-' + ch.tag + '">' + ch.tag + '</td><td>' + esc(ch.metodo) + '</td>' +
            '<td class="nome">' + esc(rota) + '</td><td class="num">' + fmt(ch.tamanho) + '</td></tr>';
        }
        h4 += '</table><div class="nota">"Exportar coleta" gera o JSON completo para calibragem — mande no chat com um print quando algo nao bater.</div>';
      }
      corpo.innerHTML = h4;
    }
  }

  setInterval(function () {
    if (estado.sujo && $('sia-painel').classList.contains('aberto')) { estado.sujo = false; render(); }
  }, 900);
})();

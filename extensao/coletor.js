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

  var VERSAO = '0.23.7';
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
    modoPagina: null,        // 'portal' (Seller Centre) | 'publico' (visao do cliente)
    anuncioPublico: null,    // leitura da vitrine: preco, fotos, estrelas, vendidos
    cadastro: null,          // get_product_info: preco, estoque, categoria, fotos
    series: {},              // series temporais por campanha (get_time_graph)
    loja: null,              // shop_id + nome (selleraccount/shop_info)
    spc: null,               // chave de sessao SPC_CDS (colhida das chamadas)
    coletaProgresso: null,   // texto de progresso da coleta completa
    periodoAds: null,        // janela selecionada na tela do Ads (start/end)
    diagnostico: null,       // ultimo retorno do Cerebro
    analisando: false,
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
    roas: 'roas', broad_roas: 'roas', broad_roi: 'roas', direct_roas: 'roas_direto', direct_roi: 'roas_direto',
    cr: 'conversao', conversion_rate: 'conversao', cvr: 'conversao', placed_cr: 'conversao',
    avg_rank: 'posicao', avg_ranking: 'posicao', rank: 'posicao',
    acos: 'acos', atc: 'carrinho', atc_rate: 'taxa_carrinho',
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
  var CAMPOS_DINHEIRO = { gasto: 1, gmv: 1, gmv_direto: 1, orcamento: 1, orcamento_dia: 1, comissao: 1 };
  var CAMPOS_ID_PRODUTO = ['itemid', 'item_id', 'product_id', 'productid'];
  var CAMPOS_ID_CAMPANHA = ['campaignid', 'campaign_id'];
  var CAMPOS_NOME = ['name', 'title', 'campaign_name', 'item_name', 'product_name', 'shop_item_name'];

  function numero(v) {
    if (typeof v === 'number' && isFinite(v)) return v <= -999999 ? null : v;
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

  function dinheiro(v, micro) {
    if (v === null) return null;
    if (micro && Number.isInteger(v) && Math.abs(v) >= 1000) return v / MICRO;
    return v;
  }

  function extrairMetricas(obj, micro) {
    var m = {};
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var chave = MAPA[k.toLowerCase()];
      if (!chave) continue;
      var v = numero(obj[k]);
      if (v === null) continue;
      m[chave] = CAMPOS_DINHEIRO[chave] ? dinheiro(v, micro) : v;
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

    var metricas = extrairMetricas(no, ctx.tag === 'ads' || ctx.tag === 'publico');
    if (Object.keys(metricas).length) {
      if (novoCtx.idProd) {
        var p = entidadeProduto(novoCtx.idProd);
        for (var mk in metricas) p.metricas[mk] = metricas[mk];
        if (novoCtx.nome) p.nome = novoCtx.nome;
        if (novoCtx.idCamp) p.campanha = novoCtx.idCamp;
        p.origem = ctx.tag; p.visto_em = Date.now();
        if (ctx.tag === 'performance') camposNumericos(no, p.campos);
        estado.sujo = true;
      } else if (novoCtx.idCamp && ctx.tag === 'ads') {
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
    var raiz = json;
    if (json && json.data !== undefined) raiz = json.data;
    else if (json && json.result !== undefined) raiz = json.result;
    achatar(raiz, '', campos, 0);
    if (Object.keys(campos).length) {
      for (var k in campos) alvo.campos[k] = campos[k];
      alvo.atualizadoEm = Date.now();
      estado.sujo = true;
    }
  }

  function absorverCadastro(json) {
    try {
      var pi = json && json.data && json.data.product_info;
      if (!pi || !pi.id) return;
      var precoN = null, precoP = null, estoque = 0;
      var lista = Array.isArray(pi.model_list) ? pi.model_list : [];
      for (var i = 0; i < lista.length; i++) {
        var mo = lista[i];
        if (mo.price_info) {
          var pn = numero(mo.price_info.normal_price);
          var pp = numero(mo.price_info.promotion_price);
          if (pn !== null && (precoN === null || pn < precoN)) precoN = pn;
          if (pp !== null && pp > 0 && (precoP === null || pp < precoP)) precoP = pp;
        }
        if (mo.stock_detail && numero(mo.stock_detail.total_available_stock) !== null) {
          estoque += numero(mo.stock_detail.total_available_stock);
        }
      }
      estado.cadastro = {
        id: String(pi.id),
        nome: pi.name || '',
        preco: precoN,
        preco_promo: precoP,
        estoque: estoque,
        categoria: Array.isArray(pi.category_path_name_list) ? pi.category_path_name_list.join(' > ') : '',
        n_fotos: Array.isArray(pi.images) ? pi.images.length : 0,
        imagens: Array.isArray(pi.images) ? pi.images.slice(0, 12) : [],
        variacoes: lista.length,
        capturado_em: Date.now()
      };
      var p = entidadeProduto(estado.cadastro.id);
      if (estado.cadastro.nome) p.nome = estado.cadastro.nome;
      if (precoP !== null || precoN !== null) p.preco_cadastro = precoP !== null ? precoP : precoN;
      estado.sujo = true;
    } catch (e) { /* calibrar com exportacao */ }
  }

  function absorverPublico(json) {
    // procura o primeiro objeto com identidade de item + nome
    var achado = null;
    (function busca(no, prof) {
      if (achado || !no || typeof no !== 'object' || prof > 6) return;
      if (Array.isArray(no)) { for (var i = 0; i < no.length && !achado; i++) busca(no[i], prof + 1); return; }
      var id = acharCampo(no, CAMPOS_ID_PRODUTO);
      var nome = acharCampo(no, ['name', 'title']);
      if (id && typeof nome === 'string' && nome.length > 3) { achado = { no: no, id: String(id), nome: nome }; return; }
      for (var k in no) { if (no[k] && typeof no[k] === 'object') busca(no[k], prof + 1); }
    })(json, 0);
    if (!achado) return;
    var no = achado.no;
    var preco = numero(no.price_min !== undefined ? no.price_min : no.price);
    var a = {
      id: achado.id,
      nome: achado.nome,
      preco: preco !== null ? dinheiro(preco, true) : null,
      preco_max: no.price_max !== undefined ? dinheiro(numero(no.price_max), true) : null,
      estrelas: no.item_rating && numero(no.item_rating.rating_star) !== null ? numero(no.item_rating.rating_star) : null,
      vendidos: numero(no.historical_sold !== undefined ? no.historical_sold : (no.global_sold_count !== undefined ? no.global_sold_count : no.sold)),
      imagens: Array.isArray(no.images) ? no.images.slice(0, 12) : [],
      capturado_em: Date.now()
    };
    estado.anuncioPublico = a;
    // tambem alimenta a entidade produto pela chave-mestra
    var p = entidadeProduto(a.id);
    if (a.nome) p.nome = a.nome;
    if (a.preco !== null) p.preco_publico = a.preco;
    estado.sujo = true;
  }

  var TRADUZ_ESTRATEGIA = { roi_two: 'Meta de ROAS', roi_one: 'Meta de ROAS (v1)', auto: 'Automatico', manual: 'Manual' };

  function metaCampanha(c) {
    if (!c || !c.campaign_id) return null;
    var ent = entidadeCampanha(String(c.campaign_id));
    if (c.name) ent.nome = c.name;
    if (c.state) ent.estado = c.state;
    if (c.bidding_strategy) ent.estrategia = TRADUZ_ESTRATEGIA[c.bidding_strategy] || c.bidding_strategy;
    if (c.type) ent.tipo = c.type;
    var ob = numero(c.daily_budget);
    if (ob !== null) ent.metricas.orcamento_dia = dinheiro(ob, true);
    ent.visto_em = Date.now();
    estado.sujo = true;
    return ent;
  }

  /* Parser exato das rotas do Shopee Ads (calibrado com payload real 24/07). */
  function parsePas(url, corpo, dados) {
    var body = null;
    try { body = corpo ? JSON.parse(corpo) : null; } catch (e) { /* noop */ }
    if (body && body.start_time && body.end_time) {
      var dias = Math.max(1, Math.round((body.end_time - body.start_time) / 86400));
      estado.periodoAds = { inicio: body.start_time, fim: body.end_time, dias: dias };
    }
    var data = dados && dados.data !== undefined ? dados.data : null;

    // Lista de campanhas da homepage do Ads
    if (url.indexOf('/pas/v1/homepage/query') >= 0 && data && Array.isArray(data.entry_list)) {
      for (var i = 0; i < data.entry_list.length; i++) {
        var e = data.entry_list[i];
        var camp = (e.campaign && e.campaign.campaign_id) ? e.campaign :
                   (e.manual_product_ads && e.manual_product_ads.campaign_id) ? e.manual_product_ads : null;
        var ent = camp ? metaCampanha(camp) : null;
        if (!ent && e.campaign_id) ent = metaCampanha(e);
        if (!ent) continue;
        if (e.title) ent.nome = e.title;
        if (e.state) ent.estado = e.state;
        if (e.subtype) ent.tipo = e.subtype;
        if (e.report) {
          var m = extrairMetricas(e.report, true);
          for (var k in m) ent.metricas[k] = m[k];
        }
      }
      return true;
    }

    // Produtos dentro da campanha (+ meta da campanha)
    if (url.indexOf('/pas/v1/product/get') >= 0 && data) {
      var idCamp = null;
      if (data.campaign) { var entc = metaCampanha(data.campaign); idCamp = data.campaign.campaign_id ? String(data.campaign.campaign_id) : null; }
      var lista = Array.isArray(data.ads_list) ? data.ads_list : [];
      for (var j = 0; j < lista.length; j++) {
        var ad = lista[j] || {};
        var idItem = acharCampo(ad, CAMPOS_ID_PRODUTO);
        if (idItem) {
          var pAd = entidadeProduto(String(idItem));
          if (idCamp) pAd.campanha = idCamp;
          pAd.origem = 'ads'; pAd.visto_em = Date.now();
        }
        garimpar(ad, { tag: 'ads', idCamp: idCamp });
      }
      estado.sujo = true;
      return true;
    }

    // Agregado com variacao (report/get) — atribui pela chave do corpo
    if (url.indexOf('/pas/v1/report/get/') >= 0 && Array.isArray(data)) {
      var agg = body && body.agg_type ? body.agg_type : null;
      for (var r = 0; r < data.length; r++) {
        var item = data[r];
        if (!item || item.key === undefined) continue;
        var alvo = null;
        if (agg === 'campaign_id') alvo = entidadeCampanha(String(item.key));
        else if (agg === 'item_id' || agg === 'itemid') alvo = entidadeProduto(String(item.key));
        if (!alvo) continue;
        if (item.metrics) { var mm = extrairMetricas(item.metrics, true); for (var mk in mm) alvo.metricas[mk] = mm[mk]; }
        if (item.ratio) { alvo.variacao = extrairMetricas(item.ratio, false); }
        alvo.visto_em = Date.now(); estado.sujo = true;
      }
      return true;
    }

    // Serie temporal (get_time_graph) — guarda leve para as tendencias 7/15/30
    if (url.indexOf('/pas/v1/report/get_time_graph') >= 0 && data && Array.isArray(data.report_by_time)) {
      var idc = body && body.filter_params && body.filter_params.campaign_id ? String(body.filter_params.campaign_id) : 'conta';
      var pontos = [];
      for (var t = 0; t < data.report_by_time.length; t++) {
        var pt = data.report_by_time[t];
        if (!pt || !pt.metrics) continue;
        var pm = extrairMetricas(pt.metrics, true);
        pm.ts = numero(pt.key);
        pontos.push(pm);
      }
      estado.series[idc] = { atualizado: Date.now(), inicio: body ? body.start_time : null, fim: body ? body.end_time : null, pontos: pontos };
      if (data.report_aggregate && idc !== 'conta') {
        var alvo2 = entidadeCampanha(idc);
        var ma = extrairMetricas(data.report_aggregate, true);
        for (var ak in ma) alvo2.metricas[ak] = ma[ak];
        alvo2.visto_em = Date.now();
      }
      estado.sujo = true;
      return true;
    }
    return false;
  }

  /* Listas de produto da Central de Dados (calibrado com payload real 25/07):
     v4/product/performance (funil completo) e traffic/item-list (fatia + campanha). */
  function parseMydataProdutos(url, dados, corpo) {
    // detecta se a tela esta filtrada por uma fonte de trafego (Contribuicao do Produto)
    var fonteSel = null;
    try {
      var b = corpo ? JSON.parse(corpo) : null;
      if (b) for (var kb in b) {
        if (/source|channel/i.test(kb) && b[kb] && b[kb] !== 'all' && b[kb] !== 0 && b[kb] !== '0') {
          var vs = String(b[kb]).toLowerCase();
          fonteSel = /ads/.test(vs) ? 'ads' : (/afili|affiliate/.test(vs) ? 'afiliado' : vs.slice(0, 20));
          break;
        }
      }
    } catch (e) { /* noop */ }
    var res = dados && (dados.result || dados.data);
    if (!res) return false;
    var lista = res.items || res.item;
    if (!Array.isArray(lista) || !lista.length) return false;
    var ehPerformance = url.indexOf('/product/performance') >= 0;
    var ehTrafego = url.indexOf('traffic/item-list') >= 0 || url.indexOf('product-contribution') >= 0;
    if (!ehPerformance && !ehTrafego) return false;
    for (var i = 0; i < lista.length; i++) {
      var it = lista[i] || {};
      if (!it.id) continue;
      var p = entidadeProduto(String(it.id));
      if (it.name) p.nome = it.name;
      if (it.campaign_id) p.campanha = String(it.campaign_id);
      if (it.view_ads !== undefined) p.pode_ads = !!it.view_ads;
      var m = p.metricas;
      function pega(campo, chave) { var v = numero(it[campo]); if (v !== null) m[chave] = v; }
      if (ehPerformance) {
        pega('uv', 'visitantes'); pega('pv', 'visualizacoes');
        pega('product_card_impressions', 'impressoes_card'); pega('product_card_clicks', 'cliques_card');
        pega('ctr', 'ctr_card'); pega('bounce_rate', 'rejeicao');
        pega('add_to_cart_buyers', 'carrinho'); pega('add_to_cart_units', 'carrinho_unidades');
        pega('paid_orders', 'pedidos_pagos'); pega('paid_sales', 'vendas_pagas');
        pega('paid_units', 'unidades_pagas'); pega('paid_sales_per_order', 'ticket_pedido');
        pega('paid_order_conversion_rate', 'conversao_pago');
        pega('uv_to_add_to_cart_rate', 'taxa_carrinho');
        pega('repeat_paid_order_rate', 'recompra'); pega('likes', 'curtidas');
        pega('search_clicks', 'cliques_busca');
      }
      if (ehTrafego) {
        if (fonteSel) {
          // tela filtrada por uma fonte: grava separado, sem sobrescrever o total
          if (!p.metricas.fontes) p.metricas.fontes = {};
          var fv = numero(it.sales), fo = numero(it.orders);
          p.metricas.fontes[fonteSel] = { vendas: fv, pedidos: fo };
        } else {
          pega('sales', 'vendas_pagas'); pega('orders', 'pedidos_pagos');
          pega('sales_ratio', 'fatia_vendas'); pega('sales_per_order', 'ticket_pedido');
          pega('ctr', 'ctr_card'); pega('product_impressions', 'impressoes_card');
          pega('product_clicks', 'cliques_card');
        }
      }
      p.origem = 'performance'; p.visto_em = Date.now();
    }
    estado.sujo = true;
    return true;
  }

  function classificar(url) {
    if (url.indexOf('/api/pas/') >= 0) return 'ads';
    if (url.indexOf('monitor-report') >= 0) return url.indexOf('reportMetrics') >= 0 ? 'afiliados' : 'outra';
    if (url.indexOf('affiliate') >= 0) return 'afiliados';
    if (url.indexOf('datacenter') >= 0 || url.indexOf('product/performance') >= 0) return 'performance';
    if (url.indexOf('/api/mydata/') >= 0) return 'conta';
    if (url.indexOf('/api/v3/product/') >= 0 || url.indexOf('/api/v4/product/') >= 0) return 'cadastro';
    if (url.indexOf('/api/marketing/') >= 0) return 'marketing';
    if (url.indexOf('/api/v4/pdp') >= 0 || url.indexOf('/api/v4/item') >= 0 || url.indexOf('/api/v2/item') >= 0) return 'publico';
    return 'outra';
  }

  /* ============================== RECEPCAO ============================== */
  function processarPacote(pacote) {
    if (!pacote || !pacote.url) return;
    var mSpc = pacote.url.match(/SPC_CDS=([a-f0-9-]{20,})/i);
    if (mSpc) { estado.spc = mSpc[1]; try { window.SIA_ULTIMO_CDS = mSpc[1]; } catch (e) { } }
    // captura o start/end REAL das chamadas mydata (Central de Dados) que a
    // Shopee ja validou. Reusamos no coletor pra nunca errar o formato de data.
    if (/mydata\/.*\/(key-metrics|performance|traffic|order-performance)/.test(pacote.url)) {
      var mSt = pacote.url.match(/start_time=(\d{9,11})/);
      var mEt = pacote.url.match(/end_time=(\d{9,11})/);
      var mPer = pacote.url.match(/period=(\w+)/);
      if (mSt && mEt && mPer && mPer[1] === 'month') {
        estado.periodoMydata = { inicio: parseInt(mSt[1], 10), fim: parseInt(mEt[1], 10) };
      }
      // guarda a URL COMPLETA real de cada rota dashboard, pra reusar tal e qual
      estado.urlsReais = estado.urlsReais || {};
      if (/dashboard\/key-metrics/.test(pacote.url)) estado.urlsReais.keyMetrics = pacote.url;
      else if (/product\/traffic\/overview/.test(pacote.url)) estado.urlsReais.funilOverview = pacote.url;
      else if (/dashboard\/traffic-sources/.test(pacote.url)) estado.urlsReais.trafficSources = pacote.url;
      else if (/product\/performance/.test(pacote.url)) estado.urlsReais.performance = pacote.url;
      else if (/dashboard\/order-performance/.test(pacote.url)) estado.urlsReais.orderPerf = pacote.url;
    }
    var tag = classificar(pacote.url);
    var tamanho = 0;
    try { tamanho = JSON.stringify(pacote.dados).length; } catch (e) { /* noop */ }

    estado.chamadas.unshift({ ts: pacote.ts, url: pacote.url, metodo: pacote.metodo, tag: tag, tamanho: tamanho });
    if (estado.chamadas.length > LIMITE_CHAMADAS) estado.chamadas.length = LIMITE_CHAMADAS;

    estado.brutos.unshift({ ts: pacote.ts, url: pacote.url, metodo: pacote.metodo, corpo: pacote.corpo, dados: pacote.dados });
    if (estado.brutos.length > LIMITE_BRUTOS) estado.brutos.length = LIMITE_BRUTOS;

    // ---- CAMADA 1: extracao dos diamantes (nao invasivo, nunca derruba a coleta) ----
    try { if (window.SIA_Diamantes) window.SIA_Diamantes.processar(pacote.url, pacote.dados); } catch (e) { /* silencioso */ }

    if (tag === 'publico') { absorverPublico(pacote.dados); }
    else if (tag === 'cadastro' && pacote.url.indexOf('get_product_info') >= 0) { absorverCadastro(pacote.dados); }
    else if (tag === 'conta') {
      if (!parseMydataProdutos(pacote.url, pacote.dados, pacote.corpo)) { absorverPainel(pacote.dados, estado.conta); garimpar(pacote.dados, { tag: tag }); }
    }
    else if (tag === 'afiliados') { absorverPainel(pacote.dados, estado.afiliados); /* sem garimpo: micro proprio, tratado na v0.6 */ }
    else if (tag === 'ads') { if (!parsePas(pacote.url, pacote.corpo, pacote.dados)) garimpar(pacote.dados, { tag: tag }); }
    else if (tag === 'outra') {
      if (pacote.url.indexOf('shop_info') >= 0 && !estado.loja) {
        (function cacar(no, prof) {
          if (estado.loja || !no || typeof no !== 'object' || prof > 4) return;
          if (Array.isArray(no)) { for (var i = 0; i < no.length; i++) cacar(no[i], prof + 1); return; }
          var sid = no.shop_id !== undefined ? no.shop_id : no.shopid;
          if (sid) {
            estado.loja = { shop_id: String(sid), nome: no.shop_name || no.name || no.username || '' };
            estado.sujo = true; return;
          }
          for (var k in no) { if (no[k] && typeof no[k] === 'object') cacar(no[k], prof + 1); }
        })(pacote.dados, 0);
      }
    }
    else if (tag === 'performance') { if (!parseMydataProdutos(pacote.url, pacote.dados, pacote.corpo)) garimpar(pacote.dados, { tag: tag }); }
    else garimpar(pacote.dados, { tag: tag });
    estado.sujo = true;
  }
  window.addEventListener('SIA_DADOS', function (ev) {
    var pacote;
    try { pacote = JSON.parse(ev.detail); } catch (e) { return; }
    processarPacote(pacote);
  });

  window.addEventListener('SIA_PONG', function (ev) {
    try { estado.interceptorVersao = JSON.parse(ev.detail).versao; } catch (e) { /* noop */ }
  });
  try { window.dispatchEvent(new CustomEvent('SIA_PING')); } catch (e) { /* noop */ }

  function detectarPaginaProduto() {
    var host = location.hostname;
    if (host === 'seller.shopee.com.br') {
      var m = location.pathname.match(/\/portal\/product\/(\d{6,})/) || location.search.match(/[?&](?:item_?id|product_?id)=(\d{6,})/);
      estado.paginaProduto = m ? m[1] : null;
      estado.modoPagina = 'portal';
      return;
    }
    // pagina publica: .../nome-i.SHOPID.ITEMID  OU  /product/SHOPID/ITEMID
    var mp = location.pathname.match(/-i\.(\d+)\.(\d+)$/) || location.pathname.match(/\/product\/(\d+)\/(\d+)/);
    if (mp) { estado.paginaProduto = mp[2]; estado.modoPagina = 'publico'; }
    else { estado.paginaProduto = null; estado.modoPagina = host.indexOf('shopee') >= 0 ? 'publico' : null; }
  }
  detectarPaginaProduto();
  setInterval(detectarPaginaProduto, 1500);

  /* ============================ PERSISTENCIA ============================ */
  function fotoDoEstado() {
    return {
      versao: VERSAO,
      gerado_em: new Date().toISOString(),
      pagina: location.href,
      loja: estado.loja,
      periodo_ads: estado.periodoAds,
      conta: estado.conta,
      afiliados: estado.afiliados,
      anuncio_publico: estado.anuncioPublico,
      cadastro: estado.cadastro,
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
        estado.loja = resp.coleta.loja || estado.loja;
        estado.conta = resp.coleta.conta || estado.conta;
        estado.afiliados = resp.coleta.afiliados || estado.afiliados;
        estado.campanhas = resp.coleta.campanhas || {};
        estado.produtos = resp.coleta.produtos || {};
        estado.sujo = true;
      }
    });
  } catch (e) { /* noop */ }


  /* ================== MODO LENTE (v0.9) ==================
     Anota a propria tela da Shopee: um selo ao lado de cada
     metrica conhecida; clique abre um card com 3 camadas:
     o que e -> como esta o seu -> faca assim.               */
  function vLente(chave) { // le valor+variacao das Gerenciais (varias grafias)
    var c = estado.conta.campos || {};
    var tentativas = [chave + '.value', chave, 'key_metrics.' + chave + '.value', 'key_metrics.' + chave,
      'result.' + chave + '.value', 'result.' + chave, 'result.key_metrics.' + chave + '.value'];
    var val;
    for (var t = 0; t < tentativas.length; t++) { if (typeof c[tentativas[t]] === 'number') { val = c[tentativas[t]]; break; } }
    var rat = c[chave + '.ratio']; if (typeof rat !== 'number') rat = c['key_metrics.' + chave + '.ratio'];
    return { v: (typeof val === 'number' ? val : null), r: (typeof rat === 'number' ? rat : null) };
  }
  function fLe(n2, casas) { return n2 === null || n2 === undefined ? null : n2.toLocaleString('pt-BR', { minimumFractionDigits: casas || 0, maximumFractionDigits: casas || 0 }); }

  function somaCampanhas() {
    var t = { gasto: 0, gmv: 0, cliques: 0, impressoes: 0, pedidos: 0 };
    for (var id in estado.campanhas) {
      var m = estado.campanhas[id].metricas || {};
      t.gasto += m.gasto || 0; t.gmv += m.gmv || 0;
      t.cliques += m.cliques || 0; t.impressoes += m.impressoes || 0; t.pedidos += m.pedidos || 0;
    }
    return t;
  }
  function janelaTelaConfere() {
    // compara from/to (ou period) da URL com a janela coletada
    if (!estado.periodoAds) return false;
    var mF = location.search.match(/[?&]from=(\d{9,11})/);
    var mT = location.search.match(/[?&]to=(\d{9,11})/);
    if (mF && mT) {
      return Math.abs(parseInt(mF[1], 10) - estado.periodoAds.inicio) < 172800 &&
             Math.abs(parseInt(mT[1], 10) - estado.periodoAds.fim) < 172800;
    }
    return false;
  }
  function janelaTxt() {
    if (!estado.periodoAds) return 'sem janela definida';
    function dd(ts) { var d = new Date(ts * 1000); return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2); }
    return dd(estado.periodoAds.inicio) + ' a ' + dd(estado.periodoAds.fim);
  }

  var LENTE = [
    { rot: ['Taxa de Conversão de Pedidos', 'Taxa de Conversão (Visitados a Confirmados)', 'Taxa de Conversão'], id: 'conv', paths: ['/datacenter'],
      oque: 'De cada 100 pessoas que visitam, quantas compram. E o multiplicador da loja inteira: quem converte bem paga mais barato no leilao de ads.',
      leitura: function () { var d = vLente('conversion_rate'); if (d.v === null) return null;
        var p = d.v <= 1 ? d.v * 100 : d.v;
        return { valor: fLe(p, 2) + '%', bom: p >= 1, texto: p >= 1 ? 'Acima de 1% — funil saudavel. Proteja: qualquer queda aqui encarece todas as campanhas.' : 'Abaixo de 1% — a pagina nao esta fechando a venda que o trafego traz.' }; },
      acao: 'Se estiver baixa: abra seus 3 produtos de maior trafego como cliente, no celular, e compare preco e foto com os 3 primeiros da busca. Corrija um item por vez.' },
    { rot: ['Vendas por Comprador', 'Vendas por Pedido'], id: 'vpc', paths: ['/datacenter'],
      oque: 'Quanto entra em media por pedido/comprador. E a alavanca mais barata da loja: sobe com kits, combos e leve-mais-pague-menos — e conversa direto com o degrau de comissao dos R$80.',
      leitura: function () { var g = vLente('paid_gmv'); var o = vLente('paid_order');
        if (g.v === null || o.v === null || !o.v) return null;
        var t = g.v / o.v;
        return { valor: 'R$ ' + fLe(t, 2), bom: t >= 80, texto: t < 80 ? 'Abaixo de R$80 — cada venda paga a comissao mais cara (20% + R$4). Kit cruzando R$80 cai para 14% + R$16.' : 'Acima do degrau dos R$80 — comissao na faixa de 14%.' }; },
      acao: 'Para subir: combo dos 2 mais vendidos com 8-10% de desconto, e cupom de loja com gasto minimo ~35% acima do ticket atual.' },
    { rot: ['Taxa de Rejeição do Produto', 'Taxa de Rejeição'], id: 'rej', paths: ['/datacenter'],
      oque: 'Visitantes que saem sem interagir. Rejeicao alta = a pagina nao confirma o que o card prometeu (preco, modelo, kit).',
      leitura: function () { var d = vLente('bounce_rate'); if (d.v === null) return null;
        var p = d.v <= 1 ? d.v * 100 : d.v;
        return { valor: fLe(p, 2) + '%', bom: p < 35, texto: p < 35 ? 'Dentro do saudavel (< 35%).' : 'Acima de 35% — promessa do card e pagina estao desalinhadas.' }; },
      acao: 'Compare a foto do card com a primeira dobra da pagina: precisam contar a mesma historia. Se o preco do card e "a partir de", confira se a variacao barata tem estoque.' },
    { rot: ['Visitantes do Produto', 'Visitantes'], id: 'uv', paths: ['/datacenter'],
      oque: 'Pessoas unicas que entraram nas paginas. E o topo do funil — mas visitante sem conversao e so conta de luz.',
      leitura: function () { var d = vLente('uv'); if (d.v === null) return null;
        return { valor: fLe(d.v, 0), bom: d.r === null || d.r >= 0, texto: d.r === null ? '' : (d.r >= 0 ? 'Crescendo ' : 'Caindo ') + fLe(Math.abs(d.r * 100), 1) + '% vs periodo anterior.' }; },
      acao: 'Trafego se constroi em 3 frentes: titulo com o termo mais buscado (organico), ads nos produtos que ja convertem, e afiliados com comissao especial nos 2 melhores.' },
    { rot: ['Cliques em buscas'], id: 'buscas', paths: ['/datacenter'],
      oque: 'Cliques vindos da busca interna. A busca costuma ser a maior fonte — e ela depende do titulo e da foto no card.',
      leitura: null,
      acao: 'O titulo e seu ativo de midia: no novo algoritmo, a correspondencia de palavra-chave nasce dele. Beneficio + termo buscado nas primeiras palavras.' },
    { rot: ['Adicionar ao Carrinho', 'Visitantes do Produto (Adicionar ao Carrinho)'], id: 'atc', paths: ['/datacenter'],
      oque: 'Quem colocou no carrinho ja decidiu que quer. O que trava depois e frete na tela final ou falta de empurrao pra fechar agora.',
      leitura: function () { var a = vLente('atc_uv'); var p2 = vLente('paid_buyers');
        if (a.v === null || p2.v === null || a.v <= p2.v) return null;
        var ab = (1 - p2.v / a.v) * 100;
        return { valor: fLe(ab, 0) + '% abandonam', bom: ab < 70, texto: fLe(a.v, 0) + ' adicionaram, ' + fLe(p2.v, 0) + ' pagaram.' }; },
      acao: 'Cupom de fechamento (ex: 5% acima de R$40) — ele aparece exatamente no carrinho — e leve-mais-pague-menos nos produtos de maior trafego.' },
    { rot: ['GMV Pago', 'Total de Vendas'], id: 'gmv', paths: ['/datacenter'],
      oque: 'O que de fato entrou (pedidos pagos). E o numero que paga as contas — pedido feito sem pagamento nao e venda.',
      leitura: function () { var d = vLente('paid_gmv'); if (d.v === null) return null;
        return { valor: 'R$ ' + fLe(d.v, 2), bom: d.r === null || d.r >= 0, texto: d.r === null ? '' : (d.r >= 0 ? 'Crescendo ' : 'Caindo ') + fLe(Math.abs(d.r * 100), 1) + '% vs periodo anterior.' }; },
      acao: 'Cresce por 3 alavancas, nesta ordem de custo: conversao (gratis), ticket (quase gratis), trafego (pago). Comece sempre pela mais barata.' },
    { rot: ['ROAS', 'GMV por Gasto'], id: 'roas',
      oque: 'Quantos reais voltam por real investido. O numero sozinho engana: o que importa e comparar com o SEU ponto de equilibrio (100 ÷ margem%).',
      leitura: null,
      acao: 'Margem de 25% = empate em 4x; abaixo disso e prejuizo mesmo "parecendo bom". Cadastre o custo no Cofre (em breve) e o veredito passa a usar o seu numero real.' },
    { rot: ['Cliques Por Produto'], id: 'cliques_prod', paths: ['/datacenter'],
      oque: 'Cliques nos cards dos seus produtos. Clique e a moeda do funil: sem ele, nada acontece — e ele nasce da foto + preco + inicio do titulo.',
      leitura: function () { var d = vLente('product_clicks'); if (d.v === null) return null;
        return { valor: fLe(d.v, 0), bom: d.r === null || d.r >= 0, texto: d.r === null ? '' : (d.r >= 0 ? 'Crescendo ' : 'Caindo ') + fLe(Math.abs(d.r * 100), 1) + '% vs periodo anterior.' }; },
      acao: 'Clique caindo com impressao estavel = vitrine perdendo a disputa. Foto principal e as 3 primeiras palavras do titulo sao o alvo.' },
    { rot: ['Impressões', 'Impressoes'], id: 'ads_impr', paths: ['/portal/marketing/pas'],
      oque: 'Quantas vezes seus anuncios apareceram. Impressao e o algoritmo te dando chance — CTR e conversao definem se ele da mais.',
      leitura: function () { var t = somaCampanhas(); if (!t.impressoes) return null; var ok = janelaTelaConfere();
        return { valor: ok ? fLe(t.impressoes, 0) : null, bom: true, texto: ok ? 'confere com o card (' + janelaTxt() + ').' : 'a coleta cobre ' + janelaTxt() + '; a tela esta em outro periodo. Selecione o mesmo intervalo para casar os numeros.' }; },
      acao: 'Impressao caindo com campanha ativa = perda de leilao: reforce criativo e conversao antes de subir lance.' },
    { rot: ['Cliques'], id: 'ads_cliques', paths: ['/portal/marketing/pas'],
      oque: 'Cliques nos seus anuncios. O clique nasce da vitrine: foto + preco + inicio do titulo.',
      leitura: function () { var t = somaCampanhas(); if (!t.cliques) return null; var ok = janelaTelaConfere();
        return { valor: ok ? fLe(t.cliques, 0) : null, bom: true, texto: ok ? 'confere com o card.' : 'coleta: ' + janelaTxt() + '; tela em outro periodo.' }; },
      acao: 'Clique caro ou escasso: o alvo e a vitrine, nao o lance.' },
    { rot: ['Vendas'], id: 'ads_vendas', paths: ['/portal/marketing/pas'],
      oque: 'Vendas atribuidas aos anuncios. Lembre da janela de atribuicao: os ultimos 7 dias sempre sobem depois.',
      leitura: function () { var t = somaCampanhas(); if (!t.gmv) return null; var ok = janelaTelaConfere();
        return { valor: ok ? ('R$ ' + fLe(t.gmv, 2)) : null, bom: true, texto: ok ? 'confere com o card.' : 'coleta: ' + janelaTxt() + '; tela em outro periodo.' }; },
      acao: 'Compare sempre janela fechada com janela fechada — nunca julgue a semana corrente.' },
    { rot: ['Investimento', 'Despesas'], id: 'ads_gasto', paths: ['/portal/marketing/pas'],
      oque: 'Quanto foi investido. Gasto so faz sentido lado a lado com retorno e com o SEU ponto de equilibrio.',
      leitura: function () { var t = somaCampanhas(); if (!t.gasto) return null; var ok = janelaTelaConfere();
        return { valor: ok ? ('R$ ' + fLe(t.gasto, 2)) : null, bom: true, texto: ok ? 'confere com o card.' : 'coleta: ' + janelaTxt() + '; tela em outro periodo.' }; },
      acao: 'Direcione verba pelo diagnostico: escale vencedoras em degraus de 20%, corrija ofertas que clicam e nao vendem.' },
    { rot: ['ROAS'], id: 'ads_roas', paths: ['/portal/marketing/pas'],
      oque: 'Retorno por real investido, no conjunto das campanhas. O numero certo para te julgar e o SEU equilibrio (100 ÷ margem%), nao um numero magico.',
      leitura: function () { var t = somaCampanhas(); if (!t.gasto) return null;
        var r = t.gmv / t.gasto;
        return { valor: fLe(r, 2) + 'x', bom: r >= 6, texto: (r >= 6 ? 'acima' : 'abaixo') + ' do ponto de referencia (6x). ' + (janelaTelaConfere() ? 'Confere com o card.' : 'Coleta em ' + janelaTxt() + '; ajuste a tela para o mesmo periodo.') + ' Com o Cofre, o piso vira seu equilibrio real.' }; },
      acao: 'Abaixo do equilibrio: encontre a etapa fraca (CTR = vitrine; conversao = pagina) antes de mexer em lance ou pausar.' },
    { rot: ['Pedidos'], id: 'ads_pedidos', paths: ['/portal/marketing/pas'],
      oque: 'Pedidos atribuidos aos anuncios na janela.',
      leitura: function () { var t = somaCampanhas(); if (!t.pedidos) return null; var ok = janelaTelaConfere();
        return { valor: ok ? fLe(t.pedidos, 0) : null, bom: true, texto: ok ? 'confere com o card.' : 'coleta: ' + janelaTxt() + '; tela em outro periodo.' }; },
      acao: 'Volume de pedidos e o que torna qualquer leitura confiavel — regua de 30/mes por campanha.' },
    { rot: ['CTR'], id: 'ctr_ads', paths: ['/portal/marketing/pas', '/datacenter/product/traffic'],
      oque: 'De cada 100 vezes que o anuncio aparece, quantas e clicado. E a porta do funil pago — e o algoritmo premia quem clica bem com mais entrega.',
      leitura: null,
      acao: 'Abaixo de 1,5%: o problema e a vitrine (foto principal + inicio do titulo), nao o lance. Acima de 2%: o card esta bom — se o resultado nao vem, o gargalo e a pagina.' },
    { rot: ['Impressões', 'Impressoes'], id: 'impr',
      oque: 'Quantas vezes seus anuncios apareceram. Impressao e o algoritmo te dando chance — o que voce faz com ela (CTR e conversao) define se ele te da mais.',
      leitura: null,
      acao: 'Impressao caindo com campanha ativa = perda de leilao: o funil enfraqueceu e o CPM efetivo subiu. Reforce criativo e conversao antes de subir lance.' },
    { rot: ['Despesas', 'Despesa', 'Gasto'], id: 'gasto',
      oque: 'Quanto foi investido no periodo. Gasto sozinho nao diz nada — a leitura certa e sempre gasto CONTRA retorno e contra o seu ponto de equilibrio.',
      leitura: null,
      acao: 'Campanha que gasta e vende acima do equilibrio: escale +20%/semana. Gasta e nao vende com 50+ cliques: corrija a oferta antes de qualquer outra coisa.' },
    { rot: ['Pedidos', 'Encomendas'], id: 'pedidos_ads',
      oque: 'Vendas atribuidas ao anuncio. Atencao a janela: vendas dos ultimos 7 dias ainda estao chegando (atribuicao) — o numero recente sempre sobe depois.',
      leitura: null,
      acao: 'Nunca julgue os ultimos 7 dias como fracasso — compare sempre janela fechada com janela fechada.' },
    { rot: ['Posição média', 'Posicao media', 'Classificação Média'], id: 'pos',
      oque: 'Onde seu anuncio aparece em media no leilao. Posicao e consequencia do funil (clique x conversao x ticket), nao do lance: quem converte melhor paga menos por aparecer.',
      leitura: null,
      acao: 'Posicao fraca + CTR bom = trabalhe conversao e ticket (kit, preco psicologico). Posicao fraca + CTR fraco = troque foto e titulo. Lance e o ultimo recurso, nunca o primeiro.' },
    { rot: ['Vendas'], id: 'af_vendas', paths: ['web-seller-affiliate'],
      oque: 'Quanto os afiliados venderam para voce. E venda sem leilao: voce so paga a comissao quando a venda acontece.',
      leitura: function () {
        var fontes = vendasPorFonte();
        var vAf = fontes.affiliate;
        if (vAf === undefined) return null;
        var g = vLente('paid_gmv');
        var ped = pedidosPorFonte('affiliate');
        var partes = ['R$ ' + fLe(vAf, 2) + ' via afiliados'];
        if (ped) partes.push(ped + ' pedido(s), ticket R$ ' + fLe(vAf / ped, 2));
        var fatia = g.v ? vAf / g.v * 100 : null;
        return { valor: 'R$ ' + fLe(vAf, 2), bom: fatia === null || (fatia >= 5 && fatia <= 15) || fatia < 5,
          texto: partes.join(' · ') + (fatia !== null ? ' — ' + fLe(fatia, 1) + '% das vendas da loja (faixa saudavel: 5% a 15%).' : '') }; },
      acao: 'Abaixo de 5% das vendas: suba a comissao extra dos seus 2 melhores produtos para atrair criadores. Acima de 15%: cuidado com a dependencia e o custo somado por pedido.' },
    { rot: ['Comissão Estimada', 'Comissao Estimada'], id: 'af_comissao', paths: ['web-seller-affiliate'],
      oque: 'Quanto voce paga aos afiliados pelas vendas. E o "custo de ads" deste canal — so que pago apenas quando vende.',
      leitura: function () { var af = kpiAfiliado(); if (!af || af.vendas === null || af.pedidos === null || !af.pedidos) return avisoJanelaAf();
        // comissao media do painel ~ 7% (7000/100000) confirmada na coleta; usamos vendas x taxa se comissao direta faltar
        var custoPed = af.comissao !== null ? af.comissao / af.pedidos : null;
        return { valor: af.comissao !== null ? ('R$ ' + fLe(af.comissao, 2)) : null,
          bom: true, texto: custoPed !== null ? 'custo medio de R$ ' + fLe(custoPed, 2) + ' por pedido via afiliado.' : 'sobre ' + af.pedidos + ' pedido(s) via afiliado.' }; },
      acao: 'Comissao alta com ROI alto = otimo. Comissao subindo com ROI caindo = revise em quais produtos a comissao extra esta ativa.' },
    { rot: ['ROI'], id: 'af_roi', paths: ['web-seller-affiliate'],
      oque: 'Retorno por real de comissao: vendas ÷ comissao paga. E o ROAS deste canal.',
      leitura: function () { var af = kpiAfiliado(); if (!af || af.vendas === null) return avisoJanelaAf();
        if (af.comissao === null || !af.comissao) return { valor: null, bom: true, texto: 'vendas de R$ ' + fLe(af.vendas, 2) + ' via afiliado; comissao ainda nao capturada nesta janela.' };
        var roi = af.vendas / af.comissao;
        return { valor: fLe(roi, 1), bom: roi >= 5, texto: (roi >= 10 ? 'saudavel' : roi >= 5 ? 'aceitavel' : 'baixo — comissao cara') + ' (ref: bom > 10, ok > 5).' }; },
      acao: 'Abaixo de 5: reduza a comissao extra dos produtos de margem apertada. Acima de 10: da para investir mais no canal.' },
    { rot: ['Compradores totais'], id: 'af_compradores', paths: ['web-seller-affiliate'],
      oque: 'Quantas pessoas compraram via afiliados. Costuma ser publico NOVO — gente que seu anuncio nao alcancava.',
      leitura: function () { var af = kpiAfiliado(); if (!af || af.pedidos === null) return avisoJanelaAf();
        return { valor: fLe(af.pedidos, 0) + ' pedido(s)', bom: true, texto: 'via afiliado na janela coletada. Cruze com o total da loja para ver o quanto o canal abre de publico.' }; },
      acao: 'Se a maioria for comprador novo, o canal esta cumprindo o papel de abrir audiencia.' },
    { rot: ['Novos compradores'], id: 'af_novos', paths: ['web-seller-affiliate'],
      oque: 'Compradores que compraram pela primeira vez via afiliado. Valor escondido: cliente novo pode recomprar sem custo depois.',
      leitura: function () { return avisoJanelaAf('A Shopee nao expoe "novos" separado na coleta ainda — leia junto com Compradores totais.'); },
      acao: 'Novos caindo com cliques estaveis = criadores falando sempre para a mesma audiencia. Busque afiliados novos no Marketplace.' },
    { rot: ['Itens vendidos brutos'], id: 'af_itens', paths: ['web-seller-affiliate'],
      oque: 'Unidades vendidas via afiliados antes de cancelamentos.',
      leitura: function () { var af = kpiAfiliado(); if (!af || af.unidades === null) return avisoJanelaAf();
        return { valor: fLe(af.unidades, 0) + ' un.', bom: true, texto: 'via afiliado na janela coletada.' }; },
      acao: 'Diferenca grande entre bruto e confirmado = cancelamento alto; costuma ser promessa exagerada no conteudo do criador.' },
    { rot: ['Curtidas'], id: 'likes',
      oque: 'Interesse guardado pra depois. Curtida e comprador futuro — e sinal de relevancia pro algoritmo.',
      leitura: null,
      acao: 'Produto com muitas curtidas e conversao baixa pede oferta relampago: transforma intencao guardada em pedido.' }
  ];

  function montarCardLente(item) {
    var le = item.leitura ? item.leitura() : null;
    var h = '<div style="font-weight:700;font-size:12px;color:#fff;margin-bottom:6px">O que e</div>' +
      '<div style="font-size:12px;color:#c9cdd6;line-height:1.5">' + item.oque + '</div>';
    if (le) {
      h += '<div style="font-weight:700;font-size:12px;color:#fff;margin:10px 0 4px">Como esta o seu</div>' +
        '<div style="font-size:12px;line-height:1.5;color:#c9cdd6"><b style="color:' + (le.bom ? '#2ecc71' : '#f5b041') + '">' + le.valor + '</b>' + (le.texto ? ' — ' + le.texto : '') + '</div>';
    }
    h += '<div style="font-weight:700;font-size:12px;color:#fff;margin:10px 0 4px">Faca assim</div>' +
      '<div style="font-size:12px;color:#c9cdd6;line-height:1.5">' + item.acao + '</div>' +
      '<div style="font-size:9px;color:#6d7280;margin-top:10px;letter-spacing:.08em">SELLER.IA · METODO EFEITO VENDAS</div>';
    return h;
  }

  var cardLente = null;
  function fecharCardLente() {
    if (cardLente && cardLente.parentNode) cardLente.parentNode.removeChild(cardLente);
    cardLente = null;
  }
  function abrirPainelLateral(html, titulo, rect) {
    fecharCardLente();
    cardLente = document.createElement('div');
    cardLente.setAttribute('data-sia-lente-card', '1');
    var pos;
    if (rect) {
      var topo = Math.min(rect.bottom + 8, window.innerHeight - 320);
      var esq = Math.max(8, Math.min(rect.left, window.innerWidth - 450));
      pos = 'top:' + Math.max(60, topo) + 'px;left:' + esq + 'px;';
    } else {
      pos = 'top:72px;right:14px;';
    }
    cardLente.style.cssText = 'all:initial;position:fixed;' + pos + 'z-index:2147483200;width:min(430px,94vw);max-height:70vh;display:flex;flex-direction:column;background:#0c0e12;border:1px solid #2a2f3a;border-top:3px solid #ff4d1c;border-radius:12px;box-shadow:0 16px 50px rgba(0,0,0,.6);font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;';
    cardLente.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #1d212a;flex:none">' +
      '<span style="width:14px;height:14px;border-radius:4px;background:linear-gradient(120deg,#ff4d1c,#7B2FFF);display:inline-block"></span>' +
      '<span style="font:700 12px Arial;color:#fff;letter-spacing:.04em;flex:1">' + (titulo || 'SELLER.IA') + '</span>' +
      '<button data-sia-fechar="1" style="all:initial;cursor:pointer;color:#b8bcc6;font:700 14px Arial;padding:4px 8px;border-radius:6px;background:#12151b">✕</button>' +
      '</div>' +
      '<div style="padding:14px 16px;overflow:auto;font-size:12.5px;line-height:1.55">' + html + '</div>';
    document.documentElement.appendChild(cardLente);
    cardLente.querySelector('[data-sia-fechar]').addEventListener('click', fecharCardLente);
  }
  function abrirCardLente(alvo, item) {
    abrirPainelLateral(montarCardLente(item), 'SELLER.IA · METRICA', alvo && alvo.getBoundingClientRect ? alvo.getBoundingClientRect() : null);
  }

  var TELAS_LENTE = ['/datacenter/overview', '/datacenter/product/traffic', '/portal/web-seller-affiliate', '/portal/marketing/pas'];
  function telaPermitida() {
    for (var i = 0; i < TELAS_LENTE.length; i++) if (location.pathname.indexOf(TELAS_LENTE[i]) === 0 || location.pathname.indexOf(TELAS_LENTE[i]) > 0) return true;
    return false;
  }
  function varrerLente() {
    if (location.hostname !== 'seller.shopee.com.br' || !telaPermitida()) return;
    var jaAnotados = {};
    var selosExistentes = document.querySelectorAll('[data-sia-lente]');
    for (var e0 = 0; e0 < selosExistentes.length; e0++) jaAnotados[selosExistentes[e0].getAttribute('data-sia-lente')] = true;
    var candidatos = document.querySelectorAll('span,div,p,label,th');
    for (var i = 0; i < candidatos.length; i++) {
      var el = candidatos[i];
      if (el.childElementCount > 1) continue;
      if (el.getAttribute('data-sia-lente')) continue;
      var txt = (el.textContent || '').trim();
      if (!txt || txt.length > 60) continue;
      for (var j = 0; j < LENTE.length; j++) {
        var item = LENTE[j];
        if (item.paths) {
          var pathOk = false;
          for (var pp = 0; pp < item.paths.length; pp++) if (location.pathname.indexOf(item.paths[pp]) >= 0) { pathOk = true; break; }
          if (!pathOk) continue;
        }
        var bate = false;
        for (var r2 = 0; r2 < item.rot.length; r2++) {
          if (txt === item.rot[r2]) { bate = true; break; }
        }
        if (!bate) continue;
        if (jaAnotados[item.id]) { break; } // um por metrica por pagina
        jaAnotados[item.id] = true;
        el.setAttribute('data-sia-lente', item.id);
        var selo = document.createElement('span');
        selo.setAttribute('data-sia-selo', '1');
        // barra padrao (igual a das linhas de produto), com nota rapida quando a leitura existir
        var leRapida = item.leitura ? item.leitura() : null;
        selo.textContent = (leRapida && leRapida.valor) ? ('Seller.IA · ' + leRapida.valor) : 'Seller.IA · leitura';
        selo.title = 'O que e, como esta o seu e o que fazer';
        selo.style.cssText = 'all:initial;display:block;width:fit-content;max-width:220px;margin-top:4px;padding:2px 10px;border-radius:4px;background:linear-gradient(120deg,#ff4d1c,#7B2FFF);color:#fff;font:700 8.5px/1.5 Arial;letter-spacing:.05em;cursor:pointer;' + (leRapida ? 'box-shadow:0 0 0 1px ' + (leRapida.bom ? '#2ecc71' : '#f5b041') + ' inset;' : '');
        (function (itemF) {
          selo.addEventListener('click', function (ev) {
            ev.stopPropagation(); ev.preventDefault();
            abrirCardLente(ev.target, itemF);
          });
        })(item);
        el.appendChild(selo);
        break;
      }
    }
  }
  function cardVereditoCampanha(vereditos, nomeCamp) {
    var cor = { forte: '#2ecc71', atencao: '#f5b041', critico: '#e74c3c' };
    var h = '<div style="font-weight:700;font-size:12px;color:#fff;margin-bottom:8px">' + nomeCamp.slice(0, 60) + '</div>';
    for (var i = 0; i < vereditos.length; i++) {
      var vd = vereditos[i];
      h += '<div style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #1d212a">' +
        '<span style="font-size:9px;letter-spacing:.08em;border:1px solid ' + (cor[vd.status] || '#7d8290') + ';color:' + (cor[vd.status] || '#7d8290') + ';border-radius:99px;padding:2px 8px">' + vd.veredito + '</span>' +
        '<div style="font-weight:700;font-size:12px;color:#f2f2f4;margin:6px 0 3px">' + vd.manchete + '</div>' +
        '<div style="font-size:11.5px;color:#c9cdd6;line-height:1.45;white-space:pre-line">' + vd.diagnostico + '</div>';
      if (vd.passos && vd.passos.length) {
        h += '<div style="font-size:11.5px;color:#fff;font-weight:700;margin-top:6px">Faca assim:</div><ol style="margin:2px 0 0 16px;padding:0">';
        for (var p2 = 0; p2 < vd.passos.length; p2++) h += '<li style="font-size:11.5px;color:#c9cdd6;margin:2px 0;line-height:1.4">' + vd.passos[p2] + '</li>';
        h += '</ol>';
      }
      if (vd.impacto) h += '<div style="font-size:11.5px;margin-top:5px;color:#a78bfa"><b>Impacto:</b> <span style="color:#c9cdd6">' + vd.impacto + '</span></div>';
      h += '</div>';
    }
    h += '<div style="font-size:9px;color:#6d7280;letter-spacing:.08em">SELLER.IA · METODO EFEITO VENDAS</div>';
    return h;
  }

  function abrirCardHtml(alvo, html) {
    abrirPainelLateral(html, 'SELLER.IA · LEITURA', alvo && alvo.getBoundingClientRect ? alvo.getBoundingClientRect() : null);
  }

  function vereditosDaCampanha(idC) {
    var vs = estado.diagnostico && estado.diagnostico.vereditos ? estado.diagnostico.vereditos : [];
    return vs.filter(function (v) { return String(v.id).split(':')[0] === String(idC); });
  }
  function grupoObservacao() {
    var vs = estado.diagnostico && estado.diagnostico.vereditos ? estado.diagnostico.vereditos : [];
    for (var i = 0; i < vs.length; i++) if (vs[i].escopo === 'grupo' && vs[i].id === 'observacao') return vs[i];
    return null;
  }
  function vestirBarraCampanha(barra, idC) {
    var meus = vereditosDaCampanha(idC);
    if (meus.length) {
      var pior = 'forte';
      for (var m2 = 0; m2 < meus.length; m2++) {
        if (meus[m2].status === 'critico') { pior = 'critico'; break; }
        if (meus[m2].status === 'atencao') pior = 'atencao';
      }
      var corS = pior === 'forte' ? '#2ecc71' : pior === 'critico' ? '#e74c3c' : '#f5b041';
      var mB = estado.campanhas[idC] && estado.campanhas[idC].metricas ? estado.campanhas[idC].metricas : {};
      var posTxt = typeof mB.posicao === 'number' ? ' · POS ' + Math.round(mB.posicao) : '';
      barra.textContent = 'Seller.IA · ' + meus[0].veredito + posTxt;
      barra.style.boxShadow = '0 0 0 1px ' + corS + ' inset';
      return;
    }
    if (estado.diagnostico && estado.diagnostico.vereditos && grupoObservacao()) {
      barra.textContent = 'Seller.IA · EM OBSERVACAO';
      barra.style.boxShadow = '0 0 0 1px #f5b041 inset';
      return;
    }
    barra.textContent = 'Seller.IA · analisar';
    barra.style.boxShadow = 'none';
  }
  function varrerCampanhasNaTela() {
    if (location.pathname.indexOf('/portal/marketing/pas') < 0) return;
    var nomes = [];
    for (var id in estado.campanhas) {
      var cnome = estado.campanhas[id].nome;
      if (cnome && cnome.length > 6) nomes.push({ id: id, nome: cnome });
    }
    if (!nomes.length) return;
    // atualiza barras existentes (pos-analise elas ganham o veredito sozinhas)
    var jaTemBarra = {};
    var barras = document.querySelectorAll('[data-sia-barra-camp]');
    for (var b2 = 0; b2 < barras.length; b2++) {
      var idB = barras[b2].getAttribute('data-sia-barra-camp');
      if (jaTemBarra[idB]) { if (barras[b2].parentNode) barras[b2].parentNode.removeChild(barras[b2]); continue; }
      jaTemBarra[idB] = true;
      vestirBarraCampanha(barras[b2], idB);
    }
    var candidatos = document.querySelectorAll('span,div,p,a');
    for (var i = 0; i < candidatos.length; i++) {
      var el = candidatos[i];
      if (el.childElementCount > 1 || el.getAttribute('data-sia-camp')) continue;
      var txt = (el.textContent || '').trim();
      if (txt.length < 8 || txt.length > 90) continue;
      for (var j = 0; j < nomes.length; j++) {
        var nomeJ = nomes[j].nome;
        var casa = txt === nomeJ ||
          (txt.length >= 25 && nomeJ.indexOf(txt.replace(/\.\.\.$/, '')) === 0) ||
          (nomeJ.length >= 25 && txt.indexOf(nomeJ.slice(0, 45)) === 0);
        if (!casa) continue;
        el.setAttribute('data-sia-camp', nomes[j].id);
        if (jaTemBarra[nomes[j].id]) break; // uma barra por campanha na pagina
        jaTemBarra[nomes[j].id] = true;
        var selo = document.createElement('span');
        selo.setAttribute('data-sia-barra-camp', nomes[j].id);
        selo.title = 'Veredito desta campanha';
        selo.style.cssText = 'all:initial;display:block;width:fit-content;max-width:230px;margin-top:3px;padding:2px 10px;border-radius:4px;background:linear-gradient(120deg,#ff4d1c,#7B2FFF);color:#fff;font:700 8.5px/1.5 Arial;letter-spacing:.05em;cursor:pointer;';
        vestirBarraCampanha(selo, nomes[j].id);
        (function (idF, nomeF) {
          selo.addEventListener('click', function (ev) {
            ev.stopPropagation(); ev.preventDefault();
            var meusAgora = vereditosDaCampanha(idF); // LIDO NA HORA DO CLIQUE
            if (meusAgora.length) { abrirCardHtml(ev.target, cardVereditoCampanha(meusAgora, nomeF)); return; }
            var grupo = grupoObservacao();
            if (grupo) {
              var cG = estado.campanhas[idF];
              var mG = cG && cG.metricas ? cG.metricas : {};
              var roasG = mG.roas !== undefined ? mG.roas : (mG.gasto ? (mG.gmv || 0) / mG.gasto : null);
              abrirCardHtml(ev.target, '<div style="color:#c9cdd6"><b style="color:#fff">' + nomeF.slice(0, 60) + '</b><br>' +
                '<span style="font-size:9px;letter-spacing:.08em;border:1px solid #f5b041;color:#f5b041;border-radius:99px;padding:2px 8px;display:inline-block;margin:6px 0">EM OBSERVACAO</span><br>' +
                'Numeros do periodo: gasto R$ ' + fLe(mG.gasto || 0, 2) + ' · vendas R$ ' + fLe(mG.gmv || 0, 2) + ' · ' + fLe(mG.pedidos || 0, 0) + ' pedido(s)' + (roasG ? ' · ROAS ' + fLe(roasG, 2) + 'x' : '') + '.<br>' +
                (typeof mG.posicao === 'number' ? '<b style="color:#fff">Leilao:</b> posicao media ' + Math.round(mG.posicao) + (mG.posicao <= 10 ? ' — vitrine nobre; o funil esta pagando o espaco.' : mG.posicao > 40 ? ' — fundo de vitrine; enquanto acumula vendas, ja da pra atacar a causa: ' + (typeof mG.ctr === 'number' && (mG.ctr <= 1 ? mG.ctr * 100 : mG.ctr) >= 2 ? 'o card clica bem, o alvo e conversao/ticket da pagina.' : 'o card clica pouco — foto principal e titulo.') : ' — zona intermediaria do leilao.') + '<br>' : '') +
                (typeof mG.ctr === 'number' ? '<b style="color:#fff">CTR:</b> ' + fLe((mG.ctr <= 1 ? mG.ctr * 100 : mG.ctr), 2) + '%<br>' : '') + '<br>' +
                '<b style="color:#fff">Por que sem veredito individual:</b> ainda ha poucas vendas para uma leitura confiavel — o ROAS pode dobrar ou cair pela metade por puro acaso. Decidir agora seria chutar.<br><br>' +
                '<b style="color:#fff">Faca assim:</b> nao pause nem escale; mantenha o orcamento estavel e deixe acumular vendas. Quando passar do volume minimo da janela, o veredito proprio aparece aqui sozinho.</div>');
              return;
            }
            {
              var c = estado.campanhas[idF];
              var m = c && c.metricas ? c.metricas : {};
              var roasT = m.roas !== undefined ? m.roas : (m.gasto ? (m.gmv || 0) / m.gasto : null);
              abrirCardHtml(ev.target, '<div style="color:#c9cdd6"><b style="color:#fff">' + nomeF.slice(0, 60) + '</b><br><br>' +
                'Dados coletados: gasto R$ ' + fLe(m.gasto || 0, 2) + ' · vendas R$ ' + fLe(m.gmv || 0, 2) + (roasT ? ' · ROAS ' + fLe(roasT, 2) + 'x' : '') + '.<br><br>' +
                'Rode <b style="color:#ff4d1c">Coletar conta completa + Analisar</b> no painel para o veredito do metodo aparecer aqui.</div>');
            }
          });
        })(nomes[j].id, nomes[j].nome);
        el.appendChild(selo);
        break;
      }
    }
  }
  function comissaoShopee(preco) {
    if (preco <= 79.99) return preco * 0.20 + 4;
    if (preco <= 99.99) return preco * 0.14 + 16;
    if (preco <= 199.99) return preco * 0.14 + 20;
    return preco * 0.14 + 26;
  }

  function leituraLocalProduto(m) {
    // julgamento imediato, sempre com nota explicita (o Cerebro aprofunda no Analisar)
    var itens = [];
    function pct(v) { return v <= 1 ? v * 100 : v; }
    function nota(ok2, rotulo) { return '<b style="color:' + (ok2 === true ? '#2ecc71' : ok2 === false ? '#e74c3c' : '#f5b041') + '">' + rotulo + '</b>'; }

    if (typeof m.ctr_card === 'number') {
      var ctr = pct(m.ctr_card);
      var nCtr = ctr >= 3 ? nota(true, 'EXCELENTE') : ctr >= 1.5 ? nota(true, 'BOM') : ctr >= 1 ? nota(null, 'MEDIANO') : nota(false, 'FRACO');
      itens.push({ ok: ctr >= 1.5, txt: 'CTR do card ' + fLe(ctr, 2) + '% — ' + nCtr + '. Referencia: bom acima de 1,5%, excelente acima de 3%. ' + (ctr >= 1.5 ? 'A vitrine (foto + preco + titulo) esta vencendo a disputa pelo clique.' : 'A vitrine perde a disputa: foto principal e inicio do titulo sao o alvo.') });
    }
    if (typeof m.conversao_pago === 'number') {
      var cv = pct(m.conversao_pago);
      var nCv = cv >= 2 ? nota(true, 'EXCELENTE') : cv >= 1 ? nota(true, 'BOM') : cv >= 0.5 ? nota(null, 'MEDIANO') : nota(false, 'FRACO');
      itens.push({ ok: cv >= 1, txt: 'Conversao da pagina ' + fLe(cv, 2) + '% — ' + nCv + '. Referencia: bom acima de 1%, excelente acima de 2%. ' + (cv >= 1 ? 'De cada 100 visitantes, ' + fLe(cv, 1) + ' compram — a pagina cumpre o papel.' : 'O clique chega mas a pagina nao fecha: confira preco vs concorrencia, variacoes com estoque e avaliacoes.') });
    }
    if (typeof m.rejeicao === 'number') {
      var rj = pct(m.rejeicao);
      var nRj = rj <= 25 ? nota(true, 'BOA') : rj <= 35 ? nota(null, 'ACEITAVEL') : nota(false, 'ALTA');
      itens.push({ ok: rj <= 35, txt: 'Rejeicao ' + fLe(rj, 1) + '% — ' + nRj + '. Referencia: boa ate 25%, aceitavel ate 35%. ' + (rj > 35 ? 'Acima disso, o card esta prometendo o que a pagina nao entrega.' : 'Visitante esta ficando e navegando.') });
    }
    if (typeof m.ticket_pedido === 'number') {
      var tk = m.ticket_pedido;
      var com = comissaoShopee(tk);
      var liquido = tk - com;
      var linha = 'Do ticket de R$ ' + fLe(tk, 2) + ': comissao Shopee R$ ' + fLe(com, 2) + ' → sobram <b style="color:#f2f2f4">R$ ' + fLe(liquido, 2) + '</b> por pedido, antes de custo do produto e trafego.';
      if (typeof m.gasto === 'number' && typeof m.pedidos_pagos === 'number' && m.pedidos_pagos > 0 && m.gasto > 0) {
        var adsPed = m.gasto / m.pedidos_pagos;
        linha += ' Descontando o ads deste produto (~R$ ' + fLe(adsPed, 2) + '/pedido, estimado), sobram <b style="color:#f2f2f4">R$ ' + fLe(liquido - adsPed, 2) + '</b>.';
      }
      if (m.fontes) {
        if (m.fontes.ads && typeof m.fontes.ads.vendas === 'number') linha += ' Vendas via Ads: R$ ' + fLe(m.fontes.ads.vendas, 2) + '.';
        if (m.fontes.afiliado && typeof m.fontes.afiliado.vendas === 'number') linha += ' Via Afiliado: R$ ' + fLe(m.fontes.afiliado.vendas, 2) + '.';
      }
      linha += ' Cadastre o custo no Cofre (em breve) e a margem final aparece aqui.';
      if (tk >= 60 && tk < 80) linha += ' E este ticket esta a R$ ' + fLe(80 - tk, 2) + ' do degrau: kit cruzando R$80 muda a comissao para 14% + R$16.';
      itens.push({ ok: null, txt: linha });
    }
    if (typeof m.fatia_vendas === 'number' && m.fatia_vendas >= 0.3) {
      itens.push({ ok: false, txt: 'Este produto sozinho e ' + fLe(m.fatia_vendas * 100, 0) + '% das vendas da loja — ' + nota(false, 'CONCENTRACAO') + '. Forte, mas se ele engasgar (estoque, concorrente), a loja inteira sente. Construa o segundo pilar.' });
    }
    return itens;
  }

  function cardProduto(id) {
    var p = estado.produtos[id];
    var titulo = p && p.nome ? p.nome.slice(0, 70) : 'Produto ' + id;
    var h = '<div style="font-weight:700;font-size:12px;color:#fff;margin-bottom:2px">' + titulo + '</div>' +
      '<div style="font-size:9.5px;color:#6d7280;margin-bottom:8px">ID ' + id + '</div>';
    if (!p || !p.metricas || !Object.keys(p.metricas).length) {
      return h + '<div style="font-size:12px;color:#c9cdd6;line-height:1.5">Ainda sem dados coletados deste produto nesta sessao. Navegue pela <b>Performance de Produto</b> (e role ate ele aparecer na lista) — a leitura fica pronta aqui.</div>';
    }
    var m = p.metricas;
    function cel(rot, val) { return val === undefined || val === null ? '' : '<div style="min-width:86px"><div style="font-size:9px;color:#6d7280;text-transform:uppercase;letter-spacing:.05em">' + rot + '</div><div style="font-size:13px;font-weight:700;color:#f2f2f4">' + val + '</div></div>'; }
    function pct(v) { return v === undefined ? undefined : fLe((v <= 1 ? v * 100 : v), 2) + '%'; }
    h += '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px">' +
      cel('Vendas', m.vendas_pagas !== undefined ? 'R$ ' + fLe(m.vendas_pagas, 2) : undefined) +
      cel('Pedidos', m.pedidos_pagos !== undefined ? fLe(m.pedidos_pagos, 0) : undefined) +
      cel('Ticket', m.ticket_pedido !== undefined ? 'R$ ' + fLe(m.ticket_pedido, 2) : undefined) +
      cel('CTR card', pct(m.ctr_card)) +
      cel('Conversao', pct(m.conversao_pago)) +
      cel('Rejeicao', pct(m.rejeicao)) +
      cel('Fatia da loja', pct(m.fatia_vendas)) +
      '</div>';
    var leituras = leituraLocalProduto(m);
    if (leituras.length) {
      h += '<div style="font-weight:700;font-size:12px;color:#fff;margin-bottom:4px">O que os numeros dizem</div>';
      for (var i = 0; i < leituras.length; i++) {
        var corPonto = leituras[i].ok === true ? '#2ecc71' : leituras[i].ok === false ? '#e74c3c' : '#f5b041';
        h += '<div style="font-size:11.5px;line-height:1.5;color:#c9cdd6;margin-bottom:5px"><span style="color:' + corPonto + '">&#9679;</span> ' + leituras[i].txt + '</div>';
      }
    }
    var vds = estado.diagnostico && estado.diagnostico.vereditos ? estado.diagnostico.vereditos.filter(function (v) { return String(v.id).split(':')[0] === String(id); }) : [];
    if (vds.length) {
      h += '<div style="font-weight:700;font-size:12px;color:#fff;margin:8px 0 4px">Veredito Seller.IA</div>';
      for (var v2 = 0; v2 < Math.min(vds.length, 2); v2++) {
        var vd = vds[v2];
        h += '<div style="font-size:11.5px;color:#c9cdd6;line-height:1.45;margin-bottom:6px"><b style="color:#ff4d1c">' + vd.veredito + '</b> — ' + vd.manchete + '</div>';
        if (vd.passos && vd.passos.length) {
          h += '<ol style="margin:0 0 4px 16px;padding:0">';
          for (var pz = 0; pz < vd.passos.length; pz++) h += '<li style="font-size:11px;color:#c9cdd6;margin:2px 0">' + vd.passos[pz] + '</li>';
          h += '</ol>';
        }
      }
    } else {
      h += '<div style="font-size:10.5px;color:#6d7280;margin-top:6px">Para o veredito completo do metodo, clique em Analisar no painel Seller.IA.</div>';
    }
    h += '<div style="font-size:9px;color:#6d7280;margin-top:8px;letter-spacing:.08em">SELLER.IA · METODO EFEITO VENDAS</div>';
    return h;
  }

  function varrerLinhasDeProduto() {
    if (location.hostname !== 'seller.shopee.com.br') return;
    var candidatos = document.querySelectorAll('span,div,p');
    for (var i = 0; i < candidatos.length; i++) {
      var el = candidatos[i];
      if (el.childElementCount > 1 || el.getAttribute('data-sia-prod')) continue;
      var txt = (el.textContent || '').trim();
      var m = txt.match(/^ID do Produto:?\s*(\d{6,})$/);
      if (!m) continue;
      var idp = m[1];
      el.setAttribute('data-sia-prod', idp);
      var selo = document.createElement('span');
      selo.textContent = 'Seller.IA';
      selo.title = 'Ver a leitura deste produto';
      selo.style.cssText = 'all:initial;display:inline-block;margin-left:8px;padding:2px 8px;border-radius:99px;background:linear-gradient(120deg,#ff4d1c,#7B2FFF);color:#fff;font:700 8.5px/1.3 Arial;letter-spacing:.05em;cursor:pointer;vertical-align:middle;';
      (function (idF) {
        selo.addEventListener('click', function (ev) {
          ev.stopPropagation(); ev.preventDefault();
          abrirCardHtml(ev.target, cardProduto(idF));
        });
      })(idp);
      el.appendChild(selo);
    }
  }

  /* pagina publica: 3 caminhos de leitura + diagnostico do porque */
  estado.debugPublico = null;
  function lerPaginaPublica() {
    if (estado.modoPagina !== 'publico') return;
    if (!estado.paginaProduto) { estado.debugPublico = 'URL sem ID reconhecivel: ' + location.pathname.slice(0, 60); return; }
    if (estado.anuncioPublico && estado.anuncioPublico.id === estado.paginaProduto) return;
    // Caminho 2: meta tags (og:) — presentes mesmo sem JSON-LD
    function lerMetas() {
      function meta(nome) { var el = document.querySelector('meta[property="' + nome + '"],meta[name="' + nome + '"]'); return el ? el.getAttribute('content') : null; }
      var titulo = meta('og:title');
      if (!titulo || titulo.length < 5) return false;
      var precoM = meta('product:price:amount') || meta('og:price:amount');
      var img = meta('og:image');
      estado.anuncioPublico = {
        id: estado.paginaProduto,
        nome: titulo.replace(/\s*\|\s*Shopee.*$/i, ''),
        preco: precoM ? parseFloat(precoM) : null,
        preco_max: null, estrelas: null, vendidos: null,
        imagens: img ? [img] : [],
        origem_leitura: 'meta',
        capturado_em: Date.now()
      };
      var p = entidadeProduto(estado.paginaProduto);
      if (estado.anuncioPublico.nome) p.nome = estado.anuncioPublico.nome;
      if (estado.anuncioPublico.preco !== null && !isNaN(estado.anuncioPublico.preco)) p.preco_publico = estado.anuncioPublico.preco;
      estado.sujo = true;
      return true;
    }
    // Caminho 3: preco visivel no DOM (ultimo recurso)
    function lerDom() {
      var els = document.querySelectorAll('div,span,section');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.childElementCount > 2) continue;
        var t = (el.textContent || '').trim();
        var mR = t.match(/^R\$\s?([\d.]{1,7},\d{2})$/);
        if (mR) {
          var preco = parseFloat(mR[1].replace(/\./g, '').replace(',', '.'));
          if (preco > 0 && preco < 100000) {
            estado.anuncioPublico = { id: estado.paginaProduto, nome: (document.title || '').replace(/\s*\|\s*Shopee.*$/i, ''), preco: preco, preco_max: null, estrelas: null, vendidos: null, imagens: [], origem_leitura: 'dom', capturado_em: Date.now() };
            var p2 = entidadeProduto(estado.paginaProduto);
            if (estado.anuncioPublico.nome) p2.nome = estado.anuncioPublico.nome;
            p2.preco_publico = preco;
            estado.sujo = true;
            return true;
          }
        }
      }
      return false;
    }
    try {
      var scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (var i = 0; i < scripts.length; i++) {
        var dados;
        try { dados = JSON.parse(scripts[i].textContent); } catch (e) { continue; }
        var lista = Array.isArray(dados) ? dados : [dados];
        for (var j = 0; j < lista.length; j++) {
          var dj = lista[j];
          if (!dj || dj['@type'] !== 'Product') continue;
          var oferta = dj.offers || {};
          if (Array.isArray(oferta)) oferta = oferta[0] || {};
          var aval = dj.aggregateRating || {};
          estado.anuncioPublico = {
            id: estado.paginaProduto,
            nome: dj.name || '',
            preco: oferta.price !== undefined ? parseFloat(oferta.price) : (oferta.lowPrice !== undefined ? parseFloat(oferta.lowPrice) : null),
            preco_max: oferta.highPrice !== undefined ? parseFloat(oferta.highPrice) : null,
            estrelas: aval.ratingValue !== undefined ? parseFloat(aval.ratingValue) : null,
            vendidos: null,
            imagens: dj.image ? (Array.isArray(dj.image) ? dj.image : [dj.image]) : [],
            capturado_em: Date.now()
          };
          var p = entidadeProduto(estado.paginaProduto);
          if (estado.anuncioPublico.nome) p.nome = estado.anuncioPublico.nome;
          if (estado.anuncioPublico.preco !== null && !isNaN(estado.anuncioPublico.preco)) p.preco_publico = estado.anuncioPublico.preco;
          estado.anuncioPublico.origem_leitura = 'json-ld';
          estado.sujo = true;
          estado.debugPublico = 'lido via JSON-LD';
          return;
        }
      }
      // JSON-LD nao achado ou incompleto: tentar metas, depois DOM
      var nLd = document.querySelectorAll('script[type="application/ld+json"]').length;
      if (lerMetas()) { estado.debugPublico = 'lido via meta tags (JSON-LD: ' + nLd + ')'; return; }
      if (lerDom()) { estado.debugPublico = 'lido via DOM (JSON-LD: ' + nLd + ', metas: nao)'; return; }
      estado.debugPublico = 'FALHOU — JSON-LD: ' + nLd + ', og:title: ' + (document.querySelector('meta[property="og:title"]') ? 'sim' : 'nao') + ', preco visivel: nao achado';
    } catch (e) { estado.debugPublico = 'erro: ' + String(e).slice(0, 80); }
  }

  var varreduraAgendada = null;
  function varrerTudo() {
    varreduraAgendada = null;
    // v0.17.1: selos na tela DESLIGADOS — a analise vive no painel proprio (gaveta).
    // Isso deixa a pagina da Shopee leve e nao corta mais os numeros dela.
    try { lerPaginaPublica(); } catch (e) { /* noop */ }
  }
  function agendarVarredura() {
    if (varreduraAgendada) return;
    varreduraAgendada = setTimeout(varrerTudo, 350); // logo apos a Shopee redesenhar
  }
  try {
    // v0.17.1: sem selos na tela, o observer so precisa reagir a troca de PAGINA
    // (mudanca de URL), nao a cada micro-redesenho. Muito mais leve.
    var ultimaUrl = location.href;
    var observador = new MutationObserver(function () {
      if (location.href !== ultimaUrl) { ultimaUrl = location.href; agendarVarredura(); }
    });
    observador.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* noop */ }
  // v0.17.1: remove qualquer selo grudado por versoes anteriores (limpa a tela)
  try {
    var lixo = document.querySelectorAll('[data-sia-selo],[data-sia-barra-camp],[data-sia-lente]');
    for (var lx = 0; lx < lixo.length; lx++) { if (lixo[lx].parentNode) lixo[lx].parentNode.removeChild(lixo[lx]); }
  } catch (e) { /* noop */ }
  setTimeout(varrerTudo, 800);
  setInterval(varrerTudo, 8000); // rede de seguranca leve (so leitura publica)

  /* auto-coleta: ao entrar no Seller Centre, coleta e analisa sozinha (no maximo 1x a cada 12h) */
  var AUTO_INTERVALO_MS = 12 * 3600 * 1000;
  var autoTentativas = 0;
  var autoTimer = setInterval(function () {
    if (location.hostname !== 'seller.shopee.com.br') { clearInterval(autoTimer); return; }
    autoTentativas++;
    if (autoTentativas > 24) { clearInterval(autoTimer); return; } // ~2min tentando achar a sessao
    if (!estado.spc || estado.coletaProgresso) return;
    clearInterval(autoTimer);
    try {
      chrome.runtime.sendMessage({ tipo: 'sia:carregar' }, function (r) {
        void chrome.runtime.lastError;
        var ultimo = 0;
        try { ultimo = (r && r.coleta && r.coleta.auto_ts) || 0; } catch (e) { /* noop */ }
        if (Date.now() - ultimo < AUTO_INTERVALO_MS) return;
        coletaCompleta(function () { estado.sujo = true; }).then(function (res) {
          if (!res.ok) return;
          var foto = fotoDoEstado();
          foto.auto_ts = Date.now();
          try {
            chrome.runtime.sendMessage({ tipo: 'sia:salvar', coleta: foto }, function () {
              void chrome.runtime.lastError;
              var payload = { loja: estado.loja ? estado.loja.shop_id : 'desconhecida', snapshot: foto };
              chrome.runtime.sendMessage({ tipo: 'sia:analisar', payload: payload }, function (resp) {
                void chrome.runtime.lastError;
                if (resp) { estado.diagnostico = resp; estado.sujo = true; }
              });
            });
          } catch (e) { /* noop */ }
        });
      });
    } catch (e) { /* noop */ }
  }, 5000);

  /* ====================== COLETA COMPLETA (1 clique) ====================== */
  var pendentesBusca = {};
  var seqBusca = 0;
  window.addEventListener('SIA_BUSCA_RESULTADO', function (ev) {
    var r;
    try { r = JSON.parse(ev.detail); } catch (e) { return; }
    if (r && r.id && pendentesBusca[r.id]) { pendentesBusca[r.id](r); delete pendentesBusca[r.id]; }
  });
  function buscar(url, metodo, corpo) {
    return new Promise(function (resolve) {
      var id = 'b' + (++seqBusca) + '_' + Date.now();
      pendentesBusca[id] = resolve;
      try {
        window.dispatchEvent(new CustomEvent('SIA_BUSCAR', { detail: JSON.stringify({ id: id, url: url, metodo: metodo || 'GET', corpo: corpo || null }) }));
      } catch (e) { resolve({ ok: false, erro: 'ponte indisponivel' }); }
      setTimeout(function () { if (pendentesBusca[id]) { pendentesBusca[id]({ ok: false, erro: 'tempo esgotado' }); delete pendentesBusca[id]; } }, 15000);
    });
  }
  function pausa(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function coletaCompleta(aoProgresso) {
    return new Promise(function (resolver) {
      (async function () {
        function prog(t) { estado.coletaProgresso = t; estado.sujo = true; if (aoProgresso) aoProgresso(t); }
        if (!estado.spc) { prog(null); resolver({ ok: false, erro: 'Abra qualquer pagina do Seller Centre e tente de novo (chave de sessao ainda nao capturada).' }); return; }
        // A Shopee EXIGE datas alinhadas ao dia no fuso do Brasil (UTC-3),
        // senao retorna code 10006 "invalid param". Calculamos inicio do dia
        // (00:00 BRT = 03:00 UTC) e fim do dia (23:59 BRT).
        // BRT = UTC-3, entao o offset e 3*3600 = 10800s.
        var BRT = 3 * 3600;
        var agora = Math.floor(Date.now() / 1000);
        function inicioDoDiaBRT(ts) {
          // 00:00 BRT = 03:00 UTC. Vai pro dia UTC deslocado, arredonda, volta.
          return Math.floor((ts - BRT) / 86400) * 86400 + BRT;
        }
        var ini, fim;
        // PREFERIDO: reusa o periodo REAL que a Shopee ja validou (capturado
        // quando voce navegou pela Central de Dados). Nunca erra o formato.
        if (estado.periodoMydata && estado.periodoMydata.inicio && estado.periodoMydata.fim) {
          ini = estado.periodoMydata.inicio;
          fim = estado.periodoMydata.fim;
        } else {
          // FALLBACK: calcula (inicio do mes ate ontem 00:00 BRT)
          var hoje0 = inicioDoDiaBRT(agora);
          var dNow = new Date(hoje0 * 1000);
          var primeiroMes = new Date(Date.UTC(dNow.getUTCFullYear(), dNow.getUTCMonth(), 1, 3, 0, 0));
          ini = Math.floor(primeiroMes.getTime() / 1000);
          fim = hoje0 - 86400;
        }
        // se estiver na tela de Ads com janela selecionada, espelha (alinhado ao dia)
        var mFrom = location.search.match(/[?&]from=(\d{9,11})/);
        var mTo = location.search.match(/[?&]to=(\d{9,11})/);
        if (mFrom && mTo) { ini = inicioDoDiaBRT(parseInt(mFrom[1], 10)); fim = inicioDoDiaBRT(parseInt(mTo[1], 10)); }
        var spcQ = 'SPC_CDS=' + estado.spc + '&SPC_CDS_VER=2';
        var totalChamadas = 0;

        // A) Campanhas do Ads (paginado por offset)
        prog('Lendo campanhas do Shopee Ads...');
        for (var off = 0; off < 400; off += 20) {
          var corpoC = JSON.stringify({ start_time: ini, end_time: fim, filter_list: [{ campaign_type: 'product_homepage_v3', state: 'all', search_term: '', is_valid_rebate_only: false }], offset: off, limit: 20, use_paid_gmv: false });
          var rc = await buscar('/api/pas/v1/homepage/query/?' + spcQ, 'POST', corpoC);
          totalChamadas++;
          if (!rc.ok || !rc.dados) break;
          processarPacote({ url: '/api/pas/v1/homepage/query/', metodo: 'POST', corpo: corpoC, dados: rc.dados, ts: Date.now() });
          var lote = rc.dados.data && rc.dados.data.entry_list ? rc.dados.data.entry_list.length : 0;
          prog('Campanhas lidas: ' + Object.keys(estado.campanhas).length + '...');
          if (lote < 20) break;
          await pausa(450);
        }
        estado.periodoAds = { inicio: ini, fim: fim, dias: 30 };

        // B) Variacao das 12 maiores campanhas (report/get com ratio)
        var idsTop = Object.keys(estado.campanhas).filter(function (k) { var mm = estado.campanhas[k].metricas || {}; return (mm.gasto || 0) > 0 || (mm.gmv || 0) > 0; })
          .sort(function (a, b) { return (estado.campanhas[b].metricas.gasto || 0) - (estado.campanhas[a].metricas.gasto || 0); }).slice(0, 30);
        for (var t2 = 0; t2 < idsTop.length; t2++) {
          prog('Aprofundando campanha ' + (t2 + 1) + ' de ' + idsTop.length + '...');
          var corpoR = JSON.stringify({ start_time: ini, end_time: fim, campaign_type: 'product', agg_type: 'campaign_id', filter_params: { campaign_id: parseInt(idsTop[t2], 10) }, need_ratio: true });
          var rr = await buscar('/api/pas/v1/report/get/?' + spcQ, 'POST', corpoR);
          totalChamadas++;
          if (rr.ok && rr.dados) processarPacote({ url: '/api/pas/v1/report/get/', metodo: 'POST', corpo: corpoR, dados: rr.dados, ts: Date.now() });
          await pausa(450);
        }

        // C) Funil de todos os produtos (Central de Dados, paginado)
        prog('Lendo o funil dos produtos...');
        for (var pg = 1; pg <= 12; pg++) {
          var urlP = '/api/mydata/v4/product/performance/?' + spcQ + '&start_time=' + ini + '&end_time=' + fim + '&period=month&keyword=&category_type=shopee&category_id=-1&page_size=10&page_num=' + pg + '&order_type=paid&order_by=paid_sales.desc';
          var rp = await buscar(urlP, 'GET', null);
          totalChamadas++;
          if (!rp.ok || !rp.dados) break;
          processarPacote({ url: urlP, metodo: 'GET', corpo: null, dados: rp.dados, ts: Date.now() });
          var itens = rp.dados.result && rp.dados.result.items ? rp.dados.result.items.length : 0;
          prog('Produtos lidos: ' + Object.keys(estado.produtos).length + '...');
          if (itens < 20) break;
          await pausa(450);
        }

        // D) Fatia de vendas + vinculo campanha (traffic item-list, paginado)
        prog('Cruzando fatia de vendas e campanhas...');
        for (var pg2 = 1; pg2 <= 12; pg2++) {
          var urlT = '/api/mydata/v1/product/traffic/item-list/?' + spcQ + '&keyword=&order_by=&page_size=10&page_num=' + pg2 + '&category_type=shop&start_time=' + ini + '&end_time=' + fim + '&period=month&category_id=-1';
          var rt = await buscar(urlT, 'GET', null);
          totalChamadas++;
          if (!rt.ok || !rt.dados) break;
          processarPacote({ url: urlT, metodo: 'GET', corpo: null, dados: rt.dados, ts: Date.now() });
          var itens2 = rt.dados.result && rt.dados.result.item ? rt.dados.result.item.length : 0;
          if (itens2 < 20) break;
          await pausa(450);
        }

        // D2) Funil de vendas (overview) — a origem do dinheiro (card/ads/afiliado)
        prog('Lendo o funil de vendas...');
        var urlFo = (estado.urlsReais && estado.urlsReais.funilOverview) || ('/api/mydata/v1/product/traffic/overview/?' + spcQ + '&start_time=' + ini + '&end_time=' + fim + '&period=month&order_type=paid');
        var rfo = await buscar(urlFo, 'GET', null);
        totalChamadas++;
        if (rfo.ok && rfo.dados) processarPacote({ url: urlFo, metodo: 'GET', corpo: null, dados: rfo.dados, ts: Date.now() });
        await pausa(150);

        // helper: prefere a URL REAL capturada da Central (a Shopee ja validou);
        // se nao navegou aquela tela ainda, usa a reconstruida (fallback).
        var reais = estado.urlsReais || {};
        function urlComPagina(real, pg) {
          // troca page_num na URL real, mantendo todo o resto identico
          if (/page_num=/.test(real)) return real.replace(/page_num=\d+/, 'page_num=' + pg);
          return real + '&page_num=' + pg;
        }

        // D3) Fontes de trafego (traffic-sources)
        prog('Cruzando fontes de trafego...');
        var urlF = reais.trafficSources || ('/api/mydata/v1/dashboard/traffic-sources/?' + spcQ + '&start_time=' + ini + '&end_time=' + fim + '&period=month&order_type=paid');
        var rf = await buscar(urlF, 'GET', null);
        totalChamadas++;
        if (rf.ok && rf.dados) processarPacote({ url: urlF, metodo: 'GET', corpo: null, dados: rf.dados, ts: Date.now() });

        // E) Indicadores gerais da loja — key-metrics
        prog('Lendo os indicadores gerais...');
        var urlK = reais.keyMetrics || ('/api/mydata/v3/dashboard/key-metrics/?' + spcQ + '&start_time=' + ini + '&end_time=' + fim + '&period=month&fetag=fetag');
        var rk = await buscar(urlK, 'GET', null);
        totalChamadas++;
        if (rk.ok && rk.dados) processarPacote({ url: urlK, metodo: 'GET', corpo: null, dados: rk.dados, ts: Date.now() });

        // G) Vendas e cancelamentos (saude das vendas)
        prog('Lendo vendas e cancelamentos...');
        var urlO = (estado.urlsReais && estado.urlsReais.orderPerf) || ('/api/mydata/dashboard/order-performance/?' + spcQ + '&start_time=' + ini + '&end_time=' + fim + '&period=month&fetag=fetag&order_type=paid');
        var ro = await buscar(urlO, 'GET', null);
        totalChamadas++;
        if (ro.ok && ro.dados) processarPacote({ url: urlO, metodo: 'GET', corpo: null, dados: ro.dados, ts: Date.now() });
        await pausa(150);

        // H) Saude da conta (penalidade, rating de performance)
        prog('Lendo a saude da conta...');
        var urlH = '/api/accounthealth/v1/sc/shops/overview?' + spcQ;
        var rh = await buscar(urlH, 'GET', null);
        totalChamadas++;
        if (rh.ok && rh.dados) processarPacote({ url: urlH, metodo: 'GET', corpo: null, dados: rh.dados, ts: Date.now() });
        await pausa(150);

        // I) Afiliados (resumo do canal + top 5)
        prog('Lendo os afiliados...');
        var urlAf = '/api/v3/affiliateplatform/dashboard/seller_daily?start_time=' + ini + '&end_time=' + (fim - 1) + '&is_real_time=0&order_type=2&channel=0';
        var raf = await buscar(urlAf, 'GET', null);
        totalChamadas++;
        if (raf.ok && raf.dados) processarPacote({ url: urlAf, metodo: 'GET', corpo: null, dados: raf.dados, ts: Date.now() });
        await pausa(150);
        var urlTop = '/api/v3/affiliateplatform/dashboard/affiliate_performance/top5?start_time=' + ini + '&end_time=' + (fim - 1) + '&order_type=2&channel=0&has_meta_feature=1';
        var rtop = await buscar(urlTop, 'GET', null);
        totalChamadas++;
        if (rtop.ok && rtop.dados) processarPacote({ url: urlTop, metodo: 'GET', corpo: null, dados: rtop.dados, ts: Date.now() });

        prog(null);
        resolver({ ok: true, chamadas: totalChamadas, campanhas: Object.keys(estado.campanhas).length, produtos: Object.keys(estado.produtos).length });
      })();
    });
  }

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
    '.bloco-d{background:#12151b;border:1px solid #1d212a;border-radius:9px;padding:10px 12px;margin-bottom:9px}' +
    '.bloco-d .td{font-family:monospace;font-size:9px;letter-spacing:.06em;color:#ff4d1c;margin-bottom:7px}' +
    '.bloco-d .ld{font-size:12px;color:#b8bcc6;line-height:1.6;padding:1px 0}' +
    '.bloco-d .ld b{color:#f2f2f4}' +
    '.bloco-d .vazio-d{color:#5a5f6a;font-style:italic;font-size:11px}' +
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
  var abaAtiva = 'semaforo';
  var ABAS = [
    { id: 'semaforo', rotulo: '\u25cf Semaforo' },
    { id: 'conta360', rotulo: '\u25c9 Conta 360' },
    { id: 'calc', rotulo: '\u2696 Margem' },
    { id: 'diagnostico', rotulo: 'Diagnostico' },
    { id: 'visao', rotulo: 'Visao da Conta' },
    { id: 'campanhas', rotulo: 'Campanhas' },
    { id: 'produtos', rotulo: 'Produtos (Ads)' },
    { id: 'performance', rotulo: 'Performance' },
    { id: 'afiliados', rotulo: 'Afiliados' },
    { id: 'cadastro', rotulo: 'Anuncio' },
    { id: 'diamantes', rotulo: '\u2666 Diamantes' },
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
    // inclui o cofre de diamantes capturado (Camada 1) para conferencia
    try { if (window.SIA_Diamantes) pacote.diamantes = window.SIA_Diamantes.estado(); } catch (e) { /* noop */ }
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

  function kpiAfiliado() {
    var c = estado.conta.campos || {};
    function soma(sufixo) { var t = 0, achou = false; for (var k in c) { if (new RegExp('^(?:result\\.)?affiliate\\.breakdown\\[\\d+\\]\\.' + sufixo + '$').test(k)) { t += c[k]; achou = true; } } return achou ? t : null; }
    var vendas = soma('sales');
    if (vendas === null) return null;
    return { vendas: vendas, pedidos: soma('orders'), unidades: soma('units'), comissao: soma('commission') };
  }
  function avisoJanelaAf(extra) {
    return { valor: null, bom: true, texto: (extra ? extra + ' ' : '') + 'Rode a coleta com a mesma janela desta tela para os numeros baterem.' };
  }
  function vendasPorFonte() {
    var c = estado.conta.campos || {};
    var fontes = {};
    for (var k in c) {
      var m = k.match(/^(?:result\.)?([a-z_]+)\.breakdown\[\d+\]\.sales$/);
      if (m) { fontes[m[1]] = (fontes[m[1]] || 0) + c[k]; continue; }
      var m2 = k.match(/^(?:result\.)?([a-z_]+)\.sales$/);
      if (m2 && !/per_order|ratio/.test(k)) { if (fontes[m2[1]] === undefined) fontes[m2[1]] = c[k]; }
    }
    return fontes;
  }
  function pedidosPorFonte(fonte) {
    var c = estado.conta.campos || {};
    var tot = 0, achou = false;
    for (var k in c) {
      if (new RegExp('^(?:result\\.)?' + fonte + '\\.breakdown\\[\\d+\\]\\.orders$').test(k)) { tot += c[k]; achou = true; }
    }
    return achou ? tot : null;
  }
  var NOME_FONTE = { affiliate: 'Afiliados', ads: 'Shopee Ads', shopee_ads: 'Shopee Ads', live: 'Lives', video: 'Video', product_card: 'Card do Produto', card: 'Card do Produto', total: 'Total' };

  var TRADUCAO = {
    uv: 'Visitantes unicos', pv: 'Visualizacoes de pagina', hybrid_uv: 'Visitantes (hibrido)',
    iv: 'Visitantes via busca interna',
    atc_uv: 'Visitantes que add. ao carrinho', atc_unit_num: 'Unidades no carrinho', atc_rate: 'Taxa de carrinho',
    bounce_rate: 'Taxa de rejeicao', bounce_visitors: 'Visitantes que sairam',
    conversion_rate: 'Conversao',
    placed_gmv: 'GMV pedidos feitos', paid_gmv: 'GMV pago', confirmed_gmv: 'GMV confirmado',
    placed_order: 'Pedidos feitos', paid_order: 'Pedidos pagos', confirmed_order: 'Pedidos confirmados',
    placed_buyers: 'Compradores (feitos)', paid_buyers: 'Compradores (pagos)', confirmed_buyers: 'Compradores (confirm.)',
    placed_unit_num: 'Unidades (feitas)', paid_unit_num: 'Unidades (pagas)', confirmed_unit_num: 'Unidades (confirm.)',
    placed_items: 'Itens distintos (feitos)', paid_items: 'Itens distintos (pagos)', confirmed_items: 'Itens distintos (confirm.)',
    like_unit_num: 'Curtidas', sales: 'Vendas', units: 'Unidades', orders: 'Pedidos', buyers: 'Compradores',
    product_clicks: 'Cliques em produto', uv_to_buyers_rate: 'Visitante virou comprador',
    product_clicks_to_orders_rate: 'Clique virou pedido',
    placed_buyers_to_confirmed_buyers_rate: 'Feito que confirmou',
    average_days_to_repeat_placed_order: 'Dias p/ recomprar (feito)',
    average_days_to_repeat_paid_order: 'Dias p/ recomprar (pago)',
    average_days_to_repeat_confirmed_order: 'Dias p/ recomprar (confirm.)'
  };
  var CAMPOS_PORCENTO = { atc_rate:1, bounce_rate:1, conversion_rate:1, uv_to_buyers_rate:1, product_clicks_to_orders_rate:1, placed_buyers_to_confirmed_buyers_rate:1 };
  var CAMPOS_REAIS = { placed_gmv:1, paid_gmv:1, confirmed_gmv:1, sales:1 };

  function paresGerenciais(campos) {
    // agrupa {base}.value / {base}.ratio + campos soltos {base} / {base}_pct_diff
    var pares = {};
    for (var k in campos) {
      var m1 = k.match(/^(?:key_metrics\.)?(.+)\.(value|ratio)$/);
      var m2 = k.match(/^(?:key_metrics\.)?(.+?)(_pct_diff)?$/);
      if (m1) {
        var b1 = m1[1];
        if (!pares[b1]) pares[b1] = {};
        pares[b1][m1[2] === 'value' ? 'v' : 'r'] = campos[k];
      } else if (m2 && !/\./.test(m2[1])) {
        var b2 = m2[1];
        if (b2 === 'code') continue;
        if (!pares[b2]) pares[b2] = {};
        if (m2[2]) pares[b2].r = campos[k]; else if (pares[b2].v === undefined) pares[b2].v = campos[k];
      }
    }
    return pares;
  }

  function tabelaGerenciais(campos, atualizadoEm) {
    var pares = paresGerenciais(campos);
    var bases = Object.keys(pares);
    if (!bases.length) return null;
    bases.sort(function (a, b) {
      var ta = TRADUCAO[a] ? 0 : 1, tb = TRADUCAO[b] ? 0 : 1;
      return ta !== tb ? ta - tb : a.localeCompare(b);
    });
    var h = '<div class="nota">Informacoes Gerenciais (' + (atualizadoEm ? hora(atualizadoEm) : '') + ') — variacao vs periodo anterior fornecida pela propria Shopee:</div>';
    h += '<table><tr><th>Indicador</th><th class="num">Valor</th><th class="num">Variacao</th></tr>';
    for (var i = 0; i < Math.min(bases.length, 70); i++) {
      var b = bases[i], p = pares[b];
      if (p.v === undefined) continue;
      var rotulo = TRADUCAO[b] || (b + ' (calibrar)');
      var valor;
      if (CAMPOS_PORCENTO[b]) valor = fmt(p.v * 100, 2) + '%';
      else if (CAMPOS_REAIS[b]) valor = reais(p.v);
      else valor = fmt(p.v, p.v % 1 ? 2 : 0);
      var varh = '—';
      if (p.r !== undefined && p.r !== null) {
        var pct = p.r * 100;
        var cor = pct >= 0 ? '#2ecc71' : '#e74c3c';
        varh = '<span style="color:' + cor + '">' + (pct >= 0 ? '+' : '') + fmt(pct, 1) + '%</span>';
      }
      h += '<tr><td class="nome">' + esc(rotulo) + '</td><td class="num">' + valor + '</td><td class="num">' + varh + '</td></tr>';
    }
    return h + '</table>';
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

  // ==========================================================
  // SEMAFORO (Camada 2, metade LOCAL) — a triagem na tela
  // ==========================================================
  var CORES_SEM = {
    vermelho: { bg: '#2a0f0f', bd: '#5a1f1f', dot: '#e74c3c', nome: 'Sangrando' },
    amarelo: { bg: '#2a230f', bd: '#5a4a1f', dot: '#f5b041', nome: 'Sufocada' },
    verde: { bg: '#0f2a17', bd: '#1f5a30', dot: '#2ecc71', nome: 'Escalando' },
    cinza: { bg: '#15171d', bd: '#2a2f3a', dot: '#5a5f6a', nome: 'Aprendendo' }
  };

  function renderSemaforo() {
    var cofre = null;
    try { if (window.SIA_Diamantes) cofre = window.SIA_Diamantes.estado(); } catch (e) { }
    if (!cofre || !window.SIA_Triagem) {
      return '<div class="nota" style="padding:20px">Motor de triagem carregando… recarregue a pagina se persistir.</div>';
    }
    var nCamp = Object.keys(cofre.porCampanha || {}).length;
    if (nCamp === 0) {
      return '<div style="padding:24px;text-align:center">' +
        '<div style="font-size:34px;margin-bottom:10px">\u25cf</div>' +
        '<div style="font-size:14px;color:#f2f2f4;font-weight:600;margin-bottom:6px">Nenhuma campanha lida ainda</div>' +
        '<div class="nota" style="max-width:340px;margin:0 auto">Abra a pagina de <b>Anuncios</b> no Seller Central e navegue pelas campanhas. Conforme a Shopee carrega os dados, o semaforo se enche sozinho.</div></div>';
    }

    var R = window.SIA_Triagem.triar(cofre, { margemPct: 0.25 });

    // cabecalho com contagem
    var h = '<div style="padding:4px 2px 14px">';
    h += '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">' +
      '<div style="font-size:15px;font-weight:700;color:#f2f2f4">Semaforo de campanhas</div>' +
      '<div class="nota" style="margin:0">' + R.total + ' lidas · R$ ' + R.gastoTotal.toFixed(2).replace('.', ',') + ' no periodo</div></div>';
    h += '<div class="nota" style="margin:0 0 12px">Margem assumida: 25% (piso ROAS 4x). Com o Cofre de Custos, vira seu numero real.</div>';

    // 4 cartoes de contagem
    h += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:16px">';
    ['vermelho', 'amarelo', 'verde', 'cinza'].forEach(function (nv) {
      var c = CORES_SEM[nv];
      h += '<div style="background:' + c.bg + ';border:1px solid ' + c.bd + ';border-radius:10px;padding:11px 8px;text-align:center">' +
        '<div style="font-size:24px;font-weight:800;color:' + c.dot + ';line-height:1">' + R.contagem[nv] + '</div>' +
        '<div style="font-size:10px;color:#b8bcc6;margin-top:3px;font-weight:600">' + c.nome + '</div></div>';
    });
    h += '</div>';

    // fila de acao
    if (R.fila.length === 0) {
      h += '<div style="background:#0f2a17;border:1px solid #1f5a30;border-radius:10px;padding:16px;text-align:center;color:#2ecc71;font-size:13px">Tudo sob controle. Nenhuma campanha pedindo acao agora.</div>';
    } else {
      h += '<div style="font-size:11px;color:#ff4d1c;font-family:monospace;letter-spacing:.06em;margin-bottom:9px">FILA DE ACAO (' + R.fila.length + ') — ordenada por impacto</div>';
      R.fila.forEach(function (c) {
        var co = CORES_SEM[c.nivel];
        h += '<div style="background:' + co.bg + ';border:1px solid ' + co.bd + ';border-left:3px solid ' + co.dot + ';border-radius:9px;padding:10px 12px;margin-bottom:8px">';
        h += '<div style="display:flex;align-items:center;gap:7px;margin-bottom:4px">' +
          '<span style="width:8px;height:8px;border-radius:50%;background:' + co.dot + ';display:inline-block;flex:0 0 auto"></span>' +
          '<span style="font-size:12.5px;font-weight:700;color:#f2f2f4">' + esc(c.titulo) + '</span>' +
          '<span style="margin-left:auto;font-size:11px;color:#7d8290;font-variant-numeric:tabular-nums">R$ ' + c.gasto.toFixed(2).replace('.', ',') + '</span></div>';
        if (c.campanha) h += '<div style="font-size:11px;color:#9aa0ac;margin-bottom:3px">' + esc(c.campanha) + (c.roas ? ' · ROAS ' + c.roas.toFixed(1) + 'x' : '') + (c.posicao ? ' · pos ' + c.posicao : '') + '</div>';
        h += '<div style="font-size:11.5px;color:#c8ccd4;line-height:1.5">' + esc(c.texto) + '</div>';
        h += '</div>';
      });
      h += '<div class="nota" style="margin-top:10px">As <b>' + R.contagem.cinza + '</b> campanhas em aprendizado ficam fora da fila de proposito: mexer nelas antes de 7 dias atrapalha o algoritmo.</div>';
    }
    h += '</div>';
    return h;
  }

  // liga o botao "Coletar conta agora" (coletor em lote)
  var coletaEmAndamento = false;
  var coletaJaTentada = false;
  function ligarBotaoColeta() {
    var btn = $('sia-btn-coletar');
    if (!btn) return;
    var status = $('sia-lote-status');
    btn.addEventListener('click', function () { dispararColeta(); });
    // AUTOMATICO: dispara se ainda nao temos os dados do PERIODO (mes).
    // O dado do DIA (que a pagina inicial sempre preenche) NAO conta como
    // "ja tem" — precisamos buscar o periodo de qualquer forma.
    if (!coletaJaTentada && estado.spc) {
      var precisaBuscar = true;
      try {
        var D = window.SIA_Diamantes ? window.SIA_Diamantes.resumo() : null;
        var temPeriodo = D && D.gerenciais && D.gerenciais.fonte === 'periodo';
        var temResto = D && D.funil && D.afiliados;
        if (temPeriodo && temResto) precisaBuscar = false;
      } catch (e) { }
      if (precisaBuscar) { coletaJaTentada = true; setTimeout(dispararColeta, 500); }
    } else if (!estado.spc && status) {
      status.textContent = 'Abra a Central de Dados uma vez pra ativar a coleta.';
      status.style.color = '#f5b041';
    }
  }

  function dispararColeta() {
    if (coletaEmAndamento || estado.coletaProgresso) return;
    if (!estado.spc) {
      var st0 = $('sia-lote-status');
      if (st0) { st0.textContent = 'Abra a Central de Dados uma vez pra capturar a sessao, e volte aqui.'; st0.style.color = '#f5b041'; }
      return;
    }
    coletaJaTentada = true;
    coletaEmAndamento = true;
    var btn = $('sia-btn-coletar');
    var status = $('sia-lote-status');
    var barraBg = $('sia-lote-barra-bg');
    var barra = $('sia-lote-barra');
    if (btn) { btn.style.opacity = '0.6'; btn.textContent = 'Coletando…'; }
    if (barraBg) barraBg.style.display = 'block';
    if (barra) { barra.style.width = '15%'; barra.style.background = 'linear-gradient(90deg,#ff4d1c,#7B2FFF)'; }
    if (status) { status.style.color = '#7d8290'; status.textContent = 'iniciando…'; }

    // usa o coletaCompleta (testado, com paginacao e CDS confiavel)
    var pulso = 15;
    coletaCompleta(function () {
      // aoProgresso: mostra o texto que o coletaCompleta emite
      if (status && estado.coletaProgresso) status.textContent = estado.coletaProgresso;
      if (barra) { pulso = Math.min(pulso + 7, 92); barra.style.width = pulso + '%'; }
    }).then(function (res) {
      coletaEmAndamento = false;
      if (btn) { btn.style.opacity = '1'; btn.textContent = 'Coletar de novo'; }
      if (!res || !res.ok) {
        if (status) { status.textContent = (res && res.erro) || 'nao foi possivel coletar'; status.style.color = '#e74c3c'; }
        if (barra) barra.style.background = '#e74c3c';
        return;
      }
      if (barra) barra.style.width = '100%';
      if (status) { status.style.color = '#2ecc71'; status.textContent = 'pronto! conta lida.'; }
      // persiste e re-renderiza pra mostrar os blocos cheios
      try { if (window.SIA_Diamantes && window.SIA_Diamantes.persistir) window.SIA_Diamantes.persistir(); } catch (e) { }
      setTimeout(function () { if (abaAtiva === 'conta360') render(); }, 700);
    });
  }

  // ==========================================================
  // CALCULADORA DE MARGEM REAL — custo + taxas Shopee + ads
  // ==========================================================
  function renderCalculadora() {
    var i = 'width:100%;box-sizing:border-box;background:#0c0e12;border:1px solid #242630;border-radius:8px;padding:9px 11px;color:#f2f2f4;font-size:13px;margin-top:4px';
    var lbl = 'font-size:11px;color:#9aa0ac;font-weight:600';
    var h = '<div style="padding:2px">';
    h += '<div class="nota" style="margin:0 0 12px">Sua margem <b>real</b> cruzando custo, taxas da Shopee e o gasto de ads. Descobre se voce lucra de verdade.</div>';

    h += '<div class="bloco-d"><div class="td">O PRODUTO</div>';
    h += '<div style="margin-bottom:8px"><div style="' + lbl + '">Preco de venda (R$) *</div><input id="calc-preco" type="tel" inputmode="decimal" placeholder="29,90" style="' + i + '"></div>';
    h += '<div style="margin-bottom:8px"><div style="' + lbl + '">Custo do fornecedor (R$) *</div><input id="calc-custo" type="tel" inputmode="decimal" placeholder="8,00" style="' + i + '"></div>';
    h += '<div style="display:flex;gap:8px"><div style="flex:1"><div style="' + lbl + '">Embalagem/outros</div><input id="calc-outros" type="tel" inputmode="decimal" placeholder="0,00" style="' + i + '"></div>';
    h += '<div style="flex:1"><div style="' + lbl + '">Imposto NF (%)</div><input id="calc-imposto" type="tel" inputmode="decimal" placeholder="6" style="' + i + '"></div></div>';
    h += '</div>';

    h += '<div class="bloco-d"><div class="td">ADS (opcional)</div>';
    h += '<div style="' + lbl + '">Gasto de ads por venda (R$)</div><input id="calc-ads" type="tel" inputmode="decimal" placeholder="deixe vazio se nao usa" style="' + i + '">';
    h += '<div class="ld" style="font-size:11px;color:#7d8290;margin-top:5px">Se preencher, cruzamos com o ROAS minimo pra ver se ta no lucro.</div>';
    h += '</div>';

    h += '<button id="calc-btn" style="all:unset;cursor:pointer;display:block;text-align:center;background:linear-gradient(135deg,#ff4d1c,#7B2FFF);color:#fff;font-weight:700;font-size:13px;padding:11px;border-radius:9px;margin:4px 0 12px">Calcular margem real</button>';

    h += '<div id="calc-resultado"></div>';
    h += '</div>';
    return h;
  }

  function ligarCalculadora() {
    var btn = $('calc-btn');
    if (!btn || !window.SIA_Calc) return;
    btn.addEventListener('click', function () {
      var ent = {
        preco: ($('calc-preco') || {}).value,
        custo: ($('calc-custo') || {}).value,
        outros: ($('calc-outros') || {}).value,
        impostoPct: ($('calc-imposto') || {}).value,
        adsReais: ($('calc-ads') || {}).value
      };
      var m = window.SIA_Calc.margem(ent);
      var alvo = $('calc-resultado');
      if (!m) { if (alvo) alvo.innerHTML = '<div class="nota" style="color:#e74c3c">Preencha ao menos o preco de venda.</div>'; return; }
      alvo.innerHTML = montarResultadoCalc(m, ent.adsReais);
    });
  }

  function montarResultadoCalc(m, adsInput) {
    function fr(v) { return 'R$ ' + Number(v).toFixed(2).replace('.', ','); }
    var corLucro = m.noLucro ? '#2ecc71' : '#e74c3c';
    var h = '<div class="bloco-d" style="border-color:' + (m.noLucro ? '#1f5a30' : '#5a1f1f') + '">';
    h += '<div class="td">RESULTADO · ' + esc(m.faixa) + '</div>';
    // cascata de custos
    h += '<div class="ld">Preco de venda: <b>' + fr(m.preco) + '</b></div>';
    h += '<div class="ld" style="color:#9aa0ac">− Custo produto: ' + fr(m.custoProduto) + (m.outros ? ' · outros ' + fr(m.outros) : '') + '</div>';
    h += '<div class="ld" style="color:#9aa0ac">− Comissao Shopee (' + m.comissao.pct + '%): ' + fr(m.comissao.reais) + ' + taxa fixa ' + fr(m.taxaFixa) + '</div>';
    if (m.imposto.reais > 0) h += '<div class="ld" style="color:#9aa0ac">− Imposto (' + m.imposto.pct + '%): ' + fr(m.imposto.reais) + '</div>';
    if (m.ads > 0) h += '<div class="ld" style="color:#9aa0ac">− Ads por venda: ' + fr(m.ads) + '</div>';
    h += '<div style="border-top:1px solid #242630;margin:8px 0 6px"></div>';
    h += '<div class="ld" style="font-size:15px">Lucro por venda: <b style="color:' + corLucro + '">' + fr(m.lucro) + '</b> <span style="color:#7d8290;font-size:12px">(margem ' + m.margemPct + '%)</span></div>';
    if (!m.noLucro) h += '<div class="ld" style="color:#e74c3c;font-size:11px;margin-top:4px">Atencao: este produto esta no PREJUIZO com esses numeros.</div>';
    // ROAS minimo + cruzamento
    if (m.roasMinimo) {
      h += '<div style="border-top:1px solid #242630;margin:8px 0 6px"></div>';
      h += '<div class="ld">ROAS minimo pra empatar o ads: <b>' + m.roasMinimo + 'x</b></div>';
      // tenta cruzar com o ROAS real da conta (se houver)
      var roasReal = null;
      try {
        var D = window.SIA_Diamantes ? window.SIA_Diamantes.resumo() : null;
        if (D && D.metaRoas && D.metaRoas.exato) roasReal = D.metaRoas.exato;
      } catch (e) { }
      var cruz = window.SIA_Calc.cruzarAds(m, roasReal);
      if (cruz && roasReal) {
        var cor = { verde: '#2ecc71', amarelo: '#f5b041', vermelho: '#e74c3c', cinza: '#7d8290' }[cruz.nivel];
        h += '<div class="ld" style="color:' + cor + ';font-size:11.5px;margin-top:3px">' + esc(cruz.texto) + '</div>';
      } else {
        h += '<div class="ld" style="color:#7d8290;font-size:11px;margin-top:3px">Rode a coleta pra cruzar com seu ROAS real da conta.</div>';
      }
    }
    h += '</div>';
    return h;
  }

  // ==========================================================
  // CONTA 360 — as 6 inteligencias do cerebro geral (visual)
  // So MOSTRA o que a coleta capturou. A analise vem depois.
  // ==========================================================
  function renderConta360() {
    var D = null;
    try { if (window.SIA_Diamantes) D = window.SIA_Diamantes.resumo(); } catch (e) { }
    if (!D) return '<div class="nota" style="padding:20px">Cofre carregando…</div>';

    // helpers visuais locais
    function fmtR(v) { return v == null ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function fmtN(v) { return v == null ? '—' : Number(v).toLocaleString('pt-BR'); }
    // seta de variacao: sobe verde, desce vermelho (mas reembolso/cancelamento e o contrario)
    function varia(v, inverso) {
      if (v == null) return '';
      var bom = inverso ? v < 0 : v > 0;
      var cor = v === 0 ? '#7d8290' : (bom ? '#2ecc71' : '#e74c3c');
      var seta = v > 0 ? '\u25b2' : (v < 0 ? '\u25bc' : '');
      return ' <span style="color:' + cor + ';font-size:10px">' + seta + ' ' + Math.abs(v).toFixed(0) + '%</span>';
    }
    function tend(t) {
      if (!t) return '';
      var m = { subindo: ['#2ecc71', 'subindo'], caindo: ['#e74c3c', 'caindo'], estavel: ['#7d8290', 'estavel'] }[t.direcao] || ['#7d8290', t.direcao];
      return '<span style="color:' + m[0] + ';font-size:10px"> · ' + m[1] + '</span>';
    }
    function bloco(titulo, conteudo, vazio) {
      return '<div class="bloco-d"><div class="td">' + titulo + '</div>' + (conteudo || ('<div class="ld vazio-d">' + vazio + '</div>')) + '</div>';
    }

    var h = '<div style="padding:2px">';
    // ---- COLETA AUTOMATICA (coletor em lote) ----
    h += '<div id="sia-lote-box" style="background:#12151b;border:1px solid #1d212a;border-radius:10px;padding:12px;margin-bottom:12px">';
    h += '<div style="display:flex;align-items:center;gap:8px">';
    h += '<button id="sia-btn-coletar" style="all:unset;cursor:pointer;background:linear-gradient(135deg,#ff4d1c,#7B2FFF);color:#fff;font-weight:700;font-size:12.5px;padding:9px 14px;border-radius:8px;text-align:center">Coletar conta agora</button>';
    h += '<div id="sia-lote-status" style="font-size:11px;color:#7d8290;flex:1">Clique para a extensao buscar tudo sozinha</div>';
    h += '</div>';
    h += '<div id="sia-lote-barra-bg" style="display:none;height:6px;background:#1d212a;border-radius:3px;margin-top:10px;overflow:hidden"><div id="sia-lote-barra" style="height:100%;width:0%;background:linear-gradient(90deg,#ff4d1c,#7B2FFF);transition:width .3s"></div></div>';
    h += '</div>';
    h += '<div class="nota" style="margin:0 0 12px">Retrato da conta lido direto da Shopee. Use o botao acima ou navegue pelas telas.</div>';

    // ---- 1) GERENCIAIS ----
    var g = D.gerenciais, cg = '';
    if (g && (g.gmvPago || g.pv)) {
      // avisa a origem do dado: dia (navegacao passiva) ou periodo (coleta/central)
      if (g.fonte === 'dia') cg += '<div class="ld" style="color:#f5b041;font-size:11px;margin-bottom:4px">\u26a0 Dados de HOJE. Clique em "Coletar" ou abra a Central pro mes completo.</div>';
      else if (g.fonte === 'periodo') cg += '<div class="ld" style="color:#2ecc71;font-size:11px;margin-bottom:4px">Dados do periodo (mes)</div>';
      if (g.gmvPago) cg += '<div class="ld">GMV pago: <b>' + fmtR(g.gmvPago.valor) + '</b>' + varia(g.gmvPago.variacao) + '</div>';
      if (g.pedidosPagos) cg += '<div class="ld">Pedidos: <b>' + fmtN(g.pedidosPagos.valor) + '</b>' + varia(g.pedidosPagos.variacao) + (g.ticketMedio ? ' · ticket <b>' + fmtR(g.ticketMedio) + '</b>' : '') + '</div>';
      if (g.visitantes) cg += '<div class="ld">Visitantes: <b>' + fmtN(g.visitantes.valor) + '</b>' + varia(g.visitantes.variacao) + (g.conversaoLoja != null ? ' · conversao <b>' + g.conversaoLoja + '%</b>' : '') + '</div>';
      if (g.pv && g.uv) cg += '<div class="ld" style="color:#7d8290;font-size:11px">PV ' + fmtN(g.pv.valor) + ' · UV ' + fmtN(g.uv.valor) + '</div>';
    }
    h += bloco('1 · VISAO GERENCIAL', cg, 'abra a Central de Dados (Painel) para capturar');

    // ---- saude (cancelamentos/reembolsos) ----
    if (g && g.saude) {
      var s = g.saude, cs = '';
      if (s.reembolsos) cs += '<div class="ld">Reembolsos: <b>' + fmtR(s.reembolsos.valor) + '</b>' + varia(s.reembolsos.variacao, true) + '</div>';
      if (s.vendasCanceladas) cs += '<div class="ld">Cancelamentos: <b>' + fmtR(s.vendasCanceladas.valor) + '</b>' + varia(s.vendasCanceladas.variacao, true) + '</div>';
      if (s.pedidosDevolvidos) cs += '<div class="ld" style="color:#7d8290;font-size:11px">' + fmtN(s.pedidosDevolvidos.valor) + ' devolucoes · ' + fmtN(s.pedidosCancelados ? s.pedidosCancelados.valor : 0) + ' cancelados</div>';
      if (cs) h += bloco('SAUDE DAS VENDAS', cs, '');
    }

    // ---- 2) FUNIL ----
    var f = D.funil, cf = '';
    if (f && f.canais) {
      var ordem = ['card', 'ads', 'afiliado', 'live', 'video'];
      var nomes = { card: 'Vitrine (card)', ads: 'Anuncios', afiliado: 'Afiliados', live: 'Live', video: 'Video' };
      ordem.forEach(function (k) {
        var ca = f.canais[k];
        if (ca && ca.valor > 0) cf += '<div class="ld">' + nomes[k] + ': <b>' + (ca.ratio != null ? ca.ratio.toFixed(1) + '%' : '—') + '</b> <span style="color:#7d8290;font-size:11px">(' + fmtR(ca.valor) + ')</span>' + varia(ca.variacao) + '</div>';
      });
      if (f.naoUsa && f.naoUsa.length) cf += '<div class="ld" style="color:#f5b041;font-size:11px">Nao usa: ' + f.naoUsa.join(', ') + ' — canais parados</div>';
    }
    h += bloco('2 · FUNIL / ORIGEM DO DINHEIRO', cf, 'abra Fluxo de Visitantes na Central de Dados');

    // ---- 3) PERFORMANCE DE PRODUTO (top por venda) ----
    var prods = D.produtos ? null : null;
    var E = null; try { E = window.SIA_Diamantes.estado(); } catch (e) { }
    var cp = '';
    if (E && E.porProduto) {
      var comPerf = Object.keys(E.porProduto).filter(function (k) { return E.porProduto[k].perf && E.porProduto[k].perf.ctr != null; });
      comPerf.sort(function (a, b) {
        var va = (E.porProduto[a].perf.vendaPaga || E.porProduto[a].perf.venda || 0);
        var vb = (E.porProduto[b].perf.vendaPaga || E.porProduto[b].perf.venda || 0);
        return vb - va;
      });
      comPerf.slice(0, 6).forEach(function (k) {
        var p = E.porProduto[k], P = p.perf;
        var nome = (p.nome || k).slice(0, 26);
        var alerta = '';
        // sinal visual: CTR bom + conversao baixa = pagina nao converte
        if (P.ctr >= 2 && P.convPago != null && P.convPago < 1) alerta = ' <span style="color:#f5b041;font-size:10px">pagina segura</span>';
        else if (P.rejeicao != null && P.rejeicao > 45) alerta = ' <span style="color:#e74c3c;font-size:10px">rejeicao alta</span>';
        cp += '<div class="ld" style="border-bottom:1px solid #15171d;padding-bottom:5px;margin-bottom:5px">' +
          '<b>' + esc(nome) + '</b>' + alerta + '<br>' +
          '<span style="color:#9aa0ac;font-size:11px">CTR ' + (P.ctr != null ? P.ctr.toFixed(1) : '—') + '% · conv ' + (P.convPago != null ? P.convPago.toFixed(1) : '—') + '% · rejeicao ' + (P.rejeicao != null ? P.rejeicao.toFixed(0) : '—') + '% · ' + fmtR(P.vendaPaga || P.venda) + (P.fatiaVendas != null ? ' · ' + P.fatiaVendas.toFixed(0) + '% da loja' : '') + '</span></div>';
      });
    }
    h += bloco('3 · PERFORMANCE DE PRODUTO', cp, 'abra Produtos na Central de Dados');

    // ---- 4) SAUDE / AVALIACOES ----
    var ca4 = '';
    if (E && E.porProduto) {
      var comAval = Object.keys(E.porProduto).filter(function (k) { return E.porProduto[k].avaliacoes; });
      var totBaixas = 0, totAval = 0;
      comAval.forEach(function (k) { totBaixas += E.porProduto[k].avaliacoes.baixas || 0; totAval += E.porProduto[k].avaliacoes.total || 0; });
      if (comAval.length) ca4 += '<div class="ld">' + comAval.length + ' produtos avaliados · <b>' + totAval + '</b> avaliacoes' + (totBaixas > 0 ? ' · <span style="color:#e74c3c">' + totBaixas + ' baixas (1-2\u2605)</span>' : ' · <span style="color:#2ecc71">nenhuma baixa</span>') + '</div>';
    }
    if (g && g.travasDetectadas && Object.keys(g.travasDetectadas).length) {
      var travasSet = {};
      Object.keys(g.travasDetectadas).forEach(function (l) { (g.travasDetectadas[l] || []).forEach(function (t) { travasSet[t] = 1; }); });
      var listaT = Object.keys(travasSet);
      if (listaT.length) ca4 += '<div class="ld" style="color:#f5b041;font-size:11px">Travas de edicao detectadas: ' + listaT.slice(0, 4).join(', ') + '</div>';
    }
    h += bloco('4 · SAUDE / AVALIACOES', ca4, 'abra Avaliacoes ou um Produto para capturar');

    // ---- 5) AFILIADOS ----
    var af = D.afiliados, caf = '';
    if (af && af.resumo && af.resumo.pedidos != null) {
      var r5 = af.resumo;
      caf += '<div class="ld">ROI do canal: <b>' + (r5.roi != null ? r5.roi.toFixed(1) + 'x' : '—') + '</b>' + varia(r5.roiVariacao) + '</div>';
      caf += '<div class="ld">GMV afiliados: <b>' + fmtR(r5.gmv) + '</b> · <b>' + fmtN(r5.pedidos) + '</b> pedidos · comissao ' + fmtR(r5.comissaoPaga) + '</div>';
    }
    if (af && af.top && af.top.length) {
      caf += '<div class="ld" style="color:#7d8290;font-size:11px;margin-top:4px">Top afiliados:</div>';
      af.top.slice(0, 3).forEach(function (t) {
        caf += '<div class="ld" style="font-size:11px">• ' + esc((t.nome || '').slice(0, 22)) + ' — ' + (t.roi != null ? t.roi.toFixed(1) + 'x' : '—') + ' · ' + fmtR(t.gmv) + (t.seguidores ? ' · ' + fmtN(t.seguidores) + ' seg' : '') + '</div>';
      });
    }
    if (af && af.creatorsDisponiveis) caf += '<div class="ld" style="color:#7d8290;font-size:11px;margin-top:3px">' + af.creatorsDisponiveis + ' creators disponiveis para recrutar</div>';
    h += bloco('5 · AFILIADOS', caf, 'abra o painel de Afiliados no Seller Central');

    // ---- 6) FINANCEIRO ----
    var fin = D.financeiro, cfin = '';
    if (fin && fin.componentes) {
      var comp = fin.componentes;
      cfin += '<div class="ld" style="color:#7d8290;font-size:11px">Taxas reais da Shopee (' + fin.amostras + ' pedido' + (fin.amostras > 1 ? 's' : '') + ' lido' + (fin.amostras > 1 ? 's' : '') + '):</div>';
      if (comp.COMMISSION_FEE != null) cfin += '<div class="ld">Comissao: <b>' + fmtR(Math.abs(comp.COMMISSION_FEE)) + '</b></div>';
      if (comp.SERVICE_FEE != null) cfin += '<div class="ld">Taxa de servico: <b>' + fmtR(Math.abs(comp.SERVICE_FEE)) + '</b></div>';
      if (comp.ESCROW_AMOUNT != null) cfin += '<div class="ld">Liquido recebido: <b style="color:#2ecc71">' + fmtR(comp.ESCROW_AMOUNT) + '</b></div>';
      cfin += '<div class="ld" style="color:#7d8290;font-size:11px;margin-top:3px">A Shopee ja entrega comissao e taxas. Falta so o custo do produto (Cofre de Custos).</div>';
    }
    h += bloco('6 · FINANCEIRO (margem real)', cfin, 'abra um pedido em Financeiro > Minha Renda');

    h += '</div>';
    return h;
  }

  function render() {
    if (!$('sia-painel').classList.contains('aberto')) return;
    renderAbas();
    var corpo = $('sia-corpo');
    var nC = Object.keys(estado.campanhas).length;
    var nP = Object.keys(estado.produtos).length;
    $('sia-info').textContent = nC + ' campanhas · ' + nP + ' produtos · ' + estado.chamadas.length + ' chamadas';

    if (abaAtiva === 'semaforo') {
      corpo.innerHTML = renderSemaforo();
      return;
    }

    if (abaAtiva === 'conta360') {
      corpo.innerHTML = renderConta360();
      ligarBotaoColeta();
      return;
    }

    if (abaAtiva === 'calc') {
      corpo.innerHTML = renderCalculadora();
      ligarCalculadora();
      return;
    }

    if (abaAtiva === 'diagnostico') {
      var dg = estado.diagnostico;
      var hd = '';
      hd += '<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap">' +
        '<button id="sia-coletar-tudo" style="background:linear-gradient(120deg,#ff4d1c,#7B2FFF);border:none;color:#fff;font-weight:700;font-size:13px;padding:10px 18px;border-radius:8px;cursor:' + (estado.coletaProgresso ? 'wait' : 'pointer') + '">' +
        (estado.coletaProgresso ? esc(estado.coletaProgresso) : 'Coletar conta completa + Analisar') + '</button>' +
        '<button id="sia-analisar" style="background:#12151b;border:1px solid #2a2f3a;color:#fff;font-weight:600;font-size:12px;padding:10px 14px;border-radius:8px;cursor:pointer">' +
        (estado.analisando ? 'Analisando...' : 'So analisar o ja coletado') + '</button>' +
        '<span class="nota" style="margin:0">' + (dg && dg.rules_version ? 'Regras ' + esc(dg.rules_version) + ' · cerebro no servidor' : 'Envia a coleta ao Cerebro Seller.IA e recebe os vereditos do metodo.') + '</span></div>';
      if (dg && dg.erro) hd += '<div class="nota" style="color:#e74c3c">Falha: ' + esc(dg.erro) + '</div>';
      if (dg && dg.vereditos && dg.vereditos.length) {
        hd += '<div class="nota" style="margin-top:0">Clique em um card para abrir os detalhes.</div>';
        for (var v = 0; v < dg.vereditos.length; v++) {
          var vd = dg.vereditos[v];
          var cor = vd.status === 'forte' ? '#2ecc71' : (vd.status === 'critico' ? '#e74c3c' : '#f5b041');
          hd += '<div class="sia-card-diag" style="border:1px solid #1d212a;border-left:3px solid ' + cor + ';border-radius:0 10px 10px 0;background:#12151b;padding:10px 14px;margin-bottom:8px;cursor:pointer">' +
            '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
              '<span style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;border:1px solid ' + cor + ';color:' + cor + ';border-radius:99px;padding:2px 8px">' + esc(vd.veredito) + '</span>' +
              '<span style="font-size:10px;color:#7d8290">' + esc(vd.escopo) + (vd.nome ? ' · ' + esc(String(vd.nome).slice(0, 55)) : '') + (vd.id && vd.escopo !== 'conta' && vd.escopo !== 'grupo' ? ' · ID ' + esc(String(vd.id).split(':')[0]) : '') + '</span></div>' +
            '<div style="font-weight:700;font-size:13px;margin:6px 0 0;color:#f2f2f4">' + esc(vd.manchete) + '</div>' +
            '<div class="sia-detalhe" style="display:none;margin-top:6px">' +
            '<div style="font-size:12px;color:#b8bcc6;line-height:1.5;white-space:pre-line">' + esc(vd.diagnostico) + '</div>' +
            (vd.passos && vd.passos.length ? (function () {
              var hp = '<div style="font-size:12px;margin-top:8px;color:#f2f2f4;font-weight:700">Faca assim:</div><ol style="margin:4px 0 0 18px;padding:0">';
              for (var pz = 0; pz < vd.passos.length; pz++) hp += '<li style="font-size:12px;color:#b8bcc6;margin:3px 0;line-height:1.45">' + esc(vd.passos[pz]) + '</li>';
              return hp + '</ol>';
            })() : (vd.acao ? '<div style="font-size:12px;margin-top:8px;color:#b8bcc6"><b style="color:#f2f2f4">O que fazer:</b> ' + esc(vd.acao.fazer) + '</div>' : '')) +
            (vd.impacto ? '<div style="font-size:12px;margin-top:7px;color:#7B2FFF"><b>Impacto:</b> <span style="color:#b8bcc6">' + esc(vd.impacto) + '</span></div>' : '') +
            '</div></div>';
        }
      } else if (dg && dg.vereditos) {
        hd += '<div class="vazio">O Cerebro nao encontrou nada para julgar ainda — navegue pelo Ads e pelas Informacoes Gerenciais e analise de novo.</div>';
      } else if (!dg) {
        hd += '<div class="vazio">Navegue pelas telas (Ads, Informacoes Gerenciais) e clique em <b>Analisar conta agora</b>.<br>Os vereditos do metodo aparecem aqui — manchete, diagnostico e acao.</div>';
      }
      corpo.innerHTML = hd;
      var cardsD = corpo.querySelectorAll('.sia-card-diag');
      for (var cd = 0; cd < cardsD.length; cd++) {
        cardsD[cd].addEventListener('click', function () {
          var det = this.querySelector('.sia-detalhe');
          if (det) det.style.display = det.style.display === 'none' ? 'block' : 'none';
        });
      }
      var btnTudo = raiz.getElementById('sia-coletar-tudo');
      if (btnTudo) btnTudo.addEventListener('click', function () {
        if (estado.coletaProgresso) return;
        coletaCompleta(function () { render(); }).then(function (res) {
          estado.sujo = true;
          if (!res.ok) {
            estado.diagnostico = { ok: false, erro: res.erro };
            render();
            return;
          }
          // salva e analisa automaticamente
          var btnA = raiz.getElementById('sia-analisar');
          if (btnA) btnA.click();
        });
      });
      var btn = raiz.getElementById('sia-analisar');
      if (btn) btn.addEventListener('click', function () {
        if (estado.analisando) return;
        estado.analisando = true; estado.sujo = true; render();
        try {
          // primeiro salva a foto desta aba (fusao no bg), depois analisa com o estado global
          chrome.runtime.sendMessage({ tipo: 'sia:salvar', coleta: fotoDoEstado() }, function () {
            void chrome.runtime.lastError;
            chrome.runtime.sendMessage({ tipo: 'sia:carregar', }, function (r2) {
              void chrome.runtime.lastError;
              var fotoGlobal = (r2 && r2.coleta) ? r2.coleta : fotoDoEstado();
              var payload = { loja: (fotoGlobal.loja && fotoGlobal.loja.shop_id) || (estado.loja ? estado.loja.shop_id : 'desconhecida'), snapshot: fotoGlobal };
          chrome.runtime.sendMessage({ tipo: 'sia:analisar', payload: payload }, function (resp) {
            void chrome.runtime.lastError;
            estado.analisando = false;
            estado.diagnostico = resp || { ok: false, erro: 'sem resposta do servidor' };
            estado.sujo = true; render();
          });
            });
          });
        } catch (e) {
          estado.analisando = false;
          estado.diagnostico = { ok: false, erro: 'extensao recarregada — atualize a pagina' };
          estado.sujo = true; render();
        }
      });

    } else if (abaAtiva === 'visao') {
      var t = somaProdutos();
      var h = '<div class="kpis">' +
        '<div class="kpi"><div class="v">' + reais(t.gasto) + '</div><div class="l">Gasto (ads lidos)</div></div>' +
        '<div class="kpi"><div class="v">' + reais(t.gmv) + '</div><div class="l">GMV (ads lidos)</div></div>' +
        '<div class="kpi"><div class="v">' + (t.gasto ? fmt(t.gmv / t.gasto, 2) + 'x' : '—') + '</div><div class="l">ROAS blended</div></div>' +
        '<div class="kpi"><div class="v">' + fmt(t.pedidos) + '</div><div class="l">Pedidos via ads</div></div>' +
        '<div class="kpi"><div class="v">' + t.n + '</div><div class="l">Produtos lidos</div></div>' +
        '</div>';
      var fontes = vendasPorFonte();
      var chavesF = Object.keys(fontes).filter(function (f) { return f !== 'total' && fontes[f] > 0; });
      if (chavesF.length) {
        var somaF = 0; for (var f2 = 0; f2 < chavesF.length; f2++) somaF += fontes[chavesF[f2]];
        chavesF.sort(function (a, b) { return fontes[b] - fontes[a]; });
        h += '<div class="nota"><b style="color:#f2f2f4">Cruzamento de fontes de venda</b> (do painel da Shopee):</div><table><tr><th>Fonte</th><th class="num">Vendas</th><th class="num">%</th><th class="num">Pedidos</th><th class="num">Ticket</th></tr>';
        for (var f3 = 0; f3 < chavesF.length; f3++) {
          var fk = chavesF[f3];
          var ped = pedidosPorFonte(fk);
          h += '<tr><td class="nome">' + esc(NOME_FONTE[fk] || fk) + '</td><td class="num">' + reais(fontes[fk]) + '</td>' +
            '<td class="num">' + (somaF ? fmt(fontes[fk] / somaF * 100, 1) + '%' : '—') + '</td>' +
            '<td class="num">' + (ped === null ? '—' : fmt(ped)) + '</td>' +
            '<td class="num">' + (ped ? reais(fontes[fk] / ped) : '—') + '</td></tr>';
        }
        h += '</table>';
      }
      var tc = tabelaGerenciais(estado.conta.campos, estado.conta.atualizadoEm);
      h += tc || '<div class="vazio">Abra a area de <b>Informacoes Gerenciais</b> para a leitura da conta.</div>';
      corpo.innerHTML = h;

    } else if (abaAtiva === 'campanhas') {
      var idsC = Object.keys(estado.campanhas);
      if (!idsC.length) {
        corpo.innerHTML = '<div class="vazio">Nada lido ainda. Navegue pela tela de <b>Shopee Ads</b>.</div>';
        return;
      }
      idsC.sort(function (a, b) { return (estado.campanhas[b].metricas.gasto || 0) - (estado.campanhas[a].metricas.gasto || 0); });
      var h2 = '<table><tr><th>Campanha</th><th>Estado</th><th>Estrategia</th><th class="num">Orc/dia</th>' +
        '<th class="num">Gasto</th><th class="num">GMV</th><th class="num">ROAS</th><th class="num">CTR</th>' +
        '<th class="num">CPC</th><th class="num">Pedidos</th><th class="num">Pos.</th></tr>';
      for (var j = 0; j < idsC.length; j++) {
        var c = estado.campanhas[idsC[j]];
        var m = c.metricas;
        var roasC = m.roas !== undefined ? m.roas : (m.gasto ? (m.gmv || 0) / m.gasto : null);
        var ctrC = m.ctr !== undefined ? (m.ctr <= 1 ? m.ctr * 100 : m.ctr) : (m.impressoes ? (m.cliques || 0) / m.impressoes * 100 : null);
        var cpcC = m.gasto && m.cliques ? m.gasto / m.cliques : null;
        var estadoTxt = c.estado === 'ongoing' ? 'Ativa' : (c.estado === 'paused' ? 'Pausada' : (c.estado || '—'));
        h2 += '<tr><td class="nome">' + esc(c.nome || '(sem nome)') + '</td>' +
          '<td>' + esc(estadoTxt) + '</td><td>' + esc(c.estrategia || '—') + '</td>' +
          '<td class="num">' + (m.orcamento_dia === 0 ? 'Sem limite' : reais(m.orcamento_dia)) + '</td>' +
          '<td class="num">' + reais(m.gasto) + '</td><td class="num">' + reais(m.gmv) + '</td>' +
          '<td class="num">' + (roasC === null ? '—' : fmt(roasC, 2) + 'x') + '</td>' +
          '<td class="num">' + (ctrC === null ? '—' : fmt(ctrC, 2) + '%') + '</td>' +
          '<td class="num">' + (cpcC === null ? '—' : reais(cpcC)) + '</td>' +
          '<td class="num">' + fmt(m.pedidos) + '</td>' +
          '<td class="num">' + (m.posicao === undefined ? '—' : fmt(m.posicao, 0)) + '</td></tr>';
      }
      h2 += '</table><div class="nota">CPC derivado (gasto ÷ cliques) — os campos cpc/cpm da API interna nao batem com a tela e foram descartados. ROAS = broad_roi da Shopee.</div>';
      corpo.innerHTML = h2;

    } else if (abaAtiva === 'produtos') {
      var mapa = estado.produtos;
      var ids = Object.keys(mapa).filter(function (id) { return mapa[id].metricas.gasto !== undefined || mapa[id].metricas.roas !== undefined; });
      if (!ids.length) {
        // sem metricas de ads por item (a Shopee nem sempre entrega): mostra o funil como visao util
        var idsF = Object.keys(mapa).filter(function (id) { return mapa[id].metricas.vendas_pagas !== undefined; });
        if (idsF.length) { abaAtiva = 'performance'; render(); abaAtiva = 'produtos'; return; }
        corpo.innerHTML = '<div class="vazio">A Shopee ainda nao entregou metricas de ads por produto nesta coleta (ela so as expoe em algumas telas). Use a aba <b>Performance</b> — e a leitura por item entra na busca ativa da proxima versao.</div>';
        return;
      }
      ids.sort(function (a, b) { return (mapa[b].metricas.gasto || 0) - (mapa[a].metricas.gasto || 0); });
      var h2b = '<table><tr><th>Produto</th><th>ID</th>' +
        '<th class="num">Gasto</th><th class="num">GMV</th><th class="num">ROAS</th><th class="num">Impr.</th>' +
        '<th class="num">Cliques</th><th class="num">CTR</th><th class="num">Pedidos</th><th class="num">Pos.</th></tr>';
      for (var j2 = 0; j2 < ids.length; j2++) {
        var item = mapa[ids[j2]];
        h2b += '<tr><td class="nome">' + esc(item.nome || '(sem nome capturado)') + '</td>' +
          '<td>' + esc(item.id) + '</td>' + linhaMetrica(item.metricas) + '</tr>';
      }
      h2b += '</table><div class="nota">Ordenado por gasto. Micro-unidades convertidas (÷100.000).</div>';
      corpo.innerHTML = h2b;

    } else if (abaAtiva === 'performance') {
      var idsP = Object.keys(estado.produtos).filter(function (id) {
        var mm = estado.produtos[id].metricas;
        return mm.visitantes !== undefined || mm.vendas_pagas !== undefined;
      });
      if (!idsP.length) {
        corpo.innerHTML = '<div class="vazio">Abra <b>Central de Dados → Performance de Produto</b> e navegue pela lista (role/pagine — a coleta pega o que a tela mostrar).</div>';
        return;
      }
      idsP.sort(function (a, b) { return (estado.produtos[b].metricas.vendas_pagas || 0) - (estado.produtos[a].metricas.vendas_pagas || 0); });
      var h5 = '<table><tr><th>Produto</th><th>ID</th><th class="num">Vendas</th><th class="num">Pedidos</th><th class="num">Ticket</th><th class="num">Visitantes</th><th class="num">CTR card</th><th class="num">Conversao</th><th class="num">Rejeicao</th><th class="num">Fatia loja</th></tr>';
      for (var q = 0; q < idsP.length; q++) {
        var pp = estado.produtos[idsP[q]];
        var m5 = pp.metricas;
        function pct5(v) { return v === undefined || v === null ? '—' : fmt((v <= 1 ? v * 100 : v), 2) + '%'; }
        h5 += '<tr><td class="nome">' + esc(pp.nome || '(sem nome)') + '</td><td>' + esc(pp.id) + '</td>' +
          '<td class="num">' + reais(m5.vendas_pagas) + '</td><td class="num">' + fmt(m5.pedidos_pagos) + '</td>' +
          '<td class="num">' + reais(m5.ticket_pedido) + '</td><td class="num">' + fmt(m5.visitantes) + '</td>' +
          '<td class="num">' + pct5(m5.ctr_card) + '</td><td class="num">' + pct5(m5.conversao_pago) + '</td>' +
          '<td class="num">' + pct5(m5.rejeicao) + '</td><td class="num">' + pct5(m5.fatia_vendas) + '</td></tr>';
      }
      h5 += '</table><div class="nota">Funil por produto (pagamento confirmado). A coleta acompanha o que a tela carregar — role a lista da Shopee para cobrir mais produtos.</div>';
      corpo.innerHTML = h5;

    } else if (abaAtiva === 'afiliados') {
      var brutosAf = estado.afiliados.campos || {};
      var uteis = {};
      for (var kaf in brutosAf) {
        if (/id/i.test(kaf)) continue;                       // IDs fora
        var vaf = brutosAf[kaf];
        if (typeof vaf !== 'number' || Math.abs(vaf) >= 1e11) continue; // numeros de ID gigantes fora
        if (!/(sale|commission|roi|click|order|buyer|gmv|invest|spend|conversion|item_sold)/i.test(kaf)) continue;
        if (/(sale|commission|gmv|spend|amount)/i.test(kaf) && Number.isInteger(vaf) && Math.abs(vaf) >= 100000) vaf = vaf / 100000;
        uteis[kaf] = vaf;
      }
      var ta = tabelaCampos(uteis, estado.afiliados.atualizadoEm, 'Afiliados — indicadores capturados (curadoria automatica)');
      corpo.innerHTML = ta || '<div class="vazio">Abra o <b>painel de Afiliados</b> e navegue pelos indicadores. A leitura estruturada entra na proxima rodada de calibragem.</div>';

    } else if (abaAtiva === 'cadastro') {
      var h3 = '';
      if (estado.modoPagina === 'publico') {
        var ap = estado.anuncioPublico;
        if (ap) {
          h3 += '<div class="kpis">' +
            '<div class="kpi"><div class="v">' + reais(ap.preco) + '</div><div class="l">Preco exibido</div></div>' +
            '<div class="kpi"><div class="v">' + (ap.estrelas === null ? '—' : fmt(ap.estrelas, 2)) + '</div><div class="l">Estrelas</div></div>' +
            '<div class="kpi"><div class="v">' + fmt(ap.vendidos) + '</div><div class="l">Vendidos</div></div>' +
            '<div class="kpi"><div class="v">' + ap.imagens.length + '</div><div class="l">Fotos no anuncio</div></div>' +
            '</div>' +
            '<div class="nota"><b style="color:#f2f2f4">' + esc(ap.nome) + '</b><br>ID ' + esc(ap.id) + ' — visao do cliente (vitrine). E daqui que o ClipSeller vai ler as fotos para critica e geracao de criativos (Etapa 7).</div>';
          var pv = estado.produtos[ap.id];
          if (pv && (pv.metricas.gasto !== undefined || pv.metricas.roas !== undefined)) {
            h3 += '<table><tr><th>Ads deste produto</th><th class="num">Gasto</th><th class="num">GMV</th><th class="num">ROAS</th><th class="num">Impr.</th><th class="num">Cliques</th><th class="num">CTR</th><th class="num">Pedidos</th><th class="num">Pos.</th></tr>' +
              '<tr><td class="nome">' + esc(pv.nome || '') + '</td>' + linhaMetrica(pv.metricas) + '</tr></table>';
          }
        } else {
          h3 = '<div class="vazio">Pagina publica detectada' + (estado.paginaProduto ? ' (ID ' + esc(estado.paginaProduto) + ')' : '') + '.<br>Status da leitura: <b>' + esc(estado.debugPublico || 'tentando...') + '</b><br>Se falhar, me mande esse status.</div>';
        }
        corpo.innerHTML = h3;
        return;
      }
      if (estado.paginaProduto) {
        var cad = estado.cadastro && estado.cadastro.id === estado.paginaProduto ? estado.cadastro : null;
        if (cad) {
          h3 += '<div class="kpis">' +
            '<div class="kpi"><div class="v">' + reais(cad.preco_promo !== null ? cad.preco_promo : cad.preco) + '</div><div class="l">' + (cad.preco_promo !== null ? 'Preco promocional' : 'Preco') + '</div></div>' +
            (cad.preco_promo !== null ? '<div class="kpi"><div class="v">' + reais(cad.preco) + '</div><div class="l">Preco normal</div></div>' : '') +
            '<div class="kpi"><div class="v">' + fmt(cad.estoque) + '</div><div class="l">Estoque</div></div>' +
            '<div class="kpi"><div class="v">' + cad.n_fotos + '</div><div class="l">Fotos</div></div>' +
            '<div class="kpi"><div class="v">' + cad.variacoes + '</div><div class="l">Variacoes</div></div>' +
            '</div>' +
            '<div class="nota"><b style="color:#f2f2f4">' + esc(cad.nome) + '</b><br>ID ' + esc(cad.id) + ' · ' + esc(cad.categoria) + '</div>';
        } else {
          h3 += '<div class="kpis"><div class="kpi"><div class="v">' + esc(estado.paginaProduto) + '</div><div class="l">ID do produto (chave-mestra)</div></div></div>';
        }
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

    } else if (abaAtiva === 'diamantes') {
      // CAMADA 1: painel de conferencia do ouro capturado
      var D = (window.SIA_Diamantes && window.SIA_Diamantes.estado()) || null;
      if (!D) { corpo.innerHTML = '<div class="vazio">Modulo de diamantes nao carregou. Recarregue a extensao.</div>'; }
      else {
        var R = window.SIA_Diamantes.resumo();
        var hd = '<div class="nota">Ouro capturado nesta sessao. Navegue pelo Seller Centre (Ads, Produtos, criar campanha) e veja encher. <b style="color:#f2f2f4">' + R.capturas + '</b> capturas.</div>';

        // bloco META ROAS
        hd += '<div class="bloco-d"><div class="td">META DE ROAS (SHOPEE)</div>';
        if (R.metaRoas) {
          hd += '<div class="ld">A Shopee recomenda <b>' + (R.metaRoas.exato != null ? R.metaRoas.exato.toFixed(1) + 'x' : '?') + '</b> para este produto</div>';
          if (R.metaRoas.conservador != null) hd += '<div class="ld" style="color:#7d8290;font-size:11px">(ela entrega bem de ' + R.metaRoas.conservador.toFixed(1) + 'x ate ' + (R.metaRoas.agressivo != null ? R.metaRoas.agressivo.toFixed(1) + 'x' : '?') + ' — quanto mais alto o ROAS, menos ela entrega)</div>';
          if (R.projecao) hd += '<div class="ld">Nesse ritmo ela projeta <b>+' + (R.projecao.gmvUpliftPct != null ? R.projecao.gmvUpliftPct.toFixed(0) : '?') + '% em vendas</b></div>';
        } else hd += '<div class="ld vazio-d">abra "criar campanha" no Ads para capturar</div>';
        hd += '</div>';

        // bloco LEILAO / CPM (o coracao do Leilao Reverso)
        hd += '<div class="bloco-d"><div class="td">O LEILAO (CPM REAL)</div>';
        if (R.leilao || R.gasto || R.lancePorPrecoLiberado !== undefined) {
          if (R.leilao && R.leilao.cpmReal != null) hd += '<div class="ld">CPM real: <b>R$ ' + R.leilao.cpmReal.toFixed(2) + '</b> por mil impressoes</div>';
          if (R.leilao && R.leilao.posicaoMedia != null) hd += '<div class="ld">Posicao media no leilao: <b>' + R.leilao.posicaoMedia + '</b></div>';
          if (R.gasto && R.gasto.hoje != null) hd += '<div class="ld">Gasto hoje: <b>R$ ' + R.gasto.hoje.toFixed(2) + '</b>' + (R.gasto.mediaSeteDias != null ? ' · media 7d R$ ' + R.gasto.mediaSeteDias.toFixed(2) : '') + '</div>';
          if (R.lancePorPrecoLiberado !== undefined) hd += '<div class="ld" style="color:#7d8290;font-size:11px">Lance manual por preco: ' + (R.lancePorPrecoLiberado ? 'liberado' : '<b style="color:#f5b041">desligado</b> (oCPM: a alavanca agora e preco competitivo + Meta de ROAS)') + '</div>';
        } else hd += '<div class="ld vazio-d">abra o grafico de desempenho de uma campanha no Ads para capturar</div>';
        hd += '</div>';

        // bloco ALGORITMO (as regras do oCPM)
        if (R.algoritmo && R.algoritmo.metaRoas) {
          var a = R.algoritmo;
          hd += '<div class="bloco-d"><div class="td">REGRAS DO ALGORITMO (oCPM)</div>';
          hd += '<div class="ld">Aprendizado: <b>' + a.metaRoas.aprendizadoDias + ' dias</b> (nao mexa nesse periodo)</div>';
          hd += '<div class="ld">Meta de ROAS muda no maximo <b>' + a.metaRoas.mudancaMaxPct + '%</b> por vez, <b>' + a.metaRoas.mudancasPorDia + 'x ao dia</b></div>';
          hd += '<div class="ld">Bloqueio de campanha: <b>' + a.metaRoas.bloqueioDias + ' dias</b> · teto do lance: <b>' + a.metaRoas.tetoMultiplicador + 'x</b></div>';
          if (a.lanceMinimo) hd += '<div class="ld">Lance minimo: busca produto <b>R$ ' + a.lanceMinimo.buscaProduto.toFixed(2) + '</b> · loja R$ ' + (a.lanceMinimo.buscaLoja != null ? a.lanceMinimo.buscaLoja.toFixed(2) : '?') + '</div>';
          if (a.notaMinimaAuto != null) hd += '<div class="ld" style="color:#7d8290;font-size:11px">Precisa nota &ge; ' + a.notaMinimaAuto + ' para o modo automatico</div>';
          hd += '</div>';
        }

        // bloco META SUGERIDA POR CAMPANHA (a Shopee te diz o ROAS ideal)
        var campsMeta = Object.keys(D.porCampanha).filter(function (k) { return D.porCampanha[k].metaShopee; });
        if (campsMeta.length) {
          hd += '<div class="bloco-d"><div class="td">META IDEAL DA SHOPEE (' + campsMeta.length + ' campanhas)</div>';
          campsMeta.slice(0, 6).forEach(function (k) {
            var ms = D.porCampanha[k].metaShopee;
            var seta = (ms.sugerida < ms.atual) ? 'baixar' : 'subir';
            hd += '<div class="ld">Campanha ' + k + ': voce em <b>' + (ms.atual != null ? ms.atual.toFixed(1) + 'x' : '?') + '</b>, Shopee sugere <b style="color:#f5b041">' + (ms.sugerida != null ? ms.sugerida.toFixed(1) + 'x' : '?') + '</b> (' + seta + ')' + (ms.ganhoGmvPct ? ' · +' + ms.ganhoGmvPct + '% vendas' : '') + '</div>';
          });
          if (campsMeta.length > 6) hd += '<div class="ld" style="color:#5a5f6a;font-size:11px">+ ' + (campsMeta.length - 6) + ' outras</div>';
          hd += '</div>';
        }

        // bloco CREDITOS E INCENTIVOS (dinheiro de ads)
        if (R.creditos || (R.incentivos && Object.keys(R.incentivos).length)) {
          hd += '<div class="bloco-d"><div class="td">CREDITOS E INCENTIVOS</div>';
          if (R.creditos && R.creditos.total != null) hd += '<div class="ld">Credito de ads: <b>R$ ' + R.creditos.total.toFixed(2) + '</b>' + (R.creditos.vencendo30d ? ' · <span style="color:#f5b041">R$ ' + R.creditos.vencendo30d.toFixed(2) + ' vence em 30d</span>' : '') + '</div>';
          if (R.incentivos && R.incentivos.metaGasto) hd += '<div class="ld">Gaste <b>R$ ' + R.incentivos.metaGasto.gasteParaGanhar.toFixed(2) + '</b> e ganhe <b>R$ ' + R.incentivos.metaGasto.recompensa.toFixed(2) + '</b> de credito</div>';
          if (R.incentivos && R.incentivos.surge) hd += '<div class="ld" style="color:#7d8290;font-size:11px">Impulso ativo pode elevar vendas em ~' + R.incentivos.surge.upliftGmvPct + '%</div>';
          hd += '</div>';
        }

        // bloco LOJA (saude geral)
        if (R.loja && R.loja.rating != null) {
          hd += '<div class="bloco-d"><div class="td">SUA LOJA</div>';
          hd += '<div class="ld">Nota: <b>' + R.loja.rating.toFixed(2) + '</b> (' + R.loja.avaliacoes + ' avaliacoes) · <b>' + R.loja.seguidores + '</b> seguidores</div>';
          if (R.loja.tag) hd += '<div class="ld">Selo: <b>' + esc(R.loja.tag) + '</b> · resposta no chat: <b>' + R.loja.taxaRespostaChat + '%</b></div>';
          hd += '</div>';
        }
        hd += '<div class="bloco-d"><div class="td">SAUDE DA CONTA</div>';
        var c = D.conta;
        if (c && (c.penalidade != null || c.percentilCategoria != null || c.fontes)) {
          if (c.penalidade != null) hd += '<div class="ld">Penalidade: <b>' + c.penalidade + '</b> ponto(s)</div>';
          if (c.notaPerformance) hd += '<div class="ld">Performance: <b>' + esc(c.notaPerformance) + '</b></div>';
          if (c.percentilCategoria != null) hd += '<div class="ld">Percentil categoria: <b>' + c.percentilCategoria + '</b></div>';
          if (c.fontes) hd += '<div class="ld">Fontes: ads ' + c.fontes.adsPct + '% · afiliado ' + c.fontes.afiliadoPct + '% · card ' + c.fontes.cardPct + '%</div>';
        } else hd += '<div class="ld vazio-d">navegue pela Central de Marketing para capturar</div>';
        hd += '</div>';

        // bloco PRODUTOS (diamantes por item)
        var prods = Object.keys(D.porProduto);
        hd += '<div class="bloco-d"><div class="td">PRODUTOS COM OURO (' + prods.length + ')</div>';
        if (prods.length) {
          for (var pi = 0; pi < Math.min(prods.length, 12); pi++) {
            var pid = prods[pi], pp = D.porProduto[pid];
            var partes = [];
            if (pp.status) partes.push(pp.status === 'deboost' ? '<span style="color:#e74c3c">LIMITADO</span>' : 'normal');
            if (pp.posicaoLeilao != null) partes.push('leilao ' + pp.posicaoLeilao);
            if (pp.competitividade != null) partes.push('comp ' + pp.competitividade);
            if (pp.emAprendizado) partes.push('aprendizado');
            if (pp.janelaNovoDias != null) partes.push('novo ' + pp.janelaNovoDias + 'd');
            hd += '<div class="ld"><span style="color:#7d8290">' + pid + '</span> ' + partes.join(' · ') + '</div>';
          }
        } else hd += '<div class="ld vazio-d">abra a lista de Produtos no Ads para capturar</div>';
        hd += '</div>';

        // bloco CAMPANHAS diagnosticadas
        var camps = Object.keys(D.porCampanha);
        hd += '<div class="bloco-d"><div class="td">DIAGNOSTICO SHOPEE (' + camps.length + ' campanhas)</div>';
        if (camps.length) {
          var contaNota = { good: 0, fair: 0, poor: 0 };
          camps.forEach(function (ci) { var nt = D.porCampanha[ci].nota; if (contaNota[nt] != null) contaNota[nt]++; });
          hd += '<div class="ld">Boas: <b style="color:#2ecc71">' + contaNota.good + '</b> · Medianas: <b style="color:#f5b041">' + contaNota.fair + '</b> · Ruins: <b style="color:#e74c3c">' + contaNota.poor + '</b></div>';
        } else hd += '<div class="ld vazio-d">navegue pelo Ads para capturar os vereditos</div>';
        hd += '</div>';

        // bloco BUSCA
        var buscas = Object.keys(D.busca);
        hd += '<div class="bloco-d"><div class="td">ESPIAO DE BUSCA (' + buscas.length + ')</div>';
        if (buscas.length) {
          buscas.slice(0, 5).forEach(function (kw) {
            var b = D.busca[kw];
            hd += '<div class="ld">"' + esc(kw) + '": ' + b.total + ' resultados capturados</div>';
          });
        } else hd += '<div class="ld vazio-d">pesquise na busca da Shopee (shopee.com.br) para capturar</div>';
        hd += '</div>';

        hd += '<div class="nota" style="margin-top:8px">Isto e a Camada 1: so a coleta. Quando os diamantes que voce navegou aparecerem aqui, esta funcionando — e ai construo a Camada 2 (o cerebro que usa tudo isso).</div>';
        corpo.innerHTML = hd;
      }
    } else if (abaAtiva === 'debug') {
      var okInterceptor = !!estado.interceptorVersao;
      var pj = estado.periodoAds ? (estado.periodoAds.dias + ' dia(s)') : 'nao capturado';
      var h4pre = estado.modoPagina === 'publico' ? '<div class="nota">Pagina publica: ' + esc(estado.debugPublico || 'aguardando leitura...') + '</div>' : '';
      var lj = estado.loja ? (estado.loja.shop_id + (estado.loja.nome ? ' · ' + estado.loja.nome : '')) : 'nao capturada';
      var h4 = h4pre + '<div class="nota">Loja: <b style="color:#f2f2f4">' + esc(lj) + '</b> · Janela do Ads: <b style="color:#f2f2f4">' + esc(pj) + '</b></div>' +
        '<div class="nota">Interceptor' +
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

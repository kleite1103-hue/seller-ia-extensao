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

  var VERSAO = '0.45.0';
  var MICRO = 100000;

  /* ================= PONTE DA BUSCA PUBLICA (Espiao) =================
     A busca da Shopee NAO aceita chamada montada por nos: ela exige
     headers de antifraude (af-ac-enc-dat, x-sap-ri, x-sap-sec) que o
     proprio JS dela gera. Por isso o 403 — nao era login nem origem.
     Solucao: nao chamamos nada. O bg abre a pagina de busca numa aba
     em segundo plano, a Shopee faz a chamada assinada dela mesma, e o
     interceptor captura a resposta. Clean-room: so escutamos. */
  function repassarBusca(url, dados) {
    try {
      if (!/\/api\/v4\/search\/search_items/.test(url)) return;
      var mk = url.match(/keyword=([^&]*)/);
      if (!mk) return;
      var kw = decodeURIComponent(String(mk[1]).replace(/\+/g, ' '));
      var itens = (dados && dados.items) || [];
      if (!kw || !itens.length) return;
      chrome.runtime.sendMessage({ tipo: 'sia:busca-capturada', termo: kw, itens: itens }, function () { void chrome.runtime.lastError; });
    } catch (e) { /* noop */ }
  }

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
    espiao: { termo: '', buscando: false, erro: null, res: null, radar: null },  // Espiao de Busca
    cofre: { custos: {}, embalagem: 0, imposto: 0 },  // Cofre de Custos (por loja)
    contas: {},              // snapshot por shop_id — isola conta de conta
    trocou: null,            // ultima troca de conta detectada
    lidoEm: null,            // quando esta conta foi lida
    autoColeta: false,       // coletar sozinho ao trocar de conta
    filaCompleta: false,     // Inicio mostra 5; o resto atras de um clique
    rel: { mes: null, gerando: false, markdown: null, erro: null, etapa: '', loja: null },
    modoTecnico: false,      // mostra a aba Debug (duplo clique no logo)
    temaClaro: false,        // tema claro (nude) ou escuro
    vereditos: null,         // vereditos vindos do cerebro
    fonteVeredito: 'local',  // 'cerebro' | 'local'
    versaoRegras: null,
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

    // ---- ESPIAO: a busca da vitrine passou por aqui, repassa ao bg ----
    repassarBusca(pacote.url, pacote.dados);

    if (tag === 'publico') { absorverPublico(pacote.dados); }
    else if (tag === 'cadastro' && pacote.url.indexOf('get_product_info') >= 0) { absorverCadastro(pacote.dados); }
    else if (tag === 'conta') {
      if (!parseMydataProdutos(pacote.url, pacote.dados, pacote.corpo)) { absorverPainel(pacote.dados, estado.conta); garimpar(pacote.dados, { tag: tag }); }
    }
    else if (tag === 'afiliados') { absorverPainel(pacote.dados, estado.afiliados); /* sem garimpo: micro proprio, tratado na v0.6 */ }
    else if (tag === 'ads') { if (!parsePas(pacote.url, pacote.corpo, pacote.dados)) garimpar(pacote.dados, { tag: tag }); }
    else if (tag === 'outra') {
      if (pacote.url.indexOf('shop_info') >= 0) {
        // NUNCA travar na primeira leitura. Agencia troca de conta o dia todo
        // na mesma guia: se a identidade nao acompanhar, o dado da conta A
        // aparece rotulado como conta B. Isso e pior que nao coletar.
        var achado = null;
        (function cacar(no, prof) {
          if (achado || !no || typeof no !== 'object' || prof > 4) return;
          if (Array.isArray(no)) { for (var i = 0; i < no.length; i++) cacar(no[i], prof + 1); return; }
          var sid = no.shop_id !== undefined ? no.shop_id : no.shopid;
          if (sid) { achado = { shop_id: String(sid), nome: no.shop_name || no.name || no.username || '' }; return; }
          for (var k in no) { if (no[k] && typeof no[k] === 'object') cacar(no[k], prof + 1); }
        })(pacote.dados, 0);
        if (achado) aplicarLoja(achado);
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
    var h = '<div style="font-weight:700;font-size:12px;color:var(--t0);margin-bottom:6px">O que e</div>' +
      '<div style="font-size:12px;color:#c9cdd6;line-height:1.5">' + item.oque + '</div>';
    if (le) {
      h += '<div style="font-weight:700;font-size:12px;color:var(--t0);margin:10px 0 4px">Como esta o seu</div>' +
        '<div style="font-size:12px;line-height:1.5;color:#c9cdd6"><b style="color:' + (le.bom ? 'var(--vd)' : 'var(--am)') + '">' + le.valor + '</b>' + (le.texto ? ' — ' + le.texto : '') + '</div>';
    }
    h += '<div style="font-weight:700;font-size:12px;color:var(--t0);margin:10px 0 4px">Faca assim</div>' +
      '<div style="font-size:12px;color:#c9cdd6;line-height:1.5">' + item.acao + '</div>' +
      '<div style="font-size:9px;color:var(--t2);margin-top:10px;letter-spacing:.08em">SELLER.IA · METODO EFEITO VENDAS</div>';
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
    cardLente.style.cssText = 'all:initial;position:fixed;' + pos + 'z-index:2147483200;width:min(430px,94vw);max-height:70vh;display:flex;flex-direction:column;background:var(--b1);border:1px solid var(--li2);border-top:3px solid var(--mk);border-radius:12px;box-shadow:0 16px 50px rgba(0,0,0,.6);font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;';
    cardLente.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--li);flex:none">' +
      '<span style="width:14px;height:14px;border-radius:4px;background:linear-gradient(120deg,var(--mk),var(--px));display:inline-block"></span>' +
      '<span style="font:700 12px Arial;color:var(--t0);letter-spacing:.04em;flex:1">' + (titulo || 'SELLER.IA') + '</span>' +
      '<button data-sia-fechar="1" style="all:initial;cursor:pointer;color:var(--t1);font:700 14px Arial;padding:4px 8px;border-radius:6px;background:var(--b2)">✕</button>' +
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
        selo.style.cssText = 'all:initial;display:block;width:fit-content;max-width:220px;margin-top:4px;padding:2px 10px;border-radius:4px;background:linear-gradient(120deg,var(--mk),var(--px));color:var(--t0);font:700 8.5px/1.5 Arial;letter-spacing:.05em;cursor:pointer;' + (leRapida ? 'box-shadow:0 0 0 1px ' + (leRapida.bom ? 'var(--vd)' : 'var(--am)') + ' inset;' : '');
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
    var cor = { forte: 'var(--vd)', atencao: 'var(--am)', critico: 'var(--rd)' };
    var h = '<div style="font-weight:700;font-size:12px;color:var(--t0);margin-bottom:8px">' + nomeCamp.slice(0, 60) + '</div>';
    for (var i = 0; i < vereditos.length; i++) {
      var vd = vereditos[i];
      h += '<div style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--li)">' +
        '<span style="font-size:9px;letter-spacing:.08em;border:1px solid ' + (cor[vd.status] || 'var(--t2)') + ';color:' + (cor[vd.status] || 'var(--t2)') + ';border-radius:99px;padding:2px 8px">' + vd.veredito + '</span>' +
        '<div style="font-weight:700;font-size:12px;color:var(--t0);margin:6px 0 3px">' + vd.manchete + '</div>' +
        '<div style="font-size:11.5px;color:#c9cdd6;line-height:1.45;white-space:pre-line">' + vd.diagnostico + '</div>';
      if (vd.passos && vd.passos.length) {
        h += '<div style="font-size:11.5px;color:var(--t0);font-weight:700;margin-top:6px">Faca assim:</div><ol style="margin:2px 0 0 16px;padding:0">';
        for (var p2 = 0; p2 < vd.passos.length; p2++) h += '<li style="font-size:11.5px;color:#c9cdd6;margin:2px 0;line-height:1.4">' + vd.passos[p2] + '</li>';
        h += '</ol>';
      }
      if (vd.impacto) h += '<div style="font-size:11.5px;margin-top:5px;color:#a78bfa"><b>Impacto:</b> <span style="color:#c9cdd6">' + vd.impacto + '</span></div>';
      h += '</div>';
    }
    h += '<div style="font-size:9px;color:var(--t2);letter-spacing:.08em">SELLER.IA · METODO EFEITO VENDAS</div>';
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
      var corS = pior === 'forte' ? 'var(--vd)' : pior === 'critico' ? 'var(--rd)' : 'var(--am)';
      var mB = estado.campanhas[idC] && estado.campanhas[idC].metricas ? estado.campanhas[idC].metricas : {};
      var posTxt = typeof mB.posicao === 'number' ? ' · POS ' + Math.round(mB.posicao) : '';
      barra.textContent = 'Seller.IA · ' + meus[0].veredito + posTxt;
      barra.style.boxShadow = '0 0 0 1px ' + corS + ' inset';
      return;
    }
    if (estado.diagnostico && estado.diagnostico.vereditos && grupoObservacao()) {
      barra.textContent = 'Seller.IA · EM OBSERVACAO';
      barra.style.boxShadow = '0 0 0 1px var(--am) inset';
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
        selo.style.cssText = 'all:initial;display:block;width:fit-content;max-width:230px;margin-top:3px;padding:2px 10px;border-radius:4px;background:linear-gradient(120deg,var(--mk),var(--px));color:var(--t0);font:700 8.5px/1.5 Arial;letter-spacing:.05em;cursor:pointer;';
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
              abrirCardHtml(ev.target, '<div style="color:#c9cdd6"><b style="color:var(--t0)">' + nomeF.slice(0, 60) + '</b><br>' +
                '<span style="font-size:9px;letter-spacing:.08em;border:1px solid var(--am);color:var(--am);border-radius:99px;padding:2px 8px;display:inline-block;margin:6px 0">EM OBSERVACAO</span><br>' +
                'Numeros do periodo: gasto R$ ' + fLe(mG.gasto || 0, 2) + ' · vendas R$ ' + fLe(mG.gmv || 0, 2) + ' · ' + fLe(mG.pedidos || 0, 0) + ' pedido(s)' + (roasG ? ' · ROAS ' + fLe(roasG, 2) + 'x' : '') + '.<br>' +
                (typeof mG.posicao === 'number' ? '<b style="color:var(--t0)">Leilao:</b> posicao media ' + Math.round(mG.posicao) + (mG.posicao <= 10 ? ' — vitrine nobre; o funil esta pagando o espaco.' : mG.posicao > 40 ? ' — fundo de vitrine; enquanto acumula vendas, ja da pra atacar a causa: ' + (typeof mG.ctr === 'number' && (mG.ctr <= 1 ? mG.ctr * 100 : mG.ctr) >= 2 ? 'o card clica bem, o alvo e conversao/ticket da pagina.' : 'o card clica pouco — foto principal e titulo.') : ' — zona intermediaria do leilao.') + '<br>' : '') +
                (typeof mG.ctr === 'number' ? '<b style="color:var(--t0)">CTR:</b> ' + fLe((mG.ctr <= 1 ? mG.ctr * 100 : mG.ctr), 2) + '%<br>' : '') + '<br>' +
                '<b style="color:var(--t0)">Por que sem veredito individual:</b> ainda ha poucas vendas para uma leitura confiavel — o ROAS pode dobrar ou cair pela metade por puro acaso. Decidir agora seria chutar.<br><br>' +
                '<b style="color:var(--t0)">Faca assim:</b> nao pause nem escale; mantenha o orcamento estavel e deixe acumular vendas. Quando passar do volume minimo da janela, o veredito proprio aparece aqui sozinho.</div>');
              return;
            }
            {
              var c = estado.campanhas[idF];
              var m = c && c.metricas ? c.metricas : {};
              var roasT = m.roas !== undefined ? m.roas : (m.gasto ? (m.gmv || 0) / m.gasto : null);
              abrirCardHtml(ev.target, '<div style="color:#c9cdd6"><b style="color:var(--t0)">' + nomeF.slice(0, 60) + '</b><br><br>' +
                'Dados coletados: gasto R$ ' + fLe(m.gasto || 0, 2) + ' · vendas R$ ' + fLe(m.gmv || 0, 2) + (roasT ? ' · ROAS ' + fLe(roasT, 2) + 'x' : '') + '.<br><br>' +
                'Rode <b style="color:var(--mk)">Coletar conta completa + Analisar</b> no painel para o veredito do metodo aparecer aqui.</div>');
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
    function nota(ok2, rotulo) { return '<b style="color:' + (ok2 === true ? 'var(--vd)' : ok2 === false ? 'var(--rd)' : 'var(--am)') + '">' + rotulo + '</b>'; }

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
      var linha = 'Do ticket de R$ ' + fLe(tk, 2) + ': comissao Shopee R$ ' + fLe(com, 2) + ' → sobram <b style="color:var(--t0)">R$ ' + fLe(liquido, 2) + '</b> por pedido, antes de custo do produto e trafego.';
      if (typeof m.gasto === 'number' && typeof m.pedidos_pagos === 'number' && m.pedidos_pagos > 0 && m.gasto > 0) {
        var adsPed = m.gasto / m.pedidos_pagos;
        linha += ' Descontando o ads deste produto (~R$ ' + fLe(adsPed, 2) + '/pedido, estimado), sobram <b style="color:var(--t0)">R$ ' + fLe(liquido - adsPed, 2) + '</b>.';
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
    var h = '<div style="font-weight:700;font-size:12px;color:var(--t0);margin-bottom:2px">' + titulo + '</div>' +
      '<div style="font-size:9.5px;color:var(--t2);margin-bottom:8px">ID ' + id + '</div>';
    if (!p || !p.metricas || !Object.keys(p.metricas).length) {
      return h + '<div style="font-size:12px;color:#c9cdd6;line-height:1.5">Ainda sem dados coletados deste produto nesta sessao. Navegue pela <b>Performance de Produto</b> (e role ate ele aparecer na lista) — a leitura fica pronta aqui.</div>';
    }
    var m = p.metricas;
    function cel(rot, val) { return val === undefined || val === null ? '' : '<div style="min-width:86px"><div style="font-size:9px;color:var(--t2);text-transform:uppercase;letter-spacing:.05em">' + rot + '</div><div style="font-size:13px;font-weight:700;color:var(--t0)">' + val + '</div></div>'; }
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
      h += '<div style="font-weight:700;font-size:12px;color:var(--t0);margin-bottom:4px">O que os numeros dizem</div>';
      for (var i = 0; i < leituras.length; i++) {
        var corPonto = leituras[i].ok === true ? 'var(--vd)' : leituras[i].ok === false ? 'var(--rd)' : 'var(--am)';
        h += '<div style="font-size:11.5px;line-height:1.5;color:#c9cdd6;margin-bottom:5px"><span style="color:' + corPonto + '">&#9679;</span> ' + leituras[i].txt + '</div>';
      }
    }
    var vds = estado.diagnostico && estado.diagnostico.vereditos ? estado.diagnostico.vereditos.filter(function (v) { return String(v.id).split(':')[0] === String(id); }) : [];
    if (vds.length) {
      h += '<div style="font-weight:700;font-size:12px;color:var(--t0);margin:8px 0 4px">Veredito Seller.IA</div>';
      for (var v2 = 0; v2 < Math.min(vds.length, 2); v2++) {
        var vd = vds[v2];
        h += '<div style="font-size:11.5px;color:#c9cdd6;line-height:1.45;margin-bottom:6px"><b style="color:var(--mk)">' + vd.veredito + '</b> — ' + vd.manchete + '</div>';
        if (vd.passos && vd.passos.length) {
          h += '<ol style="margin:0 0 4px 16px;padding:0">';
          for (var pz = 0; pz < vd.passos.length; pz++) h += '<li style="font-size:11px;color:#c9cdd6;margin:2px 0">' + vd.passos[pz] + '</li>';
          h += '</ol>';
        }
      }
    } else {
      h += '<div style="font-size:10.5px;color:var(--t2);margin-top:6px">Para o veredito completo do metodo, clique em Analisar no painel Seller.IA.</div>';
    }
    h += '<div style="font-size:9px;color:var(--t2);margin-top:8px;letter-spacing:.08em">SELLER.IA · METODO EFEITO VENDAS</div>';
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
      selo.style.cssText = 'all:initial;display:inline-block;margin-left:8px;padding:2px 8px;border-radius:99px;background:linear-gradient(120deg,var(--mk),var(--px));color:var(--t0);font:700 8.5px/1.3 Arial;letter-spacing:.05em;cursor:pointer;vertical-align:middle;';
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

  /* auto-coleta: ao entrar no Seller Centre, coleta e analisa sozinha (no maximo 1x a cada 2h) */
  var AUTO_INTERVALO_MS = 2 * 3600 * 1000;
  var autoTentativas = 0;
  var autoTimer = setInterval(function () {
    if (location.hostname !== 'seller.shopee.com.br') { clearInterval(autoTimer); return; }
    autoTentativas++;
    if (autoTentativas > 60) { clearInterval(autoTimer); return; } // ~5min tentando achar a sessao
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
              chrome.runtime.sendMessage({ tipo: 'sia:analisar', payload: payloadCerebro(foto) }, function (resp) {
                void chrome.runtime.lastError;
                guardarVereditos(resp);
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
  var CONTAGEM_BUSCA = { ok: 0, falhas: 0 };
  function buscar(url, metodo, corpo) {
    return new Promise(function (resolveOriginal) {
      function resolve(r) {
        // coleta que termina dizendo "pronto" com metade das rotas quebradas
        // e pior que uma que falha na cara: o analista confia no que ve
        if (r && r.ok) CONTAGEM_BUSCA.ok++; else CONTAGEM_BUSCA.falhas++;
        resolveOriginal(r);
      }
      var id = 'b' + (++seqBusca) + '_' + Date.now();
      pendentesBusca[id] = resolve;
      try {
        window.dispatchEvent(new CustomEvent('SIA_BUSCAR', { detail: JSON.stringify({ id: id, url: url, metodo: metodo || 'GET', corpo: corpo || null }) }));
      } catch (e) { resolve({ ok: false, erro: 'ponte indisponivel' }); }
      setTimeout(function () { if (pendentesBusca[id]) { pendentesBusca[id]({ ok: false, erro: 'tempo esgotado' }); delete pendentesBusca[id]; } }, 15000);
    });
  }
  function pausa(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function coletaCompleta(aoProgresso, periodoForcado) {
    estado.coletaProgresso = 'iniciando';
    // leitura de periodo passado nao representa o estado atual da conta
    estado.leituraHistorica = !!periodoForcado;
    return new Promise(function (resolver) {
      (async function () {
        function prog(t) {
          estado.coletaProgresso = t; estado.sujo = true;
          if (t === null) {
            estado.lidoEm = Date.now();               // terminou: marca a leitura DESTA conta
            estado.ultimaColeta = { ok: CONTAGEM_BUSCA.ok, falhas: CONTAGEM_BUSCA.falhas };
            if (estado.loja) guardarConta(estado.loja.shop_id);
          }
          if (aoProgresso) aoProgresso(t);
        }
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
        // MAIS FORTE QUE TUDO: periodo escolhido no seletor de mes do Relatorio.
        // Sem isto, o mes do relatorio era so um rotulo e os numeros continuavam
        // sendo os do recorte que estivesse aberto no painel da Shopee.
        if (periodoForcado && periodoForcado.inicio && periodoForcado.fim) {
          ini = periodoForcado.inicio;
          fim = periodoForcado.fim;
        } else if (estado.periodoMydata && estado.periodoMydata.inicio && estado.periodoMydata.fim) {
          ini = estado.periodoMydata.inicio;
          fim = estado.periodoMydata.fim;
        } else {
          // FALLBACK: calcula (inicio do mes ate ontem 00:00 BRT)
          var hoje0 = inicioDoDiaBRT(agora);
          var dNow = new Date(hoje0 * 1000);
          var primeiroMes = new Date(Date.UTC(dNow.getUTCFullYear(), dNow.getUTCMonth(), 1, 3, 0, 0));
          ini = Math.floor(primeiroMes.getTime() / 1000);
          // end = HOJE 00:00 BRT. Isso representa "ate o fim de ontem" (D-1),
          // que e o que a Shopee disponibiliza. Testado: funciona (v0.23.6).
          fim = hoje0;
        }
        // se estiver na tela de Ads com janela selecionada, espelha (alinhado ao dia)
        var mFrom = location.search.match(/[?&]from=(\d{9,11})/);
        var mTo = location.search.match(/[?&]to=(\d{9,11})/);
        if (mFrom && mTo && !periodoForcado) { ini = inicioDoDiaBRT(parseInt(mFrom[1], 10)); fim = inicioDoDiaBRT(parseInt(mTo[1], 10)); }
        var spcQ = 'SPC_CDS=' + estado.spc + '&SPC_CDS_VER=2';
        var totalChamadas = 0;
        CONTAGEM_BUSCA.ok = 0; CONTAGEM_BUSCA.falhas = 0;
        // o Ads (pas/) exige end_time no ULTIMO segundo do dia (23:59:59),
        // nao 00:00 do dia seguinte. Senao retorna code 5 "invalid request".
        var fimAds = fim - 1;

        // A) Campanhas do Ads (paginado por offset)
        prog('Lendo campanhas do Shopee Ads...');
        for (var off = 0; off < 400; off += 20) {
          var corpoC = JSON.stringify({ start_time: ini, end_time: fimAds, filter_list: [{ campaign_type: 'product_homepage_v3', state: 'all', search_term: '', is_valid_rebate_only: false }], offset: off, limit: 20, use_paid_gmv: false });
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
        // B') O QUE A SHOPEE SABE E NAO MOSTRA
        // Posicao no leilao, competitividade de preco, status e o diagnostico
        // dela so vinham quando o analista abria campanha por campanha. Numa
        // conta com 300 campanhas isso nunca acontecia — a coluna ficava vazia
        // para sempre. Agora a coleta busca de uma vez para as que mais gastam.
        var idsGasto = Object.keys(estado.campanhas).sort(function (a, b) {
          var ma = (estado.campanhas[a] && estado.campanhas[a].metricas) || {};
          var mb = (estado.campanhas[b] && estado.campanhas[b].metricas) || {};
          return (mb.gasto || 0) - (ma.gasto || 0);
        });
        var alvoLeilao = idsGasto.slice(0, 60);
        if (alvoLeilao.length) {
          prog('Lendo posicao no leilao e diagnostico da Shopee...');
          for (var lv = 0; lv < alvoLeilao.length; lv += 20) {
            var lote20 = alvoLeilao.slice(lv, lv + 20).map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !!x; });
            if (!lote20.length) continue;
            var corpoV = JSON.stringify({ campaign_id_list: lote20, start_time: ini, end_time: fimAds });
            var rv = await buscar('/api/pas/v1/diagnosis/homepage_batch_list_verdict/?' + spcQ, 'POST', corpoV);
            totalChamadas++;
            if (rv.ok && rv.dados) {
              processarPacote({ url: '/api/pas/v1/diagnosis/homepage_batch_list_verdict/', metodo: 'POST', corpo: corpoV, dados: rv.dados, ts: Date.now() });
            }
            await pausa(450);   // rajada sem intervalo e o padrao que dispara antifraude
            var corpoPI = JSON.stringify({ campaign_id_list: lote20, start_time: ini, end_time: fimAds });
            var rpi = await buscar('/api/pas/v1/campaign/get_product_performance_info/?' + spcQ, 'POST', corpoPI);
            totalChamadas++;
            if (rpi.ok && rpi.dados) {
              processarPacote({ url: '/api/pas/v1/campaign/get_product_performance_info/', metodo: 'POST', corpo: corpoPI, dados: rpi.dados, ts: Date.now() });
            }
            await pausa(450);
          }
        }

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
        await pausa(150);

        // J) Avaliacoes dos top produtos (1-2 estrelas = risco). Pega ate 6 produtos
        // com mais venda (ja temos no cofre pela performance).
        prog('Lendo avaliacoes dos produtos...');
        try {
          var cofreP = window.SIA_Diamantes ? window.SIA_Diamantes.estado().porProduto : null;
          if (cofreP) {
            var idsAval = Object.keys(cofreP)
              .filter(function (k) { return cofreP[k].perf && cofreP[k].perf.vendaPaga; })
              .sort(function (a, b) { return (cofreP[b].perf.vendaPaga || 0) - (cofreP[a].perf.vendaPaga || 0); })
              .slice(0, 6);
            for (var ia = 0; ia < idsAval.length; ia++) {
              var urlAv = '/api/v2/item/get_ratings?itemid=' + idsAval[ia] + '&filter=0&flag=1&limit=6&offset=0&type=0&exclude_filter=1';
              var rav = await buscar(urlAv, 'GET', null);
              totalChamadas++;
              if (rav.ok && rav.dados) processarPacote({ url: urlAv, metodo: 'GET', corpo: null, dados: rav.dados, ts: Date.now() });
              await pausa(120);
            }
          }
        } catch (eAv) { /* noop */ }

        prog(null);
        resolver({ ok: true, chamadas: totalChamadas, campanhas: Object.keys(estado.campanhas).length, produtos: Object.keys(estado.produtos).length });
      })();
    });
  }

  /* ================================ UI ================================= */
  // As fontes precisam viver no DOCUMENTO. @font-face declarado dentro de um
  // shadow root nao e aplicado ao conteudo dele no Chrome — era por isso que
  // Bebas Neue e Outfit nunca carregavam e tudo caia em Arial.
  (function carregarFontes() {
    if (document.getElementById('sia-fontes')) return;
    var l = document.createElement('link');
    l.id = 'sia-fontes';
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Outfit:wght@300;400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap';
    (document.head || document.documentElement).appendChild(l);
  })();

  var host = document.createElement('div');
  host.id = 'seller-ia-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;bottom:0;right:0;';
  document.documentElement.appendChild(host);
  var raiz = host.attachShadow({ mode: 'closed' });

  var LOGO = '<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff4d1c"/><stop offset="1" stop-color="#7B2FFF"/></linearGradient></defs><rect x="4" y="4" width="120" height="120" rx="30" fill="#07080a"/><rect x="4" y="4" width="120" height="120" rx="30" fill="none" stroke="url(#g)" stroke-width="5"/><path d="M 90 38 H 56 a 17 17 0 0 0 0 34 h 16 a 17 17 0 0 1 0 34 H 38" fill="none" stroke="url(#g)" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/><circle cx="93" cy="99" r="9" fill="#ff4d1c"/></svg>';

  raiz.innerHTML =
    '<style>' +
    ':host{all:initial;' +
    '--b0:#07080a;--b1:#0c0e12;--b2:#12151b;--li:#1d212a;--li2:#2a2f3a;' +
    '--t0:#f2f2f4;--t1:#b8bcc6;--t2:#8a909c;--t3:#5a5f6a;' +
    '--mk:#ff4d1c;--mk2:#ff7a4d;--vd:#2ecc71;--rd:#e74c3c;--am:#f5b041;--px:#c08bff;' +
    '--sh:rgba(0,0,0,.55);--shb:rgba(0,0,0,.45)}' +
    ':host(.claro){' +
    '--b0:#ffffff;--b1:#fbfaf8;--b2:#f5f3ef;--li:#e5e1d8;--li2:#d4cec1;' +
    '--t0:#1b1b1e;--t1:#4d5057;--t2:#7c818a;--t3:#a4a8b0;' +
    '--mk:#e0400f;--mk2:#f06a33;--vd:#1c8a52;--rd:#c42a2f;--am:#a8700a;--px:#6b28d9;' +
    '--sh:rgba(60,50,40,.16);--shb:rgba(60,50,40,.22)}' +
    '*{box-sizing:border-box;margin:0;padding:0;font-family:"Outfit",-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-weight:300}' +
    '.botao{position:fixed;bottom:22px;right:22px;width:54px;height:54px;z-index:2147483001;border-radius:50%;cursor:pointer;box-shadow:0 4px 18px var(--shb);transition:transform .15s;background:var(--b0);border:none;padding:6px}' +
    '.botao:hover{transform:scale(1.08)}' +
    '.botao svg{width:100%;height:100%}' +
    '.painel{position:fixed;top:0;right:0;height:100vh;width:min(640px,100vw);background:var(--b1);border-left:1px solid var(--li);box-shadow:-18px 0 50px var(--sh);display:flex;flex-direction:column;overflow:hidden;color:var(--t0);transform:translateX(102%);transition:transform .26s cubic-bezier(.4,0,.2,1);z-index:2147483000}' +
    '.painel.aberto{transform:translateX(0)}' +
    '@media(prefers-reduced-motion:reduce){.painel{transition:none}}' +
    '.cab{display:flex;align-items:center;gap:11px;padding:16px 20px 14px;border-bottom:1px solid var(--li);background:var(--b0);flex-wrap:wrap}' +
    '.cab svg{width:28px;height:28px;flex:none}' +
    '.cab .titulo{font-family:"Bebas Neue";font-weight:400;font-size:29px;letter-spacing:.05em;line-height:1}' +
    '.cab .titulo em{font-style:normal;color:var(--mk)}' +
    '.cab .info{font-family:"Space Mono";font-size:11.5px;color:var(--t2);width:100%;order:3;margin-top:2px}' +
    '.cab .acoes{margin-left:auto;display:flex;gap:6px}' +
    '.cab button{background:var(--b2);border:1px solid var(--li);color:var(--t1);font-family:"Space Mono";font-size:11px;padding:7px 11px;border-radius:7px;cursor:pointer}' +
    '.cab button:hover{border-color:var(--mk);color:var(--t0)}' +
    '.abas{display:flex;flex-wrap:nowrap;gap:1px;background:var(--b0);padding:0 14px;border-bottom:1px solid var(--li);overflow-x:auto;scrollbar-width:none}' + '.abas::-webkit-scrollbar{display:none}' +
    '.subabas{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}' +
    '.subaba{background:var(--b2);border:1px solid var(--li);color:var(--t2);font-family:"Space Mono";font-size:12px;padding:8px 14px;border-radius:8px;cursor:pointer}' +
    '.subaba.ativa{color:var(--t0);border-color:var(--mk);background:rgba(255,77,28,.1)}' +
    '.aba{background:none;border:none;color:var(--t2);font-family:"Space Mono";font-size:13px;letter-spacing:.03em;padding:13px 13px;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}' +
    '.aba.ativa{color:var(--t0);border-bottom-color:var(--mk)}' +
    '.corpo{flex:1;overflow-y:auto;overflow-x:hidden;padding:26px 26px 40px}' +
    /* olho de secao: o padrao do Club — traco curto, mono pequeno, muito respiro */
    '.olho{display:flex;align-items:center;gap:10px;font-family:"Space Mono";font-size:11.5px;color:var(--t2);letter-spacing:.14em;margin:32px 0 14px}' +
    '.olho:first-child{margin-top:0}' +
    '.olho::before{content:"";width:22px;height:2px;background:var(--mk);flex:none}' +
    '.leitura{margin-bottom:20px}' +
    '.leitura .fr{font-size:26px;font-weight:500;line-height:1.28;color:var(--t0);letter-spacing:-.02em}' +
    '.leitura .fr .d{color:var(--rd)}.leitura .fr .w{color:var(--am)}.leitura .fr .u{color:var(--vd)}' +
    '.leitura .ex{font-size:15.5px;color:var(--t1);margin-top:11px;line-height:1.6}' +
    '.tres{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--li);border:1px solid var(--li);border-radius:13px;overflow:hidden;margin-bottom:18px}' +
    '.tres>div{background:var(--b2);padding:19px 12px;text-align:center}' +
    '.tres .v{font-family:"Bebas Neue";font-size:40px;line-height:1}' +
    '.tres .l{font-family:"Space Mono";font-size:10px;color:var(--t2);letter-spacing:.07em;margin-top:7px}' +
    '.tres .s{font-size:12.5px;color:var(--t2);margin-top:3px}' +
    /* cabecalho de tela: olho + display + numero fantasma, como no Club */
    '.capa{position:relative;padding:0 0 14px;margin-bottom:14px;border-bottom:1px solid var(--li)}' +
    '.capa .ol{display:flex;align-items:center;gap:10px;font-family:"Space Mono";font-size:11px;color:var(--mk);letter-spacing:.14em;margin-bottom:9px}' +
    '.capa .ol::before{content:"";width:22px;height:2px;background:var(--mk);flex:none}' +
    '.capa .dp{font-family:"Bebas Neue";font-size:30px;line-height:1;letter-spacing:.02em;color:var(--t0)}' +
    '.capa .dp small{font-family:"Bebas Neue";font-size:30px;color:var(--t2);margin-left:7px}' +
    '.capa .gh{position:absolute;top:-2px;right:0;font-family:"Bebas Neue";font-size:38px;line-height:1;color:var(--li);pointer-events:none;user-select:none}' +
    '.tit{font-family:"Bebas Neue";font-size:34px;letter-spacing:.02em;line-height:1.05;color:var(--t0);margin-bottom:6px}' +
    '.lead{font-size:14px;color:var(--t1);line-height:1.55;margin-bottom:4px}' +
    '.corpo table{display:block;overflow-x:auto;white-space:nowrap}' +
    'table{width:100%;border-collapse:collapse;font-size:14.5px}' +
    'th{text-align:left;color:var(--t2);font-size:11px;text-transform:uppercase;letter-spacing:.08em;padding:7px 8px;border-bottom:1px solid var(--mk);position:sticky;top:-14px;background:var(--b1)}' +
    'td{padding:11px 9px;border-bottom:1px solid var(--li);color:var(--t1);white-space:nowrap}' +
    'td.nome{white-space:normal;min-width:160px;color:var(--t0)}' +
    'tr:hover td{background:var(--b2)}' +
    '.num{text-align:right;font-variant-numeric:tabular-nums}' +
    '.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:9px;margin-bottom:20px}' +
    '.kpi{background:var(--b2);border:1px solid var(--li);border-radius:13px;padding:15px 13px}' +
    '.kpi .v{font-family:"Bebas Neue";font-size:38px;line-height:1;color:var(--mk)}' +
    '.kpi .l{font-family:"Space Mono";font-size:9.5px;color:var(--t2);margin-top:6px;text-transform:uppercase;letter-spacing:.07em;line-height:1.35}' +
    '.vazio{color:var(--t2);font-size:15.5px;line-height:1.6;padding:30px 10px;text-align:center}' +
    '.selo{display:inline-block;font-size:9px;letter-spacing:.08em;text-transform:uppercase;border:1px solid var(--li);border-radius:99px;padding:2px 8px;color:var(--t2);margin-left:8px}' +
    '.selo.ok{border-color:var(--vd);color:var(--vd)}' +
    '.selo.off{border-color:var(--rd);color:var(--rd)}' +
    '.dica{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;border:1px solid var(--li2);background:var(--b2);color:var(--t2);font-family:"Space Mono";font-size:10px;cursor:pointer;padding:0;margin-left:5px;vertical-align:middle;line-height:1}' +
    '.dica:hover{border-color:var(--mk);color:var(--mk)}' +
    '.expl{display:none;padding:12px 15px;border-top:1px solid var(--li);background:var(--b2);font-size:13.5px;color:var(--t1);line-height:1.55}' +
    '.expl.on{display:block}' +
    '.expl b{color:var(--t0)}' +
    '.expl .x{float:right;background:none;border:none;color:var(--t2);cursor:pointer;font-size:15px;line-height:1;padding:0 0 0 10px}' +
    '.nota{font-size:14px;color:var(--t2);margin:12px 0;line-height:1.6}' +
    '.bloco-d{background:var(--b2);border:1px solid var(--li);border-radius:9px;padding:10px 12px;margin-bottom:9px}' +
    '.bloco-d .td{font-family:"Space Mono";font-size:11px;letter-spacing:.06em;color:var(--mk);margin-bottom:7px}' +
    '.bloco-d .ld{font-size:13.5px;color:var(--t1);line-height:1.65;padding:2px 0}' +
    '.bloco-d .ld b{color:var(--t0)}' +
    '.bloco-d .vazio-d{color:var(--t3);font-style:italic;font-size:12.5px}' +
    '.tag-ads{color:var(--mk)}.tag-conta{color:var(--px)}.tag-cadastro{color:var(--vd)}.tag-marketing{color:var(--am)}.tag-outra{color:var(--t2)}.tag-afiliados{color:#e91e8c}.tag-performance{color:#3ab7f5}' +
    '</style>' +
    '<button class="botao" id="sia-abrir" title="Seller.IA">' + LOGO + '</button>' +
    '<div class="painel" id="sia-painel">' +
    '  <div class="cab">' + LOGO +
    '    <span class="titulo">SELLER<em>.IA</em></span>' +
    '    <span class="info" id="sia-info"></span>' +
    '    <div class="acoes">' +
    '      <button id="sia-tema" title="Alternar claro e escuro">tema</button>' +
    '      <button id="sia-exportar" title="Exportar coleta">exportar</button>' +
    '      <button id="sia-limpar" title="Limpar coleta">limpar</button>' +
    '      <button id="sia-fechar" title="Fechar">\u2715</button>' +
    '    </div>' +
    '  </div>' +
    '  <div class="abas" id="sia-abas"></div>' +
    '  <div class="corpo" id="sia-corpo"></div>' +
    '  <div class="expl" id="sia-expl"></div>' +
    '</div>';

  var $ = function (id) { return raiz.getElementById(id); };
  var abaAtiva = 'semaforo';
  // Uma aba por PERGUNTA que o analista faz, na ordem em que ele pergunta.
  // 'Ferramentas' saiu: era caixa sem dono. A Margem virou parte do Cofre,
  // que e onde ela e usada, e Performance ganhou tela propria porque e
  // leitura de FUNIL, nao de Ads — estava enterrada dentro de Produtos.
  var ABAS = [
    { id: 'semaforo', rotulo: 'Inicio' },
    { id: 'conta360', rotulo: 'Conta 360' },
    { id: 'performance', rotulo: 'Funil de Produto' },
    { id: 'gprod', rotulo: 'Shopee Ads' },
    { id: 'espiao', rotulo: 'Espiao' },
    { id: 'cofre', rotulo: 'Cofre' },
    { id: 'relatorio', rotulo: 'Relatorio' },
    { id: 'diagnostico', rotulo: 'Especialista' },
    { id: 'debug', rotulo: 'Debug', tecnica: true }
  ];
  // grupos: uma aba de cima abre varias telas por dentro
  var SUB = {
    cofre: [
      { id: 'cofre', rotulo: 'Custos por produto' },
      { id: 'calc', rotulo: 'Calculadora de margem' }
    ],
    gprod: [
      { id: 'campanhas', rotulo: 'Campanhas' }
    ]
  };
  var subAtiva = { cofre: 'cofre', gprod: 'campanhas' };
  function grupoDe(id) {
    for (var g in SUB) for (var i = 0; i < SUB[g].length; i++) if (SUB[g][i].id === id) return g;
    return null;
  }
  function subsDe(grupo) {
    var lista = SUB[grupo].slice();
    // Anuncio so faz sentido (e so tem dado) dentro da pagina publica do produto
    if (grupo === 'gprod' && estado.modoPagina === 'publico') lista.push({ id: 'cadastro', rotulo: 'Anuncio' });
    return lista;
  }
  function renderSubAbas(grupo) {
    var subs = subsDe(grupo);
    var h = '<div class="subabas">';
    for (var i = 0; i < subs.length; i++) {
      var s = subs[i];
      h += '<button class="subaba' + (s.id === subAtiva[grupo] ? ' ativa' : '') + '" data-sub="' + grupo + ':' + s.id + '">' + s.rotulo + '</button>';
    }
    return h + '</div>';
  }

  $('sia-abrir').addEventListener('click', function () { $('sia-painel').classList.toggle('aberto'); render(); });
  $('sia-abrir').addEventListener('dblclick', function (ev) {
    ev.preventDefault(); estado.modoTecnico = !estado.modoTecnico; render();
  });
  $('sia-corpo').addEventListener('click', function (ev) {
    var el = ev.target;
    while (el && el !== this) {
      if (el.getAttribute) {
        if (el.id === 'sia-fila-mais') { estado.filaCompleta = true; render(); return; }
        var tr = el.getAttribute && el.getAttribute('data-trocar');
        if (tr) {
          var novo = prompt('Qual termo o Radar deve buscar para este produto?\n\n' + tr.slice(0, 70), '');
          if (novo && novo.trim()) {
            abaAtiva = 'espiao';
            estado.espiao.meuProduto = { nome: tr };
            estado.espiao.termo = novo.trim(); estado.espiao.buscando = true; estado.espiao.volumes = null; render();
            espBuscar(novo.trim(), function (resp) {
              estado.espiao.buscando = false;
              if (!resp || !resp.ok) { estado.espiao.erro = (resp && resp.erro) || 'Falhou.'; estado.espiao.res = null; }
              else { var l2 = espMapear(resp.itens); estado.espiao.res = { termo: resp.termo, lista: l2, barreira: espBarreira(l2) }; }
              render();
            });
          }
          return;
        }
        var esp = el.getAttribute && el.getAttribute('data-espiar');
        if (esp) {
          abaAtiva = 'espiao';
          var prodOrigem = el.getAttribute('data-prod') || null;
          estado.espiao.meuProduto = prodOrigem ? { nome: prodOrigem } : null;
          estado.espiao.termo = esp; estado.espiao.buscando = true; estado.espiao.erro = null; estado.espiao.volumes = null; render();
          espBuscar(esp, function (resp) {
            estado.espiao.buscando = false;
            if (!resp || !resp.ok) { estado.espiao.erro = (resp && resp.erro) || 'Falhou.'; estado.espiao.res = null; }
            else {
              var lst = espMapear(resp.itens);
              estado.espiao.res = { termo: resp.termo, lista: lst, barreira: espBarreira(lst) };
            }
            render();
          });
          return;
        }
        var sb = el.getAttribute && el.getAttribute('data-sub');
        if (sb) { var pr = sb.split(':'); subAtiva[pr[0]] = pr[1]; abaAtiva = pr[1]; render(); return; }
        if (el.id === 'sia-vinc-ok') {
          var sel = $('sia-vinc');
          if (sel) { salvarVinculo(el.getAttribute('data-camp'), sel.value); render(); }
          return;
        }
        if (el.getAttribute('data-voltar')) { abaAtiva = (estado.cardVoltaPara && TELAS_VALIDAS.indexOf(estado.cardVoltaPara) >= 0) ? estado.cardVoltaPara : 'campanhas'; render(); return; }
        var d = el.getAttribute('data-card');
        if (d) { var p = d.split(':'); estado.cardVoltaPara = abaAtiva; abrirCard(p[0], p.slice(1).join(':')); return; }
      }
      el = el.parentNode;
    }
  });
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
      if (a.tecnica && !estado.modoTecnico) continue;
      var ativo = (a.id === abaAtiva) || (SUB[a.id] && grupoDe(abaAtiva) === a.id) || (a.id === 'gprod' && abaAtiva === 'card');
      h += '<button class="aba' + (ativo ? ' ativa' : '') + '" data-aba="' + a.id + '">' + a.rotulo + '</button>';
    }
    $('sia-abas').innerHTML = h;
    var botoes = $('sia-abas').querySelectorAll('.aba');
    for (var b = 0; b < botoes.length; b++) {
      botoes[b].addEventListener('click', function () {
        var alvo = this.getAttribute('data-aba');
        abaAtiva = SUB[alvo] ? (subAtiva[alvo] || SUB[alvo][0].id) : alvo;
        render();
      });
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
        var cor = pct >= 0 ? 'var(--vd)' : 'var(--rd)';
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
  // Tinta transparente sobre a superficie do tema, nunca cor solida:
  // #2a0f0f era vermelho-escuro fixo — ilegivel no escuro e desastroso no claro.
  var CORES_SEM = {
    vermelho: { bg: 'color-mix(in srgb, var(--rd) 9%, var(--b2))', bd: 'color-mix(in srgb, var(--rd) 32%, var(--li))', dot: 'var(--rd)', nome: 'Sangrando' },
    amarelo: { bg: 'color-mix(in srgb, var(--am) 9%, var(--b2))', bd: 'color-mix(in srgb, var(--am) 32%, var(--li))', dot: 'var(--am)', nome: 'Sufocada' },
    verde: { bg: 'color-mix(in srgb, var(--vd) 9%, var(--b2))', bd: 'color-mix(in srgb, var(--vd) 32%, var(--li))', dot: 'var(--vd)', nome: 'Escalando' },
    cinza: { bg: 'var(--b2)', bd: 'var(--li)', dot: 'var(--t3)', nome: 'Aprendendo' }
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
        '<div style="font-size:14px;color:var(--t0);font-weight:600;margin-bottom:6px">Nenhuma campanha lida ainda</div>' +
        '<div class="nota" style="max-width:340px;margin:0 auto">Abra a pagina de <b>Anuncios</b> no Seller Central e navegue pelas campanhas. Conforme a Shopee carrega os dados, o semaforo se enche sozinho.</div></div>';
    }

    var R = window.SIA_Triagem.triar(cofre, { margemPct: 0.25 });

    // ---- A LEITURA: uma frase que responde "o que eu faco agora" ----
    var gastoRuim = 0, iF;
    for (iF = 0; iF < R.fila.length; iF++) if (R.fila[iF].nivel === 'vermelho') gastoRuim += (R.fila[iF].gasto || 0);
    var temCofre = Object.keys((estado.cofre && estado.cofre.custos) || {}).length > 0;

    var frase, expl;
    if (R.contagem.vermelho > 0) {
      frase = 'Voce tem <span class="d">' + R.contagem.vermelho + ' campanha' + (R.contagem.vermelho > 1 ? 's' : '') + ' devolvendo menos do que custa</span>.';
      expl = 'Somadas, elas consumiram ' + reais(gastoRuim) + ' no periodo. Enquanto o retorno estiver abaixo do seu piso, cada venda que elas trazem sai no prejuizo.';
    } else if (R.contagem.amarelo > 0) {
      frase = 'Nenhuma campanha no prejuizo, mas <span class="w">' + R.contagem.amarelo + (R.contagem.amarelo > 1 ? ' estao sufocadas' : ' esta sufocada') + '</span>.';
      expl = 'Elas entregam acima do piso, porem com meta apertada demais para ganhar volume. E onde esta o crescimento mais barato da conta.';
    } else if (R.contagem.verde > 0) {
      frase = '<span class="u">Nenhuma campanha abaixo do seu piso</span>.';
      expl = R.contagem.verde + (R.contagem.verde > 1 ? ' campanhas estao' : ' campanha esta') + ' com folga para escalar. A conta esta saudavel para receber mais investimento.';
    } else {
      frase = 'Todas as campanhas ainda estao aprendendo.';
      expl = 'Mexer antes do fim do aprendizado reinicia a contagem do algoritmo. O melhor a fazer agora e nao fazer nada.';
    }

    var h = '<div class="leitura"><div class="fr">' + frase + '</div><div class="ex">' + expl + '</div></div>';

    h += '<div class="tres">' +
      '<div><div class="v" style="color:var(--rd)">' + R.contagem.vermelho + '</div><div class="l">NO PREJUIZO</div><div class="s">' + reais(gastoRuim) + '</div></div>' +
      '<div><div class="v" style="color:var(--am)">' + R.contagem.amarelo + '</div><div class="l">SUFOCADAS</div><div class="s">meta apertada</div></div>' +
      '<div><div class="v" style="color:var(--vd)">' + R.contagem.verde + '</div><div class="l">ESCALANDO</div><div class="s">com folga</div></div></div>';

    h += '<div class="nota" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px">' +
      seloFonte() +
      '<span>' + R.total + ' campanhas &middot; ' + reais(R.gastoTotal) + '</span>' +
      (temCofre ? '' : '<span style="color:var(--am)">margem assumida 25%</span>') +
      dica('<b>De onde vem esta leitura.</b> Foram lidas ' + R.total + ' campanhas, com ' + reais(R.gastoTotal) + ' investidos no periodo. ' +
        R.contagem.cinza + ' estao em aprendizado e ficam fora da fila de proposito: campanha nova precisa de 7 dias em Meta de ROAS ou 14 em Lance Automatico para o algoritmo entender o publico, e mexer antes reinicia a contagem. ' +
        (temCofre ? 'O piso de ROAS usa a margem real do seu Cofre de Custos.'
                  : '<b>O piso de 4x esta assumindo margem de 25%</b>, porque o Cofre de Custos esta vazio. Cadastre o custo dos produtos e o piso vira o seu numero real.')) +
      '</div>';

    // fila de acao
    if (R.fila.length === 0) {
      h += '<div style="background:#0f2a17;border:1px solid #1f5a30;border-radius:10px;padding:16px;text-align:center;color:var(--vd);font-size:13px">Tudo sob controle. Nenhuma campanha pedindo acao agora.</div>';
    } else {
      h += olho('O QUE FAZER PRIMEIRO', 'A fila ordena por dinheiro em jogo, nao por gravidade. Um problema numa campanha que gasta R$ 800 vem antes de um problema em campanha que gasta R$ 8 — mesmo que a segunda esteja mais quebrada. Clique em qualquer linha para abrir o card completo.');
      var LIMITE = 5;
      var mostrar = estado.filaCompleta ? R.fila : R.fila.slice(0, LIMITE);
      mostrar.forEach(function (c) {
        var co = CORES_SEM[c.nivel];
        h += '<div' + (c.id ? ' data-card="campanha:' + esc(c.id) + '" style="cursor:pointer;' : ' style="') + 'background:' + co.bg + ';border:1px solid ' + co.bd + ';border-left:3px solid ' + co.dot + ';border-radius:14px;padding:18px 19px;margin-bottom:12px;transition:border-color .15s">';
        h += '<div style="display:flex;align-items:baseline;gap:9px;margin-bottom:6px">' +
          '<span style="flex:1;font-size:17px;font-weight:600;color:var(--t0);line-height:1.3;letter-spacing:-.015em">' + esc(c.titulo) + '</span>' +
          '<span style="font-family:Space Mono,monospace;font-size:12px;color:var(--t2);flex:none">R$ ' + c.gasto.toFixed(2).replace('.', ',') + '</span></div>';
        if (c.campanha) h += '<div style="font-size:12.5px;color:var(--t2);margin-bottom:7px;line-height:1.4">' + esc(c.campanha) +
          '<span style="font-family:Space Mono,monospace;color:var(--t3)">' + (c.roas ? '  ROAS ' + c.roas.toFixed(1) + 'x' : '') + (c.posicao ? '  pos ' + c.posicao : '') + '</span></div>';
        h += '<div style="font-size:14.5px;color:var(--t1);line-height:1.6">' + esc(c.texto) + '</div>';
        h += '</div>';
      });
    }
    return h;
  }

  // liga o botao "Coletar conta agora" (coletor em lote)
  var coletaEmAndamento = false;
  var coletaJaTentada = false;
  var coletouNestaSessao = false;
  function ligarBotaoColeta() {
    var btn = $('sia-btn-coletar');
    if (!btn) return;
    var status = $('sia-lote-status');
    btn.addEventListener('click', function () { coletaJaTentada = true; dispararColeta(); });

    // se ja esta coletando, mostra isso
    if (coletaEmAndamento || estado.coletaProgresso) {
      if (status) { status.textContent = estado.coletaProgresso || 'coletando…'; status.style.color = 'var(--t2)'; }
      return;
    }
    // ja temos tudo do periodo? avisa que esta pronto (com opcao de recoletar)
    var completo = false;
    try {
      var D = window.SIA_Diamantes ? window.SIA_Diamantes.resumo() : null;
      var temPeriodo = D && D.gerenciais && D.gerenciais.fonte === 'periodo';
      var temResto = D && D.funil && D.afiliados;
      completo = temPeriodo && temResto;
    } catch (e) { }
    if (completo && coletouNestaSessao) {
      if (status) { status.textContent = 'conta lida agora. Toque pra atualizar.'; status.style.color = 'var(--vd)'; }
      if (btn) btn.textContent = 'Coletar de novo';
      return;
    }
    // se tem cache (completo) mas nao coletou nesta sessao, ainda dispara
    // pra trazer o Ads/semaforo/campanhas (que o cache pode nao ter).
    // nao esta completo OU cache velho: dispara. Se a chave existe, ja; senao espera aparecer.
    if (coletaJaTentada && !completo) {
      if (status) { status.textContent = 'toque em Coletar pra tentar de novo.'; status.style.color = 'var(--am)'; }
      return;
    }
    if (coletaJaTentada) return;
    if (estado.spc) {
      coletaJaTentada = true;
      if (status) { status.textContent = 'iniciando coleta…'; status.style.color = 'var(--t2)'; }
      setTimeout(dispararColeta, 400);
    } else {
      if (status) { status.textContent = 'preparando… (abra o Seller Central e aguarde)'; status.style.color = 'var(--t2)'; }
      var espera = 0;
      var vigia = setInterval(function () {
        espera++;
        if (coletaJaTentada || espera > 30) { clearInterval(vigia); if (!coletaJaTentada && status) { status.textContent = 'toque em Coletar pra buscar agora.'; status.style.color = 'var(--am)'; } return; }
        if (estado.spc) {
          clearInterval(vigia);
          coletaJaTentada = true;
          if (status) { status.textContent = 'iniciando coleta…'; status.style.color = 'var(--t2)'; }
          dispararColeta();
        }
      }, 1000);
    }
  }

  function dispararColeta() {
    if (coletaEmAndamento || estado.coletaProgresso) return;
    if (!estado.spc) {
      var st0 = $('sia-lote-status');
      if (st0) { st0.textContent = 'Abra a Central de Dados uma vez pra capturar a sessao, e volte aqui.'; st0.style.color = 'var(--am)'; }
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
    if (barra) { barra.style.width = '15%'; barra.style.background = 'linear-gradient(90deg,var(--mk),var(--px))'; }
    if (status) { status.style.color = 'var(--t2)'; status.textContent = 'iniciando…'; }

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
        if (status) { status.textContent = (res && res.erro) || 'nao foi possivel coletar'; status.style.color = 'var(--rd)'; }
        if (barra) barra.style.background = 'var(--rd)';
        return;
      }
      if (barra) barra.style.width = '100%';
      if (status) { status.style.color = 'var(--vd)'; status.textContent = 'pronto! conta lida.'; }
      coletouNestaSessao = true;
      // persiste e re-renderiza pra mostrar os blocos cheios
      try { if (window.SIA_Diamantes && window.SIA_Diamantes.persistir) window.SIA_Diamantes.persistir(); } catch (e) { }
      setTimeout(function () { if (abaAtiva === 'conta360') render(); }, 700);
    });
  }

  // ==========================================================
  // CALCULADORA DE MARGEM REAL — custo + taxas Shopee + ads
  // ==========================================================
  function renderCalculadora() {
    var i = 'width:100%;box-sizing:border-box;background:var(--b1);border:1px solid #242630;border-radius:8px;padding:9px 11px;color:var(--t0);font-size:13px;margin-top:4px';
    var lbl = 'font-size:11px;color:var(--t2);font-weight:600';
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
    h += '<div class="ld" style="font-size:11px;color:var(--t2);margin-top:5px">Se preencher, cruzamos com o ROAS minimo pra ver se ta no lucro.</div>';
    h += '</div>';

    h += '<button id="calc-btn" style="all:unset;cursor:pointer;display:block;text-align:center;background:linear-gradient(135deg,var(--mk),var(--px));color:var(--t0);font-weight:700;font-size:13px;padding:11px;border-radius:9px;margin:4px 0 12px">Calcular margem real</button>';

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
      if (!m) { if (alvo) alvo.innerHTML = '<div class="nota" style="color:var(--rd)">Preencha ao menos o preco de venda.</div>'; return; }
      alvo.innerHTML = montarResultadoCalc(m, ent.adsReais);
    });
  }

  function montarResultadoCalc(m, adsInput) {
    function fr(v) { return 'R$ ' + Number(v).toFixed(2).replace('.', ','); }
    var corLucro = m.noLucro ? 'var(--vd)' : 'var(--rd)';
    var h = '<div class="bloco-d" style="border-color:' + (m.noLucro ? '#1f5a30' : '#5a1f1f') + '">';
    h += '<div class="td">RESULTADO · ' + esc(m.faixa) + '</div>';
    // cascata de custos
    h += '<div class="ld">Preco de venda: <b>' + fr(m.preco) + '</b></div>';
    h += '<div class="ld" style="color:var(--t2)">− Custo produto: ' + fr(m.custoProduto) + (m.outros ? ' · outros ' + fr(m.outros) : '') + '</div>';
    h += '<div class="ld" style="color:var(--t2)">− Comissao Shopee (' + m.comissao.pct + '%): ' + fr(m.comissao.reais) + ' + taxa fixa ' + fr(m.taxaFixa) + '</div>';
    if (m.imposto.reais > 0) h += '<div class="ld" style="color:var(--t2)">− Imposto (' + m.imposto.pct + '%): ' + fr(m.imposto.reais) + '</div>';
    if (m.ads > 0) h += '<div class="ld" style="color:var(--t2)">− Ads por venda: ' + fr(m.ads) + '</div>';
    h += '<div style="border-top:1px solid #242630;margin:8px 0 6px"></div>';
    h += '<div class="ld" style="font-size:15px">Lucro por venda: <b style="color:' + corLucro + '">' + fr(m.lucro) + '</b> <span style="color:var(--t2);font-size:12px">(margem ' + m.margemPct + '%)</span></div>';
    if (!m.noLucro) h += '<div class="ld" style="color:var(--rd);font-size:11px;margin-top:4px">Atencao: este produto esta no PREJUIZO com esses numeros.</div>';
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
        var cor = { verde: 'var(--vd)', amarelo: 'var(--am)', vermelho: 'var(--rd)', cinza: 'var(--t2)' }[cruz.nivel];
        h += '<div class="ld" style="color:' + cor + ';font-size:11.5px;margin-top:3px">' + esc(cruz.texto) + '</div>';
      } else {
        h += '<div class="ld" style="color:var(--t2);font-size:11px;margin-top:3px">Rode a coleta pra cruzar com seu ROAS real da conta.</div>';
      }
    }
    h += '</div>';
    return h;
  }

  // ==========================================================
  // CONTA 360 — as 6 inteligencias do cerebro geral (visual)
  // So MOSTRA o que a coleta capturou. A analise vem depois.
  // ==========================================================
  /* ============ FUNIL DA LOJA ============
     Quatro degraus, com a queda de cada um e o pior nomeado. Nada de
     metafora: dizer quantas pessoas passaram e quantas ficaram. */
  function valCampo(id) {
    var c = (estado.conta && estado.conta.campos) || {};
    var v = c[id];
    if (v && typeof v === 'object') v = v.valor !== undefined ? v.valor : v.v;
    var n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[^0-9,.-]/g, '').replace(/\./g, '').replace(',', '.'));
    return isFinite(n) ? n : null;
  }
  function renderFunilLoja() {
    var uv = valCampo('uv');
    var atc = valCampo('atc');
    var ped = valCampo('pedidos');
    if (ped == null) ped = valCampo('ped');
    if (ped == null) ped = valCampo('pedidos_pagos');
    var buscas = valCampo('buscas') != null ? valCampo('buscas') : valCampo('cliques_prod');
    var impr = valCampo('impr');
    var etapas = [
      { r: 'IMPRESSOES', v: impr, ex: 'Quantas vezes seus produtos apareceram.' },
      { r: 'CLIQUES NA BUSCA', v: buscas, ex: 'Pessoas que clicaram no seu card dentro da busca da Shopee.' },
      { r: 'VISITANTES', v: uv, ex: 'Pessoas diferentes que abriram alguma pagina de produto seu.' },
      { r: 'ADICIONARAM AO CARRINHO', v: atc, ex: 'Quantas guardaram algum produto no carrinho.' },
      { r: 'PEDIDOS PAGOS', v: ped, ex: 'Quantas fecharam e pagaram.' }
    ].filter(function (e) { return e.v != null; });
    if (etapas.length < 2) return '';

    var quedas = [], i;
    for (i = 1; i < etapas.length; i++) {
      var ant = etapas[i - 1].v, at = etapas[i].v;
      quedas.push({ de: etapas[i - 1].r, para: etapas[i].r, pct: ant ? (1 - at / ant) * 100 : null, i: i });
    }
    var pior = null;
    for (i = 0; i < quedas.length; i++) if (quedas[i].pct != null && (!pior || quedas[i].pct > pior.pct)) pior = quedas[i];

    var h = olho('O CAMINHO ATE A VENDA', '<b>O funil da loja inteira.</b> Cada degrau mostra quantas pessoas passaram para a etapa seguinte. A queda entre dois degraus e onde voce perde gente. O degrau com a maior queda e onde vale colocar esforco primeiro — melhorar um degrau que ja esta bom rende pouco.');
    h += '<div style="background:var(--b2);border:1px solid var(--li);border-radius:12px;padding:14px 10px;display:flex;align-items:flex-end;gap:3px;margin-bottom:11px">';
    for (i = 0; i < etapas.length; i++) {
      if (i > 0) {
        var q = quedas[i - 1];
        var ruim = pior && q.i === pior.i;
        h += '<div style="flex:none;text-align:center;font-family:Space Mono,monospace;font-size:9px;color:' + (ruim ? 'var(--rd)' : 'var(--t2)') + ';padding-bottom:16px">\u203a<br>' + (q.pct != null ? '\u2212' + fmt(q.pct, 0) + '%' : '') + '</div>';
      }
      h += '<div style="flex:1;text-align:center"><div style="font-family:Bebas Neue,sans-serif;font-size:22px;line-height:1;color:var(--t0)">' + fmt(etapas[i].v, 0) + '</div>' +
        '<div style="font-family:Space Mono,monospace;font-size:7.5px;color:var(--t2);margin-top:3px;line-height:1.3">' + etapas[i].r + '</div></div>';
    }
    h += '</div>';

    if (pior) {
      var deTxt = pior.de.toLowerCase(), paraTxt = pior.para.toLowerCase();
      var idx = pior.i;
      var quantosAntes = etapas[idx - 1].v, quantosDepois = etapas[idx].v;
      var conselho = '';
      if (paraTxt.indexOf('visitantes') >= 0) conselho = 'Quem ve o card nao entra. O que decide isso e a primeira foto, o preco no card e o comeco do titulo.';
      else if (paraTxt.indexOf('carrinho') >= 0) conselho = 'Quem entra na pagina nao se convence. Preco contra o concorrente, variacao sem estoque e avaliacoes sem resposta sao as causas mais comuns.';
      else conselho = 'Quem guardou no carrinho nao fechou. Frete, prazo de entrega e o preco final na hora de pagar sao o que costuma travar.';
      h += '<div style="background:var(--b2);border-left:3px solid var(--rd);border-radius:0 10px 10px 0;padding:12px 14px;font-size:13.5px;color:var(--t1);line-height:1.55">' +
        '<b style="color:var(--t0)">A maior perda esta aqui:</b> de ' + fmt(quantosAntes, 0) + ' que chegaram em ' + deTxt + ', ' + fmt(quantosDepois, 0) + ' seguiram para ' + paraTxt + '. ' +
        '<span style="color:var(--rd)">Perde ' + fmt(pior.pct, 0) + '% neste degrau.</span><br>' + conselho + '</div>';
    }
    return h;
  }

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
      var cor = v === 0 ? 'var(--t2)' : (bom ? 'var(--vd)' : 'var(--rd)');
      var seta = v > 0 ? '\u25b2' : (v < 0 ? '\u25bc' : '');
      return ' <span style="color:' + cor + ';font-size:10px">' + seta + ' ' + Math.abs(v).toFixed(0) + '%</span>';
    }
    function tend(t) {
      if (!t) return '';
      var m = { subindo: ['var(--vd)', 'subindo'], caindo: ['var(--rd)', 'caindo'], estavel: ['var(--t2)', 'estavel'] }[t.direcao] || ['var(--t2)', t.direcao];
      return '<span style="color:' + m[0] + ';font-size:10px"> · ' + m[1] + '</span>';
    }
    function bloco(titulo, conteudo, vazio) {
      return '<div class="bloco-d"><div class="td">' + titulo + '</div>' + (conteudo || ('<div class="ld vazio-d">' + vazio + '</div>')) + '</div>';
    }

    var h = '<div style="padding:2px">';
    // ---- COLETA AUTOMATICA (coletor em lote) ----
    h += '<div id="sia-lote-box" style="background:var(--b2);border:1px solid var(--li);border-radius:10px;padding:12px;margin-bottom:12px">';
    h += '<div style="display:flex;align-items:center;gap:8px">';
    h += '<button id="sia-btn-coletar" style="all:unset;cursor:pointer;background:linear-gradient(135deg,var(--mk),var(--px));color:var(--t0);font-weight:700;font-size:12.5px;padding:9px 14px;border-radius:8px;text-align:center">Coletar conta agora</button>';
    h += '<div id="sia-lote-status" style="font-size:11px;color:var(--t2);flex:1">Clique para a extensao buscar tudo sozinha</div>';
    h += '</div>';
    h += '<div id="sia-lote-barra-bg" style="display:none;height:6px;background:var(--li);border-radius:3px;margin-top:10px;overflow:hidden"><div id="sia-lote-barra" style="height:100%;width:0%;background:linear-gradient(90deg,var(--mk),var(--px));transition:width .3s"></div></div>';
    // diagnostico: mostra se a sessao (chave) foi capturada
    var temChave = !!estado.spc;
    h += '<div style="font-size:10px;margin-top:8px;color:' + (temChave ? 'var(--vd)' : 'var(--am)') + '">' +
      (temChave ? '\u25cf sessao capturada — pronto pra coletar' : '\u25cb sessao ainda nao capturada — abra/recarregue o Seller Central') + '</div>';
    h += '</div>';
    h += '<div class="nota" style="margin:0 0 12px">Retrato da conta lido direto da Shopee. Use o botao acima ou navegue pelas telas.</div>';

    // ---- 1) GERENCIAIS ----
    var g = D.gerenciais, cg = '';
    if (g && (g.gmvPago || g.pv)) {
      // avisa a origem do dado: dia (navegacao passiva) ou periodo (coleta/central)
      if (g.fonte === 'dia') cg += '<div class="ld" style="color:var(--am);font-size:11px;margin-bottom:4px">\u26a0 Dados de HOJE. Clique em "Coletar" ou abra a Central pro mes completo.</div>';
      else if (g.fonte === 'periodo') cg += '<div class="ld" style="color:var(--vd);font-size:11px;margin-bottom:4px">Dados do periodo (mes)</div>';
      if (g.gmvPago) cg += '<div class="ld">GMV pago: <b>' + fmtR(g.gmvPago.valor) + '</b>' + varia(g.gmvPago.variacao) + '</div>';
      if (g.pedidosPagos) cg += '<div class="ld">Pedidos: <b>' + fmtN(g.pedidosPagos.valor) + '</b>' + varia(g.pedidosPagos.variacao) + (g.ticketMedio ? ' · ticket <b>' + fmtR(g.ticketMedio) + '</b>' : '') + '</div>';
      if (g.visitantes) cg += '<div class="ld">Visitantes: <b>' + fmtN(g.visitantes.valor) + '</b>' + varia(g.visitantes.variacao) + (g.conversaoLoja != null ? ' · conversao <b>' + g.conversaoLoja + '%</b>' : '') + '</div>';
      if (g.pv && g.uv) cg += '<div class="ld" style="color:var(--t2);font-size:11px">PV ' + fmtN(g.pv.valor) + ' · UV ' + fmtN(g.uv.valor) + '</div>';
    }
    h += bloco('1 · VISAO GERENCIAL', cg, 'abra a Central de Dados (Painel) para capturar');

    // ---- saude (cancelamentos/reembolsos) ----
    if (g && g.saude) {
      var s = g.saude, cs = '';
      if (s.reembolsos) cs += '<div class="ld">Reembolsos: <b>' + fmtR(s.reembolsos.valor) + '</b>' + varia(s.reembolsos.variacao, true) + '</div>';
      if (s.vendasCanceladas) cs += '<div class="ld">Cancelamentos: <b>' + fmtR(s.vendasCanceladas.valor) + '</b>' + varia(s.vendasCanceladas.variacao, true) + '</div>';
      if (s.pedidosDevolvidos) cs += '<div class="ld" style="color:var(--t2);font-size:11px">' + fmtN(s.pedidosDevolvidos.valor) + ' devolucoes · ' + fmtN(s.pedidosCancelados ? s.pedidosCancelados.valor : 0) + ' cancelados</div>';
      if (cs) h += bloco('SAUDE DAS VENDAS', cs, '');
    }

    // ---- 2) FUNIL ----
    var f = D.funil, cf = '';
    if (f && f.canais) {
      var ordem = ['card', 'ads', 'afiliado', 'live', 'video'];
      var nomes = { card: 'Vitrine (card)', ads: 'Anuncios', afiliado: 'Afiliados', live: 'Live', video: 'Video' };
      ordem.forEach(function (k) {
        var ca = f.canais[k];
        if (ca && ca.valor > 0) cf += '<div class="ld">' + nomes[k] + ': <b>' + (ca.ratio != null ? ca.ratio.toFixed(1) + '%' : '—') + '</b> <span style="color:var(--t2);font-size:11px">(' + fmtR(ca.valor) + ')</span>' + varia(ca.variacao) + '</div>';
      });
      if (f.naoUsa && f.naoUsa.length) cf += '<div class="ld" style="color:var(--am);font-size:11px">Nao usa: ' + f.naoUsa.join(', ') + ' — canais parados</div>';
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
        if (P.ctr >= 2 && P.convPago != null && P.convPago < 1) alerta = ' <span style="color:var(--am);font-size:10px">pagina segura</span>';
        else if (P.rejeicao != null && P.rejeicao > 45) alerta = ' <span style="color:var(--rd);font-size:10px">rejeicao alta</span>';
        cp += '<div class="ld" style="border-bottom:1px solid #15171d;padding-bottom:5px;margin-bottom:5px">' +
          '<b>' + esc(nome) + '</b>' + alerta + '<br>' +
          '<span style="color:var(--t2);font-size:11px">CTR ' + (P.ctr != null ? P.ctr.toFixed(1) : '—') + '% · conv ' + (P.convPago != null ? P.convPago.toFixed(1) : '—') + '% · rejeicao ' + (P.rejeicao != null ? P.rejeicao.toFixed(0) : '—') + '% · ' + fmtR(P.vendaPaga || P.venda) + (P.fatiaVendas != null ? ' · ' + P.fatiaVendas.toFixed(0) + '% da loja' : '') + '</span></div>';
      });
    }
    h += bloco('3 · PERFORMANCE DE PRODUTO', cp, 'abra Produtos na Central de Dados');

    // ---- 4) SAUDE / AVALIACOES ----
    var ca4 = '';
    // saude da conta (rating de performance + penalidade) — vem do accounthealth
    if (D.conta && D.conta.saudeConta) {
      var sc = D.conta.saudeConta;
      var corRating = sc.ratingPerformance === 'excellent' ? 'var(--vd)' : (sc.ratingPerformance === 'good' ? 'var(--am)' : 'var(--rd)');
      var traduz = { excellent: 'Excelente', good: 'Boa', improvement_needed: 'Precisa melhorar', poor: 'Ruim' };
      ca4 += '<div class="ld">Saude da conta: <b style="color:' + corRating + '">' + (traduz[sc.ratingPerformance] || sc.ratingPerformance) + '</b>';
      if (sc.pontosPenalidade != null) ca4 += ' · ' + sc.pontosPenalidade + ' pts penalidade';
      ca4 += '</div>';
    }
    if (E && E.porProduto) {
      var comAval = Object.keys(E.porProduto).filter(function (k) { return E.porProduto[k].avaliacoes; });
      var totBaixas = 0, totAval = 0;
      comAval.forEach(function (k) { totBaixas += E.porProduto[k].avaliacoes.baixas || 0; totAval += E.porProduto[k].avaliacoes.total || 0; });
      if (comAval.length) ca4 += '<div class="ld">' + comAval.length + ' produtos avaliados · <b>' + totAval + '</b> avaliacoes' + (totBaixas > 0 ? ' · <span style="color:var(--rd)">' + totBaixas + ' baixas (1-2\u2605)</span>' : ' · <span style="color:var(--vd)">nenhuma baixa</span>') + '</div>';
    }
    if (g && g.travasDetectadas && Object.keys(g.travasDetectadas).length) {
      var travasSet = {};
      Object.keys(g.travasDetectadas).forEach(function (l) { (g.travasDetectadas[l] || []).forEach(function (t) { travasSet[t] = 1; }); });
      var listaT = Object.keys(travasSet);
      if (listaT.length) ca4 += '<div class="ld" style="color:var(--am);font-size:11px">Travas de edicao detectadas: ' + listaT.slice(0, 4).join(', ') + '</div>';
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
      caf += '<div class="ld" style="color:var(--t2);font-size:11px;margin-top:4px">Top afiliados:</div>';
      af.top.slice(0, 3).forEach(function (t) {
        caf += '<div class="ld" style="font-size:11px">• ' + esc((t.nome || '').slice(0, 22)) + ' — ' + (t.roi != null ? t.roi.toFixed(1) + 'x' : '—') + ' · ' + fmtR(t.gmv) + (t.seguidores ? ' · ' + fmtN(t.seguidores) + ' seg' : '') + '</div>';
      });
    }
    if (af && af.creatorsDisponiveis) caf += '<div class="ld" style="color:var(--t2);font-size:11px;margin-top:3px">' + af.creatorsDisponiveis + ' creators disponiveis para recrutar</div>';
    h += bloco('5 · AFILIADOS', caf, 'abra o painel de Afiliados no Seller Central');

    // ---- 6) FINANCEIRO ----
    var fin = D.financeiro, cfin = '';
    if (fin && fin.componentes) {
      var comp = fin.componentes;
      cfin += '<div class="ld" style="color:var(--t2);font-size:11px">Taxas reais da Shopee (' + fin.amostras + ' pedido' + (fin.amostras > 1 ? 's' : '') + ' lido' + (fin.amostras > 1 ? 's' : '') + '):</div>';
      if (comp.COMMISSION_FEE != null) cfin += '<div class="ld">Comissao: <b>' + fmtR(Math.abs(comp.COMMISSION_FEE)) + '</b></div>';
      if (comp.SERVICE_FEE != null) cfin += '<div class="ld">Taxa de servico: <b>' + fmtR(Math.abs(comp.SERVICE_FEE)) + '</b></div>';
      if (comp.ESCROW_AMOUNT != null) cfin += '<div class="ld">Liquido recebido: <b style="color:var(--vd)">' + fmtR(comp.ESCROW_AMOUNT) + '</b></div>';
      cfin += '<div class="ld" style="color:var(--t2);font-size:11px;margin-top:3px">A Shopee ja entrega comissao e taxas. Falta so o custo do produto (Cofre de Custos).</div>';
    }
    h += bloco('6 · FINANCEIRO (margem real)', cfin, 'abra um pedido em Financeiro > Minha Renda');

    h += '</div>';
    return h;
  }

  /* ------------------------- ESPIAO DE BUSCA ------------------------- */
  /* Le a vitrine publica da Shopee como comprador. O faturamento estimado
     vem do "vendido/mes" que a propria Shopee exibe no card x preco. */
  var ESP_STOP = { 'kit': 1, 'un': 1, 'unidades': 1, 'pcs': 1, 'pecas': 1, 'com': 1, 'de': 1, 'da': 1, 'do': 1, 'para': 1, 'e': 1, 'o': 1, 'a': 1, 'em': 1, 'no': 1, 'na': 1, 'pro': 1, 'novo': 1, 'promocao': 1, 'frete': 1, 'gratis': 1 };

  function espTermo(nome) {
    var s = String(nome || '').toLowerCase();
    s = s.normalize ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : s;
    s = s.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    var out = [], p = s.split(' ');
    for (var i = 0; i < p.length && out.length < 3; i++) {
      if (p[i].length < 3 || ESP_STOP[p[i]] || /^\d+$/.test(p[i])) continue;
      out.push(p[i]);
    }
    return out.join(' ');
  }

  function espMapear(itens) {
    var meu = estado.loja ? String(estado.loja.shop_id) : null;
    var lista = [];
    for (var i = 0; i < itens.length; i++) {
      var it = itens[i] || {};
      var d = it.item_data || {};
      var asset = it.item_card_displayed_asset || {};
      var dp = d.item_card_display_price || {};
      var sc = d.item_card_display_sold_count || {};
      var rt = d.item_rating || {};
      var preco = dp.price != null ? Number(dp.price) / 100000 : null;
      var mes = sc.monthly_sold_count != null ? Number(sc.monthly_sold_count) : null;
      var voucher = d.recommended_shop_voucher_info || dp.recommended_shop_voucher_info || null;
      lista.push({
        pos: i + 1,
        nome: asset.name || '',
        shopid: d.shopid != null ? String(d.shopid) : null,
        link: (d.shopid != null && d.itemid != null)
          ? 'https://shopee.com.br/product/' + d.shopid + '/' + d.itemid : null,
        itemid: d.itemid != null ? String(d.itemid) : null,
        preco: preco,
        desconto: dp.discount != null ? Number(dp.discount) : null,
        vendasMes: mes,
        vendaTotal: sc.historical_sold_count != null ? Number(sc.historical_sold_count) : null,
        faturamentoMes: (mes != null && preco != null) ? Math.round(mes * preco) : null,
        nota: rt.rating_star != null ? Number(rt.rating_star) : null,
        avaliacoes: rt.rating_count && rt.rating_count.length ? Number(rt.rating_count[0]) : null,
        cupom: voucher ? (voucher.voucher_code || 'sim') : null,
        ads: !!it.adsid,
        eu: meu && String(d.shopid) === meu
      });
    }
    return lista;
  }

  /* ---- PALAVRAS QUE OS PRIMEIROS USAM E VOCE NAO ----
     Agora e comparacao de verdade: quebra o titulo de cada um dos primeiros
     colocados, quebra o seu, e devolve o que aparece neles e falta no seu.
     Antes eu mostrava a lista da rota de keywords sem confrontar com o
     titulo — parecia analise e nao era. */
  var ESP_IGNORA = { 'para': 1, 'com': 1, 'sem': 1, 'de': 1, 'da': 1, 'do': 1, 'das': 1, 'dos': 1, 'em': 1, 'no': 1, 'na': 1, 'e': 1, 'ou': 1, 'kit': 1, 'un': 1, 'pcs': 1, 'unidades': 1, 'novo': 1, 'promocao': 1, 'frete': 1, 'gratis': 1, 'envio': 1, 'rapido': 1, 'pronta': 1, 'entrega': 1, 'qualidade': 1, 'melhor': 1, 'top': 1 };
  function espPalavras(nome) {
    var s = String(nome || '').toLowerCase();
    s = s.normalize ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : s;
    s = s.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    var out = {}, p = s.split(' ');
    for (var i = 0; i < p.length; i++) {
      if (p[i].length < 3 || ESP_IGNORA[p[i]] || /^\d+$/.test(p[i])) continue;
      out[p[i]] = true;
    }
    return out;
  }
  /* ---- VOLUME DE BUSCA POR PALAVRA ----
     A rota de recomendacao de palavra devolve o volume mensal real. Nao
     serve para configurar lance (no oCPM nao existe lance de produto), mas
     responde a pergunta que importa: essa palavra que falta no meu titulo
     tem gente procurando? */
  function espVolume(termos, aoPronto) {
    if (!termos.length) { aoPronto({}); return; }
    // sem a chave de sessao a URL sairia com "undefined" e a rota recusaria
    if (!estado.spc) { aoPronto({}); return; }
    var corpo = JSON.stringify({ campaign_type: 'shop', keyword_list: termos.slice(0, 12), limit: 40 });
    chrome.runtime.sendMessage({
      tipo: 'sia:buscar',
      url: '/api/pas/v1/setup_helper/list_recommended_keyword/?SPC_CDS=' + estado.spc + '&SPC_CDS_VER=2',
      metodo: 'POST', corpo: corpo
    }, function (r) {
      void chrome.runtime.lastError;
      var mapa = {};
      try {
        var lista = (((r || {}).dados || {}).data || {}).keyword_list || [];
        for (var i = 0; i < lista.length; i++) {
          var k = lista[i];
          if (k && k.keyword != null && k.search_volume != null) mapa[String(k.keyword).toLowerCase()] = k.search_volume;
        }
      } catch (e) { /* noop */ }
      aoPronto(mapa);
    });
  }
  function espDiffPalavras(lista, nomeMeu) {
    var meus = {}, deles = {}, i, k;
    for (i = 0; i < lista.length; i++) {
      var pal = espPalavras(lista[i].nome);
      if (lista[i].eu) { for (k in pal) meus[k] = true; }
    }
    // Se eu nao apareco no top 60, ainda quero saber quais palavras eles usam
    // e faltam no MEU titulo. Antes o bloco simplesmente sumia — que era o
    // caso mais importante, porque nao aparecer e o pior cenario.
    if (!Object.keys(meus).length && nomeMeu) {
      var pm = espPalavras(nomeMeu);
      for (k in pm) meus[k] = true;
    }
    var top = lista.filter(function (x) { return !x.eu; }).slice(0, 5);
    for (i = 0; i < top.length; i++) {
      var pd = espPalavras(top[i].nome);
      for (k in pd) deles[k] = (deles[k] || 0) + 1;
    }
    var faltando = [];
    for (k in deles) {
      if (meus[k]) continue;
      if (deles[k] < 2) continue;              // so o que repete em 2+ dos primeiros
      faltando.push({ p: k, n: deles[k] });
    }
    faltando.sort(function (a, b) { return b.n - a.n; });
    return { faltando: faltando.slice(0, 8), temMeu: Object.keys(meus).length > 0 };
  }

  function espBarreira(lista) {
    var conc = [], i;
    for (i = 0; i < lista.length; i++) if (!lista[i].eu) conc.push(lista[i]);
    var top = conc.slice(0, 5);
    if (!top.length) return null;
    function media(campo) {
      var s = 0, n = 0;
      for (var k = 0; k < top.length; k++) if (top[k][campo] != null) { s += top[k][campo]; n++; }
      return n ? s / n : null;
    }
    var comCupom = 0;
    for (i = 0; i < top.length; i++) if (top[i].cupom) comCupom++;
    return {
      n: top.length, lider: top[0], top: top,
      preco: media('preco'), vendasMes: media('vendasMes'),
      faturamentoMes: media('faturamentoMes'), nota: media('nota'),
      avaliacoes: media('avaliacoes'), comCupom: comCupom
    };
  }

  function espBuscar(termo, aoTerminar) {
    try {
      chrome.runtime.sendMessage({ tipo: 'sia:busca-publica', termo: termo }, function (resp) {
        void chrome.runtime.lastError;
        aoTerminar(resp || { ok: false, erro: 'Sem resposta do Seller.IA.' });
      });
    } catch (e) { aoTerminar({ ok: false, erro: 'Extensao sem permissao para buscar.' }); }
  }

  function espMeusProdutos(limite) {
    var arr = [], id;
    for (id in estado.produtos) {
      var p = estado.produtos[id];
      if (!p || !p.nome) continue;
      // linhas que nao sao produto entram na lista de "produtos" da coleta
      // (credito de Ads, saldo, ajuste). Buscar isso na vitrine e ruido.
      if (/cr[eé]dito|saldo|recarga|ajuste|reembolso|taxa|cupom da loja/i.test(p.nome)) continue;
      if (!/[a-zA-Zà-ú]{4}/.test(p.nome)) continue;
      var m = p.metricas || {};
      arr.push({ id: id, nome: p.nome, gmv: m.gmv || 0 });
    }
    arr.sort(function (a, b) { return b.gmv - a.gmv; });
    return arr.slice(0, limite || 6);
  }

  function espRodarRadar() {
    var alvos = espMeusProdutos(6);
    if (!alvos.length) { estado.espiao.erro = 'Colete a conta primeiro — o radar usa os seus produtos que mais vendem.'; render(); return; }
    estado.espiao.radar = []; estado.espiao.radarRodando = 0; estado.espiao.radarTotal = alvos.length; estado.espiao.erro = null;
    render();
    (function proximo(i) {
      if (i >= alvos.length) { estado.espiao.radarRodando = null; render(); return; }
      estado.espiao.radarRodando = i + 1; render();
      var termo = espTermo(alvos[i].nome);
      espBuscar(termo, function (resp) {
        var linha = { produto: alvos[i].nome, termo: termo };
        if (resp && resp.ok) {
          var lista = espMapear(resp.itens);
          var b = espBarreira(lista);
          var meu = null;
          for (var k = 0; k < lista.length; k++) if (lista[k].eu) { meu = lista[k]; break; }
          linha.total = lista.length;
          linha.ads = lista.filter(function (x) { return x.ads; }).length;
          linha.barreira = b ? b.faturamentoMes : null;
          linha.meuFat = meu ? meu.faturamentoMes : null;
          linha.pos = meu ? meu.pos : null;
          linha.meuAds = meu ? meu.ads : null;
        } else { linha.erro = (resp && resp.erro) || 'falhou'; }
        estado.espiao.radar.push(linha);
        setTimeout(function () { proximo(i + 1); }, 1200); // respeita a Shopee
      });
    })(0);
  }

  function espDinheiro(v) {
    if (v == null) return '—';
    if (v >= 1000) return 'R$ ' + fmt(v / 1000, 1) + ' mil';
    return 'R$ ' + fmt(v, 0);
  }

  function renderEspiao() {
    if (!estado.espiao) estado.espiao = { termo: '', res: null, radar: null };
    var e = estado.espiao;
    var h = capa('COMO ESTOU CONTRA OS OUTROS', 'O', 'ESPIAO', '04');

    h += '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">' +
      '<input id="sia-esp-termo" value="' + esc(e.termo || '') + '" placeholder="digite o termo que o comprador pesquisa" ' +
      'style="flex:1;min-width:200px;background:var(--b2);border:1px solid var(--li);border-radius:8px;padding:10px 12px;color:var(--t0);font-size:13px">' +
      '<button id="sia-esp-ir" style="background:var(--mk);border:none;color:var(--t0);font-weight:700;font-size:13px;padding:10px 18px;border-radius:8px;cursor:pointer">' + (e.buscando ? 'Espiando...' : 'Espiar') + '</button>' +
      '<button id="sia-esp-radar" style="background:var(--b2);border:1px solid var(--li2);color:var(--t0);font-weight:600;font-size:12px;padding:10px 14px;border-radius:8px;cursor:pointer">' +
      (e.radarRodando ? 'Radar ' + e.radarRodando + '/' + e.radarTotal + '...' : 'Radar dos meus produtos') + '</button></div>';

    h += '<div class="nota" style="margin-top:0">A busca abre a vitrine numa aba em segundo plano e le a resposta que a propria Shopee entrega — nao fabricamos chamada, so escutamos. Cada termo leva alguns segundos. O faturamento e estimado: a propria Shopee mostra quantas unidades cada produto vendeu nos ultimos 30 dias. Multiplicamos pelo preco exibido. E regua de vitrine, nao o extrato do concorrente.</div>';

    if (e.erro) h += '<div class="nota" style="color:var(--rd)">' + esc(e.erro) + '</div>';

    /* ---- RADAR ---- */
    if (e.radar && e.radar.length) {
      h += '<div style="font-family:monospace;font-size:10px;color:var(--t2);letter-spacing:.06em;margin:16px 0 8px">SEUS PRODUTOS NAS BUSCAS DELES</div>';
      for (var r = 0; r < e.radar.length; r++) {
        var L = e.radar[r];
        var cor = 'var(--t2)', txt = '', posTxt = '—';
        if (L.erro) { txt = esc(L.erro); }
        else {
          posTxt = L.pos ? String(L.pos) : '—';
          if (L.meuFat == null) { txt = 'voce nao aparece no top ' + (L.total || 60) + ' dessa busca'; cor = 'var(--rd)'; }
          else if (L.barreira && L.meuFat >= L.barreira) { txt = 'voce vende mais que eles'; cor = 'var(--vd)'; }
          else if (L.barreira) { txt = 'eles vendem ' + fmt(L.barreira / L.meuFat, 1) + 'x mais que voce'; cor = L.barreira / L.meuFat > 2 ? 'var(--rd)' : 'var(--am)'; }
        }
        h += '<button data-espiar="' + esc(L.termo) + '" data-prod="' + esc(L.produto) + '" style="display:block;width:100%;text-align:left;cursor:pointer;font-family:inherit;background:var(--b2);border:1px solid var(--li);border-left:3px solid ' + cor + ';border-radius:12px;padding:14px 15px;margin-bottom:9px">' +
          '<div style="display:flex;gap:8px;align-items:center">' +
          '<span style="font-family:monospace;font-size:15px;color:' + cor + ';width:26px">' + posTxt + '</span>' +
          '<span style="flex:1;font-size:12.5px">' + esc(String(L.produto).slice(0, 52)) + '</span>' +
          (L.meuAds ? '<span style="font-family:monospace;font-size:8px;color:var(--mk);border:1px solid rgba(255,77,28,.4);border-radius:99px;padding:2px 7px">ADS</span>' : '') +
          '</div>' +
          '<div style="font-family:monospace;font-size:10px;color:var(--t2);margin-top:4px">busca "' + esc(L.termo) + '"' + (L.total ? ' · ' + L.total + ' resultados · ' + L.ads + ' anuncios' : '') + '</div>' +
          '<div style="font-family:monospace;font-size:10.5px;margin-top:5px">' +
          '<span style="color:var(--t1)">voce ' + espDinheiro(L.meuFat) + '/mes</span> ' +
          '<span style="color:var(--t2)">→</span> ' +
          '<span style="color:var(--vd)">TOP 5 ' + espDinheiro(L.barreira) + '</span> ' +
          '<span style="color:' + cor + '">· ' + txt + '</span></div>' +
          '<div style="display:flex;align-items:center;gap:10px;margin-top:9px">' +
          '<span style="font-family:Space Mono,monospace;font-size:10px;color:var(--mk)">ver comparativo completo &rsaquo;</span>' +
          '<span data-trocar="' + esc(L.produto) + '" style="font-family:Space Mono,monospace;font-size:10px;color:var(--t2);text-decoration:underline;margin-left:auto">trocar o termo</span>' +
          '</div></button>';
      }
    }

    /* ---- SONDA + DUELO ---- */
    if (e.res) {
      var lista = e.res.lista, b = e.res.barreira;
      var nAds = 0, i;
      for (i = 0; i < lista.length; i++) if (lista[i].ads) nAds++;

      h += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:16px 0 10px">' +
        '<div style="background:var(--b2);border:1px solid var(--li);border-radius:10px;padding:9px;text-align:center"><div style="font-family:"Space Mono";font-size:10px;color:var(--t2)">ANUNCIOS</div><div style="font-size:20px;color:var(--mk)">' + nAds + '<span style="font-size:12px;color:var(--t2)">/' + lista.length + '</span></div></div>' +
        '<div style="background:var(--b2);border:1px solid var(--li);border-radius:10px;padding:9px;text-align:center"><div style="font-family:"Space Mono";font-size:10px;color:var(--t2)">PRECO TOP 5</div><div style="font-size:20px">' + (b && b.preco != null ? 'R$' + fmt(b.preco, 0) : '—') + '</div></div>' +
        '<div style="background:var(--b2);border:1px solid var(--li);border-radius:10px;padding:9px;text-align:center"><div style="font-family:"Space Mono";font-size:10px;color:var(--t2)">BARREIRA/MES</div><div style="font-size:20px;color:var(--vd)">' + (b ? espDinheiro(b.faturamentoMes) : '—') + '</div></div></div>';

      for (i = 0; i < lista.length; i++) {
        var x = lista[i];
        h += '<div style="display:flex;align-items:center;gap:8px;padding:7px 6px;border-bottom:1px solid var(--li);font-size:11.5px' + (x.eu ? ';background:rgba(46,204,113,.06);border-radius:6px' : '') + '">' +
          '<span style="font-family:monospace;font-size:13px;width:22px;color:' + (x.eu ? 'var(--vd)' : 'var(--t2)') + '">' + x.pos + '</span>' +
          '<span style="flex:1;color:' + (x.eu ? 'var(--vd)' : 'var(--t1)') + (x.eu ? ';font-weight:600' : '') + '">' + esc(x.nome.slice(0, 44)) + (x.eu ? ' (voce)' : '') + '</span>' +
          (x.ads ? '<span style="font-family:monospace;font-size:8px;color:var(--mk)">ADS</span>' : '') +
          '<span style="text-align:right"><span style="font-family:monospace;font-size:10.5px;display:block">' + (x.preco != null ? 'R$' + fmt(x.preco, 2) : '—') + '</span>' +
          '<span style="font-family:monospace;font-size:8.5px;color:var(--vd)">' + (x.vendasMes != null ? x.vendasMes + '/mes · ' + espDinheiro(x.faturamentoMes) : 'sem dado') + '</span></span></div>';
      }

      var meus = lista.filter(function (z) { return z.eu; });
      var meuFora = (!meus.length && b && estado.espiao.meuProduto);
      if (meuFora) {
        var mp = estado.espiao.meuProduto;
        h += '<div style="background:color-mix(in srgb,var(--rd) var(--tin,9%),var(--b2));border:1px solid var(--rd);border-radius:12px;padding:15px 16px;margin:16px 0 4px">' +
          '<div style="font-size:16px;font-weight:600;color:var(--t0);margin-bottom:5px">Voce nao aparece nesta busca</div>' +
          '<div style="font-size:14px;color:var(--t1);line-height:1.55">' + esc(String(mp.nome).slice(0, 60)) + ' nao esta entre os ' + lista.length + ' primeiros de <b>' + esc(e.res.termo) + '</b>. Os cinco primeiros faturam ' + espDinheiro(b.faturamentoMes) + ' por mes cada, na media — esse mercado passa longe de voce.</div></div>';
      }
      if (meus.length && b) {
        var m = meus[0], lid = b.lider;
        h += '<div style="font-family:monospace;font-size:10px;color:var(--t2);letter-spacing:.06em;margin:18px 0 8px">VOCE · MEDIA DOS 5 PRIMEIROS · O PRIMEIRO</div>';
        h += '<table style="width:100%;border-collapse:collapse;font-size:11.5px">' +
          '<tr><th></th><th style="font-family:monospace;font-size:9px;color:var(--mk);padding:6px">VOCE</th><th style="font-family:monospace;font-size:9px;color:var(--vd);padding:6px">MEDIA DOS 5</th><th style="font-family:Space Mono,monospace;font-size:10.5px;color:var(--t2);padding:6px">O PRIMEIRO</th></tr>';
        function linha(rot, a, c, d) {
          return '<tr><td style="font-family:Space Mono,monospace;font-size:10.5px;color:var(--t2);padding:6px 4px">' + rot + '</td>' +
            '<td style="text-align:center;padding:6px;font-family:monospace;background:rgba(255,77,28,.05)">' + a + '</td>' +
            '<td style="text-align:center;padding:6px;color:var(--t1)">' + c + '</td>' +
            '<td style="text-align:center;padding:6px;color:var(--t2)">' + d + '</td></tr>';
        }
        h += linha('Posicao', m.pos, '1 a 5', lid.pos);
        h += linha('Preco', m.preco != null ? 'R$' + fmt(m.preco, 2) : '—', b.preco != null ? 'R$' + fmt(b.preco, 2) : '—', lid.preco != null ? 'R$' + fmt(lid.preco, 2) : '—');
        h += linha('Vendas/mes', m.vendasMes != null ? m.vendasMes : '—', b.vendasMes != null ? fmt(b.vendasMes, 0) : '—', lid.vendasMes != null ? lid.vendasMes : '—');
        h += linha('Faturam./mes', espDinheiro(m.faturamentoMes), espDinheiro(b.faturamentoMes), espDinheiro(lid.faturamentoMes));
        h += linha('Avaliacoes', m.avaliacoes != null ? fmt(m.avaliacoes, 0) : '—', b.avaliacoes != null ? fmt(b.avaliacoes, 0) : '—', lid.avaliacoes != null ? fmt(lid.avaliacoes, 0) : '—');
        h += linha('Nota', m.nota != null ? fmt(m.nota, 1) : '—', b.nota != null ? fmt(b.nota, 1) : '—', lid.nota != null ? fmt(lid.nota, 1) : '—');
        h += linha('Cupom', m.cupom ? 'sim' : 'nao', b.comCupom + ' de ' + b.n + ' tem', lid.cupom ? 'sim' : 'nao');
        h += '</table>';

        var falta = (b.faturamentoMes != null && m.faturamentoMes != null) ? b.faturamentoMes - m.faturamentoMes : null;
        var faltaUn = (b.vendasMes != null && m.vendasMes != null) ? Math.round(b.vendasMes - m.vendasMes) : null;
        h += '<div style="background:var(--b2);border-left:3px solid var(--mk);border-radius:0 9px 9px 0;padding:11px 13px;margin-top:12px;font-size:12px;color:var(--t1);line-height:1.5">';
        if (falta != null && falta > 0) {
          h += '<b style="color:var(--t0)">Para chegar no topo:</b> faltam <b style="color:var(--mk)">' + espDinheiro(falta) + '/mes</b> para encostar no padrao do topo' +
            (faltaUn > 0 ? ' — em unidades, de ' + m.vendasMes + ' para cerca de ' + fmt(b.vendasMes, 0) + ' vendas/mes.' : '.');
        } else { h += '<b style="color:var(--vd)">Voce esta acima da barreira do TOP 5 nesta busca.</b> Aqui a leitura muda: proteja a posicao, nao persiga preco.'; }
        if (m.preco != null && b.preco != null && m.preco > b.preco * 1.15) h += ' Voce esta ' + fmt((m.preco / b.preco - 1) * 100, 0) + '% mais caro que o padrao do topo.';
        if (!m.cupom && b.comCupom >= 2) h += ' E e o unico sem cupom entre os primeiros — cupom vira selo na busca e custa menos que cortar preco.';
        h += '<br><br><b style="color:var(--t0)">Antes de mexer no preco:</b> abra a Margem e veja seu liquido de hoje. Preco e o ultimo passo, e so se a margem aguentar.</div>';
      }
      var dp = espDiffPalavras(lista, estado.espiao.meuProduto ? estado.espiao.meuProduto.nome : null);
      if (dp.faltando.length && !estado.espiao.volumes) {
        estado.espiao.volumes = {};
        espVolume(dp.faltando.map(function (x) { return x.p; }), function (mapa) {
          estado.espiao.volumes = mapa; estado.sujo = true;
        });
      }
      if (dp.temMeu && dp.faltando.length) {
        h += '<div style="font-family:Space Mono,monospace;font-size:11px;color:var(--t2);letter-spacing:.06em;margin:18px 0 8px">PALAVRAS QUE OS PRIMEIROS USAM E VOCE NAO' + dica('<b>Como isto e calculado:</b> quebramos o titulo dos cinco primeiros colocados desta busca e o seu, e listamos as palavras que aparecem em pelo menos dois deles e faltam no seu titulo. Palavras muito genericas ficam de fora. <b>Regra do metodo:</b> titulo de produto que ja vende nao se mexe. Isto serve para produto sem trafego, onde nao ha historico a proteger.') + '</div><div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">';
        for (var w = 0; w < dp.faltando.length; w++) {
          var vol = (estado.espiao.volumes || {})[dp.faltando[w].p];
          h += '<span style="font-family:Space Mono,monospace;font-size:11.5px;color:var(--px);background:color-mix(in srgb,var(--px) 10%,transparent);border:1px solid var(--px);border-radius:99px;padding:4px 11px">' +
            esc(dp.faltando[w].p) + ' <span style="color:var(--t2)">' + dp.faltando[w].n + '/5</span>' +
            (vol ? ' <b style="color:var(--vd);font-weight:400">' + fmt(vol, 0) + '/mes</b>' : '') + '</span>';
        }
        h += '</div>';
      }
      if (!meus.length && b) {
        h += '<div class="nota" style="color:var(--am);margin-top:12px">Nenhum produto seu apareceu nesta busca. Quando o titulo nao carrega o termo que o comprador digita, voce nem entra na disputa — nem paga, nem organica.</div>';
      }
    }
    return h;
  }

  function ligarEspiao() {
    var inp = $('sia-esp-termo'), bt = $('sia-esp-ir'), br = $('sia-esp-radar');
    function ir() {
      var t = (inp && inp.value || '').trim();
      if (!t) return;
      estado.espiao.termo = t; estado.espiao.buscando = true; estado.espiao.erro = null; render();
      espBuscar(t, function (resp) {
        estado.espiao.buscando = false;
        if (!resp || !resp.ok) { estado.espiao.erro = (resp && resp.erro) || 'Falhou.'; estado.espiao.res = null; }
        else {
          var lista = espMapear(resp.itens);
          estado.espiao.res = { termo: resp.termo, lista: lista, barreira: espBarreira(lista) };
        }
        render();
      });
    }
    if (bt) bt.addEventListener('click', ir);
    if (inp) inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') ir(); });
    if (br) br.addEventListener('click', function () { espRodarRadar(); });
  }

  /* ===================== CARD DE 6 PARTES =====================
     O modelo aprovado em card-final-base.html, agora alimentado pelo
     que a extensao ja coleta. Ordem fixa, nunca reduzir a 3 blocos:
     1 aprendizado · 2 dinheiro · 3 ROAS explicado · 4 consultor
     5 ouro da Shopee (espiao) · 6 funil. */
  function cofreD() { try { return (window.SIA_Diamantes && window.SIA_Diamantes.estado()) || {}; } catch (e) { return {}; } }

  /* --- VINCULO CAMPANHA -> PRODUTO ---
     A Shopee so entrega item_id junto da campanha em algumas rotas. Com 298
     campanhas e 14 produtos identificados, a maioria dos cards abria sem
     produto — e sem produto nao ha custo, logo nao ha lucro. Aqui resolvemos
     em tres degraus: vinculo salvo pela usuaria > item_id da API > nome. */
  function normNome(s) {
    s = String(s || '').toLowerCase();
    s = s.normalize ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : s;
    return s.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function listaProdutos() {
    var C = cofreD(), out = [], id;
    for (id in estado.produtos) out.push({ id: id, nome: estado.produtos[id].nome || ('Produto ' + id) });
    for (id in (C.porProduto || {})) {
      if (estado.produtos[id]) continue;
      out.push({ id: id, nome: (C.porProduto[id].nome) || ('Produto ' + id) });
    }
    return out;
  }
  function acharProdutoPorNome(titulo) {
    var alvo = normNome(titulo);
    if (!alvo) return null;
    var tk = alvo.split(' ').filter(function (x) { return x.length > 2; });
    if (!tk.length) return null;
    var lista = listaProdutos(), melhor = null, melhorNota = 0;
    for (var i = 0; i < lista.length; i++) {
      var n = normNome(lista[i].nome);
      if (!n) continue;
      var achou = 0;
      for (var k = 0; k < tk.length; k++) if (n.indexOf(tk[k]) >= 0) achou++;
      var nota = achou / tk.length;
      if (nota > melhorNota) { melhorNota = nota; melhor = lista[i]; }
    }
    return melhorNota >= 0.5 ? melhor : null;
  }
  function vinculoDe(idCamp) {
    var v = estado.cofre && estado.cofre.vinculos ? estado.cofre.vinculos[String(idCamp)] : null;
    return v || null;
  }
  function salvarVinculo(idCamp, idProd) {
    if (!estado.cofre) estado.cofre = { custos: {}, embalagem: 0, imposto: 0 };
    estado.cofre.vinculos = estado.cofre.vinculos || {};
    if (idProd) estado.cofre.vinculos[String(idCamp)] = String(idProd);
    else delete estado.cofre.vinculos[String(idCamp)];
    salvarCofre();
  }

  function abrirCard(tipo, id) {
    estado.card = { tipo: tipo, id: String(id) };
    abaAtiva = 'card';
    render();
  }

  function cardResolver() {
    var C = cofreD(), a = estado.card || {};
    var pc = null, pp = null, nome = '', idProduto = null, idCamp = null, autoNome = false;
    if (a.tipo === 'campanha') {
      idCamp = a.id;
      pc = (C.porCampanha || {})[a.id] || null;
      var camp = estado.campanhas[a.id];
      nome = (pc && pc.titulo) || (camp && camp.nome) || ('Campanha ' + a.id);
      // 1) vinculo salvo pela usuaria manda em tudo
      var vin = vinculoDe(a.id);
      if (vin) { idProduto = vin; pp = (C.porProduto || {})[vin] || null; }
      // 2) item_id que a propria API entregou
      if (!idProduto) {
        for (var k in (C.porProduto || {})) {
          if (C.porProduto[k].campaignId === String(a.id)) { pp = C.porProduto[k]; idProduto = k; break; }
        }
      }
      // 3) nome da campanha x nome do produto
      if (!idProduto) {
        var achado = acharProdutoPorNome(nome);
        if (achado) { idProduto = achado.id; pp = (C.porProduto || {})[achado.id] || null; autoNome = true; }
      }
    } else {
      idProduto = a.id;
      pp = (C.porProduto || {})[a.id] || null;
      nome = (pp && pp.nome) || (estado.produtos[a.id] && estado.produtos[a.id].nome) || ('Produto ' + a.id);
      if (pp && pp.campaignId) { idCamp = pp.campaignId; pc = (C.porCampanha || {})[pp.campaignId] || null; }
    }
    return { tipo: a.tipo || 'produto', pc: pc, pp: pp, nome: nome, idProduto: idProduto, idCamp: idCamp, C: C, autoNome: autoNome };
  }

  function chip(rot, val, sub, cor) {
    return '<div style="background:var(--b2);border:1px solid var(--li);border-radius:10px;padding:9px 10px">' +
      '<div style="font-family:Space Mono,monospace;font-size:11.5px;color:var(--t2);letter-spacing:.05em">' + rot + '</div>' +
      '<div style="font-family:Bebas Neue,sans-serif;font-size:26px;line-height:1.1;margin-top:3px;color:' + (cor || 'var(--t0)') + '">' + val + '</div>' +
      '<div style="font-size:12px;color:var(--t2);margin-top:2px">' + sub + '</div></div>';
  }

  function renderCard6() {
    var R = cardResolver();
    var pc = R.pc, pp = R.pp;
    var h = '';

    h += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
      '<button data-voltar="1" style="background:var(--b2);border:1px solid var(--li2);color:var(--t1);border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer">‹ voltar</button>' +
      '<div style="flex:1"><div style="font-size:14px;font-weight:600;line-height:1.25">' + esc(String(R.nome).slice(0, 62)) + '</div>' +
      '<div style="font-family:monospace;font-size:9.5px;color:var(--t2)">' + (R.tipo === 'produto' ? 'produto · ID ' + esc(R.idProduto || '—') : 'campanha · ' + esc(R.idCamp || '—')) + '</div></div></div>';

    if (!pc && !pp) {
      return h + '<div class="vazio">Ainda nao tenho dados ' + (R.tipo === 'produto' ? 'deste produto' : 'desta campanha') + '. Rode a coleta completa na aba Inicio.</div>';
    }

    /* ---- 1. ALERTA DE APRENDIZADO (so quando existe) ---- */
    if (pp && pp.emAprendizado && pp.aprendizadoDias) {
      h += '<div style="display:flex;gap:8px;background:rgba(245,176,65,.1);border:1px solid rgba(245,176,65,.28);border-radius:10px;padding:10px 12px;margin-bottom:11px;font-size:12px;color:var(--am);line-height:1.45">' +
        '<b>Em aprendizado:</b> faltam ' + fmt(pp.aprendizadoDias, 0) + ' dias. Nao altere preco nem lance agora — reinicia a contagem do algoritmo.</div>';
    }

    /* ---- 2. A CONTA DESTE PEDIDO ---- */
    var mCamp = (estado.campanhas[R.idCamp] && estado.campanhas[R.idCamp].metricas) || {};
    var pedidos = (pc && pc.resultado && pc.resultado.pedidos) || (pp && pp.perf && pp.perf.pedidos) || mCamp.pedidos || null;
    var gasto = (pc && pc.leilao && pc.leilao.gasto) || mCamp.gasto || null;
    var gmvCamp = (pc && pc.resultado && pc.resultado.gmvAmplo) || mCamp.gmv || null;
    // ticket: usa o do produto se existir; senao deriva do proprio GMV da campanha
    var preco = (pp && pp.perf && pp.perf.ticket) || ((gmvCamp && pedidos) ? gmvCamp / pedidos : null);
    var precoDerivado = !(pp && pp.perf && pp.perf.ticket);
    var adsPedido = (gasto && pedidos) ? gasto / pedidos : null;
    var comissao = null;
    var custoProd = R.idProduto ? custoDe(R.idProduto) : null;
    var emb = (estado.cofre && estado.cofre.embalagem) || 0;
    var impPct = (estado.cofre && estado.cofre.imposto) || 0;
    var faixaTxt = '';
    try {
      if (preco && window.SIA_Calc) {
        var tx = window.SIA_Calc.taxaShopee(preco);
        comissao = (preco * tx.comissao / 100) + tx.fixa;
        faixaTxt = tx.comissao + '% + ' + reais(tx.fixa);
      }
    } catch (e) { /* noop */ }
    var imposto = (preco != null && impPct) ? preco * impPct / 100 : 0;
    var liquido = (preco != null && comissao != null)
      ? preco - comissao - (adsPedido || 0) - (custoProd || 0) - emb - imposto
      : null;
    var margemPct = (liquido != null && preco) ? (liquido / preco) * 100 : null;

    h += '<div style="border:1px solid var(--li);border-radius:12px;padding:12px;margin-bottom:11px">' +
      olho('A CONTA DE UM PEDIDO', 'A conta de um pedido: o que entra e o que sai em UMA venda deste produto. Ticket medio menos comissao da Shopee, menos o que o anuncio custou por pedido, menos custo, embalagem e imposto quando cadastrados no Cofre. O que sobra e o seu lucro por unidade vendida.');
    function linhaR(l, v, forte) {
      return '<div style="display:flex;justify-content:space-between;font-size:14px;padding:4px 0;color:' + (forte ? 'var(--t0)' : 'var(--t1)') + '"><span>' + l + '</span><span style="font-family:monospace">' + v + '</span></div>';
    }
    h += linhaR('Ticket medio' + (precoDerivado && preco != null ? ' (GMV ÷ pedidos)' : ''), preco != null ? reais(preco) : '—', true);
    h += linhaR('− Comissao Shopee' + (faixaTxt ? ' (' + faixaTxt + ')' : ''), comissao != null ? '− ' + reais(comissao) : '—');
    h += linhaR('− Ads por pedido', adsPedido != null ? '− ' + reais(adsPedido) : '—');
    if (custoProd) h += linhaR('− Custo do produto', '− ' + reais(custoProd));
    if (emb) h += linhaR('− Embalagem', '− ' + reais(emb));
    if (imposto) h += linhaR('− Imposto (' + fmt(impPct, 1) + '%)', '− ' + reais(imposto));
    h += '<div style="display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid var(--li);margin-top:6px;padding-top:7px">' +
      '<span style="font-size:14px;font-weight:600">' + (custoProd ? 'Lucro por pedido' : 'Sobra antes do custo') + '</span>' +
      '<span style="font-size:26px;color:' + (liquido > 0 ? 'var(--vd)' : 'var(--rd)') + '">' + (liquido != null ? reais(liquido) : '—') + '</span></div>';
    if (!custoProd) {
      var lp = listaProdutos();
      if (lp.length) {
        h += '<div style="background:var(--b2);border:1px solid var(--li);border-radius:9px;padding:9px 11px;margin-top:9px">' +
          '<div style="font-family:"Space Mono";font-size:10px;color:var(--t2);margin-bottom:6px">QUAL PRODUTO E ESTA CAMPANHA?</div>' +
          '<div style="display:flex;gap:6px"><select id="sia-vinc" style="flex:1;background:var(--b1);border:1px solid var(--li);border-radius:7px;padding:7px;color:var(--t0);font-size:11.5px"><option value="">escolha o produto...</option>';
        for (var vp = 0; vp < lp.length; vp++) {
          h += '<option value="' + esc(lp[vp].id) + '"' + (String(lp[vp].id) === String(R.idProduto) ? ' selected' : '') + '>' + esc(String(lp[vp].nome).slice(0, 40)) + (custoDe(lp[vp].id) ? ' · custo ok' : ' · sem custo') + '</option>';
        }
        h += '</select><button id="sia-vinc-ok" data-camp="' + esc(R.idCamp || '') + '" style="background:var(--mk);border:none;color:var(--t0);font-size:11.5px;font-weight:600;padding:0 13px;border-radius:7px;cursor:pointer">Vincular</button></div></div>';
      }
    }
    if (custoProd) {
      h += '<div style="background:var(--b2);border-left:3px solid var(--vd);border-radius:0 8px 8px 0;padding:8px 11px;margin-top:9px;font-size:11.5px;color:var(--t1)">' +
        'Margem real de <b style="color:var(--vd)">' + (margemPct != null ? fmt(margemPct, 1) + '%' : '—') + '</b> — custo, embalagem e imposto ja descontados.' + (R.autoNome ? ' <span style="color:var(--am)">Produto identificado pelo nome — confira se e este mesmo.</span>' : '') + '</div></div>';
    } else {
      h += '<div style="background:var(--b2);border-left:3px solid var(--px);border-radius:0 8px 8px 0;padding:8px 11px;margin-top:9px;font-size:11.5px;color:var(--t1)">' +
        'Falta o custo deste produto. Cadastre na aba <b style="color:var(--t0)">Cofre</b> e esta sobra vira lucro de verdade.</div></div>';
    }

    /* ---- 3. POR QUE ESTE ROAS (a Shopee explica) ---- */
    var roasReal = (pc && pc.resultado && pc.resultado.roiAmplo) || null;
    var meta = (pc && pc.metaShopee) || {};
    // ATENCAO: sem o custo do produto isso NAO e o equilibrio real, e o TETO
    // (o melhor cenario possivel, com custo zero). Mostrar 2,1x como equilibrio
    // faria a usuaria baixar a meta e perder dinheiro. Enquanto o Cofre de
    // Custos nao existe, o card diz o que o numero e de verdade.
    var teto = margemPct ? 100 / margemPct : null;
    var temCusto = !!custoProd;
    var equil = temCusto ? teto : null;
    var temAds = !!(pc && (pc.resultado || pc.leilao));
    if (!temAds) {
      h += '<div style="background:var(--b2);border-left:3px solid var(--px);border-radius:0 9px 9px 0;padding:10px 12px;margin-bottom:11px;font-size:13px;color:var(--t1);line-height:1.5">' +
        'Este produto nao tem anuncio ativo nesta coleta, entao nao ha ROAS para explicar. O julgamento acima vem do funil organico da pagina.</div>';
    } else {
    h += '<div style="border:1px solid var(--li);border-radius:12px;padding:12px;margin-bottom:11px">' +
      '<div style="font-family:Space Mono,monospace;font-size:12px;color:var(--px);letter-spacing:.06em;margin-bottom:9px">POR QUE ESTE ROAS</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:7px;text-align:center">' +
      '<div><div style="font-size:18px;color:var(--am)">' + (meta.atual != null ? fmt(meta.atual, 1) + 'x' : '—') + '</div><div style="font-family:"Space Mono";font-size:10px;color:var(--t2)">VOCE PEDE</div></div>' +
      '<div><div style="font-size:18px;color:var(--vd)">' + (meta.sugerida != null ? fmt(meta.sugerida, 1) + 'x' : '—') + '</div><div style="font-family:"Space Mono";font-size:10px;color:var(--t2)">SHOPEE SUGERE</div></div>' +
      '<div><div style="font-size:18px;color:' + (equil != null ? 'var(--mk)' : 'var(--t2)') + '">' + (equil != null ? fmt(equil, 1) + 'x' : (teto != null ? fmt(teto, 1) + 'x' : '—')) + '</div><div style="font-family:monospace;font-size:8px;color:' + (equil != null ? 'var(--t2)' : 'var(--am)') + '">' + (equil != null ? 'SEU EQUILIBRIO' : 'TETO · SEM CUSTO') + '</div></div></div>';
    // Uma ideia por linha. Nada de paragrafo com tres assuntos misturados,
    // nada de frase de efeito. Cada linha responde uma pergunta so.
    function linhaRoas(txt, cor) {
      return '<div style="display:flex;gap:8px;font-size:13.5px;color:var(--t1);padding:7px 0;border-top:1px solid var(--li);line-height:1.45">' +
        '<span style="color:' + (cor || 'var(--t2)') + ';flex:none">•</span><span>' + txt + '</span></div>';
    }
    h += '<div style="margin-top:10px">';
    if (meta.atual != null && roasReal != null) {
      var folga = meta.atual - roasReal;
      h += linhaRoas('Voce pede <b style="color:var(--t0)">' + fmt(meta.atual, 1) + 'x</b> e a campanha entrega <b style="color:var(--t0)">' + fmt(roasReal, 2) + 'x</b>.' +
        (folga > 1 ? ' A meta esta acima do que ela consegue.' : ' A meta esta no tamanho da entrega.'),
        folga > 1 ? 'var(--am)' : 'var(--vd)');
    } else if (roasReal != null) {
      h += linhaRoas('A campanha entrega <b style="color:var(--t0)">' + fmt(roasReal, 2) + 'x</b> hoje.');
    }
    if (meta.sugerida != null) {
      h += linhaRoas('A Shopee sugere baixar a meta pra <b style="color:var(--vd)">' + fmt(meta.sugerida, 1) + 'x</b>' +
        (meta.ganhoGmvPct != null ? ' e projeta <b style="color:var(--vd)">+' + fmt(meta.ganhoGmvPct, 0) + '%</b> de vendas.' : '.'), 'var(--vd)');
    } else {
      h += linhaRoas('A sugestao da Shopee ainda nao foi lida. Abra a tela de Shopee Ads uma vez.', 'var(--am)');
    }
    if (equil != null) {
      h += linhaRoas('Abaixo de <b style="color:var(--mk)">' + fmt(equil, 1) + 'x</b> voce paga pra vender.', 'var(--mk)');
    } else if (teto != null) {
      h += linhaRoas('<b style="color:var(--am)">Nao use o ' + fmt(teto, 1) + 'x como meta.</b> Ele ignora o custo do produto. Seu limite real e mais alto, e so o Cofre de Custos vai dizer quanto.', 'var(--am)');
    }
    h += '</div></div>';
    }

    /* ---- 4. CONSULTOR ---- */
    var diag = null;
    try {
      if (estado.diagnostico && estado.diagnostico.vereditos) {
        for (var v = 0; v < estado.diagnostico.vereditos.length; v++) {
          var vd = estado.diagnostico.vereditos[v];
          if (String(vd.id) === String(R.idCamp) || String(vd.id) === String(R.idProduto)) { diag = vd; break; }
        }
      }
    } catch (e) { /* noop */ }
    var dp = (R.tipo === 'produto' && R.idProduto && estado.produtos[R.idProduto]) ? diagProduto(R.idProduto) : null;
    var fraseCard = (dp && dp.titulo) || (diag && (diag.titulo || diag.frase)) || cardFraseLocal(pc, pp);
    h += '<div style="background:var(--b2);border:1px solid var(--li);border-radius:12px;padding:13px;margin-bottom:11px">' +
      '<div style="font-size:19px;color:var(--mk);line-height:1.25;margin-bottom:6px">' + esc(fraseCard) + '</div>';
    if (dp && dp.texto) h += '<div style="font-size:13px;color:var(--t1);line-height:1.5;margin-bottom:8px">' + esc(dp.texto) + '</div>';
    var passos = (diag && diag.acoes) || (dp && dp.acao ? [dp.acao] : null);
    if (passos && passos.length) {
      h += '<div style="font-family:Space Mono,monospace;font-size:12px;color:var(--t2);letter-spacing:.06em;margin-bottom:6px">FACA NESTA ORDEM</div>';
      for (var s = 0; s < passos.length; s++) {
        h += '<div style="display:flex;gap:9px;padding:6px 0;border-bottom:1px solid var(--li);font-size:11.5px;color:var(--t1)">' +
          '<span style="font-family:monospace;color:var(--mk)">' + (s + 1) + '</span><span>' + esc(passos[s]) + '</span></div>';
      }
    } else {
      h += '<div style="font-size:11.5px;color:var(--t2)">O passo a passo vem do cerebro treinado. Rode <b style="color:var(--t1)">Analisar</b> na aba Diagnostico para trazer as acoes desta campanha.</div>';
    }
    h += '</div>';

    /* ---- 5. OURO DA SHOPEE (o espiao) ---- */
    var posLeilao = (pc && pc.leilao && pc.leilao.posicao) || (pp && pp.posicaoLeilao) || null;
    var comp = pp && pp.competitividade != null ? pp.competitividade : null;
    var st = (pp && pp.status) || null;
    var probl = (pc && pc.problema) || (meta.problema) || null;
    var DIAG = {
      'na': ['sem apontamento', 'a Shopee nao ve problema aqui'],
      'no_conversion': ['nao converte', 'chega gente e nao compra'],
      'low_conversion': ['converte pouco', 'a pagina segura pouco'],
      'low_traffic': ['pouco trafego', 'falta gente vendo'],
      'low_impression': ['pouca exibicao', 'o anuncio aparece pouco'],
      'room_more_traffic': ['cabe mais', 'da pra crescer sem quebrar'],
      'low_roi': ['ROAS baixo', 'devolve pouco pelo que gasta'],
      'good': ['saudavel', 'a Shopee aprova'],
      'fair': ['mediana', 'nem boa nem ruim'],
      'poor': ['fraca', 'a Shopee sinaliza problema']
    };
    var dg = DIAG[String(probl || '').toLowerCase()] || null;
    var diagRot = dg ? dg[0] : (probl ? esc(String(probl).slice(0, 16)) : '—');
    var diagSub = dg ? dg[1] : (probl ? 'apontado pela propria Shopee' : 'sem apontamento');
    var diagCor = !probl ? 'var(--t2)' : (String(probl).toLowerCase() === 'na' || String(probl).toLowerCase() === 'good' ? 'var(--vd)' : (String(probl).toLowerCase() === 'room_more_traffic' ? 'var(--vd)' : 'var(--am)'));
    h += olho('O QUE A SHOPEE SABE E NAO MOSTRA', '<b>Estes quatro numeros existem na API da Shopee e nao aparecem no painel dela.</b> Posicao no leilao e onde seu anuncio cai na disputa. Competitividade e como o seu preco esta contra a categoria, na regua dela. Status diz se o produto tem alcance limitado. Diagnostico e o problema que ela mesma aponta.') +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:11px">' +
      chip('POSICAO NO LEILAO', posLeilao != null ? fmt(posLeilao, 0) : '—', posLeilao == null ? 'sem dado' : (posLeilao <= 10 ? 'topo da vitrine' : (posLeilao <= 30 ? 'meio da vitrine' : 'fundo da vitrine')), posLeilao != null && posLeilao <= 10 ? 'var(--vd)' : (posLeilao > 30 ? 'var(--rd)' : 'var(--am)')) +
      chip('COMPETITIVIDADE PRECO', comp != null ? fmt(comp, 0) + '<span style="font-size:11px;color:var(--t2)">/100</span>' : '—', comp == null ? 'abra a campanha uma vez' : (comp >= 70 ? 'acima da categoria' : (comp >= 40 ? 'na media' : 'caro pra categoria')), comp != null && comp >= 70 ? 'var(--vd)' : (comp != null && comp < 40 ? 'var(--rd)' : 'var(--am)')) +
      chip('STATUS SHOPEE', st ? esc(st === 'normal' ? 'Normal' : st) : '—', st === 'normal' ? 'sem limitacao' : (st ? 'produto limitado' : 'abra a campanha uma vez'), st && st !== 'normal' ? 'var(--rd)' : 'var(--vd)') +
      chip('DIAGNOSTICO SHOPEE', diagRot, diagSub, diagCor) +
      '</div>';

    /* ---- 6. FUNIL ---- */
    var f = (pc && pc.funil) || {};
    var perfP = (pp && pp.perf) || {};
    var mProd = (R.idProduto && estado.produtos[R.idProduto] && estado.produtos[R.idProduto].metricas) || {};
    var etapas, tituloFunil = 'O CAMINHO ATE A VENDA';
    if (R.tipo === 'produto' && !f.impressoes) {
      tituloFunil = 'O CAMINHO ATE A VENDA (PAGINA DO PRODUTO)';
      etapas = [
        { r: 'VISITANTES', v: mProd.visitantes !== undefined ? mProd.visitantes : perfP.uv },
        { r: 'VISUALIZACOES', v: perfP.pv },
        { r: 'CARRINHO', v: perfP.carrinhoCompradores != null ? perfP.carrinhoCompradores : perfP.carrinhoUnid },
        { r: 'PEDIDOS', v: mProd.pedidos_pagos !== undefined ? mProd.pedidos_pagos : perfP.pedidosPagos }
      ];
    } else {
      etapas = [
        { r: 'IMPRESSOES', v: f.impressoes },
        { r: 'CLIQUES', v: f.cliques },
        { r: 'CARRINHO', v: f.atc != null ? f.atc : (f.checkout != null ? f.checkout : null) },
        { r: 'VENDAS', v: (pc && pc.resultado && pc.resultado.pedidos) || f.checkout }
      ];
    }
    h += '<div style="font-family:Space Mono,monospace;font-size:12px;color:var(--t2);letter-spacing:.06em;margin-bottom:7px">' + tituloFunil + '</div>' +
      '<div style="display:flex;align-items:center;gap:4px;background:var(--b2);border:1px solid var(--li);border-radius:12px;padding:12px 8px">';
    for (var i = 0; i < etapas.length; i++) {
      if (i > 0) {
        var ant = null;
        for (var z = i - 1; z >= 0; z--) { if (etapas[z].v != null) { ant = etapas[z].v; break; } }
        var at = etapas[i].v;
        var queda = (ant && at != null) ? Math.round((1 - at / ant) * 100) : null;
        h += '<div style="flex:none;text-align:center;color:var(--t2);font-family:monospace;font-size:8px">›<br>' + (queda != null ? '−' + queda + '%' : '') + '</div>';
      }
      h += '<div style="flex:1;text-align:center"><div style="font-size:17px;color:var(--t0)">' + (etapas[i].v != null ? fmt(etapas[i].v, 0) : '—') + '</div>' +
        '<div style="font-family:monospace;font-size:7.5px;color:var(--t2)">' + etapas[i].r + '</div></div>';
    }
    h += '</div>';
    return h;
  }

  function cardFraseLocal(pc, pp) {
    var f = (pc && pc.funil) || {};
    var roas = (pc && pc.resultado && pc.resultado.roiAmplo) || null;
    // CTR sempre derivado: o campo cru da API vem em escalas diferentes por rota
    var ctr = (f.impressoes && f.cliques != null) ? (f.cliques / f.impressoes) * 100 : null;
    var conv = (f.cliques && pc && pc.resultado && pc.resultado.pedidos != null) ? (pc.resultado.pedidos / f.cliques) * 100 : null;
    if (pp && pp.emAprendizado) return 'Esta campanha ainda esta aprendendo. Deixe rodar.';
    if (roas != null && roas < 1) return 'Cada real investido aqui volta menos que um real.';
    if (ctr != null && ctr >= 1.8 && conv != null && conv < 1) return 'Recebe clique e nao fecha a venda.';
    if (ctr != null && ctr < 1) return 'Aparece na busca e recebe pouco clique.';
    if (roas != null && roas < 2) return 'Esta campanha gasta mais do que devolve.';
    if (roas != null && roas > 8) return 'Sobra margem: da pra buscar mais volume.';
    return 'Leitura desta campanha.';
  }

  /* ============ EXPLICACOES SOB DEMANDA ============
     Todo rotulo que nao se explica sozinho ganha um "?". A explicacao abre
     numa faixa no pe da gaveta, uma por vez — nao empilha texto na tela. */
  function capa(olhoTxt, linha1, linha2, num) {
    return '<div class="capa">' + (num ? '<div class="gh">' + num + '</div>' : '') +
      '<div class="ol">' + olhoTxt + '</div>' +
      '<div class="dp">' + linha1 + (linha2 ? ' <small>' + linha2 + '</small>' : '') + '</div></div>';
  }
  function olho(rot, txtDica) {
    return '<div class="olho">' + rot + (txtDica ? dica(txtDica) : '') + '</div>';
  }
  function dica(txt) {
    return '<button class="dica" data-dica="' + esc(txt) + '" aria-label="explicar">?</button>';
  }
  function mostrarExpl(txt) {
    var e = $('sia-expl');
    if (!e) return;
    e.innerHTML = '<button class="x" id="sia-expl-x" aria-label="fechar">\u2715</button>' + txt;
    e.classList.add('on');
    var x = $('sia-expl-x');
    if (x) x.addEventListener('click', function () { e.classList.remove('on'); });
  }
  function aplicarTema(claro) {
    estado.temaClaro = !!claro;
    try { host.classList.toggle('claro', !!claro); } catch (e) { /* noop */ }
  }
  function ligarTema() {
    var b = $('sia-tema');
    if (!b) return;
    b.addEventListener('click', function () {
      aplicarTema(!estado.temaClaro);
      try { chrome.runtime.sendMessage({ tipo: 'sia:pref-salvar', chave: 'temaClaro', valor: estado.temaClaro }, function () { void chrome.runtime.lastError; }); } catch (e) { /* noop */ }
    });
  }

  /* ============ CONVERSA COM O CEREBRO ============
     A extensao manda fatos e recebe vereditos prontos. Ela nao sabe as
     regras — de proposito. Enquanto o cerebro nao responde, o julgamento
     local roda como apoio e o rotulo diz isso na cara. */
  function margemMediaCofre() {
    var cf = estado.cofre || {};
    var ids = Object.keys(cf.custos || {});
    if (!ids.length) return null;
    var soma = 0, n = 0;
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], custo = cf.custos[id];
      var pr = estado.produtos[id] && estado.produtos[id].metricas;
      var ticket = pr && (pr.ticket_pedido || (pr.vendas_pagas && pr.pedidos_pagos ? pr.vendas_pagas / pr.pedidos_pagos : null));
      if (!ticket || !custo) continue;
      var com = ticket < 80 ? ticket * 0.20 + 4 : (ticket < 100 ? ticket * 0.14 + 16 : (ticket < 200 ? ticket * 0.14 + 20 : ticket * 0.14 + 26));
      var liq = ticket - com - custo - (cf.embalagem || 0) - (ticket * (cf.imposto || 0) / 100);
      soma += (liq / ticket) * 100; n++;
    }
    return n ? Math.round((soma / n) * 10) / 10 : null;
  }
  function payloadCerebro(foto) {
    var f = foto || fotoDoEstado();
    f.cofre = estado.cofre || null;
    f.margemMediaPct = margemMediaCofre();
    return {
      loja: estado.loja ? estado.loja.shop_id : 'desconhecida',
      snapshot: f,
      // impede que a leitura de um mes passado sobrescreva o dia de hoje
      // no historico com numeros antigos
      semHistorico: !!estado.leituraHistorica
    };
  }
  function guardarVereditos(resp) {
    estado.diagnostico = resp;
    if (resp && resp.ok && resp.vereditos && resp.vereditos.length) {
      estado.vereditos = resp.vereditos;
      estado.fonteVeredito = 'cerebro';
      estado.versaoRegras = resp.rules_version || null;
    }
    estado.sujo = true;
  }
  function vereditosDe(escopo, id) {
    var out = [];
    var v = estado.vereditos || [];
    for (var i = 0; i < v.length; i++) {
      if (v[i].escopo !== escopo) continue;
      if (id !== undefined && String(v[i].id) !== String(id)) continue;
      out.push(v[i]);
    }
    return out;
  }
  function seloFonte() {
    if (estado.fonteVeredito === 'cerebro') {
      return '<span style="font-family:Space Mono,monospace;font-size:9.5px;color:var(--vd);border:1px solid var(--vd);border-radius:99px;padding:2px 8px">analise Seller.IA' + (estado.versaoRegras ? ' \u00b7 ' + esc(estado.versaoRegras) : '') + '</span>';
    }
    return '<span style="font-family:Space Mono,monospace;font-size:9.5px;color:var(--am);border:1px solid var(--am);border-radius:99px;padding:2px 8px">leitura local' + dica('<b>Leitura local:</b> esta analise foi feita dentro do navegador, com as regras basicas. A analise completa roda no servidor da Seller.IA e traz o diagnostico da propria Shopee, o piso de ROAS pela sua margem e a leitura por formato de anuncio. Clique em Analisar na aba Especialista para trazer.') + '</span>';
  }

  /* ==================== RELATORIO ====================
     Junta os dois periodos, manda para o cerebro e recebe o relatorio
     pronto. O prompt e a chave da API ficam no servidor. */
  function mesesDisponiveis() {
    var out = [], hoje = new Date();
    // comeca em i=0 (mes corrente) so se ja houver ao menos um dia fechado
    for (var i = (hoje.getDate() > 1 ? 0 : 1); i < 12; i++) {
      var d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
      out.push({
        v: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'),
        r: ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][d.getMonth()] + '/' + d.getFullYear()
      });
    }
    return out;
  }
  function epochDoMes(v) {
    var p = String(v).split('-'), y = +p[0], m = +p[1];
    // BRT = UTC-3, entao 00:00 local e 03:00 UTC
    var ini = Date.UTC(y, m - 1, 1, 3, 0, 0) / 1000;
    var fimMes = Date.UTC(y, m, 1, 3, 0, 0) / 1000;   // 00:00 do dia 1 do mes seguinte
    var hoje0 = inicioDoDiaBRT(Math.floor(Date.now() / 1000));
    // a Shopee so entrega ate D-1; nunca pedir alem disso
    var fim = Math.min(fimMes, hoje0);
    // mes ainda nao comecado devolveria fim ANTES do inicio, e a rota
    // responderia erro ou vazio sem dizer por que
    if (fim <= ini) return null;
    return { inicio: ini, fim: fim };
  }
  function faixaDoMes(v) {
    var p = String(v).split('-'), y = +p[0], m = +p[1];
    var ini = new Date(y, m - 1, 1), fim = new Date(y, m, 0);
    function f(d) { return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear(); }
    return { de: f(ini), ate: f(fim), rotulo: f(ini) + ' - ' + f(fim) };
  }
  function mesAnterior(v) {
    var p = String(v).split('-'), d = new Date(+p[0], +p[1] - 2, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function numeroPuro(x) {
    if (x == null) return null;
    if (typeof x === 'number') return isFinite(x) ? x : null;
    var bruto = String(x).trim();
    // A Shopee abrevia numero grande na tela: "12,5 mil" e "1.2K". Sem tratar,
    // 12,5 mil virava 12,5 e 1.2K virava 12 — o relatorio receberia doze reais
    // onde sao mil e duzentos, sem nenhum erro aparecer.
    var mult = 1;
    if (/\bmi(l?h(o|õ)es?)?\b/i.test(bruto) && !/\bmil\b/i.test(bruto)) mult = 1000000;
    else if (/\bmil\b/i.test(bruto)) mult = 1000;
    else if (/\d\s*K\b/i.test(bruto)) mult = 1000;
    else if (/\d\s*M\b/.test(bruto)) mult = 1000000;
    var s = bruto.replace(/\b(mil|mi|milh(o|õ)es?|K|M)\b/gi, '').replace(/[R$\s%x]/gi, '');
    if (mult > 1) {
      // com multiplicador, o separador decimal e a virgula e o ponto tambem
      s = s.replace(',', '.');
      var partes = s.split('.');
      if (partes.length === 2) s = partes[0] + '.' + partes[1];
    } else {
      s = s.replace(/\./g, '').replace(',', '.');
    }
    var n = parseFloat(s);
    return isFinite(n) ? n * mult : null;
  }
  function blocoPeriodo(rotulo) {
    // usa o que esta coletado no estado atual
    var c = (estado.conta && estado.conta.campos) || {};
    var prods = [], id;
    for (id in estado.produtos) {
      var p = estado.produtos[id], m = (p && p.metricas) || {};
      if (!p || !p.nome) continue;
      prods.push({
        nome: String(p.nome).slice(0, 80), id: id,
        visitantes: numeroPuro(m.visitantes), cliques: numeroPuro(m.cliques),
        carrinho: numeroPuro(m.carrinho), unidades: numeroPuro(m.pedidos_pagos),
        vendas: numeroPuro(m.vendas_pagas), conversao: numeroPuro(m.conversao_pago)
      });
    }
    prods.sort(function (a, b) { return (b.vendas || 0) - (a.vendas || 0); });

    var camps = [], k, fmtCont = {};
    for (k in estado.campanhas) {
      var cp = estado.campanhas[k], rp = (cp && cp.report) || {};
      if (!cp) continue;
      var g = numeroPuro(rp.gasto), ped = numeroPuro(rp.broad_order), ro = numeroPuro(rp.broad_roi);
      var fm = cp.type === 'product_mpd' ? 'Grupo de Anuncios'
        : cp.type === 'shop_auto' ? 'Anuncio Automatico de Loja'
        : cp.type === 'shop_manual' ? 'Busca de Loja'
        : (cp.subtype ? 'GMV Max Meta de ROAS' : 'GMV Max Automatico');
      if (!fmtCont[fm]) fmtCont[fm] = { rotulo: fm, qtd: 0, gasto: 0, gmvS: 0 };
      fmtCont[fm].qtd++; fmtCont[fm].gasto += (g || 0); fmtCont[fm].gmvS += (g || 0) * (ro || 0);
      camps.push({
        nome: String(cp.nome || cp.titulo || k).slice(0, 70), produtoId: cp.produtoId || null, formato: fm,
        gasto: g, gmv: (g != null && ro != null) ? g * ro : null, roas: ro,
        roasDireto: numeroPuro(rp.direct_roi), pedidos: ped,
        cpa: (g != null && ped) ? g / ped : null,
        metaAtual: numeroPuro(cp.metaAtual), metaSugerida: numeroPuro(cp.metaSugerida)
      });
    }
    camps.sort(function (a, b) { return (b.gasto || 0) - (a.gasto || 0); });
    var formatos = []; for (k in fmtCont) { var f = fmtCont[k]; formatos.push({ rotulo: f.rotulo, qtd: f.qtd, gasto: f.gasto, roas: f.gasto ? f.gmvS / f.gasto : null }); }

    var inv = numeroPuro(c.ads_invest), pedAds = numeroPuro(c.ads_pedidos), gmvAds = numeroPuro(c.ads_gmv);
    return {
      periodo: rotulo,
      conta: {
        gmvPago: numeroPuro(c.vendas), pedidosPagos: numeroPuro(c.pedidos), visitantes: numeroPuro(c.uv),
        conversaoPaga: numeroPuro(c.conv), ticketMedio: numeroPuro(c.ticket), cancelamentos: numeroPuro(c.cancelados),
        visualizacoes: numeroPuro(c.pv), carrinho: numeroPuro(c.atc)
      },
      ads: {
        investimento: inv, impressoes: numeroPuro(c.impr), cliques: numeroPuro(c.cliques_ads),
        ctr: numeroPuro(c.ctr), gmvPainel: gmvAds, gmvReal: numeroPuro(c.ads_gmv_real),
        pedidos: pedAds, roasPainel: numeroPuro(c.roas), roasReal: numeroPuro(c.roas_real),
        cpa: (inv != null && pedAds) ? inv / pedAds : null
      },
      afiliados: {
        gmv: numeroPuro(c.afil_vendas), comissao: numeroPuro(c.afil_comissao),
        pedidos: numeroPuro(c.afil_pedidos), novosCompradores: numeroPuro(c.afil_novos), roi: numeroPuro(c.afil_roi)
      },
      produtos: prods, campanhas: camps, formatos: formatos
    };
  }
  function renderRelatorio() {
    var R = estado.rel;
    var h = capa('DIAGNOSTICO COMPLETO', 'O', 'RELATORIO', '06');

    if (R.markdown) {
      h += '<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">' +
        '<button id="sia-rel-pdf" style="background:var(--mk);border:none;color:#fff;font-family:inherit;font-weight:600;font-size:13.5px;padding:11px 18px;border-radius:9px;cursor:pointer">Salvar em PDF</button>' +
        '<button id="sia-rel-copiar" style="background:var(--b2);border:1px solid var(--li);color:var(--t1);font-family:inherit;font-size:13.5px;padding:11px 16px;border-radius:9px;cursor:pointer">Copiar texto</button>' +
        '<button id="sia-rel-novo" style="background:var(--b2);border:1px solid var(--li);color:var(--t1);font-family:inherit;font-size:13.5px;padding:11px 16px;border-radius:9px;cursor:pointer">Gerar outro</button></div>';
      h += '<div id="sia-rel-corpo" style="background:var(--b2);border:1px solid var(--li);border-radius:12px;padding:18px;font-size:14px;line-height:1.65;color:var(--t1);max-height:62vh;overflow:auto">' + mdParaHtml(R.markdown) + '</div>';
      return h;
    }

    var meses = mesesDisponiveis();
    var sel = R.mes || meses[1].v;
    var fa = faixaDoMes(sel), fp = faixaDoMes(mesAnterior(sel));

    h += '<div class="leitura"><div class="fr">Relatorio completo da conta.</div>' +
      '<div class="ex">Compara o mes escolhido com o anterior e devolve o diagnostico no formato dos seus relatorios, com plano tatico de 30 dias e projecao com lucro.</div></div>';

    h += olho('MES DO RELATORIO');
    h += '<select id="sia-rel-mes" style="width:100%;background:var(--b2);border:1px solid var(--li);border-radius:9px;padding:12px;color:var(--t0);font-family:inherit;font-size:14px;margin-bottom:10px">';
    for (var i = 0; i < meses.length; i++) h += '<option value="' + meses[i].v + '"' + (meses[i].v === sel ? ' selected' : '') + '>' + meses[i].r + '</option>';
    h += '</select>';
    h += '<div class="nota">Atual: <b>' + fa.rotulo + '</b><br>Anterior: <b>' + fp.rotulo + '</b></div>';

    var nC = Object.keys(estado.campanhas).length, nP = Object.keys(estado.produtos).length;
    if (!nC && !nP) {
      h += '<div class="nota" style="color:var(--am)">Colete a conta antes de gerar o relatorio.</div>';
      return h;
    }

    h += '<div style="background:var(--b2);border-left:3px solid var(--vd);border-radius:0 11px 11px 0;padding:13px 15px;margin:14px 0;font-size:13.5px;color:var(--t1);line-height:1.55">' +
      '<b style="color:var(--t0)">A coleta e automatica.</b> Ao gerar, a Seller.IA le os dois meses direto da Shopee, um de cada vez, sem voce precisar trocar nada no painel. ' +
      'Leva alguns minutos porque sao duas leituras completas da conta.</div>';

    h += '<button id="sia-rel-gerar" ' + (R.gerando ? 'disabled ' : '') +
      'style="width:100%;background:var(--mk);border:none;color:#fff;font-family:inherit;font-weight:700;font-size:15px;padding:15px;border-radius:11px;cursor:pointer' + (R.gerando ? ';opacity:.6' : '') + '">' +
      (R.gerando ? (R.etapa || 'Gerando...') : 'Gerar relatorio') + '</button>';
    if (R.erro) h += '<div class="nota" style="color:var(--rd)">' + esc(R.erro) + '</div>';
    if (R.gerando) h += '<div class="nota">O relatorio leva de 30 a 90 segundos. Pode deixar a gaveta aberta.</div>';
    return h;
  }
  function mdParaHtml(md) {
    var s = esc(md);
    s = s.replace(/^#### (.*)$/gm, '<div style="font-size:14px;font-weight:600;color:var(--t0);margin:14px 0 5px">$1</div>');
    s = s.replace(/^### (.*)$/gm, '<div style="font-size:16px;font-weight:600;color:var(--t0);margin:18px 0 6px">$1</div>');
    s = s.replace(/^## (.*)$/gm, '<div style="font-family:Bebas Neue,sans-serif;font-size:24px;color:var(--t0);margin:22px 0 8px;letter-spacing:.02em">$1</div>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<b style="color:var(--t0)">$1</b>');
    s = s.replace(/^\s*[-*] (.*)$/gm, '<div style="padding-left:14px;position:relative;margin:3px 0">&bull; $1</div>');
    // tabelas markdown
    s = s.replace(/(^\|.*\|\s*$\n?)+/gm, function (bloco) {
      var linhas = bloco.trim().split('\n').filter(function (l) { return !/^\s*\|[\s|:-]+\|\s*$/.test(l); });
      var out = '<table style="width:100%;border-collapse:collapse;font-size:12.5px;margin:10px 0">';
      linhas.forEach(function (l, i) {
        var cels = l.replace(/^\||\|$/g, '').split('|');
        out += '<tr>';
        cels.forEach(function (c) {
          out += i === 0
            ? '<th style="text-align:left;padding:7px 6px;border-bottom:1px solid var(--li);color:var(--t2);font-family:Space Mono,monospace;font-size:9.5px;font-weight:400">' + c.trim() + '</th>'
            : '<td style="padding:7px 6px;border-bottom:1px solid var(--li);color:var(--t1)">' + c.trim() + '</td>';
        });
        out += '</tr>';
      });
      return out + '</table>';
    });
    s = s.replace(/\n{2,}/g, '<div style="height:9px"></div>');
    return s;
  }
  function ligarRelatorio() {
    var m = $('sia-rel-mes');
    if (m) m.addEventListener('change', function () { estado.rel.mes = m.value; render(); });

    var g = $('sia-rel-gerar');
    if (g) g.addEventListener('click', function () {
      // sem esta trava, dois cliques rapidos disparam duas geracoes que
      // competem pelo mesmo estado.campanhas e misturam os periodos
      if (estado.rel.gerando) return;
      if (estado.coletaProgresso !== null) {
        estado.rel.erro = 'Ja existe uma leitura em andamento. Espere ela terminar.'; render(); return;
      }
      var meses = mesesDisponiveis();
      var sel = estado.rel.mes || meses[1].v;
      var fa = faixaDoMes(sel), fp = faixaDoMes(mesAnterior(sel));
      if (!epochDoMes(sel) || !epochDoMes(mesAnterior(sel))) {
        estado.rel.erro = 'Este mes ainda nao tem dia fechado na Shopee. Escolha outro.'; render(); return;
      }
      if (!estado.loja || !estado.loja.shop_id) {
        estado.rel.erro = 'Ainda nao identifiquei a loja. Navegue uma vez pelo painel da Shopee e tente de novo.'; render(); return;
      }
      estado.rel.gerando = true; estado.rel.erro = null; render();

      // Coleta os DOIS meses sozinha, um de cada vez. Antes o seletor so
      // rotulava o relatorio e os numeros vinham do recorte aberto no painel
      // — o mesmo bloco ia como "atual" e como "anterior", e o comparativo
      // era uma comparacao do mes com ele mesmo.
      var guardaCampanhas = estado.campanhas, guardaProdutos = estado.produtos, guardaConta = estado.conta;
      function restaurar() { estado.campanhas = guardaCampanhas; estado.produtos = guardaProdutos; estado.conta = guardaConta; }
      function zerar() { estado.campanhas = {}; estado.produtos = {}; estado.conta = { campos: {}, atualizadoEm: null }; }

      estado.rel.etapa = 'Lendo ' + faixaDoMes(sel).rotulo + '...'; render();
      zerar();
      coletaCompleta(function (p) {
        if (p) { estado.rel.etapa = 'Mes atual: ' + p; render(); }
      }, epochDoMes(sel));

      // a coleta avisa o fim passando null no progresso; encadeamos por espera
      // TETO DE TEMPO: sem isto, coleta travada deixava o botao em "Gerando"
      // para sempre e o snapshot da conta nunca voltava — o analista perdia
      // o que estava vendo na tela.
      var LIMITE_MS = 6 * 60 * 1000;
      var t0 = Date.now();
      function desistir(motivo) {
        estado.rel.gerando = false; estado.rel.etapa = '';
        estado.rel.erro = motivo;
        restaurar(); render();
      }
      var esperaA = setInterval(function () {
        if (Date.now() - t0 > LIMITE_MS) { clearInterval(esperaA); desistir('A leitura do mes atual demorou demais e foi interrompida. Os dados da tela foram preservados.'); return; }
        if (estado.coletaProgresso !== null) return;
        clearInterval(esperaA);
        var blocoA = blocoPeriodo(fa.rotulo);
        if (!Object.keys(estado.campanhas).length && !Object.keys(estado.produtos).length) {
          desistir('Nao consegui ler dados de ' + fa.rotulo + '. Verifique se voce esta na conta certa e se ha movimento nesse mes.');
          return;
        }

        estado.rel.etapa = 'Lendo ' + faixaDoMes(mesAnterior(sel)).rotulo + '...'; render();
        zerar();
        // respiro entre as duas leituras completas: sao ~60 chamadas seguidas
        // e emendar uma na outra e o jeito mais rapido de tomar bloqueio
        setTimeout(function () {
        coletaCompleta(function (p) {
          if (p) { estado.rel.etapa = 'Mes anterior: ' + p; render(); }
        }, epochDoMes(mesAnterior(sel)));
        }, 3000);

        var t1 = Date.now();
        var esperaB = setInterval(function () {
          if (Date.now() - t1 > LIMITE_MS) { clearInterval(esperaB); desistir('A leitura do mes anterior demorou demais e foi interrompida. Os dados da tela foram preservados.'); return; }
          if (estado.coletaProgresso !== null) return;
          clearInterval(esperaB);
          var blocoB = blocoPeriodo(fp.rotulo);
          restaurar();

          estado.rel.etapa = 'O consultor esta escrevendo...'; render();
          var payload = {
            loja: estado.loja ? estado.loja.shop_id : 'desconhecida',
            loja_nome: estado.loja ? estado.loja.nome : '',
            margemMediaPct: margemMediaCofre(),
            atual: blocoA,
            anterior: blocoB
          };
          try {
            chrome.runtime.sendMessage({ tipo: 'sia:relatorio', payload: payload }, function (resp) {
              void chrome.runtime.lastError;
              estado.rel.gerando = false; estado.rel.etapa = '';
              if (!resp || !resp.ok) { estado.rel.erro = (resp && (resp.erro || resp.detalhe)) || 'Nao consegui gerar.'; }
              else { estado.rel.markdown = resp.markdown; estado.rel.loja = estado.loja ? estado.loja.shop_id : null; }
              render();
            });
          } catch (e) { estado.rel.gerando = false; estado.rel.erro = String(e); restaurar(); render(); }
        }, 900);
      }, 900);
    });

    var pdf = $('sia-rel-pdf');
    if (pdf) pdf.addEventListener('click', function () { imprimirRelatorio(); });
    var cp = $('sia-rel-copiar');
    if (cp) cp.addEventListener('click', function () {
      try { navigator.clipboard.writeText(estado.rel.markdown || ''); cp.textContent = 'Copiado'; setTimeout(function () { cp.textContent = 'Copiar texto'; }, 1800); } catch (e) { /* noop */ }
    });
    var nv = $('sia-rel-novo');
    if (nv) nv.addEventListener('click', function () { estado.rel.markdown = null; render(); });
  }
  function imprimirRelatorio() {
    var w = window.open('', '_blank');
    if (!w) { mostrarExpl('<b>O navegador bloqueou a janela.</b> Libere pop-ups para este site e tente de novo.'); return; }
    var nome = (estado.loja && estado.loja.nome) || 'Loja';
    w.document.write('<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatorio ' + esc(nome) + '</title>' +
      '<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">' +
      '<style>@page{margin:16mm}body{font-family:Outfit,Arial,sans-serif;font-weight:300;color:#15161a;line-height:1.6;max-width:820px;margin:0 auto;padding:24px;font-size:12pt}' +
      'h1{font-family:Bebas Neue;font-size:30pt;letter-spacing:.02em;margin:0 0 4px}' +
      'table{width:100%;border-collapse:collapse;margin:10px 0;font-size:10pt}' +
      'th{text-align:left;padding:7px 6px;border-bottom:2px solid #15161a;font-size:8.5pt;text-transform:uppercase;letter-spacing:.05em;font-weight:600}' +
      'td{padding:7px 6px;border-bottom:1px solid #ddd}' +
      'b{font-weight:600}.cab{border-bottom:3px solid #ff4d1c;padding-bottom:10px;margin-bottom:18px}' +
      '.mk{color:#ff4d1c}.rod{margin-top:26px;padding-top:10px;border-top:1px solid #ddd;font-size:8.5pt;color:#777}' +
      '@media print{.noprint{display:none}}</style></head><body>' +
      '<div class="cab"><h1>SELLER<span class="mk">.IA</span></h1><div style="font-size:10pt;color:#666">Relatorio de analise de conta &middot; ' + esc(nome) + ' &middot; gerado em ' + new Date().toLocaleDateString('pt-BR') + '</div></div>' +
      '<div class="noprint" style="background:#f4f2ee;border-radius:8px;padding:11px 14px;margin-bottom:18px;font-size:10pt">Use <b>Imprimir &rarr; Salvar como PDF</b>. Esta faixa nao sai na impressao.</div>' +
      mdParaHtmlImpressao(estado.rel.markdown || '') +
      '<div class="rod">Seller.IA &middot; Efeito Vendas</div></body></html>');
    w.document.close();
    setTimeout(function () { try { w.print(); } catch (e) { /* noop */ } }, 700);
  }
  function mdParaHtmlImpressao(md) {
    return mdParaHtml(md)
      .replace(/var\(--t0\)/g, '#15161a').replace(/var\(--t1\)/g, '#333')
      .replace(/var\(--t2\)/g, '#777').replace(/var\(--li\)/g, '#ddd')
      .replace(/Bebas Neue,sans-serif/g, 'Bebas Neue');
  }

  /* ==================== MULTICONTA ====================
     Uma agencia com 170 contas troca de loja dezenas de vezes por dia na
     mesma guia. Duas coisas precisam ser verdade sempre:
     1. o dado de uma conta NUNCA aparece sob o nome de outra;
     2. voltar para uma conta ja lida nao obriga a coletar de novo. */
  function contaVazia() {
    return { campanhas: {}, produtos: {}, conta: { campos: {}, atualizadoEm: null }, diagnostico: null, lidoEm: null };
  }
  function guardarConta(id) {
    if (!id) return;
    var foto = {
      campanhas: estado.campanhas, produtos: estado.produtos,
      conta: estado.conta, diagnostico: estado.diagnostico, lidoEm: estado.lidoEm || null
    };
    estado.contas[id] = foto;
    // TETO NA MEMORIA DA GUIA: os brutos ja tinham limite, os snapshots nao.
    // Uma agencia trocando 40 contas num turno acumulava tudo na aba.
    // O disco continua guardando 40; aqui basta o giro recente.
    var idsMem = Object.keys(estado.contas);
    if (idsMem.length > 8) {
      idsMem.sort(function (a, b) {
        return ((estado.contas[b] && estado.contas[b].lidoEm) || 0) - ((estado.contas[a] && estado.contas[a].lidoEm) || 0);
      });
      for (var dm = 8; dm < idsMem.length; dm++) {
        if (idsMem[dm] !== id) delete estado.contas[idsMem[dm]];
      }
    }
    // persiste em disco: trocar de conta no Seller Center recarrega a pagina,
    // e sem disco a memoria da guia morre e o time recoleta tudo de novo.
    try {
      chrome.runtime.sendMessage({ tipo: 'sia:conta-salvar', loja: id, dados: foto }, function () { void chrome.runtime.lastError; });
    } catch (e) { /* noop */ }
  }
  function restaurarConta(id) {
    var g = estado.contas[id] || contaVazia();
    estado.campanhas = g.campanhas; estado.produtos = g.produtos;
    estado.conta = g.conta; estado.diagnostico = g.diagnostico; estado.lidoEm = g.lidoEm;
    estado.espiao = { termo: '', buscando: false, erro: null, res: null, radar: null };
    estado.card = null; estado.cofre = { custos: {}, embalagem: 0, imposto: 0 };
    estado.vereditos = null; estado.fonteVeredito = 'local'; estado.versaoRegras = null;
    if (estado.rel && estado.rel.loja && estado.rel.loja !== id) {
      estado.rel.markdown = null; estado.rel.erro = null; estado.rel.loja = null;
    }
    if (estado.contas[id]) return;   // memoria da guia tinha, nao precisa do disco
    try {
      chrome.runtime.sendMessage({ tipo: 'sia:conta-carregar', loja: id }, function (r) {
        void chrome.runtime.lastError;
        if (!r || !r.dados) return;
        if (!estado.loja || estado.loja.shop_id !== id) return;  // trocou de novo no meio
        var d = r.dados;
        estado.campanhas = d.campanhas || {}; estado.produtos = d.produtos || {};
        estado.conta = d.conta || { campos: {}, atualizadoEm: null };
        estado.diagnostico = d.diagnostico || null;
        estado.lidoEm = d.lidoEm || r.em || null;
        estado.contas[id] = d;
        estado.sujo = true;
        agendarAutoColeta();
      });
    } catch (e) { /* noop */ }
  }
  function aplicarLoja(nova) {
    var antigo = estado.loja ? estado.loja.shop_id : null;
    // Se o relatorio esta lendo periodos e a conta muda, os dois blocos
    // ficariam de lojas diferentes. Aborta com aviso em vez de gerar
    // um relatorio que mistura clientes.
    if (antigo && nova.shop_id !== antigo && estado.rel && estado.rel.gerando) {
      estado.rel.gerando = false; estado.rel.etapa = '';
      estado.rel.erro = 'A conta mudou no meio da leitura e o relatorio foi cancelado. Gere novamente na conta certa.';
    }
    if (antigo === nova.shop_id) {
      if (nova.nome && !estado.loja.nome) { estado.loja.nome = nova.nome; estado.sujo = true; }
      return;
    }
    if (antigo) guardarConta(antigo);           // congela o que ja foi lido
    estado.loja = nova;
    restaurarConta(nova.shop_id);               // traz o que existia, ou zera
    carregarCofre();                            // o cofre e por loja
    estado.trocou = { de: antigo, para: nova.shop_id, nome: nova.nome, em: Date.now() };
    estado.sujo = true;
    try { console.debug('[Seller.IA] conta:', nova.shop_id, nova.nome || ''); } catch (e) { /* noop */ }
    // NAO exigir `antigo`: ao ENTRAR numa conta, antigo e null e a auto-coleta
    // nunca disparava — ela so funcionava trocando de uma conta para outra,
    // que e justamente o caso menos comum.
    if (estado.autoColeta) agendarAutoColeta();
  }
  /* ---- AUTO-COLETA ----
     Dispara sozinha quando a conta e identificada, desde que ela ainda nao
     tenha sido lida nesta sessao. Espera o painel assentar e nao repete. */
  var autoColetaFeita = {};
  function agendarAutoColeta() {
    if (!estado.autoColeta || !estado.loja) return;
    var id = estado.loja.shop_id;
    if (autoColetaFeita[id]) return;                       // ja rodou nesta sessao
    if (estado.coletaProgresso !== null) return;           // ja tem coleta rodando
    if (estado.rel && estado.rel.gerando) return;          // o relatorio zera o estado
                                                           // entre os dois meses; disparar
                                                           // aqui bagunçaria os periodos
    var temDado = Object.keys(estado.campanhas).length || Object.keys(estado.produtos).length;
    if (temDado) { autoColetaFeita[id] = true; return; }   // veio do disco, nao precisa
    autoColetaFeita[id] = true;
    setTimeout(function () {
      if (!estado.loja || estado.loja.shop_id !== id) return;   // trocou no meio
      try { coletaCompleta(); } catch (e) { /* noop */ }
    }, 2500);
  }

  function lidoHa() {
    if (!estado.lidoEm) return null;
    var m = Math.round((Date.now() - estado.lidoEm) / 60000);
    if (m < 1) return 'agora';
    if (m < 60) return 'ha ' + m + ' min';
    var h = Math.round(m / 60);
    return h < 24 ? 'ha ' + h + 'h' : 'ha ' + Math.round(h / 24) + 'd';
  }
  function renderChamadaCerebro() {
    if (estado.fonteVeredito === 'cerebro') return '';
    if (!Object.keys(estado.campanhas).length && !Object.keys(estado.produtos).length) return '';
    return '<div style="background:var(--b2);border:1px solid var(--li);border-radius:11px;padding:13px;margin-top:14px">' +
      '<div style="font-size:14px;color:var(--t0);font-weight:500;margin-bottom:4px">A analise completa ainda nao rodou</div>' +
      '<div style="font-size:13px;color:var(--t2);line-height:1.5;margin-bottom:10px">O que esta na tela e a leitura local. A completa traz o diagnostico da propria Shopee, o piso de ROAS pela sua margem e a leitura por formato de anuncio.</div>' +
      '<button id="sia-analisar-agora" style="background:var(--mk);border:none;color:#fff;font-weight:600;font-size:13px;padding:9px 16px;border-radius:8px;cursor:pointer">' +
      (estado.analisando ? 'Analisando...' : 'Analisar esta conta') + '</button></div>';
  }
  function ligarChamadaCerebro() {
    var b = $('sia-analisar-agora');
    if (!b) return;
    b.addEventListener('click', function () {
      if (estado.analisando) return;
      estado.analisando = true; render();
      try {
        chrome.runtime.sendMessage({ tipo: 'sia:analisar', payload: payloadCerebro() }, function (resp) {
          void chrome.runtime.lastError;
          estado.analisando = false;
          guardarVereditos(resp);
          if (!resp || !resp.ok) mostrarExpl('<b>Nao consegui falar com a analise completa.</b> ' + esc((resp && resp.erro) || 'Sem resposta.') + ' A leitura local continua valendo.');
          render();
        });
      } catch (e) { estado.analisando = false; render(); }
    });
  }
  /* ---- AUDITORIA LOCAL DA COLETA ----
     Mesma defesa do cerebro, para quando ele nao responde: se a coleta
     terminou mas o que chegou nao tem os campos esperados, e mais provavel
     que a Shopee tenha mudado algo do que a conta estar realmente vazia. */
  function auditarColeta() {
    var nC = 0, comRoas = 0, comGasto = 0, nP = 0, comFunil = 0, k;
    for (k in estado.campanhas) {
      nC++;
      var m = estado.campanhas[k].metricas || {};
      if (m.roas != null) comRoas++;
      if (m.gasto != null) comGasto++;
    }
    for (k in estado.produtos) {
      nP++;
      var pm = estado.produtos[k].metricas || {};
      if (pm.visitantes != null || pm.uv != null) comFunil++;
    }
    var av = [];
    if (nC >= 5 && comRoas === 0) av.push('Nenhuma das ' + nC + ' campanhas trouxe retorno.');
    if (nC >= 5 && comGasto === 0) av.push('Nenhuma campanha trouxe valor investido.');
    if (nP >= 5 && comFunil === 0) av.push('Nenhum dos ' + nP + ' produtos trouxe dado de visita.');
    return av;
  }
  function renderAvisoLeitura() {
    var av = auditarColeta();
    var uc = estado.ultimaColeta;
    if (uc && uc.falhas > 0 && (uc.falhas / (uc.ok + uc.falhas)) > 0.25) {
      av.unshift(uc.falhas + ' de ' + (uc.ok + uc.falhas) + ' consultas a Shopee falharam nesta leitura.');
    }
    if (!av.length) return '';
    return '<div style="background:color-mix(in srgb,var(--rd) var(--tin,9%),var(--b2));border:1px solid var(--rd);border-left:3px solid var(--rd);border-radius:12px;padding:15px 16px;margin-bottom:14px">' +
      '<div style="font-size:16px;font-weight:600;color:var(--t0);margin-bottom:5px">A leitura desta conta pode estar incompleta</div>' +
      '<div style="font-size:14px;color:var(--t1);line-height:1.55">' + esc(av.join(' ')) +
      ' A Shopee pode ter mudado algo no painel. <b>Enquanto isso nao for verificado, a ausencia de alertas nesta tela nao significa que esta tudo bem.</b></div></div>';
  }

  function renderBannerConta() {
    if (!estado.loja) {
      return '<div style="background:var(--b2);border-left:3px solid var(--am);border-radius:0 10px 10px 0;padding:11px 13px;margin-bottom:12px;font-size:13px;color:var(--t1)">Identificando a loja... navegue uma vez no painel para a Seller.IA reconhecer a conta.</div>';
    }
    var n = Object.keys(estado.campanhas).length, p = Object.keys(estado.produtos).length;
    var vazio = (n + p) === 0;
    var trocouAgora = estado.trocou && (Date.now() - estado.trocou.em) < 600000;
    if (!vazio && !trocouAgora) return '';
    var cor = vazio ? 'var(--am)' : 'var(--vd)';
    var rodando = estado.coletaProgresso !== null;
    if (vazio && rodando) {
      return '<div style="background:var(--b2);border-left:3px solid var(--mk);border-radius:0 10px 10px 0;padding:11px 13px;margin-bottom:12px;font-size:13px;color:var(--t1);line-height:1.5">' +
        'Lendo <b>' + esc(estado.loja.nome || ('loja ' + estado.loja.shop_id)) + '</b> agora \u2014 ' + esc(String(estado.coletaProgresso)) + '</div>';
    }
    var txt = vazio
      ? '<b>' + esc(estado.loja.nome || ('loja ' + estado.loja.shop_id)) + '</b> ainda nao foi lida nesta sessao.'
      : '<b>' + esc(estado.loja.nome || ('loja ' + estado.loja.shop_id)) + '</b> — dado desta conta, lido ' + (lidoHa() || 'agora') + '.';
    return '<div style="background:var(--b2);border-left:3px solid ' + cor + ';border-radius:0 10px 10px 0;padding:11px 13px;margin-bottom:12px;font-size:13px;color:var(--t1);line-height:1.5">' + txt +
      (vazio ? ' <button id="sia-coletar-agora" style="background:var(--mk);border:none;color:var(--t0);font-weight:600;font-size:12px;padding:6px 12px;border-radius:7px;cursor:pointer;margin-left:6px">Coletar esta conta</button>' : '') +
      '<div style="font-family:Space Mono,monospace;font-size:10.5px;color:var(--t2);margin-top:6px">' +
      '<label style="cursor:pointer"><input type="checkbox" id="sia-auto-troca"' + (estado.autoColeta ? ' checked' : '') + '> ler a conta sozinha ao abrir</label>' +
      ' &nbsp;·&nbsp; <a href="#" id="sia-limpar-contas" style="color:var(--t2);text-decoration:underline">apagar dados de todas as contas</a></div></div>';
  }
  function ligarBannerConta() {
    var b = $('sia-coletar-agora');
    if (b) b.addEventListener('click', function () { try { coletaCompleta(); } catch (e) { /* noop */ } });
    var lc = $('sia-limpar-contas');
    if (lc) lc.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (!confirm('Apagar os dados guardados de TODAS as contas nesta maquina? A coleta atual continua.')) return;
      try { chrome.runtime.sendMessage({ tipo: 'sia:contas-limpar' }, function (r) { void chrome.runtime.lastError; estado.contas = {}; alert('Apagado. ' + ((r && r.apagadas) || 0) + ' registros removidos.'); }); } catch (e) { /* noop */ }
    });
    var c = $('sia-auto-troca');
    if (c) c.addEventListener('change', function () {
      estado.autoColeta = c.checked;
      try { chrome.runtime.sendMessage({ tipo: 'sia:pref-salvar', chave: 'autoColeta', valor: c.checked }, function () { void chrome.runtime.lastError; }); } catch (e) { /* noop */ }
    });
  }

  /* ===================== COFRE DE CUSTOS =====================
     Regra de velocidade: 1 campo por produto (o custo), e mais nada.
     Embalagem e imposto sao da LOJA, cadastrados uma vez so e valendo
     pra todos. Cadastrar 3 campos em 150 produtos ninguem faz; 1 campo
     em 10 produtos que respondem por 80% do GMV, faz hoje. */
  function cofreChave() { return estado.loja ? estado.loja.shop_id : 'sem_loja'; }

  function carregarCofre() {
    try {
      chrome.runtime.sendMessage({ tipo: 'sia:cofre-carregar', loja: cofreChave() }, function (r) {
        void chrome.runtime.lastError;
        if (r && r.cofre) { estado.cofre = r.cofre; estado.sujo = true; }
      });
    } catch (e) { /* noop */ }
  }
  function salvarCofre() {
    try {
      chrome.runtime.sendMessage({ tipo: 'sia:cofre-salvar', loja: cofreChave(), cofre: estado.cofre }, function () { void chrome.runtime.lastError; });
    } catch (e) { /* noop */ }
  }
  function custoDe(itemid) {
    var c = estado.cofre && estado.cofre.custos ? estado.cofre.custos[String(itemid)] : null;
    return (typeof c === 'number' && isFinite(c) && c > 0) ? c : null;
  }
  function numBR(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim().replace(/\s/g, '').replace(/R\$/i, '');
    if (!s) return null;
    s = s.replace(/\./g, '').replace(',', '.');   // aceita 1.234,56 e 1234.56
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  function renderCofre() {
    if (!estado.cofre) estado.cofre = { custos: {}, embalagem: 0, imposto: 0 };
    var cf = estado.cofre;
    var C = cofreD();
    var lista = [], id;
    for (id in estado.produtos) {
      var p = estado.produtos[id];
      var m = p.metricas || {};
      lista.push({ id: id, nome: p.nome || ('Produto ' + id), gmv: m.gmv || 0 });
    }
    for (id in (C.porProduto || {})) {
      if (estado.produtos[id]) continue;
      var pd = C.porProduto[id];
      lista.push({ id: id, nome: pd.nome || ('Produto ' + id), gmv: (pd.perf && pd.perf.venda) || 0 });
    }
    lista.sort(function (a, b) { return b.gmv - a.gmv; });

    var preenchidos = 0;
    for (var k = 0; k < lista.length; k++) if (custoDe(lista[k].id)) preenchidos++;

    var h = '';
    h += '<div class="nota" style="margin-top:0">Cadastre o custo <b>uma vez</b> por produto. Embalagem e imposto sao da loja inteira — preenche aqui em cima e vale pra todos. Sem isso, o card mostra teto, nao lucro.</div>';

    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0">' +
      '<div style="background:var(--b2);border:1px solid var(--li);border-radius:10px;padding:10px">' +
      '<div style="font-family:"Space Mono";font-size:10px;color:var(--t2)">EMBALAGEM POR PEDIDO (R$)</div>' +
      '<input id="sia-cf-emb" value="' + (cf.embalagem ? String(cf.embalagem).replace('.', ',') : '') + '" placeholder="0,00" style="width:100%;background:var(--b1);border:1px solid var(--li);border-radius:7px;padding:7px 9px;color:var(--t0);font-family:monospace;font-size:13px;margin-top:5px"></div>' +
      '<div style="background:var(--b2);border:1px solid var(--li);border-radius:10px;padding:10px">' +
      '<div style="font-family:"Space Mono";font-size:10px;color:var(--t2)">IMPOSTO SOBRE A VENDA (%)</div>' +
      '<input id="sia-cf-imp" value="' + (cf.imposto ? String(cf.imposto).replace('.', ',') : '') + '" placeholder="0" style="width:100%;background:var(--b1);border:1px solid var(--li);border-radius:7px;padding:7px 9px;color:var(--t0);font-family:monospace;font-size:13px;margin-top:5px"></div></div>';

    h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:9px">' +
      '<span style="font-family:Space Mono,monospace;font-size:12px;color:var(--t2);letter-spacing:.06em;flex:1">CUSTO POR PRODUTO — ' + preenchidos + ' de ' + lista.length + ' cadastrados</span>' +
      '<button id="sia-cf-salvar" style="background:var(--mk);border:none;color:var(--t0);font-weight:700;font-size:12px;padding:8px 16px;border-radius:8px;cursor:pointer">Salvar</button></div>';

    if (!lista.length) return h + '<div class="vazio">Nenhum produto lido ainda. Rode a coleta na aba Inicio.</div>';

    for (var i = 0; i < lista.length; i++) {
      var it = lista[i];
      var cst = custoDe(it.id);
      h += '<div style="display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid var(--li)">' +
        '<span style="width:6px;height:6px;border-radius:50%;background:' + (cst ? 'var(--vd)' : 'var(--li2)') + ';flex:none"></span>' +
        '<span style="flex:1;font-size:12px;color:var(--t1);min-width:0">' + esc(String(it.nome).slice(0, 46)) + '</span>' +
        (it.gmv ? '<span style="font-family:"Space Mono";font-size:10.5px;color:var(--t2)">' + reais(it.gmv) + '</span>' : '') +
        '<input data-custo="' + esc(it.id) + '" value="' + (cst ? String(cst).replace('.', ',') : '') + '" placeholder="custo" ' +
        'style="width:84px;background:var(--b1);border:1px solid ' + (cst ? 'var(--vd)' : 'var(--li)') + ';border-radius:7px;padding:6px 8px;color:var(--t0);font-family:monospace;font-size:12px;text-align:right"></div>';
    }
    h += '<div class="nota">Comece pelos de cima — eles concentram o faturamento. Nao precisa cadastrar todos hoje.</div>';
    return h;
  }

  function ligarCofre() {
    function coletarCampos() {
      if (!estado.cofre) estado.cofre = { custos: {}, embalagem: 0, imposto: 0 };
      var e = $('sia-cf-emb'), im = $('sia-cf-imp');
      estado.cofre.embalagem = numBR(e && e.value) || 0;
      estado.cofre.imposto = numBR(im && im.value) || 0;
      var campos = $('sia-corpo').querySelectorAll('[data-custo]');
      estado.cofre.custos = estado.cofre.custos || {};
      for (var i = 0; i < campos.length; i++) {
        var id = campos[i].getAttribute('data-custo');
        var v = numBR(campos[i].value);
        if (v && v > 0) estado.cofre.custos[id] = v;
        else delete estado.cofre.custos[id];
      }
    }
    var bt = $('sia-cf-salvar');
    if (bt) bt.addEventListener('click', function () {
      coletarCampos(); salvarCofre();
      bt.textContent = 'Salvo'; bt.style.background = 'var(--vd)';
      setTimeout(function () { render(); }, 800);
    });
  }

  // ATENCAO: toda aba nova precisa entrar aqui. Se abaAtiva nao estiver na
  // lista, o render forca a volta para o Inicio — foi o que aconteceu com
  // 'relatorio' e 'gprod' depois da reorganizacao das abas: a tela abria e
  // fechava sozinha.
  var TELAS_VALIDAS = ['semaforo','conta360','calc','cofre','espiao','card','diagnostico','visao',
    'campanhas','produtos','performance','afiliados','cadastro','diamantes','debug',
    'relatorio','gprod','ferramentas'];
  /* ============ INTELIGENCIA DE PRODUTO (Performance) ============
     Le o funil de cada produto e devolve um veredito, nao uma linha de
     tabela. A ordem das perguntas segue o metodo: primeiro o dinheiro
     em jogo, depois onde o funil vaza. Cada produto sai daqui com uma
     frase que uma pessoa entende e um proximo passo. */
  function pctNorm(v) {
    if (v === undefined || v === null) return null;
    return v <= 1 ? v * 100 : v;
  }
  function diagProduto(id) {
    var p = estado.produtos[id] || {};
    var m = p.metricas || {};
    var C = cofreD();
    var d = (C.porProduto || {})[id] || {};
    var perf = d.perf || {};

    var venda = m.vendas_pagas !== undefined ? m.vendas_pagas : perf.vendaPaga;
    var pedidos = m.pedidos_pagos !== undefined ? m.pedidos_pagos : perf.pedidosPagos;
    var ticket = m.ticket_pedido !== undefined ? m.ticket_pedido : perf.ticket;
    var visitas = m.visitantes !== undefined ? m.visitantes : perf.uv;
    var ctr = pctNorm(m.ctr_card !== undefined ? m.ctr_card : perf.ctr);
    var conv = pctNorm(m.conversao_pago !== undefined ? m.conversao_pago : perf.convPago);
    var rej = pctNorm(m.rejeicao !== undefined ? m.rejeicao : perf.rejeicao);
    var fatia = pctNorm(m.fatia_vendas !== undefined ? m.fatia_vendas : perf.fatiaVendas);
    if (!ticket && venda && pedidos) ticket = venda / pedidos;

    var r = {
      id: id, nome: p.nome || d.nome || ('Produto ' + id),
      venda: venda || 0, pedidos: pedidos, ticket: ticket, visitas: visitas,
      ctr: ctr, conv: conv, rej: rej, fatia: fatia,
      nivel: 'cinza', titulo: '', texto: '', acao: ''
    };

    // sem volume nao se le nada. Dizer isso e melhor que inventar veredito.
    if (!visitas || visitas < 100) {
      r.nivel = 'cinza';
      r.titulo = 'Visitas insuficientes para julgar';
      r.texto = 'Recebeu ' + (visitas ? fmt(visitas, 0) : '0') + ' visitantes no periodo. Com menos de 100, qualquer percentual vira ruido: 1 venda em 3 visitas daria 33% e nao significa nada.';
      r.acao = 'Traga visita antes de tirar conclusao deste produto.';
      return r;
    }

    // 1) o card nao chama: o problema nasce antes da pagina
    if (ctr != null && ctr < 1.8) {
      r.nivel = 'vermelho';
      r.titulo = 'Aparece na vitrine e recebe pouco clique';
      r.texto = 'De cada 100 pessoas que viram este produto na busca, ' + fmt(ctr, 1) + ' clicaram. O normal e ao menos 2.';
      r.acao = 'O que decide o clique e a primeira foto, o preco no card e o comeco do titulo — nesta ordem.';
      return r;
    }
    // 2) clica e nao compra: a pagina e o gargalo
    if (conv != null && conv < 1 && ctr != null && ctr >= 1.8) {
      r.nivel = 'vermelho';
      r.titulo = 'Recebe clique e nao vende';
      r.texto = 'O card funciona: ' + fmt(ctr, 1) + ' de cada 100 clicam. Mas de cada 100 que entram na pagina, menos de 1 compra.';
      r.acao = 'Abra a pagina no celular e compare com o concorrente: preco, variacao sem estoque e avaliacoes sem resposta sao os tres motivos mais comuns.';
      return r;
    }
    // 3) entra e sai na hora
    if (rej != null && rej >= 70) {
      r.nivel = 'amarelo';
      r.titulo = 'A maioria sai sem olhar nada';
      r.texto = 'De cada 100 que entram, ' + fmt(rej, 0) + ' saem sem clicar em nada. Normalmente e porque a pagina nao entrega o que o card prometeu.';
      r.acao = 'Confira se a primeira foto e o titulo descrevem o que a pessoa encontra ao entrar.';
      return r;
    }
    // 4) concentracao de risco
    if (fatia != null && fatia >= 30) {
      r.nivel = 'amarelo';
      r.titulo = fmt(fatia, 0) + '% do faturamento vem deste produto';
      r.texto = 'Se ele perder posicao, sair de estoque ou ganhar um concorrente mais barato, a loja perde ' + fmt(fatia, 0) + '% de uma vez.';
      r.acao = 'Nao mexa neste sem motivo. Coloque esforco no segundo colocado para reduzir a dependencia.';
      return r;
    }
    // 5) ticket abaixo do degrau de comissao
    if (ticket != null && ticket > 0 && ticket < 80) {
      r.nivel = 'amarelo';
      r.titulo = 'Preco na faixa de comissao mais cara';
      r.texto = 'Cada pedido sai a ' + reais(ticket) + '. Ate R$79,99 a Shopee cobra 20% + R$4. Passando de R$80 cai para 14% + R$16 — em muitos casos sobra mais dinheiro vendendo mais caro.';
      r.acao = 'Um kit ou combo que passe de R$80 aumenta a sobra sem precisar de visita nova.';
      return r;
    }
    // 6) converte bem e ninguem esta empurrando
    if (conv != null && conv >= 2) {
      r.nivel = 'verde';
      r.titulo = (d.campaignId || perf.temAds) ? 'Vende bem e ja tem anuncio' : 'Vende bem sem nenhum anuncio';
      r.texto = 'De cada 100 pessoas que entram na pagina, ' + fmt(conv, 1) + ' compram. A media da loja e mais baixa que isso.';
      r.acao = (d.campaignId || perf.temAds) ? 'Suba o orcamento em 20% e reavalie em 7 dias, uma mudanca por vez.' : 'A pagina ja vende sozinha. E o produto mais barato para comecar a anunciar, porque voce paga por visita que ja sabe converter.';
      return r;
    }
    r.nivel = 'verde';
    r.titulo = 'Sem alerta';
    r.texto = (conv != null ? 'De cada 100 que entram, ' + fmt(conv, 1) + ' compram' : 'Nenhum degrau do funil chamou atencao') + (ctr != null ? ', e ' + fmt(ctr, 1) + ' de cada 100 que veem na busca clicam' : '') + '.';
    r.acao = 'Nada urgente aqui.';
    return r;
  }

  function cartaoProduto(c) {
    var co = CORES_SEM[c.nivel] || CORES_SEM.cinza;
    return '<div data-card="produto:' + esc(c.id) + '" style="cursor:pointer;background:' + co.bg + ';border:1px solid ' + co.bd + ';border-left:3px solid ' + co.dot + ';border-radius:14px;padding:18px 19px;margin-bottom:12px">' +
      '<div style="display:flex;align-items:baseline;gap:9px;margin-bottom:6px">' +
      '<span style="flex:1;font-size:17px;font-weight:600;color:var(--t0);line-height:1.3;letter-spacing:-.015em">' + esc(c.titulo) + '</span>' +
      (c.venda ? '<span style="font-family:Space Mono,monospace;font-size:12px;color:var(--t2);flex:none">' + reais(c.venda) + '</span>' : '') +
      '</div>' +
      '<div style="font-size:12.5px;color:var(--t2);margin-bottom:7px;line-height:1.4">' + esc(String(c.nome).slice(0, 70)) + '</div>' +
      '<div style="font-size:14.5px;color:var(--t1);line-height:1.6">' + esc(c.texto) + '</div>' +
      (c.acao ? '<div style="font-size:13.5px;color:' + co.dot + ';margin-top:7px;line-height:1.5">\u2192 ' + esc(c.acao) + '</div>' : '') +
      '</div>';
  }
  function renderPerformanceIA() {
    var ids = Object.keys(estado.produtos).filter(function (id) {
      var mm = estado.produtos[id].metricas || {};
      return mm.visitantes !== undefined || mm.vendas_pagas !== undefined;
    });
    if (!ids.length) {
      return '<div class="vazio">Abra <b>Central de Dados → Performance de Produto</b> e navegue pela lista (role/pagine — a coleta pega o que a tela mostrar).</div>';
    }
    var lidos = [];
    var doCerebro = vereditosDe('produto');
    if (doCerebro.length) {
      // o cerebro julgou: a extensao so desenha
      for (var c = 0; c < doCerebro.length; c++) {
        var vv = doCerebro[c];
        var pr = estado.produtos[vv.id] || {};
        var mm = pr.metricas || {};
        lidos.push({
          id: vv.id, nome: pr.nome || ('Produto ' + vv.id),
          venda: (mm.vendas_pagas !== undefined ? mm.vendas_pagas : (vv.dinheiro || 0)) || 0,
          nivel: vv.nivel, titulo: vv.titulo, texto: vv.texto,
          acao: (vv.passos && vv.passos.length) ? vv.passos.join(' \u00b7 ') : ''
        });
      }
    } else {
      for (var i = 0; i < ids.length; i++) lidos.push(diagProduto(ids[i]));
    }
    // ordem = dinheiro em jogo, nao gravidade. Problema em produto que vende
    // R$8 mil vale mais atencao que problema em produto que vende R$80.
    var peso = { vermelho: 3, amarelo: 2, verde: 1, cinza: 0 };
    lidos.sort(function (a, b) {
      if (peso[a.nivel] !== peso[b.nivel]) return peso[b.nivel] - peso[a.nivel];
      return (b.venda || 0) - (a.venda || 0);
    });
    var cont = { vermelho: 0, amarelo: 0, verde: 0, cinza: 0 };
    for (i = 0; i < lidos.length; i++) cont[lidos[i].nivel]++;

    var CORES = {
      vermelho: { dot: 'var(--rd)', bg: 'rgba(231,76,60,.07)', bd: 'rgba(231,76,60,.25)' },
      amarelo: { dot: 'var(--am)', bg: 'rgba(245,176,65,.07)', bd: 'rgba(245,176,65,.25)' },
      verde: { dot: 'var(--vd)', bg: 'rgba(46,204,113,.07)', bd: 'rgba(46,204,113,.25)' },
      cinza: { dot: 'var(--t3)', bg: 'transparent', bd: 'var(--li)' }
    };
    var travados = cont.vermelho, folga = cont.amarelo, bons = cont.verde;
    var dinheiroTravado = 0;
    for (var dz = 0; dz < lidos.length; dz++) if (lidos[dz].nivel === 'vermelho') dinheiroTravado += (lidos[dz].venda || 0);
    var fr, ex;
    if (travados > 0) {
      fr = '<span class="d">' + travados + ' produto' + (travados > 1 ? 's' : '') + '</span> recebe' + (travados > 1 ? 'm' : '') + ' visita e nao converte.';
      ex = 'Eles somam ' + reais(dinheiroTravado) + ' de venda no periodo. Trazer mais gente para uma pagina que nao fecha so aumenta o custo — o gargalo esta depois do clique.';
    } else if (folga > 0) {
      fr = 'Nenhum produto travado, mas <span class="w">' + folga + '</span> tem gargalo identificado.';
      ex = 'Sao ganhos faceis: faixa de comissao, gente saindo sem olhar ou concentracao de risco.';
    } else {
      fr = '<span class="u">Seu catalogo esta convertendo bem</span>.';
      ex = bons + ' produto' + (bons > 1 ? 's convertem' : ' converte') + ' acima da media da loja. A regra aqui e proteger, nao otimizar.';
    }
    var h = capa('ONDE ESTA O GARGALO', 'FUNIL DE', 'PRODUTO', '02') +
      '<div style="display:flex;align-items:center;gap:8px;margin:16px 0 18px">' + seloFonte() + '</div>' +
      '<div class="leitura"><div class="fr">' + fr + '</div><div class="ex">' + ex + '</div></div>' +
      '<div class="kpis">' +
      '<div class="kpi"><div class="v" style="color:var(--rd)">' + cont.vermelho + '</div><div class="l">Perdendo dinheiro' + dica('<b>Perdendo dinheiro:</b> produtos que recebem visita e quase nao vendem, ou que tiveram queda forte. Cada real gasto neles rende menos que a media da loja. Sao os primeiros a mexer.') + '</div></div>' +
      '<div class="kpi"><div class="v" style="color:var(--am)">' + cont.amarelo + '</div><div class="l">Da pra melhorar' + dica('<b>Da pra melhorar:</b> vendem, mas tem um gargalo identificado — preco na faixa de comissao errada, muita gente saindo sem olhar, ou concentracao de risco. Nao e urgente, e e onde tem ganho facil.') + '</div></div>' +
      '<div class="kpi"><div class="v" style="color:var(--vd)">' + cont.verde + '</div><div class="l">Vendendo bem' + dica('<b>Vendendo bem:</b> convertem acima da media da loja. A regra aqui e nao mexer sem motivo — e proteger, nao otimizar. Se algum deles nao tem anuncio, e por ele que se comeca.') + '</div></div>' +
      '<div class="kpi"><div class="v" style="color:var(--t2)">' + cont.cinza + '</div><div class="l">Sem visita' + dica('<b>Sem visita:</b> menos de 100 visitantes no periodo. Ficam de fora do julgamento de proposito, porque com pouca visita qualquer percentual engana — 1 venda em 3 visitas daria 33% de conversao e nao significa nada.') + '</div></div></div>';

    // Top 3 piores e top 3 melhores na tela; o resto atras de um seletor.
    // Despejar 23 produtos de uma vez nao e informacao, e ruido — o analista
    // nao consegue decidir o que olhar primeiro.
    var piores = lidos.filter(function (x) { return x.nivel === 'vermelho' || x.nivel === 'amarelo'; }).slice(0, 3);
    var melhores = lidos.filter(function (x) { return x.nivel === 'verde'; }).slice(0, 3);
    var vistos = {};
    piores.concat(melhores).forEach(function (x) { vistos[x.id] = true; });
    var resto = lidos.filter(function (x) { return !vistos[x.id]; });

    if (piores.length) {
      h += olho('OS QUE MAIS PRECISAM DE VOCE', '<b>Sao os tres com problema que tem mais dinheiro em jogo.</b> A ordem nao e por gravidade: um problema num produto que fatura R$ 8 mil vem antes de um problema em produto que fatura R$ 80, mesmo que o segundo esteja mais quebrado.');
      piores.forEach(function (c) { h += cartaoProduto(c); });
    }
    if (melhores.length) {
      h += olho('OS QUE ESTAO INDO BEM', 'Convertem acima da media da loja. A regra aqui e proteger, nao otimizar. Se algum deles nao tem Shopee Ads, e por ele que se comeca a investir.');
      melhores.forEach(function (c) { h += cartaoProduto(c); });
    }
    if (resto.length) {
      h += olho('VER UM PRODUTO ESPECIFICO');
      h += '<select id="sia-prod-sel" style="width:100%;background:var(--b2);border:1px solid var(--li);border-radius:10px;padding:13px;color:var(--t0);font-family:inherit;font-size:14px;margin-bottom:11px">' +
        '<option value="">Escolha entre os outros ' + resto.length + ' produtos...</option>';
      resto.forEach(function (c) {
        var marca = c.nivel === 'vermelho' ? '\u25cf ' : (c.nivel === 'amarelo' ? '\u25cb ' : '');
        h += '<option value="' + esc(c.id) + '"' + (estado.prodSel === String(c.id) ? ' selected' : '') + '>' + marca + esc(String(c.nome).slice(0, 52)) + ' \u00b7 ' + reais(c.venda || 0) + '</option>';
      });
      h += '</select>';
      for (var q = 0; q < resto.length; q++) {
        if (String(resto[q].id) === estado.prodSel) h += cartaoProduto(resto[q]);
      }
    }
    h += renderChamadaCerebro();
    h += '<div class="nota">A leitura usa o funil que a Shopee entrega por produto. Produtos com menos de 100 visitantes ficam de fora do julgamento de proposito — abaixo disso, taxa e ruido.</div>';
    return h;
  }

  function render() {
    if (!$('sia-painel').classList.contains('aberto')) return;
    // se por algum caminho a aba ativa virar um id de GRUPO (gprod, ferramentas)
    // ou um id desconhecido, nenhuma branch casa e a tela apaga. Cai no padrao.
    if (SUB[abaAtiva]) abaAtiva = subAtiva[abaAtiva] || SUB[abaAtiva][0].id;
    if (TELAS_VALIDAS.indexOf(abaAtiva) < 0) abaAtiva = 'semaforo';
    renderAbas();
    var corpo = $('sia-corpo');
    var nC = Object.keys(estado.campanhas).length;
    var nP = Object.keys(estado.produtos).length;
    var lojaTxt = estado.loja ? (estado.loja.nome || ('loja ' + estado.loja.shop_id)) : 'identificando a loja...';
    $('sia-info').textContent = lojaTxt + ' · ' + nC + ' campanhas · ' + nP + ' produtos' + (lidoHa() ? ' · lido ' + lidoHa() : '');

    if (abaAtiva === 'semaforo') {
      corpo.innerHTML = renderAvisoLeitura() + renderBannerConta() + renderSemaforo() + renderChamadaCerebro();
      ligarBannerConta();
      ligarChamadaCerebro();
      return;
    }

    if (abaAtiva === 'relatorio') {
      corpo.innerHTML = renderRelatorio();
      ligarRelatorio();
      return;
    }
    if (abaAtiva === 'conta360') {
      corpo.innerHTML = capa('COMO A LOJA ESTA', 'CONTA', '360', '01') + renderFunilLoja() + renderConta360();
      ligarBotaoColeta();
      return;
    }

    if (abaAtiva === 'calc') {
      corpo.innerHTML = capa('QUANTO SOBRA', 'O', 'COFRE', '05') + renderSubAbas('cofre') + renderCalculadora();
      ligarCalculadora();
      return;
    }

    if (abaAtiva === 'cofre') {
      corpo.innerHTML = capa('QUANTO SOBRA', 'O', 'COFRE', '05') + renderSubAbas('cofre') + renderCofre();
      ligarCofre();
      return;
    }

    if (abaAtiva === 'card') {
      corpo.innerHTML = renderCard6();
      return;
    }

    if (abaAtiva === 'espiao') {
      corpo.innerHTML = renderEspiao();
      ligarEspiao();
      return;
    }

    if (abaAtiva === 'diagnostico') {
      var dg = estado.diagnostico;
      var hd = '';
      hd += '<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap">' +
        '<button id="sia-coletar-tudo" style="background:linear-gradient(120deg,var(--mk),var(--px));border:none;color:var(--t0);font-weight:700;font-size:13px;padding:10px 18px;border-radius:8px;cursor:' + (estado.coletaProgresso ? 'wait' : 'pointer') + '">' +
        (estado.coletaProgresso ? esc(estado.coletaProgresso) : 'Coletar conta completa + Analisar') + '</button>' +
        '<button id="sia-analisar" style="background:var(--b2);border:1px solid var(--li2);color:var(--t0);font-weight:600;font-size:12px;padding:10px 14px;border-radius:8px;cursor:pointer">' +
        (estado.analisando ? 'Analisando...' : 'So analisar o ja coletado') + '</button>' +
        '<span class="nota" style="margin:0">' + (dg && dg.rules_version ? 'Regras ' + esc(dg.rules_version) + ' · cerebro no servidor' : 'Envia a coleta ao Cerebro Seller.IA e recebe os vereditos do metodo.') + '</span></div>';
      if (dg && dg.erro) hd += '<div class="nota" style="color:var(--rd)">Falha: ' + esc(dg.erro) + '</div>';
      if (dg && dg.vereditos && dg.vereditos.length) {
        hd += '<div class="nota" style="margin-top:0">Clique em um card para abrir os detalhes.</div>';
        for (var v = 0; v < dg.vereditos.length; v++) {
          var vd = dg.vereditos[v];
          var cor = vd.status === 'forte' ? 'var(--vd)' : (vd.status === 'critico' ? 'var(--rd)' : 'var(--am)');
          hd += '<div class="sia-card-diag" style="border:1px solid var(--li);border-left:3px solid ' + cor + ';border-radius:0 10px 10px 0;background:var(--b2);padding:10px 14px;margin-bottom:8px;cursor:pointer">' +
            '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
              '<span style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;border:1px solid ' + cor + ';color:' + cor + ';border-radius:99px;padding:2px 8px">' + esc(vd.veredito) + '</span>' +
              '<span style="font-size:10px;color:var(--t2)">' + esc(vd.escopo) + (vd.nome ? ' · ' + esc(String(vd.nome).slice(0, 55)) : '') + (vd.id && vd.escopo !== 'conta' && vd.escopo !== 'grupo' ? ' · ID ' + esc(String(vd.id).split(':')[0]) : '') + '</span></div>' +
            '<div style="font-weight:700;font-size:13px;margin:6px 0 0;color:var(--t0)">' + esc(vd.manchete) + '</div>' +
            '<div class="sia-detalhe" style="display:none;margin-top:6px">' +
            '<div style="font-size:12px;color:var(--t1);line-height:1.5;white-space:pre-line">' + esc(vd.diagnostico) + '</div>' +
            (vd.passos && vd.passos.length ? (function () {
              var hp = '<div style="font-size:12px;margin-top:8px;color:var(--t0);font-weight:700">Faca assim:</div><ol style="margin:4px 0 0 18px;padding:0">';
              for (var pz = 0; pz < vd.passos.length; pz++) hp += '<li style="font-size:12px;color:var(--t1);margin:3px 0;line-height:1.45">' + esc(vd.passos[pz]) + '</li>';
              return hp + '</ol>';
            })() : (vd.acao ? '<div style="font-size:12px;margin-top:8px;color:var(--t1)"><b style="color:var(--t0)">O que fazer:</b> ' + esc(vd.acao.fazer) + '</div>' : '')) +
            (vd.impacto ? '<div style="font-size:12px;margin-top:7px;color:var(--px)"><b>Impacto:</b> <span style="color:var(--t1)">' + esc(vd.impacto) + '</span></div>' : '') +
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
              var payload = payloadCerebro(fotoGlobal);
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
        h += '<div class="nota"><b style="color:var(--t0)">Cruzamento de fontes de venda</b> (do painel da Shopee):</div><table><tr><th>Fonte</th><th class="num">Vendas</th><th class="num">%</th><th class="num">Pedidos</th><th class="num">Ticket</th></tr>';
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
        corpo.innerHTML = capa('ONDE O DINHEIRO ESTA INDO', 'SHOPEE', 'ADS', '03') + '<div class="vazio">Nada lido ainda. Navegue pela tela de <b>Shopee Ads</b>.</div>';
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
        h2 += '<tr data-card="campanha:' + esc(idsC[j]) + '" style="cursor:pointer"><td class="nome">' + esc(c.nome || '(sem nome)') + ' <span style="color:var(--mk);font-family:monospace;font-size:9px">abrir ›</span></td>' +
          '<td>' + esc(estadoTxt) + '</td><td>' + esc(c.estrategia || '—') + '</td>' +
          '<td class="num">' + (m.orcamento_dia === 0 ? 'Sem limite' : reais(m.orcamento_dia)) + '</td>' +
          '<td class="num">' + reais(m.gasto) + '</td><td class="num">' + reais(m.gmv) + '</td>' +
          '<td class="num">' + (roasC === null ? '—' : fmt(roasC, 2) + 'x') + '</td>' +
          '<td class="num">' + (ctrC === null ? '—' : fmt(ctrC, 2) + '%') + '</td>' +
          '<td class="num">' + (cpcC === null ? '—' : reais(cpcC)) + '</td>' +
          '<td class="num">' + fmt(m.pedidos) + '</td>' +
          '<td class="num">' + (m.posicao === undefined ? '—' : fmt(m.posicao, 0)) + '</td></tr>';
      }
      h2 = capa('ONDE O DINHEIRO ESTA INDO', 'SHOPEE', 'ADS', '03') + h2;
      h2 += '</table><div class="nota">CPC derivado (gasto ÷ cliques) — os campos cpc/cpm da API interna nao batem com a tela e foram descartados. ROAS = broad_roi da Shopee.</div>';
      corpo.innerHTML = h2;

    } else if (abaAtiva === 'produtos') {
      // mostra as CAMPANHAS do Ads (o dado que o coletor traz via homepage/query).
      // produto-a-produto exige abrir cada campanha — fica pra busca ativa depois.
      var camps = estado.campanhas || {};
      var idsC = Object.keys(camps).filter(function (id) {
        var m = camps[id].metricas || {};
        return m.gasto !== undefined || m.gmv !== undefined || m.roas !== undefined;
      });
      if (!idsC.length) {
        corpo.innerHTML = renderSubAbas('gprod') + '<div class="vazio">Sem campanhas de Ads ainda.<br>Rode a coleta na aba <b>Conta 360</b> (o bot\u00e3o "Coletar conta") \u2014 o Ads entra junto.</div>';
        return;
      }
      idsC.sort(function (a, b) { return (camps[b].metricas.gasto || 0) - (camps[a].metricas.gasto || 0); });
      var h2b = '<table><tr><th>Campanha</th>' +
        '<th class="num">Gasto</th><th class="num">GMV</th><th class="num">ROAS</th><th class="num">Impr.</th>' +
        '<th class="num">Cliques</th><th class="num">CTR</th><th class="num">Pedidos</th></tr>';
      for (var j2 = 0; j2 < idsC.length; j2++) {
        var camp = camps[idsC[j2]];
        var mc = camp.metricas || {};
        function nz(v, suf) { return v != null ? (typeof v === 'number' ? fmtN(v) : v) + (suf || '') : '—'; }
        h2b += '<tr><td class="nome">' + esc(camp.nome || '(campanha ' + idsC[j2] + ')') + '</td>' +
          '<td class="num">' + (mc.gasto != null ? fmtR(mc.gasto) : '—') + '</td>' +
          '<td class="num">' + (mc.gmv != null ? fmtR(mc.gmv) : '—') + '</td>' +
          '<td class="num">' + (mc.roas != null ? mc.roas.toFixed(1) + 'x' : '—') + '</td>' +
          '<td class="num">' + nz(mc.impressoes) + '</td>' +
          '<td class="num">' + nz(mc.cliques) + '</td>' +
          '<td class="num">' + (mc.ctr != null ? (mc.ctr * (mc.ctr < 1 ? 100 : 1)).toFixed(1) + '%' : '—') + '</td>' +
          '<td class="num">' + nz(mc.pedidos) + '</td></tr>';
      }
      h2b += '</table><div class="nota">Campanhas do Shopee Ads, ordenadas por gasto.</div>';
      corpo.innerHTML = renderSubAbas('gprod') + h2b;

    } else if (abaAtiva === 'performance') {
      corpo.innerHTML = renderPerformanceIA();
      ligarChamadaCerebro();
      var ps = $('sia-prod-sel');
      if (ps) ps.addEventListener('change', function () { estado.prodSel = ps.value; render(); });

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
            '<div class="nota"><b style="color:var(--t0)">' + esc(ap.nome) + '</b><br>ID ' + esc(ap.id) + ' — visao do cliente (vitrine). E daqui que o ClipSeller vai ler as fotos para critica e geracao de criativos (Etapa 7).</div>';
          var pv = estado.produtos[ap.id];
          if (pv && (pv.metricas.gasto !== undefined || pv.metricas.roas !== undefined)) {
            h3 += '<table><tr><th>Ads deste produto</th><th class="num">Gasto</th><th class="num">GMV</th><th class="num">ROAS</th><th class="num">Impr.</th><th class="num">Cliques</th><th class="num">CTR</th><th class="num">Pedidos</th><th class="num">Pos.</th></tr>' +
              '<tr><td class="nome">' + esc(pv.nome || '') + '</td>' + linhaMetrica(pv.metricas) + '</tr></table>';
          }
        } else {
          h3 = '<div class="vazio">Pagina publica detectada' + (estado.paginaProduto ? ' (ID ' + esc(estado.paginaProduto) + ')' : '') + '.<br>Status da leitura: <b>' + esc(estado.debugPublico || 'tentando...') + '</b><br>Se falhar, me mande esse status.</div>';
        }
        corpo.innerHTML = renderSubAbas('gprod') + h3;
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
            '<div class="nota"><b style="color:var(--t0)">' + esc(cad.nome) + '</b><br>ID ' + esc(cad.id) + ' · ' + esc(cad.categoria) + '</div>';
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
        var hd = '<div class="nota">Ouro capturado nesta sessao. Navegue pelo Seller Centre (Ads, Produtos, criar campanha) e veja encher. <b style="color:var(--t0)">' + R.capturas + '</b> capturas.</div>';

        // bloco META ROAS
        hd += '<div class="bloco-d"><div class="td">META DE ROAS (SHOPEE)</div>';
        if (R.metaRoas) {
          hd += '<div class="ld">A Shopee recomenda <b>' + (R.metaRoas.exato != null ? R.metaRoas.exato.toFixed(1) + 'x' : '?') + '</b> para este produto</div>';
          if (R.metaRoas.conservador != null) hd += '<div class="ld" style="color:var(--t2);font-size:11px">(ela entrega bem de ' + R.metaRoas.conservador.toFixed(1) + 'x ate ' + (R.metaRoas.agressivo != null ? R.metaRoas.agressivo.toFixed(1) + 'x' : '?') + ' — quanto mais alto o ROAS, menos ela entrega)</div>';
          if (R.projecao) hd += '<div class="ld">Nesse ritmo ela projeta <b>+' + (R.projecao.gmvUpliftPct != null ? R.projecao.gmvUpliftPct.toFixed(0) : '?') + '% em vendas</b></div>';
        } else hd += '<div class="ld vazio-d">abra "criar campanha" no Ads para capturar</div>';
        hd += '</div>';

        // bloco LEILAO / CPM (o coracao do Leilao Reverso)
        hd += '<div class="bloco-d"><div class="td">O LEILAO (CPM REAL)</div>';
        if (R.leilao || R.gasto || R.lancePorPrecoLiberado !== undefined) {
          if (R.leilao && R.leilao.cpmReal != null) hd += '<div class="ld">CPM real: <b>R$ ' + R.leilao.cpmReal.toFixed(2) + '</b> por mil impressoes</div>';
          if (R.leilao && R.leilao.posicaoMedia != null) hd += '<div class="ld">Posicao media no leilao: <b>' + R.leilao.posicaoMedia + '</b></div>';
          if (R.gasto && R.gasto.hoje != null) hd += '<div class="ld">Gasto hoje: <b>R$ ' + R.gasto.hoje.toFixed(2) + '</b>' + (R.gasto.mediaSeteDias != null ? ' · media 7d R$ ' + R.gasto.mediaSeteDias.toFixed(2) : '') + '</div>';
          if (R.lancePorPrecoLiberado !== undefined) hd += '<div class="ld" style="color:var(--t2);font-size:11px">Lance manual por preco: ' + (R.lancePorPrecoLiberado ? 'liberado' : '<b style="color:var(--am)">desligado</b> (oCPM: a alavanca agora e preco competitivo + Meta de ROAS)') + '</div>';
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
          if (a.notaMinimaAuto != null) hd += '<div class="ld" style="color:var(--t2);font-size:11px">Precisa nota &ge; ' + a.notaMinimaAuto + ' para o modo automatico</div>';
          hd += '</div>';
        }

        // bloco META SUGERIDA POR CAMPANHA (a Shopee te diz o ROAS ideal)
        var campsMeta = Object.keys(D.porCampanha).filter(function (k) { return D.porCampanha[k].metaShopee; });
        if (campsMeta.length) {
          hd += '<div class="bloco-d"><div class="td">META IDEAL DA SHOPEE (' + campsMeta.length + ' campanhas)</div>';
          campsMeta.slice(0, 6).forEach(function (k) {
            var ms = D.porCampanha[k].metaShopee;
            var seta = (ms.sugerida < ms.atual) ? 'baixar' : 'subir';
            hd += '<div class="ld">Campanha ' + k + ': voce em <b>' + (ms.atual != null ? ms.atual.toFixed(1) + 'x' : '?') + '</b>, Shopee sugere <b style="color:var(--am)">' + (ms.sugerida != null ? ms.sugerida.toFixed(1) + 'x' : '?') + '</b> (' + seta + ')' + (ms.ganhoGmvPct ? ' · +' + ms.ganhoGmvPct + '% vendas' : '') + '</div>';
          });
          if (campsMeta.length > 6) hd += '<div class="ld" style="color:var(--t3);font-size:11px">+ ' + (campsMeta.length - 6) + ' outras</div>';
          hd += '</div>';
        }

        // bloco CREDITOS E INCENTIVOS (dinheiro de ads)
        if (R.creditos || (R.incentivos && Object.keys(R.incentivos).length)) {
          hd += '<div class="bloco-d"><div class="td">CREDITOS E INCENTIVOS</div>';
          if (R.creditos && R.creditos.total != null) hd += '<div class="ld">Credito de ads: <b>R$ ' + R.creditos.total.toFixed(2) + '</b>' + (R.creditos.vencendo30d ? ' · <span style="color:var(--am)">R$ ' + R.creditos.vencendo30d.toFixed(2) + ' vence em 30d</span>' : '') + '</div>';
          if (R.incentivos && R.incentivos.metaGasto) hd += '<div class="ld">Gaste <b>R$ ' + R.incentivos.metaGasto.gasteParaGanhar.toFixed(2) + '</b> e ganhe <b>R$ ' + R.incentivos.metaGasto.recompensa.toFixed(2) + '</b> de credito</div>';
          if (R.incentivos && R.incentivos.surge) hd += '<div class="ld" style="color:var(--t2);font-size:11px">Impulso ativo pode elevar vendas em ~' + R.incentivos.surge.upliftGmvPct + '%</div>';
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
            if (pp.status) partes.push(pp.status === 'deboost' ? '<span style="color:var(--rd)">LIMITADO</span>' : 'normal');
            if (pp.posicaoLeilao != null) partes.push('leilao ' + pp.posicaoLeilao);
            if (pp.competitividade != null) partes.push('comp ' + pp.competitividade);
            if (pp.emAprendizado) partes.push('aprendizado');
            if (pp.janelaNovoDias != null) partes.push('novo ' + pp.janelaNovoDias + 'd');
            hd += '<div class="ld"><span style="color:var(--t2)">' + pid + '</span> ' + partes.join(' · ') + '</div>';
          }
        } else hd += '<div class="ld vazio-d">abra a lista de Produtos no Ads para capturar</div>';
        hd += '</div>';

        // bloco CAMPANHAS diagnosticadas
        var camps = Object.keys(D.porCampanha);
        hd += '<div class="bloco-d"><div class="td">DIAGNOSTICO SHOPEE (' + camps.length + ' campanhas)</div>';
        if (camps.length) {
          var contaNota = { good: 0, fair: 0, poor: 0 };
          camps.forEach(function (ci) { var nt = D.porCampanha[ci].nota; if (contaNota[nt] != null) contaNota[nt]++; });
          hd += '<div class="ld">Boas: <b style="color:var(--vd)">' + contaNota.good + '</b> · Medianas: <b style="color:var(--am)">' + contaNota.fair + '</b> · Ruins: <b style="color:var(--rd)">' + contaNota.poor + '</b></div>';
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
      var h4 = h4pre + '<div class="nota">Loja: <b style="color:var(--t0)">' + esc(lj) + '</b> · Janela do Ads: <b style="color:var(--t0)">' + esc(pj) + '</b></div>' +
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

  carregarCofre();
  setTimeout(carregarCofre, 4000); // a loja so e identificada apos as primeiras chamadas
  ligarTema();
  try {
    chrome.runtime.sendMessage({ tipo: 'sia:pref-carregar', chave: 'temaClaro' }, function (r) {
      void chrome.runtime.lastError;
      if (r && r.valor) aplicarTema(true);
    });
  } catch (e) { /* noop */ }
  try {
    chrome.runtime.sendMessage({ tipo: 'sia:pref-carregar', chave: 'autoColeta' }, function (r) {
      void chrome.runtime.lastError;
      if (r && r.valor) {
        estado.autoColeta = true; estado.sujo = true;
        // a loja pode ja ter sido identificada antes desta preferencia chegar
        agendarAutoColeta();
        setTimeout(agendarAutoColeta, 4000);
      }
    });
  } catch (e) { /* noop */ }

  setInterval(function () {
    if (estado.sujo && $('sia-painel').classList.contains('aberto')) { estado.sujo = false; render(); }
  }, 900);
})();

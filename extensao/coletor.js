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

  var VERSAO = '1.1.4';
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

  // A extensao fala direto com a funcao do relatorio: o service worker do
  // Chrome nao sobrevive aos 60-90 segundos que ela leva para responder.
  var SIA_URL_RELATORIO = 'https://mkfreezlizdbfpjjpxoo.supabase.co/functions/v1/relatorio';
  // A CHAVE VEM DAS CONFIGURACOES, NUNCA DO CODIGO.
  // Eu tinha escrito um JWT aqui sem ter acesso a chave real do projeto: o
  // payload decodificava, mas a assinatura era invalida. O Supabase rejeitava
  // com 401 ANTES da funcao rodar, e a resposta do gateway nao tem headers
  // CORS — por isso o navegador acusava CORS e republicar a funcao nunca
  // resolvia. Agora a pessoa cola a chave real uma vez e ela fica salva.
  var SIA_ANON_KEY = '';

  var ICONE_SOL = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/></svg>';
  var ICONE_LUA = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>';

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
    espiaoModo: 'radar',     // 'radar' (meus produtos) | 'busca' (termo livre)
    modoTecnico: false,      // mostra a aba Debug (duplo clique no logo)
    temaEscuro: false,       // bege e o padrao; escuro e o alternativo
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

  function numero(v, permitirNegativo) {
    // -1 na API da Shopee significa SEM DADO em campos de METRICA (atc,
    // broad_roi, chain_ratio). Mas variacao percentual pode ser -1 de
    // verdade, e id tambem — por isso o descarte so vale quando quem chama
    // nao pediu para permitir negativo.
    if (typeof v === 'number' && isFinite(v)) {
      if (v <= -999999) return null;
      if (v === -1 && !permitirNegativo) return null;
      return v;
    }
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

  function extrairMetricas(obj, micro, permitirNegativo) {
    var m = {};
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var chave = MAPA[k.toLowerCase()];
      if (!chave) continue;
      var v = numero(obj[k], permitirNegativo);
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
    // CARIMBO NA ORIGEM. Todo produto guarda de qual loja ele veio: se a
    // conta atual e outra, ele nao entra. Sem isso, qualquer caminho que
    // criasse produto — e sao varios — furava o isolamento entre contas.
    var lojaAgora = estado.loja ? String(estado.loja.shop_id) : null;
    if (!estado.produtos[id]) {
      estado.produtos[id] = { id: id, metricas: {}, campos: {}, loja: lojaAgora };
    } else if (lojaAgora && estado.produtos[id].loja && estado.produtos[id].loja !== lojaAgora) {
      // produto de outra conta que sobrou na memoria: substitui, nao mistura
      estado.produtos[id] = { id: id, metricas: {}, campos: {}, loja: lojaAgora };
    } else if (lojaAgora && !estado.produtos[id].loja) {
      estado.produtos[id].loja = lojaAgora;
    }
    return estado.produtos[id];
  }
  function entidadeCampanha(id) {
    var lojaC = estado.loja ? String(estado.loja.shop_id) : null;
    if (!estado.campanhas[id]) {
      if (Object.keys(estado.campanhas).length >= 280) return { id: id, metricas: {} };
      estado.campanhas[id] = { id: id, metricas: {}, loja: lojaC, periodo: PERIODO_PACOTE };
    } else if (lojaC && estado.campanhas[id].loja && estado.campanhas[id].loja !== lojaC) {
      estado.campanhas[id] = { id: id, metricas: {}, loja: lojaC, periodo: PERIODO_PACOTE };
    } else if (lojaC && !estado.campanhas[id].loja) {
      estado.campanhas[id].loja = lojaC;
    }
    // periodo diferente do ultimo lido: as metricas antigas nao valem mais
    if (PERIODO_PACOTE && estado.campanhas[id].periodo && estado.campanhas[id].periodo !== PERIODO_PACOTE) {
      estado.campanhas[id].metricas = {};
    }
    if (PERIODO_PACOTE) estado.campanhas[id].periodo = PERIODO_PACOTE;
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
        if (e.type) ent.type = e.type;
        // O ID DO PRODUTO EXISTE e eu nao estava lendo: vem em
        // manual_product_ads.item_id, e em mpd.item_list quando e Grupo de
        // Anuncios. Sem isso a IA recebia campo vazio e inventava nome.
        var mpa = e.manual_product_ads;
        if (mpa && mpa.item_id) ent.produtoId = String(mpa.item_id);
        if (!ent.produtoId && e.mpd && Array.isArray(e.mpd.item_list) && e.mpd.item_list.length) {
          ent.itensGrupo = e.mpd.item_list.map(String);
          if (e.mpd.item_list.length === 1) ent.produtoId = String(e.mpd.item_list[0]);
        }
        if (mpa && mpa.bidding_strategy) ent.estrategia = mpa.bidding_strategy;
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
        if (item.ratio) { alvo.variacao = extrairMetricas(item.ratio, false, true); }
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
  var lojaDoCiclo = null;   // de qual loja e a coleta em andamento
  function processarPacote(pacote) {
    // guarda o periodo do pacote para carimbar as entidades criadas por ele
    PERIODO_PACOTE = (pacote && pacote.periodo) || null;

    // IDENTIDADE PELA URL. Depender so de shop_info deixava a conta sem dono
    // ate essa rota chegar — e todo dado lido antes disso entrava sem carimbo.
    // O SPC_CDS muda a cada conta e vem em quase toda chamada do painel.
    try {
      var urlPac = String(pacote && pacote.url || '');
      // A vitrine publica nao tem SPC_CDS e nao pode disparar troca de conta.
      var ehVitrine = /shopee\.com\.br\/api\/v4|search_items|\/pdp\//.test(urlPac);
      var mSpc = ehVitrine ? null : urlPac.match(/SPC_CDS=([\w-]{8,})/);
      if (mSpc && mSpc[1] !== estado.spcCorrente) {
        if (estado.spcCorrente) {
          // sessao diferente = outra conta: limpa tudo antes de aceitar dado
          estado.campanhas = {}; estado.produtos = {};
          estado.conta = { campos: {}, atualizadoEm: null };
          try { if (window.SIA_Diamantes && window.SIA_Diamantes.zerar) window.SIA_Diamantes.zerar('SPC_CDS mudou'); } catch (e2) { }
          MAPA_ADS = null;
        }
        estado.spcCorrente = mSpc[1];
      }
    } catch (e) { /* noop */ }
    // ULTIMA LINHA DE DEFESA contra dado de outra conta. Se o pacote foi
    // carimbado com uma loja e ela nao e a atual, descarta. Sem isso, pacote
    // em voo da conta anterior grava na nova.
    if (pacote && pacote.loja && estado.loja && estado.loja.shop_id &&
        String(pacote.loja) !== String(estado.loja.shop_id) &&
        !/search_items|\/pdp\/|shopee\.com\.br\/api\/v4/.test(String(pacote.url || ''))) {
      return;
    }
    if (!pacote || !pacote.url) return;
    // CRITICO: ao trocar de conta, as respostas ainda em voo da conta anterior
    // continuam chegando e eram gravadas na conta NOVA — as metricas da loja
    // vinham certas e os produtos vinham da loja anterior. Numa agencia isso
    // e decisao tomada com dado de outro cliente.
    var lojaAgora = estado.loja ? estado.loja.shop_id : null;
    if (pacote.loja && lojaAgora && String(pacote.loja) !== String(lojaAgora)) return;
    if (lojaDoCiclo && lojaAgora && String(lojaDoCiclo) !== String(lojaAgora)) return;
    var mSpc = pacote.url.match(/SPC_CDS=([a-f0-9-]{20,})/i);
    if (mSpc) { estado.spc = mSpc[1]; try { window.SIA_ULTIMO_CDS = mSpc[1]; } catch (e) { } }
    // captura o start/end REAL das chamadas mydata (Central de Dados) que a
    // Shopee ja validou. Reusamos no coletor pra nunca errar o formato de data.
    // O periodo era atualizado a cada chamada que a Shopee fazia enquanto a
    // pessoa navegava, entao a tela ficava trocando sozinha. Agora so aceita
    // periodo novo quando NAO ha coleta em andamento — durante a coleta o
    // recorte e o que a coleta pediu, e ponto.
    if (estado.coletaProgresso === null && /mydata\/.*\/(key-metrics|performance|traffic|order-performance)/.test(pacote.url)) {
      var mSt = pacote.url.match(/start_time=(\d{9,11})/);
      var mEt = pacote.url.match(/end_time=(\d{9,11})/);
      var mPer = pacote.url.match(/period=(\w+)/);
      // ANTES so aceitava period=month. Com 'últimos 7 dias' ou 'ontem' no
      // painel, o periodo era IGNORADO e a coleta usava um recorte antigo —
      // por isso a tela dizia ler o periodo do painel e varias coisas nao
      // fechavam. Agora aceita qualquer period, e guarda qual foi.
      if (mSt && mEt) {
        var iNovo = parseInt(mSt[1], 10), fNovo = parseInt(mEt[1], 10);
        if (fNovo > iNovo && (fNovo - iNovo) <= 400 * 86400) {
          estado.periodoMydata = { inicio: iNovo, fim: fNovo, rotulo: mPer ? mPer[1] : null };
        }
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
      // So a rota shop_info do SELLER CENTRE identifica a conta. A vitrine
      // publica (shopee.com.br) tambem tem shop_info, com o shopid do
      // CONCORRENTE — e caçar shop_id em objeto aninhado pegava esse.
      if (pacote.url.indexOf('shop_info') >= 0 && !/shopee\.com\.br\/api\/v4|search_items|\/pdp\//.test(String(pacote.url))) {
        // NUNCA travar na primeira leitura. Agencia troca de conta o dia todo
        // na mesma guia: se a identidade nao acompanhar, o dado da conta A
        // aparece rotulado como conta B. Isso e pior que nao coletar.
        var achado = null;
        (function cacar(no, prof) {
          // profundidade 2, nao 4: mais fundo comeca a pegar shopid de item
          // dentro de lista, que e de outra loja
          if (achado || !no || typeof no !== 'object' || prof > 2) return;
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
    // O interceptor entrega TUDO que a Shopee pede enquanto a pessoa navega.
    // Sem filtro, cada pagina do painel de Ads que ela abre acrescenta
    // campanhas ao estado — foi assim que a conta chegou a mais de 400
    // campanhas mesmo com a coleta limitada a 260.
    // Regra: a lista de campanhas so entra quando VEIO DA NOSSA COLETA.
    // O resto (produto aberto, metrica de uma tela) continua sendo absorvido,
    // porque e ali que a lente funciona.
    if (estado.coletaProgresso === null && /pas\/v1\/homepage\/query/.test(String(pacote && pacote.url || ''))) {
      return;
    }
    pacote.loja = pacote.loja || (estado.loja ? estado.loja.shop_id : null);
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
    cardLente.style.cssText = 'all:initial;position:fixed;' + pos + 'z-index:2147483200;width:min(430px,94vw);max-height:70vh;display:flex;flex-direction:column;background:#FBF8F3;border:1px solid #E7DFD2;border-top:3px solid #EE4D2D;border-radius:22px;box-shadow:0 16px 50px rgba(72,56,38,.22);color:#211F1B;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;';
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
        selo.style.cssText = 'all:initial;display:block;width:fit-content;max-width:220px;margin-top:4px;padding:2px 10px;border-radius:4px;background:#EE4D2D;color:#fff;font:700 8.5px/1.5 Arial;letter-spacing:.05em;cursor:pointer;' + (leRapida ? 'box-shadow:0 0 0 1px ' + (leRapida.bom ? 'var(--vd)' : 'var(--am)') + ' inset;' : '');
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
        selo.style.cssText = 'all:initial;display:block;width:fit-content;max-width:230px;margin-top:3px;padding:2px 10px;border-radius:4px;background:#EE4D2D;color:#fff;font:700 8.5px/1.5 Arial;letter-spacing:.05em;cursor:pointer;';
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

  // COLETA EM DOIS MODOS.
  // Eu fui empilhando rota e a coleta passou de ~30 para mais de 90 chamadas:
  // 12 series horarias, 3 lotes de leilao, 8 palavras-chave, top campanhas.
  // Virou lenta demais para o uso do dia a dia — e quem espera 3 minutos
  // prefere olhar o painel. Agora o padrao e RAPIDA (o essencial, ~40s) e o
  // que e pesado vira PROFUNDA, disparada so quando a pessoa pede.
  function coletaCompleta(aoProgresso, periodoForcado, modo) {
    var PROFUNDA = modo === 'profunda';
    // Marcar 'iniciando' sem garantir a liberacao deixava coletaProgresso
    // travado para sempre quando a coleta falhava antes do fim — e a trava
    // do relatorio olha justamente esse campo. Era por isso que o botao
    // Gerar relatorio nao fazia nada e nao dizia por que.
    estado.coletaProgresso = 'iniciando';
    var jaResolveu = false;
    var travaSeguranca = null;
    lojaDoCiclo = estado.loja ? estado.loja.shop_id : null;
    // LIMPAR ANTES DE LER. A coleta nunca zerava estado.campanhas e
    // estado.produtos: campanhas lidas em recortes anteriores continuavam na
    // memoria e somavam com as novas. Era por isso que apareciam 305
    // campanhas e o investimento nao batia com o faturamento do periodo.
    estado.campanhas = {};
    estado.produtos = {};
    estado.conta = { campos: {}, atualizadoEm: null };
    try { if (window.SIA_Diamantes && window.SIA_Diamantes.zerar) window.SIA_Diamantes.zerar('inicio de coleta'); } catch (e) { /* noop */ }
    estado.faltando = [];
    MAPA_ADS = null;
    estado.diarioColeta = { etapas: [], periodo: null };
    // leitura de periodo passado nao representa o estado atual da conta
    estado.leituraHistorica = !!periodoForcado;
    return new Promise(function (resolverOriginal) {
      // Uma coleta que nunca resolve trava tudo que depende dela — foi o que
      // aconteceu com o relatorio, que ficou esperando para sempre a leitura
      // do mes anterior. Aqui ela SEMPRE termina: no maximo em 4 minutos.
      function resolver(r) {
        if (jaResolveu) return;
        jaResolveu = true;
        clearTimeout(travaSeguranca);
        estado.coletaProgresso = null;
        estado.sujo = true;
        resolverOriginal(r);
      }
      travaSeguranca = setTimeout(function () {
        resolver({ ok: false, erro: 'A leitura passou de 4 minutos e foi encerrada. O que ja tinha sido lido foi mantido.',
          chamadas: 0, campanhas: Object.keys(estado.campanhas).length, produtos: Object.keys(estado.produtos).length });
      }, (PROFUNDA ? 5 : 2) * 60 * 1000);
      (async function () {
        // registra o periodo REAL pedido, para a tela poder mostrar
        estado.diarioColeta.periodo = { ini: ini, fim: fim, forcado: !!periodoForcado };
        function prog(t) {
          estado.coletaProgresso = t; estado.sujo = true;
          if (t === null) {
            clearTimeout(travaSeguranca);
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
        // A URL da tela de Ads tem from/to proprios, e quando a pessoa esta
        // com "Todo o periodo" selecionado ali, isso SOBRESCREVIA o recorte da
        // conta inteira — era assim que apareciam 305 campanhas com gasto de
        // um intervalo completamente diferente do faturamento lido. Agora so
        // aceita a janela do Ads se ela for compativel: no maximo 90 dias e
        // terminando no mesmo periodo da conta.
        var mFrom = location.search.match(/[?&]from=(\d{9,11})/);
        var mTo = location.search.match(/[?&]to=(\d{9,11})/);
        if (mFrom && mTo && !periodoForcado) {
          // O 'to' da URL vem como 23:59:59 do ultimo dia. Alinhar para 00:00
          // encurtava a janela em um dia e a checagem de compatibilidade
          // falhava — por isso o periodo do Ads nunca era aceito e ele seguia
          // usando outro recorte. Soma-se 1 dia ao fim antes de alinhar.
          var iA = inicioDoDiaBRT(parseInt(mFrom[1], 10));
          var fA = inicioDoDiaBRT(parseInt(mTo[1], 10) + 60);
          var diasAds = Math.round((fA - iA) / 86400);
          var diasConta = Math.round((fim - ini) / 86400);
          if (diasAds > 0 && diasAds <= 92 && Math.abs(diasAds - diasConta) <= 3) { ini = iA; fim = fA; }
        }
        var spcQ = 'SPC_CDS=' + estado.spc + '&SPC_CDS_VER=2';
        var totalChamadas = 0;
        CONTAGEM_BUSCA.ok = 0; CONTAGEM_BUSCA.falhas = 0;
        // o Ads (pas/) exige end_time no ULTIMO segundo do dia (23:59:59),
        // nao 00:00 do dia seguinte. Senao retorna code 5 "invalid request".
        var fimAds = fim - 1;

        // A) Campanhas do Ads (paginado por offset)
        prog('Lendo campanhas do Shopee Ads...');
        // ANTES: state 'all' com ate 400 campanhas — puxava as 300 da conta,
        // incluindo pausadas ha meses que nao dizem nada e so deixam a coleta
        // lenta. AGORA: as ONGOING primeiro, e depois um lote pequeno de
        // pausadas so para detectar a que rendia e parou.
        var fases = [
          { estado: 'ongoing', ate: 200 },
          { estado: 'paused', ate: 60 }
        ];
        for (var fx = 0; fx < fases.length; fx++) {
        var faseAtual = fases[fx];
        for (var off = 0; off < faseAtual.ate; off += 20) {
          var corpoC = JSON.stringify({ start_time: ini, end_time: fimAds, filter_list: [{ campaign_type: 'product_homepage_v3', state: faseAtual.estado, search_term: '', is_valid_rebate_only: false }], offset: off, limit: 20, use_paid_gmv: false });
          var rc = await buscar('/api/pas/v1/homepage/query/?' + spcQ, 'POST', corpoC);
          totalChamadas++;
          if (!rc.ok || !rc.dados) break;
          // PAUSADA COM MAIS DE 60 DIAS nao entra: a analise de pausada que
          // rendia so faz sentido em campanha parada ha pouco tempo, com o
          // produto ainda vivo. Acima disso e arqueologia, e so pesa a coleta.
          if (faseAtual.estado === 'paused' && rc.dados.data && rc.dados.data.entry_list) {
            var corte = Math.floor(Date.now() / 1000) - 60 * 86400;
            rc.dados.data.entry_list = rc.dados.data.entry_list.filter(function (e) {
              var c2 = e && e.campaign;
              if (!c2) return false;
              var fimC = c2.end_time && c2.end_time > 0 ? c2.end_time : null;
              var iniC = c2.start_time || 0;
              // usa o fim quando existe; senao o inicio, como aproximacao
              return (fimC ? fimC >= corte : iniC >= corte);
            });
          }
          processarPacote({ url: '/api/pas/v1/homepage/query/', metodo: 'POST', corpo: corpoC, dados: rc.dados, ts: Date.now(), loja: lojaDoCiclo, periodo: ini + '_' + fimAds });
          var lote = rc.dados.data && rc.dados.data.entry_list ? rc.dados.data.entry_list.length : 0;
          prog((faseAtual.estado === 'ongoing' ? 'Campanhas ativas' : 'Campanhas pausadas') + ': ' + Object.keys(estado.campanhas).length + '...');
          if (lote < 20) break;
          await pausa(250);
        }
        }
        estado.periodoAds = { inicio: ini, fim: fim, dias: 30 };

        // B) Variacao das 12 maiores campanhas (report/get com ratio)
        var idsTop = Object.keys(estado.campanhas).filter(function (k) { var mm = estado.campanhas[k].metricas || {}; return (mm.gasto || 0) > 0 || (mm.gmv || 0) > 0; })
          .sort(function (a, b) { return (estado.campanhas[b].metricas.gasto || 0) - (estado.campanhas[a].metricas.gasto || 0); }).slice(0, 30);
        for (var t2 = 0; t2 < idsTop.length; t2++) {
          prog('Aprofundando campanha ' + (t2 + 1) + ' de ' + idsTop.length + '...');
          var corpoR = JSON.stringify({
            start_time: ini, end_time: fimAds, campaign_type: 'product',
            agg_type: 'campaign_id',
            filter_params: { campaign_id: parseInt(idsTop[t2], 10) },
            need_ratio: true
          });
          var rr = await buscar('/api/pas/v1/report/get/?' + spcQ, 'POST', corpoR);
          totalChamadas++;
          if (rr.ok && rr.dados) processarPacote({ url: '/api/pas/v1/report/get/', metodo: 'POST', corpo: corpoR, dados: rr.dados, ts: Date.now() });
          await pausa(250);
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
        var alvoLeilao = idsGasto.slice(0, PROFUNDA ? 60 : 20);

        // Esta rota e da LOJA INTEIRA e nao depende de campanha nenhuma, mas
        // tinha ficado dentro do if de campanhas com gasto — numa conta sem
        // gasto no periodo ela nunca era chamada, e a competitividade ficava
        // vazia para sempre. Ela sai do if e roda sempre.
        prog('Lendo o que a Shopee recomenda...');
        var rt = await buscar('/api/pas/v1/todo/list_task/?' + spcQ, 'POST', '{}');
        totalChamadas++;
        if (rt.ok && rt.dados) {
          processarPacote({ url: '/api/pas/v1/todo/list_task/', metodo: 'POST', corpo: '{}', dados: rt.dados, ts: Date.now(), loja: lojaDoCiclo });
        } else {
          estado.faltando = estado.faltando || [];
          estado.faltando.push('recomendacoes da Shopee (competitividade)');
        }
        await pausa(250);

        // APRENDIZADO REAL E MUDANCA DE META (itens 6 e 7)
        // A rota report/get_time_graph devolve, por hora, o roi_target_setting
        // com is_cold_start dito pela PROPRIA Shopee — nao estimado por idade —
        // e o valor da meta em cada momento, o que revela QUANDO ela foi
        // alterada. E a unica forma de responder "mexeram na campanha dentro
        // da janela de aprendizado?".
        var alvoTempo = PROFUNDA ? idsGasto.slice(0, 12) : [];
        for (var tg = 0; tg < alvoTempo.length; tg++) {
          // CORPO EXATO da captura real. O meu estava errado em tres pontos:
          // agg_interval e o numero 4, nao a string 'hour'; o campaign_id vai
          // dentro de filter_params; e need_roi_target_setting e o que traz o
          // is_cold_start e a meta por hora. Por isso a serie nunca chegava e
          // o Ads seguia pedindo leitura profunda mesmo depois de rodada.
          var corpoTG = JSON.stringify({
            need_roi_target_setting: true,
            agg_interval: 4,
            campaign_type: 'product',
            filter_params: { campaign_id: parseInt(alvoTempo[tg], 10) },
            start_time: ini,
            end_time: fimAds,
            need_product_npa_setting: false,
            need_positive_operation_boost_completed_setting: true
          });
          var rtg = await buscar('/api/pas/v1/report/get_time_graph/?' + spcQ, 'POST', corpoTG);
          totalChamadas++;
          if (rtg.ok && rtg.dados) {
            processarPacote({ url: '/api/pas/v1/report/get_time_graph/?campaign_id=' + alvoTempo[tg], metodo: 'POST', corpo: corpoTG, dados: rtg.dados, ts: Date.now(), loja: lojaDoCiclo });
          }
          await pausa(200);
        }

        if (alvoLeilao.length) {

        prog('Lendo posicao no leilao e diagnostico da Shopee...');
          for (var lv = 0; lv < alvoLeilao.length; lv += 20) {
            var lote20 = alvoLeilao.slice(lv, lv + 20).map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !!x; });
            if (!lote20.length) continue;
            var corpoV = JSON.stringify({ campaign_id_list: lote20, start_time: ini, end_time: fimAds });
            var rv = await buscar('/api/pas/v1/diagnosis/homepage_batch_list_verdict/?' + spcQ, 'POST', corpoV);
            totalChamadas++;
            if (rv.ok && rv.dados) {
              processarPacote({ url: '/api/pas/v1/diagnosis/homepage_batch_list_verdict/', metodo: 'POST', corpo: corpoV, dados: rv.dados, ts: Date.now(), loja: lojaDoCiclo });
            }
            await pausa(250);   // rajada sem intervalo e o padrao que dispara antifraude
            // ROTA CORRIGIDA: /api/pas/v1/campaign/get_product_performance_info
            // nao existe — dava 404 em toda coleta, e aparecia repetido no
            // console. A rota real que liga produto a campanha e
            // /api/v3/opt/product/get_campaign_info_by_item_list, e ela recebe
            // ITENS, nao campanhas.
            var itensLote = [];
            for (var ilp in estado.produtos) {
              if (itensLote.length >= 50) break;
              var idn = parseInt(ilp, 10);
              if (idn) itensLote.push(idn);
            }
            if (itensLote.length) {
              var corpoPI = JSON.stringify({ item_id_list: itensLote });
              var rpi = await buscar('/api/v3/opt/product/get_campaign_info_by_item_list/?' + spcQ, 'POST', corpoPI);
              totalChamadas++;
              if (rpi.ok && rpi.dados) {
                processarPacote({ url: '/api/v3/opt/product/get_campaign_info_by_item_list/', metodo: 'POST', corpo: corpoPI, dados: rpi.dados, ts: Date.now(), loja: lojaDoCiclo });
              }
              await pausa(250);
            }
          }
        }

        // ORIGEM DA VENDA POR CANAL e FUNIL DIARIO POR PRODUTO
        // PALAVRAS-CHAVE COM VOLUME DE BUSCA
        // A chamada da LOJA e uma so e barata: volta para a coleta normal.
        // O que pesava eram as 8 por produto, que seguem na profunda.
        prog('Lendo palavras-chave...');
        // CORPO EXATO da captura real. Eu mandava {campaign_type, limit}:
        // 'limit' nao existe nessa rota e 'suggest_log_data' e obrigatorio.
        var corpoKW = JSON.stringify({ campaign_type: 'shop', suggest_log_data: { page: 'suggest_creation' } });
        var rkw = await buscar('/api/pas/v1/setup_helper/list_recommended_keyword/?' + spcQ, 'POST', corpoKW);
        totalChamadas++;
        if (rkw.ok && rkw.dados) processarPacote({ url: '/api/pas/v1/setup_helper/list_recommended_keyword/?escopo=loja', metodo: 'POST', corpo: corpoKW, dados: rkw.dados, ts: Date.now(), loja: lojaDoCiclo });
        await pausa(250);
        // por produto: cada item traz o proprio conjunto de termos
        var idsKW = PROFUNDA ? Object.keys(estado.produtos).slice(0, 8) : [];
        for (var kw = 0; kw < idsKW.length; kw++) {
          var cKW = JSON.stringify({ campaign_type: 'product', item_id: parseInt(idsKW[kw], 10), suggest_log_data: { page: 'suggest_creation' } });
          var rk2 = await buscar('/api/pas/v1/setup_helper/list_recommended_keyword/?' + spcQ, 'POST', cKW);
          totalChamadas++;
          if (rk2.ok && rk2.dados) processarPacote({ url: '/api/pas/v1/setup_helper/list_recommended_keyword/?item_id=' + idsKW[kw], metodo: 'POST', corpo: cKW, dados: rk2.dados, ts: Date.now(), loja: lojaDoCiclo });
          await pausa(200);
        }

        // PALAVRAS DE CADA CAMPANHA DE BUSCA DE LOJA
        // Unico formato com lance manual: da para ver qual palavra esta
        // ativa, quanto voce paga e quanto a Shopee recomenda.
        var idsBusca = [];
        for (var kb2 in estado.campanhas) {
          if (String(estado.campanhas[kb2].type || '') === 'shop_manual') idsBusca.push(kb2);
        }
        if (idsBusca.length) {
          prog('Lendo palavras das campanhas de busca...');
          for (var kb3 = 0; kb3 < Math.min(idsBusca.length, 10); kb3++) {
            var cKb = JSON.stringify({ campaign_id: parseInt(idsBusca[kb3], 10) });
            var rkb = await buscar('/api/pas/v1/shop/manual/list_keyword_with_recommended_price/?' + spcQ, 'POST', cKb);
            totalChamadas++;
            if (rkb.ok && rkb.dados) {
              processarPacote({ url: '/api/pas/v1/shop/manual/list_keyword_with_recommended_price/?campaign_id=' + idsBusca[kb3], metodo: 'POST', corpo: cKb, dados: rkb.dados, ts: Date.now(), loja: lojaDoCiclo });
            }
            await pausa(250);
          }
        }

        // CAMPANHAS DE MARKETING: cupons, oferta relampago, descontos.
        // Todas trazem ctime e mtime — criacao e ULTIMA ALTERACAO — que e o
        // que permite ver mexida do cliente sem log de auditoria.
        prog('Lendo campanhas de marketing...');
        // PARAMETROS EXATOS da captura real. Os que eu tinha inventado
        // (voucher_type, voucher_status, status) nao existem, e a Shopee
        // recusava a chamada — por isso os cupons nunca apareceram.
        var rotasMkt = [
          { u: '/api/marketing/v3/voucher/list/?' + spcQ + '&offset=0&limit=50&promotion_type=0', m: 'GET', c: null },
          { u: '/api/marketing/v4/shop_flash_sale/get_shop_flash_sale_list/?' + spcQ + '&offset=0&limit=30&type=3', m: 'GET', c: null },
          { u: '/api/marketing/v3/public/discount/list/?' + spcQ, m: 'POST', c: JSON.stringify({ discount_type: 2, time_status: 0, offset: 0, limit: 30 }) },
          { u: '/api/marketing/v4/public/get_marketing_center_campaign_list/?' + spcQ + '&language=pt-br', m: 'GET', c: null },
          { u: '/api/marketing/v4/public/get_toggle/?' + spcQ, m: 'GET', c: null },
          { u: '/api/marketing/v4/discount/metrics/?' + spcQ, m: 'POST', c: JSON.stringify({ start_time: ini, end_time: fim }) },
          { u: '/api/marketing/v3/voucher/promotion_tool/metrics/?' + spcQ + '&tool_name=marketing_voucher', m: 'GET', c: null },
          { u: '/api/marketing/v3/bundle_deal/metrics/?' + spcQ, m: 'POST', c: JSON.stringify({ start_time: ini, end_time: fim }) }
        ];
        for (var rm = 0; rm < rotasMkt.length; rm++) {
          var R2 = rotasMkt[rm];
          var rr2 = await buscar(R2.u, R2.m, R2.c);
          totalChamadas++;
          if (rr2.ok && rr2.dados) processarPacote({ url: R2.u, metodo: R2.m, corpo: R2.c, dados: rr2.dados, ts: Date.now(), loja: lojaDoCiclo });
          await pausa(250);
        }

        prog('Lendo de onde vem cada venda...');
        var urlTO = '/api/mydata/v1/product/traffic/overview/?' + spcQ + '&start_time=' + ini + '&end_time=' + fim + '&period=day';
        var rto = await buscar(urlTO, 'GET', null);
        totalChamadas++;
        if (rto.ok && rto.dados) processarPacote({ url: urlTO, metodo: 'GET', corpo: null, dados: rto.dados, ts: Date.now(), loja: lojaDoCiclo });
        else { estado.faltando = estado.faltando || []; estado.faltando.push('origem das vendas'); }
        await pausa(250);

        prog('Lendo a evolucao diaria da loja...');
        var urlMT = '/api/mydata/v2/product/overview/metric-trends/?' + spcQ + '&start_time=' + ini + '&end_time=' + fim + '&period=day';
        var rmt = await buscar(urlMT, 'GET', null);
        totalChamadas++;
        if (rmt.ok && rmt.dados) processarPacote({ url: urlMT, metodo: 'GET', corpo: null, dados: rmt.dados, ts: Date.now(), loja: lojaDoCiclo });
        await pausa(250);

        prog('Lendo o funil dos produtos...');
        for (var pg = 1; pg <= 12; pg++) {
          var urlP = '/api/mydata/v4/product/performance/?' + spcQ + '&start_time=' + ini + '&end_time=' + fim + '&period=month&keyword=&category_type=shopee&category_id=-1&page_size=10&page_num=' + pg + '&order_type=paid&order_by=paid_sales.desc';
          var rp = await buscar(urlP, 'GET', null);
          totalChamadas++;
          if (!rp.ok || !rp.dados) break;
          processarPacote({ url: urlP, metodo: 'GET', corpo: null, dados: rp.dados, ts: Date.now(), loja: lojaDoCiclo });
          var itens = rp.dados.result && rp.dados.result.items ? rp.dados.result.items.length : 0;
          prog('Produtos lidos: ' + Object.keys(estado.produtos).length + '...');
          if (itens < 20) break;
          await pausa(250);
        }

        // D) Fatia de vendas + vinculo campanha (traffic item-list, paginado)
        prog('Cruzando fatia de vendas e campanhas...');
        for (var pg2 = 1; pg2 <= 12; pg2++) {
          var urlT = '/api/mydata/v1/product/traffic/item-list/?' + spcQ + '&keyword=&order_by=&page_size=10&page_num=' + pg2 + '&category_type=shop&start_time=' + ini + '&end_time=' + fim + '&period=month&category_id=-1';
          var rt = await buscar(urlT, 'GET', null);
          totalChamadas++;
          if (!rt.ok || !rt.dados) break;
          processarPacote({ url: urlT, metodo: 'GET', corpo: null, dados: rt.dados, ts: Date.now(), loja: lojaDoCiclo });
          var itens2 = rt.dados.result && rt.dados.result.item ? rt.dados.result.item.length : 0;
          if (itens2 < 20) break;
          await pausa(250);
        }

        // D2) Funil de vendas (overview) — a origem do dinheiro (card/ads/afiliado)
        prog('Lendo o funil de vendas...');
        var urlFo = (estado.urlsReais && estado.urlsReais.funilOverview) || ('/api/mydata/v1/product/traffic/overview/?' + spcQ + '&start_time=' + ini + '&end_time=' + fim + '&period=month&order_type=paid');
        var rfo = await buscar(urlFo, 'GET', null);
        totalChamadas++;
        if (rfo.ok && rfo.dados) processarPacote({ url: urlFo, metodo: 'GET', corpo: null, dados: rfo.dados, ts: Date.now(), loja: lojaDoCiclo });
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
        var urlF = (periodoForcado ? null : reais.trafficSources) || ('/api/mydata/v1/dashboard/traffic-sources/?' + spcQ + '&start_time=' + ini + '&end_time=' + fim + '&period=month&order_type=paid');
        var rf = await buscar(urlF, 'GET', null);
        totalChamadas++;
        if (rf.ok && rf.dados) processarPacote({ url: urlF, metodo: 'GET', corpo: null, dados: rf.dados, ts: Date.now(), loja: lojaDoCiclo });

        // E) Indicadores gerais da loja — key-metrics
        prog('Lendo os indicadores gerais...');
        // Antes preferia a URL capturada do painel, que carrega o periodo QUE
        // A SHOPEE usou — por isso escolher 30 dias trazia o mes. Quando ha
        // periodo forcado, ele manda; a URL capturada so vale como fallback.
        // PROVADO nas capturas: a rota aceita start_time e end_time LIVRES —
        // vieram intervalos de 23 e de 30 dias, ambos com period=month, e um
        // deles nem alinhado a meia-noite. Ou seja, `period` e so um ROTULO;
        // quem define o recorte sao start/end. Meu erro antes foi trocar o
        // period por 'custom'/'day', valores que a Shopee nao usa e recusa.
        // Mantendo period=month, da para pedir qualquer intervalo.
        var urlK = periodoForcado
          ? ('/api/mydata/v3/dashboard/key-metrics/?' + spcQ + '&start_time=' + ini + '&end_time=' + fim + '&period=month&fetag=fetag')
          : (reais.keyMetrics || ('/api/mydata/v3/dashboard/key-metrics/?' + spcQ + '&start_time=' + ini + '&end_time=' + fim + '&period=month&fetag=fetag'));
        var rk = await buscar(urlK, 'GET', null);
        totalChamadas++;
        if (rk.ok && rk.dados) processarPacote({ url: urlK, metodo: 'GET', corpo: null, dados: rk.dados, ts: Date.now(), loja: lojaDoCiclo });

        // G) Vendas e cancelamentos (saude das vendas)
        prog('Lendo vendas e cancelamentos...');
        var urlO = (estado.urlsReais && estado.urlsReais.orderPerf) || ('/api/mydata/dashboard/order-performance/?' + spcQ + '&start_time=' + ini + '&end_time=' + fim + '&period=month&fetag=fetag&order_type=paid');
        var ro = await buscar(urlO, 'GET', null);
        totalChamadas++;
        if (ro.ok && ro.dados) processarPacote({ url: urlO, metodo: 'GET', corpo: null, dados: ro.dados, ts: Date.now(), loja: lojaDoCiclo });
        await pausa(150);

        // H) Saude da conta (penalidade, rating de performance)
        prog('Lendo a saude da conta...');
        var urlH = '/api/accounthealth/v1/sc/shops/overview?' + spcQ;
        var rh = await buscar(urlH, 'GET', null);
        totalChamadas++;
        if (rh.ok && rh.dados) processarPacote({ url: urlH, metodo: 'GET', corpo: null, dados: rh.dados, ts: Date.now(), loja: lojaDoCiclo });
        else estado.faltando.push('saude da conta');
        await pausa(150);

        // I) Afiliados (resumo do canal + top 5)
        prog('Lendo os afiliados...');
        var urlAf = '/api/v3/affiliateplatform/dashboard/seller_daily?start_time=' + ini + '&end_time=' + (fim - 1) + '&is_real_time=0&order_type=2&channel=0';
        var raf = await buscar(urlAf, 'GET', null);
        totalChamadas++;
        if (raf.ok && raf.dados) processarPacote({ url: urlAf, metodo: 'GET', corpo: null, dados: raf.dados, ts: Date.now(), loja: lojaDoCiclo });
        await pausa(150);
        var urlTop = '/api/v3/affiliateplatform/dashboard/affiliate_performance/top5?start_time=' + ini + '&end_time=' + fimAds + '&order_type=2&channel=0&has_meta_feature=1&sm_parameter=0&sort_rule=3&is_real_time=0&period_type=1' + ini + '&end_time=' + (fim - 1) + '&order_type=2&channel=0&has_meta_feature=1';
        var rtop = await buscar(urlTop, 'GET', null);
        totalChamadas++;
        if (rtop.ok && rtop.dados) processarPacote({ url: urlTop, metodo: 'GET', corpo: null, dados: rtop.dados, ts: Date.now(), loja: lojaDoCiclo });
        await pausa(150);

        // J) Avaliacoes dos top produtos (1-2 estrelas = risco). Pega ate 6 produtos
        // com mais venda (ja temos no cofre pela performance).
        // AVALIACOES — ultimo passo, e o mais fragil.
        // A rota get_ratings e da vitrine publica e exige shopid junto do
        // itemid; sem ele responde 404 (eram esses erros no console). E como
        // e o passo final, qualquer travamento aqui deixava a coleta presa
        // em "Lendo avaliacoes" para sempre — que e exatamente o que
        // aconteceu na geracao do relatorio, porque a coleta nunca terminava
        // e a segunda leitura nunca comecava.
        // Agora: so roda com shopid conhecido, tem teto de tempo proprio e,
        // acima de tudo, NUNCA impede a coleta de terminar.
        prog('Lendo avaliacoes dos produtos...');
        try {
          var shopAv = estado.loja && estado.loja.shop_id ? estado.loja.shop_id : null;
          var cofreP = window.SIA_Diamantes ? window.SIA_Diamantes.estado().porProduto : null;
          // DESLIGADO: get_ratings e rota da vitrine publica (shopee.com.br) e
          // recusa chamada originada do Seller Centre, respondendo 404 sempre.
          // Enchia o console de erro sem entregar nada. As avaliacoes ja vem
          // do Espiao, que le a vitrine de verdade.
          if (false && shopAv && cofreP) {
            var idsAval = Object.keys(cofreP)
              .filter(function (k) { return cofreP[k].perf && cofreP[k].perf.vendaPaga; })
              .sort(function (a, b) { return (cofreP[b].perf.vendaPaga || 0) - (cofreP[a].perf.vendaPaga || 0); })
              .slice(0, 6);
            var limiteAv = Date.now() + 25000;   // 25s no maximo para esta etapa
            for (var ia = 0; ia < idsAval.length; ia++) {
              if (Date.now() > limiteAv) break;
              var urlAv = '/api/v2/item/get_ratings?itemid=' + idsAval[ia] + '&shopid=' + shopAv +
                '&filter=0&flag=1&limit=6&offset=0&type=0';
              var rav = await buscar(urlAv, 'GET', null);
              totalChamadas++;
              if (rav.ok && rav.dados) processarPacote({ url: urlAv, metodo: 'GET', corpo: null, dados: rav.dados, ts: Date.now(), loja: lojaDoCiclo });
              await pausa(120);
            }
          }
        } catch (eAv) { /* avaliacoes sao complemento: nunca travam a coleta */ }

        prog(null);
        resolver({ ok: true, chamadas: totalChamadas, campanhas: Object.keys(estado.campanhas).length, produtos: Object.keys(estado.produtos).length });
      })().catch(function (err) {
        // sem este catch, uma excecao no meio deixava a Promise pendurada
        try { console.error('[Seller.IA] coleta:', err); } catch (e) { }
        resolver({ ok: false, erro: String((err && err.message) || err),
          chamadas: 0, campanhas: Object.keys(estado.campanhas).length, produtos: Object.keys(estado.produtos).length });
      });
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
    l.href = 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Bebas+Neue&family=Outfit:wght@300;400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap';
    (document.head || document.documentElement).appendChild(l);
  })();

  var host = document.createElement('div');
  host.id = 'seller-ia-host';
  // 'all:initial' no STYLE INLINE do host anula as variaveis CSS declaradas
  // no :host de dentro do shadow — o inline sempre ganha. Era por isso que
  // trocar a paleta nao mudava nada e o painel ficava com as cores do
  // navegador. O reset continua no :host de dentro, que e o lugar certo.
  host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;right:0;margin:0;padding:0;border:0;';
  document.documentElement.appendChild(host);
  var raiz = host.attachShadow({ mode: 'closed' });

  var LOGO = '<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="0" y="0" width="128" height="128" rx="30" fill="#1C1A17"/>' +
    '<text x="46" y="88" font-family="Archivo,Outfit,Arial" font-size="74" font-weight="500" fill="#FBF8F3" text-anchor="middle" letter-spacing="-2">S</text>' +
    '<circle cx="88" cy="80" r="8" fill="#EE4D2D"/></svg>';

  raiz.innerHTML =
    '<style>' +
    /* PADRAO = bege claro. A classe .escuro inverte. */
    ':host{all:initial;color:#211F1B;' +
    '--b0:#FFFFFF;--b1:#FEFCF9;--b2:#F7F3EC;--li:#EDE6D9;--li2:#DFD6C6;' +
    '--t0:#12100D;--t1:#3A342B;--t2:#6E665A;--t3:#928A7C;' +
    '--mk:#EE4D2D;--mk2:#F0764F;--vd:#1F8A5F;--rd:#D64545;--am:#C98A1E;--px:#8A5CD6;' +
    '--tin:9%;--r-card:22px;--r-btn:14px;--r-painel:30px;' +
    '--sh:rgba(72,56,38,.22);--shb:rgba(72,56,38,.10)}' +
    ':host(.escuro){color:#F2F4F7;' +
    '--b0:#151920;--b1:#0F1115;--b2:#1A1F27;--li:#232833;--li2:#2A303B;' +
    '--t0:#FFFFFF;--t1:#D3D9E2;--t2:#969EAA;--t3:#7C8490;' +
    '--mk:#FF6A3D;--mk2:#FF8A63;--vd:#2ECC8F;--rd:#FF6B6B;--am:#E8B14A;--px:#B06CFF;' +
    '--tin:14%;' +
    '--sh:rgba(0,0,0,.50);--shb:rgba(0,0,0,.28)}' +
    '*{box-sizing:border-box;margin:0;padding:0;font-family:"Outfit",-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-weight:300}' +
    /* sem isto, elemento sem cor explicita herdava o preto do documento da
       Shopee e sumia no tema escuro */
    '.painel,.painel *{color:inherit}' +
    'select,input,textarea,button{color:var(--t0);background-color:var(--b2)}' +
    'option{background:var(--b2);color:var(--t0)}' +
    '.botao{position:fixed;bottom:22px;right:22px;width:52px;height:52px;z-index:2147483010;border-radius:17px;cursor:pointer;box-shadow:0 8px 24px var(--sh),0 2px 6px var(--shb);transition:transform .15s;background:none;border:none;padding:0;overflow:hidden}' +
    '.botao svg{display:block;width:100%;height:100%}' +
    '.botao:hover{transform:scale(1.08)}' +
    /* O seletor irmao nao servia: o botao vem ANTES do painel no HTML e o til
       so alcanca irmaos posteriores. Classe direta resolve, e precisa vir
       DEPOIS da regra base para vencer na cascata. */

    '.botao svg{width:100%;height:100%}' +
    '.painel{position:fixed;top:0;right:0;height:100vh;width:min(760px,100vw);background:var(--b1);border-left:1px solid var(--li);border-radius:var(--r-painel,30px) 0 0 var(--r-painel,30px);box-shadow:-18px 0 60px var(--sh),0 6px 18px var(--shb);display:flex;flex-direction:column;overflow:hidden;color:var(--t0);transform:translateX(102%);transition:transform .26s cubic-bezier(.4,0,.2,1);z-index:2147483000}' +
    '.painel.aberto{transform:translateX(0)}' +
    '@media(prefers-reduced-motion:reduce){.painel{transition:none}}' +
    '.cab{display:flex;align-items:center;gap:12px;padding:18px 22px 15px;background:var(--b1);flex-wrap:wrap}' +
    '.cab .marca-ic{display:flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:18px;background:var(--t0);box-shadow:0 5px 14px var(--shb);font:500 26px Archivo,Outfit,Arial;letter-spacing:-.04em;color:var(--b1);flex:none}' +
    '.cab .marca-ic em{font-style:normal;color:var(--mk)}' +
    '.cab svg{width:28px;height:28px;flex:none}' +
    '.cab .titulo{font:500 25px Archivo,Outfit,Arial;letter-spacing:-.035em;line-height:1;color:var(--t0)}' +
    '.cab .titulo em{font-style:normal;color:var(--mk)}' +
    '.cab .info{font-family:Space Mono,monospace;font-size:11.5px;color:var(--t2);width:100%;order:3;margin-top:2px}' +
    '.cab .acoes{margin-left:auto;display:flex;gap:6px}' +
    '.cab button{background:var(--b1);border:1px solid var(--li2);color:var(--t1);font-family:Space Mono,monospace;font-size:11px;padding:8px 13px;border-radius:18px;cursor:pointer}' +
    '.cab button.ico{width:34px;height:34px;padding:0;display:grid;place-items:center}' +
    '.cab button.rec{display:flex;align-items:center;gap:8px;border-radius:999px;letter-spacing:.08em}' +
    '.cab button.rec i{width:9px;height:9px;border-radius:50%;background:var(--li2);display:block}' +
    '.cab button.rec.on{background:color-mix(in srgb,var(--rd) var(--tin,9%),var(--b1));border-color:var(--rd);color:var(--rd)}' +
    '.cab button.rec.on i{background:var(--rd);animation:siaPulse 1.2s infinite}' +
    '@keyframes siaPulse{0%,100%{opacity:1}50%{opacity:.3}}' +
    '.cab button:hover{border-color:var(--mk);color:var(--mk)}' +
    '.abas{display:flex;flex-wrap:wrap;gap:3px;background:var(--b1);padding:8px 18px 0;border-bottom:1px solid var(--li)}' +
    
    '.aba.ativa{color:var(--mk);border-bottom-color:var(--mk);background:none}' +
    '.subabas{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}' +
    '.subaba{background:var(--b2);border:1px solid var(--li);color:var(--t2);font-family:Space Mono,monospace;font-size:12px;padding:8px 14px;border-radius:var(--r-btn,14px);cursor:pointer}' +
    '.subaba.ativa{color:var(--t0);border-color:var(--mk);background:rgba(255,77,28,.1)}' +
    '.aba{display:flex;align-items:center;gap:7px;background:none;border:none;border-bottom:2px solid transparent;color:var(--t2);font-family:Space Mono,monospace;font-size:12.5px;letter-spacing:.02em;padding:10px 11px 11px;border-radius:0;white-space:nowrap;cursor:pointer}' +
    '.aba:hover{color:var(--mk)}' +
    '.aba.ativa{color:var(--t0);border-bottom-color:var(--mk)}' +
    '.corpo{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:24px 24px 30px;scrollbar-width:thin;scrollbar-color:var(--li2) transparent;background:var(--b1)}' +
    '.corpo::-webkit-scrollbar{width:10px}' +
    '.corpo::-webkit-scrollbar-track{background:transparent}' +
    '.corpo::-webkit-scrollbar-thumb{background:var(--li2);border-radius:99px;border:3px solid var(--b1)}' +
    '.corpo::-webkit-scrollbar-thumb:hover{background:var(--t3)}' +

    '.rodape{position:relative;flex:none;padding:10px 18px 14px;background:var(--b1);display:flex;justify-content:center}' +
    '.rodape button{width:auto;min-width:260px;max-width:80%;background:var(--mk);border:none;color:#fff;font-family:Outfit,Arial;font-weight:600;font-size:14.5px;padding:12px 28px;border-radius:999px;cursor:pointer;box-shadow:0 6px 18px color-mix(in srgb,var(--mk) 30%,transparent)}' +
    '.rodape button:hover{background:var(--mk2)}' +
    '.rodape button:disabled{opacity:.65;cursor:default}' +
    /* olho de secao: o padrao do Club — traco curto, mono pequeno, muito respiro */
    '.olho{display:flex;align-items:center;gap:10px;font-family:Space Mono,monospace;font-size:11px;color:var(--t2);letter-spacing:.13em;margin:30px 0 13px}' +
    '.olho:first-child{margin-top:0}' +
    '.olho::before{content:"";width:22px;height:2px;background:var(--mk);flex:none}' +
    '.leitura{margin-bottom:24px}' +
    '.leitura .fr{font-size:26px;font-weight:500;line-height:1.28;color:var(--t0);letter-spacing:-.02em}' +
    '.leitura .fr .d{color:var(--rd)}.leitura .fr .w{color:var(--am)}.leitura .fr .u{color:var(--vd)}' +
    '.leitura .ex{font-size:15.5px;color:var(--t1);margin-top:11px;line-height:1.6}' +
    '.tres{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--li);border:1px solid var(--li);border-radius:18px;overflow:hidden;margin-bottom:18px}' +
    '.tres>div{background:var(--b2);padding:19px 12px;text-align:center}' +
    '.tres .v{font-family:Archivo,Outfit,Arial;font-weight:600;font-size:36px;line-height:1;letter-spacing:-.03em}' +
    '.tres .l{font-family:Space Mono,monospace;font-size:10px;color:var(--t2);letter-spacing:.07em;margin-top:7px}' +
    '.tres .s{font-size:12.5px;color:var(--t2);margin-top:3px}' +
    /* cabecalho de tela: olho + display + numero fantasma, como no Club */
    '.capa{position:relative;padding:6px 0 18px;margin-bottom:18px;border-bottom:1px solid var(--li)}' +
    '.capa .ol{display:flex;align-items:center;gap:10px;font-family:Space Mono,monospace;font-size:11px;color:var(--mk);letter-spacing:.14em;margin-bottom:9px}' +
    '.capa .ol::before{content:"";width:22px;height:2px;background:var(--mk);flex:none}' +
    '.capa .dp{font-family:Archivo,Outfit,Arial;font-weight:400;font-size:31px;line-height:1.1;letter-spacing:-.025em;color:var(--t0)}' +
    '.capa .dp small{font-weight:600;font-size:inherit;color:var(--mk)}' +
    '.capa .dp small{font-family:"Bebas Neue";font-size:30px;color:var(--t2);margin-left:7px}' +
    '.capa .gh{position:absolute;top:-2px;right:0;font-family:"Bebas Neue";font-size:38px;line-height:1;color:var(--li);pointer-events:none;user-select:none}' +
    '.tit{font-family:Archivo,Outfit,Arial;font-weight:400;font-size:33px;letter-spacing:-.025em;line-height:1.1;color:var(--t0);margin-bottom:8px}' +
    '.lead{font-size:14px;color:var(--t1);line-height:1.55;margin-bottom:4px}' +
    '.corpo table{display:block;overflow-x:auto;white-space:nowrap}' +
    'table{width:100%;border-collapse:collapse;font-size:14.5px;background:var(--b0);border:1px solid var(--li);border-radius:var(--r-card,22px);overflow:hidden;margin:6px 0 14px}' +
    'th{text-align:left;color:var(--t2);font-size:11px;text-transform:uppercase;letter-spacing:.08em;padding:7px 8px;border-bottom:1px solid var(--mk);position:sticky;top:-14px;background:var(--b1)}' +
    'td{padding:11px 9px;border-bottom:1px solid var(--li);color:var(--t1);white-space:nowrap}' +
    'td.nome{white-space:normal;min-width:160px;color:var(--t0)}' +
    'tr:hover td{background:var(--b2)}' +
    '.num{text-align:right;font-variant-numeric:tabular-nums}' +
    '.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:9px;margin-bottom:20px}' +
    '.kpi{background:var(--b0);border:1px solid var(--li);border-radius:18px;padding:15px 13px}' +
    '.kpi .v{font-family:Archivo,Outfit,Arial;font-weight:600;font-size:34px;line-height:1;letter-spacing:-.03em;color:var(--mk)}' +
    '.kpi .l{font-family:Space Mono,monospace;font-size:9.5px;color:var(--t2);margin-top:6px;text-transform:uppercase;letter-spacing:.07em;line-height:1.35}' +
    '.vazio{color:var(--t2);font-size:15.5px;line-height:1.6;padding:30px 10px;text-align:center}' +
    '.selo{display:inline-block;font-size:9px;letter-spacing:.08em;text-transform:uppercase;border:1px solid var(--li);border-radius:99px;padding:2px 8px;color:var(--t2);margin-left:8px}' +
    '.selo.ok{border-color:var(--vd);color:var(--vd)}' +
    '.selo.off{border-color:var(--rd);color:var(--rd)}' +
    /* MODO GRAVACAO: borra o que identifica a conta do cliente, e so isso.
       Numero, veredito e o que vem do Espiao continuam legiveis, porque sao
       o conteudo que se quer mostrar na gravacao. */
    ':host(.gravando) .sigilo{filter:blur(5px);transition:filter .12s}' +
    ':host(.gravando) .sigilo:hover{filter:blur(0)}' +
    '.sigilo{border-radius:3px}' +
    '.dica{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;border:1px solid var(--li2);background:var(--b2);color:var(--t2);font-family:Space Mono,monospace;font-size:10px;cursor:pointer;padding:0;margin-left:5px;vertical-align:middle;line-height:1}' +
    '.dica:hover{border-color:var(--mk);color:var(--mk)}' +
    '.expl{display:none;padding:12px 15px;border-top:1px solid var(--li);background:var(--b2);font-size:13.5px;color:var(--t1);line-height:1.55}' +
    '.expl.on{display:block}' +
    '.expl b{color:var(--t0)}' +
    '.expl .x{float:right;background:none;border:none;color:var(--t2);cursor:pointer;font-size:15px;line-height:1;padding:0 0 0 10px}' +
    '.nota{font-size:14px;color:var(--t2);margin:12px 0;line-height:1.6}' +
    '.bloco-d{background:var(--b0);border:1px solid var(--li);border-radius:9px;padding:10px 12px;margin-bottom:9px}' +
    '.bloco-d .td{font-family:Space Mono,monospace;font-size:11px;letter-spacing:.06em;color:var(--mk);margin-bottom:7px}' +
    '.bloco-d .ld{font-size:13.5px;color:var(--t1);line-height:1.65;padding:2px 0}' +
    '.bloco-d .ld b{color:var(--t0)}' +
    '.bloco-d .vazio-d{color:var(--t3);font-style:italic;font-size:12.5px}' +
    '.tag-ads{color:var(--mk)}.tag-conta{color:var(--px)}.tag-cadastro{color:var(--vd)}.tag-marketing{color:var(--am)}.tag-outra{color:var(--t2)}.tag-afiliados{color:#e91e8c}.tag-performance{color:#3ab7f5}' +
    '</style>' +
    '<button class="botao" id="sia-abrir" title="Seller.IA">' + LOGO + '</button>' +
    '<div class="painel" id="sia-painel">' +
    '  <div class="cab">' +
    '    <span class="marca-ic">S<em>.</em></span>' +
    '    <span class="titulo">Seller<em>.</em>ia</span>' +
    '    <span class="info" id="sia-info"></span>' +
    '    <div class="acoes">' +
    '      <button id="sia-gravar" class="rec" title="Modo gravacao: borra nomes da conta"><i></i>REC</button>' +
    '      <button id="sia-tema" class="ico" title="Alternar claro e escuro">' + ICONE_LUA + '</button>' +
    '      <button id="sia-fechar" class="ico" title="Fechar">\u2715</button>' +
    '    </div>' +
    '  </div>' +
    '  <div class="abas" id="sia-abas"></div>' +
    '  <div class="corpo" id="sia-corpo"></div>' +
    '  <div class="rodape"><button id="sia-recoletar">Recoletar conta + Analisar</button></div>' +
    '  <div class="expl" id="sia-expl"></div>' +
    '</div>';

  var $ = function (id) { return raiz.getElementById(id); };
  // Ligar listener em elemento que nao existe derruba o arquivo INTEIRO e a
  // extensao abre vazia. Foi o que aconteceu ao remover o botao limpar no
  // redesign: o codigo continuou tentando ligar nele.
  function ligar(id, evento, fn) {
    var el = $(id);
    if (el) el.addEventListener(evento, fn);
    return !!el;
  }

  var abaAtiva = 'conta360';
  // Uma aba por PERGUNTA que o analista faz, na ordem em que ele pergunta.
  // 'Ferramentas' saiu: era caixa sem dono. A Margem virou parte do Cofre,
  // que e onde ela e usada, e Performance ganhou tela propria porque e
  // leitura de FUNIL, nao de Ads — estava enterrada dentro de Produtos.
  var ICONES_ABA = {
    conta360:    'M3.5 12.5 12 4l8.5 8.5M6 11v9h12v-9',
    performance: 'M3.5 4.5h17l-6.5 8v7l-4 2v-9z',
    gprod:       'M3.5 20.5V13M9 20.5V7M14.5 20.5v-5M20 20.5V3.5',
    campanhas:   'M3.5 20.5V13M9 20.5V7M14.5 20.5v-5M20 20.5V3.5',
    espiao:      'M1.8 12S5.6 5.5 12 5.5 22.2 12 22.2 12 18.4 18.5 12 18.5 1.8 12 1.8 12zM12 8.9a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2z',
    marketing:   'M20.5 12a2.2 2.2 0 0 1 0-4V4.5h-17V8a2.2 2.2 0 0 1 0 8v3.5h17V16a2.2 2.2 0 0 1 0-4z',
    cofre:       'M7.5 4.5h9a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3zM8.5 8.5h7M9 13h1.5M14 13h1.5M9 16.5h1.5M14 16.5h1.5',
    palavras:    'M13.5 3.5 20.5 10.5 12 19H5v-7zM16.5 14.5H9',
    semanal:     'M4.5 4.5h15a1.5 1.5 0 0 1 1.5 1.5v13a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19V6a1.5 1.5 0 0 1 1.5-1.5zM3 9h18M8 3v3M16 3v3',
    relatorio:   'M6.5 3.5h7l4.5 4.5v12a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1.5-1.5zM13.5 3.5V8H18M8.5 13h7M8.5 16.5h4',
    diagnostico: 'M12 3.5l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM18.5 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
    debug:       'M9 6 3.5 12 9 18M15 6l5.5 6L15 18'
  };
  function svgAba(id) {
    var d = ICONES_ABA[id];
    if (!d) return '';
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>';
  }

  var ABAS = [
    { id: 'conta360', rotulo: 'Inicio' },
    { id: 'performance', rotulo: 'Funil de Produto' },
    { id: 'gprod', rotulo: 'Shopee Ads' },
    { id: 'espiao', rotulo: 'Espiao' },
    { id: 'marketing', rotulo: 'Marketing' },
    { id: 'cofre', rotulo: 'Precificacao' },
    { id: 'palavras', rotulo: 'Palavras' },
    { id: 'semanal', rotulo: 'Semanal' },
    { id: 'relatorio', rotulo: 'Relatorio' },
    { id: 'diagnostico', rotulo: 'Especialista' },
    { id: 'debug', rotulo: 'Debug', tecnica: true }
  ];
  // grupos: uma aba de cima abre varias telas por dentro
  var SUB = {
    cofre: [
      { id: 'cofre', rotulo: 'Por quanto vender' },
      { id: 'calc', rotulo: 'Margem de um preco' }
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
  // As sub-abas do Espiao sao MODO, nao TELA: se entrarem em SUB, clicar em
  // Espiao troca abaAtiva para 'radar', que nao tem branch de render, e a
  // tela fica em branco. Elas sao desenhadas a mao dentro do renderEspiao.
  function renderModoEspiao(atual) {
    var opc = [{ id: 'radar', rot: 'Meus produtos' }, { id: 'busca', rot: 'Buscar termo' }];
    var h = '<div class="subabas">';
    for (var i = 0; i < opc.length; i++) {
      h += '<button class="subaba' + (opc[i].id === atual ? ' ativa' : '') + '" data-modo-esp="' + opc[i].id + '">' + opc[i].rot + '</button>';
    }
    return h + '</div>';
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

  ligar('sia-abrir', 'click', function () {
    // O botao fica SEMPRE visivel, como era antes de eu mexer: esconder
    // obrigava a fechar o painel para reabrir.
    $('sia-painel').classList.toggle('aberto');
    render();
  });
  ligar('sia-abrir', 'dblclick', function (ev) {
    ev.preventDefault(); estado.modoTecnico = !estado.modoTecnico; render();
  });
  ligar('sia-corpo', 'click', function (ev) {
    // PRIMEIRA PASSAGEM: acoes internas do card (expandir, excluir, calcular).
    // Sem isto o div do card, que e pai, capturava o clique e abria a tela do
    // card em vez de expandir — clicar no texto do link nao funcionava.
    var alvo = ev.target;
    // ORDEM IMPORTA. O card inteiro tem data-exp-camp, e os controles internos
    // (calculadora, excluir, botoes) sao FILHOS dele. Se o expandir for testado
    // primeiro, ele vence ao subir a arvore e nada mais funciona — foi o que
    // aconteceu. Agora ha duas voltas: a primeira procura so os controles
    // especificos, a segunda o expandir.
    var voltaA = ev.target;
    while (voltaA && voltaA !== this) {
      if (voltaA.getAttribute) {
        if (voltaA.tagName === 'INPUT' || voltaA.tagName === 'SELECT' || voltaA.tagName === 'TEXTAREA') return;
        if (voltaA.getAttribute('data-link-externo')) return;
        if (voltaA.id === 'sia-esp-exportar') {
          try {
            var bl = new Blob([JSON.stringify(estado.espiaoCru, null, 1)], { type: 'application/json' });
            var ur = URL.createObjectURL(bl);
            var aE = document.createElement('a');
            aE.href = ur; aE.download = 'espiao-bruto-' + (estado.espiaoCru.termo || 'busca').replace(/[^\w]/g, '-') + '.json';
            document.body.appendChild(aE); aE.click(); document.body.removeChild(aE);
            setTimeout(function () { try { URL.revokeObjectURL(ur); } catch (e) { } }, 30000);
          } catch (e) { mostrarExpl('Nao consegui gerar o arquivo: ' + esc(String(e))); }
          return;
        }
        if (voltaA.id === 'sia-prec-calcular') {
          // LE DIRETO DO DOM. Depender de listener de input era fragil: cada
          // render recria os campos e a ligacao se perde, entao o valor
          // digitado nunca chegava em estado.precific e a conta nao saia.
          estado.precific = estado.precific || {};
          var campos = corpoEl().querySelectorAll('[data-prec]');
          for (var cp2 = 0; cp2 < campos.length; cp2++) {
            estado.precific[campos[cp2].getAttribute('data-prec')] = campos[cp2].value;
          }
          estado.sujo = true; render(); return;
        }
        if (voltaA.id === 'sia-anon-salvar') {
          var ci = $('sia-anon');
          if (ci && ci.value.trim()) {
            estado.anonKey = ci.value.trim();
            try { chrome.runtime.sendMessage({ tipo: 'sia:pref-salvar', chave: 'anonKey', valor: estado.anonKey }, function () { void chrome.runtime.lastError; }); } catch (e4) { }
            mostrarExpl('<b>Chave salva.</b> O relatorio e o panorama semanal ja podem ser gerados.');
            render();
          }
          return;
        }
        var _cc2 = voltaA.getAttribute('data-calc-calcular');
        if (_cc2) {
          // idem para a calculadora do card
          estado.calcTmp = estado.calcTmp || {};
          estado.calcTmp[_cc2] = estado.calcTmp[_cc2] || {};
          var camposC = corpoEl().querySelectorAll('[data-calc]');
          for (var cc3 = 0; cc3 < camposC.length; cc3++) {
            var pr3 = camposC[cc3].getAttribute('data-calc').split(':');
            if (pr3[1] === _cc2) estado.calcTmp[_cc2][pr3[0]] = camposC[cc3].value;
          }
          estado.sujo = true; render(); return;
        }
        var _cs2 = voltaA.getAttribute('data-calc-salvar');
        if (_cs2) { salvarCalcDoCard(_cs2); return; }
        var _xc2 = voltaA.getAttribute('data-cofre-excluir');
        if (_xc2) { excluirDoCofre(_xc2); return; }
        var _cmp2 = voltaA.getAttribute('data-comparar');
        if (_cmp2) { compararComVitrine(_cmp2); return; }
        if (voltaA.id === 'sia-sem-gerar') { estado.semanal = estado.semanal || {}; try { gerarSemanal(); } catch (e3) { estado.semanal.erro = 'Erro: ' + String(e3 && e3.message || e3); render(); } return; }
        if (voltaA.id === 'sia-sem-novo') { estado.semanal = estado.semanal || {}; estado.semanal.markdown = null; render(); return; }
        if (voltaA.id === 'sia-sem-pdf') { imprimirSemanal(); return; }
        if (voltaA.id === 'sia-profunda') { if (estado.coletaProgresso === null) { coletaCompleta(function () { render(); }, null, 'profunda'); render(); } return; }
        if (voltaA.id === 'sia-rel-gerar' || voltaA.id === 'sia-rel-pdf' || voltaA.id === 'sia-rel-copiar' || voltaA.id === 'sia-rel-novo') break;
      }
      voltaA = voltaA.parentNode;
    }
    // SEGUNDA VOLTA: expandir card de campanha
    var voltaB = ev.target;
    while (voltaB && voltaB !== this) {
      if (voltaB.getAttribute) {
        var _ec3 = voltaB.getAttribute('data-exp-camp');
        if (_ec3) { estado.campExpandida = (estado.campExpandida === _ec3) ? null : _ec3; render(); return; }
      }
      voltaB = voltaB.parentNode;
    }

    var el = ev.target;
    while (el && el !== this) {
      if (el.getAttribute) {
        // sem isto o clique e capturado pela linha e o href nunca e seguido
        if (el.getAttribute('data-link-externo')) return;
        if (el.id === 'sia-fila-mais') { estado.filaCompleta = true; render(); return; }
        var mde = el.getAttribute && el.getAttribute('data-modo-esp');
        if (mde) { estado.espiaoModo = mde; render(); return; }
        if (el.id === 'sia-esp-analisar') {
          try {
            var sel = raiz.getElementById ? raiz.getElementById('sia-esp-prod') : $('sia-esp-prod');
            var campo = $('sia-esp-termo');
            estado.espiao.termoManual = (campo && campo.value.trim()) || null;
            if (!campo) estado.espiao.termoManual = null;   // Radar usa o titulo
            if (!sel || !sel.value) { estado.espiao.erro = 'Escolha um produto na lista primeiro.'; render(); return; }
            espAnalisarProduto(sel.value);
          } catch (err) {
            estado.espiao.buscando = false;
            estado.espiao.erro = 'Erro ao comparar: ' + String((err && err.message) || err);
            render();
          }
          return;
        }
        if (el.getAttribute('data-voltar-radar')) { estado.espiao.erro = null; estado.espiao.res = null; render(); return; }
        var cf = el.getAttribute && el.getAttribute('data-camp-filtro');
        if (cf) { estado.verPausadas = (cf === 'pausadas'); render(); return; }
        // Estes botoes eram ligados por addEventListener depois de cada render.
        // Qualquer render extra entre o desenho e a religacao deixava o botao
        // morto — clicava e nada acontecia, sem erro. Na delegacao global eles
        // funcionam sempre, porque o listener vive no container que nao e
        // recriado.
        if (el.id === 'sia-sem-gerar') { gerarSemanal(); return; }
        if (el.id === 'sia-sem-novo') { estado.semanal.markdown = null; render(); return; }
        if (el.id === 'sia-sem-pdf') { imprimirSemanal(); return; }
        if (el.id === 'sia-rel-gerar') {
          // Sem este try, um ReferenceError dentro de gerarRelatorio morria no
          // console e o botao "nao fazia nada" — que foi exatamente o caso do
          // inicioDoDiaBRT. Agora o erro aparece na tela, com a linha.
          try { gerarRelatorio(); }
          catch (err) {
            estado.rel.gerando = false; estado.rel.etapa = '';
            estado.rel.erro = 'Erro interno ao gerar: ' + String((err && err.message) || err);
            try { console.error('[Seller.IA] gerarRelatorio:', err); } catch (e2) { }
            render();
          }
          return;
        }
        if (el.id === 'sia-rel-pdf') { imprimirRelatorio(); return; }
        if (el.id === 'sia-rel-copiar') {
          try { navigator.clipboard.writeText(estado.rel.markdown || ''); mostrarExpl('<b>Relatorio copiado.</b> Cole onde precisar.'); } catch (e) { /* noop */ }
          return;
        }
        if (el.id === 'sia-rel-novo') { estado.rel.markdown = null; render(); return; }
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
        // o handler do "?" sumiu numa das refatoracoes: o botao era desenhado
        // mas nada escutava o clique
        var dd = el.getAttribute && el.getAttribute('data-dica');
        if (dd) { mostrarExpl(DICAS[dd] || dd); return; }
        var esp = el.getAttribute && el.getAttribute('data-espiar');
        if (esp) {
          try {
          abaAtiva = 'espiao';
          var prodOrigem = el.getAttribute('data-prod') || null;
          estado.espiao.meuProduto = prodOrigem ? { nome: prodOrigem } : null;
          estado.espiao.termo = esp; estado.espiao.buscando = true; estado.espiao.erro = null;
          estado.espiao.volumes = null; estado.espiao.res = null; render();
          espBuscar(esp, function (resp) {
            estado.espiao.buscando = false;
            if (!resp || !resp.ok) { estado.espiao.erro = (resp && resp.erro) || 'Falhou.'; estado.espiao.res = null; }
            else {
              var lst = espMapear(resp.itens);
              estado.espiao.res = { termo: resp.termo, lista: lst, barreira: espBarreira(lst) };
            }
            render();
          });
          } catch (err) {
            estado.espiao.buscando = false;
            estado.espiao.erro = 'Erro interno ao espiar: ' + String((err && err.message) || err);
            try { console.error('[Seller.IA] espiar:', err); } catch (e2) { }
            render();
          }
          return;
        }
        var sb = el.getAttribute && el.getAttribute('data-sub');
        if (sb) { var pr = sb.split(':'); subAtiva[pr[0]] = pr[1]; abaAtiva = pr[1]; render(); return; }
        if (el.id === 'sia-vinc-ok') {
          var sel = $('sia-vinc');
          if (sel) { salvarVinculo(el.getAttribute('data-camp'), sel.value); render(); }
          return;
        }
        if (el.getAttribute('data-voltar')) { abaAtiva = (estado.cardVoltaPara && TELAS_VALIDAS.indexOf(estado.cardVoltaPara) >= 0) ? estado.cardVoltaPara : 'performance'; render(); return; }
        var d = el.getAttribute('data-card');
        if (d) { var p = d.split(':'); estado.cardVoltaPara = abaAtiva; abrirCard(p[0], p.slice(1).join(':')); return; }
      }
      el = el.parentNode;
    }
  });
  ligar('sia-recoletar', 'click', function () {
    if (estado.coletaProgresso !== null) return;
    coletaJaTentada = true;
    coletaCompleta(function () { render(); });
    render();
  });
  ligar('sia-fechar', 'click', function () {
    $('sia-painel').classList.remove('aberto');
  });
  ligar('sia-limpar', 'click', function () {
    estado.campanhas = {}; estado.produtos = {};
    estado.conta = { campos: {}, atualizadoEm: null };
    estado.afiliados = { campos: {}, atualizadoEm: null };
    estado.chamadas = []; estado.brutos = []; estado.sujo = true;
    try { chrome.runtime.sendMessage({ tipo: 'sia:limpar' }, function () { void chrome.runtime.lastError; }); } catch (e) { /* noop */ }
    render();
  });
  ligar('sia-exportar', 'click', function () {
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
      // O card ficava sempre marcando 'Shopee Ads' como aba ativa, mesmo
      // aberto pelo Funil de Produto — era isso que dava a sensacao de ser
      // levada para o Ads. Agora ele destaca a aba DE ONDE veio.
      var ativo = (a.id === abaAtiva) || (SUB[a.id] && grupoDe(abaAtiva) === a.id) ||
        (abaAtiva === 'card' && a.id === (estado.cardVoltaPara || 'gprod'));
      h += '<button class="aba' + (ativo ? ' ativa' : '') + '" data-aba="' + a.id + '">' + svgAba(a.id) + a.rotulo + '</button>';
    }
    $('sia-abas').innerHTML = h;
    var botoes = $('sia-abas').querySelectorAll('.aba');
    for (var b = 0; b < botoes.length; b++) {
      botoes[b].addEventListener('click', function () {
        var alvo = this.getAttribute('data-aba');
        // SUB[alvo] pode existir e estar VAZIO: SUB[alvo][0].id dava undefined
        // e abaAtiva virava undefined, sem branch de render — a aba nao abria.
        var sublist = SUB[alvo];
        abaAtiva = (sublist && sublist.length) ? (subAtiva[alvo] || sublist[0].id) : alvo;
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
    var gg = null;
    try { gg = window.SIA_Diamantes ? window.SIA_Diamantes.estado().gerenciais : null; } catch (e) { /* noop */ }
    var perTxt = '';
    if (gg && gg.periodoIni && gg.periodoFim) {
      var dIni = new Date(gg.periodoIni * 1000), dFim = new Date(gg.periodoFim * 1000);
      function dd(x) { return String(x.getUTCDate()).padStart(2, '0') + '/' + String(x.getUTCMonth() + 1).padStart(2, '0'); }
      perTxt = ' &middot; periodo lido: <b>' + dd(dIni) + ' a ' + dd(dFim) + '</b>' + (gg.periodoDias ? ' (' + gg.periodoDias + ' dias)' : '');
    }
    // Sem dizer QUAL periodo esta na tela, um numero grande parecia erro.
    var h = '<div class="nota">Informacoes Gerenciais (' + (atualizadoEm ? hora(atualizadoEm) : '') + ')' + perTxt + ' — variacao vs periodo anterior fornecida pela propria Shopee:</div>';
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

    var busca = (estado.buscaPalavra || '').toLowerCase().trim();
    var h = '<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">' +
      '<input id="sia-kw-busca" value="' + esc(estado.buscaPalavra || '') + '" placeholder="procurar um termo na lista" ' +
      'style="flex:1;min-width:200px;background:var(--b0);border:1px solid var(--li);border-radius:9px;padding:11px 12px;color:var(--t0);font-size:13.5px"></div>';
    h += '<div class="leitura"><div class="fr">' + frase + '</div><div class="ex">' + expl + '</div></div>';

    // ROSCA no lugar dos tres numeros soltos: e o grafico do layout, e ele
    // mostra a proporcao entre as categorias, nao so a contagem.
    h += roscaSemaforo([
      { n: R.contagem.vermelho, rot: 'sangrando', cor: 'var(--rd)' },
      { n: R.contagem.verde, rot: 'saudaveis', cor: 'var(--vd)' },
      { n: R.contagem.amarelo, rot: 'sufocadas', cor: 'var(--am)' },
      { n: R.contagem.cinza || 0, rot: 'aprendendo', cor: 'var(--li2)' }
    ], R.total, 'CAMPANHAS');

    if (gastoRuim) {
      h += '<div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;background:color-mix(in srgb,var(--rd) var(--tin,9%),var(--b0));border:1px solid color-mix(in srgb,var(--rd) 22%,var(--li));border-radius:var(--r-card,22px);padding:16px 20px;margin-bottom:16px">' +
        '<span style="font-family:Space Mono,monospace;font-size:10px;color:var(--t2);letter-spacing:.1em">EM RISCO</span>' +
        '<span style="font-family:Archivo,Outfit,Arial;font-weight:500;font-size:29px;color:var(--rd);letter-spacing:-.02em">' + reais(gastoRuim) + '</span>' +
        '<span style="font-size:13.5px;color:var(--t1)">e o que essas campanhas consomem sem devolver</span></div>';
    }

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
      h += '<div style="background:color-mix(in srgb,var(--vd) var(--tin,9%),var(--b0));border:1px solid color-mix(in srgb,var(--vd) 30%,var(--li));border-radius:10px;padding:16px;text-align:center;color:var(--vd);font-size:13px">Tudo sob controle. Nenhuma campanha pedindo acao agora.</div>';
    } else {
      h += olho('O QUE FAZER PRIMEIRO', 'A fila ordena por dinheiro em jogo, nao por gravidade. Um problema numa campanha que gasta R$ 800 vem antes de um problema em campanha que gasta R$ 8 — mesmo que a segunda esteja mais quebrada. Clique em qualquer linha para abrir o card completo.');
      var LIMITE = 5;
      var mostrar = estado.filaCompleta ? R.fila : R.fila.slice(0, LIMITE);
      mostrar.forEach(function (c) {
        var co = CORES_SEM[c.nivel];
        h += '<div' + (c.id ? ' data-card="campanha:' + esc(c.id) + '" style="cursor:pointer;' : ' style="') + 'background:' + co.bg + ';border:1px solid ' + co.bd + ';border-left:3px solid ' + co.dot + ';border-radius:var(--r-card,22px);padding:15px 16px;margin-bottom:9px;transition:border-color .15s">';
        h += '<div style="display:flex;align-items:baseline;gap:9px;margin-bottom:6px">' +
          '<span style="flex:1;font-size:17.5px;font-weight:600;color:var(--t0);line-height:1.25;letter-spacing:-.015em">' + esc(c.titulo) + '</span>' +
          '<span style="font-family:Space Mono,monospace;font-size:12px;color:var(--t2);flex:none">R$ ' + c.gasto.toFixed(2).replace('.', ',') + '</span></div>';
        if (c.campanha) h += '<div style="font-size:13px;color:var(--t2);margin-bottom:6px;line-height:1.35">' + sig(c.campanha) +
          '<span style="font-family:Space Mono,monospace;color:var(--t3)">' + (c.roas ? '  ROAS ' + c.roas.toFixed(1) + 'x' : '') + (c.posicao ? '  pos ' + c.posicao : '') + '</span></div>';
        h += '<div style="font-size:15px;color:var(--t1);line-height:1.5">' + esc(c.texto) + '</div>';
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
    // NAO auto-disparar quando ja ha dado lido. Antes, abrir a Conta 360
    // iniciava uma coleta a cada render — e coleta rodando bloqueia o
    // relatorio, que foi o que travou o teste.
    if (Object.keys(estado.produtos).length || Object.keys(estado.campanhas).length) {
      coletaJaTentada = true;
      if (status) { status.textContent = 'conta ja lida. Toque em Coletar para atualizar.'; status.style.color = 'var(--t2)'; }
      return;
    }
    if (estado.rel && estado.rel.gerando) return;   // relatorio em andamento manda
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
    var i = 'width:100%;box-sizing:border-box;background:var(--b1);border:1px solid var(--li);border-radius:8px;padding:9px 11px;color:var(--t0);font-size:13px;margin-top:4px';
    var lbl = 'font-size:11px;color:var(--t2);font-weight:600';
    var h = avisoFalta + '<div style="padding:2px">';
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

  function salvarCalcDoCard(id) {
    // le do DOM antes de salvar, pelo mesmo motivo
    try {
      estado.calcTmp = estado.calcTmp || {};
      estado.calcTmp[id] = estado.calcTmp[id] || {};
      var cs3 = corpoEl().querySelectorAll('[data-calc]');
      for (var q4 = 0; q4 < cs3.length; q4++) {
        var pr4 = cs3[q4].getAttribute('data-calc').split(':');
        if (pr4[1] === id) estado.calcTmp[id][pr4[0]] = cs3[q4].value;
      }
    } catch (e) { /* noop */ }
    var tmpC = (estado.calcTmp && estado.calcTmp[id]) || {};
    var vc = numeroPuro(tmpC.custo);
    if (!vc) { mostrarExpl('<b>Preencha o custo do produto</b> para o sistema calcular a margem real.'); return; }
    estado.cofre.custos = estado.cofre.custos || {};
    estado.cofre.custos[id] = vc;
    if (numeroPuro(tmpC.embalagem)) estado.cofre.embalagem = numeroPuro(tmpC.embalagem);
    if (numeroPuro(tmpC.imposto)) estado.cofre.imposto = numeroPuro(tmpC.imposto);
    salvarCofre();
    mostrarExpl('<b>Custo salvo.</b> O piso de ROAS deste produto passa a usar a margem real, e o relatorio tambem.');
    render();
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
    var h = '<div class="bloco-d" style="border-color:' + (m.noLucro ? 'color-mix(in srgb,var(--vd) 30%,var(--li))' : 'color-mix(in srgb,var(--rd) 30%,var(--li))') + '">';
    h += '<div class="td">RESULTADO · ' + esc(m.faixa) + '</div>';
    // cascata de custos
    h += '<div class="ld">Preco de venda: <b>' + fr(m.preco) + '</b></div>';
    h += '<div class="ld" style="color:var(--t2)">− Custo produto: ' + fr(m.custoProduto) + (m.outros ? ' · outros ' + fr(m.outros) : '') + '</div>';
    h += '<div class="ld" style="color:var(--t2)">− Comissao Shopee (' + m.comissao.pct + '%): ' + fr(m.comissao.reais) + ' + taxa fixa ' + fr(m.taxaFixa) + '</div>';
    if (m.imposto.reais > 0) h += '<div class="ld" style="color:var(--t2)">− Imposto (' + m.imposto.pct + '%): ' + fr(m.imposto.reais) + '</div>';
    if (m.ads > 0) h += '<div class="ld" style="color:var(--t2)">− Ads por venda: ' + fr(m.ads) + '</div>';
    h += '<div style="border-top:1px solid var(--li);margin:8px 0 6px"></div>';
    h += '<div class="ld" style="font-size:15px">Lucro por venda: <b style="color:' + corLucro + '">' + fr(m.lucro) + '</b> <span style="color:var(--t2);font-size:12px">(margem ' + m.margemPct + '%)</span></div>';
    if (!m.noLucro) h += '<div class="ld" style="color:var(--rd);font-size:11px;margin-top:4px">Atencao: este produto esta no PREJUIZO com esses numeros.</div>';
    // ROAS minimo + cruzamento
    if (m.roasMinimo) {
      h += '<div style="border-top:1px solid var(--li);margin:8px 0 6px"></div>';
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
    h += '<div style="background:var(--b0);border:1px solid var(--li);border-radius:18px;padding:14px 10px;display:flex;align-items:flex-end;gap:3px;margin-bottom:11px">';
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
      h += '<div style="background:var(--b0);border-left:3px solid var(--rd);border-radius:0 16px 16px 0;padding:12px 14px;font-size:13.5px;color:var(--t1);line-height:1.55">' +
        '<b style="color:var(--t0)">A maior perda esta aqui:</b> de ' + fmt(quantosAntes, 0) + ' que chegaram em ' + deTxt + ', ' + fmt(quantosDepois, 0) + ' seguiram para ' + paraTxt + '. ' +
        '<span style="color:var(--rd)">Perde ' + fmt(pior.pct, 0) + '% neste degrau.</span><br>' + conselho + '</div>';
    }
    return h;
  }

  /* ============ SELETOR DE PERIODO DA CONTA 360 ============
     Antes a tela herdava o periodo que estivesse aberto no painel da Shopee,
     entao o mesmo numero podia ser de 7, 30 ou 90 dias sem ninguem saber.
     Agora a tela escolhe e diz qual recorte esta mostrando. */
  var PERIODOS = [
    { id: '7', rot: 'Ultimos 7 dias', dias: 7 },
    { id: '30', rot: 'Ultimos 30 dias', dias: 30 },
    { id: 'mes', rot: 'Este mes', dias: null },
    { id: 'mesant', rot: 'Mes passado', dias: null }
  ];
  function faixaDoPeriodo(id) {
    var hoje0 = inicioDoDiaBRT(Math.floor(Date.now() / 1000));
    if (id === 'mes') {
      var d = new Date();
      return { inicio: Date.UTC(d.getFullYear(), d.getMonth(), 1, 3, 0, 0) / 1000, fim: hoje0 };
    }
    if (id === 'mesant') {
      var d2 = new Date();
      return {
        inicio: Date.UTC(d2.getFullYear(), d2.getMonth() - 1, 1, 3, 0, 0) / 1000,
        fim: Date.UTC(d2.getFullYear(), d2.getMonth(), 1, 3, 0, 0) / 1000
      };
    }
    var n = parseInt(id, 10) || 30;
    return { inicio: hoje0 - n * 86400, fim: hoje0 };
  }
  // O periodo volta a ser o do painel da Shopee: e o que ela ja validou.
  // A tela apenas DIZ qual e, para nunca mais haver duvida sobre de onde
  // vem o numero.
  function renderAvisoPeriodo() {
    var gg = null;
    try { gg = window.SIA_Diamantes ? window.SIA_Diamantes.estado().gerenciais : null; } catch (e) { /* noop */ }
    var h = '';
    if (gg && gg.periodoIni && gg.periodoFim) {
      var di = new Date(gg.periodoIni * 1000), df = new Date(gg.periodoFim * 1000);
      function dd(x) { return String(x.getUTCDate()).padStart(2, '0') + '/' + String(x.getUTCMonth() + 1).padStart(2, '0'); }
      var rotP = (estado.periodoMydata && estado.periodoMydata.rotulo) || null;
      var ROT_PER = { month: 'Por mes', week: 'Por semana', day: 'Por dia', yesterday: 'Ontem', realtime: 'Tempo real', custom: 'Personalizado' };
      h += '<div class="nota">Periodo lido: <b>' + dd(di) + ' a ' + dd(df) + '</b>' + (gg.periodoDias ? ' (' + gg.periodoDias + ' dias' + (rotP ? ', ' + (ROT_PER[rotP] || rotP) : '') + ')' : '') +
        ' &middot; e o recorte que estava aberto no painel da Shopee. Para trocar, mude o periodo no painel e colete de novo.</div>';
    }
    if (estado.coletaProgresso !== null) {
      h += '<div class="nota" style="color:var(--mk)">Lendo: ' + esc(String(estado.coletaProgresso)) + '</div>';
    } else {
      h += '<div class="nota" style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">' +
        '<button id="sia-profunda" style="background:var(--b0);border:1px solid var(--li2);color:var(--t1);font-family:inherit;font-size:12.5px;padding:8px 14px;border-radius:var(--r-btn,14px);cursor:pointer">Leitura profunda</button>' +
        '<span>Acrescenta a serie hora a hora e as palavras por produto. Leva alguns minutos.</span></div>';
    }
    return h;
  }
  function renderSeletorPeriodo() {
    var atual = estado.periodo360 || '30';
    var h = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">';
    for (var i = 0; i < PERIODOS.length; i++) {
      var p = PERIODOS[i], on = p.id === atual;
      h += '<button data-per360="' + p.id + '" style="background:' + (on ? 'var(--mk)' : 'var(--b2)') + ';border:1px solid ' + (on ? 'var(--mk)' : 'var(--li)') + ';color:' + (on ? '#fff' : 'var(--t1)') + ';font-family:inherit;font-size:12.5px;padding:8px 14px;border-radius:var(--r-btn,14px);cursor:pointer">' + p.rot + '</button>';
    }
    h += '</div>';
    if (estado.coletaProgresso !== null) {
      h += '<div class="nota" style="color:var(--mk)">Lendo: ' + esc(String(estado.coletaProgresso)) + '</div>';
    } else {
      h += '<div class="nota" style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">' +
        '<button id="sia-profunda" style="background:var(--b0);border:1px solid var(--li2);color:var(--t1);font-family:inherit;font-size:12.5px;padding:8px 14px;border-radius:var(--r-btn,14px);cursor:pointer">Leitura profunda</button>' +
        '<span>A leitura normal cobre conta, produtos e campanhas. A profunda acrescenta a serie hora a hora e as palavras-chave, e leva alguns minutos.</span></div>';
    }
    return h;
  }
  function ligarSeletorPeriodo() {
    var bs = corpoEl().querySelectorAll('[data-per360]');
    for (var i = 0; i < bs.length; i++) {
      bs[i].addEventListener('click', function () {
        if (estado.coletaProgresso !== null) return;
        estado.periodo360 = this.getAttribute('data-per360');
        var f = faixaDoPeriodo(estado.periodo360);
        try { if (window.SIA_Diamantes && window.SIA_Diamantes.zerar) window.SIA_Diamantes.zerar('troca de periodo da Conta 360'); } catch (e) { /* noop */ }
        estado.campanhas = {}; estado.produtos = {}; estado.conta = { campos: {}, atualizadoEm: null };
        render();
        coletaCompleta(function () { render(); }, f, 'rapida');
      });
    }
  }
  function corpoEl() { return $('sia-corpo'); }
  function ligarProfunda() {
    var b = $('sia-profunda');
    if (!b) return;
    b.addEventListener('click', function () {
      if (estado.coletaProgresso !== null) return;
      coletaCompleta(function () { render(); }, null, 'profunda');
      render();
    });
  }

  /* ============ DE ONDE VEM CADA VENDA ============
     Separa o que a loja CONQUISTA (busca) do que o algoritmo EMPRESTA
     (recomendacao). Loja que vive de recomendacao e fragil e nao sabe:
     a Shopee pode cortar a entrega amanha sem aviso. */
  function renderOrigem() {
    var D = null;
    try { D = window.SIA_Diamantes ? window.SIA_Diamantes.estado() : null; } catch (e) { /* noop */ }
    var O = D && D.origem;
    if (!O || !O.canais || !O.canais.length) return '';

    var busca = 0, recom = 0;
    for (var i = 0; i < O.canais.length; i++) {
      if (O.canais[i].origem === 'Busca') busca = O.canais[i].pctVendas;
      if (O.canais[i].origem === 'Recomendacao') recom = O.canais[i].pctVendas;
    }
    var h = olho('DE ONDE VEM CADA VENDA', '<b>Busca e o que voce conquista</b>: o comprador procurou e escolheu voce, por titulo, preco e avaliacao. <b>Recomendacao e o que o algoritmo empresta</b>: ele decidiu te mostrar. A diferenca importa porque recomendacao pode ser cortada da noite para o dia, e busca so cai se voce piorar. Loja que vive de recomendacao tem faturamento que nao controla.');

    var fr, ex;
    if (recom >= busca) {
      fr = '<span class="w">' + fmt(recom, 0) + '% das suas vendas vem de recomendacao</span>, contra ' + fmt(busca, 0) + '% de busca.';
      ex = 'A maior parte do que voce vende hoje depende do algoritmo escolher te mostrar. Isso pode mudar sem aviso. O caminho e ganhar busca: titulo com o termo certo, preco competitivo e avaliacao.';
    } else if (busca >= 60) {
      fr = '<span class="u">' + fmt(busca, 0) + '% das vendas vem de busca</span>.';
      ex = 'A maior parte do faturamento e conquistada, nao emprestada. E a base mais solida que uma loja pode ter: so cai se voce piorar.';
    } else {
      fr = fmt(busca, 0) + '% das vendas vem de busca e ' + fmt(recom, 0) + '% de recomendacao.';
      ex = 'Divisao equilibrada. A busca e o que voce controla; a recomendacao e bonus que o algoritmo da enquanto o produto performa.';
    }
    h += '<div class="leitura"><div class="fr">' + fr + '</div><div class="ex">' + ex + '</div></div>';

    // barras em vez de tabela: participacao se le melhor com barra
    var itensB = [];
    for (i = 0; i < O.canais.length; i++) {
      var cB = O.canais[i];
      if (cB.pctVendas < 0.5) continue;
      itensB.push({
        rot: cB.origem, v: cB.pctVendas,
        txt: fmt(cB.pctVendas, 1) + '%' + (cB.ticket != null ? '  \u00b7  ticket ' + reais(cB.ticket) : ''),
        cor: cB.origem === 'Busca' ? 'var(--vd)' : (cB.origem === 'Recomendacao' ? 'var(--am)' : 'var(--li2)')
      });
    }
    h += barraPct(itensB);
    h += '<table><tr><th>ORIGEM</th><th class="num">% VENDAS</th><th class="num">CLIQUE&rarr;PEDIDO</th><th class="num">TICKET</th></tr>';
    for (i = 0; i < O.canais.length; i++) {
      var c = O.canais[i];
      if (c.pctVendas < 0.5) continue;
      var cor = c.origem === 'Busca' ? 'var(--vd)' : (c.origem === 'Recomendacao' ? 'var(--am)' : 'var(--t1)');
      h += '<tr><td style="color:' + cor + '">' + esc(c.origem) + '</td>' +
        '<td class="num">' + fmt(c.pctVendas, 1) + '%</td>' +
        '<td class="num">' + (c.cliqueParaPedido != null ? fmt(c.cliqueParaPedido, 2) + '%' : '\u2014') + '</td>' +
        '<td class="num">' + (c.ticket != null ? reais(c.ticket) : '\u2014') + '</td></tr>';
    }
    h += '</table>';

    h += '<div class="nota">Canais no periodo: Shopee Ads ' + reais(O.adsPago || 0) +
      (O.adsVar != null ? ' (' + (O.adsVar >= 0 ? '+' : '') + fmt(O.adsVar, 1) + '%)' : '') +
      ' &middot; afiliados ' + reais(O.afiliados || 0) + ' = ' + fmt(O.afiliadosRatio, 1) + '% do total' +
      (O.afiliadosVar != null ? ' (' + (O.afiliadosVar >= 0 ? '+' : '') + fmt(O.afiliadosVar, 1) + '%)' : '') + '.</div>';
    return h;
  }

  /* ============ PERDA DEPOIS DO PEDIDO ============
     Pedido colocado que nao vira confirmado. E receita que aparece no
     painel e some do caixa — e ninguem audita isso. */
  function renderPerdaPosPedido() {
    // CORRECAO: "confirmado" e identico a "pago" no dado da Shopee — verificado
    // nas capturas. A perda real e colocado -> PAGO, ou seja PEDIDO NAO PAGO:
    // boleto e Pix que o comprador gerou e nao pagou. Chamar de "nao
    // confirmado" era jargao que ninguem usa. E vale a pena mostrar porque o
    // painel so deixa filtrar pago ou nao pago, nunca a TAXA entre os dois
    // ao longo dos dias.
    var D = null;
    try { D = window.SIA_Diamantes ? window.SIA_Diamantes.estado() : null; } catch (e) { /* noop */ }
    var T = D && D.tendencia;
    if (!T || !T.perdaPosPedido || T.perdaPosPedido.perdaPct == null) return '';
    var P = T.perdaPosPedido;
    if (P.perdaPct < 3) return '';

    var grave = P.perdaPct >= 15;
    var naoPagos = P.totalColocado - P.totalConfirmado;
    var h = olho('PEDIDOS QUE NAO FORAM PAGOS', 'O comprador finalizou o pedido e nao pagou: boleto vencido, Pix nao concluido ou cartao recusado. O vendedor nao escolhe os meios de pagamento na Shopee, entao o que da para mexer e o que acontece ANTES de pagar: cupom, frete e lembrete por chat. O painel deixa filtrar pago ou nao pago, mas nao mostra a TAXA entre os dois ao longo dos dias \u2014 e e a taxa que revela se e normal da categoria ou se algo mudou no seu checkout.');
    h += '<div style="background:color-mix(in srgb,' + (grave ? 'var(--rd)' : 'var(--am)') + ' var(--tin,9%),var(--b2));border-left:3px solid ' + (grave ? 'var(--rd)' : 'var(--am)') + ';border-radius:0 18px 18px 0;padding:15px 16px;margin-bottom:12px">' +
      '<div style="font-size:16px;font-weight:600;color:var(--t0);margin-bottom:5px">' + fmt(naoPagos, 0) + ' pedidos nao foram pagos (' + fmt(P.perdaPct, 1) + '%)</div>' +
      '<div style="font-size:14px;color:var(--t1);line-height:1.55">De ' + fmt(P.totalColocado, 0) + ' pedidos feitos no periodo, ' + fmt(P.totalConfirmado, 0) + ' foram pagos. ' +
      (P.diasRuins ? 'Em ' + P.diasRuins + ' dia' + (P.diasRuins > 1 ? 's' : '') + ' a taxa passou de 10%.' : '') +
      ' Ate 10% e comum quando ha boleto; acima disso vale investigar.</div>' +
      '<div style="font-size:13.5px;color:' + (grave ? 'var(--rd)' : 'var(--am)') + ';margin-top:8px;line-height:1.55">' +
      '\u2192 Cupom com valor minimo alto faz desistir na hora de pagar<br>' +
      '\u2192 Frete que so aparece no fim do checkout derruba pedido pronto<br>' +
      '\u2192 Use Transmissao por Chat para lembrar quem gerou boleto e nao pagou</div></div>';
    return h;
  }

  /* ============ AS 24 HORAS ============
     O padrao do dia nao aparece em nenhum numero consolidado. Nos dados
     reais, a tarde consumia 42% do dinheiro e entregava 13% dos pedidos —
     custando 8x mais por pedido que a noite, com CPM MENOR. Ou seja: nao se
     paga mais por impressao, paga-se por impressao que nao converte. */
  /* ============ O QUE A META RECOMENDADA REALMENTE E ============
     Descoberta no campo recommendation_percentiles: exact = percentil 50,
     lower_bound = percentil 80, upper_bound = percentil 20. Ou seja, a meta
     que a Shopee sugere e a MEDIANA DA CATEGORIA — nao um calculo do custo
     ou da margem deste lojista. E a categoria inclui quem vende sem margem
     e quem esta queimando estoque. */
  /* ============ O QUE FOI LIDO ============
     Sem isto, quando algo nao aparece na tela nao da para saber se e porque
     a conta nao tem aquele dado, se a rota falhou, ou se foi o periodo. */
  function renderDiagnosticoColeta() {
    var dc = estado.diarioColeta;
    if (!dc || !dc.periodo) return '';
    var D = null;
    try { D = window.SIA_Diamantes ? window.SIA_Diamantes.estado() : null; } catch (e) { /* noop */ }
    function dd(ts) {
      var x = new Date(ts * 1000);
      return String(x.getUTCDate()).padStart(2, '0') + '/' + String(x.getUTCMonth() + 1).padStart(2, '0');
    }
    var itens = [
      { rot: 'Indicadores da conta', ok: !!(D && D.gerenciais && D.gerenciais.gmvPago) },
      { rot: 'Produtos', ok: Object.keys(estado.produtos).length > 0, n: Object.keys(estado.produtos).length },
      { rot: 'Campanhas', ok: Object.keys(estado.campanhas).length > 0, n: Object.keys(estado.campanhas).length },
      { rot: 'Origem das vendas', ok: !!(D && D.origem) },
      { rot: 'Evolucao diaria', ok: !!(D && D.tendencia) },
      { rot: 'Palavras-chave', ok: !!(D && D.busca && D.busca.keywords && D.busca.keywords.length), n: (D && D.busca && D.busca.keywords) ? D.busca.keywords.length : 0 },
      { rot: 'Serie hora a hora', ok: !!(D && D.horas && Object.keys(D.horas).length), extra: 'so na leitura profunda' },
      { rot: 'Afiliados', ok: !!(D && D.afiliados && D.afiliados.resumo) },
      { rot: 'Saude da conta', ok: !!(D && D.conta && D.conta.saudeConta) }
    ];
    var okN = 0;
    for (var i = 0; i < itens.length; i++) if (itens[i].ok) okN++;

    var h = olho('O QUE FOI LIDO', 'Cada linha e uma fonte de dado da Shopee. Verde significa que chegou; cinza significa que nao veio nesta leitura. Assim, quando uma tela aparece vazia, da para saber se e porque a conta nao tem aquele dado ou porque a rota falhou.');
    h += '<div class="nota">Periodo pedido: <b>' + dd(dc.periodo.ini) + ' a ' + dd(dc.periodo.fim) + '</b>' +
      (dc.periodo.forcado ? ' (escolhido por voce)' : ' (herdado do painel)') + ' &middot; ' + okN + ' de ' + itens.length + ' fontes.</div>';
    h += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">';
    for (i = 0; i < itens.length; i++) {
      var it = itens[i];
      h += '<span style="font-family:Space Mono,monospace;font-size:11px;padding:5px 10px;border-radius:99px;border:1px solid ' +
        (it.ok ? 'var(--vd);color:var(--vd)' : 'var(--li2);color:var(--t3)') + '">' +
        (it.ok ? '\u2713 ' : '\u2013 ') + it.rot + (it.ok && it.n ? ' ' + it.n : '') + '</span>';
    }
    h += '</div>';
    return h;
  }

  function renderPercentis() {
    var D = null;
    try { D = window.SIA_Diamantes ? window.SIA_Diamantes.estado() : null; } catch (e) { /* noop */ }
    var P = D && D.algoritmo && D.algoritmo.percentis;
    if (!P || P.exato == null) return '';

    var margem = margemMediaCofre();
    var piso = margem ? 100 / margem : null;

    var h = olho('O QUE A META SUGERIDA REALMENTE SIGNIFICA', 'A Shopee entrega tres numeros de meta com os percentis de cada um. <b>Exato e o percentil 50: a mediana do que os outros vendedores da sua categoria praticam.</b> Nao e calculo do seu custo, da sua margem ou do seu ticket — ela olha onde os outros estao e sugere o meio.');

    h += '<div class="leitura"><div class="fr">A meta que a Shopee sugere e <span class="w">a mediana da sua categoria</span>, nao um calculo do seu produto.</div>' +
      '<div class="ex">Ela recomenda ' + fmt(P.exato, 1) + 'x porque metade dos vendedores da categoria opera acima disso e metade abaixo. Essa categoria inclui quem vende sem margem e quem esta queimando estoque \u2014 seguir a mediana e aceitar a media do mercado como objetivo.</div></div>';

    h += '<div class="tres">' +
      '<div><div class="v" style="color:var(--vd)">' + fmt(P.tetoCategoria, 1) + 'x</div><div class="l">SO ' + fmt(P.pctTeto, 0) + '% PEDEM MAIS</div><div class="s">os mais exigentes</div></div>' +
      '<div><div class="v" style="color:var(--am)">' + fmt(P.exato, 1) + 'x</div><div class="l">A MEDIANA</div><div class="s">o que ela sugere</div></div>' +
      '<div><div class="v" style="color:var(--t2)">' + fmt(P.pisoCategoria, 1) + 'x</div><div class="l">' + fmt(P.pctPiso, 0) + '% PEDEM MAIS</div><div class="s">os menos exigentes</div></div></div>';

    if (piso) {
      var abaixo = P.exato < piso;
      h += '<div style="background:color-mix(in srgb,' + (abaixo ? 'var(--rd)' : 'var(--vd)') + ' var(--tin,9%),var(--b2));border-left:3px solid ' + (abaixo ? 'var(--rd)' : 'var(--vd)') + ';border-radius:0 16px 16px 0;padding:14px 15px;margin-top:12px;font-size:14px;color:var(--t1);line-height:1.55">' +
        '<b style="color:var(--t0)">Seu ponto de equilibrio e ' + fmt(piso, 1) + 'x</b>, pela margem cadastrada no Cofre. ' +
        (abaixo
          ? 'A mediana da categoria (' + fmt(P.exato, 1) + 'x) esta <b style="color:var(--rd)">abaixo do seu equilibrio</b>. Seguir a sugestao da Shopee faria cada venda sair no prejuizo — e explica por que a recomendacao dela nunca deve ser aceita sem confronto.'
          : 'A mediana da categoria (' + fmt(P.exato, 1) + 'x) esta acima do seu equilibrio, entao ha espaco para trabalhar entre os dois.') +
        '</div>';
    } else {
      h += '<div class="nota" style="color:var(--am)">Cadastre o custo no Cofre para saber se essa mediana cabe na sua margem. Sem isso, nao da para dizer se seguir a sugestao da Shopee da lucro ou prejuizo.</div>';
    }
    return h;
  }

  function renderHoras() {
    var D = null;
    try { D = window.SIA_Diamantes ? window.SIA_Diamantes.estado() : null; } catch (e) { /* noop */ }
    var H = D && D.horas;
    if (!H || !Object.keys(H).length) {
      return olho('O DIA HORA A HORA') +
        '<div class="nota" style="color:var(--am)">Esta leitura precisa da <b>leitura profunda</b>, que busca a serie hora a hora das campanhas. Rode na Conta 360.</div>';
    }

    var FAIXAS = [
      { id: 'madrugada', rot: 'Madrugada', de: 0, ate: 5 },
      { id: 'manha', rot: 'Manha', de: 6, ate: 11 },
      { id: 'tarde', rot: 'Tarde', de: 12, ate: 17 },
      { id: 'noite', rot: 'Noite', de: 18, ate: 23 }
    ];
    var res = [], totG = 0, totP = 0;
    for (var f = 0; f < FAIXAS.length; f++) {
      var F = FAIXAS[f], g = 0, im = 0, cl = 0, pd = 0, gm = 0;
      for (var hh = F.de; hh <= F.ate; hh++) {
        var a = H[hh]; if (!a) continue;
        g += a.gasto; im += a.impressoes; cl += a.cliques; pd += a.pedidos; gm += a.gmv;
      }
      if (!im) continue;
      totG += g; totP += pd;
      res.push({
        rot: F.rot, gasto: g, impressoes: im, cliques: cl, pedidos: pd, gmv: gm,
        cpm: im ? g / im * 1000 : null,
        ctr: im ? cl / im * 100 : null,
        custoPedido: pd ? g / pd : null,
        roas: g ? gm / g : null
      });
    }
    if (!res.length) return '';

    // a pior faixa: a que mais consome por pedido
    var pior = null, melhor = null;
    for (var i = 0; i < res.length; i++) {
      if (res[i].custoPedido == null) continue;
      if (!pior || res[i].custoPedido > pior.custoPedido) pior = res[i];
      if (!melhor || res[i].custoPedido < melhor.custoPedido) melhor = res[i];
    }

    var h = olho('O DIA HORA A HORA', '<b>Nenhum numero consolidado mostra isto.</b> O total do dia mistura as faixas e some com o padrao. Aqui cada faixa aparece com o que gastou, o que entregou e quanto custou cada pedido nela. <b>CPM mais barato nao significa faixa melhor</b>: o que importa e quanto custa o pedido, nao a impressao.');

    if (pior && melhor && pior !== melhor && pior.custoPedido > melhor.custoPedido * 2) {
      var partG = totG ? pior.gasto / totG * 100 : 0;
      var partP = totP ? pior.pedidos / totP * 100 : 0;
      h += '<div class="leitura"><div class="fr">A <span class="d">' + pior.rot.toLowerCase() + ' consome ' + fmt(partG, 0) + '% do dinheiro e entrega ' + fmt(partP, 0) + '% dos pedidos</span>.</div>' +
        '<div class="ex">Cada pedido ali custa ' + reais(pior.custoPedido) + ', contra ' + reais(melhor.custoPedido) + ' na ' + melhor.rot.toLowerCase() + '. ' +
        (pior.cpm != null && melhor.cpm != null && pior.cpm <= melhor.cpm
          ? 'E repare: o CPM da ' + pior.rot.toLowerCase() + ' nao e o mais caro. Voce nao paga mais por impressao — paga por impressao que nao converte.'
          : '') + '</div></div>';
    }

    h += '<table><tr><th>FAIXA</th><th class="num">GASTO</th><th class="num">CPM</th><th class="num">CTR</th><th class="num">PEDIDOS</th><th class="num">CUSTO/PEDIDO</th></tr>';
    for (i = 0; i < res.length; i++) {
      var r = res[i];
      var cor = (pior && r === pior) ? 'var(--rd)' : ((melhor && r === melhor) ? 'var(--vd)' : 'var(--t1)');
      h += '<tr><td style="color:' + cor + '">' + r.rot + '</td>' +
        '<td class="num">' + reais(r.gasto) + '</td>' +
        '<td class="num">' + (r.cpm != null ? 'R$' + fmt(r.cpm, 2) : '\u2014') + '</td>' +
        '<td class="num">' + (r.ctr != null ? fmt(r.ctr, 2) + '%' : '\u2014') + '</td>' +
        '<td class="num">' + fmt(r.pedidos, 0) + '</td>' +
        '<td class="num" style="color:' + cor + '">' + (r.custoPedido != null ? reais(r.custoPedido) : '\u2014') + '</td></tr>';
    }
    h += '</table>';

    // orcamento que acaba antes do pico
    var horasComGasto = [];
    for (var hz = 0; hz < 24; hz++) if (H[hz] && H[hz].gasto > 0) horasComGasto.push(hz);
    var ultima = horasComGasto.length ? horasComGasto[horasComGasto.length - 1] : null;
    if (ultima != null && ultima < 20) {
      h += '<div style="background:color-mix(in srgb,var(--am) var(--tin,9%),var(--b2));border-left:3px solid var(--am);border-radius:0 16px 16px 0;padding:13px 15px;margin-top:12px;font-size:13.5px;color:var(--t1);line-height:1.55">' +
        '<b style="color:var(--t0)">O gasto para as ' + ultima + 'h.</b> Depois disso a conta nao aparece mais na vitrine paga. ' +
        'Se a noite converte melhor que o resto do dia, o orcamento esta acabando justamente antes do melhor horario.</div>';
    }
    return h;
  }

  function renderConta360() {
    var D = null;
    try { if (window.SIA_Diamantes) D = window.SIA_Diamantes.resumo(); } catch (e) { }
    if (!D) return '<div class="nota" style="padding:20px">Cofre carregando…</div>';

    // Sem isto a tela mostrava metade das metricas e a pessoa nao tinha como
    // saber se a conta e assim ou se a leitura falhou.
    var avisoFalta = '';
    if (estado.faltando && estado.faltando.length) {
      avisoFalta = '<div style="background:color-mix(in srgb,var(--am) var(--tin,9%),var(--b2));border-left:3px solid var(--am);border-radius:0 16px 16px 0;padding:12px 14px;margin-bottom:14px;font-size:13.5px;color:var(--t1);line-height:1.55">' +
        '<b style="color:var(--t0)">Esta leitura veio incompleta.</b> Nao consegui ler: ' + esc(estado.faltando.join(', ')) +
        '. Rode a coleta de novo; se persistir, a Shopee pode ter mudado essas telas.</div>';
    }

    // helpers visuais locais
    function fmtR(v) { return v == null ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function fmtN(v) { return v == null ? '—' : Number(v).toLocaleString('pt-BR'); }
    // seta de variacao: sobe verde, desce vermelho (mas reembolso/cancelamento e o contrario)
    function varia(v, inverso) {
      if (v == null || !isFinite(v)) return '';
      // SEM TETO a variacao explodia: base quase zero no periodo anterior
      // produzia "-1.000.000%" na tela. Acima de 999% a comparacao nao diz
      // mais nada — o certo e dizer que o periodo anterior nao tinha base.
      if (Math.abs(v) > 999) {
        return ' <span style="color:var(--t2);font-size:10px">sem base anterior</span>';
      }
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
    h += '<div id="sia-lote-box" style="background:var(--b0);border:1px solid var(--li);border-radius:10px;padding:12px;margin-bottom:12px">';
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
    // O bloco lia de D.funil.canais, mas quem grava a origem das vendas e o
    // exOrigem, em COFRE.origem — por isso ficava sempre vazio pedindo para
    // abrir uma tela que a coleta ja le sozinha.
    if (!cf && D.origem && D.origem.canais && D.origem.canais.length) {
      for (var oc2 = 0; oc2 < D.origem.canais.length; oc2++) {
        var cn2 = D.origem.canais[oc2];
        if (!cn2.pctVendas || cn2.pctVendas < 0.5) continue;
        cf += '<div class="ld">' + esc(cn2.origem) + ': <b>' + fmt(cn2.pctVendas, 1) + '%</b>' +
          (cn2.vendas != null ? ' <span style="color:var(--t2);font-size:11px">(' + reais(cn2.vendas) + ')</span>' : '') +
          (cn2.variacao != null ? varia(cn2.variacao) : '') + '</div>';
      }
      if (D.origem.adsPago) cf += '<div class="ld">Shopee Ads: <b>' + reais(D.origem.adsPago) + '</b>' + (D.origem.adsVar != null ? varia(D.origem.adsVar) : '') + '</div>';
      if (D.origem.afiliados) cf += '<div class="ld">Afiliados: <b>' + reais(D.origem.afiliados) + '</b> <span style="color:var(--t2);font-size:11px">(' + fmt(D.origem.afiliadosRatio, 1) + '% do total)</span></div>';
    }
    h += bloco('2 · DE ONDE VEM O DINHEIRO', cf, 'a coleta traz isto sozinha — se estiver vazio, rode a leitura de novo');

    // ---- 3) PERFORMANCE DE PRODUTO (top por venda) ----
    var prods = D.produtos ? null : null;
    var E = null; try { E = window.SIA_Diamantes.estado(); } catch (e) { }
    var cp = '';
    if (E && E.porProduto) {
      // ANTES filtrava por perf.ctr != null: produto que vendeu muito mas nao
      // tinha CTR ficava de fora, e a lista nao batia com o painel. Agora o
      // criterio e o mesmo do painel — quem mais faturou — e junta as duas
      // fontes de dado, como ja corrigi no relatorio.
      var fonte = {};
      for (var kf in E.porProduto) fonte[kf] = { nome: E.porProduto[kf].nome, perf: E.porProduto[kf].perf || {} };
      for (kf in estado.produtos) {
        var pe2 = estado.produtos[kf] || {}, me2 = pe2.metricas || {};
        if (!fonte[kf]) fonte[kf] = { nome: pe2.nome, perf: {} };
        if (!fonte[kf].nome && pe2.nome) fonte[kf].nome = pe2.nome;
        var pf2 = fonte[kf].perf;
        if (pf2.vendaPaga == null && me2.vendas_pagas != null) pf2.vendaPaga = me2.vendas_pagas;
        if (pf2.uv == null && me2.visitantes != null) pf2.uv = me2.visitantes;
        if (pf2.ctr == null && me2.ctr_card != null) pf2.ctr = me2.ctr_card;
        if (pf2.convPago == null && me2.conversao_pago != null) pf2.convPago = me2.conversao_pago;
        if (pf2.fatiaVendas == null && me2.fatia_vendas != null) pf2.fatiaVendas = me2.fatia_vendas;
        if (pf2.rejeicao == null && me2.rejeicao != null) pf2.rejeicao = me2.rejeicao;
      }
      E = { porProduto: fonte };
      var comPerf = Object.keys(fonte).filter(function (k) {
        var v = fonte[k].perf.vendaPaga || fonte[k].perf.venda || 0;
        return v > 0 && ehProdutoDeVerdade(fonte[k].nome);
      });
      comPerf.sort(function (a, b) {
        var va = (fonte[a].perf.vendaPaga || fonte[a].perf.venda || 0);
        var vb = (fonte[b].perf.vendaPaga || fonte[b].perf.venda || 0);
        return vb - va;
      });
      comPerf.slice(0, 6).forEach(function (k) {
        var p = E.porProduto[k], P = p.perf;
        var nome = (p.nome || k).slice(0, 26);
        var alerta = '';
        // sinal visual: CTR bom + conversao baixa = pagina nao converte
        if (P.ctr >= 2 && P.convPago != null && P.convPago < 1) alerta = ' <span style="color:var(--am);font-size:10px">pagina segura</span>';
        else if (P.rejeicao != null && P.rejeicao > 45) alerta = ' <span style="color:var(--rd);font-size:10px">rejeicao alta</span>';
        cp += '<div class="ld" style="border-bottom:1px solid var(--li);padding-bottom:5px;margin-bottom:5px">' +
          '<b>' + esc(nome) + '</b>' + alerta + '<br>' +
          '<span style="color:var(--t2);font-size:11px">CTR ' + (P.ctr != null ? P.ctr.toFixed(1) : '—') + '% · conv ' + (P.convPago != null ? P.convPago.toFixed(1) : '—') + '% · rejeicao ' + (P.rejeicao != null ? P.rejeicao.toFixed(0) : '—') + '% · ' + fmtR(P.vendaPaga || P.venda) + (P.fatiaVendas != null ? ' · ' + P.fatiaVendas.toFixed(0) + '% da loja' : '') + '</span></div>';
      });
    }
    h += bloco('3 · OS QUE MAIS FATURARAM', cp, 'abra Produtos na Central de Dados');

    // ---- RESUMO DE ADS, no mesmo formato dos outros blocos do 360 ----
    var cads = '';
    var gA = 0, impA = 0, cliA = 0, pedA = 0, gmvA = 0, ativasA = 0;
    for (var ka in estado.campanhas) {
      var ma = estado.campanhas[ka].metricas || {};
      var ea = String(estado.campanhas[ka].estado || estado.campanhas[ka].state || '').toLowerCase();
      if (ea !== 'paused' && ea !== 'ended' && ea !== 'closed') ativasA++;
      gA += ma.gasto || 0; impA += ma.impressoes || 0; cliA += ma.cliques || 0; pedA += ma.pedidos || 0;
      if (ma.gasto && ma.roas) gmvA += ma.gasto * ma.roas;
    }
    if (gA) {
      cads += '<div class="ld">Investimento: <b>' + reais(gA) + '</b> em ' + ativasA + ' campanhas ativas</div>';
      cads += '<div class="ld">Retorno (venda ampla da Shopee): <b>' + reais(gmvA) + '</b> = ' + fmt(gmvA / gA, 1) + 'x</div>';
      if (impA) cads += '<div class="ld">Impressoes: <b>' + fmt(impA, 0) + '</b> &middot; cliques: <b>' + fmt(cliA, 0) + '</b> &middot; CTR ' + fmt((cliA / impA) * 100, 2) + '%</div>';
      if (impA) cads += '<div class="ld">CPM: <b>R$ ' + fmt((gA / impA) * 1000, 2) + '</b>' + (cliA ? ' &middot; CPC: <b>R$ ' + fmt(gA / cliA, 2) + '</b>' : '') + '</div>';
      if (pedA) cads += '<div class="ld">Pedidos por anuncio: <b>' + fmt(pedA, 0) + '</b> &middot; custo por pedido: <b>' + reais(gA / pedA) + '</b></div>';
      h += bloco('4 &middot; SHOPEE ADS NO PERIODO', cads, '');
    }

    // ---- 4) SAUDE / AVALIACOES ----
    var ca4 = '';
    // saude da conta (rating de performance + penalidade) — vem do accounthealth
    if (D.conta && D.conta.saudeConta) {
      var sc = D.conta.saudeConta;
      var corRating = sc.ratingPerformance === 'excellent' ? 'var(--vd)' : (sc.ratingPerformance === 'good' ? 'var(--am)' : 'var(--rd)');
      var traduz = { excellent: 'Excelente', good: 'Boa', improvement_needed: 'Precisa melhorar', poor: 'Ruim' };
      ca4 += '<div class="ld">Saude da conta: <b style="color:' + corRating + '">' + (traduz[sc.ratingPerformance] || sc.ratingPerformance) + '</b>' +
        dica('<b>Por que a saude da conta importa para o anuncio.</b> A Shopee pontua infracoes como atraso de envio, cancelamento por culpa do vendedor e produto irregular. Conta com pontos tem alcance reduzido na vitrine \u2014 entao otimizar campanha numa conta penalizada e investir num teto rebaixado. Resolver a penalidade vem antes de escalar orcamento.');
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
      if (listaT.length) {
        var NOMES_TRAVA = {
          min_purchase_limit: 'quantidade minima por pedido',
          tier_variation_add: 'adicionar variacao',
          tier_variation_delete: 'remover variacao',
          tier_variation_name: 'nome da variacao',
          tier_option_add: 'adicionar opcao de variacao',
          model_level_dts_toggle: 'prazo de envio por variacao',
          price: 'preco', stock: 'estoque', name: 'titulo',
          image: 'fotos', category: 'categoria', description: 'descricao'
        };
        // AGORA POR PRODUTO: antes era uma lista solta sem dizer onde.
        var travasPorProd = (D.gerenciais && D.gerenciais.travasDetectadas) || {};
        var linhasT = [];
        for (var idT in travasPorProd) {
          if (!/^\d+$/.test(idT)) continue;
          var nomeT = (D.porProduto && D.porProduto[idT] && D.porProduto[idT].nome) || ('Produto ' + idT);
          var legiveisT = travasPorProd[idT].map(function (x) { return NOMES_TRAVA[x] || x; });
          linhasT.push({ nome: nomeT, itens: legiveisT, temVar: travasPorProd[idT].some(function (x) { return x.indexOf('tier_') >= 0; }) });
        }
        if (linhasT.length) {
          ca4 += '<div style="margin-top:9px;font-size:12.5px;color:var(--t1);line-height:1.55">' +
            '<b style="color:var(--am)">A Shopee bloqueou edicoes em ' + linhasT.length + ' produto' + (linhasT.length > 1 ? 's' : '') + ':</b>';
          for (var lt = 0; lt < Math.min(linhasT.length, 6); lt++) {
            ca4 += '<div style="margin-top:5px"><b style="color:var(--t0)">' + sig(String(linhasT[lt].nome).slice(0, 44)) + '</b>: nao da para mudar ' + esc(linhasT[lt].itens.join(', ')) + '.</div>';
          }
          var algumVar = linhasT.some(function (x) { return x.temVar; });
          ca4 += '<div style="margin-top:7px;color:var(--t2)">Costuma ser campanha ativa, pedido em aberto ou produto em analise.' +
            (algumVar ? ' <b style="color:var(--t1)">Como ha travas de variacao, nao da para tirar do ar uma grade problematica sem pausar a campanha do produto antes.</b>' : '') + '</div></div>';
        }
      }    }
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
      // monthly_sold_count e o numero EXATO dos ultimos 30 dias, dito pela
      // API. Nao usar o texto do card: ele mistura periodos — produto de
      // inverno que vendeu 10 mil ha 60 dias mostraria isso como se fosse
      // agora. Se o campo nao vier, e melhor nao ter numero do que ter um
      // numero errado.
      var mes = (sc.monthly_sold_count != null && Number(sc.monthly_sold_count) >= 0)
        ? Number(sc.monthly_sold_count) : null;

      // Quando o campo nao vier, registra no console TODAS as chaves que
      // existem no item, para eu descobrir onde a Shopee pos o numero em vez
      // de adivinhar. So no primeiro item, para nao poluir.
      if (mes == null && i === 0) {
        try {
          console.debug('[Seller.IA] campo de vendas ausente. Chaves de item_data:', Object.keys(d).join(', '));
          console.debug('[Seller.IA] chaves de sold_count:', Object.keys(sc).join(', '));
          console.debug('[Seller.IA] item completo:', JSON.stringify(it).slice(0, 1200));
        } catch (e) { /* noop */ }
      }

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
        eu: meu && String(d.shopid) === meu,

        // ---- O QUE A API ENTREGA E ESTAVA SENDO JOGADO FORA ----
        // Os numeros abaixo sao EXATOS: vem da API, nao do texto arredondado
        // que aparece no card da vitrine ("1,2mil" na tela = 1237 aqui).
        precoAntes: dp.price_before_discount != null ? Number(dp.price_before_discount) / 100000 : null,
        precoMin: dp.price_min != null ? Number(dp.price_min) / 100000 : null,
        precoMax: dp.price_max != null ? Number(dp.price_max) / 100000 : null,
        estoque: d.stock != null ? Number(d.stock) : null,
        vendidoTexto: sc.sold_count_text || null,          // como a Shopee escreve na tela
        curtidas: d.liked_count != null ? Number(d.liked_count) : null,
        notaDetalhe: rt.rating_count || null,              // [total,1,2,3,4,5 estrelas]
        cidade: d.shop_location || d.item_location || null,
        freteGratis: !!(d.show_free_shipping || (d.badge_icon_type === 1)),
        preferido: !!(d.shopee_verified || d.is_preferred_plus_seller),
        oficial: !!d.is_official_shop,
        adsid: it.adsid || null,
        campanhaAds: it.campaignid || null,
        vendedorId: d.shopid != null ? String(d.shopid) : null,
        nomeLoja: d.shop_name || null,
        criadoEm: d.ctime != null ? Number(d.ctime) : null,
        variacoes: d.tier_variations ? d.tier_variations.length : null,
        // guarda o item cru para nao perder nada que a Shopee adicionar depois
        cru: it
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
  // Foi apagada junto com o Radar em lote e continuou sendo chamada em tres
  // pontos: mais uma referencia orfa que so quebrava em execucao.
  function espDinheiro(v) {
    if (v == null || !isFinite(v)) return '\u2014';
    if (v >= 1000000) return 'R$ ' + (v / 1000000).toFixed(1).replace('.', ',') + ' mi';
    if (v >= 1000) return 'R$ ' + (v / 1000).toFixed(1).replace('.', ',') + ' mil';
    return 'R$ ' + v.toFixed(0);
  }
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
    var comCupom2 = 0, comFrete = 0, comAds = 0;
    for (i = 0; i < top.length; i++) {
      if (top[i].cupom) comCupom2++;
      if (top[i].freteGratis) comFrete++;
      if (top[i].ads) comAds++;
    }
    comCupom = comCupom2;
    return {
      n: top.length, lider: top[0], top: top,
      preco: media('preco'), vendasMes: media('vendasMes'),
      faturamentoMes: media('faturamentoMes'), nota: media('nota'),
      avaliacoes: media('avaliacoes'), comCupom: comCupom,
      comFrete: comFrete, comAds: comAds
    };
  }

  function espBuscar(termo, aoTerminar) {
    try {
      chrome.runtime.sendMessage({ tipo: 'sia:busca-publica', termo: termo }, function (resp) {
        void chrome.runtime.lastError;
        aoTerminar(resp || { ok: false, erro: 'Sem resposta do Seller.IA.' });
      });
    } catch (e) {
      // a mensagem antiga culpava permissao, que quase nunca e a causa real:
      // o mais comum e o service worker ter hibernado e a extensao precisar
      // ser recarregada, ou a aba ter sido descarregada pelo Chrome
      aoTerminar({ ok: false, erro: 'Perdi a conexao com o Seller.IA. Recarregue a pagina (F5) e tente de novo. Detalhe: ' + String(e && e.message || e) });
    }
  }

  function espMeusProdutos(limite) {
    var arr = [], id;
    for (id in estado.produtos) {
      var p = estado.produtos[id];
      if (!ehProdutoDeVerdade(p && p.nome)) continue;
      if (estado.cofre.ocultos && estado.cofre.ocultos[id]) continue;
      if (!p || !p.nome) continue;
      // linhas que nao sao produto entram na lista de "produtos" da coleta
      // (credito de Ads, saldo, ajuste). Buscar isso na vitrine e ruido.
      if (/cr[eé]dito|saldo|recarga|ajuste|reembolso|taxa|cupom da loja/i.test(p.nome)) continue;
      if (!/[a-zA-Zà-ú]{4}/.test(p.nome)) continue;
      // O filtro de metrica cortava todo produto sem trafego no periodo, e o
      // seletor trazia so um punhado. Mas quem escolhe o que analisar e a
      // pessoa: produto parado e justamente o que ela quer investigar no
      // Espiao. O isolamento entre contas ja e garantido pelo carimbo de
      // loja, entao esse filtro nao e mais necessario aqui.
      if (p.loja && estado.loja && estado.loja.shop_id && String(p.loja) !== String(estado.loja.shop_id)) continue;
      var m = p.metricas || {};
      arr.push({ id: id, nome: p.nome, gmv: m.gmv || 0 });
    }
    arr.sort(function (a, b) { return b.gmv - a.gmv; });
    return arr.slice(0, limite || 6);
  }

  /* ---- RADAR: UM produto por vez, escolhido por voce ----
     O lote de 6 buscas em sequencia era o bug: cada uma sobrescrevia
     estado.espiao.res, entao clicar numa linha enquanto o radar rodava
     fazia a busca da linha ser atropelada pela proxima do lote — e a aba
     em segundo plano acabava pesquisando outra coisa. Agora e uma busca
     por vez, disparada por voce, e o comparativo aparece na mesma tela. */
  function espAnalisarProduto(idOuNome) {
    var alvos = espMeusProdutos(60);
    var alvo = null;
    for (var i = 0; i < alvos.length; i++) {
      if (String(alvos[i].id) === String(idOuNome) || alvos[i].nome === idOuNome) { alvo = alvos[i]; break; }
    }
    if (!alvo) { estado.espiao.erro = 'Nao encontrei esse produto na coleta.'; render(); return; }

    var termo = estado.espiao.termoManual || espTermo(alvo.nome);
    estado.espiao.meuProduto = { id: alvo.id, nome: alvo.nome };
    estado.espiao.termo = termo;
    estado.espiao.buscando = true;
    estado.espiao.erro = null;
    estado.espiao.res = null;
    estado.espiao.volumes = null;
    render();

    espBuscar(termo, function (resp) {
      estado.espiao.buscando = false;
      if (!resp || !resp.ok) {
        estado.espiao.erro = (resp && resp.erro) || 'A busca nao voltou.';
      } else {
        var lista = espMapear(resp.itens);
        // ORDENA POR FATURAMENTO, nao por posicao na pagina: o que interessa
        // e quem VENDE mais, nao quem aparece primeiro. Era isso que a Karina
        // vinha pedindo e o Radar nunca fez.
        var cd2 = lista.filter(function (x) { return x.faturamentoMes != null && x.faturamentoMes > 0; });
        var sd2 = lista.filter(function (x) { return !(x.faturamentoMes != null && x.faturamentoMes > 0); });
        cd2.sort(function (a, b) { return b.faturamentoMes - a.faturamentoMes; });
        sd2.sort(function (a, b) { return (a.pos || 99) - (b.pos || 99); });
        var ordenada = cd2.concat(sd2);
        for (var q = 0; q < ordenada.length; q++) ordenada[q].posVenda = q + 1;
        estado.espiao.res = {
          termo: resp.termo, lista: lista, ordenada: ordenada,
          barreira: espBarreira(lista)
        };
      }
      render();
    });
  }

  function telaDeErro(tela, err) {
    var msg = String((err && err.message) || err);
    var onde = '';
    try {
      var pilha = String(err && err.stack || '').split('\n')[1] || '';
      var m = pilha.match(/coletor\.js:(\d+)/);
      if (m) onde = ' (coletor.js linha ' + m[1] + ')';
    } catch (e) { /* noop */ }
    try { console.error('[Seller.IA] ' + tela + ':', err); } catch (e) { /* noop */ }
    return '<div style="background:color-mix(in srgb,var(--rd) var(--tin,9%),var(--b2));border:1px solid var(--rd);border-left:3px solid var(--rd);border-radius:18px;padding:18px;margin-top:12px">' +
      '<div style="font-size:16px;font-weight:600;color:var(--t0);margin-bottom:6px">A aba ' + esc(tela) + ' nao conseguiu abrir</div>' +
      '<div style="font-size:14px;color:var(--t1);line-height:1.55">' + esc(msg) + esc(onde) + '</div>' +
      '<div style="font-size:13px;color:var(--t2);margin-top:9px;line-height:1.5">Manda esta mensagem que eu corrijo. As outras abas continuam funcionando.</div></div>';
  }
  /* ============ O ESPECIALISTA ============
     Le todos os vereditos e escreve a leitura da conta em ordem de decisao:
     o que esta sangrando, o que esta travado, o que da para escalar. Nao e
     lista de alertas — e o que um analista falaria abrindo a conta. */
  function renderEspecialista() {
    var V = estado.vereditos || [];
    var nC = Object.keys(estado.campanhas).length, nP = Object.keys(estado.produtos).length;

    var h = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap">' + seloFonte() +
      '<button id="sia-coletar-tudo" style="background:var(--mk);border:none;color:#fff;font-weight:600;font-size:13px;padding:9px 16px;border-radius:var(--r-btn,14px);cursor:pointer">' +
      (estado.coletaProgresso !== null ? esc(String(estado.coletaProgresso)) : 'Ler a conta de novo') + '</button></div>';

    if (!nC && !nP) {
      return h + '<div class="nota" style="color:var(--am)">Ainda nao li esta conta. Clique em <b>Ler a conta de novo</b> — leva cerca de um minuto.</div>';
    }
    if (!V.length) {
      return h + renderChamadaCerebro() +
        '<div class="nota">Li ' + nP + ' produtos e ' + nC + ' campanhas, mas a analise completa ainda nao rodou. E ela que traz o diagnostico da Shopee, o piso de ROAS pela sua margem e a leitura por formato de anuncio.</div>';
    }

    var verm = V.filter(function (x) { return x.nivel === 'vermelho'; });
    var amar = V.filter(function (x) { return x.nivel === 'amarelo'; });
    var verd = V.filter(function (x) { return x.nivel === 'verde'; });
    var dinVerm = 0, i;
    for (i = 0; i < verm.length; i++) dinVerm += (verm[i].dinheiro || 0);

    // ---- A LEITURA ----
    var fr, ex;
    if (verm.length) {
      fr = '<span class="d">' + verm.length + ' ' + (verm.length > 1 ? 'coisas estao' : 'coisa esta') + ' custando dinheiro agora</span>.';
      ex = 'Somadas, envolvem ' + reais(dinVerm) + '. A ordem abaixo e por dinheiro em jogo, nao por gravidade: resolver o primeiro item vale mais que resolver os tres ultimos juntos.';
    } else if (amar.length) {
      fr = 'Nada sangrando, mas <span class="w">' + amar.length + ' ' + (amar.length > 1 ? 'pontos pedem' : 'ponto pede') + ' atencao</span>.';
      ex = 'Sao os ganhos mais baratos da conta: coisas que ja funcionam e estao sendo limitadas por algum detalhe.';
    } else if (verd.length) {
      fr = '<span class="u">A conta esta saudavel</span>.';
      ex = 'Nada abaixo do seu piso. O trabalho aqui e escalar o que ja funciona, sem mexer no que nao pede para ser mexido.';
    } else {
      fr = 'Ainda nao ha o que julgar.';
      ex = 'A conta foi lida, mas nao ha volume suficiente para conclusao. Traga visita antes de tirar conclusao.';
    }
    h += '<div class="leitura"><div class="fr">' + fr + '</div><div class="ex">' + ex + '</div></div>';

    h += '<div class="tres">' +
      '<div><div class="v" style="color:var(--rd)">' + verm.length + '</div><div class="l">CUSTANDO</div><div class="s">' + reais(dinVerm) + '</div></div>' +
      '<div><div class="v" style="color:var(--am)">' + amar.length + '</div><div class="l">PEDEM ATENCAO</div></div>' +
      '<div><div class="v" style="color:var(--vd)">' + verd.length + '</div><div class="l">PARA ESCALAR</div></div></div>';

    function secao(rot, lista, dicaTxt) {
      if (!lista.length) return '';
      var s = olho(rot, dicaTxt);
      for (var j = 0; j < Math.min(lista.length, 8); j++) {
        var v = lista[j];
        var co = CORES_SEM[v.nivel] || CORES_SEM.cinza;
        var alvo = v.escopo === 'produto' ? (estado.produtos[v.id] && estado.produtos[v.id].nome)
          : (estado.campanhas[v.id] && (estado.campanhas[v.id].nome || estado.campanhas[v.id].titulo));
        s += '<div data-card="' + esc(v.escopo) + ':' + esc(v.id || '') + '" style="cursor:pointer;background:' + co.bg + ';border:1px solid ' + co.bd + ';border-left:3px solid ' + co.dot + ';border-radius:var(--r-card,22px);padding:15px 16px;margin-bottom:9px">' +
          '<div style="display:flex;align-items:baseline;gap:9px;margin-bottom:5px">' +
          '<span style="flex:1;font-size:17px;font-weight:600;color:var(--t0);line-height:1.25">' + esc(v.titulo) + '</span>' +
          (v.dinheiro ? '<span style="font-family:Space Mono,monospace;font-size:12px;color:var(--t2);flex:none">' + reais(v.dinheiro) + '</span>' : '') + '</div>' +
          (alvo ? '<div style="font-size:12.5px;color:var(--t2);margin-bottom:6px">' + sig(String(alvo).slice(0, 66)) + '</div>' : '') +
          '<div style="font-size:14.5px;color:var(--t1);line-height:1.6">' + esc(v.texto) + '</div>';
        if (v.passos && v.passos.length) {
          s += '<div style="font-size:14px;color:' + co.dot + ';margin-top:8px;line-height:1.45">';
          for (var k2 = 0; k2 < v.passos.length; k2++) s += '\u2192 ' + esc(v.passos[k2]) + '<br>';
          s += '</div>';
        }
        s += '</div>';
      }
      if (lista.length > 8) s += '<div class="nota">e mais ' + (lista.length - 8) + ' nesta categoria.</div>';
      return s;
    }

    h += secao('RESOLVA PRIMEIRO', verm, 'Ordenado por dinheiro em jogo. Um problema numa campanha que gasta R$ 800 vem antes de um problema em campanha que gasta R$ 8, mesmo que a segunda esteja mais quebrada.');
    h += secao('DEPOIS DISSO', amar, 'Coisas que ja funcionam e estao sendo limitadas. Sao os ganhos mais baratos, porque nao exigem consertar nada — so destravar.');
    h += secao('ONDE COLOCAR MAIS DINHEIRO', verd, 'O que ja entrega acima do seu ponto de equilibrio. Subir orcamento aqui e o crescimento mais barato que a conta tem.');

    h += '<div class="nota" style="margin-top:16px">Leitura de ' + nP + ' produtos e ' + nC + ' campanhas' +
      (estado.versaoRegras ? ' \u00b7 regras ' + esc(estado.versaoRegras) : '') + '. Clique em qualquer item para abrir o card completo.</div>';
    return h;
  }

  function renderEspiao() {
    if (!estado.espiao) estado.espiao = { termo: '', res: null, radar: null };
    var e = estado.espiao;
    var h = capa('COMO ESTOU CONTRA OS OUTROS', 'O', 'ESPIAO', '04');

    var modo = estado.espiaoModo || 'radar';
    h += renderModoEspiao(modo);

    if (modo === 'radar') {
      // UM produto por vez, escolhido por voce. O lote de 6 buscas atropelava
      // a si mesmo e era a causa da aba abrir pesquisando outra coisa.
      var meus = espMeusProdutos(60);
      if (!meus.length) {
        h += '<div class="nota" style="color:var(--am);margin-top:12px">Colete a conta primeiro — o Radar usa os seus produtos.</div>';
        return h;
      }
      h += '<div style="margin-top:12px">' +
        '<select id="sia-esp-prod" style="width:100%;background:var(--b0);border:1px solid var(--li);border-radius:9px;padding:12px;color:var(--t0);font-family:inherit;font-size:14px;margin-bottom:9px">' +
        '<option value="">Escolha o produto que quer comparar...</option>';
      for (var mp = 0; mp < meus.length; mp++) {
        var selMp = estado.espiao.meuProduto && String(estado.espiao.meuProduto.id) === String(meus[mp].id);
        h += '<option value="' + esc(meus[mp].id) + '"' + (selMp ? ' selected' : '') + '>' + esc(String(meus[mp].nome).slice(0, 58)) + '</option>';
      }
      h += '</select>';
      h += '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<input id="sia-esp-termo" value="' + esc(e.termo || '') + '" placeholder="termo da busca (deixe em branco para usar o titulo)" ' +
        'style="flex:1;min-width:190px;background:var(--b0);border:1px solid var(--li);border-radius:9px;padding:11px 12px;color:var(--t0);font-size:13.5px">' +
        '<button id="sia-esp-analisar" style="background:var(--mk);border:none;color:#fff;font-weight:700;font-size:13.5px;padding:11px 20px;border-radius:var(--r-btn,14px);cursor:pointer">' +
        (e.buscando ? 'Comparando...' : 'Comparar') + '</button></div></div>';
    } else {
      h += '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">' +
        '<input id="sia-esp-termo" value="' + esc(e.termo || '') + '" placeholder="digite o termo que o comprador pesquisa" ' +
        'style="flex:1;min-width:200px;background:var(--b0);border:1px solid var(--li);border-radius:9px;padding:11px 12px;color:var(--t0);font-size:13.5px">' +
        '<button id="sia-esp-ir" style="background:var(--mk);border:none;color:#fff;font-weight:700;font-size:13.5px;padding:11px 20px;border-radius:var(--r-btn,14px);cursor:pointer">' + (e.buscando ? 'Espiando...' : 'Espiar') + '</button></div>';
    }

    h += '<div class="nota" style="margin-top:0">A busca abre a vitrine numa aba em segundo plano e le a resposta que a propria Shopee entrega — nao fabricamos chamada, so escutamos. Cada termo leva alguns segundos. O faturamento e estimado: a propria Shopee mostra quantas unidades cada produto vendeu nos ultimos 30 dias. Multiplicamos pelo preco exibido. E regua de vitrine, nao o extrato do concorrente.</div>';

    // ORDEM CORRETA: buscando e erro vem ANTES do Radar e cortam o render.
    // Estavam num ponto do arquivo que nunca era alcancado, entao clicar numa
    // linha do Radar parecia nao fazer nada: a tela voltava a desenhar o
    // proprio Radar e o resultado nunca aparecia.
    if (e.buscando) {
      return h + '<div style="background:var(--b0);border:1px solid var(--li);border-radius:18px;padding:18px;margin-top:12px">' +
        '<div style="display:flex;align-items:center;gap:9px;margin-bottom:7px">' +
        '<span style="width:9px;height:9px;border-radius:50%;background:var(--mk);display:inline-block"></span>' +
        '<b style="font-size:15px;color:var(--t0)">Espiando "' + esc(e.termo || '') + '"</b></div>' +
        '<div style="font-size:13.5px;color:var(--t2);line-height:1.55">A Seller.IA abre a vitrine da Shopee numa aba invisivel, le os resultados como um comprador veria e volta com o comparativo. Leva ate 40 segundos.</div></div>';
    }
    if (e.erro) {
      return h + '<div style="background:color-mix(in srgb,var(--rd) var(--tin,9%),var(--b2));border:1px solid var(--rd);border-left:3px solid var(--rd);border-radius:18px;padding:16px;margin-top:12px">' +
        '<div style="font-size:16px;font-weight:600;color:var(--t0);margin-bottom:6px">Nao consegui espiar "' + esc(e.termo || '') + '"</div>' +
        '<div style="font-size:14px;color:var(--t1);line-height:1.55">' + esc(e.erro) + '</div>' +
        '<div style="font-size:13px;color:var(--t2);line-height:1.5;margin-top:9px">Confira se voce esta logada em <b>shopee.com.br</b>, nao so no Seller Centre, e recarregue esta pagina.</div>' +
        '<button data-voltar-radar="1" style="margin-top:12px;background:var(--b0);border:1px solid var(--li2);color:var(--t0);font-family:inherit;font-size:13px;padding:9px 15px;border-radius:var(--r-btn,14px);cursor:pointer">Voltar ao Radar</button></div>';
    }

    /* ---- RADAR EM LISTA (desativado: virou seletor) ---- */
    if (false && e.radar && e.radar.length) {
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
        h += '<button data-espiar="' + esc(L.termo) + '" data-prod="' + esc(L.produto) + '" style="display:block;width:100%;text-align:left;cursor:pointer;font-family:inherit;background:var(--b0);border:1px solid var(--li);border-left:3px solid ' + cor + ';border-radius:18px;padding:14px 15px;margin-bottom:9px">' +
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

      // OS MAIS VENDIDOS, nao os primeiros da pagina. Quem aparece primeiro
      // pode estar pagando por isso; quem vende mais e a referencia real.
      var porVenda = (e.res.ordenada || lista.slice().sort(function (x, y) {
        return (y.faturamentoMes || 0) - (x.faturamentoMes || 0);
      })).filter(function (x) { return (x.faturamentoMes || 0) > 0; });
      if (porVenda.length) {
        h += olho('OS QUE MAIS VENDEM \u00b7 ULTIMOS 30 DIAS', '<b>Ordenado por faturamento, nao pela posicao na pagina.</b> Quem aparece primeiro pode estar pagando por isso; quem vende mais e a referencia que importa.<br><br><b>De onde vem o numero:</b> a API da Shopee devolve <b>monthly_sold_count</b>, que e a quantidade EXATA vendida nos ultimos 30 dias — nao o texto arredondado do card (onde 1237 aparece como \'1,2mil\'). Multiplicamos pelo preco atual. A unica imprecisao possivel e se o concorrente mudou de preco durante o mes.');
        for (var pv = 0; pv < Math.min(porVenda.length, 8); pv++) {
          var it = porVenda[pv];
          h += '<div style="display:flex;align-items:center;gap:10px;padding:11px 8px;border-bottom:1px solid var(--li);font-size:13.5px' +
            (it.eu ? ';background:color-mix(in srgb,var(--vd) var(--tin,9%),transparent);border-radius:8px' : '') + '">' +
            '<span style="font-family:Bebas Neue,sans-serif;font-size:19px;width:26px;color:' + (it.eu ? 'var(--vd)' : 'var(--t2)') + '">' + (pv + 1) + '</span>' +
            '<span style="flex:1;min-width:0;line-height:1.35;color:' + (it.eu ? 'var(--vd)' : 'var(--t1)') + (it.eu ? ';font-weight:600' : '') + '">' +
            (it.eu ? sig(String(it.nome).slice(0, 46)) + ' (voce)' : esc(String(it.nome).slice(0, 46))) +
            '<span style="display:block;font-family:Space Mono,monospace;font-size:10px;color:var(--t3)">pagina ' + it.pos +
            (it.ads ? ' \u00b7 ADS' : ' \u00b7 organico') + (it.cupom ? ' \u00b7 cupom' : '') +
            (it.freteGratis ? ' \u00b7 frete gratis' : '') +
            (it.estoque != null ? ' \u00b7 estoque ' + fmt(it.estoque, 0) : '') +
            (it.avaliacoes != null ? ' \u00b7 ' + fmt(it.avaliacoes, 0) + ' avaliacoes (total)' : '') +
            (it.nota != null ? ' \u00b7 nota ' + fmt(it.nota, 1) : '') +
            (it.cidade ? ' \u00b7 ' + esc(String(it.cidade)) : '') +
            '</span></span>' +
            '<span style="text-align:right;flex:none">' +
            '<span style="font-family:Space Mono,monospace;font-size:13px;display:block;color:var(--t0)">' + espDinheiro(it.faturamentoMes) + '</span>' +
            '<span style="font-family:Space Mono,monospace;font-size:10.5px;color:var(--vd)">' + (it.vendasMes != null ? it.vendasMes + ' vendas' : '—') + ' · R$' + fmt(it.preco, 2) + '</span></span>' +
            (it.link && !it.eu ? '<a data-link-externo="1" href="' + esc(it.link) + '" target="_blank" rel="noopener" style="flex:none;color:var(--mk);text-decoration:none;font-size:18px;padding:0 4px">\u2197</a>' : '') +
            '</div>';
        }
      }

      h += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:16px 0 10px">' +
        '<div style="background:var(--b0);border:1px solid var(--li);border-radius:10px;padding:9px;text-align:center"><div style="font-family:Space Mono,monospace;font-size:10px;color:var(--t2)">ANUNCIOS</div><div style="font-size:20px;color:var(--mk)">' + nAds + '<span style="font-size:12px;color:var(--t2)">/' + lista.length + '</span></div></div>' +
        '<div style="background:var(--b0);border:1px solid var(--li);border-radius:10px;padding:9px;text-align:center"><div style="font-family:Space Mono,monospace;font-size:10px;color:var(--t2)">PRECO TOP 5</div><div style="font-size:20px">' + (b && b.preco != null ? 'R$' + fmt(b.preco, 0) : '—') + '</div></div>' +
        '<div style="background:var(--b0);border:1px solid var(--li);border-radius:10px;padding:9px;text-align:center"><div style="font-family:Space Mono,monospace;font-size:10px;color:var(--t2)">BARREIRA/MES</div><div style="font-size:20px;color:var(--vd)">' + (b ? espDinheiro(b.faturamentoMes) : '—') + '</div></div></div>';

      for (i = 0; i < lista.length; i++) {
        var x = lista[i];
        h += '<div style="display:flex;align-items:center;gap:9px;padding:10px 7px;border-bottom:1px solid var(--li);font-size:13.5px' + (x.eu ? ';background:rgba(46,204,113,.06);border-radius:6px' : '') + '">' +
          '<span style="font-family:monospace;font-size:13px;width:22px;color:' + (x.eu ? 'var(--vd)' : 'var(--t2)') + '">' + x.pos + '</span>' +
          '<span style="flex:1;color:' + (x.eu ? 'var(--vd)' : 'var(--t1)') + (x.eu ? ';font-weight:600' : '') + '">' + (x.eu ? sig(x.nome.slice(0, 44)) + ' (voce)' : esc(x.nome.slice(0, 44))) + '</span>' +
          (x.ads ? '<span style="font-family:monospace;font-size:10px;color:var(--mk);border:1px solid var(--mk);border-radius:99px;padding:1px 6px">ADS</span>' : '') +
          '<span style="text-align:right"><span style="font-family:monospace;font-size:10.5px;display:block">' + (x.preco != null ? 'R$' + fmt(x.preco, 2) : '—') + '</span>' +
          '<span style="font-family:monospace;font-size:12px;font-weight:700;color:var(--vd)">' +
          (x.vendasMes != null ? x.vendasMes + '/mes \u00b7 ' + espDinheiro(x.faturamentoMes)
           : (x.avaliacoes ? fmt(x.avaliacoes, 0) + ' avaliacoes' : 'R$' + fmt(x.preco, 2))) + '</span></span>' +
          // O link para o anuncio do concorrente foi perdido numa edicao
          // anterior: por isso o Espiao nunca levava ate o campeao.
          (x.link && !x.eu ? '<a data-link-externo="1" href="' + esc(x.link) + '" target="_blank" rel="noopener" title="abrir o anuncio dele" style="flex:none;color:var(--mk);text-decoration:none;font-size:18px;padding:0 4px">\u2197</a>' : '') +
          '</div>';
      }

      var meus = lista.filter(function (z) { return z.eu; });
      var meuFora = (!meus.length && b && estado.espiao.meuProduto);
      if (meuFora) {
        var mp = estado.espiao.meuProduto;
        h += '<div style="background:color-mix(in srgb,var(--rd) var(--tin,9%),var(--b2));border:1px solid var(--rd);border-radius:18px;padding:15px 16px;margin:16px 0 4px">' +
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
        // as duas linhas que faltavam para completar as nove prometidas
        h += linha('Anuncio', m.ads ? 'pago' : 'organico', (b.comAds != null ? b.comAds : 0) + ' de ' + b.n + ' pagos', lid.ads ? 'pago' : 'organico');
        h += '</table>';
        if (lid && !lid.ads && m.ads) {
          h += '<div class="nota" style="color:var(--am)">O primeiro colocado esta em <b>organico</b> e voce esta pagando anuncio para ficar atras dele. Isso costuma ser diferenca de titulo, avaliacao ou preco, nao de investimento.</div>';
        }

        var falta = (b.faturamentoMes != null && m.faturamentoMes != null) ? b.faturamentoMes - m.faturamentoMes : null;
        var faltaUn = (b.vendasMes != null && m.vendasMes != null) ? Math.round(b.vendasMes - m.vendasMes) : null;
        h += '<div style="background:var(--b0);border-left:3px solid var(--mk);border-radius:0 9px 9px 0;padding:11px 13px;margin-top:12px;font-size:12px;color:var(--t1);line-height:1.5">';
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
          if (vol == null) {
            // tenta na lista de palavras que a coleta ja trouxe
            try {
              var Dk = window.SIA_Diamantes ? window.SIA_Diamantes.estado() : null;
              var lk = (Dk && Dk.busca && Dk.busca.keywords) || [];
              for (var vk = 0; vk < lk.length; vk++) {
                if (String(lk[vk].termo).toLowerCase().indexOf(dp.faltando[w].p) >= 0) { vol = lk[vk].volume; break; }
              }
            } catch (e) { /* noop */ }
          }
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
    var inp = $('sia-esp-termo'), bt = $('sia-esp-ir');
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
    // espRodarRadar foi removida quando o Radar virou seletor. A referencia
    // ficou aqui e lancava ReferenceError, matando o render inteiro do Espiao
    // — era por isso que a aba nao abria.
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
      if (!ehProdutoDeVerdade(C.porProduto[id] && C.porProduto[id].nome)) continue;
      if (estado.cofre.ocultos && estado.cofre.ocultos[id]) continue;
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
    return '<div style="background:var(--b0);border:1px solid var(--li);border-radius:10px;padding:9px 10px">' +
      '<div style="font-family:Space Mono,monospace;font-size:11.5px;color:var(--t2);letter-spacing:.05em">' + rot + '</div>' +
      '<div style="font-family:Bebas Neue,sans-serif;font-size:26px;line-height:1.1;margin-top:3px;color:' + (cor || 'var(--t0)') + '">' + val + '</div>' +
      '<div style="font-size:12px;color:var(--t2);margin-top:2px">' + sub + '</div></div>';
  }

  function renderCard6() {
    var R = cardResolver();
    var pc = R.pc, pp = R.pp;
    var h = '';

    h += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
      '<button data-voltar="1" style="background:var(--b0);border:1px solid var(--li2);color:var(--t1);border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer">‹ voltar</button>' +
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

    h += '<div style="border:1px solid var(--li);border-radius:18px;padding:12px;margin-bottom:11px">' +
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
        h += '<div style="background:var(--b0);border:1px solid var(--li);border-radius:9px;padding:9px 11px;margin-top:9px">' +
          '<div style="font-family:Space Mono,monospace;font-size:10px;color:var(--t2);margin-bottom:6px">QUAL PRODUTO E ESTA CAMPANHA?</div>' +
          '<div style="display:flex;gap:6px"><select id="sia-vinc" style="flex:1;background:var(--b1);border:1px solid var(--li);border-radius:7px;padding:7px;color:var(--t0);font-size:11.5px"><option value="">escolha o produto...</option>';
        for (var vp = 0; vp < lp.length; vp++) {
          h += '<option value="' + esc(lp[vp].id) + '"' + (String(lp[vp].id) === String(R.idProduto) ? ' selected' : '') + '>' + esc(String(lp[vp].nome).slice(0, 40)) + (custoDe(lp[vp].id) ? ' · custo ok' : ' · sem custo') + '</option>';
        }
        h += '</select><button id="sia-vinc-ok" data-camp="' + esc(R.idCamp || '') + '" style="background:var(--mk);border:none;color:var(--t0);font-size:11.5px;font-weight:600;padding:0 13px;border-radius:7px;cursor:pointer">Vincular</button></div></div>';
      }
    }
    if (custoProd) {
      h += '<div style="background:var(--b0);border-left:3px solid var(--vd);border-radius:0 8px 8px 0;padding:8px 11px;margin-top:9px;font-size:11.5px;color:var(--t1)">' +
        'Margem real de <b style="color:var(--vd)">' + (margemPct != null ? fmt(margemPct, 1) + '%' : '—') + '</b> — custo, embalagem e imposto ja descontados.' + (R.autoNome ? ' <span style="color:var(--am)">Produto identificado pelo nome — confira se e este mesmo.</span>' : '') + '</div></div>';
    } else {
      h += '<div style="background:var(--b0);border-left:3px solid var(--px);border-radius:0 8px 8px 0;padding:8px 11px;margin-top:9px;font-size:11.5px;color:var(--t1)">' +
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
      h += '<div style="background:var(--b0);border-left:3px solid var(--px);border-radius:0 9px 9px 0;padding:10px 12px;margin-bottom:11px;font-size:13px;color:var(--t1);line-height:1.5">' +
        'Este produto nao tem anuncio ativo nesta coleta, entao nao ha ROAS para explicar. O julgamento acima vem do funil organico da pagina.</div>';
    } else {
    h += '<div style="border:1px solid var(--li);border-radius:18px;padding:12px;margin-bottom:11px">' +
      '<div style="font-family:Space Mono,monospace;font-size:12px;color:var(--px);letter-spacing:.06em;margin-bottom:9px">POR QUE ESTE ROAS</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:7px;text-align:center">' +
      '<div><div style="font-size:18px;color:var(--am)">' + (meta.atual != null ? fmt(meta.atual, 1) + 'x' : '—') + '</div><div style="font-family:Space Mono,monospace;font-size:10px;color:var(--t2)">VOCE PEDE</div></div>' +
      '<div><div style="font-size:18px;color:var(--vd)">' + (meta.sugerida != null ? fmt(meta.sugerida, 1) + 'x' : '—') + '</div><div style="font-family:Space Mono,monospace;font-size:10px;color:var(--t2)">SHOPEE SUGERE</div></div>' +
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
    h += '<div style="background:var(--b0);border:1px solid var(--li);border-radius:18px;padding:13px;margin-bottom:11px">' +
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
    // A competitividade vem da rota todo/list_task e e gravada em
    // COFRE.porProduto pelo item_id. Se o card foi aberto por CAMPANHA, o pp
    // pode nao ter sido resolvido — entao busca tambem pelo produto vinculado.
    var comp = pp && pp.competitividade != null ? pp.competitividade : null;
    if (comp == null && idProduto) {
      try {
        var Dc = window.SIA_Diamantes ? window.SIA_Diamantes.estado() : null;
        var pc3 = Dc && Dc.porProduto && Dc.porProduto[String(idProduto)];
        if (pc3 && pc3.competitividade != null) comp = pc3.competitividade;
      } catch (e) { /* noop */ }
    }
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
    // Funil do produto contra a media da loja: sem a comparacao, 2% de
    // conversao nao diz se e bom ou ruim.
    if (idProduto) {
      var fq = funilDoProduto(idProduto);
      if (fq) {
        h += renderComparacao(idProduto);
        h += olho('O CAMINHO ATE A VENDA', 'Cada degrau mostra quantas pessoas seguiram para a etapa seguinte. O degrau com a maior queda e onde vale colocar esforco primeiro: melhorar um degrau que ja esta bom rende quase nada.') + fq;

        // como este produto se compara com a media da loja
        var somaConv = 0, nConv = 0, somaCtr = 0, nCtr = 0;
        for (var pk in estado.produtos) {
          var mk3 = estado.produtos[pk].metricas || {};
          if ((mk3.visitantes || 0) < 30) continue;
          if (mk3.conversao_pago != null) { somaConv += mk3.conversao_pago; nConv++; }
          if (mk3.ctr_card != null) { somaCtr += mk3.ctr_card; nCtr++; }
        }
        var mProd = (estado.produtos[idProduto] && estado.produtos[idProduto].metricas) || {};
        var convP = mProd.conversao_pago, ctrP = mProd.ctr_card;
        var mediaConv = nConv ? somaConv / nConv : null, mediaCtr = nCtr ? somaCtr / nCtr : null;
        if (mediaConv != null && convP != null) {
          var razao = convP / mediaConv;
          h += '<div style="background:color-mix(in srgb,' + (razao >= 1 ? 'var(--vd)' : 'var(--am)') + ' var(--tin,9%),var(--b2));border-left:3px solid ' + (razao >= 1 ? 'var(--vd)' : 'var(--am)') + ';border-radius:0 16px 16px 0;padding:13px 15px;margin-bottom:12px;font-size:13.5px;color:var(--t1);line-height:1.55">' +
            '<b style="color:var(--t0)">Contra a media da sua loja:</b> este produto converte ' + fmt(convP, 1) + '% e a media e ' + fmt(mediaConv, 1) + '%' +
            (razao >= 1.3 ? ' — ' + fmt(razao, 1) + 'x melhor que o resto do catalogo.'
             : razao >= 1 ? ', ou seja esta na faixa da loja.'
             : ' — ' + fmt(1 / razao, 1) + 'x pior que o resto do catalogo.') +
            (mediaCtr != null && ctrP != null ? ' No clique, ' + fmt(ctrP, 1) + '% contra ' + fmt(mediaCtr, 1) + '% da loja.' : '') +
            '</div>';
        }
      }
    }

    // Produto sem campanha nao tem nada de Ads para mostrar. Antes o card
    // abria as secoes de leilao e meta mesmo assim, e a leitura de funil —
    // que e o motivo de ter clicado — ficava enterrada embaixo delas.
    var temAds = !!(pc && (pc.metricas || pc.campanha));
    if (!temAds) {
      h += '<div class="nota">Este produto nao tem campanha ativa nesta leitura. O que esta abaixo e o funil organico dele.</div>';
    }

    // ---- APRENDIZADO REAL, dito pela Shopee ----
    // Substitui a estimativa por idade da campanha, que era um chute.
    var apr = temAds ? (pc && pc.aprendizado) : null;
    if (apr) {
      if (apr.emAprendizado) {
        h += '<div style="background:color-mix(in srgb,var(--px) var(--tin,9%),var(--b2));border-left:3px solid var(--px);border-radius:0 16px 16px 0;padding:13px 15px;margin-bottom:12px;font-size:13.5px;color:var(--t1);line-height:1.55">' +
          '<b style="color:var(--t0)">Em aprendizado agora</b> \u2014 a propria Shopee marca esta campanha como em fase de aprendizado. ' +
          'Enquanto isso durar, o resultado dela ainda nao representa o que ela vai entregar. Mexer agora reinicia a contagem.</div>';
      }
      if (apr.ultimaTroca) {
        var tt = apr.ultimaTroca;
        var quando = tt.em ? new Date(tt.em * 1000) : null;
        h += '<div style="background:color-mix(in srgb,var(--am) var(--tin,9%),var(--b2));border-left:3px solid var(--am);border-radius:0 16px 16px 0;padding:13px 15px;margin-bottom:12px;font-size:13.5px;color:var(--t1);line-height:1.55">' +
          '<b style="color:var(--t0)">A meta foi alterada' + (quando ? ' em ' + quando.toLocaleDateString('pt-BR') : '') + '</b>: de ' +
          fmt(tt.de, 1) + 'x para ' + fmt(tt.para, 1) + 'x' + (apr.trocasDeMeta.length > 1 ? ', e foram ' + apr.trocasDeMeta.length + ' mudancas no periodo' : '') + '. ' +
          'Cada alteracao reinicia o aprendizado \u2014 o numero que voce esta vendo mistura o antes e o depois.</div>';
      }
      if (apr.impulsionando) {
        h += '<div class="nota" style="color:var(--px)">Esta campanha esta sob <b>impulsionamento de produto novo</b>, o que altera a entrega e a meta efetiva.</div>';
      }
    }

    // ---- CPM E FATIA DE LEILAO ----
    var mrep = temAds ? ((pc && pc.metricas) || {}) : {};
    var cpmReal = (mrep.gasto && mrep.impressoes) ? (mrep.gasto / mrep.impressoes) * 1000 : null;
    var ls = pc && pc.leilaoSerie;
    if (cpmReal != null || (ls && (ls.sovMedio != null || ls.alcanceMax != null))) {
      h += olho('O QUE VOCE PAGA PARA APARECER', '<b>CPM e o preco que o algoritmo calculou que a sua impressao vale.</b> No oCPM ele nao e uma taxa: pela lei do leilao, CPM = (ticket x conversao x CTR x 1000) / ROAS. Entao CPM alto e consequencia de funil bom \u2014 e bonificacao, nao desperdicio. Ele so vira problema quando esta alto E a venda nao vem: ai o algoritmo previu conversao que nao aconteceu. <b>Fatia de voz</b> e quanto das impressoes disponiveis nessa disputa foram suas.');
      h += '<div class="tres">' +
        '<div><div class="v">' + (cpmReal != null ? 'R$' + fmt(cpmReal, 2) : '\u2014') + '</div><div class="l">CPM REAL</div><div class="s">por mil impressoes</div></div>' +
        '<div><div class="v">' + (ls && ls.sovMedio != null ? fmt(ls.sovMedio, 1) + '%' : '\u2014') + '</div><div class="l">FATIA DE VOZ</div><div class="s">das impressoes</div></div>' +
        '<div><div class="v">' + (ls && ls.alcanceMax != null ? fmt(ls.alcanceMax, 0) : '\u2014') + '</div><div class="l">ALCANCE</div><div class="s">pessoas unicas</div></div></div>';

      // CPM que a matematica do produto sustenta
      var tkt = pp && pp.perf && (pp.perf.ticket || (pp.perf.vendaPaga && pp.perf.pedidosPagos ? pp.perf.vendaPaga / pp.perf.pedidosPagos : null));
      var cvv = pp && pp.perf && pp.perf.convPago;
      var ctrv = mrep.impressoes ? (mrep.cliques || 0) / mrep.impressoes * 100 : null;
      var metaV = pc && (pc.metaRoas || (pc.campanha && pc.campanha.roi_two_target));
      if (tkt && cvv && ctrv && metaV) {
        var alvo = (tkt * (cvv / 100) * (ctrv / 100) * 1000) / metaV;
        var acimaAlvo = cpmReal != null && cpmReal > alvo * 1.2;
        h += '<div style="background:var(--b0);border-left:3px solid ' + (acimaAlvo ? 'var(--am)' : 'var(--vd)') + ';border-radius:0 16px 16px 0;padding:13px 15px;margin-bottom:12px;font-size:13.5px;color:var(--t1);line-height:1.55">' +
          '<b style="color:var(--t0)">Pela matematica deste produto, o CPM que sustenta a meta de ' + fmt(metaV, 1) + 'x e R$' + fmt(alvo, 2) + '.</b> ' +
          (cpmReal == null ? '' : acimaAlvo
            ? 'Voce esta pagando R$' + fmt(cpmReal, 2) + ' \u2014 acima do que ticket, conversao e clique deste produto aguentam nessa meta.'
            : 'Voce esta pagando R$' + fmt(cpmReal, 2) + ' \u2014 dentro do que a conta deste produto sustenta.') + '</div>';
      }
    }

    var fase = faseAprendizado(pc && pc.campanha ? pc.campanha : pc);
    if (apr) fase = null;   // dado real ganha da estimativa por idade
    if (fase) {
      h += '<div style="background:color-mix(in srgb,var(--px) var(--tin,9%),var(--b2));border-left:3px solid var(--px);border-radius:0 16px 16px 0;padding:13px 15px;margin-bottom:12px;font-size:13.5px;color:var(--t1);line-height:1.55">' +
        '<b style="color:var(--t0)">Ainda em aprendizado &mdash; faltam ' + fase.faltam + ' dia' + (fase.faltam === 1 ? '' : 's') + '</b><br>' + esc(fase.texto) + '</div>';
    }
    h += olho('O QUE A SHOPEE SABE E NAO MOSTRA', '<b>Estes quatro numeros existem na API da Shopee e nao aparecem no painel dela.</b> Posicao no leilao e onde seu anuncio cai na disputa. Competitividade e como o seu preco esta contra a categoria, na regua dela. Status diz se o produto tem alcance limitado. Diagnostico e o problema que ela mesma aponta.') +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:11px">' +
      chip('POSICAO NO LEILAO', posLeilao != null ? fmt(posLeilao, 0) : '—', posLeilao == null ? 'sem dado' : (posLeilao <= 10 ? 'topo da vitrine' : (posLeilao <= 30 ? 'meio da vitrine' : 'fundo da vitrine')), posLeilao != null && posLeilao <= 10 ? 'var(--vd)' : (posLeilao > 30 ? 'var(--rd)' : 'var(--am)')) +
      chip('COMPETITIVIDADE PRECO', comp != null ? fmt(comp, 0) + '<span style="font-size:11px;color:var(--t2)">/100</span>' : '—', comp == null ? 'a Shopee nao calculou para este produto' : (comp >= 70 ? 'acima da categoria' : (comp >= 40 ? 'na media' : 'caro pra categoria')), comp != null && comp >= 70 ? 'var(--vd)' : (comp != null && comp < 40 ? 'var(--rd)' : 'var(--am)')) +
      chip('STATUS SHOPEE', st ? esc(st === 'normal' ? 'Normal' : st) : '—', st === 'normal' ? 'sem limitacao' : (st ? 'produto limitado' : 'nao informado nesta coleta'), st && st !== 'normal' ? 'var(--rd)' : 'var(--vd)') +
      chip('DIAGNOSTICO SHOPEE', diagRot, diagSub, diagCor) +
      '</div>';

    // O ROAS que a propria Shopee recomenda para este produto, com a faixa
    // estimada. Vem da mesma rota da competitividade e nunca foi mostrado.
    var roasRec = pp && pp.roasRecomendado != null ? pp.roasRecomendado : null;
    if (roasRec != null) {
      var pisoAqui = (estado.cofre && margemMediaCofre()) ? 100 / margemMediaCofre() : null;
      var abaixo = pisoAqui != null && roasRec < pisoAqui;
      h += '<div style="background:color-mix(in srgb,' + (abaixo ? 'var(--rd)' : 'var(--px)') + ' var(--tin,9%),var(--b2));border-left:3px solid ' + (abaixo ? 'var(--rd)' : 'var(--px)') + ';border-radius:0 16px 16px 0;padding:13px 15px;margin-bottom:12px;font-size:13.5px;color:var(--t1);line-height:1.55">' +
        '<b style="color:var(--t0)">A Shopee recomenda meta de ' + fmt(roasRec, 1) + 'x para este produto</b>' +
        (pp.roiEstimadoMin != null && pp.roiEstimadoMax != null ? ', e estima retorno entre ' + fmt(pp.roiEstimadoMin, 1) + 'x e ' + fmt(pp.roiEstimadoMax, 1) + 'x' : '') + '.' +
        (abaixo
          ? '<br><span style="color:var(--rd)">Isso esta abaixo do seu ponto de equilibrio de ' + fmt(pisoAqui, 1) + 'x. Seguir essa recomendacao faria cada venda sair no prejuizo.</span>'
          : (pisoAqui != null ? '<br>Seu ponto de equilibrio e ' + fmt(pisoAqui, 1) + 'x, entao ha espaco para trabalhar.' : '<br>Cadastre o custo no Cofre para saber se essa meta cabe na sua margem.')) +
        '</div>';
    }

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
      '<div style="display:flex;align-items:center;gap:4px;background:var(--b0);border:1px solid var(--li);border-radius:18px;padding:12px 8px">';
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
  var DICAS = {};   // guarda o texto fora do atributo: assim ele pode ter
                    // negrito sem quebrar o HTML e sem ser escapado duas vezes
  var seqDica = 0;
  // Envolve texto que identifica a conta. So isso e borrado no modo gravacao.
  function sig(txt) {
    return '<span class="sigilo">' + esc(txt) + '</span>';
  }
  function dica(txt) {
    var k = 'd' + (++seqDica);
    DICAS[k] = txt;
    return '<button class="dica" data-dica="' + k + '" aria-label="explicar">?</button>';
  }
  function mostrarExpl(txt) {
    var e = $('sia-expl');
    if (!e) return;
    e.innerHTML = '<button class="x" id="sia-expl-x" aria-label="fechar">\u2715</button>' + txt;
    e.classList.add('on');
    var x = $('sia-expl-x');
    if (x) x.addEventListener('click', function () { e.classList.remove('on'); });
  }
  function aplicarTema(escuro) {
    estado.temaEscuro = !!escuro;
    try { host.classList.toggle('escuro', !!escuro); } catch (e) { /* noop */ }
    var b = $('sia-tema');
    if (b) b.innerHTML = escuro ? ICONE_SOL : ICONE_LUA;
  }
  function ligarGravacao() {
    var b = $('sia-gravar');
    if (!b) return;
    b.addEventListener('click', function () {
      estado.gravando = !estado.gravando;
      try { host.classList.toggle('gravando', estado.gravando); } catch (e) { /* noop */ }
      b.classList.toggle('on', estado.gravando);
      if (estado.gravando) {
        mostrarExpl('<b>Modo gravacao ligado.</b> O nome da loja e os nomes dos seus produtos ficam borrados. Numeros, vereditos e os dados do Espiao continuam visiveis, porque sao o que voce quer mostrar. Passe o mouse sobre um nome borrado para ver por um instante.');
      }
      render();
    });
  }
  function ligarTema() {
    var b = $('sia-tema');
    if (!b) return;
    b.addEventListener('click', function () {
      aplicarTema(!estado.temaEscuro);
      try { chrome.runtime.sendMessage({ tipo: 'sia:pref-salvar', chave: 'temaEscuro', valor: estado.temaEscuro }, function () { void chrome.runtime.lastError; }); } catch (e) { /* noop */ }
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
  // Estava declarada DENTRO de coletaCompleta e era chamada de fora por
  // epochDoMes: ReferenceError na hora de gerar o relatorio, que e o motivo
  // real do botao "nao fazer nada". Agora vive no escopo do modulo.
  var BRT_OFFSET = 3 * 3600;
  // varias rotas exigem um reference_id no corpo; sem ele a Shopee recusa
  function uuidSimples() {
    function h4() { return Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1); }
    return h4() + h4() + '-' + h4() + '-' + h4() + '-' + h4() + '-' + h4() + h4() + h4();
  }
  function inicioDoDiaBRT(ts) {
    // 00:00 BRT = 03:00 UTC. Vai pro dia UTC deslocado, arredonda, volta.
    return Math.floor((ts - BRT_OFFSET) / 86400) * 86400 + BRT_OFFSET;
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
    // ORIGEM CORRETA DOS DADOS.
    // Eu estava lendo de estado.conta.campos com nomes inventados (vendas,
    // ads_invest, afil_vendas) que nao existem em lugar nenhum — por isso o
    // relatorio saiu inteiro com "Nao disponivel" mesmo com a conta lida.
    // Os numeros da conta vivem em COFRE.gerenciais (gmvPago, pedidosPagos,
    // uv, pv, ticketMedio, conversaoLoja) e os de Ads sao somados das
    // campanhas, que e onde o dado realmente esta.
    var D = null;
    try { if (window.SIA_Diamantes) D = window.SIA_Diamantes.estado(); } catch (e) { /* noop */ }
    var G = (D && D.gerenciais) || {};
    var AF = (D && D.afiliados && D.afiliados.resumo) || {};

    function val(o) {
      if (o == null) return null;
      if (typeof o === 'number') return isFinite(o) ? o : null;
      if (typeof o === 'object' && o.valor !== undefined) return numeroPuro(o.valor);
      return numeroPuro(o);
    }

    // MESMO ERRO QUE JA CORRIGI NAS CAMPANHAS: lia so de COFRE.porProduto e
    // ignorava estado.produtos, que e onde a maioria vive. Por isso o
    // relatorio listava produtos que nao eram os que mais venderam — ele
    // ordenava corretamente, mas dentro de uma lista incompleta.
    var prods = [], id;
    var PP = {};
    var PPcofre = (D && D.porProduto) || {};
    for (id in PPcofre) PP[id] = { nome: PPcofre[id].nome, perf: PPcofre[id].perf || {} };
    for (id in estado.produtos) {
      var pe = estado.produtos[id] || {}, me = pe.metricas || {};
      if (!PP[id]) PP[id] = { nome: pe.nome, perf: {} };
      if (!PP[id].nome && pe.nome) PP[id].nome = pe.nome;
      var pf = PP[id].perf;
      if (pf.uv == null && me.visitantes != null) pf.uv = me.visitantes;
      if (pf.cliques == null && me.cliques != null) pf.cliques = me.cliques;
      if (pf.atc == null && me.carrinho != null) pf.atc = me.carrinho;
      if (pf.pedidosPagos == null && me.pedidos_pagos != null) pf.pedidosPagos = me.pedidos_pagos;
      if (pf.vendaPaga == null && me.vendas_pagas != null) pf.vendaPaga = me.vendas_pagas;
      if (pf.convPago == null && me.conversao_pago != null) pf.convPago = me.conversao_pago;
    }
    for (id in PP) {
      var pr = PP[id], perf = (pr && pr.perf) || {};
      if (!pr || !pr.nome) continue;
      if (!ehProdutoDeVerdade(pr.nome)) continue;
      prods.push({
        nome: String(pr.nome).slice(0, 80), id: id,
        visitantes: val(perf.uv) != null ? val(perf.uv) : val(perf.visitantes),
        cliques: val(perf.cliques), carrinho: val(perf.carrinho) != null ? val(perf.carrinho) : val(perf.atc),
        unidades: val(perf.pedidosPagos) != null ? val(perf.pedidosPagos) : val(perf.unidadesPagas),
        vendas: val(perf.vendaPaga) != null ? val(perf.vendaPaga) : val(perf.venda),
        conversao: val(perf.convPago) != null ? val(perf.convPago) : val(perf.conversao)
      });
    }
    prods.sort(function (a, b) { return (b.vendas || 0) - (a.vendas || 0); });

    // SELECAO POR GRUPO, nao os 25 primeiros. A maioria das lojas passa de 25
    // itens e mandar todos gasta token sem melhorar a analise. O que importa
    // sao quatro recortes, e um produto pode estar em mais de um.
    function selecionarProdutos(lista, listaAnterior) {
      var antes = {};
      (listaAnterior || []).forEach(function (x) { antes[x.id] = x; });
      var totalGmv = 0;
      lista.forEach(function (x) { totalGmv += x.vendas || 0; });

      lista.forEach(function (x) {
        var a = antes[x.id];
        x.grupos = [];
        x.fatiaPct = totalGmv ? ((x.vendas || 0) / totalGmv) * 100 : null;
        if (a && a.vendas) {
          x.variacaoPct = (((x.vendas || 0) - a.vendas) / a.vendas) * 100;
          x.vendasAntes = a.vendas;
        } else if (!a && (x.vendas || 0) > 0) {
          x.novo = true;
        }
      });

      var porGmv = lista.slice(0, 5);
      porGmv.forEach(function (x) { x.grupos.push('top faturamento'); });

      // pior desempenho: tem trafego e nao converte
      var pior = lista.filter(function (x) { return (x.visitantes || 0) >= 100 && porGmv.indexOf(x) < 0; })
        .sort(function (a, b) { return (a.conversao || 0) - (b.conversao || 0); }).slice(0, 5);
      pior.forEach(function (x) { x.grupos.push('pior conversao'); });

      // maior crescimento no periodo
      var cresceu = lista.filter(function (x) { return x.variacaoPct != null && x.variacaoPct > 30 && (x.vendas || 0) > 0; })
        .sort(function (a, b) { return b.variacaoPct - a.variacaoPct; }).slice(0, 5);
      cresceu.forEach(function (x) { if (x.grupos.indexOf('top faturamento') < 0) x.grupos.push('crescimento'); });

      // PERDENDO E PESANDO: caiu no periodo e representa fatia relevante
      var caindo = lista.filter(function (x) {
        return x.variacaoPct != null && x.variacaoPct < -15 && (x.fatiaPct || 0) >= 3;
      }).sort(function (a, b) { return (b.fatiaPct || 0) - (a.fatiaPct || 0); }).slice(0, 5);
      caindo.forEach(function (x) { x.grupos.push('perdendo desempenho'); });

      var vistos = {}, saida = [];
      [].concat(porGmv, pior, cresceu, caindo).forEach(function (x) {
        if (!vistos[x.id]) { vistos[x.id] = 1; saida.push(x); }
      });
      return { selecionados: saida, total: lista.length, totalGmv: totalGmv };
    }

    // campanhas + soma de Ads
    var camps = [], k, fmtCont = {};
    // As campanhas do homepage/query vivem em estado.campanhas; o
    // COFRE.porCampanha so recebe dados de outras rotas e fica quase vazio.
    // Ler so dele fazia o relatorio sair sem NENHUM numero de Ads, mesmo com
    // 300 campanhas lidas — foi o que aconteceu no relatorio de 03/08.
    var PC = {};
    for (var kc in estado.campanhas) PC[kc] = estado.campanhas[kc];
    var PCcofre = (D && D.porCampanha) || {};
    for (kc in PCcofre) {
      if (!PC[kc]) { PC[kc] = PCcofre[kc]; continue; }
      // completa o que faltar, sem sobrescrever o que ja veio
      var alvo = PC[kc], extra = PCcofre[kc] || {};
      alvo.metricas = alvo.metricas || {};
      for (var mk2 in (extra.metricas || {})) {
        if (alvo.metricas[mk2] == null) alvo.metricas[mk2] = extra.metricas[mk2];
      }
      if (extra.metaRoas != null && alvo.metaRoas == null) alvo.metaRoas = extra.metaRoas;
      if (extra.leilao && !alvo.leilao) alvo.leilao = extra.leilao;
    }
    var somaGasto = 0, somaImpr = 0, somaCliq = 0, somaPed = 0, somaGmvAds = 0;
    for (k in PC) {
      var cp = PC[k], m = (cp && cp.metricas) || {};
      if (!cp) continue;
      var g = val(m.gasto), ro = val(m.roas), imp = val(m.impressoes), cli = val(m.cliques), ped = val(m.pedidos);
      var fm = cp.tipoFormato || (cp.type === 'product_mpd' ? 'Grupo de Anuncios'
        : cp.type === 'shop_auto' ? 'Anuncio Automatico de Loja'
        : cp.type === 'shop_manual' ? 'Busca de Loja'
        : (cp.subtype ? 'GMV Max Meta de ROAS' : 'GMV Max Automatico'));
      somaGasto += g || 0; somaImpr += imp || 0; somaCliq += cli || 0; somaPed += ped || 0;
      if (g != null && ro != null) somaGmvAds += g * ro;
      if (!fmtCont[fm]) fmtCont[fm] = { rotulo: fm, qtd: 0, gasto: 0, gmvS: 0 };
      fmtCont[fm].qtd++; fmtCont[fm].gasto += (g || 0); fmtCont[fm].gmvS += (g || 0) * (ro || 0);
      camps.push({
        nome: String(cp.nome || k).slice(0, 70),
        produtoId: cp.produtoId || null,
        itensGrupo: cp.itensGrupo ? cp.itensGrupo.length : null,
        formato: fm,
        gasto: g, gmv: (g != null && ro != null) ? g * ro : null, roas: ro,
        roasDireto: val(m.roasDireto), pedidos: ped,
        cpa: (g != null && ped) ? g / ped : null,
        metaAtual: val(cp.metaRoas), metaSugerida: val(cp.metaSugerida)
      });
    }
    camps.sort(function (a, b) { return (b.gasto || 0) - (a.gasto || 0); });
    var formatos = [];
    for (k in fmtCont) { var f = fmtCont[k]; formatos.push({ rotulo: f.rotulo, qtd: f.qtd, gasto: f.gasto, roas: f.gasto ? f.gmvS / f.gasto : null }); }

    var gmv = val(G.gmvPago), pedidos = val(G.pedidosPagos), uv = val(G.uv) != null ? val(G.uv) : val(G.visitantes);
    var ticket = val(G.ticketMedio);
    if (ticket == null && gmv && pedidos) ticket = gmv / pedidos;

    return {
      periodo: rotulo,
      conta: {
        gmvPago: gmv, pedidosPagos: pedidos, visitantes: uv,
        conversaoPaga: val(G.conversaoLoja), ticketMedio: ticket,
        cancelamentos: val(G.cancelados), visualizacoes: val(G.pv),
        carrinho: val(G.carrinho) != null ? val(G.carrinho) : val(G.atc)
      },
      ads: {
        investimento: somaGasto || null, impressoes: somaImpr || null, cliques: somaCliq || null,
        ctr: somaImpr ? (somaCliq / somaImpr) * 100 : null,
        gmvPainel: somaGmvAds || null, gmvReal: somaGmvAds || null,
        pedidos: somaPed || null,
        roasPainel: somaGasto ? somaGmvAds / somaGasto : null,
        roasReal: somaGasto ? somaGmvAds / somaGasto : null,
        cpa: somaPed ? somaGasto / somaPed : null
      },
      afiliados: {
        gmv: val(AF.vendas), comissao: val(AF.comissao), pedidos: val(AF.pedidos),
        novosCompradores: val(AF.novos), roi: val(AF.roi)
      },
      origem: (D && D.origem) ? {
        canais: (D.origem.canais || []).slice(0, 8),
        afiliados: D.origem.afiliados, adsPago: D.origem.adsPago
      } : null,
      naoPago: (D && D.tendencia && D.tendencia.perdaPosPedido) ? {
        perdaPct: D.tendencia.perdaPosPedido.perdaPct,
        totalColocado: D.tendencia.perdaPosPedido.totalColocado,
        totalPago: D.tendencia.perdaPosPedido.totalConfirmado,
        diasRuins: D.tendencia.perdaPosPedido.diasRuins
      } : null,
      produtos: prods.slice(0, 25),
      selecao: selecionarProdutos(prods, (estado.rel && estado.rel.produtosAnteriores) || null),
      campanhas: camps.slice(0, 25), formatos: formatos
    };
  }

  /* ============ PLANILHA DO GRUPO DE ANUNCIOS ============
     A API nao entrega metrica por produto dentro de Grupo de Anuncios — mas
     a exportacao do painel entrega. Ideia da Karina: em vez de so declarar a
     limitacao, pedir a planilha e analisar a partir dela. E o unico caminho
     para saber qual item sustenta e qual parasita o grupo. */
  /* Pausada nao gasta agora: deixar as duas na mesma tabela enche a lista de
     coisa que nao acontece mais. Ativas por padrao; as pausadas ficam atras
     de um clique e sao ordenadas por retorno, que e o que interessa nelas. */
  /* ============ CARDS DE CAMPANHA ============
     Tabela nao e analise: ela mostra numeros lado a lado e deixa a leitura
     para o analista. Cada campanha agora vira um card com veredito, o que
     esta acontecendo e o que fazer — como o analista faria. */
  function campoCalc(campo, id, rot, valor) {
    return '<div><div style="font-family:Space Mono,monospace;font-size:9px;color:var(--t2);margin-bottom:4px">' + rot + '</div>' +
      '<input data-calc="' + esc(campo) + ':' + esc(id) + '" value="' + esc(String(valor)) + '" placeholder="0,00" ' +
      'style="width:100%;background:var(--b1);border:1px solid var(--li);border-radius:7px;padding:8px 9px;color:var(--t0);font-family:Space Mono,monospace;font-size:13px"></div>';
  }

  function cardCampanha(id) {
    var c = estado.campanhas[id] || {};
    var m = c.metricas || {};
    var D = null;
    try { D = window.SIA_Diamantes ? window.SIA_Diamantes.estado() : null; } catch (e) { /* noop */ }
    var pcC = (D && D.porCampanha && D.porCampanha[id]) || {};

    var gasto = m.gasto != null ? m.gasto : null;
    var roas = m.roas != null ? m.roas : null;
    var impr = m.impressoes != null ? m.impressoes : null;
    var cliq = m.cliques != null ? m.cliques : null;
    var ped = m.pedidos != null ? m.pedidos : 0;
    var gmv = (gasto != null && roas != null) ? gasto * roas : null;
    var ctr = impr ? (cliq || 0) / impr * 100 : null;
    var cpc = cliq ? gasto / cliq : null;
    var cpa = ped ? gasto / ped : null;
    var cpm = impr ? gasto / impr * 1000 : null;
    var meta = m.metaRoas != null ? m.metaRoas : (pcC.metaRoas != null ? pcC.metaRoas : null);
    var pos = (pcC.leilao && pcC.leilao.posicao) || m.posicao || null;

    var margem = margemMediaCofre();
    var piso = margem ? 100 / margem : 4;
    var temCofre = !!margem;

    // regua da propria loja
    var totCliq = 0, totPed = 0;
    for (var k in estado.campanhas) {
      var mm = estado.campanhas[k].metricas || {};
      totCliq += mm.cliques || 0; totPed += mm.pedidos || 0;
    }
    var cliquesPorVenda = totPed ? totCliq / totPed : null;

    var estadoC = String(c.estado || c.state || '').toLowerCase();
    var pausada = (estadoC === 'paused' || estadoC === 'ended' || estadoC === 'closed');

    // ---- VEREDITO ----
    var nivel = 'cinza', titulo = 'Sem volume para julgar', texto = '', passos = [];
    if (pausada) {
      nivel = 'cinza'; titulo = 'Pausada';
      texto = gmv ? 'Enquanto rodava, gerou ' + reais(gmv) + ' com ' + reais(gasto) + ' investidos.' : 'Nao gerou receita registrada no periodo.';
      passos = gmv && roas >= piso ? ['Rendia acima do seu equilibrio: vale entender por que parou'] : [];
    } else if (!gasto) {
      nivel = 'cinza'; titulo = 'Sem investimento no periodo';
      texto = 'Nao gastou nada neste recorte. Pode estar sem saldo, fora do ar ou com orcamento zerado.';
      passos = ['Confira saldo e orcamento diario'];
    } else if (ped === 0 && cliquesPorVenda && cliq < cliquesPorVenda) {
      nivel = 'cinza'; titulo = 'Ainda cedo para julgar';
      texto = 'Gastou ' + reais(gasto) + ' e comprou ' + fmt(cliq, 0) + ' cliques. Nesta loja, cada venda custa cerca de ' + fmt(cliquesPorVenda, 0) + ' cliques.';
      passos = ['Reavalie quando passar de ' + fmt(cliquesPorVenda, 0) + ' cliques'];
    } else if (ped === 0) {
      nivel = 'vermelho';
      if (ctr != null && ctr < 1.8) {
        titulo = 'Paga para aparecer e recebe pouco clique';
        texto = 'De cada 100 que veem, ' + fmt(ctr, 1) + ' clicam — o normal e ao menos 2. ' + reais(gasto) + ' gastos sem venda.';
        passos = ['A primeira foto e o preco no card decidem o clique', 'Compare com quem aparece na mesma busca'];
      } else {
        titulo = 'Recebe clique e nao vende';
        texto = fmt(cliq, 0) + ' cliques, ' + reais(gasto) + ' gastos e nenhuma venda. O card funciona; o freio esta na pagina.';
        passos = ['Abra o card do produto e toque em comparar com os 3 que mais vendem', 'A Seller.IA busca a vitrine e mostra o que eles fazem diferente'];
      }
    } else if (roas != null && roas < piso) {
      nivel = 'vermelho'; titulo = 'Vende, mas abaixo do seu equilibrio';
      var perda = gasto * (roas * ((margem || 25) / 100) - 1);
      texto = 'Entrega ' + fmt(roas, 1) + 'x e o equilibrio e ' + fmt(piso, 1) + 'x. ' +
        (perda < 0 ? 'Resultado no periodo: ' + reais(perda) + '.' : '') +
        (temCofre ? '' : ' Margem assumida de 25% — cadastre o custo no Cofre.');
      passos = ['Suba a meta em degraus de 20% e meça 7 dias', 'Se o volume cair sem o lucro subir, o problema e a pagina'];
    } else if (roas != null && roas >= piso * 1.5) {
      nivel = 'verde'; titulo = 'Aqui cabe mais investimento';
      texto = 'Entrega ' + fmt(roas, 1) + 'x contra o equilibrio de ' + fmt(piso, 1) + 'x. ' + reais(gmv) + ' com ' + reais(gasto) + '.';
      passos = ['Suba o orcamento em 20%, nao mais que isso de uma vez', 'Meça 7 dias antes do proximo aumento'];
    } else {
      nivel = 'amarelo'; titulo = 'Dentro do esperado';
      texto = 'Entrega ' + fmt(roas, 1) + 'x, acima do equilibrio de ' + fmt(piso, 1) + 'x, mas sem folga para escalar com seguranca.';
      passos = ['Melhore a pagina antes de subir orcamento'];
    }

    var co = CORES_SEM[nivel] || CORES_SEM.cinza;
    // O CARD INTEIRO expande. Antes ele tinha data-card, que levava para outra
    // tela, e o link de expandir era filho dele — clicar em quase qualquer
    // lugar abria a tela errada em vez de expandir.
    var h = '<div data-exp-camp="' + esc(id) + '" style="cursor:pointer;background:' + co.bg + ';border:1px solid ' + co.bd + ';border-left:3px solid ' + co.dot + ';border-radius:var(--r-card,22px);padding:15px 16px;margin-bottom:9px">';
    h += '<div style="display:flex;align-items:baseline;gap:9px;margin-bottom:4px">' +
      '<span style="flex:1;font-size:17px;font-weight:600;color:var(--t0);line-height:1.25">' + esc(titulo) + '</span>' +
      (gasto != null ? '<span style="font-family:Space Mono,monospace;font-size:12px;color:var(--t2);flex:none">' + reais(gasto) + '</span>' : '') + '</div>';
    h += '<div style="font-size:13px;color:var(--t2);margin-bottom:7px;line-height:1.35">' + sig(String(c.nome || c.titulo || ('Campanha ' + id)).slice(0, 62)) +
      (meta ? ' <span style="font-family:Space Mono,monospace;color:var(--t3)">meta ' + fmt(meta, 1) + 'x</span>' : '') +
      (pos ? ' <span style="font-family:Space Mono,monospace;color:var(--t3)">pos ' + fmt(pos, 0) + '</span>' : '') + '</div>';

    // os numeros que sustentam o veredito
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(74px,1fr));gap:1px;background:var(--li);border:1px solid var(--li);border-radius:10px;overflow:hidden;margin-bottom:10px">';
    function celula(rot, val2, cor) {
      return '<div style="background:var(--b0);padding:9px 6px;text-align:center">' +
        '<div style="font-family:Space Mono,monospace;font-size:16px;font-weight:700;color:' + (cor || 'var(--t0)') + '">' + val2 + '</div>' +
        '<div style="font-family:Space Mono,monospace;font-size:9.5px;color:var(--t2);margin-top:5px">' + rot + '</div></div>';
    }
    h += celula('ROAS', roas != null ? fmt(roas, 1) + 'x' : '\u2014', roas != null ? (roas >= piso ? 'var(--vd)' : 'var(--rd)') : null);
    h += celula('CTR', ctr != null ? fmt(ctr, 1) + '%' : '\u2014', ctr != null && ctr < 1.8 ? 'var(--am)' : null);
    h += celula('CPC', cpc != null ? 'R$' + fmt(cpc, 2) : '\u2014');
    h += celula('CPA', cpa != null ? 'R$' + fmt(cpa, 2) : '\u2014');
    h += celula('CPM', cpm != null ? 'R$' + fmt(cpm, 2) : '\u2014');
    h += celula('PEDIDOS', fmt(ped, 0));
    h += '</div>';

    h += '<div style="font-size:15px;color:var(--t1);line-height:1.5">' + esc(texto) + '</div>';
    if (passos.length) {
      // Passos em vermelho pareciam alerta urgente. Agora sao um bloco suave
      // com a cor do nivel so no marcador.
      h += '<div style="background:var(--b1);border-radius:12px;padding:11px 13px;margin-top:9px">';
      for (var q = 0; q < passos.length; q++) {
        h += '<div style="display:flex;gap:8px;align-items:flex-start;font-size:14px;color:var(--t1);line-height:1.45' + (q ? ';margin-top:6px' : '') + '">' +
          '<span style="color:' + co.dot + ';flex:none">\u2192</span><span>' + esc(passos[q]) + '</span></div>';
      }
      h += '</div>';
    }
    // ---- O FUNIL DESTA CAMPANHA ----
    // Impressao -> clique -> carrinho -> pedido, com a queda de cada degrau.
    // Estava faltando: o card mostrava os numeros soltos e nao onde quebra.
    var atcC = (m.carrinho != null) ? m.carrinho : ((pcC.metricas && pcC.metricas.carrinho) != null ? pcC.metricas.carrinho : null);
    var degC = [];
    function vOk(x) { return (typeof x === 'number' && isFinite(x) && x >= 0) ? x : null; }
    if (vOk(impr)) degC.push({ r: 'IMPRESSOES', v: impr });
    if (vOk(cliq) != null) degC.push({ r: 'CLIQUES', v: cliq });
    if (vOk(atcC) != null) degC.push({ r: 'CARRINHO', v: atcC });
    if (vOk(ped) != null) degC.push({ r: 'PEDIDOS', v: ped });
    if (degC.length >= 2) {
      var quedasC = [], piorC = null;
      for (var dq = 1; dq < degC.length; dq++) {
        if (!degC[dq - 1].v || degC[dq - 1].v <= 0) continue;
        if (degC[dq].v == null || degC[dq].v > degC[dq - 1].v) continue;
        var qc = { i: dq, de: degC[dq - 1].r, para: degC[dq].r, pct: (1 - degC[dq].v / degC[dq - 1].v) * 100 };
        quedasC.push(qc);
        if (!piorC || qc.pct > piorC.pct) piorC = qc;
      }
      h += '<div style="background:var(--b1);border:1px solid var(--li);border-radius:16px;padding:12px 10px;margin-bottom:10px">' +
        '<div style="font-family:Space Mono,monospace;font-size:9px;color:var(--t2);letter-spacing:.08em;margin-bottom:8px">O FUNIL DESTA CAMPANHA</div>' +
        '<div style="display:flex;align-items:flex-end;gap:2px">';
      for (var dc = 0; dc < degC.length; dc++) {
        if (dc > 0) {
          var qq = quedasC[dc - 1];
          var ruimC = piorC && qq && qq.i === piorC.i;
          h += '<div style="flex:none;text-align:center;font-family:Space Mono,monospace;font-size:9px;color:' + (ruimC ? 'var(--rd)' : 'var(--t3)') + ';padding-bottom:16px">\u203a<br>' + (qq ? '\u2212' + fmt(qq.pct, 0) + '%' : '') + '</div>';
        }
        h += '<div style="flex:1;text-align:center">' +
          '<div style="font-family:Bebas Neue,sans-serif;font-size:23px;line-height:1;color:' + (dc === degC.length - 1 && !degC[dc].v ? 'var(--rd)' : 'var(--t0)') + '">' + fmt(degC[dc].v, 0) + '</div>' +
          '<div style="font-family:Space Mono,monospace;font-size:7.5px;color:var(--t2);margin-top:4px">' + degC[dc].r + '</div></div>';
      }
      h += '</div>';
      if (piorC) {
        h += '<div style="font-size:12.5px;color:var(--t1);line-height:1.5;margin-top:9px;padding-top:8px;border-top:1px solid var(--li)">' +
          '<b style="color:var(--t0)">Maior perda entre ' + piorC.de.toLowerCase() + ' e ' + piorC.para.toLowerCase() + '</b> \u2014 ' + fmt(piorC.pct, 0) + '%.</div>';
      }
      h += '</div>';
    }

    // ---- EXPANDIR: margem, leilao e o que a Shopee sabe ----
    var aberto = estado.campExpandida === String(id);
    h += '<div style="margin-top:10px;padding-top:9px;border-top:1px solid var(--li);font-family:Space Mono,monospace;font-size:10.5px;color:var(--mk)">' +
      (aberto ? '\u2303 fechar' : '\u2304 toque para analisar margem, leilao e palavras') + '</div>';

    if (aberto) {
      var idProd = c.produtoId || campanhaDoProduto(c.produtoId);
      var pr = idProd ? (estado.produtos[idProd] || {}) : {};
      var mp2 = pr.metricas || {};
      var ticket = mp2.ticket_pedido || (mp2.vendas_pagas && mp2.pedidos_pagos ? mp2.vendas_pagas / mp2.pedidos_pagos : (ped && gmv ? gmv / ped : null));
      var custo = (estado.cofre && estado.cofre.custos && idProd) ? estado.cofre.custos[idProd] : null;

      h += '<div style="background:var(--b1);border:1px solid var(--li);border-radius:16px;padding:13px;margin-top:10px">';
      h += '<div style="font-family:Space Mono,monospace;font-size:9.5px;color:var(--t2);letter-spacing:.08em;margin-bottom:9px">A CONTA DE UM PEDIDO</div>';
      if (ticket) {
        var com2 = ticket < 80 ? ticket * 0.20 + 4 : (ticket < 100 ? ticket * 0.14 + 16 : (ticket < 200 ? ticket * 0.14 + 20 : ticket * 0.14 + 26));
        var adsPorPedido = cpa || 0;
        function ln(rot, val3, cor) {
          return '<div style="display:flex;justify-content:space-between;font-size:13.5px;padding:4px 0;color:' + (cor || 'var(--t1)') + '">' +
            '<span>' + rot + '</span><span style="font-family:Space Mono,monospace">' + val3 + '</span></div>';
        }
        h += ln('Ticket medio', reais(ticket));
        h += ln('\u2212 Comissao Shopee', '\u2212 ' + reais(com2), 'var(--t2)');
        if (adsPorPedido) h += ln('\u2212 Ads por pedido', '\u2212 ' + reais(adsPorPedido), 'var(--t2)');
        if (custo) h += ln('\u2212 Custo do produto', '\u2212 ' + reais(custo), 'var(--t2)');
        var sobra = ticket - com2 - adsPorPedido - (custo || 0);
        h += '<div style="display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid var(--li);margin-top:7px;padding-top:8px">' +
          '<span style="font-size:14px;font-weight:600;color:var(--t0)">' + (custo ? 'Lucro por pedido' : 'Sobra antes do custo') + '</span>' +
          '<span style="font-family:Bebas Neue,sans-serif;font-size:24px;color:' + (sobra > 0 ? 'var(--vd)' : 'var(--rd)') + '">' + reais(sobra) + '</span></div>';
        if (!custo) {
          // Calculadora no proprio card, como a Karina desenhou: preencher
          // aqui e mais rapido que ir ao Cofre, e o resultado aparece na hora.
          h += '<div style="background:var(--b0);border:1px solid var(--li);border-radius:10px;padding:12px;margin-top:10px">' +
            '<div style="font-family:Space Mono,monospace;font-size:9.5px;color:var(--t2);letter-spacing:.08em;margin-bottom:9px">CALCULADORA DE MARGEM</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
            campoCalc('custo', idProd, 'Custo do produto', (estado.calcTmp && estado.calcTmp[idProd] && estado.calcTmp[idProd].custo) || '') +
            campoCalc('embalagem', idProd, 'Embalagem', (estado.calcTmp && estado.calcTmp[idProd] && estado.calcTmp[idProd].embalagem) || '') +
            '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">' +
            campoCalc('imposto', idProd, 'Imposto %', (estado.calcTmp && estado.calcTmp[idProd] && estado.calcTmp[idProd].imposto) || '') +
            '<button data-calc-calcular="' + esc(idProd) + '" style="background:var(--b1);border:1px solid var(--mk);color:var(--mk);font-family:inherit;font-weight:600;font-size:13px;border-radius:var(--r-btn,14px);cursor:pointer;align-self:end;padding:9px">Calcular</button>' +
            '</div>';
          var tmp = (estado.calcTmp && estado.calcTmp[idProd]) || {};
          var cTmp = numeroPuro(tmp.custo), eTmp = numeroPuro(tmp.embalagem) || 0, iTmp = numeroPuro(tmp.imposto) || 0;
          if (cTmp) {
            var impV = ticket * (iTmp / 100);
            var liqT = ticket - com2 - adsPorPedido - cTmp - eTmp - impV;
            var margT = (liqT / ticket) * 100;
            h += '<div style="border-top:1px solid var(--li);margin-top:10px;padding-top:9px;font-size:13.5px;color:var(--t1);line-height:1.55">' +
              'Sobra <b style="color:' + (liqT > 0 ? 'var(--vd)' : 'var(--rd)') + '">' + reais(liqT) + '</b> por pedido, margem de <b style="color:var(--t0)">' + fmt(margT, 1) + '%</b>.<br>' +
              (margT > 0
                ? 'Seu ponto de equilibrio e <b style="color:var(--t0)">' + fmt(100 / margT, 1) + 'x</b>' +
                  (roas != null ? ' e esta campanha entrega ' + fmt(roas, 1) + 'x — ' + (roas >= 100 / margT ? '<b style="color:var(--vd)">esta dando lucro</b>.' : '<b style="color:var(--rd)">esta no prejuizo</b>.') : '.')
                : '<b style="color:var(--rd)">Este produto perde dinheiro em cada venda, antes mesmo do anuncio.</b> Nenhuma meta de ROAS resolve isso.') +
              '</div>';
            h += '<button data-calc-salvar="' + esc(idProd) + '" style="width:100%;margin-top:10px;background:var(--mk);border:none;color:#fff;font-family:inherit;font-weight:600;font-size:13.5px;border-radius:var(--r-btn,14px);cursor:pointer;padding:11px">Salvar este custo no produto</button>';
          } else {
            h += '<div style="font-size:12.5px;color:var(--t2);margin-top:9px;line-height:1.5">Preencha o custo e toque em <b>Calcular</b> para ver a margem real, o ponto de equilibrio e se esta campanha da lucro.</div>';
          }
          h += '</div>';
        } else {
          var margemReal = (sobra / ticket) * 100;
          h += '<div style="font-size:12.5px;color:var(--t2);margin-top:7px;line-height:1.5">Margem de <b style="color:var(--t0)">' + fmt(margemReal, 1) + '%</b> por pedido. Seu ponto de equilibrio nesta campanha e <b style="color:var(--t0)">' + fmt(100 / Math.max(margemReal, 0.1), 1) + 'x</b>.</div>';
        }
      } else {
        h += '<div class="nota">Sem ticket medio para este produto nesta leitura.</div>';
      }
      h += '</div>';

      // o que a Shopee sabe
      var compet = pr.competitividade != null ? pr.competitividade : (pcC.competitividade != null ? pcC.competitividade : null);
      h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:1px;background:var(--li);border:1px solid var(--li);border-radius:10px;overflow:hidden;margin-top:9px">';
      h += celula('POSICAO', pos != null ? fmt(pos, 0) : '\u2014', pos != null && pos > 30 ? 'var(--rd)' : null);
      // A competitividade de 0 a 100 so existe para o produto que a Shopee
      // destaca em todo/list_task — um por conta. O que existe para TODA
      // campanha e o veredito de competitividade no diagnostico, que ja era
      // extraido em pc.eixos e nunca chegou na tela.
      var eixoComp = null;
      if (pcC.eixos) {
        for (var ex = 0; ex < pcC.eixos.length; ex++) {
          if (/competitiveness/.test(String(pcC.eixos[ex].eixo || ''))) { eixoComp = pcC.eixos[ex]; break; }
        }
      }
      var TRAD_NOTA = {
        good: 'boa', normal: 'media', bad: 'ruim', poor: 'ruim', na: '\u2014',
        excellent: 'excelente', fair: 'razoavel', low: 'baixa', high: 'alta',
        medium: 'media', healthy: 'saudavel', limited: 'limitada'
      };
      var valComp = compet != null ? fmt(compet, 0) + '/100'
        : (eixoComp ? (TRAD_NOTA[String(eixoComp.nota || '').toLowerCase()] || eixoComp.nota) : '\u2014');
      var corComp = compet != null ? (compet < 40 ? 'var(--rd)' : null)
        : (eixoComp && /bad|poor|low/.test(String(eixoComp.nota)) ? 'var(--rd)' : (eixoComp && /good|excellent|healthy/.test(String(eixoComp.nota)) ? 'var(--vd)' : null));
      h += celula('COMPETITIVIDADE', valComp, corComp);
      h += celula('IMPRESSOES', impr != null ? fmt(impr, 0) : '\u2014');
      h += celula('GMV', gmv != null ? reais(gmv) : '\u2014');
      h += '</div>';
      if (pcC.eixos && pcC.eixos.length) {
        h += '<div style="font-family:Space Mono,monospace;font-size:9px;color:var(--t2);letter-spacing:.08em;margin:12px 0 8px">O QUE A SHOPEE DIAGNOSTICA' +
          dica('Estes sao os vereditos que a propria Shopee calcula para a campanha e nao mostra em lugar nenhum do painel. Competitividade e como o seu preco e lance se comparam com quem disputa a mesma vitrine.') + '</div>';
        h += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
        var TRAD_EIXO = {
          competitiveness: 'competitividade', competitiveness_v2: 'competitividade',
          budget: 'orcamento', budget_v2: 'orcamento',
          roi_target: 'meta de ROAS', roi_target_v2: 'meta de ROAS',
          continuance: 'continuidade', continuance_v2: 'continuidade',
          listing: 'anuncio', listing_v2: 'anuncio',
          bid: 'lance', bid_v2: 'lance', bidding: 'lance',
          keyword: 'palavras', keyword_v2: 'palavras',
          creative: 'criativo', audience: 'publico', placement: 'posicionamento',
          conversion: 'conversao', traffic: 'trafego', delivery: 'entrega do anuncio'
        };
        for (var ez = 0; ez < pcC.eixos.length; ez++) {
          var E2 = pcC.eixos[ez];
          var rot2 = TRAD_EIXO[E2.eixo] || String(E2.eixo || '').replace(/_v2$/, '').replace(/_/g, ' ');
          var cor2 = E2.nota === 'bad' ? 'var(--rd)' : (E2.nota === 'good' ? 'var(--vd)' : 'var(--t2)');
          h += '<span style="font-family:Space Mono,monospace;font-size:10.5px;padding:5px 11px;border-radius:99px;border:1px solid ' + cor2 + ';color:' + cor2 + '">' +
            esc(rot2) + ': ' + esc(TRAD_NOTA[String(E2.nota || '').toLowerCase()] || String(E2.nota || '').replace(/_/g, ' ')) + '</span>';
        }
        h += '</div>';
      } else if (pos == null && compet == null) {
        h += '<div class="nota">Posicao no leilao vem na leitura profunda.</div>';
      }

      // ---- PALAVRAS: qual acionou, quanto voce paga, quanto perde ----
      var pal = pcC.palavras || [];
      if (pal.length) {
        var perdendo = pal.filter(function (x) { return x.abaixo; });
        h += '<div style="font-family:Space Mono,monospace;font-size:9.5px;color:var(--t2);letter-spacing:.08em;margin:12px 0 8px">' +
          'AS PALAVRAS DESTA CAMPANHA' +
          dica('<b>So a Busca de Loja tem lance por palavra</b> — nos outros formatos a Shopee escolhe sozinha onde mostrar. Aqui da para ver qual termo esta ativo, quanto voce paga por clique nele e quanto a Shopee recomenda. <b>Lance abaixo do recomendado significa perder leilao</b>: seu anuncio deixa de aparecer para quem buscou aquele termo, e o concorrente que paga mais leva.') + '</div>';
        if (perdendo.length) {
          h += '<div style="background:color-mix(in srgb,var(--am) var(--tin,9%),var(--b2));border-left:3px solid var(--am);border-radius:0 16px 16px 0;padding:11px 13px;margin-bottom:9px;font-size:13.5px;color:var(--t1);line-height:1.5">' +
            '<b style="color:var(--t0)">' + perdendo.length + ' de ' + pal.length + ' palavras com lance abaixo do recomendado.</b> ' +
            'Nelas voce aparece menos do que poderia — quem paga mais leva a impressao.</div>';
        }
        h += '<table style="font-size:12.5px"><tr><th>TERMO</th><th class="num">SEU LANCE</th><th class="num">RECOMENDADO</th><th class="num">FALTA</th></tr>';
        for (var pw = 0; pw < Math.min(pal.length, 12); pw++) {
          var P2 = pal[pw];
          h += '<tr><td>' + esc(P2.termo) +
            '<span style="font-family:Space Mono,monospace;font-size:9px;color:var(--t3)"> ' + P2.correspondencia + (P2.ativa ? '' : ' · pausada') + '</span></td>' +
            '<td class="num">' + (P2.lance != null ? 'R$' + fmt(P2.lance, 2) : '\u2014') + '</td>' +
            '<td class="num">' + (P2.recomendado != null ? 'R$' + fmt(P2.recomendado, 2) : '\u2014') + '</td>' +
            '<td class="num" style="color:' + (P2.abaixo ? 'var(--rd)' : 'var(--vd)') + '">' +
            (P2.faltaPct != null && P2.faltaPct > 0 ? '\u2212' + fmt(P2.faltaPct, 0) + '%' : 'ok') + '</td></tr>';
        }
        h += '</table>';
      } else if (String(c.type || '') === 'shop_manual') {
        h += '<div class="nota">As palavras desta campanha vem na leitura profunda.</div>';
      } else {
        // So mostra o aviso se a conta usa Busca de Loja em algum lugar.
        // Numa conta 100% GMV Max isso e informacao inutil repetida em todo
        // card.
        var temBusca = false;
        for (var kb4 in estado.campanhas) { if (String(estado.campanhas[kb4].type || '') === 'shop_manual') { temBusca = true; break; } }
        if (temBusca) h += '<div class="nota">Este formato nao tem lance por palavra \u2014 palavra com lance so existe nas campanhas de <b>Busca de Loja</b>.</div>';
      }
    }
    return h + '</div>';
  }

  // NOME DIFERENTE: existiam duas funcoes ligarCalculadora e a minha
  // sobrescrevia a original da aba de margem, que por isso parou de responder.
  function ligarCamposCalc() {
    var ins = corpoEl().querySelectorAll('[data-calc]');
    for (var i = 0; i < ins.length; i++) {
      ins[i].addEventListener('input', function () {
        var p2 = this.getAttribute('data-calc').split(':');
        estado.calcTmp[p2[1]] = estado.calcTmp[p2[1]] || {};
        estado.calcTmp[p2[1]][p2[0]] = this.value;
      });
      // blur NAO pode chamar render: redesenhar ao sair do campo apagava o
      // que a pessoa acabou de digitar no campo seguinte.
      ins[i].addEventListener('change', function () { estado.sujo = true; });
    }
  }
  function renderFiltroCampanhas() {
    var ativas = 0, pausadas = 0;
    for (var k in estado.campanhas) {
      var e2 = String((estado.campanhas[k] && (estado.campanhas[k].estado || estado.campanhas[k].state)) || '').toLowerCase();
      if (e2 === 'paused' || e2 === 'ended' || e2 === 'closed') pausadas++; else ativas++;
    }
    if (!pausadas) return '';
    var vendo = estado.verPausadas ? 'pausadas' : 'ativas';
    return '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:14px 0 10px">' +
      '<button data-camp-filtro="ativas" style="background:' + (vendo === 'ativas' ? 'var(--mk)' : 'var(--b2)') + ';border:1px solid ' + (vendo === 'ativas' ? 'var(--mk)' : 'var(--li)') + ';color:' + (vendo === 'ativas' ? '#fff' : 'var(--t1)') + ';font-family:inherit;font-size:12.5px;padding:8px 14px;border-radius:var(--r-btn,14px);cursor:pointer">Ativas (' + ativas + ')</button>' +
      '<button data-camp-filtro="pausadas" style="background:' + (vendo === 'pausadas' ? 'var(--mk)' : 'var(--b2)') + ';border:1px solid ' + (vendo === 'pausadas' ? 'var(--mk)' : 'var(--li)') + ';color:' + (vendo === 'pausadas' ? '#fff' : 'var(--t1)') + ';font-family:inherit;font-size:12.5px;padding:8px 14px;border-radius:var(--r-btn,14px);cursor:pointer">Pausadas (' + pausadas + ')</button>' +
      '<span class="nota" style="margin:0;align-self:center">' +
      (estado.verPausadas ? 'Ordenadas por retorno: o que elas geravam antes de parar.' : 'As pausadas ficam de fora da lista por padrao.') + '</span></div>';
  }
  function renderImportador() {
    var g = estado.grupoImportado;
    var h = olho('PLANILHA DO GRUPO DE ANUNCIOS', 'A Shopee nao entrega o desempenho por produto dentro de um Grupo de Anuncios pela API — so o total do grupo. A exportacao do painel entrega. Suba o arquivo aqui e a leitura passa a ser item a item.');
    h += '<div style="background:var(--b0);border:1px solid var(--li);border-radius:18px;padding:16px;margin-bottom:12px">' +
      '<div style="font-size:13.5px;color:var(--t1);line-height:1.6;margin-bottom:12px">' +
      '<b style="color:var(--t0)">Como pegar:</b> Shopee Ads &rsaquo; abra o Grupo de Anuncios &rsaquo; Exportar. ' +
      'Aceita CSV ou XLSX salvo como CSV.</div>' +
      '<input type="file" id="sia-grupo-arq" accept=".csv,.txt,.xlsx" style="width:100%;background:var(--b0);border:1px dashed var(--li2);border-radius:9px;padding:14px;color:var(--t1);font-family:inherit;font-size:13px">';
    if (g && g.linhas && g.linhas.length) {
      h += '<div class="nota" style="color:var(--vd);margin-top:10px">Li <b>' + g.linhas.length + '</b> produtos da planilha de <b>' + esc(g.nome || 'grupo') + '</b>.</div>';
    }
    h += '</div>';

    if (g && g.linhas && g.linhas.length) {
      var tot = 0, i;
      for (i = 0; i < g.linhas.length; i++) tot += (g.linhas[i].gasto || 0);
      h += olho('QUEM SUSTENTA E QUEM PARASITA');
      h += '<table><tr><th>PRODUTO</th><th class="num">GASTO</th><th class="num">%</th><th class="num">ROAS</th><th class="num">PEDIDOS</th></tr>';
      for (i = 0; i < g.linhas.length; i++) {
        var L = g.linhas[i];
        var fatia = tot ? (L.gasto || 0) / tot * 100 : 0;
        var cor = (L.roas != null && L.roas >= 4) ? 'var(--vd)' : (L.roas != null && L.roas < 1 ? 'var(--rd)' : 'var(--am)');
        h += '<tr><td>' + esc(String(L.nome).slice(0, 44)) + '</td>' +
          '<td class="num">' + reais(L.gasto || 0) + '</td>' +
          '<td class="num">' + fmt(fatia, 0) + '%</td>' +
          '<td class="num" style="color:' + cor + '">' + (L.roas != null ? fmt(L.roas, 1) + 'x' : '—') + '</td>' +
          '<td class="num">' + (L.pedidos != null ? fmt(L.pedidos, 0) : '—') + '</td></tr>';
      }
      h += '</table>';
      var piores = g.linhas.filter(function (x) { return (x.gasto || 0) > tot * 0.1 && (x.pedidos || 0) === 0; });
      if (piores.length) {
        h += '<div style="background:color-mix(in srgb,var(--rd) var(--tin,9%),var(--b2));border-left:3px solid var(--rd);border-radius:0 16px 16px 0;padding:14px 15px;margin-top:12px;font-size:14px;color:var(--t1);line-height:1.55">' +
          '<b style="color:var(--t0)">' + piores.length + ' produto(s) consomem o grupo sem vender.</b> ' +
          'Juntos levam ' + reais(piores.reduce(function (s2, x) { return s2 + (x.gasto || 0); }, 0)) + ' do orcamento e nao geraram pedido. ' +
          'Tirar do grupo devolve essa verba para quem esta vendendo.</div>';
      }
    }
    return h;
  }
  function ligarImportador() {
    var inp = $('sia-grupo-arq');
    if (!inp) return;
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      // A Shopee baixa XLSX. Exigir que a pessoa converta para CSV e jogar
      // trabalho para cima dela — o importador tem que aceitar o arquivo do
      // jeito que sai da plataforma.
      var ehXlsx = /\.xlsx?$/i.test(f.name);
      var fr = new FileReader();
      fr.onload = function () {
        try {
          if (ehXlsx) {
            xlsxParaTexto(new Uint8Array(fr.result)).then(function (texto) {
              estado.grupoImportado = lerCsvGrupo(texto, f.name);
              estado.sujo = true; render();
            }).catch(function (e2) {
              mostrarExpl('<b>Nao consegui abrir o XLSX.</b> ' + esc(String(e2 && e2.message || e2)) +
                '<br><br>Alternativa: abra no Excel e salve como CSV.');
            });
            return;
          }
          estado.grupoImportado = lerCsvGrupo(String(fr.result || ''), f.name);
          estado.sujo = true; render();
        } catch (e) {
          mostrarExpl('<b>Nao consegui ler a planilha.</b> ' + esc(String(e && e.message || e)) +
            '<br><br>Se persistir, abra o arquivo e me diga quais sao os nomes das colunas \u2014 posso ensinar o leitor a reconhece-los.');
        }
      };
      if (ehXlsx) fr.readAsArrayBuffer(f); else fr.readAsText(f, 'utf-8');
    });
  }
  /* ---- LER XLSX SEM BIBLIOTECA ----
     Um .xlsx e um zip com XML dentro. Sem descompactar de verdade, da para
     achar as strings e os valores no sheet1 e remontar as linhas. Funciona
     para planilha simples de exportacao, que e o caso da Shopee. */
  // O leitor manual nao descomprime o zip: XLSX moderno vem com deflate, e
  // procurar as strings no binario cru so funciona em arquivo sem compressao.
  // Por isso a planilha da Shopee nunca era lida. Agora a extensao usa a
  // API nativa DecompressionStream, que existe no Chrome, para abrir o zip.
  async function xlsxParaTexto(bytes) {
    function u16(o) { return bytes[o] | (bytes[o + 1] << 8); }
    function u32(o) { return (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0; }
    // varre as entradas locais do zip
    var arquivos = {};
    for (var i = 0; i < bytes.length - 4; i++) {
      if (u32(i) !== 0x04034b50) continue;
      var metodo = u16(i + 8);
      var tamComp = u32(i + 18);
      var tamNome = u16(i + 26), tamExtra = u16(i + 28);
      var ini = i + 30;
      var nome = '';
      for (var j = 0; j < tamNome; j++) nome += String.fromCharCode(bytes[ini + j]);
      var dados = bytes.subarray(ini + tamNome + tamExtra, ini + tamNome + tamExtra + tamComp);
      if (/sharedStrings\.xml$|sheet1\.xml$/.test(nome)) arquivos[nome] = { metodo: metodo, dados: dados };
      i = ini + tamNome + tamExtra + tamComp - 1;
    }
    async function inflar(e) {
      if (!e) return '';
      if (e.metodo === 0) return new TextDecoder().decode(e.dados);
      var ds = new DecompressionStream('deflate-raw');
      var stream = new Blob([e.dados]).stream().pipeThrough(ds);
      return await new Response(stream).text();
    }
    var chaveSS = Object.keys(arquivos).find(function (k) { return /sharedStrings/.test(k); });
    var chaveSh = Object.keys(arquivos).find(function (k) { return /sheet1/.test(k); });
    var xmlSS = await inflar(arquivos[chaveSS]);
    var xmlSh = await inflar(arquivos[chaveSh]);
    if (!xmlSh) throw new Error('nao achei a primeira planilha dentro do arquivo');

    var sst = [], mT, reT = /<t[^>]*>([\s\S]*?)<\/t>/g;
    while ((mT = reT.exec(xmlSS)) !== null) sst.push(mT[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));

    var linhas = [], mR, reR = /<row[^>]*>([\s\S]*?)<\/row>/g;
    while ((mR = reR.exec(xmlSh)) !== null) {
      var cols = [], mC, reC = /<c[^>]*?(?:t="([^"]*)")?[^>]*>(?:<v>([\s\S]*?)<\/v>|<is><t[^>]*>([\s\S]*?)<\/t><\/is>)?<\/c>|<c[^>]*\/>/g;
      while ((mC = reC.exec(mR[1])) !== null) {
        var tipo = mC[1], val = mC[2], inline = mC[3];
        var v = '';
        if (inline != null) v = inline;
        else if (val != null) v = (tipo === 's') ? (sst[parseInt(val, 10)] || '') : val;
        cols.push(String(v).replace(/;/g, ','));
      }
      if (cols.length) linhas.push(cols.join(';'));
    }
    if (linhas.length < 2) throw new Error('a planilha veio vazia ou em formato que nao consigo ler');
    return linhas.join('\n');
  }

  function textoDoXlsx(bytes) {
    var bruto = '';
    for (var i = 0; i < bytes.length; i++) bruto += String.fromCharCode(bytes[i]);
    // os xlsx da Shopee costumam vir sem compressao nos XML pequenos; quando
    // vem comprimido, o texto legivel ainda aparece em blocos
    var sst = [];
    var reT = /<t[^>]*>([^<]*)<\/t>/g, m;
    while ((m = reT.exec(bruto)) !== null) sst.push(m[1]);
    if (!sst.length) throw new Error('nao consegui abrir o XLSX. Salve como CSV no Excel e tente de novo');

    var linhas = [], atual = [], ultimaLinha = null;
    var reC = /<c r="([A-Z]+)(\d+)"([^>]*)>(?:<v>([^<]*)<\/v>)?/g;
    while ((m = reC.exec(bruto)) !== null) {
      var linha = m[2], attrs = m[3] || '', val = m[4];
      if (ultimaLinha !== null && linha !== ultimaLinha) { linhas.push(atual); atual = []; }
      ultimaLinha = linha;
      var v2 = '';
      if (val != null) {
        if (/t="s"/.test(attrs)) { var idx = parseInt(val, 10); v2 = sst[idx] != null ? sst[idx] : ''; }
        else v2 = val;
      }
      atual.push(String(v2).replace(/;/g, ','));
    }
    if (atual.length) linhas.push(atual);
    if (linhas.length < 2) throw new Error('a planilha parece vazia ou em formato que nao consigo ler');
    return linhas.map(function (l) { return l.join(';'); }).join('\n');
  }

  // O CSV exportado usa PONTO como decimal (393.79) e o numeroPuro trata
  // ponto como separador de milhar, virando 39379. Este le no formato do
  // arquivo, nao no formato da tela.
  function numCsv(v) {
    if (v == null || v === '' || v === '-') return null;
    var s = String(v).replace(/[R$\s%]/g, '');
    // se tem virgula E ponto, o ultimo separador manda
    if (s.indexOf(',') >= 0 && s.indexOf('.') >= 0) {
      s = (s.lastIndexOf(',') > s.lastIndexOf('.')) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (s.indexOf(',') >= 0) {
      s = s.replace(',', '.');
    }
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }
  function lerCsvGrupo(txt, nome) {
    /* FORMATO REAL DA SHOPEE, conferido nos arquivos que a Karina exportou:
         linha 1: titulo do relatorio
         linhas 2-6: usuario, loja, ID da loja, data, periodo
         linha 7: vazia
         linha 8: CABECALHO -> #,Nome do Produto,ID do produto,Impressoes,...
       Vale para Grupo de Anuncios e para GMV Max da Loja. */
    txt = String(txt || '').replace(/^\uFEFF/, '');
    var linhas = txt.split(/\r?\n/);
    if (linhas.length < 3) throw new Error('o arquivo parece vazio');

    function partir(linha, sep) {
      var out = [], atual = '', dentro = false;
      for (var i = 0; i < linha.length; i++) {
        var ch = linha[i];
        if (ch === '"') {
          if (dentro && linha[i + 1] === '"') { atual += '"'; i++; }
          else dentro = !dentro;
        } else if (ch === sep && !dentro) { out.push(atual); atual = ''; }
        else atual += ch;
      }
      out.push(atual);
      return out.map(function (x) { return x.trim(); });
    }

    // cabecalho = a linha que tem 'nome do produto' ou 'anuncio'
    var iCab = -1, sep = ',';
    for (var L = 0; L < Math.min(linhas.length, 30); L++) {
      var baixa = linhas[L].toLowerCase();
      if (baixa.indexOf('nome do produto') >= 0 || baixa.indexOf('nome do produto') >= 0 ||
          (baixa.indexOf('an\u00fancio') >= 0 && baixa.indexOf('produto') >= 0) ||
          (baixa.indexOf('id do produto') >= 0)) {
        iCab = L;
        sep = (linhas[L].split(';').length > linhas[L].split(',').length) ? ';' : ',';
        break;
      }
    }
    if (iCab < 0) {
      var amostra = [];
      for (var la = 0; la < Math.min(linhas.length, 8); la++) {
        if (linhas[la].trim()) amostra.push('linha ' + (la + 1) + ': ' + linhas[la].slice(0, 70));
      }
      throw new Error('nao achei a linha de cabecalho. Foi isto que li:\n' + amostra.join('\n'));
    }

    var cab = partir(linhas[iCab], sep).map(function (x) { return x.toLowerCase(); });
    function acha() {
      for (var a = 0; a < arguments.length; a++) {
        for (var i = 0; i < cab.length; i++) if (cab[i].indexOf(arguments[a]) >= 0) return i;
      }
      return -1;
    }
    var iNome = acha('nome do produto', 'an\u00fancio / nome', 'nome do an', 'produto');
    var iId = acha('id do produto', 'id do an');
    var iImpr = acha('impress');
    var iCliq = acha('clique');
    var iCtr = acha('ctr');
    var iConv = acha('convers\u00f5es diretas') >= 0 ? acha('convers\u00f5es') : acha('convers');
    var iGmv = acha('gmv');
    var iDesp = acha('despesa', 'receita de an', 'custo total', 'gasto');
    var iRoas = acha('roas', 'retorno');
    var iStatus = acha('status');
    if (iNome < 0) throw new Error('achei o cabecalho mas nao a coluna de produto. Colunas: ' + cab.slice(0, 8).join(' | '));

    var out = [];
    for (var l = iCab + 1; l < linhas.length; l++) {
      if (!linhas[l].trim()) continue;
      var col = partir(linhas[l], sep);
      if (col.length < 4) continue;
      var nomeP = col[iNome];
      if (!nomeP || /^(total|soma|resumo)/i.test(nomeP)) continue;
      var idP = (iId >= 0 && col[iId] && col[iId] !== '-') ? col[iId] : null;
      out.push({
        nome: nomeP,
        id: idP,
        status: iStatus >= 0 ? col[iStatus] : null,
        impressoes: iImpr >= 0 ? numCsv(col[iImpr]) : null,
        cliques: iCliq >= 0 ? numCsv(col[iCliq]) : null,
        ctr: iCtr >= 0 ? numCsv(col[iCtr]) : null,
        pedidos: iConv >= 0 ? numCsv(col[iConv]) : null,
        gmv: iGmv >= 0 ? numCsv(col[iGmv]) : null,
        gasto: iDesp >= 0 ? numCsv(col[iDesp]) : null,
        roas: iRoas >= 0 ? numCsv(col[iRoas]) : null
      });
    }
    // ROAS derivado quando a coluna nao existe
    for (var q = 0; q < out.length; q++) {
      if (out[q].roas == null && out[q].gasto && out[q].gmv) out[q].roas = out[q].gmv / out[q].gasto;
    }
    if (!out.length) throw new Error('li o cabecalho na linha ' + (iCab + 1) + ' mas nenhuma linha de produto abaixo dele');
    out.sort(function (a, b) { return (b.gasto || 0) - (a.gasto || 0); });
    return { nome: nome, linhas: out, em: Date.now(), linhaCabecalho: iCab + 1 };
  }


  /* ============ PALAVRAS-CHAVE COM VOLUME ============
     A Shopee entrega o volume mensal real de busca de cada termo que ela
     sugere. Cruzando com os titulos dos seus produtos, separa o que voce
     JA USA do que tem gente procurando e voce esta ignorando. */
  /* ============ PALAVRAS — DUAS FUNCOES ============
     1) PESQUISAR: voce escreve um termo e a Shopee devolve o volume dele e
        de termos semelhantes. Nao depende do que voce ja vende.
     2) DA SUA LOJA: os termos que ela sugere para os seus produtos,
        separados entre os que voce ja usa e os que esta ignorando. */
  /* ============ PALAVRAS ============
     A rota list_recommended_keyword NAO aceita busca livre — verificado em
     todas as variantes capturadas: ela so aceita campaign_type e campaign_id,
     e devolve os termos que a Shopee considera relevantes para ESTA loja.
     Pesquisar uma palavra qualquer nunca ia funcionar, entao a funcao de
     busca livre foi removida em vez de continuar frustrando. */
  function renderPalavras() {
    var D = null;
    try { D = window.SIA_Diamantes ? window.SIA_Diamantes.estado() : null; } catch (er) { /* noop */ }
    var K = (D && D.busca && D.busca.keywords) || [];

    if (!K.length) {
      return '<div style="background:color-mix(in srgb,var(--am) var(--tin,9%),var(--b2));border-left:3px solid var(--am);border-radius:0 18px 18px 0;padding:16px">' +
        '<div style="font-size:15px;font-weight:600;color:var(--t0);margin-bottom:5px">Ainda nao li as palavras desta conta</div>' +
        '<div style="font-size:13.5px;color:var(--t1);line-height:1.55">Elas vem da tela de criacao de campanha de Busca de Loja. Se a conta nao tem campanha desse tipo, a Shopee pode nao devolver nada.</div>' +
        '<button id="sia-kw-coletar" style="margin-top:11px;background:var(--mk);border:none;color:#fff;font-family:inherit;font-weight:600;font-size:13px;padding:10px 16px;border-radius:var(--r-btn,14px);cursor:pointer">' +
        (estado.coletaProgresso !== null ? esc(String(estado.coletaProgresso)) : 'Buscar as palavras agora') + '</button></div>';
    }

    var meus = {};
    for (var id in estado.produtos) {
      var nm = estado.produtos[id] && estado.produtos[id].nome;
      if (!nm) continue;
      var pal = espPalavras(nm);
      for (var w in pal) meus[w] = true;
    }
    function usada(termo) {
      var ps = String(termo).toLowerCase().split(/\s+/);
      var achou = 0;
      for (var i = 0; i < ps.length; i++) {
        var lp = ps[i].normalize ? ps[i].normalize('NFD').replace(/[\u0300-\u036f]/g, '') : ps[i];
        if (meus[lp]) achou++;
      }
      return ps.length ? achou / ps.length : 0;
    }
    var usadas = [], perdidas = [];
    for (var k = 0; k < K.length; k++) {
      var t2 = K[k];
      if (!t2.termo || t2.volume == null) continue;
      (usada(t2.termo) >= 0.6 ? usadas : perdidas).push({ t: t2.termo, v: t2.volume });
    }
    perdidas.sort(function (a, b) { return b.v - a.v; });
    usadas.sort(function (a, b) { return b.v - a.v; });
    var somaP = 0;
    for (k = 0; k < Math.min(perdidas.length, 10); k++) somaP += perdidas[k].v;

    var filtro = (estado.buscaPalavra || '').toLowerCase().trim();
    var h = '<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">' +
      '<input id="sia-kw-busca" value="' + esc(estado.buscaPalavra || '') + '" placeholder="filtrar esta lista" ' +
      'style="flex:1;min-width:200px;background:var(--b0);border:1px solid var(--li);border-radius:9px;padding:11px 12px;color:var(--t0);font-size:13.5px"></div>';

    h += '<div class="leitura"><div class="fr">' +
      (perdidas.length ? '<span class="w">' + fmt(somaP, 0) + ' buscas por mes</span> em termos que voce nao usa.'
                       : '<span class="u">Seus titulos cobrem os termos que a Shopee sugere</span>.') +
      '</div><div class="ex">' +
      (perdidas.length ? 'Sao as dez maiores. Nao significa que deve usar todas — significa que ha gente procurando e o seu produto nao aparece.'
                       : 'Nao ha termo relevante de fora. O ganho aqui esta em posicao, nao em palavra nova.') +
      '</div></div>';

    function tab(rot, lista, cor, dicaTxt) {
      var L = filtro ? lista.filter(function (x) { return x.t.toLowerCase().indexOf(filtro) >= 0; }) : lista;
      if (!L.length) return '';
      var s3 = olho(rot, dicaTxt) + '<table><tr><th>TERMO</th><th class="num">BUSCAS/MES</th></tr>';
      for (var q = 0; q < Math.min(L.length, 25); q++) {
        var nl = String(L[q].t).trim().split(/\s+/).length;
        s3 += '<tr><td>' + esc(L[q].t) +
          (nl >= 4 ? ' <span style="font-family:Space Mono,monospace;font-size:9.5px;color:var(--vd);border:1px solid var(--vd);border-radius:99px;padding:1px 7px">cauda longa</span>' : '') +
          '</td><td class="num" style="color:' + cor + '">' + fmt(L[q].v, 0) + '</td></tr>';
      }
      return s3 + '</table>';
    }
    h += tab('TEM GENTE PROCURANDO E VOCE NAO APARECE', perdidas, 'var(--px)',
      '<b>Como e calculado:</b> a Shopee devolve os termos que considera relevantes para a sua loja, com o volume mensal real de cada um. Cruzamos com os titulos dos seus produtos: se menos de 60% das palavras do termo estao neles, ele entra aqui.<br><br><b>Cauda longa</b> (4 palavras ou mais) traz menos gente, mas gente que ja sabe o que quer: converte mais e a disputa e menor.<br><br><b>Regra do metodo:</b> titulo de produto que ja vende nao se mexe.');
    h += tab('TERMOS QUE VOCE JA USA', usadas, 'var(--vd)',
      'Ja aparecem nos seus titulos. O volume mostra o tamanho da disputa: termo grande traz mais gente e mais concorrente.');

    h += '<div class="nota">' + K.length + ' termos lidos da Shopee, com o volume real de buscas no mes. ' +
      '<b>Limitacao:</b> a Shopee nao permite consultar o volume de uma palavra qualquer — ela so devolve os termos que considera relevantes para esta loja.</div>';
    return h;
  }

  function n0(v) { var x = typeof v === 'number' ? v : parseFloat(v); return isFinite(x) ? x : 0; }

  /* ============ RELATORIO SEMANAL ============
     Curto, objetivo e para mandar ao cliente. Le os ultimos 7 dias e a IA
     escreve o panorama sempre citando o produto pelo nome e pelo ID, para o
     cliente conseguir agir sem precisar caçar de qual item se trata. */
  /* ============ CAMPANHAS DE MARKETING ============
     Cupom, Oferta Relampago e Desconto. Alem de listar o que esta no ar e
     quando vence, guarda o mtime de cada uma: a API nao tem log de auditoria,
     entao comparar a ultima alteracao entre leituras e a unica forma de ver
     que o cliente mexeu em algo sem avisar. */
  /* ============ A LEITURA DO 360 ============
     Os numeros da Conta 360 tambem estao no painel da Shopee. O que justifica
     a tela existir e o que fazemos com eles: dizer o que cada um significa
     nesta conta, cruzando uns com os outros, como um consultor faria. */
  /* ============ COMPARACAO AUTOMATICA COM QUEM VENDE MAIS ============
     Antes o card mandava "abra a pagina no celular e compare". Isso e devolver
     trabalho: o Espiao ja sabe buscar a vitrine e trazer preco, avaliacao e
     vendas dos concorrentes. Aqui a comparacao acontece sozinha e o card diz
     o que esta diferente. */
  function compararComVitrine(idProduto) {
    var p = estado.produtos[idProduto];
    if (!p || !p.nome) return;
    estado.comparando = idProduto;
    estado.compResultado = null;
    render();
    var termo = espTermo(p.nome);
    espBuscar(termo, function (resp) {
      estado.comparando = null;
      if (!resp || !resp.ok) {
        estado.compResultado = { id: idProduto, erro: (resp && resp.erro) || 'A busca nao voltou.' };
        render(); return;
      }
      // guarda o cru da ultima busca para o exportador de diagnostico
      try { estado.espiaoCru = { termo: termo, em: Date.now(), itens: (resp.itens || []).slice(0, 5) }; } catch (e) { /* noop */ }
      var lista = espMapear(resp.itens);
      var meu = null, outros = [];
      for (var i = 0; i < lista.length; i++) {
        if (lista[i].eu) meu = lista[i]; else outros.push(lista[i]);
      }
      // Quem NAO tem dado virava zero no ordenador e podia aparecer em
      // primeiro lugar como se nao vendesse nada. Agora quem tem numero vem
      // sempre antes de quem nao tem, e o ranking so promete o que sabe.
      var comDado = outros.filter(function (x) { return x.faturamentoMes != null && x.faturamentoMes > 0; });
      var semDado = outros.filter(function (x) { return !(x.faturamentoMes != null && x.faturamentoMes > 0); });
      comDado.sort(function (a, b) { return b.faturamentoMes - a.faturamentoMes; });
      semDado.sort(function (a, b) { return (a.pos || 99) - (b.pos || 99); });
      outros = comDado.concat(semDado);
      var top3 = outros.slice(0, 3);
      var quantosComDado = comDado.length;
      if (!top3.length) {
        estado.compResultado = { id: idProduto, erro: 'Nao achei concorrentes para "' + termo + '".' };
        render(); return;
      }
      function media(campo) {
        var s = 0, n2 = 0;
        for (var j = 0; j < top3.length; j++) if (top3[j][campo] != null) { s += top3[j][campo]; n2++; }
        return n2 ? s / n2 : null;
      }
      var somaFat = 0, somaUn = 0;
      for (var q3 = 0; q3 < top3.length; q3++) {
        somaFat += top3[q3].faturamentoMes || 0;
        somaUn += top3[q3].vendasMes || 0;
      }
      estado.compResultado = {
        id: idProduto, termo: termo, meu: meu, top3: top3,
        comDado: quantosComDado, total: outros.length,
        precoMedio: media('preco'), avalMedia: media('avaliacoes'),
        notaMedia: media('nota'), vendasMedia: media('vendasMes'),
        fatMedio: media('faturamentoMes'),
        somaFat: somaFat, somaUn: somaUn
      };
      render();
    });
  }

  function renderComparacao(idProduto) {
    if (estado.comparando === idProduto) {
      return '<div class="nota" style="color:var(--mk)">Buscando quem mais vende nesta categoria...</div>';
    }
    var C = estado.compResultado;
    if (!C || C.id !== idProduto) {
      return '<div data-comparar="' + esc(idProduto) + '" style="cursor:pointer;background:var(--b0);border:1px dashed var(--li2);border-radius:16px;padding:13px 15px;margin-top:10px;font-size:13.5px;color:var(--mk);text-align:center">' +
        'Comparar com os 3 que mais vendem nesta busca' + '</div>';
    }
    if (C.erro) return '<div class="nota" style="color:var(--am)">' + esc(C.erro) + '</div>';

    var p = estado.produtos[idProduto] || {};
    var m = p.metricas || {};
    var meuPreco = (C.meu && C.meu.preco) || m.ticket_pedido || (m.vendas_pagas && m.pedidos_pagos ? m.vendas_pagas / m.pedidos_pagos : null);
    var meuAval = (C.meu && C.meu.avaliacoes) || null;
    var meuNota = (C.meu && C.meu.nota) || null;

    var achados = [];
    if (meuPreco && C.precoMedio) {
      var dif = ((meuPreco - C.precoMedio) / C.precoMedio) * 100;
      if (Math.abs(dif) >= 8) {
        achados.push({
          rot: 'PRECO',
          txt: dif > 0
            ? 'Voce cobra ' + reais(meuPreco) + ' e os tres que mais vendem cobram em media ' + reais(C.precoMedio) + ' — ' + fmt(dif, 0) + '% mais caro. Na vitrine o preco aparece antes de qualquer outra coisa.'
            : 'Voce cobra ' + reais(meuPreco) + ' contra ' + reais(C.precoMedio) + ' da media deles — ' + fmt(Math.abs(dif), 0) + '% mais barato. Preco nao e o seu problema aqui.',
          ruim: dif > 0
        });
      }
    }
    if (C.avalMedia) {
      var ma = meuAval || 0;
      if (ma < C.avalMedia * 0.5) {
        achados.push({
          rot: 'AVALIACOES',
          txt: 'Voce tem ' + fmt(ma, 0) + ' avaliacoes e eles tem em media ' + fmt(C.avalMedia, 0) + '. Na duvida entre dois produtos parecidos, o comprador escolhe o que outras pessoas ja aprovaram.',
          ruim: true
        });
      }
    }
    if (meuNota && C.notaMedia && meuNota < C.notaMedia - 0.2) {
      achados.push({
        rot: 'NOTA',
        txt: 'Sua nota e ' + fmt(meuNota, 1) + ' e a media deles e ' + fmt(C.notaMedia, 1) + '. Diferenca de nota pesa mais que diferenca de preco nessa faixa.',
        ruim: true
      });
    }
    var comAds = 0, comCupom = 0, comFrete = 0;
    for (var k = 0; k < C.top3.length; k++) {
      if (C.top3[k].ads) comAds++;
      if (C.top3[k].cupom) comCupom++;
      if (C.top3[k].freteGratis) comFrete++;
    }
    if (comCupom >= 2) achados.push({ rot: 'CUPOM', txt: comCupom + ' dos 3 que mais vendem tem cupom ativo na vitrine. Cupom aparece como selo no card e muda a decisao antes do clique.', ruim: true });
    // A vitrine so marca ADS quando o anuncio aparece como patrocinado NAQUELA
    // posicao da busca. Nao marcar nao prova que o concorrente nao anuncia —
    // eu estava afirmando mais do que o dado permite.
    if (comAds === 0) {
      achados.push({ rot: 'ANUNCIO', txt: 'Nenhum dos tres aparece como patrocinado nesta busca: eles estao ali no organico. Isso nao prova que nao anunciam em outros termos, mas mostra que nesta busca a posicao veio de titulo, preco e avaliacao.', ruim: false });
    } else {
      achados.push({ rot: 'ANUNCIO', txt: comAds + ' de 3 aparecem como patrocinados nesta busca. Voce disputa a mesma posicao pagando.', ruim: false });
    }

    var h = '<div style="background:var(--b1);border:1px solid var(--li);border-radius:18px;padding:14px;margin-top:11px">' +
      '<div style="font-family:Space Mono,monospace;font-size:9.5px;color:var(--t2);letter-spacing:.08em;margin-bottom:10px">O QUE OS 3 QUE MAIS VENDEM FAZEM DIFERENTE</div>';

    if (C.comDado != null && C.comDado < C.top3.length) {
      h += '<div class="nota" style="color:var(--am);margin-bottom:8px">A Shopee informou o volume de ' + C.comDado + ' de ' + C.top3.length +
        ' concorrentes nesta busca. Os sem numero aparecem por ultimo, na ordem em que estao na vitrine.</div>';
    }
    for (var q = 0; q < C.top3.length; q++) {
      var T = C.top3[q];
      h += '<div style="display:flex;align-items:center;gap:9px;padding:7px 0;border-bottom:1px solid var(--li);font-size:12.5px">' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:17px;color:var(--t2);width:18px">' + (q + 1) + '</span>' +
        '<span style="flex:1;min-width:0;color:var(--t1)">' + esc(String(T.nome).slice(0, 40)) + '</span>' +
        '<span style="text-align:right;flex:none">' +
        '<span style="font-family:Space Mono,monospace;font-size:12px;color:var(--t0);display:block">' + espDinheiro(T.faturamentoMes) + '</span>' +
        '<span style="font-family:Space Mono,monospace;font-size:10px;color:var(--vd)">' +
        (T.vendasMes != null ? fmt(T.vendasMes, 0) + ' un' : '\u2014') + ' \u00b7 R$' + fmt(T.preco, 2) + '</span></span>' +
        (T.link ? '<a data-link-externo="1" href="' + esc(T.link) + '" target="_blank" rel="noopener" style="color:var(--mk);text-decoration:none;font-size:15px">\u2197</a>' : '') +
        '</div>';
    }

    // O QUE ELES VENDEM. Sem isto, ver que o preco deles e menor nao diz se
    // esta funcionando: o volume e a prova.
    var meuFat = (C.meu && C.meu.faturamentoMes) || null;
    var meuUn = (C.meu && C.meu.vendasMes) || null;
    if (C.somaFat) {
      h += '<div style="border-top:1px solid var(--li);margin-top:11px;padding-top:12px">' +
        '<div style="font-family:Space Mono,monospace;font-size:9px;color:var(--t2);letter-spacing:.08em;margin-bottom:9px">OS TRES JUNTOS, NOS ULTIMOS 30 DIAS</div>' +
        '<div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:10px">' +
        '<div><div style="font-family:Archivo,Outfit,Arial;font-weight:500;font-size:25px;color:var(--t0);letter-spacing:-.02em">' + espDinheiro(C.somaFat) + '</div>' +
        '<div style="font-family:Space Mono,monospace;font-size:9px;color:var(--t2);margin-top:2px">FATURARAM</div></div>' +
        '<div><div style="font-family:Archivo,Outfit,Arial;font-weight:500;font-size:25px;color:var(--t0);letter-spacing:-.02em">' + fmt(C.somaUn, 0) + '</div>' +
        '<div style="font-family:Space Mono,monospace;font-size:9px;color:var(--t2);margin-top:2px">UNIDADES</div></div>' +
        (meuFat ? '<div><div style="font-family:Archivo,Outfit,Arial;font-weight:500;font-size:25px;color:var(--mk);letter-spacing:-.02em">' + espDinheiro(meuFat) + '</div>' +
          '<div style="font-family:Space Mono,monospace;font-size:9px;color:var(--t2);margin-top:2px">VOCE FATUROU</div></div>' : '') +
        '</div>';
      if (meuFat && C.fatMedio) {
        var razaoF = C.fatMedio / meuFat;
        h += '<div style="font-size:13.5px;color:var(--t1);line-height:1.5">' +
          (razaoF >= 1.5
            ? '<b style="color:var(--t0)">Cada um deles fatura ' + fmt(razaoF, 1) + 'x o que voce fatura</b> nesta busca' +
              (meuUn != null && C.vendasMedia ? ', vendendo ' + fmt(C.vendasMedia / Math.max(meuUn, 1), 1) + 'x mais unidades' : '') + '.'
            : razaoF >= 0.9
              ? 'Voce fatura na mesma faixa deles nesta busca. A disputa aqui e parelha.'
              : '<b style="color:var(--vd)">Voce fatura ' + fmt(1 / razaoF, 1) + 'x mais que a media deles</b> nesta busca.') +
          '</div>';
      }
      h += '</div>';
    }

    if (achados.length) {
      h += '<div style="margin-top:11px">';
      for (q = 0; q < achados.length; q++) {
        h += '<div style="border-left:2px solid ' + (achados[q].ruim ? 'var(--am)' : 'var(--vd)') + ';padding-left:11px;margin-bottom:9px">' +
          '<div style="font-family:Space Mono,monospace;font-size:9px;color:var(--t2);margin-bottom:3px">' + achados[q].rot + '</div>' +
          '<div style="font-size:13.5px;color:var(--t1);line-height:1.5">' + esc(achados[q].txt) + '</div></div>';
      }
      h += '</div>';
    } else {
      h += '<div class="nota">Preco, nota e avaliacoes estao na mesma faixa dos tres. A diferenca deve estar na foto, no titulo ou no tempo de vitrine.</div>';
    }
    // Exportador de diagnostico: baixa o que a Shopee devolveu de verdade,
    // para eu ver onde ela pos o campo de vendas em vez de adivinhar.
    if (estado.espiaoCru) {
      h += '<div style="margin-top:12px;text-align:right">' +
        '<span id="sia-esp-exportar" style="font-family:Space Mono,monospace;font-size:10.5px;color:var(--t3);cursor:pointer;text-decoration:underline">baixar dados brutos desta busca</span></div>';
    }
    return h + '</div>';
  }

  /* ============ ROSCA DO SEMAFORO ============
     O layout tem um grafico de rosca com o total no centro e as quatro
     categorias ao lado. Sem ele o painel vira lista de numeros. */
  function roscaSemaforo(dados, total, rotuloCentro) {
    var raio = 52, esp = 15, circ = 2 * Math.PI * raio;
    var soma = 0;
    for (var i = 0; i < dados.length; i++) soma += dados[i].n || 0;
    if (!soma) return '';
    var offset = 0;
    var svg = '<svg width="150" height="150" viewBox="0 0 150 150" style="flex:none">' +
      '<circle cx="75" cy="75" r="' + raio + '" fill="none" stroke="var(--li)" stroke-width="' + esp + '"/>';
    for (i = 0; i < dados.length; i++) {
      var frac = (dados[i].n || 0) / soma;
      if (!frac) continue;
      var tam = circ * frac;
      svg += '<circle cx="75" cy="75" r="' + raio + '" fill="none" stroke="' + dados[i].cor + '" stroke-width="' + esp + '" ' +
        'stroke-dasharray="' + tam.toFixed(2) + ' ' + (circ - tam).toFixed(2) + '" ' +
        'stroke-dashoffset="' + (-offset).toFixed(2) + '" transform="rotate(-90 75 75)" stroke-linecap="butt"/>';
      offset += tam;
    }
    svg += '<text x="75" y="72" text-anchor="middle" font-family="Archivo,Outfit,Arial" font-weight="500" font-size="30" letter-spacing="-1" fill="var(--t0)">' + fmt(total, 0) + '</text>' +
      '<text x="75" y="90" text-anchor="middle" font-family="Space Mono,monospace" font-size="8.5" letter-spacing="1.4" fill="var(--t2)">' + esc(rotuloCentro || '') + '</text>' +
      '</svg>';

    var legenda = '<div style="flex:1;min-width:200px;display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;align-content:center">';
    for (i = 0; i < dados.length; i++) {
      var d = dados[i];
      legenda += '<div style="display:flex;align-items:center;gap:9px">' +
        '<span style="width:10px;height:10px;border-radius:50%;background:' + d.cor + ';flex:none"></span>' +
        '<span style="font-family:Archivo,Outfit,Arial;font-weight:500;font-size:23px;color:var(--t0);letter-spacing:-.02em">' + fmt(d.n, 0) + '</span>' +
        '<span style="font-size:14px;color:var(--t1)">' + esc(d.rot) + '</span>' +
        (d.delta != null && d.delta !== 0
          ? '<span style="font-family:Space Mono,monospace;font-size:11px;color:' + (d.deltaBom ? 'var(--vd)' : 'var(--rd)') + '">' + (d.delta > 0 ? '\u2191' : '\u2193') + ' ' + Math.abs(d.delta) + '</span>'
          : '') +
        '</div>';
    }
    legenda += '</div>';
    return '<div style="display:flex;align-items:center;gap:22px;flex-wrap:wrap;background:var(--b0);border:1px solid var(--li);border-radius:var(--r-card,22px);padding:20px 22px;margin-bottom:16px">' +
      svg + legenda + '</div>';
  }

  /* Barra horizontal simples, para participacao e comparacoes */
  function barraPct(itens) {
    var max = 0;
    for (var i = 0; i < itens.length; i++) max = Math.max(max, itens[i].v || 0);
    if (!max) return '';
    var h = '<div style="background:var(--b0);border:1px solid var(--li);border-radius:var(--r-card,22px);padding:18px 20px;margin-bottom:16px">';
    for (i = 0; i < itens.length; i++) {
      var it = itens[i], pct = ((it.v || 0) / max) * 100;
      h += '<div style="margin-bottom:' + (i === itens.length - 1 ? 0 : 13) + 'px">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">' +
        '<span style="font-size:14px;color:var(--t1)">' + esc(it.rot) + '</span>' +
        '<span style="font-family:Space Mono,monospace;font-size:13px;color:var(--t0)">' + esc(it.txt) + '</span></div>' +
        '<div style="height:8px;background:var(--b0);border-radius:99px;overflow:hidden">' +
        '<div style="height:100%;width:' + pct.toFixed(1) + '%;background:' + (it.cor || 'var(--mk)') + ';border-radius:99px"></div></div></div>';
    }
    return h + '</div>';
  }

  function leituraDaConta() {
    var D = null;
    try { D = window.SIA_Diamantes ? window.SIA_Diamantes.estado() : null; } catch (e) { return ''; }
    if (!D) return '';
    var g = D.gerenciais || {};
    function v2(x) { return x && x.valor != null ? numeroPuro(x.valor) : (typeof x === 'number' ? x : null); }
    var gmv = v2(g.gmvPago), ped = v2(g.pedidosPagos), uv = v2(g.uv) || v2(g.visitantes);
    var pv = v2(g.pv), ticket = v2(g.ticketMedio);
    if (!gmv && !ped && !uv) return '';
    if (!ticket && gmv && ped) ticket = gmv / ped;
    var conv = (ped && uv) ? (ped / uv) * 100 : null;
    var pagPorVisita = (pv && uv) ? pv / uv : null;

    // Ads e afiliados para cruzar
    var gastoAds = 0, gmvAds = 0;
    for (var k in estado.campanhas) {
      var m = estado.campanhas[k].metricas || {};
      gastoAds += m.gasto || 0;
      if (m.gasto && m.roas) gmvAds += m.gasto * m.roas;
    }
    var AF = (D.afiliados && D.afiliados.resumo) || {};
    var gmvAf = numeroPuro(AF.vendas) || 0;



    var itens = [];

    // ---- ADS ----
    // CORRECAO IMPORTANTE: eu somava gasto x ROAS de cada campanha e chamava
    // isso de "GMV de Ads", comparando com o faturamento da loja. Nao da: o
    // broad_roi da Shopee conta venda AMPLA, que inclui compra de outros
    // produtos e venda que aconteceria de qualquer jeito. Somado, passa de
    // 100% do faturamento real — foi o que produziu "Ads responde por 215%".
    // Agora o retorno de Ads e apresentado como o que e: uma metrica DA
    // Shopee sobre as campanhas, nunca como fatia do faturamento da loja.
    if (gastoAds) {
      var roasGeral = gmvAds / gastoAds;
      var margemC = margemMediaCofre();
      var pisoC = margemC ? 100 / margemC : null;
      var pedAds = 0;
      for (var kp in estado.campanhas) pedAds += (estado.campanhas[kp].metricas || {}).pedidos || 0;
      var cpaGeral = pedAds ? gastoAds / pedAds : null;
      var nCamp = Object.keys(estado.campanhas).length;

      var txtAds = 'Somando as ' + nCamp + ' campanhas lidas: ' + reais(gastoAds) + ' investidos e retorno medio de ' + fmt(roasGeral, 1) + 'x pela conta da Shopee.';
      if (pisoC) {
        txtAds += roasGeral >= pisoC
          ? ' Seu ponto de equilibrio e ' + fmt(pisoC, 1) + 'x, entao no conjunto o anuncio esta pagando.'
          : ' Seu ponto de equilibrio e ' + fmt(pisoC, 1) + 'x — no conjunto, o anuncio esta abaixo dele.';
      } else {
        txtAds += ' Cadastre o custo dos produtos para eu dizer se esse retorno cobre a sua margem.';
      }
      if (cpaGeral && ticket) {
        txtAds += ' Cada pedido por anuncio custou ' + reais(cpaGeral) + ', contra um ticket de ' + reais(ticket) +
          (cpaGeral > ticket * 0.4 ? ' — ou seja, o anuncio consome mais de 40% do valor da venda.' : '.');
      }
      txtAds += ' Este retorno e o que a Shopee chama de venda ampla: inclui compra de outros produtos da loja na mesma visita, entao nao da para somar com o faturamento total nem tirar percentual dele.';
      itens.push({
        rot: 'O QUE O ANUNCIO DEVOLVEU',
        txt: txtAds,
        nivel: (pisoC && roasGeral < pisoC) ? 'amarelo' : 'verde'
      });

      // TACOS so faz sentido com gasto e GMV do MESMO periodo
      if (gmv && gastoAds) {
        var tacosReal = (gastoAds / gmv) * 100;
        if (tacosReal <= 100) {
          itens.push({
            rot: 'QUANTO DA RECEITA VAI PARA ANUNCIO',
            txt: fmt(tacosReal, 1) + '% de tudo que a loja faturou foi para Ads. ' +
              (tacosReal > 10 ? 'Acima de 10% ja corroi margem no metodo da casa: confira se o retorno cobre o seu ponto de equilibrio antes de manter esse ritmo.'
               : tacosReal < 5 ? 'Ha espaco para investir mais nas campanhas que ja entregam acima do seu equilibrio.'
               : 'Dentro da faixa de trabalho, ate 10%.'),
            nivel: tacosReal > 10 ? 'amarelo' : 'verde'
          });
        } else {
          // gasto maior que o faturamento: quase sempre recorte diferente
          itens.push({
            rot: 'ATENCAO NA LEITURA DE ADS',
            txt: 'O investimento lido (' + reais(gastoAds) + ') e maior que o faturamento do periodo (' + reais(gmv) + '). ' +
              'Isso normalmente significa que as campanhas foram lidas num recorte de datas diferente do resto da conta — e nao que a loja gastou mais do que vendeu. ' +
              'Selecione o mesmo periodo em Informacoes Gerenciais e em Shopee Ads antes de comparar os dois.',
            nivel: 'amarelo'
          });
        }
      }
    } else if (Object.keys(estado.campanhas).length) {
      itens.push({
        rot: 'O QUE O ANUNCIO DEVOLVEU',
        txt: 'Ha ' + Object.keys(estado.campanhas).length + ' campanhas cadastradas e nenhum investimento no periodo lido. Ou estao pausadas, ou sem saldo, ou o recorte de datas nao pegou o gasto.',
        nivel: 'amarelo'
      });
    }

    // 3) conversao contra o funil
    if (conv != null) {
      itens.push({
        rot: 'O QUE ACONTECE COM QUEM ENTRA',
        txt: 'De cada 100 visitantes, ' + fmt(conv, 1) + ' compram.' +
          (pagPorVisita ? ' Cada visitante ve ' + fmt(pagPorVisita, 1) + ' paginas' +
            (pagPorVisita < 2 ? ', o que e pouco: quem chega ve um produto e sai, sem passear pelo catalogo. Produto relacionado e combo sao o caminho para segurar a visita.'
             : pagPorVisita < 3 ? ', dentro do esperado para marketplace.'
             : ', o que e bom: quem entra circula pelo catalogo.') : '') +
          (conv < 1 ? ' Conversao abaixo de 1% costuma ser preco, foto ou avaliacao — nao falta de trafego.' : ''),
        nivel: conv < 1 ? 'amarelo' : 'verde'
      });
    }

    // 4) ticket
    if (ticket) {
      itens.push({
        rot: 'O TAMANHO DE CADA VENDA',
        txt: 'Ticket medio de ' + reais(ticket) + '.' +
          (ticket < 30
            ? ' Abaixo de R$ 30 a comissao pesa muito: a Shopee cobra 20% + R$ 4 nessa faixa, o que consome ' + fmt(((ticket * 0.2 + 4) / ticket) * 100, 0) + '% do preco. Combo ou kit acima de R$ 80 cai para 14% + R$ 16.'
            : ticket > 100
              ? ' Ticket alto costuma converter menos, mas cada venda sustenta um CPA maior — vale aceitar custo por pedido acima da media aqui.'
              : ' Faixa em que a comissao ja e mais leve que nos produtos baratos.'),
        nivel: ticket < 30 ? 'amarelo' : 'verde'
      });
    }

    // 5) afiliados contra ads
    if (gmvAf && gmv) {
      var partAf = (gmvAf / gmv) * 100;
      itens.push({
        rot: 'O CANAL DE AFILIADOS',
        txt: partAf >= 10
          ? 'Afiliados trazem ' + fmt(partAf, 0) + '% do faturamento e so cobram quando vendem. E o canal de menor risco da conta.'
          : 'Afiliados respondem por ' + fmt(partAf, 1) + '% do faturamento. Como so ha custo quando ha venda, ampliar aqui nao arrisca verba.',
        nivel: 'verde'
      });
    }

    if (!itens.length) return '';
    var h = olho('O QUE ESTES NUMEROS DIZEM', 'Os numeros acima tambem estao no painel da Shopee. O que muda aqui e a leitura: cada um cruzado com os outros, dizendo o que significa nesta conta especifica.');
    for (var i = 0; i < itens.length; i++) {
      var it = itens[i];
      var cor = it.nivel === 'amarelo' ? 'var(--am)' : 'var(--vd)';
      h += '<div style="border-left:3px solid ' + cor + ';background:color-mix(in srgb,' + cor + ' var(--tin,7%),var(--b2));border-radius:0 16px 16px 0;padding:13px 15px;margin-bottom:9px">' +
        '<div style="font-family:Space Mono,monospace;font-size:9.5px;color:var(--t2);letter-spacing:.07em;margin-bottom:5px">' + it.rot + '</div>' +
        '<div style="font-size:14.5px;color:var(--t1);line-height:1.55">' + esc(it.txt) + '</div></div>';
    }
    return h;
  }

  function renderMarketing() {
    var D = null;
    try { D = window.SIA_Diamantes ? window.SIA_Diamantes.estado() : null; } catch (e) { /* noop */ }
    var M = D && D.marketing;
    if (!M) return '<div class="nota" style="color:var(--am)">Ainda nao li as campanhas de marketing. Elas vem na coleta da conta.</div>';

    var agora = Math.floor(Date.now() / 1000);
    function dataBr(ts) {
      if (!ts) return '\u2014';
      var x = new Date(ts * 1000);
      return String(x.getUTCDate()).padStart(2, '0') + '/' + String(x.getUTCMonth() + 1).padStart(2, '0');
    }
    function venceEm(fim) {
      if (!fim) return null;
      var dias = Math.floor((fim - agora) / 86400);
      return dias;
    }

    var h = '';
    var todas = [].concat(
      (M.cupons || []).map(function (x) { return { t: 'Cupom', d: x }; }),
      (M.relampago || []).map(function (x) { return { t: 'Oferta Relampago', d: x }; }),
      (M.descontos || []).map(function (x) { return { t: 'Desconto', d: x }; })
    );

    // ---- ALTERACOES RECENTES ----
    var mexidas = todas.filter(function (x) {
      return x.d.alteradoEm && (agora - x.d.alteradoEm) < 7 * 86400;
    }).sort(function (a, b) { return b.d.alteradoEm - a.d.alteradoEm; });

    if (mexidas.length) {
      h += olho('MEXERAM NISTO NOS ULTIMOS 7 DIAS', 'A Shopee nao guarda quem alterou, mas guarda QUANDO: o campo de ultima alteracao de cada campanha. Aqui aparecem as que mudaram na ultima semana \u2014 util quando o cliente mexe sem avisar e o resultado muda sem explicacao aparente.');
      for (var mi = 0; mi < Math.min(mexidas.length, 8); mi++) {
        var X = mexidas[mi].d;
        var qdo = new Date(X.alteradoEm * 1000);
        h += '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--li);font-size:13.5px">' +
          '<span style="font-family:Space Mono,monospace;font-size:10px;color:var(--am);flex:none;width:74px">' +
          String(qdo.getUTCDate()).padStart(2, '0') + '/' + String(qdo.getUTCMonth() + 1).padStart(2, '0') + ' ' +
          String(qdo.getUTCHours()).padStart(2, '0') + 'h' + String(qdo.getUTCMinutes()).padStart(2, '0') + '</span>' +
          '<span style="flex:1;color:var(--t1)"><b style="color:var(--t0)">' + esc(mexidas[mi].t) + '</b> ' + esc(X.nome || X.codigo || ('#' + X.id)) + '</span>' +
          '<span style="font-family:Space Mono,monospace;font-size:10.5px;color:' + (X.ativo ? 'var(--vd)' : 'var(--t3)') + ';flex:none">' + (X.ativo ? 'ativo' : 'inativo') + '</span></div>';
      }
    }

    // ---- O QUE ESTA NO AR ----
    var ativas = todas.filter(function (x) { return x.d.ativo && (!x.d.fim || x.d.fim > agora); });
    var vencendo = ativas.filter(function (x) { var v = venceEm(x.d.fim); return v != null && v <= 7; });

    h += olho('O QUE ESTA NO AR AGORA (' + ativas.length + ')', 'Cupom, Oferta Relampago e Desconto ativos, com a data em que cada um termina. Campanha que vence sem substituta deixa buraco: o preco volta ao cheio e a conversao cai sem ninguem perceber.');
    if (vencendo.length) {
      h += '<div style="background:color-mix(in srgb,var(--am) var(--tin,9%),var(--b2));border-left:3px solid var(--am);border-radius:0 16px 16px 0;padding:13px 15px;margin-bottom:11px;font-size:13.5px;color:var(--t1);line-height:1.55">' +
        '<b style="color:var(--t0)">' + vencendo.length + ' ' + (vencendo.length > 1 ? 'campanhas vencem' : 'campanha vence') + ' em ate 7 dias.</b> ' +
        'Sem renovar, o preco volta ao cheio e a conversao cai sem aviso.</div>';
    }
    if (!ativas.length) {
      h += '<div class="nota">Nenhuma campanha de marketing ativa. A conta esta vendendo so no preco cheio.</div>';
    } else {
      h += '<table><tr><th>TIPO</th><th>NOME</th><th class="num">TERMINA</th><th class="num">USO</th></tr>';
      for (var ai = 0; ai < ativas.length; ai++) {
        var A = ativas[ai].d, dv = venceEm(A.fim);
        var corV = dv != null && dv <= 3 ? 'var(--rd)' : (dv != null && dv <= 7 ? 'var(--am)' : 'var(--t1)');
        h += '<tr><td>' + esc(ativas[ai].t) + '</td>' +
          '<td>' + sig(String(A.nome || A.codigo || ('#' + A.id)).slice(0, 34)) +
          (A.desconto ? ' <span style="font-family:Space Mono,monospace;font-size:10px;color:var(--t3)">' + fmt(A.desconto, 0) + '%</span>' : '') +
          (A.itens ? ' <span style="font-family:Space Mono,monospace;font-size:10px;color:var(--t3)">' + A.itens + ' itens</span>' : '') + '</td>' +
          '<td class="num" style="color:' + corV + '">' + dataBr(A.fim) + (dv != null && dv <= 7 ? ' (' + (dv <= 0 ? 'hoje' : dv + 'd') + ')' : '') + '</td>' +
          '<td class="num">' + (A.usados != null ? fmt(A.usados, 0) + (A.limite ? '/' + fmt(A.limite, 0) : '') : '\u2014') + '</td></tr>';
      }
      h += '</table>';
    }

    // ---- CAMPANHAS DA SHOPEE ----
    var of = M.oficiais || [];
    var abertas = of.filter(function (c) { return c.fim && c.fim > agora; });
    if (abertas.length) {
      var semInscricao = abertas.filter(function (c) { return !c.inscritos; });
      // CORRECAO: eu tinha escrito que participar "nao custa verba de anuncio",
      // como se fosse alcance gratuito. A Karina corrigiu: a campanha cobra
      // 3,5% sobre TODAS as vendas da loja no periodo, nao so sobre as vendas
      // vindas dela. Isso muda a conta inteira e nao da para recomendar
      // entrada sem confrontar com a margem.
      var margemMkt = margemMediaCofre();
      h += olho('CAMPANHA DE DESTAQUE SHOPEE (' + abertas.length + ')', '<b>A Campanha de Destaque Shopee nao e gratuita.</b> A Shopee cobra um percentual sobre as vendas da loja no periodo da campanha \u2014 normalmente 3,5%, e sobre TODAS as vendas, nao apenas as que vieram dela. Em troca, o produto entra em vitrine que a loja nao alcanca sozinha.<br><br><b>A conta que decide:</b> o ganho de alcance precisa cobrir o percentual cobrado sobre o faturamento inteiro. Loja de margem apertada raramente compensa.');
      h += '<div style="background:color-mix(in srgb,var(--am) var(--tin,9%),var(--b2));border-left:3px solid var(--am);border-radius:0 16px 16px 0;padding:13px 15px;margin-bottom:11px;font-size:13.5px;color:var(--t1);line-height:1.55">' +
        '<b style="color:var(--t0)">Antes de entrar, faca a conta.</b> A taxa costuma ser de 3,5% sobre todo o faturamento do periodo. ' +
        (margemMkt
          ? 'Com a sua margem de ' + fmt(margemMkt, 0) + '%, isso consome <b style="color:var(--t0)">' + fmt((3.5 / margemMkt) * 100, 0) + '% do que sobra</b> em cada venda \u2014 inclusive nas que voce faria de qualquer jeito.'
          : 'Cadastre o custo dos produtos para eu calcular quanto isso consome da sua margem.') +
        ' So compensa se o alcance extra trouxer venda nova acima disso.</div>';
      h += '<table><tr><th>CAMPANHA</th><th class="num">TERMINA</th><th class="num">PRODUTOS</th></tr>';
      for (var oi = 0; oi < Math.min(abertas.length, 8); oi++) {
        var O = abertas[oi];
        h += '<tr><td>' + esc(String(O.nome).slice(0, 42)) + '</td>' +
          '<td class="num">' + dataBr(O.fim) + '</td>' +
          '<td class="num" style="color:' + (O.inscritos ? 'var(--vd)' : 'var(--px)') + '">' + (O.inscritos || 'nenhum') + '</td></tr>';
      }
      h += '</table>';
    }

    // ---- RETORNO DE CADA FERRAMENTA ----
    var R3 = M.retorno || {};
    var temRet = Object.keys(R3).some(function (k) { return R3[k] && R3[k].vendas; });
    if (temRet) {
      h += olho('QUANTO CADA FERRAMENTA DEVOLVEU', 'Vendas atribuidas a cada ferramenta no periodo lido, com a variacao contra o periodo anterior. Serve para saber onde vale insistir: ferramenta que nao devolve nada esta so ocupando espaco na gestao.');
      h += '<table><tr><th>FERRAMENTA</th><th class="num">VENDAS</th><th class="num">PEDIDOS</th><th class="num">VARIACAO</th></tr>';
      var ROT_F = { desconto: 'Desconto', cupom: 'Cupom', combo: 'Combo', geral: 'Geral' };
      for (var rk in R3) {
        var F = R3[rk];
        if (!F || (!F.vendas && !F.pedidos)) continue;
        h += '<tr><td>' + (ROT_F[rk] || rk) + '</td>' +
          '<td class="num">' + (F.vendas != null ? reais(F.vendas) : '\u2014') + '</td>' +
          '<td class="num">' + (F.pedidos != null ? fmt(F.pedidos, 0) : '\u2014') + '</td>' +
          '<td class="num" style="color:' + (F.varVendas > 0 ? 'var(--vd)' : (F.varVendas < 0 ? 'var(--rd)' : 'var(--t2)')) + '">' +
          (F.varVendas != null ? (F.varVendas >= 0 ? '+' : '') + fmt(F.varVendas, 0) + '%' : '\u2014') + '</td></tr>';
      }
      h += '</table>';
    }

    // ---- FERRAMENTAS LIBERADAS E NAO USADAS ----
    var L2 = M.liberadas;
    if (L2) {
      var usadas2 = {
        cupom: (M.cupons || []).some(function (x) { return x.ativo; }),
        relampagoLoja: (M.relampago || []).some(function (x) { return x.ativo; }),
        desconto: (M.descontos || []).some(function (x) { return x.ativo; })
      };
      var ROT_L = {
        relampagoLoja: 'Oferta Relampago da Loja', desconto: 'Desconto de produto', cupom: 'Cupom da loja',
        combo: 'Leve Mais por Menos', compreJunto: 'Compre Junto', premioSeguidor: 'Premio de seguidor',
        jogoDaLoja: 'Jogo da loja', campanhaShopee: 'Campanhas da Shopee', freteSubsidiado: 'Frete subsidiado'
      };
      var ociosas = [];
      for (var lk in ROT_L) {
        if (L2[lk] && !usadas2[lk]) ociosas.push(ROT_L[lk]);
      }
      if (ociosas.length) {
        h += olho('LIBERADAS E SEM USO (' + ociosas.length + ')', 'Ferramentas que a Shopee habilitou para esta conta e que nao tem nada ativo. Nao significa que todas devam ser ligadas \u2014 significa que estao disponiveis e nao custam verba de anuncio.');
        h += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
        for (var oc = 0; oc < ociosas.length; oc++) {
          h += '<span style="font-family:Space Mono,monospace;font-size:11px;padding:6px 11px;border-radius:99px;border:1px solid var(--li2);color:var(--t2)">' + esc(ociosas[oc]) + '</span>';
        }
        h += '</div>';
      }
    }

    // cupom criado e nao usado
    var parados = (M.cupons || []).filter(function (c) { return c.ativo && (c.usados || 0) === 0 && c.criadoEm && (agora - c.criadoEm) > 7 * 86400; });
    if (parados.length) {
      h += '<div class="nota" style="color:var(--am)"><b>' + parados.length + ' cupom(ns) ativo(s) ha mais de 7 dias sem nenhum uso.</b> Ou nao esta visivel na pagina, ou o valor minimo esta acima do ticket da loja.</div>';
    }
    return h;
  }

  /* Barra de progresso com o que o consultor esta fazendo agora. Contar
     caracteres nao diz nada a quem espera; dizer a etapa, sim. */
  var ETAPAS_REL = [
    'Lendo as informacoes gerenciais',
    'Lendo o funil de vendas',
    'Lendo os produtos',
    'Lendo as campanhas de Ads',
    'Cruzando os dois periodos',
    'O consultor esta analisando a conta',
    'Escrevendo o diagnostico',
    'Analisando Ads e produtos',
    'Montando o plano de 30 dias'
  ];
  function renderProgresso(etapaAtual, pct) {
    var p2 = Math.max(3, Math.min(100, pct || 0));
    return '<div style="background:var(--b0);border:1px solid var(--li);border-radius:18px;padding:16px;margin-top:12px">' +
      '<div style="display:flex;align-items:center;gap:9px;margin-bottom:10px">' +
      '<span style="width:9px;height:9px;border-radius:50%;background:var(--mk);display:inline-block"></span>' +
      '<b style="font-size:14.5px;color:var(--t0)">' + esc(etapaAtual || 'Trabalhando...') + '</b></div>' +
      '<div style="height:6px;background:var(--b1);border-radius:99px;overflow:hidden">' +
      '<div style="height:100%;width:' + p2 + '%;background:linear-gradient(90deg,var(--mk),var(--px));border-radius:99px;transition:width .4s"></div></div>' +
      '<div style="font-size:12.5px;color:var(--t2);margin-top:8px;line-height:1.5">Sao duas leituras completas da conta mais a analise. Pode deixar a gaveta aberta e continuar navegando.</div></div>';
  }

  function renderSemanal() {
    var S = estado.semanal || {};
    var gg = null;
    try { gg = window.SIA_Diamantes ? window.SIA_Diamantes.estado().gerenciais : null; } catch (e) { /* noop */ }

    var h = '<div style="font-size:15px;color:var(--t1);line-height:1.6;margin-bottom:16px">' +
      'Panorama curto dos ultimos 7 dias, com a leitura do especialista produto a produto. Feito para mandar ao cliente.</div>';

    // aviso do periodo — a leitura herda o painel
    var dias = gg && gg.periodoDias;
    var certo = dias != null && dias >= 6 && dias <= 8;
    h += '<div style="background:color-mix(in srgb,' + (certo ? 'var(--vd)' : 'var(--am)') + ' var(--tin,9%),var(--b2));border-left:3px solid ' + (certo ? 'var(--vd)' : 'var(--am)') + ';border-radius:0 18px 18px 0;padding:14px 15px;margin-bottom:14px;font-size:13.5px;color:var(--t1);line-height:1.55">' +
      (certo
        ? '<b style="color:var(--t0)">Periodo certo.</b> A leitura atual cobre ' + dias + ' dias.'
        : '<b style="color:var(--t0)">Antes de gerar, ajuste o painel.</b> Va em <b>Informacoes Gerenciais</b> da Shopee e selecione <b>Ultimos 7 dias</b>, depois colete a conta. ' +
          (dias != null ? 'A leitura atual e de ' + dias + ' dias.' : 'Ainda nao identifiquei o periodo lido.')) +
      '</div>';

    if (S.pedirChave && !chaveSupabase()) h += renderPedirChave();
    if (S.erro) {
      h += '<div style="background:color-mix(in srgb,var(--rd) var(--tin,9%),var(--b2));border-left:3px solid var(--rd);border-radius:0 16px 16px 0;padding:14px;margin-bottom:12px;font-size:14px;color:var(--t1);line-height:1.55">' + esc(S.erro) + '</div>';
    }

    if (S.gerando) { h += renderProgresso(S.etapa, S.pct); }
    else {
      h += '<button id="sia-sem-gerar" style="width:100%;background:var(--mk);border:none;color:#fff;font-family:inherit;font-weight:700;font-size:15px;padding:15px;border-radius:16px;cursor:pointer">Gerar panorama da semana</button>';
    }

    if (S.markdown) {
      h += '<div style="display:flex;gap:8px;margin:14px 0 10px;flex-wrap:wrap">' +
        '<button id="sia-sem-pdf" style="background:var(--mk);border:none;color:#fff;font-family:inherit;font-weight:600;font-size:13.5px;padding:11px 18px;border-radius:var(--r-btn,14px);cursor:pointer">Salvar em PDF</button>' +
        '<button id="sia-sem-novo" style="background:var(--b0);border:1px solid var(--li2);color:var(--t1);font-family:inherit;font-size:13px;padding:11px 16px;border-radius:var(--r-btn,14px);cursor:pointer">Gerar de novo</button></div>';
      h += '<div style="background:var(--b0);border:1px solid var(--li);border-radius:18px;padding:18px;font-size:14.5px;color:var(--t1);line-height:1.65">' + mdParaHtml(S.markdown) + '</div>';
    }
    return h;
  }

  function chaveSupabase() { return estado.anonKey || SIA_ANON_KEY || ''; }
  function cabecalhosFuncao() {
    var h2 = { 'Content-Type': 'application/json' };
    var k = chaveSupabase();
    if (k) { h2['Authorization'] = 'Bearer ' + k; h2['apikey'] = k; }
    return h2;
  }
  function renderPedirChave() {
    return '<div style="background:color-mix(in srgb,var(--am) var(--tin,9%),var(--b2));border-left:3px solid var(--am);border-radius:0 18px 18px 0;padding:16px;margin-bottom:14px">' +
      '<div style="font-size:15px;font-weight:600;color:var(--t0);margin-bottom:6px">Falta a chave do Supabase</div>' +
      '<div style="font-size:13.5px;color:var(--t1);line-height:1.55;margin-bottom:10px">' +
      'O relatorio e o panorama semanal falam com a sua funcao no Supabase, e ela precisa da chave publica do projeto para aceitar a chamada. ' +
      'Pegue em <b>Supabase &rsaquo; Project Settings &rsaquo; API &rsaquo; anon public</b> e cole aqui. Fica salva neste navegador.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<input id="sia-anon" type="password" value="' + esc(estado.anonKey || '') + '" placeholder="cole a anon public key" ' +
      'style="flex:1;min-width:200px;background:var(--b1);border:1px solid var(--li);border-radius:8px;padding:11px 12px;color:var(--t0);font-family:Space Mono,monospace;font-size:12px">' +
      '<button id="sia-anon-salvar" style="background:var(--mk);border:none;color:#fff;font-family:inherit;font-weight:600;font-size:13px;padding:11px 18px;border-radius:var(--r-btn,14px);cursor:pointer">Salvar</button></div></div>';
  }
  function gerarSemanal() {
    estado.semanal = estado.semanal || {};
    if (estado.semanal.gerando) return;
    var nP = Object.keys(estado.produtos).length;
    if (!nP) { estado.semanal.erro = 'Colete a conta antes de gerar o panorama.'; render(); return; }

    estado.semanal.gerando = true;
    estado.semanal.erro = null;
    estado.semanal.etapa = 'Lendo os numeros da conta';
    estado.semanal.pct = 20;
    render();

    var bloco = blocoPeriodo('ultimos 7 dias');
    var payload = {
      loja: estado.loja ? estado.loja.shop_id : null,
      loja_nome: estado.loja ? estado.loja.nome : null,
      margemMediaPct: margemMediaCofre(),
      semanal: true,
      atual: bloco
    };

    estado.semanal.etapa = 'O consultor esta analisando a semana';
    estado.semanal.pct = 55;
    render();

    fetch(SIA_URL_RELATORIO, {
      method: 'POST',
      // A chave so vai junto quando existir: com Verify JWT desligado na
      // funcao, ela nao e necessaria, e mandar cabecalho vazio atrapalha.
      headers: cabecalhosFuncao(),
      body: JSON.stringify(payload)
    }).then(function (r) {
      var ct = r.headers.get('content-type') || '';
      if (r.ok && ct.indexOf('text/plain') >= 0 && r.body) {
        var reader = r.body.getReader(), dec = new TextDecoder(), acc = '';
        function ler() {
          return reader.read().then(function (res) {
            if (res.done) {
              estado.semanal.gerando = false;
              estado.semanal.markdown = acc;
              render();
              return;
            }
            acc += dec.decode(res.value, { stream: true });
            estado.semanal.pct = Math.min(97, (estado.semanal.pct || 55) + 0.6);
            estado.sujo = true;
            return ler();
          });
        }
        return ler();
      }
      return r.text().then(function (txt) {
        estado.semanal.gerando = false;
        var j = null; try { j = JSON.parse(txt); } catch (e) { /* noop */ }
        estado.semanal.erro = (j && (j.erro || j.detalhe)) || ('A funcao respondeu HTTP ' + r.status);
        render();
      });
    }).catch(function (e) {
      estado.semanal.gerando = false;
      // "Failed to fetch" com CORS quase sempre e 401 do gateway do Supabase,
      // que responde ANTES da funcao e sem os headers dela.
      estado.semanal.erro = 'Nao consegui alcancar a funcao. ' +
        (chaveSupabase()
          ? 'A chave foi enviada, entao o mais provavel e que a funcao esteja exigindo autenticacao do gateway. No Supabase, abra Edge Functions, clique em relatorio, e desligue "Verify JWT with legacy secret" (ou Enforce JWT). Depois publique de novo.'
          : 'Cole a chave anon do projeto no campo acima.') +
        ' Detalhe tecnico: ' + String(e && e.message || e);
      render();
    });
  }

  function renderRelatorio() {
    var R = estado.rel;
    var h = capa('DIAGNOSTICO COMPLETO', 'O', 'RELATORIO', '06');

    if (R.markdown) {
      h += '<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">' +
        '<button id="sia-rel-pdf" style="background:var(--mk);border:none;color:#fff;font-family:inherit;font-weight:600;font-size:13.5px;padding:11px 18px;border-radius:var(--r-btn,14px);cursor:pointer">Salvar em PDF</button>' +
        '<button id="sia-rel-copiar" style="background:var(--b0);border:1px solid var(--li);color:var(--t1);font-family:inherit;font-size:13.5px;padding:11px 16px;border-radius:var(--r-btn,14px);cursor:pointer">Copiar texto</button>' +
        '<button id="sia-rel-novo" style="background:var(--b0);border:1px solid var(--li);color:var(--t1);font-family:inherit;font-size:13.5px;padding:11px 16px;border-radius:var(--r-btn,14px);cursor:pointer">Gerar outro</button></div>';
      h += '<div id="sia-rel-corpo" style="background:var(--b0);border:1px solid var(--li);border-radius:18px;padding:18px;font-size:14px;line-height:1.65;color:var(--t1);max-height:62vh;overflow:auto">' + mdParaHtml(R.markdown) + '</div>';
      return h;
    }

    var meses = mesesDisponiveis();
    var sel = R.mes || meses[1].v;
    var fa = faixaDoMes(sel), fp = faixaDoMes(mesAnterior(sel));

    h += '<div class="leitura"><div class="fr">Relatorio completo da conta.</div>' +
      '<div class="ex">Compara o mes escolhido com o anterior e devolve o diagnostico no formato dos seus relatorios, com plano tatico de 30 dias e projecao com lucro.</div></div>';

    h += olho('MES DO RELATORIO');
    h += '<select id="sia-rel-mes" style="width:100%;background:var(--b0);border:1px solid var(--li);border-radius:9px;padding:12px;color:var(--t0);font-family:inherit;font-size:14px;margin-bottom:10px">';
    for (var i = 0; i < meses.length; i++) h += '<option value="' + meses[i].v + '"' + (meses[i].v === sel ? ' selected' : '') + '>' + meses[i].r + '</option>';
    h += '</select>';
    h += '<div class="nota">Atual: <b>' + fa.rotulo + '</b><br>Anterior: <b>' + fp.rotulo + '</b></div>';

    // O relatorio coleta os dois meses sozinho, entao exigir coleta previa era
    // contraditorio — e pior: escondia o botao, e a pessoa clicava num lugar
    // onde nao havia botao nenhum e nada acontecia.

    h += '<div style="background:var(--b0);border-left:3px solid var(--vd);border-radius:0 16px 16px 0;padding:13px 15px;margin:14px 0;font-size:13.5px;color:var(--t1);line-height:1.55">' +
      '<b style="color:var(--t0)">A coleta e automatica.</b> Ao gerar, a Seller.IA le os dois meses direto da Shopee, um de cada vez, sem voce precisar trocar nada no painel. ' +
      'Leva alguns minutos porque sao duas leituras completas da conta.</div>';

    h += '<button id="sia-rel-gerar" ' +
      'style="width:100%;background:var(--mk);border:none;color:#fff;font-family:inherit;font-weight:700;font-size:15px;padding:15px;border-radius:16px;cursor:pointer' + (R.gerando ? ';opacity:.6' : '') + '">' +
      (R.gerando ? 'Cancelar (' + esc(R.etapa || 'trabalhando') + ')' : 'Gerar relatorio') + '</button>';
    if (R.erro) h += '<div style="background:color-mix(in srgb,var(--rd) var(--tin,9%),var(--b2));border-left:3px solid var(--rd);border-radius:0 16px 16px 0;padding:12px 14px;margin-top:11px;font-size:13.5px;color:var(--t1);line-height:1.55">' + esc(R.erro) + '</div>';
    if (R.gerando) h += renderProgresso(R.etapa, R.pct);
    return h;
  }
  function mdParaHtml(md) {
    var s = esc(md);
    s = s.replace(/^#### (.*)$/gm, '<div style="font-size:13px;font-weight:600;color:var(--t0);margin:10px 0 3px">$1</div>');
    s = s.replace(/^### (.*)$/gm, '<div style="font-size:15px;font-weight:600;color:var(--t0);margin:13px 0 4px">$1</div>');
    s = s.replace(/^## (.*)$/gm, '<div style="font-family:Bebas Neue,sans-serif;font-size:21px;color:var(--t0);margin:16px 0 5px;letter-spacing:.02em">$1</div>');
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
    s = s.replace(/\n{2,}/g, '<div style="height:5px"></div>');
    return s;
  }
  function gerarRelatorio() {
    // Se ja esta gerando, o clique vira CANCELAR. Antes o botao ficava
    // disabled — e botao disabled nao propaga clique no shadow DOM, entao
    // um estado preso deixava o botao morto sem a pessoa ter como sair.
    if (estado.rel.gerando) {
      estado.rel.gerando = false;
      estado.rel.etapa = '';
      estado.rel.erro = 'Geracao cancelada por voce.';
      render();
      return;
    }

      // sem esta trava, dois cliques rapidos disparam duas geracoes que
      // competem pelo mesmo estado.campanhas e misturam os periodos
      if (estado.rel.gerando) return;
      if (estado.coletaProgresso !== null) {
        estado.rel.erro = 'Ha uma leitura em andamento (' + esc(String(estado.coletaProgresso)) + '). Espere ela terminar e tente de novo.';
        render(); return;
      }
      var meses = mesesDisponiveis();
      var sel = estado.rel.mes || meses[1].v;
      var fa = faixaDoMes(sel), fp = faixaDoMes(mesAnterior(sel));
      if (!epochDoMes(sel) || !epochDoMes(mesAnterior(sel))) {
        estado.rel.erro = 'Este mes ainda nao tem dia fechado na Shopee. Escolha outro.'; render(); return;
      }
      // MES EM CURSO: comparar 3 dias de agosto com 31 de julho produz
      // quedas falsas que parecem desempenho e nao sao. Ou equaliza os dias,
      // ou nao gera.
      var fA2 = epochDoMes(sel), fB2 = epochDoMes(mesAnterior(sel));
      if (fA2 && fB2) {
        var diasA = Math.round((fA2.fim - fA2.inicio) / 86400);
        var diasB = Math.round((fB2.fim - fB2.inicio) / 86400);
        // NUNCA recusar por mes em curso — a Karina pode querer analisar o
        // mes corrente, e isso e legitimo. O que nao pode e comparar 3 dias
        // com 31: entao equaliza SEMPRE que os periodos forem diferentes,
        // recortando o mes anterior no mesmo numero de dias.
        estado.rel.equalizado = (diasA < diasB) ? diasA : null;
      }
      if (!estado.loja || !estado.loja.shop_id) {
        estado.rel.erro = 'Ainda nao identifiquei a loja. Navegue uma vez pelo painel da Shopee e tente de novo.'; render(); return;
      }
      estado.rel.gerando = true; estado.rel.erro = null;
      estado.rel.etapa = 'Preparando...'; render();

      // Coleta os DOIS meses sozinha, um de cada vez. Antes o seletor so
      // rotulava o relatorio e os numeros vinham do recorte aberto no painel
      // — o mesmo bloco ia como "atual" e como "anterior", e o comparativo
      // era uma comparacao do mes com ele mesmo.
      var guardaCampanhas = estado.campanhas, guardaProdutos = estado.produtos, guardaConta = estado.conta;
      function restaurar() { estado.campanhas = guardaCampanhas; estado.produtos = guardaProdutos; estado.conta = guardaConta; }
      function zerar() {
        estado.campanhas = {}; estado.produtos = {}; estado.conta = { campos: {}, atualizadoEm: null };
        // O COFRE tambem precisa ser zerado: blocoPeriodo le DELE, nao de
        // estado.campanhas. Sem isto o segundo mes lia o COFRE ainda cheio
        // do primeiro, e os dois periodos saiam identicos no relatorio —
        // exatamente o que aconteceu: mesmo GMV, mesmos 24 pedidos, mesmos
        // 999 visitantes, variacao 0,00% em tudo.
        try { if (window.SIA_Diamantes && window.SIA_Diamantes.zerar) window.SIA_Diamantes.zerar('troca de periodo do relatorio'); } catch (e) { /* noop */ }
      }

      estado.rel.etapa = 'Lendo ' + faixaDoMes(sel).rotulo; estado.rel.pct = 8; render();
      zerar();
      // usa a Promise da coleta em vez de vigiar coletaProgresso: vigiar uma
      // variavel cria janela de corrida, que foi o que zerou o mes anterior.
      var prA = coletaCompleta(function (p) {
        if (p) { estado.rel.etapa = 'Lendo o mes atual \u00b7 ' + p; render(); }
      }, epochDoMes(sel));
      if (prA && prA.then) {
        prA.then(function () { if (esperaA) clearInterval(esperaA); concluirA(); });
      }

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
      var blocoA = null;
      var esperaA = setInterval(function () {
        if (Date.now() - t0 > LIMITE_MS) { clearInterval(esperaA); desistir('A leitura do mes atual demorou demais e foi interrompida. Os dados da tela foram preservados.'); return; }
        if (estado.coletaProgresso !== null) return;
        clearInterval(esperaA);
        concluirA();
      }, 900);

      var jaConcluiA = false;
      function concluirA() {
        if (jaConcluiA) return;
        jaConcluiA = true;
        blocoA = blocoPeriodo(fa.rotulo);
        if (!Object.keys(estado.campanhas).length && !Object.keys(estado.produtos).length) {
          desistir('Nao consegui ler dados de ' + fa.rotulo + '. Verifique se voce esta na conta certa e se ha movimento nesse mes.');
          return;
        }

        estado.rel.etapa = 'Lendo ' + faixaDoMes(mesAnterior(sel)).rotulo; estado.rel.pct = 35; render();
        zerar();
        // BUG QUE ZERAVA O MES ANTERIOR: o esperaB comecava a contar na hora,
        // mas a segunda coleta so disparava 3 segundos depois. Nessa janela
        // coletaProgresso ainda era null, entao o esperaB concluia na hora,
        // lia o COFRE recem-zerado e devolvia um mes vazio. Agora a espera so
        // comeca DEPOIS que a coleta confirma que iniciou, e usamos a Promise
        // da propria coleta em vez de vigiar uma variavel.
        var t1 = Date.now();
        var esperaB = null;
        setTimeout(function () {
          var pr = coletaCompleta(function (p) {
            if (p) { estado.rel.etapa = 'Lendo o mes anterior \u00b7 ' + p; render(); }
          }, (function () {
          var fb = epochDoMes(mesAnterior(sel));
          // mesmo numero de dias, contados do inicio do mes anterior
          if (fb && estado.rel.equalizado) fb = { inicio: fb.inicio, fim: fb.inicio + estado.rel.equalizado * 86400 };
          return fb;
        })());
          if (pr && pr.then) { pr.then(function () { concluirB(); }); return; }
          esperaB = setInterval(function () {
            if (Date.now() - t1 > LIMITE_MS) { clearInterval(esperaB); desistir('A leitura do mes anterior demorou demais e foi interrompida.'); return; }
            if (estado.coletaProgresso !== null) return;
            clearInterval(esperaB);
            concluirB();
          }, 900);
        }, 3000);

        function concluirB() {
          var blocoB = blocoPeriodo(fp.rotulo);
          restaurar();

          // se os dois periodos sairem identicos, algo nao trocou de verdade
          // NAO GERAR SEM DADOS. Relatorio vazio e pior que relatorio nenhum:
          // parece que funcionou e nao serve para decidir nada.
          var vazioA = !blocoA.conta || (blocoA.conta.gmvPago == null && blocoA.conta.pedidosPagos == null);
          var vazioB = !blocoB.conta || (blocoB.conta.gmvPago == null && blocoB.conta.pedidosPagos == null);
          if (vazioA || vazioB) {
            desistir('Nao consegui ler os numeros da conta ' + (vazioA && vazioB ? 'nos dois meses' : (vazioA ? 'do mes escolhido' : 'do mes anterior')) +
              '. Sem GMV e pedidos nao ha relatorio possivel — prefiro nao gerar do que entregar um documento vazio. ' +
              'Abra a Central de Dados da Shopee uma vez e tente de novo.');
            return;
          }
          var iguais = blocoA.conta && blocoB.conta &&
            blocoA.conta.gmvPago === blocoB.conta.gmvPago &&
            blocoA.conta.pedidosPagos === blocoB.conta.pedidosPagos &&
            blocoA.conta.visitantes === blocoB.conta.visitantes &&
            (blocoA.conta.gmvPago !== null && blocoA.conta.gmvPago !== undefined);
          if (iguais) {
            desistir('Os dois meses vieram com os mesmos numeros, o que significa que a leitura do periodo anterior nao trocou de verdade. Nao vou gerar um relatorio com comparacao falsa. Tente de novo; se repetir, me avise.');
            return;
          }

          estado.rel.etapa = 'O consultor esta escrevendo...'; render();
          var payload = {
            equalizado: estado.rel.equalizado || null,
            loja: estado.loja ? estado.loja.shop_id : 'desconhecida',
            loja_nome: estado.loja ? estado.loja.nome : '',
            margemMediaPct: margemMediaCofre(),
            atual: blocoA,
            anterior: blocoB
          };
          // Pede em duas partes: diagnostico e depois plano/projecao. Cada
          // chamada cabe no limite de 150s da Edge Function; juntas fazem o
          // relatorio inteiro sem estourar o tempo.
          // CHAMADA DIRETA, sem passar pelo service worker.
          // O service worker do Chrome MV3 e encerrado apos ~30s de
          // inatividade. O relatorio leva de 60 a 90 segundos, entao o worker
          // morria ANTES da resposta chegar e o callback voltava vazio — era
          // esse o "Sem resposta da funcao". A funcao no Supabase responde
          // certo; quem sumia era o intermediario.
          // A funcao tem CORS aberto e o dominio esta em host_permissions,
          // entao o fetch daqui funciona e nao depende de worker nenhum.
          function pedir(parte, aoOk) {
            var p2 = {}; for (var kk in payload) p2[kk] = payload[kk];
            p2.parte = parte;
            fetch(SIA_URL_RELATORIO, {
              method: 'POST',
              // A chave so vai junto quando existir: com Verify JWT desligado na
      // funcao, ela nao e necessaria, e mandar cabecalho vazio atrapalha.
      headers: cabecalhosFuncao(),
              body: JSON.stringify(p2)
            }).then(function (r) {
              // A funcao agora responde em STREAM de texto puro. Ler por
              // pedacos mostra o relatorio nascendo e, mais importante,
              // mantem a conexao ativa do inicio ao fim.
              var ct = r.headers.get('content-type') || '';
              if (r.ok && ct.indexOf('text/plain') >= 0 && r.body) {
                var reader = r.body.getReader();
                var dec = new TextDecoder();
                var acc = '';
                function ler() {
                  return reader.read().then(function (res) {
                    if (res.done) { aoOk({ ok: true, markdown: acc }); return; }
                    acc += dec.decode(res.value, { stream: true });
                    // sem contagem de caracteres: quem espera quer saber a
                    // etapa, nao quantos bytes chegaram
                    estado.rel.pct = Math.min(97, (estado.rel.pct || 60) + 0.4);
                    estado.sujo = true;
                    return ler();
                  });
                }
                ler().catch(function (e) { aoOk({ ok: false, erro: 'O stream foi interrompido: ' + String(e && e.message || e) }); });
                return;
              }
              return r.text().then(function (txt) {
                var j = null;
                try { j = JSON.parse(txt); } catch (e) { /* noop */ }
                if (!j) { aoOk({ ok: false, erro: 'A funcao respondeu HTTP ' + r.status + ': ' + txt.slice(0, 200) }); return; }
                aoOk(j);
              });
            }).catch(function (e) {
              aoOk({ ok: false, erro: 'Nao consegui alcancar a funcao: ' + String((e && e.message) || e) });
            });
          }
          // TRES PARTES: 8 secoes em 9 mil tokens estourava o limite e o
          // relatorio era cortado no meio da secao 4, sumindo com as secoes
          // 5 a 8. Agora sao 1-4, 5-8 e 9-10.
          estado.rel.etapa = 'O consultor esta escrevendo o diagnostico'; estado.rel.pct = 62; render();
          pedir(1, function (r1) {
            if (!r1 || !r1.ok) { falhouRelatorio(r1); return; }
            estado.rel.etapa = 'Analisando Ads e produtos'; estado.rel.pct = 78; render();
            pedir(3, function (r3) {
            estado.rel.etapa = 'Montando o plano de 30 dias'; estado.rel.pct = 91; render();
            pedir(2, function (r2) {
              estado.rel.gerando = false; estado.rel.etapa = '';
              estado.rel.markdown = r1.markdown +
                '\n\n' + ((r3 && r3.ok && r3.markdown) || '') +
                '\n\n' + ((r2 && r2.ok && r2.markdown) || '');
              estado.rel.loja = estado.loja ? estado.loja.shop_id : null;
              if (!r2 || !r2.ok) estado.rel.erro = 'O diagnostico ficou pronto, mas o plano de 30 dias falhou: ' + ((r2 && (r2.erro || r2.detalhe)) || 'sem resposta');
              else if (!r3 || !r3.ok) estado.rel.erro = 'As secoes de Ads e produtos falharam: ' + ((r3 && (r3.erro || r3.detalhe)) || 'sem resposta');
              render();
            });
            });
          });
          return;
          function falhouRelatorio(resp) {
            estado.rel.gerando = false; estado.rel.etapa = '';
            var mot = (resp && (resp.erro || resp.detalhe)) || 'Sem resposta da funcao.';
            var dica = '';
            if (/IDLE_TIMEOUT|504/i.test(mot)) dica = ' A funcao passou do tempo limite do Supabase. Republique o relatorio.ts atualizado, que gera em partes.';
            else if (/ANTHROPIC_API_KEY/i.test(mot)) dica = ' Falta a secret ANTHROPIC_API_KEY na funcao relatorio.';
            else if (/prompt.*nao encontrado/i.test(mot)) dica = ' Rode o prompt-relatorio.sql.';
            else if (/404/.test(mot)) dica = ' A funcao relatorio nao foi publicada.';
            estado.rel.erro = mot + dica;
            render();
          }
          try {
            if (false) chrome.runtime.sendMessage({ tipo: 'sia:relatorio', payload: payload }, function (resp) {
              void chrome.runtime.lastError;
              estado.rel.gerando = false; estado.rel.etapa = '';
              if (!resp || !resp.ok) {
                // "Nao consegui gerar" sozinho nao ajuda ninguem: mostra o
                // motivo que a funcao devolveu e o que fazer com ele.
                var mot = (resp && (resp.erro || resp.detalhe)) || 'Sem resposta da funcao.';
                var dica = '';
                if (/ANTHROPIC_API_KEY/i.test(mot)) dica = ' Falta cadastrar a secret ANTHROPIC_API_KEY na funcao relatorio, no Supabase.';
                else if (/prompt.*nao encontrado|conhecimento/i.test(mot)) dica = ' O prompt nao esta na tabela conhecimento: rode o prompt-relatorio.sql.';
                else if (/404|not found/i.test(mot)) dica = ' A funcao relatorio ainda nao foi publicada no Supabase.';
                else if (/401|403/.test(mot)) dica = ' A chave de acesso foi recusada pelo Supabase.';
                estado.rel.erro = mot + dica;
              }
              else { estado.rel.markdown = resp.markdown; estado.rel.loja = estado.loja ? estado.loja.shop_id : null; }
              render();
            });
          } catch (e) { estado.rel.gerando = false; estado.rel.erro = String(e); restaurar(); render(); }
        }
      }
  }

  function ligarRelatorio() {
    var m = $('sia-rel-mes');
    if (m) m.addEventListener('change', function () { estado.rel.mes = m.value; render(); });




  }
  function imprimirRelatorio() {
    // window.open('') dentro de content script e bloqueado em boa parte dos
    // casos e a janela simplesmente nao aparece. Gerar um blob e abrir a URL
    // dele funciona porque o navegador trata como navegacao normal, e ainda
    // deixa o arquivo salvavel se o pop-up for barrado.
    var html = __htmlRelatorio();
    var w = null;
    try {
      var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      w = window.open(url, '_blank');
      if (w) { setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) { } }, 60000); return; }
      // pop-up barrado: cai para download do arquivo, que nunca e bloqueado
      var a = document.createElement('a');
      a.href = url;
      a.download = 'relatorio-' + ((estado.loja && estado.loja.nome) || 'loja').replace(/[^\w-]/g, '-') + '.html';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      mostrarExpl('<b>O navegador bloqueou a janela, entao baixei o relatorio.</b> Abra o arquivo e use <b>Imprimir &rarr; Salvar como PDF</b>.');
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) { } }, 60000);
      return;
    } catch (e) {
      mostrarExpl('<b>Nao consegui gerar o arquivo.</b> ' + esc(String(e)));
      return;
    }
  }
  function imprimirSemanal() {
    var nome = (estado.loja && estado.loja.nome) || 'Loja';
    var html = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Semanal ' + esc(nome) + '</title>' +
      '<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Bebas+Neue&family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">' +
      '<style>@page{margin:12mm 11mm}body{font-family:Outfit,Arial,sans-serif;font-weight:300;color:#15161a;line-height:1.5;margin:0;padding:0;font-size:10.5pt}' +
      'h1{font-family:Bebas Neue;font-size:26pt;margin:0 0 2px}' +
      'table{width:100%;border-collapse:collapse;margin:8px 0;font-size:9pt;page-break-inside:avoid}' +
      'th{text-align:left;padding:6px 5px;border-bottom:1.5px solid #15161a;font-size:8pt;text-transform:uppercase;letter-spacing:.04em;font-weight:600}' +
      'td{padding:6px 5px;border-bottom:1px solid #e3e3e3;vertical-align:top}' +
      'ul,ol{margin:5px 0 5px 17px;padding:0}li{margin:2px 0}' +
      '.cab{border-bottom:2px solid #ff4d1c;padding-bottom:7px;margin-bottom:11px}.mk{color:#ff4d1c}' +
      '.rod{margin-top:22px;padding-top:9px;border-top:1px solid #ddd;font-size:8pt;color:#777}' +
      '@media print{.noprint{display:none}}</style></head><body>' +
      '<div class="cab"><h1>SELLER<span class="mk">.IA</span></h1>' +
      '<div style="font-size:9.5pt;color:#666">Panorama da semana &middot; ' + esc(nome) + ' &middot; ' + new Date().toLocaleDateString('pt-BR') + '</div></div>' +
      '<div class="noprint" style="background:#f4f2ee;border-radius:7px;padding:9px 12px;margin-bottom:14px;font-size:9pt">Use <b>Imprimir &rarr; Salvar como PDF</b> (Ctrl+P). Esta faixa nao sai na impressao.</div>' +
      mdParaHtmlImpressao(estado.semanal.markdown || '') +
      '<div class="rod">Seller.IA &middot; Efeito Vendas</div>' +
      '<script>setTimeout(function(){try{window.print()}catch(e){}},900)<\/script></body></html>';
    try {
      var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var w = window.open(url, '_blank');
      if (!w) {
        var a = document.createElement('a');
        a.href = url; a.download = 'semanal-' + String(nome).replace(/[^\w-]/g, '-') + '.html';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      }
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) { } }, 60000);
    } catch (e) { mostrarExpl('<b>Nao consegui gerar o arquivo.</b> ' + esc(String(e))); }
  }
  function __htmlRelatorio() {
    var nome = (estado.loja && estado.loja.nome) || 'Loja';
    return '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatorio ' + esc(nome) + '</title>' +
      '<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Bebas+Neue&family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">' +
      '<style>@page{margin:12mm 10mm}' +
      'body{font-family:Outfit,Arial,sans-serif;font-weight:300;color:#15161a;line-height:1.45;max-width:none;margin:0;padding:0;font-size:9.5pt}' +
      'h1{font-family:Bebas Neue;font-size:24pt;letter-spacing:.02em;margin:0 0 2px}' +
      'table{width:100%;border-collapse:collapse;margin:7px 0;font-size:8.5pt;page-break-inside:avoid}' +
      'th{text-align:left;padding:5px 5px;border-bottom:1.5px solid #15161a;font-size:7.5pt;text-transform:uppercase;letter-spacing:.04em;font-weight:600}' +
      'td{padding:5px 5px;border-bottom:1px solid #e3e3e3;vertical-align:top}' +
      'div{margin:0}' +
      'ul,ol{margin:4px 0 4px 16px;padding:0}li{margin:1px 0}' +
      'b{font-weight:600}.cab{border-bottom:3px solid #ff4d1c;padding-bottom:10px;margin-bottom:18px}' +
      '.mk{color:#ff4d1c}.rod{margin-top:26px;padding-top:10px;border-top:1px solid #ddd;font-size:8.5pt;color:#777}' +
      '.aviso{background:#f4f2ee;border-radius:8px;padding:11px 14px;margin-bottom:18px;font-size:10pt}' +
      '@media print{.noprint{display:none}}</style></head><body>' +
      '<div class="cab"><h1>SELLER<span class="mk">.IA</span></h1><div style="font-size:10pt;color:#666">Relatorio de analise de conta &middot; ' + esc(nome) + ' &middot; gerado em ' + new Date().toLocaleDateString('pt-BR') + '</div></div>' +
      '<div class="noprint aviso">Use <b>Imprimir &rarr; Salvar como PDF</b> (Ctrl+P). Esta faixa nao sai na impressao.</div>' +
      mdParaHtmlImpressao(estado.rel.markdown || '') +
      '<div class="rod">Seller.IA &middot; Efeito Vendas</div>' +
      '<script>setTimeout(function(){try{window.print()}catch(e){}},900)<\/script>' +
      '</body></html>';
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
    // CÓPIA, nao referencia. Guardar o proprio objeto fazia a coleta seguinte
    // alterar o snapshot da conta anterior junto — os dois apontavam para a
    // mesma memoria. Era assim que produto de uma loja aparecia em outra
    // mesmo depois de trocar de conta.
    function copiar(o) {
      try { return JSON.parse(JSON.stringify(o || {})); } catch (e) { return {}; }
    }
    var foto = {
      campanhas: copiar(estado.campanhas), produtos: copiar(estado.produtos),
      conta: copiar(estado.conta), diagnostico: copiar(estado.diagnostico),
      lidoEm: estado.lidoEm || null
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
  // Poda o que veio do disco. O snapshot guardava campanhas acumuladas de
  // leituras antigas — foi assim que apareceram 847 campanhas com gasto de
  // varios recortes somados, mesmo com o teto na criacao.
  // Remove da memoria tudo que nao e da conta aberta. Roda no render, entao
  // qualquer sobra de leitura anterior desaparece na primeira tela desenhada.
  function limparDeOutrasLojas() {
    var atual = estado.loja ? String(estado.loja.shop_id) : null;
    if (!atual) return 0;
    var n = 0, id;
    for (id in estado.produtos) {
      var pl = estado.produtos[id] && estado.produtos[id].loja;
      if (pl && pl !== atual) { delete estado.produtos[id]; n++; }
    }
    // periodo mais recente entre as campanhas: o que nao for dele sai, porque
    // somar gasto de recortes diferentes produz o total que nao bate com o
    // faturamento do periodo
    var perAtual = null, ts;
    for (id in estado.campanhas) {
      var pp2 = estado.campanhas[id] && estado.campanhas[id].periodo;
      if (!pp2) continue;
      ts = parseInt(String(pp2).split('_')[1] || '0', 10);
      if (!perAtual || ts > parseInt(String(perAtual).split('_')[1] || '0', 10)) perAtual = pp2;
    }
    for (id in estado.campanhas) {
      var c2 = estado.campanhas[id] || {};
      if (c2.loja && c2.loja !== atual) { delete estado.campanhas[id]; n++; continue; }
      if (perAtual && c2.periodo && c2.periodo !== perAtual) { delete estado.campanhas[id]; n++; }
    }
    return n;
  }
  function podarCampanhas(mapa) {
    var ids = Object.keys(mapa || {});
    if (ids.length <= 280) return mapa || {};
    ids.sort(function (a, b) {
      var ma = (mapa[a].metricas || {}), mb = (mapa[b].metricas || {});
      return (mb.gasto || 0) - (ma.gasto || 0);
    });
    var out = {};
    for (var i = 0; i < 280; i++) out[ids[i]] = mapa[ids[i]];
    return out;
  }
  function restaurarConta(id) {
    var g = estado.contas[id] || contaVazia();
    function copiaR(o) { try { return JSON.parse(JSON.stringify(o || {})); } catch (e) { return {}; } }
    estado.campanhas = podarCampanhas(copiaR(g.campanhas));
    estado.produtos = copiaR(g.produtos);
    estado.conta = copiaR(g.conta); estado.diagnostico = copiaR(g.diagnostico); estado.lidoEm = g.lidoEm;
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
    // avisa o Cofre ANTES de qualquer coisa: ele se zera sozinho se a conta
    // mudou, e passa a recusar dado que nao seja desta loja
    try {
      if (nova && nova.shop_id && window.SIA_Diamantes && window.SIA_Diamantes.definirLoja) {
        window.SIA_Diamantes.definirLoja(nova.shop_id);
      }
    } catch (e) { /* noop */ }
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
    try { if (window.SIA_Diamantes && window.SIA_Diamantes.zerar) window.SIA_Diamantes.zerar('troca de conta'); } catch (e) { /* noop */ }
    lojaDoCiclo = nova.shop_id;                 // qualquer pacote em voo da
                                                // conta anterior sera descartado
    if (estado.coletaProgresso !== null) {
      estado.coletaAbortada = true;
      estado.coletaProgresso = null;
    }
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
    return '<div style="background:var(--b0);border:1px solid var(--li);border-radius:16px;padding:13px;margin-top:14px">' +
      '<div style="font-size:14px;color:var(--t0);font-weight:500;margin-bottom:4px">A analise completa ainda nao rodou</div>' +
      '<div style="font-size:13px;color:var(--t2);line-height:1.5;margin-bottom:10px">O que esta na tela e a leitura local. A completa traz o diagnostico da propria Shopee, o piso de ROAS pela sua margem e a leitura por formato de anuncio.</div>' +
      '<button id="sia-analisar-agora" style="background:var(--mk);border:none;color:#fff;font-weight:600;font-size:13px;padding:9px 16px;border-radius:var(--r-btn,14px);cursor:pointer">' +
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
    return '<div style="background:color-mix(in srgb,var(--rd) var(--tin,9%),var(--b2));border:1px solid var(--rd);border-left:3px solid var(--rd);border-radius:18px;padding:15px 16px;margin-bottom:14px">' +
      '<div style="font-size:16px;font-weight:600;color:var(--t0);margin-bottom:5px">A leitura desta conta pode estar incompleta</div>' +
      '<div style="font-size:14px;color:var(--t1);line-height:1.55">' + esc(av.join(' ')) +
      ' A Shopee pode ter mudado algo no painel. <b>Enquanto isso nao for verificado, a ausencia de alertas nesta tela nao significa que esta tudo bem.</b></div></div>';
  }

  function renderBannerConta() {
    if (!estado.loja) {
      return '<div style="background:var(--b0);border-left:3px solid var(--am);border-radius:0 16px 16px 0;padding:11px 13px;margin-bottom:12px;font-size:13px;color:var(--t1)">Identificando a loja... navegue uma vez no painel para a Seller.IA reconhecer a conta.</div>';
    }
    var n = Object.keys(estado.campanhas).length, p = Object.keys(estado.produtos).length;
    var vazio = (n + p) === 0;
    var trocouAgora = estado.trocou && (Date.now() - estado.trocou.em) < 600000;
    if (!vazio && !trocouAgora) return '';
    var cor = vazio ? 'var(--am)' : 'var(--vd)';
    var rodando = estado.coletaProgresso !== null;
    if (vazio && rodando) {
      return '<div style="background:var(--b0);border-left:3px solid var(--mk);border-radius:0 16px 16px 0;padding:11px 13px;margin-bottom:12px;font-size:13px;color:var(--t1);line-height:1.5">' +
        'Lendo <b>' + esc(estado.loja.nome || ('loja ' + estado.loja.shop_id)) + '</b> agora \u2014 ' + esc(String(estado.coletaProgresso)) + '</div>';
    }
    var txt = vazio
      ? '<b>' + sig(estado.loja.nome || ('loja ' + estado.loja.shop_id)) + '</b> ainda nao foi lida nesta sessao.'
      : '<b>' + sig(estado.loja.nome || ('loja ' + estado.loja.shop_id)) + '</b> — dado desta conta, lido ' + (lidoHa() || 'agora') + '.';
    return '<div style="background:var(--b0);border-left:3px solid ' + cor + ';border-radius:0 16px 16px 0;padding:11px 13px;margin-bottom:12px;font-size:13px;color:var(--t1);line-height:1.5">' + txt +
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

  // Linhas que nao sao produto entram na coleta (credito de Ads, saldo,
  // recarga, ajuste). No Cofre, onde se cadastra CUSTO, elas nao fazem
  // sentido nenhuma — nao se compra credito de Ads de fornecedor.
  function excluirDoCofre(id) {
    if (!estado.cofre.custos) estado.cofre.custos = {};
    delete estado.cofre.custos[id];
    estado.cofre.ocultos = estado.cofre.ocultos || {};
    estado.cofre.ocultos[id] = true;
    salvarCofre();
    estado.sujo = true;
    render();
  }
  function ehProdutoDeVerdade(nome) {
    if (!nome) return false;
    if (/cr[eé]dito|saldo|recarga|ajuste|reembolso|taxa|cupom da loja|voucher|bonifica|desconto da loja|frete gr[aá]tis/i.test(nome)) return false;
    if (!/[a-zA-Zà-úÀ-Ú]{4}/.test(nome)) return false;
    return true;
  }
  /* ============ CALCULADORA DE PRECIFICACAO ============
     O Cofre deixou de ser lista de custos — isso agora vive no card do Ads,
     onde a decisao acontece. Aqui fica a pergunta que antecede tudo: dado
     este custo e esta margem alvo, por quanto eu preciso vender? */
  function renderPrecificacao() {
    estado.precific = estado.precific || {};
    var C = estado.precific;
    function campo(id2, rot, valor, sufixo, ajuda) {
      return '<div><div style="font-family:Space Mono,monospace;font-size:9.5px;color:var(--t2);margin-bottom:5px">' + rot + '</div>' +
        '<div style="display:flex;align-items:center;gap:6px">' +
        '<input data-prec="' + id2 + '" value="' + esc(String(valor || '')) + '" placeholder="0,00" ' +
        'style="flex:1;background:var(--b0);border:1px solid var(--li);border-radius:8px;padding:10px 11px;color:var(--t0);font-family:Space Mono,monospace;font-size:14px">' +
        (sufixo ? '<span style="font-family:Space Mono,monospace;font-size:12px;color:var(--t2)">' + sufixo + '</span>' : '') + '</div>' +
        (ajuda ? '<div style="font-size:11.5px;color:var(--t3);margin-top:4px;line-height:1.4">' + ajuda + '</div>' : '') + '</div>';
    }

    var h = '<div class="leitura"><div class="fr">Por quanto preciso vender?</div>' +
      '<div class="ex">Voce diz o custo e quanto quer que sobre. A conta devolve o preco, ja com a comissao da Shopee, embalagem e imposto descontados — e o ROAS minimo que esse preco sustenta.</div></div>';

    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">' +
      campo('custo', 'Custo do produto', C.custo, 'R$', 'o que voce paga ao fornecedor') +
      campo('margem', 'Margem que quer', C.margem, '%', 'quanto do preco final quer que sobre') +
      '</div>';
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">' +
      campo('embalagem', 'Embalagem', C.embalagem, 'R$', 'caixa, plastico, etiqueta') +
      campo('imposto', 'Imposto', C.imposto, '%', 'sobre o preco de venda') +
      '</div>';

    h += '<button id="sia-prec-calcular" style="width:100%;background:var(--mk);border:none;color:#fff;font-family:inherit;font-weight:700;font-size:14.5px;padding:13px;border-radius:10px;cursor:pointer;margin-bottom:14px">Calcular o preco</button>';
    var custo = numeroPuro(C.custo), margem = numeroPuro(C.margem);
    if (!custo || !margem) {
      return h + '<div class="nota">Preencha o custo e a margem que voce quer, e toque em <b>Calcular o preco</b>.</div>';
    }
    var emb = numeroPuro(C.embalagem) || 0, imp = numeroPuro(C.imposto) || 0;

    // resolve o preco: preco = custo + emb + comissao(preco) + imposto(preco) + margem(preco)
    // a comissao muda de faixa conforme o preco, entao testa faixa a faixa
    function comissaoDe(p2) {
      if (p2 < 80) return p2 * 0.20 + 4;
      if (p2 < 100) return p2 * 0.14 + 16;
      if (p2 < 200) return p2 * 0.14 + 20;
      return p2 * 0.14 + 26;
    }
    var preco = null;
    for (var faixa = 0; faixa < 4; faixa++) {
      var pct = faixa === 0 ? 0.20 : 0.14;
      var fixo = faixa === 0 ? 4 : (faixa === 1 ? 16 : (faixa === 2 ? 20 : 26));
      // preco*(1 - pct - imp/100 - margem/100) = custo + emb + fixo
      var div = 1 - pct - (imp / 100) - (margem / 100);
      if (div <= 0) continue;
      var cand = (custo + emb + fixo) / div;
      var limites = [80, 100, 200, Infinity];
      var minimo = faixa === 0 ? 0 : limites[faixa - 1];
      if (cand >= minimo && cand < limites[faixa]) { preco = cand; break; }
    }
    if (!preco) {
      return h + '<div style="background:color-mix(in srgb,var(--rd) var(--tin,9%),var(--b2));border-left:3px solid var(--rd);border-radius:0 16px 16px 0;padding:14px;font-size:14px;color:var(--t1);line-height:1.55">' +
        '<b style="color:var(--t0)">Essa margem nao cabe.</b> Somando comissao e imposto, nao existe preco que deixe ' + fmt(margem, 0) + '% sobrando com esse custo. Reduza a margem alvo ou o custo.</div>';
    }

    var com = comissaoDe(preco);
    var impV = preco * (imp / 100);
    var sobra = preco - com - custo - emb - impV;
    var pisoRoasP = 100 / margem;

    h += '<div style="background:var(--b0);border:1px solid var(--li);border-radius:18px;padding:17px;margin-bottom:12px">' +
      '<div style="font-family:Space Mono,monospace;font-size:9.5px;color:var(--t2);letter-spacing:.08em;margin-bottom:10px">O PRECO QUE ENTREGA ESSA MARGEM</div>' +
      '<div style="font-family:Bebas Neue,sans-serif;font-size:46px;line-height:1;color:var(--mk)">' + reais(preco) + '</div>' +
      '<div style="font-size:13.5px;color:var(--t2);margin-top:6px">deixa ' + reais(sobra) + ' por venda</div></div>';

    function ln2(rot, v2, cor) {
      return '<div style="display:flex;justify-content:space-between;font-size:14px;padding:5px 0;color:' + (cor || 'var(--t1)') + '">' +
        '<span>' + rot + '</span><span style="font-family:Space Mono,monospace">' + v2 + '</span></div>';
    }
    h += olho('DE ONDE SAI CADA REAL');
    h += '<div style="background:var(--b0);border:1px solid var(--li);border-radius:18px;padding:14px">';
    h += ln2('Preco de venda', reais(preco), 'var(--t0)');
    h += ln2('\u2212 Comissao Shopee', '\u2212 ' + reais(com), 'var(--t2)');
    h += ln2('\u2212 Custo do produto', '\u2212 ' + reais(custo), 'var(--t2)');
    if (emb) h += ln2('\u2212 Embalagem', '\u2212 ' + reais(emb), 'var(--t2)');
    if (impV) h += ln2('\u2212 Imposto', '\u2212 ' + reais(impV), 'var(--t2)');
    h += '<div style="display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid var(--li);margin-top:8px;padding-top:9px">' +
      '<span style="font-size:15px;font-weight:600;color:var(--t0)">Sobra</span>' +
      '<span style="font-family:Bebas Neue,sans-serif;font-size:26px;color:var(--vd)">' + reais(sobra) + '</span></div></div>';

    h += olho('O QUE ISSO SIGNIFICA PARA O ANUNCIO', 'Com esta margem, cada real investido em Shopee Ads precisa devolver pelo menos este valor para a venda nao sair no prejuizo. Abaixo disso voce paga para vender.');
    h += '<div style="background:color-mix(in srgb,var(--px) var(--tin,9%),var(--b2));border-left:3px solid var(--px);border-radius:0 18px 18px 0;padding:15px 16px;font-size:14.5px;color:var(--t1);line-height:1.55">' +
      '<b style="color:var(--t0)">ROAS minimo: ' + fmt(pisoRoasP, 1) + 'x</b><br>' +
      'Com margem de ' + fmt(margem, 0) + '%, abaixo de ' + fmt(pisoRoasP, 1) + 'x cada venda sai no negativo. ' +
      'Para ter folga de verdade, trabalhe a partir de ' + fmt(pisoRoasP * 1.5, 1) + 'x.</div>';

    if (preco < 80) {
      var precoAcima = null;
      for (var d2 = 80; d2 < 140; d2 += 1) {
        var s2 = d2 - comissaoDe(d2) - custo - emb - d2 * (imp / 100);
        if ((s2 / d2) * 100 >= margem) { precoAcima = d2; break; }
      }
      h += '<div class="nota" style="margin-top:12px">Este preco esta na faixa de comissao mais cara (20% + R$ 4). ' +
        (precoAcima ? 'Um kit ou combo a partir de ' + reais(precoAcima) + ' cai para 14% + R$ 16 e entrega a mesma margem com menos esforco de venda.' : 'Passar de R$ 80 muda a faixa para 14% + R$ 16.') + '</div>';
    }
    return h;
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
      '<div style="background:var(--b0);border:1px solid var(--li);border-radius:10px;padding:10px">' +
      '<div style="font-family:Space Mono,monospace;font-size:10px;color:var(--t2)">EMBALAGEM POR PEDIDO (R$)</div>' +
      '<input id="sia-cf-emb" value="' + (cf.embalagem ? String(cf.embalagem).replace('.', ',') : '') + '" placeholder="0,00" style="width:100%;background:var(--b1);border:1px solid var(--li);border-radius:7px;padding:7px 9px;color:var(--t0);font-family:monospace;font-size:13px;margin-top:5px"></div>' +
      '<div style="background:var(--b0);border:1px solid var(--li);border-radius:10px;padding:10px">' +
      '<div style="font-family:Space Mono,monospace;font-size:10px;color:var(--t2)">IMPOSTO SOBRE A VENDA (%)</div>' +
      '<input id="sia-cf-imp" value="' + (cf.imposto ? String(cf.imposto).replace('.', ',') : '') + '" placeholder="0" style="width:100%;background:var(--b1);border:1px solid var(--li);border-radius:7px;padding:7px 9px;color:var(--t0);font-family:monospace;font-size:13px;margin-top:5px"></div></div>';

    h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:9px">' +
      '<span style="font-family:Space Mono,monospace;font-size:12px;color:var(--t2);letter-spacing:.06em;flex:1">CUSTO POR PRODUTO — ' + preenchidos + ' de ' + lista.length + ' cadastrados</span>' +
      '<button id="sia-cf-salvar" style="background:var(--mk);border:none;color:var(--t0);font-weight:700;font-size:12px;padding:8px 16px;border-radius:var(--r-btn,14px);cursor:pointer">Salvar</button></div>';

    if (!lista.length) return h + '<div class="vazio">Nenhum produto lido ainda. Rode a coleta na aba Inicio.</div>';

    for (var i = 0; i < lista.length; i++) {
      var it = lista[i];
      var cst = custoDe(it.id);
      h += '<div style="display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid var(--li)">' +
        '<span style="width:6px;height:6px;border-radius:50%;background:' + (cst ? 'var(--vd)' : 'var(--li2)') + ';flex:none"></span>' +
        '<span style="flex:1;font-size:13px;color:var(--t1);min-width:0">' + sig(String(it.nome).slice(0, 46)) + '</span>' +
        (it.gmv ? '<span style="font-family:Space Mono,monospace;font-size:10.5px;color:var(--t2)">' + reais(it.gmv) + '</span>' : '') +
        '<input data-custo="' + esc(it.id) + '" value="' + (cst ? String(cst).replace('.', ',') : '') + '" placeholder="custo" ' +
        'style="width:84px;background:var(--b1);border:1px solid ' + (cst ? 'var(--vd)' : 'var(--li)') + ';border-radius:7px;padding:6px 8px;color:var(--t0);font-family:monospace;font-size:12.5px;text-align:right">' +
        '<span data-cofre-excluir="' + esc(it.id) + '" title="tirar da lista" style="flex:none;color:var(--t3);cursor:pointer;font-size:16px;padding:0 4px">\u00d7</span>' +
        '</div>';
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
    'relatorio','gprod','ferramentas','radar','busca','palavras','semanal','marketing'];
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
      r.acao = '';   // o botao de comparar ja esta no card, logo abaixo
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
      // usa o mapa completo: campaignId sozinho falhava e o produto com
      // campanha ativa aparecia como se nao tivesse anuncio
      var comAds = !!(d.campaignId || perf.temAds || produtoTemAds(d.id || d.itemid));
      r.titulo = comAds ? 'Vende bem e ja tem anuncio' : 'Vende bem sem nenhum anuncio';
      r.texto = 'De cada 100 pessoas que entram na pagina, ' + fmt(conv, 1) + ' compram. A media da loja e mais baixa que isso.';
      r.acao = comAds
        ? 'Suba o orcamento em 20%, meça 7 dias e so entao suba de novo. Uma mudanca por vez: mexer em meta e orcamento juntos impede saber o que funcionou.'
        : 'A pagina ja vende sozinha. E o produto mais barato para comecar a anunciar, porque voce paga por visita que ja sabe converter.';
      return r;
    }
    r.nivel = 'verde';
    r.titulo = 'Sem alerta';
    r.texto = (conv != null ? 'De cada 100 que entram, ' + fmt(conv, 1) + ' compram' : 'Nenhum degrau do funil chamou atencao') + (ctr != null ? ', e ' + fmt(ctr, 1) + ' de cada 100 que veem na busca clicam' : '') + '.';
    r.acao = 'Nada urgente aqui.';
    return r;
  }

  /* ---- FASE DE APRENDIZADO ----
     A API nao entrega estado de aprendizado nem data da ultima alteracao:
     so start_time. Entao da para saber a IDADE da campanha, nao se ela foi
     mexida. Mesmo assim resolve o caso mais comum, que e campanha nova
     sendo julgada cedo demais: 7 dias em Meta de ROAS, 14 em automatico. */
  function faseAprendizado(c) {
    var ini = c && (c.inicio || (c.campaign && c.campaign.start_time));
    if (!ini) return null;
    var dias = Math.floor((Date.now() / 1000 - ini) / 86400);
    if (dias < 0) return null;
    var tipo = (c && (c.type || c.tipo)) || '';
    var sub = (c && (c.subtype || c.subtipo)) || null;
    var janela = (tipo === 'product_manual' && sub) ? 7 : 14;
    if (dias >= janela) return null;
    return { dias: dias, janela: janela, faltam: janela - dias,
      texto: 'Esta campanha tem ' + dias + ' dia' + (dias === 1 ? '' : 's') + ' e ainda esta em aprendizado. ' +
        'O algoritmo precisa de ' + janela + ' dias para entender quem compra. ' +
        'Faltam ' + (janela - dias) + '. Mexer agora reinicia a contagem e joga fora o que ela ja aprendeu.' };
  }
  /* ============ FUNIL DENTRO DO CARD DE PRODUTO ============
     O veredito diz O QUE esta errado; o funil mostra ONDE. Cada degrau com
     quantas pessoas passaram e quantas ficaram, e o pior nomeado — porque
     melhorar um degrau que ja esta bom rende quase nada. */
  /* Um produto tem anuncio se QUALQUER campanha aponta para ele. Antes so
     olhavamos o campaignId gravado no proprio produto, que nem sempre vem —
     por isso um produto com campanha ativa aparecia como "vende bem sem
     nenhum anuncio", e a dica errada ia junto. */
  var MAPA_ADS = null;
  var PERIODO_PACOTE = null;
  function produtoTemAds(id) {
    if (!id) { MAPA_ADS = MAPA_ADS || {}; return false; }
    if (!MAPA_ADS) {
      MAPA_ADS = {};
      var D = null;
      try { D = window.SIA_Diamantes ? window.SIA_Diamantes.estado() : null; } catch (e) { /* noop */ }
      // 1) pelo produto
      var PP = (D && D.porProduto) || {};
      for (var k in PP) if (PP[k] && PP[k].campaignId) MAPA_ADS[k] = PP[k].campaignId;
      // 2) pela campanha (caminho inverso, que estava faltando)
      for (k in estado.campanhas) {
        var c = estado.campanhas[k];
        if (c && c.produtoId) MAPA_ADS[String(c.produtoId)] = k;
        var lst = c && c.mpd && c.mpd.item_list;
        if (lst) for (var i = 0; i < lst.length; i++) MAPA_ADS[String(lst[i])] = k;
      }
      var PC = (D && D.porCampanha) || {};
      for (k in PC) if (PC[k] && PC[k].produtoId) MAPA_ADS[String(PC[k].produtoId)] = k;
    }
    return !!MAPA_ADS[String(id)];
  }
  function campanhaDoProduto(id) {
    // produtoTemAds retorna cedo quando id e vazio e deixa MAPA_ADS em null:
    // o acesso seguinte estourava e derrubava a aba de Ads inteira, que era
    // o "Cannot read properties of null" do console.
    if (!id) return null;
    produtoTemAds(id);
    return (MAPA_ADS && MAPA_ADS[String(id)]) || null;
  }

  function funilDoProduto(id) {
    var p = estado.produtos[id] || {};
    var m = p.metricas || {};
    var D = null;
    try { D = window.SIA_Diamantes ? window.SIA_Diamantes.estado() : null; } catch (e) { /* noop */ }
    var perf = (D && D.porProduto && D.porProduto[id] && D.porProduto[id].perf) || {};

    // -1 e SEM DADO na Shopee. Passando direto, ele virava degrau do funil e
    // a queda calculada contra ele explodia: "de -1 que chegaram, 6.511
    // seguiram, perde 1.205.539%".
    function v(a, b) {
      var x = m[a];
      if (x == null || x === -1) x = perf[b];
      if (typeof x !== 'number' || !isFinite(x) || x < 0) return null;
      return x;
    }
    var impr = v('impressoes', 'impressoes');
    var uv = v('visitantes', 'uv');
    var cliq = v('cliques', 'cliques');
    var atc = v('carrinho', 'atc');
    var ped = v('pedidos_pagos', 'pedidosPagos');

    var degraus = [];
    if (impr) degraus.push({ r: 'VIRAM NA BUSCA', v: impr, ex: 'quantas vezes o card apareceu' });
    if (cliq) degraus.push({ r: 'CLICARAM', v: cliq, ex: 'quantos abriram a pagina' });
    else if (uv) degraus.push({ r: 'VISITARAM', v: uv, ex: 'pessoas diferentes que abriram' });
    if (uv && cliq) degraus.push({ r: 'VISITANTES', v: uv, ex: 'pessoas diferentes' });
    if (atc != null) degraus.push({ r: 'NO CARRINHO', v: atc, ex: 'quantos guardaram' });
    if (ped != null) degraus.push({ r: 'COMPRARAM', v: ped, ex: 'quantos pagaram' });
    if (degraus.length < 2) return '';

    // maior queda
    var quedas = [], i;
    for (i = 1; i < degraus.length; i++) {
      var ant = degraus[i - 1].v, at = degraus[i].v;
      // sem base valida ou com o degrau seguinte MAIOR que o anterior, a
      // queda nao existe — e sinal de dado faltando, nao de perda
      if (!ant || ant <= 0 || at == null || at > ant) continue;
      quedas.push({ i: i, de: degraus[i - 1].r, para: degraus[i].r, pct: (1 - at / ant) * 100, ficaram: at, tinham: ant });
    }
    var pior = null;
    for (i = 0; i < quedas.length; i++) if (!pior || quedas[i].pct > pior.pct) pior = quedas[i];

    var h = '<div style="background:var(--b1);border:1px solid var(--li);border-radius:16px;padding:13px 11px;margin-top:11px">' +
      '<div style="font-family:Space Mono,monospace;font-size:9.5px;color:var(--t2);letter-spacing:.08em;margin-bottom:9px">ONDE AS PESSOAS PARAM</div>' +
      '<div style="display:flex;align-items:flex-end;gap:2px">';
    for (i = 0; i < degraus.length; i++) {
      if (i > 0) {
        var q = quedas[i - 1];
        var ruim = pior && q && q.i === pior.i;
        h += '<div style="flex:none;text-align:center;font-family:Space Mono,monospace;font-size:10px;color:' + (ruim ? 'var(--rd)' : 'var(--t3)') + ';padding-bottom:18px">\u203a<br>' +
          (q ? '\u2212' + fmt(q.pct, 0) + '%' : '') + '</div>';
      }
      var ehUltimo = i === degraus.length - 1;
      h += '<div style="flex:1;text-align:center">' +
        '<div style="font-family:Bebas Neue,sans-serif;font-size:27px;line-height:1;color:' + (ehUltimo && degraus[i].v === 0 ? 'var(--rd)' : 'var(--t0)') + '">' + fmt(degraus[i].v, 0) + '</div>' +
        '<div style="font-family:Space Mono,monospace;font-size:8.5px;color:var(--t2);margin-top:5px;line-height:1.3">' + degraus[i].r + '</div></div>';
    }
    h += '</div>';

    if (pior) {
      var alvo = pior.para.toLowerCase();
      var conselho;
      if (alvo.indexOf('clicaram') >= 0 || alvo.indexOf('visit') >= 0) {
        conselho = 'Quem ve o card nao entra. O que decide isso e a primeira foto, o preco no card e o comeco do titulo.';
      } else if (alvo.indexOf('carrinho') >= 0) {
        conselho = 'Quem entra na pagina nao se convence. Preco contra o concorrente, variacao sem estoque e avaliacoes sem resposta sao as causas comuns.';
      } else {
        conselho = 'Quem guardou no carrinho nao fechou. Frete, prazo de entrega e o preco final na hora de pagar sao o que costuma travar.';
      }
      h += '<div style="font-size:13px;color:var(--t1);line-height:1.55;margin-top:10px;padding-top:9px;border-top:1px solid var(--li)">' +
        '<b style="color:var(--t0)">A maior perda esta entre ' + pior.de.toLowerCase() + ' e ' + alvo + ':</b> de ' +
        fmt(pior.tinham, 0) + ' que chegaram, ' + fmt(pior.ficaram, 0) + ' seguiram. ' +
        '<span style="color:var(--rd)">Perde ' + fmt(pior.pct, 0) + '% aqui.</span><br>' + conselho + '</div>';
    }
    return h + '</div>';
  }

  function cartaoProduto(c) {
    var co = CORES_SEM[c.nivel] || CORES_SEM.cinza;
    return '<div data-card="produto:' + esc(c.id) + '" style="cursor:pointer;background:' + co.bg + ';border:1px solid ' + co.bd + ';border-left:3px solid ' + co.dot + ';border-radius:var(--r-card,22px);padding:15px 16px;margin-bottom:9px">' +
      '<div style="display:flex;align-items:baseline;gap:9px;margin-bottom:6px">' +
      '<span style="flex:1;font-size:17.5px;font-weight:600;color:var(--t0);line-height:1.25;letter-spacing:-.015em">' + esc(c.titulo) + '</span>' +
      (c.venda ? '<span style="font-family:Space Mono,monospace;font-size:12px;color:var(--t2);flex:none">' + reais(c.venda) + '</span>' : '') +
      '</div>' +
      '<div style="font-size:13px;color:var(--t2);margin-bottom:6px;line-height:1.35">' + sig(String(c.nome).slice(0, 70)) + '</div>' +
      '<div style="font-size:15px;color:var(--t1);line-height:1.5">' + esc(c.texto) + '</div>' +
      // O veredito diz O QUE; o funil mostra ONDE. Sem ele o analista sabe
      // que ha problema e precisa ir procurar em qual degrau.
      funilDoProduto(c.id) +
      // o texto mandava tocar em comparar e o botao so existia no card
      // completo: agora ele esta aqui, onde a pessoa esta olhando
      renderComparacao(c.id) +
      (c.acao ? '<div style="font-size:14px;color:' + co.dot + ';margin-top:8px;line-height:1.45">\u2192 ' + esc(c.acao) + '</div>' : '') +
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
      // O cerebro julga so o que tem volume, mas o SELETOR precisa ter todos:
      // a pessoa escolhe qual produto quer analisar, nao a ferramenta.
      var julgados = {};
      for (var jc = 0; jc < doCerebro.length; jc++) julgados[doCerebro[jc].id] = 1;
      for (var idr in estado.produtos) {
        if (julgados[idr]) continue;
        var prr = estado.produtos[idr] || {}, mmr = prr.metricas || {};
        if (!ehProdutoDeVerdade(prr.nome)) continue;
        lidos.push({
          id: idr, nome: prr.nome || ('Produto ' + idr),
          venda: mmr.vendas_pagas || 0, nivel: 'cinza',
          titulo: 'Sem volume para julgar',
          texto: 'Este produto nao tem visitas suficientes no periodo para uma leitura confiavel. Ele aparece aqui para voce poder abrir e ver os numeros.',
          acao: ''
        });
      }
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
      h += '<select id="sia-prod-sel" style="width:100%;background:var(--b0);border:1px solid var(--li);border-radius:10px;padding:13px;color:var(--t0);font-family:inherit;font-size:14px;margin-bottom:11px">' +
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
    h += '<div class="nota">A leitura usa o funil que a Shopee entrega por produto. Produtos com menos de 100 visitantes ficam de fora do julgamento de proposito — abaixo disso, taxa e ruido.</div>';
    return h;
  }

  function render() {
    DICAS = {}; seqDica = 0;
    // A poda so rodava ao TROCAR de conta: quem ficou na mesma conta continuou
    // com as 847 acumuladas. Agora ela roda tambem no render, fora da coleta.
    if (estado.coletaProgresso === null) {
      var limpos = limparDeOutrasLojas();
      if (limpos) estado.sujo = true;
    }
    if (estado.coletaProgresso === null && Object.keys(estado.campanhas).length > 280) {
      estado.campanhas = podarCampanhas(estado.campanhas);
      estado.sujo = true;
    }
    try {
      var br2 = $('sia-recoletar');
      if (br2) {
        var rodando = estado.coletaProgresso !== null;
        br2.disabled = rodando;
        br2.textContent = rodando ? String(estado.coletaProgresso)
          : (Object.keys(estado.produtos).length ? 'Recoletar conta + Analisar' : 'Coletar conta completa + Analisar');
      }
    } catch (e) { /* noop */ }
    // ANTES DE REDESENHAR, guarda o que esta digitado nos campos. O render
    // recria o innerHTML e apagava tudo — era por isso que a calculadora
    // limpava sozinha assim que a tela atualizava.
    try {
      var vivos = $('sia-corpo') ? $('sia-corpo').querySelectorAll('input[data-calc],input[data-prec],input[data-custo]') : [];
      for (var vi = 0; vi < vivos.length; vi++) {
        var el2 = vivos[vi];
        if (el2.getAttribute('data-calc')) {
          var pc2 = el2.getAttribute('data-calc').split(':');
          estado.calcTmp[pc2[1]] = estado.calcTmp[pc2[1]] || {};
          estado.calcTmp[pc2[1]][pc2[0]] = el2.value;
        } else if (el2.getAttribute('data-prec')) {
          estado.precific[el2.getAttribute('data-prec')] = el2.value;
        }
      }
    } catch (e) { /* noop */ }
    if (!$('sia-painel').classList.contains('aberto')) return;
    // se por algum caminho a aba ativa virar um id de GRUPO (gprod, ferramentas)
    // ou um id desconhecido, nenhuma branch casa e a tela apaga. Cai no padrao.
    if (SUB[abaAtiva] && SUB[abaAtiva].length) abaAtiva = subAtiva[abaAtiva] || SUB[abaAtiva][0].id;
    // Rede de seguranca: aba desconhecida ou undefined volta para o Inicio.
    // Sem isto, abaAtiva undefined nao casava com nenhum branch e a gaveta
    // ficava em branco sem explicacao — foi o caso do Espiao.
    if (!abaAtiva || TELAS_VALIDAS.indexOf(abaAtiva) < 0) {
      try { console.warn('[Seller.IA] aba sem tela:', abaAtiva); } catch (e) { }
      abaAtiva = 'conta360';
    }
    renderAbas();
    var corpo = $('sia-corpo');
    var nC = Object.keys(estado.campanhas).length;
    var nP = Object.keys(estado.produtos).length;
    var lojaTxt = estado.loja ? (estado.loja.nome || ('loja ' + estado.loja.shop_id)) : 'identificando a loja...';
    $('sia-info').innerHTML = '<span class="sigilo">' + esc(lojaTxt) + '</span>' + ' · ' + nC + ' campanhas · ' + nP + ' produtos' + (lidoHa() ? ' · lido ' + lidoHa() : '');

    if (abaAtiva === 'semaforo') {
      corpo.innerHTML = renderAvisoLeitura() + renderBannerConta() + renderSemaforo() + renderChamadaCerebro();
      ligarBannerConta();
      ligarChamadaCerebro();
      return;
    }

    if (abaAtiva === 'palavras') {
      try {
        corpo.innerHTML = capa('O QUE O COMPRADOR PROCURA', 'AS', 'PALAVRAS', '06') + renderPalavras();
        var kb = $('sia-kw-busca');
        if (kb) kb.addEventListener('input', function () { estado.buscaPalavra = kb.value; estado.sujo = true; });
        var kc = $('sia-kw-coletar');
        if (kc) kc.addEventListener('click', function () {
          if (estado.coletaProgresso !== null) return;
          coletaCompleta(function () { render(); }, null, 'profunda');
          render();
        });
      } catch (err) { corpo.innerHTML = telaDeErro('Palavras', err); }
      return;
    }
    if (abaAtiva === 'marketing') {
      try { corpo.innerHTML = capa('CUPONS E PROMOCOES', 'O', 'MARKETING', '04') + renderMarketing(); }
      catch (err) { corpo.innerHTML = telaDeErro('Marketing', err); }
      return;
    }
    if (abaAtiva === 'semanal') {
      try { corpo.innerHTML = capa('OS ULTIMOS 7 DIAS', 'O', 'SEMANAL', '07') + renderSemanal(); }
      catch (err) { corpo.innerHTML = telaDeErro('Semanal', err); }
      return;
    }
    if (abaAtiva === 'relatorio') {
      // estado orfao de uma tentativa anterior travava o botao para sempre
      if (estado.rel.gerando && !estado.rel.etapa) estado.rel.gerando = false;
      corpo.innerHTML = renderRelatorio();
      ligarRelatorio();
      return;
    }
    if (abaAtiva === 'conta360') {
      corpo.innerHTML = capa('COMO A LOJA ESTA', 'CONTA', '360', '01') + renderAvisoPeriodo() +
        renderFunilLoja() + leituraDaConta() + renderOrigem() + renderPerdaPosPedido() + renderConta360();
      ligarBotaoColeta();
      ligarProfunda();
      return;
    }

    if (abaAtiva === 'calc') {
      corpo.innerHTML = capa('POR QUANTO VENDER', 'A', 'PRECIFICACAO', '05') + renderSubAbas('cofre') + renderCalculadora();
      ligarCalculadora();
      return;
    }

    if (abaAtiva === 'cofre') {
      // O Cofre virou calculadora de precificacao: a lista de custos foi para
      // o card do Ads, onde a decisao acontece.
      corpo.innerHTML = capa('POR QUANTO VENDER', 'A', 'PRECIFICACAO', '05') + renderSubAbas('cofre') + renderPrecificacao();
      var pi = corpoEl().querySelectorAll('[data-prec]');
      for (var pj = 0; pj < pi.length; pj++) {
        pi[pj].addEventListener('input', function () {
          estado.precific = estado.precific || {};
          estado.precific[this.getAttribute('data-prec')] = this.value;
        });
        pi[pj].addEventListener('change', function () { estado.sujo = true; });
      }
      ligarCofre();
      return;
    }

    if (abaAtiva === 'card') {
      corpo.innerHTML = renderCard6();
      return;
    }

    if (abaAtiva === 'performance') {
      try {
      // Estava numa cadeia else-if la embaixo que nunca era alcancada, porque
      // todos os branches acima usam if + return. Aba abria em branco.
      corpo.innerHTML = renderPerformanceIA();
      ligarChamadaCerebro();
      var psSel = $('sia-prod-sel');
      if (psSel) psSel.addEventListener('change', function () { estado.prodSel = psSel.value; render(); });
      } catch (err) { corpo.innerHTML = telaDeErro('Funil de Produto', err); }
      return;
    }
    if (abaAtiva === 'espiao') {
      // Uma excecao aqui deixava a aba TOTALMENTE em branco, sem pista
      // nenhuma do motivo — foi assim com espRodarRadar. Agora o erro
      // aparece na tela com o arquivo e a linha.
      try {
        corpo.innerHTML = renderEspiao();
        ligarEspiao();
      } catch (err) {
        corpo.innerHTML = telaDeErro('Espiao', err);
      }
      return;
    }

    if (abaAtiva === 'diagnostico') {
      // A aba so despejava o JSON cru dos vereditos. Um especialista nao
      // entrega o dado bruto: ele diz o que esta acontecendo, por que, e o
      // que fazer primeiro. Agora ela ordena por dinheiro em jogo e escreve.
      // A fila de acao vivia no Inicio e agora vem para ca, junto do resto da
      // analise: a Karina apontou que havia leitura espalhada em duas telas.
      corpo.innerHTML = capa('A ANALISE COMPLETA', 'O', 'ESPECIALISTA', '07') + renderEspecialista() + renderSemaforo();
      ligarChamadaCerebro();
      ligarCalculadora();
      var be = $('sia-coletar-tudo');
      if (be) be.addEventListener('click', function () {
        if (estado.coletaProgresso !== null) return;
        coletaCompleta(function () { render(); });
      });
      return;
    }
    if (abaAtiva === 'visao') {
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
      // ativas por padrao; pausadas so quando a pessoa pede, e ordenadas
      // por retorno, que e o que interessa numa campanha parada
      var idsC = Object.keys(estado.campanhas).filter(function (k) {
        var e3 = String((estado.campanhas[k] && (estado.campanhas[k].estado || estado.campanhas[k].state)) || '').toLowerCase();
        var pausada = (e3 === 'paused' || e3 === 'ended' || e3 === 'closed');
        return estado.verPausadas ? pausada : !pausada;
      });
      if (estado.verPausadas) {
        idsC.sort(function (a, b) {
          function ret(x) {
            var m = (estado.campanhas[x] && estado.campanhas[x].metricas) || {};
            return (m.gasto || 0) * (m.roas || 0);
          }
          return ret(b) - ret(a);
        });
      }
      if (!idsC.length) {
        corpo.innerHTML = capa('ONDE O DINHEIRO ESTA INDO', 'SHOPEE', 'ADS', '03') + '<div class="vazio">Nada lido ainda. Navegue pela tela de <b>Shopee Ads</b>.</div>' + renderImportador();
      ligarImportador();
        return;
      }
      if (!estado.verPausadas) {
        idsC.sort(function (a, b) { return (estado.campanhas[b].metricas.gasto || 0) - (estado.campanhas[a].metricas.gasto || 0); });
      }

      // CARDS EM VEZ DE TABELA: tabela mostra numeros lado a lado e deixa a
      // leitura para o analista. Cada campanha vira um card com veredito,
      // as metricas que sustentam e o que fazer.
      // TOP 5 DE CADA LADO por investimento contra retorno, mais um seletor
      // para abrir qualquer outra. Despejar 300 cards nao ajuda ninguem.
      function lucroDe2(k) {
        var m3 = estado.campanhas[k].metricas || {};
        if (!m3.gasto) return null;
        var mg = margemMediaCofre() || 25;
        return m3.gasto * ((m3.roas || 0) * (mg / 100) - 1);
      }
      var comGasto = idsC.filter(function (k) { return (estado.campanhas[k].metricas || {}).gasto; });
      var ordL = comGasto.slice().sort(function (a, b) { return (lucroDe2(b) || 0) - (lucroDe2(a) || 0); });
      var melhores = ordL.slice(0, 5);
      var piores = ordL.slice(-5).reverse().filter(function (k) { return melhores.indexOf(k) < 0; });

      var h2 = '';
      // "ainda cedo para julgar" nao ocupa card inteiro: vira linha, porque
      // nao ha decisao a tomar ali ainda.
      var cedo = comGasto.filter(function (k) {
        var m4 = estado.campanhas[k].metricas || {};
        return (m4.pedidos || 0) === 0 && (m4.cliques || 0) < 40;
      });
      melhores = melhores.filter(function (k) { return cedo.indexOf(k) < 0; });
      piores = piores.filter(function (k) { return cedo.indexOf(k) < 0; });

      function cardSeguro(k) {
        try { return cardCampanha(k); }
        catch (e5) {
          try { console.error('[Seller.IA] card ' + k + ':', e5); } catch (e6) { }
          return '<div class="nota" style="color:var(--rd)">Nao consegui montar o card desta campanha: ' + esc(String(e5 && e5.message || e5)) + '</div>';
        }
      }
      if (piores.length) {
        h2 += olho('AS 5 QUE MAIS CUSTAM', 'Ordenado pelo resultado em reais: investimento contra o que voltou, ja descontada a margem. A primeira da lista e onde o dinheiro esta indo embora mais rapido.');
        for (var pj2 = 0; pj2 < piores.length; pj2++) h2 += cardSeguro(piores[pj2]);
      }
      if (melhores.length) {
        h2 += olho('AS 5 QUE MAIS RENDEM', 'As que devolvem mais em reais. Subir orcamento aqui e o crescimento mais barato que a conta tem.');
        for (var mj2 = 0; mj2 < melhores.length; mj2++) h2 += cardSeguro(melhores[mj2]);
      }

      // seletor para qualquer outra
      if (idsC.length > melhores.length + piores.length) {
        h2 += olho('ANALISAR OUTRA CAMPANHA', 'Escolha qualquer campanha da conta para ver a analise completa, com margem, leilao e palavras.');
        h2 += '<select id="sia-camp-sel" style="width:100%;background:var(--b0);border:1px solid var(--li);border-radius:9px;padding:12px;color:var(--t0);font-family:inherit;font-size:14px;margin-bottom:10px">' +
          '<option value="">Escolha uma campanha...</option>';
        var ordSel = idsC.slice().sort(function (a, b) {
          return ((estado.campanhas[b].metricas || {}).gasto || 0) - ((estado.campanhas[a].metricas || {}).gasto || 0);
        });
        for (var sj = 0; sj < ordSel.length; sj++) {
          var cS = estado.campanhas[ordSel[sj]], mS = cS.metricas || {};
          h2 += '<option value="' + esc(ordSel[sj]) + '"' + (estado.campSel === ordSel[sj] ? ' selected' : '') + '>' +
            esc(String(cS.nome || cS.titulo || ordSel[sj]).slice(0, 52)) + (mS.gasto ? ' \u00b7 ' + reais(mS.gasto) : '') + '</option>';
        }
        h2 += '</select>';
        if (estado.campSel && estado.campanhas[estado.campSel]) h2 += cardSeguro(estado.campSel);
      }
      if (cedo.length) {
        h2 += olho('AINDA SEM VOLUME PARA JULGAR (' + cedo.length + ')', 'Gastaram pouco e receberam poucos cliques: qualquer conclusao aqui seria chute. Ficam em lista simples ate terem volume.');
        for (var cj = 0; cj < Math.min(cedo.length, 12); cj++) {
          var kc2 = cedo[cj], cc2 = estado.campanhas[kc2], mc2 = cc2.metricas || {};
          h2 += '<div style="display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid var(--li);font-size:13px">' +
            '<span style="flex:1;min-width:0;color:var(--t2)">' + sig(String(cc2.nome || kc2).slice(0, 44)) + '</span>' +
            '<span style="font-family:Space Mono,monospace;font-size:11px;color:var(--t3)">' + reais(mc2.gasto || 0) + ' \u00b7 ' + fmt(mc2.cliques || 0, 0) + ' cliques</span></div>';
        }
        if (cedo.length > 12) h2 += '<div class="nota">e mais ' + (cedo.length - 12) + '.</div>';
      }
      if (!comGasto.length) h2 += '<div class="nota">Nenhuma campanha com investimento no periodo lido.</div>';

      // Cada bloco isolado: antes, um erro em qualquer um deles derrubava a
      // aba inteira e ela nao abria — que foi o que aconteceu.
      function seguro(fn, nome) {
        try { return fn(); }
        catch (e) {
          try { console.error('[Seller.IA] ' + nome + ':', e); } catch (e2) { }
          return '<div class="nota" style="color:var(--rd)">O bloco <b>' + esc(nome) + '</b> falhou: ' + esc(String(e && e.message || e)) + '</div>';
        }
      }
      h2 = capa('ONDE O DINHEIRO ESTA INDO', 'SHOPEE', 'ADS', '03') +
        seguro(renderPercentis, 'Percentis da categoria') +
        seguro(renderHoras, 'O dia hora a hora') +
        seguro(renderFiltroCampanhas, 'Filtro de campanhas') +
        h2 +
        seguro(renderImportador, 'Planilha do grupo');
      h2 += '<div class="nota">CPC e CPM sao derivados de gasto dividido por cliques e por impressoes: os campos cpc e cpm da API nao sao taxa e foram descartados. ROAS e o broad_roi da Shopee.</div>';
      corpo.innerHTML = h2;
      var csel = $('sia-camp-sel');
      if (csel) csel.addEventListener('change', function () { estado.campSel = this.value; estado.campExpandida = this.value; render(); });
      ligarCamposCalc();
      ligarImportador();

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
  ligarGravacao();
  try {
    chrome.runtime.sendMessage({ tipo: 'sia:pref-carregar', chave: 'anonKey' }, function (r) {
    void chrome.runtime.lastError;
    if (r && r.valor) { estado.anonKey = r.valor; }
  });
  chrome.runtime.sendMessage({ tipo: 'sia:pref-carregar', chave: 'temaEscuro' }, function (r) {
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
    // Nao re-renderizar enquanto a pessoa digita: o render recria o innerHTML
    // e o campo perde o texto e o foco no meio da frase.
    var focado = null;
    try { focado = raiz.activeElement; } catch (e) { /* noop */ }
    var digitando = focado && /^(INPUT|TEXTAREA|SELECT)$/.test(focado.tagName || '');
    if (digitando) return;
    if (estado.sujo && $('sia-painel').classList.contains('aberto')) { estado.sujo = false; render(); }
  }, 900);
})();

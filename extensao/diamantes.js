/**
 * Seller.IA — diamantes.js · Camada 1 (coleta do ouro)
 * ------------------------------------------------------
 * Recebe cada resposta bruta da API (via coletor) e extrai os "diamantes":
 * os campos que a Shopee esconde e que decodificamos ao longo do projeto.
 *
 * NAO altera nada. So le e organiza. Cada diamante guarda:
 *   valor bruto + valor legivel + de qual rota veio + quando.
 *
 * O coletor chama SIA_Diamantes.processar(url, dados) para cada resposta,
 * e SIA_Diamantes.estado() para ver tudo capturado (usado no Debug).
 */
(function () {
  'use strict';

  var VERSAO = '1.3.1';

  // ---- helpers ----
  function n(v) { return (typeof v === 'number') ? v : (v ? parseFloat(v) : null); }
  function real(micro) { // dinheiro Shopee vem em micro-unidades (÷100000)
    var x = n(micro);
    return (x === null || x === -1000000) ? null : x / 100000;
  }
  function pct(v) { var x = n(v); return x === null ? null : x; }
  // busca profunda: acha a primeira ocorrencia de uma chave em qualquer nivel
  function achar(obj, chave, prof) {
    prof = prof || 0;
    if (prof > 8 || obj == null || typeof obj !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, chave) && typeof obj[chave] !== 'object') return obj[chave];
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      if (v && typeof v === 'object') {
        var r = achar(v, chave, prof + 1);
        if (r !== undefined) return r;
      }
    }
    return undefined;
  }
  function acharObj(obj, chave, prof) { // acha um sub-objeto pelo nome
    prof = prof || 0;
    if (prof > 8 || obj == null || typeof obj !== 'object') return undefined;
    if (obj[chave] && typeof obj[chave] === 'object') return obj[chave];
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      if (v && typeof v === 'object') {
        var r = acharObj(v, chave, prof + 1);
        if (r !== undefined) return r;
      }
    }
    return undefined;
  }

  // ---- o cofre dos diamantes capturados ----
  var COFRE = {
    conta: {},       // saude, penalidade, percentil, fontes
    loja: {},        // rating, seguidores, tag, resposta chat
    ads: {},         // meta roas, estrategia, cpm, leilao, gasto, creditos
    algoritmo: {},   // regras do oCPM: cold start, limites de mudanca, minimos de lance, percentis
    incentivos: {},  // creditos gratis, metas de gasto, surge
    porProduto: {},  // { itemid: { ...diamantes do produto } }
    porCampanha: {}, // { campaign_id: { veredito, motivo, report completo } }
    busca: {},       // { keyword: [ resultados ] }
    _log: []         // rastro do que foi capturado (Debug)
  };

  function logar(diamante, valor, rota) {
    COFRE._log.unshift({ d: diamante, v: valor, rota: (rota || '').split('?')[0], ts: Date.now() });
    if (COFRE._log.length > 120) COFRE._log.pop();
  }

  // =========================================================
  // EXTRATORES — um por familia de rota
  // =========================================================

  // 1) LEILAO + META ROAS (criacao de campanha, recomendacoes)
  function exLeilaoRoas(url, d) {
    // CPM real + posicao no leilao (get_time_graph = retrato do leilao no tempo)
    // O campo "cpm" da API vem inflado (~igual ao cost). Calculamos o CPM certo
    // pelo agregado: custo total / impressoes totais * 1000.
    var avgRank = achar(d, 'avg_rank');
    var dObj = (d && d.data) ? d.data : {};
    var agg = dObj.report_aggregate || null;
    if (agg && /time_graph|report/.test(url)) {
      COFRE.ads.leilao = COFRE.ads.leilao || {};
      var gastoTot = agg.cost != null ? real(agg.cost) : null;
      var imprTot = agg.impression != null ? n(agg.impression) : null;
      if (gastoTot != null && imprTot) {
        COFRE.ads.leilao.cpmReal = Math.round((gastoTot / imprTot * 1000) * 100) / 100; // R$ por mil impressoes
      }
      if (agg.avg_rank != null) COFRE.ads.leilao.posicaoMedia = n(agg.avg_rank);
      else if (avgRank != null) COFRE.ads.leilao.posicaoMedia = n(avgRank);
      var cpcAgg = agg.cost != null && agg.click ? real(agg.cost) / n(agg.click) : null;
      if (cpcAgg != null) COFRE.ads.leilao.cpc = Math.round(cpcAgg * 100) / 100;
      logar('leilao_cpm', 'CPM R$' + (COFRE.ads.leilao.cpmReal || '?') + ' pos ' + (COFRE.ads.leilao.posicaoMedia || '?'), url);
    } else if (avgRank != null && /time_graph|report/.test(url)) {
      COFRE.ads.leilao = COFRE.ads.leilao || {};
      COFRE.ads.leilao.posicaoMedia = n(avgRank);
    }
    // permissao de lance por preco (prova do oCPM: se false, lance manual acabou)
    var permBid = achar(d, 'has_price_bidding_permission');
    if (permBid !== undefined) { COFRE.ads.lancePorPrecoLiberado = !!permBid; }
    // gasto real da campanha
    var hoje = achar(d, 'today_expense');
    var media7 = achar(d, 'avg_seven_day_expense');
    if (hoje != null || media7 != null) {
      COFRE.ads.gasto = COFRE.ads.gasto || {};
      if (hoje != null) COFRE.ads.gasto.hoje = real(hoje);
      if (media7 != null) COFRE.ads.gasto.mediaSeteDias = real(media7);
      logar('gasto_ads', 'hoje R$' + (COFRE.ads.gasto.hoje || '?'), url);
    }

    // meta de ROAS com percentis: get_recommended_target_roi / get_recommended_roi_two_target
    var exact = acharObj(d, 'exact');
    if (exact && exact.value != null) {
      var lb = acharObj(d, 'lower_bound') || {};
      var ub = acharObj(d, 'upper_bound') || {};
      COFRE.ads.metaRoas = {
        sugerido: real(exact.value) ? (exact.value / 100000) : n(exact.value) / 100000,
        // valores vem tipo 510000 = 5,1x  -> /100000
        exato: n(exact.value) / 100000,
        agressivo: ub.value != null ? n(ub.value) / 100000 : null,   // percentil 20 = mais conservador no ROAS
        conservador: lb.value != null ? n(lb.value) / 100000 : null,
        teto: achar(d, 'hard_upper_bound') != null ? n(achar(d, 'hard_upper_bound')) / 100000 : null
      };
      logar('meta_roas_sugerida', COFRE.ads.metaRoas.exato + 'x', url);
    }
    // projecao de uplift: get_estimated_auto_ads_data
    var gmvUp = achar(d, 'gmv_uplift_pct');
    var ordUp = achar(d, 'order_uplift_pct');
    if (gmvUp != null || ordUp != null) {
      COFRE.ads.projecao = {
        gmvUpliftPct: gmvUp != null ? n(gmvUp) / 1000 : null,   // 30000 = 30%
        orderUpliftPct: ordUp != null ? n(ordUp) / 1000 : null
      };
      logar('projecao_uplift', COFRE.ads.projecao.gmvUpliftPct + '%', url);
    }
    // orcamento recomendado: get_budget_data_for_creation
    var rec = achar(d, 'recommended');
    if (rec != null && /budget/.test(url)) {
      COFRE.ads.orcamentoRecomendado = real(rec);
      logar('orcamento_recomendado', 'R$' + COFRE.ads.orcamentoRecomendado, url);
    }
    // elegibilidade de estrategia
    var elig = acharObj(d, 'auto');
    if (elig && elig.is_eligible !== undefined && /bidding_strategy_eligibility/.test(url)) {
      COFRE.ads.elegibilidade = {
        autoLiberado: !!elig.is_eligible,
        motivo: elig.reason || null
      };
      logar('elegibilidade_lance', elig.is_eligible ? 'auto ok' : ('auto bloqueado: ' + elig.reason), url);
    }
  }

  // 2) DIAGNOSTICO OFICIAL POR CAMPANHA (good/fair/poor + motivo)
  function exDiagnostico(url, d) {
    var dataObj = acharObj(d, 'data') || {};
    var entradas = Array.isArray(dataObj.entry_list) ? dataObj.entry_list : null;
    if (Array.isArray(entradas)) {
      entradas.forEach(function (e) {
        if (!e || e.campaign_id == null) return;
        var vs = (e.verdict_list || []).map(function (v) { return { eixo: v.type, nota: v.result, motivo: v.issue }; });
        var pc = COFRE.porCampanha[e.campaign_id] || {};
        pc.nota = (e.summary && e.summary.result) || pc.nota || null;
        pc.problema = (e.summary && e.summary.main_issue) || pc.problema || null;
        pc.eixos = vs;
        COFRE.porCampanha[e.campaign_id] = pc;
      });
      logar('diagnostico_campanhas', entradas.length + ' campanhas', url);
    } else if (dataObj.verdict_list) {
      var vs2 = dataObj.verdict_list.map(function (v) { return { eixo: v.type, nota: v.result, motivo: v.issue }; });
      var pc2 = COFRE.porCampanha[dataObj.campaign_id || 'atual'] || {};
      pc2.nota = (dataObj.summary && dataObj.summary.result) || pc2.nota;
      pc2.eixos = vs2;
      COFRE.porCampanha[dataObj.campaign_id || 'atual'] = pc2;
      logar('diagnostico_campanha', (dataObj.summary && dataObj.summary.result) || '?', url);
    }
  }

  // 3) PRODUTO — deboost, aprendizado, competitividade, leilao, listing, janela
  function exProduto(url, d) {
    var pinfo = acharObj(d, 'product_info');
    var itemid = pinfo ? pinfo.id : achar(d, 'itemid');
    if (itemid == null) itemid = achar(d, 'item_id');
    if (itemid == null) return;
    itemid = String(itemid);
    var p = COFRE.porProduto[itemid] || {};

    // janela de produto novo
    var np = achar(d, 'new_product_period');
    if (np != null) { p.janelaNovoDias = n(np); p.publicadoEm = achar(d, 'first_publish_time'); }
    // deboost / boosting
    var bs = achar(d, 'boosting_status');
    if (bs != null) p.status = bs; // normal / deboost
    // aprendizado
    var cs = achar(d, 'cold_start_duration');
    if (cs != null) { p.aprendizadoDias = n(cs); p.emAprendizado = !!achar(d, 'is_cold_start'); }
    // competitividade
    var comp = achar(d, 'competitiveness');
    if (comp != null) p.competitividade = n(comp);
    // posicao no leilao
    var rank = achar(d, 'avg_rank');
    if (rank != null) p.posicaoLeilao = n(rank);
    // cpm
    var cpm = achar(d, 'cpm');
    if (cpm != null) p.cpm = real(cpm);

    if (Object.keys(p).length) {
      COFRE.porProduto[itemid] = p;
      logar('produto', itemid + ' ' + (p.status || '') + (p.posicaoLeilao ? (' pos ' + p.posicaoLeilao) : ''), url);
    }
  }

  // 4) SAUDE DA CONTA — penalidade, rating, percentil
  function exConta(url, d) {
    var pen = achar(d, 'penalty_point');
    if (pen != null) COFRE.conta.penalidade = n(pen);
    var rating = achar(d, 'performance_rating');
    if (rating != null) COFRE.conta.notaPerformance = rating;
    var star = achar(d, 'rating_star');
    if (star != null) COFRE.conta.estrelas = n(star);
    var perc = achar(d, 'percentile');
    if (perc != null) COFRE.conta.percentilCategoria = n(perc);
    if (pen != null || rating != null || perc != null) logar('saude_conta', 'pen ' + (pen != null ? pen : '?'), url);
  }

  // 5) FONTES (proporcao ads/afiliado/organico)
  function exFontes(url, d) {
    var pa = achar(d, 'paid_ads_ratio');
    var af = achar(d, 'affiliate_ratio');
    var pc = achar(d, 'product_card_ratio');
    if (pa != null || af != null) {
      COFRE.conta.fontes = {
        adsPct: pa != null ? Math.round(n(pa) * 100) : null,
        afiliadoPct: af != null ? Math.round(n(af) * 100) : null,
        cardPct: pc != null ? Math.round(n(pc) * 100) : null
      };
      logar('fontes', 'ads ' + COFRE.conta.fontes.adsPct + '%', url);
    }
  }

  // 6) BUSCA PUBLICA (sondador) — concorrencia + faturamento estimado
  function exBusca(url, d) {
    if (!/search_items/.test(url)) return;
    var m = url.match(/keyword=([^&]+)/);
    var kw = m ? decodeURIComponent(m[1]) : 'busca';
    var itens = (d && d.items) || [];
    if (!itens.length) return;
    var lista = itens.map(function (it, i) {
      var data = it.item_data || {};
      var asset = it.item_card_displayed_asset || {};
      var dp = data.item_card_display_price || {};
      var sc = data.item_card_display_sold_count || {};
      var preco = dp.price != null ? n(dp.price) / 100000 : null;
      var mensal = sc.monthly_sold_count != null ? n(sc.monthly_sold_count) : null;
      var voucher = data.recommended_shop_voucher_info || dp.recommended_shop_voucher_info || null;
      return {
        pos: i + 1,
        nome: asset.name || '',
        shopid: data.shopid,
        itemid: data.itemid,
        preco: preco,
        desconto: dp.discount != null ? n(dp.discount) : null,
        cupom: voucher ? (voucher.voucher_code || 'sim') : null,
        vendidoTotal: sc.historical_sold_count != null ? n(sc.historical_sold_count) : null,
        vendidoMes: mensal,
        faturamentoMesEstimado: (mensal != null && preco != null) ? Math.round(mensal * preco) : null,
        curtidas: data.liked_count != null ? n(data.liked_count) : null,
        anuncio: !!it.adsid
      };
    });
    COFRE.busca[kw] = { quando: Date.now(), total: lista.length, itens: lista };
    logar('busca', '"' + kw + '" ' + lista.length + ' resultados', url);
  }

  // 7) REPORT COMPLETO POR CAMPANHA (homepage/query e report/get) — o retrato do leilao
  function exReportCampanha(url, d) {
    // homepage/query: entry_list com report + ratio por campanha
    var entry = acharObj(d, 'entry_list');
    var reports = [];
    if (entry) {
      // pode ser array (varias campanhas) ou objeto
      var lista = Array.isArray(entry) ? entry : [entry];
      lista.forEach(function (e) {
        var camp = (e.campaign && e.campaign.campaign_id) || e.campaign_id;
        var rep = e.report; var rat = e.ratio;
        if (camp && rep) reports.push({ camp: String(camp), rep: rep, rat: rat, roiTarget: e.campaign && e.campaign.roi_two_target, sub: e.subtype, estado: e.state, titulo: e.title });
      });
    }
    // report/get e get_time_graph: um so, com data.key = campaign_id
    var dObj = acharObj(d, 'data') || {};
    if (dObj.metrics && dObj.key) reports.push({ camp: String(dObj.key), rep: dObj.metrics, rat: dObj.ratio });
    var agg = dObj.report_aggregate;
    if (agg && dObj.key) reports.push({ camp: String(dObj.key), rep: agg, rat: null });

    reports.forEach(function (r) {
      var pc = COFRE.porCampanha[r.camp] || {};
      var rep = r.rep;
      // CPM real = custo / impressoes * 1000. O campo "cpm" da API vem inflado
      // (quase igual ao cost), entao calculamos do jeito classico e correto.
      var gastoReais = rep.cost != null ? real(rep.cost) : null;
      var impr = rep.impression != null ? n(rep.impression) : null;
      var cpmReal = (gastoReais != null && impr) ? (gastoReais / impr * 1000) : (pc.leilao && pc.leilao.cpm);
      pc.leilao = {
        posicao: rep.avg_rank != null ? n(rep.avg_rank) : (pc.leilao && pc.leilao.posicao),
        cpm: cpmReal != null ? Math.round(cpmReal * 100) / 100 : null, // R$ por mil impressoes, 2 casas
        cpc: rep.cpc != null ? real(rep.cpc) : null,
        custoPosicao: rep.location_in_ads != null ? real(rep.location_in_ads) : null, // custo da posicao no anuncio
        sov: rep.sov != null ? n(rep.sov) : null, // share of voice
        gasto: gastoReais
      };
      pc.funil = {
        impressoes: rep.impression != null ? n(rep.impression) : null,
        cliques: rep.click != null ? n(rep.click) : null,
        ctr: rep.ctr != null ? n(rep.ctr) : null,
        atc: rep.atc != null ? n(rep.atc) : null,
        atcRate: rep.atc_rate != null ? n(rep.atc_rate) : null,
        checkout: rep.checkout != null ? n(rep.checkout) : null,
        checkoutRate: rep.checkout_rate != null ? n(rep.checkout_rate) : null,
        cr: rep.cr != null ? n(rep.cr) : null,
        pageViews: rep.page_views != null ? n(rep.page_views) : null
      };
      pc.resultado = {
        roiAmplo: rep.broad_roi != null ? n(rep.broad_roi) : null,
        roiDireto: rep.direct_roi != null ? n(rep.direct_roi) : null,
        gmvAmplo: rep.broad_gmv != null ? real(rep.broad_gmv) : null,
        pedidos: rep.broad_order != null ? n(rep.broad_order) : null,
        cir: rep.broad_cir != null ? n(rep.broad_cir) : null // custo sobre receita
      };
      if (r.roiTarget != null) pc.roiTargetAtual = n(r.roiTarget) / 100000;
      if (r.titulo) pc.titulo = r.titulo;
      if (r.estado) pc.estado = r.estado;
      COFRE.porCampanha[r.camp] = pc;
    });
    if (reports.length) logar('report_campanha', reports.length + ' campanha(s) com leilao', url);
  }

  // 8) DIAGNOSTICO COM META SUGERIDA (a Shopee te diz o ROAS ideal por campanha)
  function exMetaSugerida(url, d) {
    function pega(entry) {
      if (!entry) return;
      var camp = entry.campaign_id;
      var vl = entry.verdict_list;
      var vlist = Array.isArray(vl) ? vl : (vl ? [vl] : []);
      if (!vlist.length) return; // campanha sem sugestao (boa)
      vlist.forEach(function (v) {
        var f = v && v.data && v.data.integer_field;
        if (!f) return;
        var pc = COFRE.porCampanha[camp || 'atual'] || {};
        pc.metaShopee = {
          atual: f.current_roi_two_target != null ? n(f.current_roi_two_target) / 100000 : null,
          sugerida: f.suggested_roi_two_target != null ? n(f.suggested_roi_two_target) / 100000 : null,
          ganhoGmvPct: f.estimate_gmv_pct != null ? n(f.estimate_gmv_pct) / 1000 : null,
          ganhoPedidosPct: f.estimate_order_pct != null ? n(f.estimate_order_pct) / 1000 : null,
          problema: v.issue,
          nota: v.result
        };
        COFRE.porCampanha[camp || 'atual'] = pc;
      });
    }
    var data = d && d.data ? d.data : {};
    if (Array.isArray(data.entry_list)) data.entry_list.forEach(pega);
    else if (data.verdict_list) pega({ campaign_id: data.campaign_id, verdict_list: data.verdict_list });
    var comMeta = Object.keys(COFRE.porCampanha).filter(function (k) { return COFRE.porCampanha[k].metaShopee; }).length;
    if (comMeta) logar('meta_sugerida', comMeta + ' campanhas com meta ideal', url);
  }

  // 9) REGRAS DO ALGORITMO (config/get) — como o oCPM funciona por dentro
  function exAlgoritmo(url, d) {
    var data = d && d.data ? d.data : d;
    var cfg = data && data.ads_config ? data.ads_config : acharObj(d, 'ads_config');
    if (!cfg) return;
    var r2 = cfg.roi_two || {};
    var cps = r2.cps || {};
    var alg = {
      metaRoas: {
        aprendizadoDias: r2.cold_start_duration != null ? n(r2.cold_start_duration) : null,
        mudancaMaxPct: cps.change_target_roi_ratio_pct != null ? n(cps.change_target_roi_ratio_pct) : null,
        mudancasPorDia: cps.change_target_roi_daily_limit != null ? n(cps.change_target_roi_daily_limit) : null,
        bloqueioDias: cps.campaign_block_period_days != null ? n(cps.campaign_block_period_days) : null,
        tetoMultiplicador: cps.max_limit_multiplier != null ? n(cps.max_limit_multiplier) : null
      },
      percentis: r2.recommendation_percentiles || (cfg.target_roi && cfg.target_roi.recommendation_percentiles) || null,
      notaMinimaAuto: (cfg.shop_ads && cfg.shop_ads.auto_whitelist_min_rating != null) ? n(cfg.shop_ads.auto_whitelist_min_rating) / 10 : null
    };
    // lance minimo real vem de data.bid_price
    var bp = data && data.bid_price ? data.bid_price : null;
    if (bp && bp.search_product && bp.search_product.exact_match) {
      alg.lanceMinimo = {
        buscaProduto: real(bp.search_product.exact_match.min),
        buscaLoja: bp.search_shop && bp.search_shop.exact_match ? real(bp.search_shop.exact_match.min) : null,
        passo: real(bp.search_product.exact_match.step)
      };
    }
    // funde (algumas chamadas de config nao trazem bid_price)
    COFRE.algoritmo = Object.assign({}, COFRE.algoritmo, alg);
    if (alg.lanceMinimo) COFRE.algoritmo.lanceMinimo = alg.lanceMinimo;
    logar('algoritmo', 'regras do oCPM capturadas', url);
  }

  // 10) CREDITOS E INCENTIVOS (dinheiro gratis de ads)
  function exIncentivos(url, d) {
    var cr = acharObj(d, 'ads_credit');
    if (cr) {
      COFRE.ads.creditos = {
        total: real(cr.total),
        vencendo30d: cr.expiring_in_30d != null ? real(cr.expiring_in_30d) : null,
        statusSaldo: cr.low_balance_status
      };
      logar('creditos', 'R$' + (COFRE.ads.creditos.total || '?') + ' em credito', url);
    }
    var inc = acharObj(d, 'incentive_list');
    if (inc) {
      var ext = inc.extinfo && inc.extinfo.sustained_abi;
      if (ext) {
        COFRE.incentivos.metaGasto = {
          gasteParaGanhar: real(ext.target_spending_amount),
          recompensa: real(ext.fixed_reward_amount),
          jaGastou: real(ext.total_spending_amount),
          tipo: inc.incentive_type,
          fim: ext.activate_deadline_time
        };
        logar('incentivo', 'gaste R$' + (COFRE.incentivos.metaGasto.gasteParaGanhar || '?') + ' ganhe R$' + (COFRE.incentivos.metaGasto.recompensa || '?'), url);
      }
    }
    // smart booster (campaign surge)
    var sb = acharObj(d, 'campaign_surge');
    if (sb && sb.uplift) {
      COFRE.incentivos.surge = {
        upliftGmvPct: sb.uplift.gmv != null ? n(sb.uplift.gmv) / 1000 : null,
        upliftPedidosPct: sb.uplift.order != null ? n(sb.uplift.order) / 1000 : null
      };
    }
  }

  // 11) SAUDE DA LOJA (rating, seguidores, tag, resposta)
  function exLoja(url, d) {
    var pv = acharObj(d, 'data');
    if (!pv || !/shop\/get_preview_data/.test(url)) return;
    COFRE.loja = {
      rating: pv.shop_rating != null ? n(pv.shop_rating) : null,
      avaliacoes: pv.rating_count != null ? n(pv.rating_count) : null,
      seguidores: pv.shop_follower != null ? n(pv.shop_follower) : null,
      seguindo: pv.shop_following != null ? n(pv.shop_following) : null,
      itens: pv.item_count != null ? n(pv.item_count) : null,
      tag: pv.shop_tag,
      taxaRespostaChat: pv.chat_response_rate != null ? n(pv.chat_response_rate) : null
    };
    logar('loja', 'rating ' + (COFRE.loja.rating || '?') + ' · ' + (COFRE.loja.tag || ''), url);
  }

  // ---- roteador: decide qual extrator roda pra cada rota ----
  function processar(url, dados) {
    if (!url || !dados) return;
    try {
      if (/get_recommended_target_roi|recommended_roi_two_target|estimated_auto_ads_data|budget_data_for_creation|bidding_strategy_eligibility|report\/get_time_graph|campaign_expense_statistics|price-bidding-product-permission/.test(url)) exLeilaoRoas(url, dados);
      if (/homepage\/query|report\/get(_time_graph)?(\/|$|\?)/.test(url)) exReportCampanha(url, dados);
      if (/diagnosis\/(list_verdict|homepage_batch_list_verdict)/.test(url)) { exDiagnostico(url, dados); exMetaSugerida(url, dados); }
      if (/config\/get/.test(url)) exAlgoritmo(url, dados);
      if (/meta\/get_ads_data|incentive\/query|sc_pc_homepage\/adopter\/list_incentive|smart_booster\/get/.test(url)) exIncentivos(url, dados);
      if (/shop\/get_preview_data/.test(url)) exLoja(url, dados);
      if (/product\/get_product_info|get_product_recommend|ads.*product|product.*ads|homepage\/query/.test(url)) exProduto(url, dados);
      if (/penalty|performance|account.*health|shop\/get/.test(url)) { exConta(url, dados); exProduto(url, dados); }
      if (/overview|meta\/get_non_ads|meta\/get_ads/.test(url)) { exFontes(url, dados); exProduto(url, dados); }
      if (/search_items/.test(url)) exBusca(url, dados);
      // varredura ampla de produto: muitas rotas trazem avg_rank/competitiveness soltos
      if (achar(dados, 'avg_rank') != null || achar(dados, 'competitiveness') != null || achar(dados, 'boosting_status') != null) exProduto(url, dados);
      persistir(); // salva no background pra somar entre Seller Central e Loja
    } catch (e) { /* nunca derruba a coleta */ }
  }

  function estado() { return COFRE; }
  function resumo() {
    return {
      metaRoas: COFRE.ads.metaRoas || null,
      projecao: COFRE.ads.projecao || null,
      leilao: COFRE.ads.leilao || null,
      gasto: COFRE.ads.gasto || null,
      creditos: COFRE.ads.creditos || null,
      lancePorPrecoLiberado: COFRE.ads.lancePorPrecoLiberado,
      algoritmo: COFRE.algoritmo && Object.keys(COFRE.algoritmo).length ? COFRE.algoritmo : null,
      incentivos: COFRE.incentivos && Object.keys(COFRE.incentivos).length ? COFRE.incentivos : null,
      loja: COFRE.loja && Object.keys(COFRE.loja).length ? COFRE.loja : null,
      conta: COFRE.conta,
      produtos: Object.keys(COFRE.porProduto).length,
      campanhasDiagnosticadas: Object.keys(COFRE.porCampanha).length,
      buscas: Object.keys(COFRE.busca),
      capturas: COFRE._log.length
    };
  }

  // ---- persistencia entre paginas/sites (via background) ----
  // Sem isto, ir do Seller Central pra Loja Shopee zera o cofre (memorias separadas).
  var salvarAgendado = null;
  function persistir() {
    if (salvarAgendado) return;
    salvarAgendado = setTimeout(function () {
      salvarAgendado = null;
      try {
        chrome.runtime.sendMessage({
          tipo: 'sia:diamantes-salvar',
          cofre: { conta: COFRE.conta, loja: COFRE.loja, ads: COFRE.ads, algoritmo: COFRE.algoritmo, incentivos: COFRE.incentivos, porProduto: COFRE.porProduto, porCampanha: COFRE.porCampanha, busca: COFRE.busca }
        }, function () { void chrome.runtime.lastError; });
      } catch (e) { /* noop */ }
    }, 600);
  }
  function carregar() {
    try {
      chrome.runtime.sendMessage({ tipo: 'sia:diamantes-carregar' }, function (r) {
        void chrome.runtime.lastError;
        if (r && r.ok && r.cofre) {
          COFRE.conta = Object.assign({}, r.cofre.conta || {}, COFRE.conta);
          COFRE.loja = Object.assign({}, r.cofre.loja || {}, COFRE.loja);
          COFRE.algoritmo = Object.assign({}, r.cofre.algoritmo || {}, COFRE.algoritmo);
          COFRE.incentivos = Object.assign({}, r.cofre.incentivos || {}, COFRE.incentivos);
          COFRE.ads = Object.assign({}, r.cofre.ads || {}, COFRE.ads);
          COFRE.porProduto = Object.assign({}, r.cofre.porProduto || {}, COFRE.porProduto);
          COFRE.porCampanha = Object.assign({}, r.cofre.porCampanha || {}, COFRE.porCampanha);
          COFRE.busca = Object.assign({}, r.cofre.busca || {}, COFRE.busca);
        }
      });
    } catch (e) { /* noop */ }
  }
  carregar(); // ao iniciar, recupera o que ja foi capturado em outras paginas

  window.SIA_Diamantes = { versao: VERSAO, processar: processar, estado: estado, resumo: resumo, persistir: persistir, carregar: carregar };
})();

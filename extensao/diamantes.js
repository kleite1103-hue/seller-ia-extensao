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

  var VERSAO = '1.4.5';

  // ---- helpers ----
  function n(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v == null || v === '') return null;
    var x = parseFloat(v);
    return isFinite(x) ? x : null;
  }
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
    origem: null,    // de onde vem cada venda, por canal
    tendencia: null, // evolucao diaria da loja + perda pos-pedido
    marketing: null, // cupons, oferta relampago e descontos, com mtime
    vinculoItemCampanha: {}, // item -> campanha, para o veredito de anuncio
    loja: {},        // rating, seguidores, tag, resposta chat
    ads: {},         // meta roas, estrategia, cpm, leilao, gasto, creditos
    algoritmo: {},   // regras do oCPM: cold start, limites de mudanca, minimos de lance, percentis
    incentivos: {},  // creditos gratis, metas de gasto, surge
    porProduto: {},  // { itemid: { ...diamantes do produto } }
    porCampanha: {}, // { campaign_id: { veredito, motivo, report completo } }
    busca: {},       // { keyword: [ resultados ] }
    // ---- CEREBRO GERAL (6 inteligencias) ----
    gerenciais: {},  // 1) PV, UV, GMV, pedidos, cancelamentos, reembolsos (com variacao e serie)
    funil: {},       // 2) origem do dinheiro: card/ads/afiliado/live/video, onde vaza
    afiliados: {},   // 5) ROI do canal, top afiliados, creators pra recrutar
    financeiro: {},  // 6) margem verdadeira: comissao/taxa/frete reais por pedido
    _log: []         // rastro do que foi capturado (Debug)
    // (performance de produto e saude/cadastro entram em porProduto[itemid])
  };

  function logar(diamante, valor, rota) {
    COFRE._log.unshift({ d: diamante, v: valor, rota: (rota || '').split('?')[0], ts: Date.now() });
    if (COFRE._log.length > 120) COFRE._log.pop();
  }

  // ---- helpers do cerebro geral (rotas mydata/dashboard/affiliate) ----
  // essas rotas usam "result" (nao "data"), taxas em decimal (0.04 = 4%),
  // e valores com { value, chain_ratio, points[] } (numero + variacao + serie).
  function raiz(d) { // pega result OU data OU o proprio objeto
    if (!d || typeof d !== 'object') return {};
    return d.result || d.data || d;
  }
  function pctReal(v) { // TAXA: 0.0407 -> 4.07 ; se ja vier >1 assume que ja e %
    var x = n(v);
    if (x === null || x === -1000000) return null;
    // corte em 0.999, nao em 1: conversao de exatamente 1,0% chega como 1 e
    // viraria 100%. Taxa real de 100% nao existe em e-commerce.
    return x < 0.999 ? x * 100 : x;
  }
  // VARIACAO (pct_diff): no funil vem em decimal (0.186 = +18,6%; -0.122 = -12,2%).
  // Diferente de taxa: variacao pode ser negativa e representar de -100% a +qualquer.
  // Heuristica segura: se |x| <= 3 assume decimal (x100); senao ja e % (ex 199.6).
  // FILTRA sentinela -1000000 e valores absurdos (sem dado / lixo).
  function variacaoPct(v) {
    var x = n(v);
    if (x === null || x <= -1000 || x >= 100000) return null; // sem dado ou lixo
    var r = (Math.abs(x) <= 3) ? x * 100 : x;
    return Math.round(r * 10) / 10;
  }
  // extrai { valor, variacao } de um campo tipo { value, chain_ratio }
  function metrica(o) {
    if (o == null) return null;
    if (typeof o === 'number') return { valor: o, variacao: null };
    if (typeof o !== 'object') return null;
    var val = (o.value != null) ? n(o.value) : null;
    // chain_ratio JA E a variacao em decimal: 0.186 = +18,6% ; -0.277 = -27,7%.
    // (pode vir negativo, prova de que nao e razao de valores)
    // FILTRA o sentinela -1000000 (= "sem dado") pra nao virar -100 milhoes %.
    var cr = n(o.chain_ratio);
    var vr = (cr != null && cr > -1000 && cr < 1000) ? cr * 100 : null;
    return { valor: val, variacao: vr != null ? Math.round(vr * 10) / 10 : null };
  }
  // reduz uma serie de points[] a um resumo leve (nao guardamos ponto a ponto)
  function tendencia(points) {
    if (!Array.isArray(points) || points.length < 3) return null;
    var vals = points.map(function (p) { return n(p.value); }).filter(function (v) { return v != null; });
    if (vals.length < 3) return null;
    var meta = Math.ceil(vals.length / 2);
    var ini = vals.slice(0, meta).reduce(function (a, b) { return a + b; }, 0) / meta;
    var fim = vals.slice(meta).reduce(function (a, b) { return a + b; }, 0) / (vals.length - meta);
    var dir = 'estavel';
    if (ini > 0) {
      var delta = (fim - ini) / ini;
      if (delta > 0.15) dir = 'subindo';
      else if (delta < -0.15) dir = 'caindo';
    }
    return { direcao: dir, inicio: Math.round(ini * 100) / 100, fim: Math.round(fim * 100) / 100, pontos: vals.length };
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
    // O Cofre e da SUA loja. Rotas da vitrine publica (shopee.com.br) trazem
    // produto de concorrente e estavam entrando aqui porque a funcao so
    // procurava um itemid em qualquer lugar da resposta. Era assim que um
    // produto pesquisado no Espiao virava produto do Cofre.
    if (/shopee\.com\.br\/api|search_items|pdp\/|get_pc|hot_sales/.test(String(url))) return;
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
    // ATENCAO: o campo "cpm" da API nao e uma taxa por mil impressoes — e um
    // valor de custo. Guardamos como cpmApiBruto para nao ser confundido com
    // CPM. CPM de verdade so existe onde temos gasto e impressoes do item.
    var cpm = achar(d, 'cpm');
    if (cpm != null) p.cpmApiBruto = real(cpm);
    var gp = achar(d, 'cost'), ip = achar(d, 'impression');
    if (gp != null && ip) p.cpmReal = Math.round((real(gp) / n(ip) * 1000) * 100) / 100;

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
        // PROVADO em 43 campanhas, erro 0,00%: o campo "cpc" da Shopee NAO e
        // custo por clique — e custo por PEDIDO (cost / broad_order). O campo
        // "cpdc" devolve o mesmo numero. Quem le como CPC erra por ~130x.
        // Entao: CPC de verdade e derivado, e o campo da API vira cpa.
        cpc: (gastoReais != null && rep.click) ? Math.round((gastoReais / n(rep.click)) * 100) / 100 : null,
        cpa: rep.cpc != null ? real(rep.cpc) : ((gastoReais != null && rep.broad_order) ? Math.round((gastoReais / n(rep.broad_order)) * 100) / 100 : null),
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

  // =========================================================
  // CEREBRO GERAL — 6 inteligencias (coleta)
  // =========================================================

  // [1] GERENCIAIS — o Snapshot Executivo (key-metrics + order-performance)
  function exGerenciais(url, d) {
    var r = raiz(d);
    // FORMATO A: homepage/key-metrics (nomes curtos: sales, uv, orders + _pct_diff)
    if (/homepage\/key-metrics/.test(url) && r.sales != null) {
      // homepage/key-metrics = ACUMULADO DO DIA (muda a cada hora).
      // So usamos como ULTIMO recurso: se ainda nao temos o dado do PERIODO
      // (dashboard). O dado do periodo (mes) sempre ganha do dado do dia.
      if (COFRE.gerenciais.fonte === 'periodo') return; // ja temos o do mes, ignora o do dia
      var gA = COFRE.gerenciais;
      gA.fonte = 'dia';
      gA.gmvPago = { valor: n(r.sales), variacao: variacaoPct(r.sales_pct_diff) };
      gA.pedidosPagos = { valor: n(r.orders), variacao: variacaoPct(r.orders_pct_diff) };
      gA.pv = { valor: n(r.pv), variacao: variacaoPct(r.pv_pct_diff) };
      gA.uv = { valor: n(r.uv), variacao: variacaoPct(r.uv_pct_diff) };
      gA.visitantes = { valor: n(r.hybrid_uv), variacao: variacaoPct(r.hybrid_uv_pct_diff) };
      gA.cliquesProduto = { valor: n(r.product_clicks), variacao: variacaoPct(r.product_clicks_pct_diff) };
      if (r.conversion_rate != null) gA.conversaoLoja = Math.round(n(r.conversion_rate) * 10000) / 100;
      if (gA.gmvPago.valor && gA.pedidosPagos.valor) gA.ticketMedio = Math.round((gA.gmvPago.valor / gA.pedidosPagos.valor) * 100) / 100;
      logar('gerenciais', 'GMV R$' + gA.gmvPago.valor + ' (DIA — navegue a Central pro mes)', url);
      return;
    }
    // FORMATO B: dashboard/key-metrics (nomes longos: paid_gmv, shop_pv + chain_ratio)
    // Este e o dado do PERIODO (mes/semana escolhido) — o que a analise precisa.
    if (/dashboard\/key-metrics/.test(url)) {
      if (!r.paid_gmv && !r.shop_pv) return;
      var g = COFRE.gerenciais;
      // ANTES: "so troca por outro periodo de maior GMV". Isso fazia o sistema
      // guardar o MAIOR valor que ja tinha visto — quem navegou em 90 dias
      // antes de escolher o mes ficava com o numero de 90 dias na tela, maior
      // que tudo que vendeu no mes. O criterio certo e o mais RECENTE, e o
      // periodo pedido na URL manda em qualquer heuristica de tamanho.
      var mIni = url.match(/start_time=(\d{9,11})/);
      var mFim = url.match(/end_time=(\d{9,11})/);
      var dias = (mIni && mFim) ? Math.round((parseInt(mFim[1], 10) - parseInt(mIni[1], 10)) / 86400) : null;
      g.fonte = 'periodo';
      g.periodoDias = dias;
      g.periodoIni = mIni ? parseInt(mIni[1], 10) : null;
      g.periodoFim = mFim ? parseInt(mFim[1], 10) : null;
      if (r.shop_pv) g.pv = metrica(r.shop_pv);
      if (r.shop_uv) g.uv = metrica(r.shop_uv);
      if (r.product_clicks) g.cliquesProduto = metrica(r.product_clicks);
      if (r.hybrid_uv) g.visitantes = metrica(r.hybrid_uv);
      if (r.paid_gmv) g.gmvPago = metrica(r.paid_gmv);
      if (r.place_gmv) g.gmvColocado = metrica(r.place_gmv);
      if (r.paid_orders) g.pedidosPagos = metrica(r.paid_orders);
      if (r.place_orders) g.pedidosColocados = metrica(r.place_orders);
      if (g.pedidosPagos && g.visitantes && g.visitantes.valor) g.conversaoLoja = Math.round((g.pedidosPagos.valor / g.visitantes.valor) * 10000) / 100;
      if (g.gmvPago && g.pedidosPagos && g.pedidosPagos.valor) g.ticketMedio = Math.round((g.gmvPago.valor / g.pedidosPagos.valor) * 100) / 100;
      logar('gerenciais', 'GMV pago R$' + (g.gmvPago ? g.gmvPago.valor : '?') + ' · ' + (g.pedidosPagos ? g.pedidosPagos.valor : '?') + ' pedidos (periodo)', url);
    }
    if (/dashboard\/order-performance/.test(url)) {
      var s = COFRE.gerenciais.saude = COFRE.gerenciais.saude || {};
      if (r.cancelled_sales) s.vendasCanceladas = metrica(r.cancelled_sales);
      if (r.return_refund_sales) s.reembolsos = metrica(r.return_refund_sales);
      if (r.cancelled_orders) s.pedidosCancelados = metrica(r.cancelled_orders);
      if (r.return_refund_orders) s.pedidosDevolvidos = metrica(r.return_refund_orders);
      logar('gerenciais_saude', 'reembolsos R$' + (s.reembolsos ? s.reembolsos.valor : '?'), url);
    }
  }

  // [2] FUNIL DE VENDAS — a origem do dinheiro (traffic-sources + traffic/overview)
  function exFunil(url, d) {
    var r = raiz(d);
    // overview: quanto cada canal traz de venda (card, ads, afiliado, live, video)
    var ov = r.overview;
    if (ov && /traffic\/overview/.test(url)) {
      var totalNovo = n(ov.total_sales) || 0;
      var totalAtual = COFRE.funil.totalVendas || 0;
      if (totalNovo < totalAtual) return; // ja temos periodo mais rico
      var f = COFRE.funil;
      f.totalVendas = n(ov.total_sales);
      f.canais = {
        card: { valor: n(ov.product_card), ratio: pctReal(ov.product_card_ratio), variacao: variacaoPct(ov.product_card_pct_diff) },
        ads: { valor: n(ov.paid_ads), ratio: pctReal(ov.paid_ads_ratio), variacao: variacaoPct(ov.paid_ads_pct_diff) },
        afiliado: { valor: n(ov.affiliate), ratio: pctReal(ov.affiliate_ratio), variacao: variacaoPct(ov.affiliate_pct_diff) },
        live: { valor: n(ov.live), ratio: pctReal(ov.live_ratio) },
        video: { valor: n(ov.video), ratio: pctReal(ov.video_ratio) }
      };
      // dependencia: qual canal domina (risco se um so canal > 70%)
      var maior = null, maiorR = 0;
      ['card', 'ads', 'afiliado', 'live', 'video'].forEach(function (k) {
        var rt = f.canais[k].ratio || 0;
        if (rt > maiorR) { maiorR = rt; maior = k; }
      });
      f.canalDominante = maior;
      f.dependenciaPct = Math.round(maiorR * 10) / 10;
      // sinaliza canais nao usados (oportunidade)
      f.naoUsa = [];
      if (!f.canais.live.valor) f.naoUsa.push('live');
      if (!f.canais.video.valor) f.naoUsa.push('video');
      logar('funil', 'dominante ' + maior + ' ' + f.dependenciaPct + '%', url);
    }
  }

  // [3] PERFORMANCE DE PRODUTO — o funil de cada item (product/performance + rankings)

  // ---- TODO/LIST_TASK: a rota que REALMENTE traz competitividade ----
  // Eu tinha assumido que competitiveness vinha de get_product_performance_info.
  // Nao vinha: essa rota nunca teve o campo. Ele vive aqui, junto com o ROAS
  // que a Shopee recomenda para o produto e a faixa estimada de retorno.
  // Valores de ROAS vem em micro (390000 = 3,9x).

  // ---- SERIE TEMPORAL: aprendizado real, mudanca de meta e leilao ----
  // is_cold_start e dito pela Shopee, nao estimado pela idade da campanha.
  // O roi_target_setting hora a hora revela quando a meta foi alterada.
  // sov, reach e location_in_ads sao as metricas de leilao que existiam e
  // nunca foram lidas.

  // ---- ORIGEM DA VENDA POR CANAL ----
  // Responde de onde vem cada real: busca, recomendacao, loja, carrinho.
  // Separa o que a loja CONQUISTA do que o algoritmo empresta.

  // ---- PALAVRAS-CHAVE COM VOLUME DE BUSCA ----
  // A rota devolve o volume mensal REAL de cada termo que a Shopee sugere.
  // Junta loja + produtos e remove repetidos, ficando com o maior volume.
  function exKeywords(url, d) {
    // A resposta traz data como LISTA DIRETA, nao objeto com keyword_list.
    // Eu tinha assumido a estrutura errada e por isso nada era lido.
    var raiz = d && d.data;
    var lista = Array.isArray(raiz) ? raiz : ((raiz || {}).keyword_list || (raiz || {}).keywords || []);
    if (!lista.length) return 0;
    COFRE.busca = COFRE.busca || {};
    COFRE.busca.keywords = COFRE.busca.keywords || [];
    var mapa = {};
    COFRE.busca.keywords.forEach(function (x) { mapa[x.termo] = x; });
    var novos = 0;
    for (var i = 0; i < lista.length; i++) {
      var k = lista[i] || {};
      var termo = k.keyword || k.keyword_name || k.name;
      var vol = k.search_volume != null ? n(k.search_volume) : null;
      if (!termo || vol == null) continue;
      var reg = mapa[termo];
      if (!reg || (reg.volume || 0) < vol) {
        mapa[termo] = {
          termo: termo, volume: vol,
          lance: k.recommended_price != null ? real(k.recommended_price) : null,
          relevancia: k.relevance != null ? n(k.relevance) : null,
          recomendado: !!k.is_recommended
        };
        novos++;
      }
    }
    COFRE.busca.keywords = Object.keys(mapa).map(function (x) { return mapa[x]; })
      .sort(function (a, b) { return (b.volume || 0) - (a.volume || 0); });
    logar('keywords', COFRE.busca.keywords.length + ' termos (+' + novos + ')', url);
    return novos;
  }

  function exOrigem(url, d) {
    var r = (d && d.result) || {};
    var o = r.overview;
    if (!o) return 0;
    var ROT = {
      psd_label_search: 'Busca', psd_label_recommendation: 'Recomendacao',
      psd_label_shop: 'Sua loja', psd_label_shopping_cart: 'Carrinho',
      psd_label_my_purchase: 'Minhas compras', psd_label_chat: 'Chat',
      psd_label_promotion: 'Promocao', psd_label_others: 'Outros'
    };
    var canais = [];
    var pc = r.product_card || {};
    (pc.breakdown || []).forEach(function (b) {
      var nome = ROT[b.source] || b.source;
      canais.push({
        origem: nome,
        pctVendas: (b.sales_ratio || 0) * 100,
        pctPedidos: (b.orders_ratio || 0) * 100,
        pctCliques: (b.product_clicks_ratio || 0) * 100,
        vendas: b.sales != null ? n(b.sales) : null,
        pedidos: b.orders != null ? n(b.orders) : null,
        ctr: b.ctr != null ? pctReal(b.ctr) : null,
        ticket: b.sales_per_order != null ? n(b.sales_per_order) : null,
        cliqueParaPedido: b.product_clicks_to_orders_rate != null ? pctReal(b.product_clicks_to_orders_rate) : null,
        variacao: b.sales_pct_diff != null ? (b.sales_pct_diff * 100) : null
      });
    });
    canais.sort(function (a, b2) { return b2.pctVendas - a.pctVendas; });
    COFRE.origem = {
      total: n(o.total_sales), totalVar: o.total_sales_pct_diff != null ? o.total_sales_pct_diff * 100 : null,
      cardProduto: n(o.product_card), cardRatio: (o.product_card_ratio || 0) * 100,
      afiliados: n(o.affiliate), afiliadosRatio: (o.affiliate_ratio || 0) * 100,
      afiliadosVar: o.affiliate_pct_diff != null ? o.affiliate_pct_diff * 100 : null,
      adsPago: n(o.paid_ads), adsVar: o.paid_ads_pct_diff != null ? o.paid_ads_pct_diff * 100 : null,
      live: n(o.live), video: n(o.video),
      canais: canais
    };
    logar('origem', canais.length + ' origens · busca ' + (canais[0] ? canais[0].pctVendas.toFixed(0) + '%' : '?'), url);
    return 1;
  }

  // ---- EVOLUCAO DIARIA DA LOJA + PERDA POS-PEDIDO ----
  // O degrau que ninguem olha: pedido COLOCADO que nao vira CONFIRMADO.
  function exTendencia(url, d) {
    var r = (d && d.result) || {};
    if (!r.uv || !Array.isArray(r.uv)) return 0;
    function serie(k) {
      return (r[k] || []).map(function (x) { return (x && typeof x === 'object') ? n(x.value) : n(x); });
    }
    var dias = serie('uv').length;
    // confirmed_order e IDENTICO a paid_order no dado da Shopee (verificado).
    // O que importa e colocado -> pago: pedido feito e nao pago.
    var colocado = serie('placed_order'), confirmado = serie('paid_order');
    var perdas = [];
    for (var i = 0; i < dias; i++) {
      var c = colocado[i], f = confirmado[i];
      if (c && f != null && c > 0) {
        var taxa = f / c;
        if (taxa < 0.9) perdas.push({ dia: i, colocado: c, confirmado: f, perdaPct: (1 - taxa) * 100 });
      }
    }
    var somaC = colocado.reduce(function (s, x) { return s + (x || 0); }, 0);
    var somaF = confirmado.reduce(function (s, x) { return s + (x || 0); }, 0);
    COFRE.tendencia = {
      dias: dias,
      uv: serie('uv'), pv: serie('pv'),
      bounce: serie('bounce_rate'), atcRate: serie('atc_rate'),
      buscaCliques: serie('search_clicks'),
      gmvColocado: serie('placed_gmv'),
      colocado: colocado, confirmado: confirmado,
      pagos: serie('paid_order'),
      conversao: serie('uv_to_paid_buyers_rate'),
      ticketPorComprador: serie('sales_per_buyer'),
      perdaPosPedido: {
        totalColocado: somaC, totalConfirmado: somaF,
        perdaPct: somaC ? (1 - somaF / somaC) * 100 : null,
        diasRuins: perdas.length, piores: perdas.sort(function (a, b2) { return b2.perdaPct - a.perdaPct; }).slice(0, 3)
      }
    };
    logar('tendencia', dias + ' dias · perda pos-pedido ' + (somaC ? ((1 - somaF / somaC) * 100).toFixed(1) + '%' : '?'), url);
    return 1;
  }

  // ---- PERCENTIS DA CATEGORIA ----
  // A meta que a Shopee recomenda e o percentil 50 da categoria: a mediana
  // do que os OUTROS vendedores praticam, nao um calculo do seu produto.

  // ---- PALAVRAS DE UMA CAMPANHA DE BUSCA DE LOJA ----
  // Traz o lance ATUAL e o RECOMENDADO por palavra. A diferenca entre os
  // dois diz se voce esta perdendo leilao por lance baixo.

  // ---- CAMPANHAS DE MARKETING ----
  // Cupom, Oferta Relampago e Desconto. Todas trazem ctime (criacao) e mtime
  // (ultima alteracao): sem log de auditoria na API, comparar o mtime entre
  // leituras e a unica forma de detectar mexida do cliente.
  function exMarketing(url, d) {
    var dd = (d && d.data) || {};
    COFRE.marketing = COFRE.marketing || { cupons: [], relampago: [], descontos: [], lidoEm: Date.now() };

    if (/voucher\/list/.test(url)) {
      var lv = dd.voucher_list || dd.list || (Array.isArray(dd) ? dd : []);
      COFRE.marketing.cupons = lv.map(function (v) {
        var rule = v.rule || {};
        return {
          id: String(v.voucher_id), nome: v.name, codigo: v.voucher_code,
          tipo: v.discount ? 'percentual' : 'valor',
          desconto: rule.discount_percentage_with_decimal ? rule.discount_percentage_with_decimal / 100000 : n(v.value),
          minimo: n(v.min_price),
          inicio: n(v.start_time), fim: n(v.end_time),
          usados: n(v.current_usage) || 0, limite: n(v.usage_limit),
          ativo: v.status === 1,
          alteradoEm: n(v.mtime), criadoEm: n(v.ctime),
          absorvidoPeloVendedor: !!rule.is_seller_absorbed,
          porUsuario: rule.usage_limit_per_user
        };
      });
      logar('marketing_cupons', COFRE.marketing.cupons.length + ' cupons', url);
      return 1;
    }
    if (/shop_flash_sale_list/.test(url)) {
      var lf = dd.flash_sale_list || dd.list || (Array.isArray(dd) ? dd : []);
      COFRE.marketing.relampago = lf.map(function (f) {
        return {
          id: String(f.flash_sale_id),
          inicio: n(f.start_time), fim: n(f.end_time),
          itens: n(f.item_count), itensAtivos: n(f.enabled_item_count),
          ativo: f.status === 1,
          alteradoEm: n(f.mtime), criadoEm: n(f.ctime)
        };
      });
      logar('marketing_relampago', COFRE.marketing.relampago.length + ' ofertas relampago', url);
      return 1;
    }
    // CAMPANHAS OFICIAIS DA SHOPEE — liquidacao 8.8, datas comemorativas.
    // A conta pode estar convidada e nao ter inscrito nenhum produto: e
    // trafego gratuito de vitrine que fica parado.
    if (/get_marketing_center_campaign_list/.test(url)) {
      var lc = dd.campaign_list || [];
      COFRE.marketing.oficiais = lc.map(function (c) {
        return {
          id: String(c.campaign_id), nome: c.campaign_name,
          inicio: n(c.campaign_start_time), fim: n(c.campaign_end_time),
          tipo: c.campaign_scene, status: c.status,
          inscritos: n(c.registered_item_count) || 0,
          url: c.url
        };
      });
      logar('marketing_oficiais', COFRE.marketing.oficiais.length + ' campanhas da Shopee', url);
      return 1;
    }
    // QUAIS FERRAMENTAS A CONTA TEM LIBERADAS
    if (/public\/get_toggle/.test(url)) {
      COFRE.marketing.liberadas = {
        relampagoLoja: !!dd.enable_shop_flash_sale,
        relampagoShopee: !!dd.enable_flash_sale,
        desconto: !!dd.enable_seller_discount,
        cupom: !!dd.enable_seller_voucher,
        combo: !!dd.enable_bundle_deal,
        compreJunto: !!dd.sz_enable_add_on_deal,
        premioSeguidor: !!dd.enable_follow_prize,
        jogoDaLoja: !!dd.sz_enable_shop_game,
        campanhaShopee: !!dd.enable_seller_campaign,
        freteSubsidiado: !!dd.enable_logistics_promotion
      };
      logar('marketing_toggles', 'ferramentas liberadas lidas', url);
      return 1;
    }
    // RETORNO DE CADA FERRAMENTA no periodo
    if (/metrics/.test(url)) {
      var mm2 = dd.data || dd.metrics || dd;
      if (!mm2 || typeof mm2 !== 'object') return 0;
      COFRE.marketing.retorno = COFRE.marketing.retorno || {};
      var qual = /discount/.test(url) ? 'desconto' : (/voucher/.test(url) ? 'cupom' : (/bundle/.test(url) ? 'combo' : 'geral'));
      COFRE.marketing.retorno[qual] = {
        vendas: n(mm2.sales), pedidos: n(mm2.orders), compradores: n(mm2.buyers), unidades: n(mm2.units),
        usados: n(mm2.used), taxaUso: mm2.usage_rate != null ? n(mm2.usage_rate) * 100 : null,
        varVendas: mm2.sales_pct_diff != null ? n(mm2.sales_pct_diff) * 100 : null,
        varPedidos: mm2.orders_pct_diff != null ? n(mm2.orders_pct_diff) * 100 : null
      };
      logar('marketing_retorno', qual + ': ' + (n(mm2.sales) || 0) + ' em vendas', url);
      return 1;
    }
    if (/discount\/list/.test(url)) {
      var ld = dd.discount_list || dd.list || (Array.isArray(dd) ? dd : []);
      COFRE.marketing.descontos = ld.map(function (x) {
        return {
          id: String(x.discount_id || x.promotion_id || ''), nome: x.discount_name || x.name,
          inicio: n(x.start_time), fim: n(x.end_time),
          itens: n(x.item_count), ativo: x.status === 1,
          alteradoEm: n(x.mtime), criadoEm: n(x.ctime)
        };
      });
      logar('marketing_descontos', COFRE.marketing.descontos.length + ' descontos', url);
      return 1;
    }
    return 0;
  }

  function exPalavrasCampanha(url, d) {
    var m = String(url).match(/campaign_id=(\d+)/);
    if (!m) return 0;
    var raiz = d && d.data;
    var lista = Array.isArray(raiz) ? raiz : ((raiz || {}).keyword_list || []);
    if (!lista.length) return 0;
    var out = [];
    for (var i = 0; i < lista.length; i++) {
      var k = lista[i] || {};
      if (!k.keyword) continue;
      var atual = k.bid_price != null ? real(k.bid_price) : null;
      var rec = k.recommended_price != null ? real(k.recommended_price) : null;
      out.push({
        termo: k.keyword,
        lance: atual,
        recomendado: rec,
        correspondencia: k.match_type === 'exact' ? 'exata' : 'ampla',
        ativa: k.state === 'active',
        abaixo: (atual != null && rec != null) ? atual < rec * 0.95 : null,
        faltaPct: (atual != null && rec != null && rec > 0) ? ((rec - atual) / rec) * 100 : null
      });
    }
    out.sort(function (a, b) { return (b.faltaPct || 0) - (a.faltaPct || 0); });
    var pc = COFRE.porCampanha[m[1]] || {};
    pc.palavras = out;
    COFRE.porCampanha[m[1]] = pc;
    var perdendo = out.filter(function (x) { return x.abaixo; }).length;
    logar('palavras_campanha', m[1] + ': ' + out.length + ' palavras, ' + perdendo + ' com lance abaixo do recomendado', url);
    return out.length;
  }

  function exPercentis(url, d) {
    var cfg = ((d && d.data) || {}).ads_config || {};
    var r2 = cfg.roi_two || {};
    var rp = r2.recommendation_percentiles || cfg.recommendation_percentiles;
    if (!rp && !r2.exact) return 0;
    COFRE.algoritmo = COFRE.algoritmo || {};
    COFRE.algoritmo.percentis = {
      exato: r2.exact != null ? real(r2.exact) : null,
      pisoCategoria: r2.lower_bound != null ? real(r2.lower_bound) : null,
      tetoCategoria: r2.upper_bound != null ? real(r2.upper_bound) : null,
      pctExato: rp ? n(rp.exact) : 50,
      pctPiso: rp ? n(rp.lower_bound) : 80,
      pctTeto: rp ? n(rp.upper_bound) : 20
    };
    logar('percentis', 'mediana da categoria ' + (COFRE.algoritmo.percentis.exato || '?') + 'x', url);
    return 1;
  }

  function exTempo(url, d) {
    var m = String(url).match(/campaign_id=(\d+)/);
    if (!m) return 0;
    var id = m[1];
    var rbt = ((d && d.data) || {}).report_by_time || [];
    if (!rbt.length) return 0;
    var pc = COFRE.porCampanha[id] || {};
    var metas = [], frio = 0, boost = 0, sovS = 0, sovN = 0, reachMax = 0, rankS = 0, rankN = 0;
    for (var i = 0; i < rbt.length; i++) {
      var p = rbt[i] || {};
      var rt = p.roi_target_setting || {};
      var mt = rt.value != null ? real(rt.value) : null;
      if (mt != null && mt > 0) metas.push({ t: n(p.key), meta: mt });
      if (rt.is_cold_start) frio++;
      if ((p.new_product_boost_setting || {}).is_boosting) boost++;
      var mm = p.metrics || {};
      if (mm.sov != null) { sovS += n(mm.sov) || 0; sovN++; }
      if (mm.reach != null) reachMax = Math.max(reachMax, n(mm.reach) || 0);
      if (mm.avg_rank != null) { rankS += n(mm.avg_rank) || 0; rankN++; }
    }
    // quando a meta mudou: compara valores consecutivos
    var trocas = [];
    for (var j = 1; j < metas.length; j++) {
      if (Math.abs(metas[j].meta - metas[j - 1].meta) > 0.01) {
        trocas.push({ em: metas[j].t, de: metas[j - 1].meta, para: metas[j].meta });
      }
    }
    pc.aprendizado = {
      emAprendizado: frio > 0,
      horasEmAprendizado: frio,
      impulsionando: boost > 0,
      trocasDeMeta: trocas,
      ultimaTroca: trocas.length ? trocas[trocas.length - 1] : null,
      pontos: rbt.length
    };
    pc.leilaoSerie = {
      sovMedio: sovN ? sovS / sovN : null,
      alcanceMax: reachMax || null,
      posicaoMedia: rankN ? rankS / rankN : null
    };
    // agrega por hora somando todas as campanhas: e assim que o padrao do
    // dia aparece. Uma campanha sozinha tem pouco volume por hora.
    COFRE.horas = COFRE.horas || {};
    for (var hx = 0; hx < rbt.length; hx++) {
      var px = rbt[hx] || {}; var mx = px.metrics || {};
      var ts = n(px.key) || 0;
      var hh = new Date((ts - 3 * 3600) * 1000).getUTCHours();
      var acc = COFRE.horas[hh] || { gasto: 0, impressoes: 0, cliques: 0, atc: 0, checkout: 0, pedidos: 0, gmv: 0, rank: 0, rankN: 0 };
      acc.gasto += (n(mx.cost) || 0) / 100000;
      acc.impressoes += n(mx.impression) || 0;
      acc.cliques += n(mx.click) || 0;
      acc.atc += n(mx.atc) || 0;
      acc.checkout += n(mx.checkout) || 0;
      acc.pedidos += n(mx.broad_order) || 0;
      acc.gmv += (n(mx.broad_gmv) || 0) / 100000;
      if (mx.avg_rank) { acc.rank += n(mx.avg_rank); acc.rankN++; }
      COFRE.horas[hh] = acc;
    }
    COFRE.porCampanha[id] = pc;
    logar('tempo', 'campanha ' + id + ': ' + (frio ? 'em aprendizado' : 'aprendizado concluido') + (trocas.length ? ' \u00b7 ' + trocas.length + ' troca(s) de meta' : ''), url);
    return 1;
  }

  function exTarefas(url, d) {
    if (!/todo\/list_task/.test(url)) return 0;
    var lista = ((d && d.data) || {}).task_list || [];
    var c = 0;
    for (var i = 0; i < lista.length; i++) {
      var tk = lista[i] || {};
      var g = tk.generic_data || {};
      var si = g.integer_field || {}, ss = g.string_field || {};
      var id = si.item_id;
      if (!id) continue;
      var p = COFRE.porProduto[String(id)] || {};
      if (ss.name && !p.nome) p.nome = ss.name;
      if (si.competitiveness != null) p.competitividade = n(si.competitiveness);
      if (si.recommended_roas_target != null) p.roasRecomendado = real(si.recommended_roas_target);
      if (si.estimated_roi__lower_bound != null) p.roiEstimadoMin = real(si.estimated_roi__lower_bound);
      if (si.estimated_roi__upper_bound != null) p.roiEstimadoMax = real(si.estimated_roi__upper_bound);
      if (tk.state) p.tarefaShopee = String(tk.state);
      COFRE.porProduto[String(id)] = p;
      c++;
    }
    return c;
  }

  function exPerformanceProduto(url, d) {
    var r = raiz(d);
    // FORMATO EXTRA: get_product_performance_info traz l30d por item_id (mapa)
    if (/get_product_performance_info/.test(url)) {
      var perf = r.performance;
      if (perf && typeof perf === 'object') {
        var c = 0;
        Object.keys(perf).forEach(function (id) {
          var pp = perf[id];
          var p = COFRE.porProduto[String(id)] || {};
          p.perf = p.perf || {};
          if (pp.l30d_sales != null) p.perf.vendas30d = n(pp.l30d_sales);
          if (pp.l30d_impression != null) p.perf.impressoes30d = n(pp.l30d_impression);
          if (pp.l30d_conversion != null) p.perf.conversao30d = pctReal(pp.l30d_conversion);
          // ESTES TRES eram o furo: a rota traz competitividade, posicao media
          // e status, e o extrator saia antes de ler. O card mostrava
          // "abra a campanha uma vez" para sempre.
          var cmp = pp.competitiveness != null ? pp.competitiveness
            : (pp.price_competitiveness != null ? pp.price_competitiveness
            : (pp.competitiveness_score != null ? pp.competitiveness_score : null));
          if (cmp != null) p.competitividade = n(cmp);
          var rk = pp.avg_rank != null ? pp.avg_rank : (pp.rank != null ? pp.rank : null);
          if (rk != null) p.posicao = n(rk);
          var stt = pp.item_status != null ? pp.item_status : (pp.status != null ? pp.status : null);
          if (stt != null) p.statusShopee = String(stt);
          if (pp.listing_status != null) p.listing = String(pp.listing_status);
          COFRE.porProduto[String(id)] = p;
          c++;
        });
        if (c) logar('perf_30d', c + ' produtos com dados de 30 dias', url);
      }
      return;
    }
    var itens = r.items || r.item || null;
    if (!Array.isArray(itens)) return;
    if (!/product\/performance|product-rankings|traffic-sources\/product-contribution|traffic\/item-list/.test(url)) return;
    var n0 = 0;
    itens.forEach(function (it) {
      var id = String(it.id != null ? it.id : (it.itemid != null ? it.itemid : ''));
      if (!id) return;
      var p = COFRE.porProduto[id] || {};
      // guarda o periodo mais rico (mais impressoes) — evita "hoje" apagar o mes
      var imprNovo = n(it.product_card_impressions) || n(it.product_impressions) || 0;
      var imprAtual = (p.perf && p.perf.impressoes) || 0;
      if (p.perf && imprNovo < imprAtual) { if (it.name) p.nome = it.name; return; }
      p.perf = p.perf || {};
      var P = p.perf;
      if (it.name) p.nome = it.name;
      // funil do card
      if (it.ctr != null) P.ctr = pctReal(it.ctr);
      if (it.product_card_impressions != null) P.impressoes = n(it.product_card_impressions);
      if (it.product_card_clicks != null) P.cliques = n(it.product_card_clicks);
      if (it.product_impressions != null) P.impressoes = n(it.product_impressions);
      if (it.product_clicks != null) P.cliques = n(it.product_clicks);
      // conversao (3 estagios)
      if (it.placed_order_conversion_rate != null) P.convColocado = pctReal(it.placed_order_conversion_rate);
      if (it.paid_order_conversion_rate != null) P.convPago = pctReal(it.paid_order_conversion_rate);
      if (it.product_clicks_to_orders_rate != null) P.convClique = pctReal(it.product_clicks_to_orders_rate);
      // pagina do produto
      if (it.uv != null) P.uv = n(it.uv);
      if (it.pv != null) P.pv = n(it.pv);
      if (it.likes != null) P.likes = n(it.likes);
      if (it.bounce_rate != null) P.rejeicao = pctReal(it.bounce_rate);
      if (it.bounce_visitors != null) P.visitantesRejeicao = n(it.bounce_visitors);
      if (it.search_clicks != null) P.cliquesBusca = n(it.search_clicks);
      // carrinho
      if (it.add_to_cart_units != null) P.carrinhoUnid = n(it.add_to_cart_units);
      if (it.add_to_cart_buyers != null) P.carrinhoCompradores = n(it.add_to_cart_buyers);
      // vendas (3 estagios: colocado, pago, confirmado)
      if (it.placed_sales != null) P.vendaColocada = n(it.placed_sales);
      if (it.paid_sales != null) P.vendaPaga = n(it.paid_sales);
      if (it.placed_orders != null) P.pedidosColocados = n(it.placed_orders);
      if (it.paid_orders != null) P.pedidosPagos = n(it.paid_orders);
      if (it.sales != null) P.venda = n(it.sales);
      if (it.orders != null) P.pedidos = n(it.orders);
      if (it.sales_ratio != null) P.fatiaVendas = pctReal(it.sales_ratio); // % das vendas da loja (concentracao)
      else if (COFRE.funil.totalVendas) {
        var vendaItem = n(it.sales) || n(it.paid_sales) || n(it.placed_sales) || 0;
        if (vendaItem > 0) P.fatiaVendas = Math.round((vendaItem / COFRE.funil.totalVendas) * 10000) / 100;
      }
      if (it.sales_per_order != null) P.ticket = n(it.sales_per_order);
      // vinculo com ads
      if (it.campaign_id != null) p.campaignId = String(it.campaign_id);
      if (it.view_ads != null) P.temAds = !!it.view_ads;
      COFRE.porProduto[id] = p;
      n0++;
    });
    if (n0) logar('performance_produto', n0 + ' produtos com funil', url);
  }

  // [4] SAUDE / CADASTRO — moderacao, travas, avaliacoes (lock + ratings)
  function exSaudeProduto(url, d) {
    // travas de edicao (product_lock_info) — vem por produto via id na url
    if (/get_product_lock_info/.test(url)) {
      var lock = d && d.data ? d.data : d;
      if (!lock || typeof lock !== 'object') return;
      var travas = [];
      Object.keys(lock).forEach(function (k) {
        if (lock[k] && lock[k].is_locked === true) travas.push(k.replace(/_edit$/, ''));
      });
      // O product_id vem na URL e estava sendo ignorado: as travas eram
      // guardadas com chave 'lote_timestamp' e a tela mostrava uma lista solta
      // sem dizer de qual produto. Sem o vinculo, o aviso e inutil.
      var mId = String(url).match(/product_id=(\d+)/);
      var idProd = mId ? mId[1] : null;
      COFRE.gerenciais.travasDetectadas = COFRE.gerenciais.travasDetectadas || {};
      if (travas.length && idProd) {
        COFRE.gerenciais.travasDetectadas[idProd] = travas;
        var pAlvo = COFRE.porProduto[idProd] || {};
        pAlvo.travas = travas;
        COFRE.porProduto[idProd] = pAlvo;
        logar('saude_travas', 'produto ' + idProd + ': ' + travas.join(', '), url);
      }
    }
    // avaliacoes (get_ratings) — detecta notas baixas recentes
    if (/item\/get_ratings/.test(url)) {
      var r = raiz(d);
      var lista = r.ratings || (Array.isArray(r) ? r : null);
      if (!Array.isArray(lista)) return;
      lista.forEach(function (av) {
        var id = String(av.itemid != null ? av.itemid : '');
        if (!id) return;
        var p = COFRE.porProduto[id] || {};
        p.avaliacoes = p.avaliacoes || { total: 0, baixas: 0, soma: 0, comFoto: 0, ultimaBaixa: null };
        var estrela = n(av.rating_star);
        if (estrela != null && estrela > 0) {
          p.avaliacoes.total++;
          p.avaliacoes.soma += estrela;
          if (av.images && av.images.length) p.avaliacoes.comFoto++;
          if (estrela <= 2) {
            p.avaliacoes.baixas++;
            var quando = n(av.ctime);
            if (quando && (!p.avaliacoes.ultimaBaixa || quando > p.avaliacoes.ultimaBaixa)) p.avaliacoes.ultimaBaixa = quando;
          }
          p.avaliacoes.media = Math.round((p.avaliacoes.soma / p.avaliacoes.total) * 100) / 100;
        }
        COFRE.porProduto[id] = p;
      });
      logar('saude_avaliacoes', lista.length + ' avaliacoes lidas', url);
    }
  }

  // [3b] TENDENCIA DO PRODUTO — a serie dia a dia (metric-trends / overview)
  function exTendenciaProduto(url, d) {
    if (!/product\/overview\/metric-trends|product\/overview\/$|product\/traffic\/overview/.test(url)) return;
    var r = raiz(d);
    // essas rotas trazem series soltas (uv[], bounce_rate[], atc_rate[]...).
    // como nem sempre ha itemid na resposta, guardamos a tendencia geral da loja.
    var t = COFRE.gerenciais.tendencias = COFRE.gerenciais.tendencias || {};
    if (Array.isArray(r.bounce_rate)) t.rejeicao = tendencia(r.bounce_rate);
    if (Array.isArray(r.atc_rate)) t.carrinho = tendencia(r.atc_rate);
    if (Array.isArray(r.uv)) t.visitantes = tendencia(r.uv);
    if (Array.isArray(r.search_clicks)) t.buscas = tendencia(r.search_clicks);
    if (t.rejeicao || t.carrinho || t.visitantes) logar('tendencia_produto', 'series capturadas', url);
  }

  // [4b] SAUDE DA CONTA (accounthealth/overview) — penalidades, rating de performance
  function exSaudeConta(url, d) {
    if (!/accounthealth\/v1\/sc\/shops\/overview/.test(url)) return;
    var data = d && d.data ? d.data : d;
    if (!data || typeof data !== 'object') return;
    COFRE.conta.saudeConta = {
      pontosPenalidade: data.penalty_point != null ? n(data.penalty_point) : null,
      ratingPerformance: data.performance_rating || null, // excellent, good, needs_improvement, poor
      metricasFalhando: data.failed_metric_count != null ? n(data.failed_metric_count) : null,
      recursos: data.appeal_count != null ? n(data.appeal_count) : null
    };
    logar('saude_conta', (COFRE.conta.saudeConta.ratingPerformance || '?') + ' · ' + (COFRE.conta.saudeConta.pontosPenalidade || 0) + ' pontos', url);
  }

  // [5] AFILIADOS — canal, ROI, top afiliados, creators pra recrutar
  // ---- PRODUTOS NO CANAL DE AFILIADOS ----
  // A rota seller_item_detail/top5 traz, por item: GMV do canal, comissao
  // paga, ROI, pedidos, compradores NOVOS e cliques. E o unico lugar que
  // separa comprador novo de recorrente por produto.

  // ---- VINCULO ITEM -> CAMPANHA ----
  // A rota get_campaign_info_by_item_list responde direto quais itens tem
  // anuncio. E a fonte mais confiavel para o veredito de "vende sem anuncio".
  function exVinculoItemCampanha(url, d) {
    var lst = ((d && d.data) || {}).list || ((d && d.data) || {}).item_list || (Array.isArray(d && d.data) ? d.data : []);
    if (!lst || !lst.length) return 0;
    COFRE.vinculoItemCampanha = COFRE.vinculoItemCampanha || {};
    var n2 = 0;
    for (var i = 0; i < lst.length; i++) {
      var x = lst[i] || {};
      var idIt = x.item_id != null ? String(x.item_id) : null;
      if (!idIt) continue;
      var camps = x.campaign_list || x.campaigns || (x.campaign_id ? [{ campaign_id: x.campaign_id }] : []);
      if (camps && camps.length) {
        var c0 = camps[0];
        COFRE.vinculoItemCampanha[idIt] = String(c0.campaign_id || c0.id || camps[0]);
        n2++;
      }
    }
    logar('vinculo_item_campanha', n2 + ' itens com anuncio', url);
    return n2;
  }

  function exAfiliadosProdutos(url, d) {
    var lst = ((d && d.data) || {}).list || [];
    if (!lst.length) return 0;
    COFRE.afiliados = COFRE.afiliados || {};
    COFRE.afiliados.produtos = lst.map(function (x) {
      var gmv = n(x.gmv) != null ? n(x.gmv) / 100000 : null;
      var com = n(x.spend) != null ? n(x.spend) / 100000 : null;
      return {
        id: String(x.item_id), nome: x.item_name,
        categoria: x.category_name || null,
        preco: n(x.price) != null ? n(x.price) / 100000 : null,
        gmv: gmv, comissao: com,
        roi: n(x.roi), pedidos: n(x.orders), unidades: n(x.sale),
        compradores: n(x.total_buyers), novos: n(x.new_buyers),
        cliques: n(x.clicks),
        custoPorVenda: (com != null && x.orders) ? com / n(x.orders) : null,
        pctNovos: (x.new_buyers != null && x.total_buyers) ? (n(x.new_buyers) / n(x.total_buyers)) * 100 : null,
        comissaoPct: (com != null && gmv) ? (com / gmv) * 100 : null
      };
    });
    logar('afiliados_produtos', COFRE.afiliados.produtos.length + ' produtos no canal', url);
    return 1;
  }

  function exAfiliados(url, d) {
    // resumo diario do canal (seller_daily) — dados vem em data
    if (/affiliateplatform\/dashboard\/seller_daily/.test(url)) {
      var rd = raiz(d);
      var pedidosNovo = n(rd.total_order_count) || 0;
      var pedidosAtual = (COFRE.afiliados.resumo && COFRE.afiliados.resumo.pedidos) || 0;
      if (pedidosNovo < pedidosAtual) return; // ja temos periodo mais amplo
      var a = COFRE.afiliados;
      a.resumo = {
        pedidos: n(rd.total_order_count),
        gmv: n(rd.dis_total_actual_amount),           // ja em reais (dis_ = display)
        comissaoPaga: n(rd.dis_total_seller_commission),
        roi: n(rd.dis_total_roi),
        roiVariacao: (rd.roi_diff != null && n(rd.roi_diff) > -1000 && n(rd.roi_diff) < 100000) ? Math.round(n(rd.roi_diff) * 10) / 10 : null,
        itensVendidos: n(rd.total_gross_item_sold)
      };
      logar('afiliados', 'ROI ' + (a.resumo.roi ? a.resumo.roi.toFixed(1) : '?') + 'x · ' + a.resumo.pedidos + ' pedidos', url);
    }
    // top 5 afiliados (por ROI/GMV)
    if (/affiliate_performance\/top5/.test(url)) {
      var lista = raiz(d).list || (d && d.list) || null;
      if (Array.isArray(lista)) {
        COFRE.afiliados.top = lista.slice(0, 5).map(function (af) {
          // ROI: dis_roi as vezes vem "--" (sem dado); roi=-1 = invalido
          var roiBruto = n(af.dis_roi);
          if (roiBruto === null || roiBruto < 0) roiBruto = n(af.roi);
          if (roiBruto !== null && roiBruto < 0) roiBruto = null; // -1 = sem dado
          return {
            nome: af.display_name || af.shopee_username,
            usuario: af.shopee_username,
            cliques: n(af.dis_clicks),
            pedidos: n(af.dis_orders),
            gmv: n(af.dis_gmv),
            comissao: n(af.dis_est_commission),
            roi: roiBruto,
            itensVendidos: n(af.item_sold),
            novosCompradores: n(af.new_buyers),
            seguidores: af.social_medias && af.social_medias[0] ? n(af.social_medias[0].follower_count) : null
          };
        });
        logar('afiliados_top', COFRE.afiliados.top.length + ' top afiliados', url);
      }
    }
    // catalogo de creators pra recrutar (creator/list)
    if (/affiliateplatform\/creator\/list/.test(url)) {
      var cl = raiz(d).list || (d && d.list) || null;
      if (Array.isArray(cl)) {
        COFRE.afiliados.creatorsDisponiveis = cl.length;
        COFRE.afiliados.creators = cl.slice(0, 20).map(function (c) {
          return {
            usuario: c.username,
            seguidores: n(c.total_follower),
            nichos: c.promote_category_ids || null,
            plataforma: c.popular_social_media ? c.popular_social_media.platform : null
          };
        });
        logar('afiliados_creators', cl.length + ' creators disponiveis', url);
      }
    }
  }

  // [6] FINANCEIRO — a margem verdadeira por pedido (income_components)
  function exFinanceiro(url, d) {
    if (!/get_order_income_components/.test(url)) return;
    var r = raiz(d);
    var bd = r.seller_income_breakdown && r.seller_income_breakdown.breakdown;
    if (!Array.isArray(bd)) return;
    var f = COFRE.financeiro;
    f.componentes = f.componentes || {};
    f.pedidosLidos = f.pedidosLidos || {}; // ANTI-DOBRA: guarda IDs ja contados
    // identifica o pedido (order_id / order_sn) pra nao contar duas vezes
    var oid = String(r.order_id || r.order_sn || achar(d, 'order_id') || achar(d, 'order_sn') || '');
    if (oid && f.pedidosLidos[oid]) return; // ja contamos este pedido — ignora
    if (oid) f.pedidosLidos[oid] = 1;
    f.amostras = Object.keys(f.pedidosLidos).length || ((f.amostras || 0) + 1);
    function somar(nome, valor) {
      if (valor == null) return;
      f.componentes[nome] = (f.componentes[nome] || 0) + valor;
    }
    bd.forEach(function (item) {
      var nomeCampo = item.field_name || item.display_name;
      var valor = real(item.amount);
      somar(nomeCampo, valor);
      if (Array.isArray(item.sub_breakdown)) {
        item.sub_breakdown.forEach(function (sub) {
          somar(sub.field_name || sub.display_name, real(sub.amount));
        });
      }
    });
    logar('financeiro', f.amostras + ' pedidos analisados (taxas reais)', url);
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
      // ---- CEREBRO GERAL (6 inteligencias) ----
      if (/dashboard\/key-metrics|homepage\/key-metrics|dashboard\/order-performance/.test(url)) exGerenciais(url, dados);
      if (/traffic\/overview|dashboard\/traffic-sources/.test(url)) exFunil(url, dados);
      if (/product\/performance|product-rankings|traffic-sources\/product-contribution|traffic\/item-list|get_product_performance_info/.test(url)) exPerformanceProduto(url, dados);
      // a mesma resposta ainda passa pela varredura ampla, que pesca
      // competitiveness/avg_rank soltos em qualquer profundidade
      if (/get_product_performance_info/.test(url)) exProduto(url, dados);
      if (/todo\/list_task/.test(url)) exTarefas(url, dados);
      if (/report\/get_time_graph/.test(url)) exTempo(url, dados);
      if (/\/api\/marketing\//.test(url)) exMarketing(url, dados);
      if (/list_keyword_with_recommended_price/.test(url)) exPalavrasCampanha(url, dados);
      if (/pas\/v1\/config\/get/.test(url)) exPercentis(url, dados);
      if (/list_recommended_keyword/.test(url)) exKeywords(url, dados);
      if (/product\/traffic\/overview/.test(url)) exOrigem(url, dados);
      if (/product\/overview\/metric-trends/.test(url)) exTendencia(url, dados);
      if (/product\/overview\/metric-trends|product\/overview\/|product\/traffic\/overview/.test(url)) exTendenciaProduto(url, dados);
      if (/get_product_lock_info|item\/get_ratings/.test(url)) exSaudeProduto(url, dados);
      if (/accounthealth\/v1\/sc\/shops\/overview/.test(url)) exSaudeConta(url, dados);
      if (/get_campaign_info_by_item_list/.test(url)) exVinculoItemCampanha(url, dados);
      if (/seller_item_detail\/top5/.test(url)) exAfiliadosProdutos(url, dados);
      if (/affiliateplatform\/dashboard\/seller_daily|affiliate_performance\/top5|affiliateplatform\/creator\/list/.test(url)) exAfiliados(url, dados);
      if (/get_order_income_components/.test(url)) exFinanceiro(url, dados);
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
      gerenciais: COFRE.gerenciais && Object.keys(COFRE.gerenciais).length ? COFRE.gerenciais : null,
      funil: COFRE.funil && Object.keys(COFRE.funil).length ? COFRE.funil : null,
      afiliados: COFRE.afiliados && Object.keys(COFRE.afiliados).length ? COFRE.afiliados : null,
      financeiro: COFRE.financeiro && Object.keys(COFRE.financeiro).length ? COFRE.financeiro : null,
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
          cofre: { conta: COFRE.conta, loja: COFRE.loja, ads: COFRE.ads, algoritmo: COFRE.algoritmo, incentivos: COFRE.incentivos, gerenciais: COFRE.gerenciais, funil: COFRE.funil, afiliados: COFRE.afiliados, financeiro: COFRE.financeiro, porProduto: COFRE.porProduto, porCampanha: COFRE.porCampanha, busca: COFRE.busca }
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
          COFRE.gerenciais = Object.assign({}, r.cofre.gerenciais || {}, COFRE.gerenciais);
          COFRE.funil = Object.assign({}, r.cofre.funil || {}, COFRE.funil);
          COFRE.afiliados = Object.assign({}, r.cofre.afiliados || {}, COFRE.afiliados);
          COFRE.financeiro = Object.assign({}, r.cofre.financeiro || {}, COFRE.financeiro);
          COFRE.ads = Object.assign({}, r.cofre.ads || {}, COFRE.ads);
          COFRE.porProduto = Object.assign({}, r.cofre.porProduto || {}, COFRE.porProduto);
          COFRE.porCampanha = Object.assign({}, r.cofre.porCampanha || {}, COFRE.porCampanha);
          COFRE.busca = Object.assign({}, r.cofre.busca || {}, COFRE.busca);
        }
      });
    } catch (e) { /* noop */ }
  }
  carregar(); // ao iniciar, recupera o que ja foi capturado em outras paginas

  // O COFRE e global e acumulava produto de todas as contas: a Conta 360 le
  // dele, entao continuava mostrando produto da loja anterior mesmo depois de
  // o coletor carimbar os pacotes. Zerar na troca e obrigatorio.
  // O COFRE nao tinha dono. Todas as protecoes de conta que eu fiz foram no
  // estado do coletor, mas a lista de produtos da tela le DAQUI — por isso
  // produto de outra loja continuava aparecendo depois de cada correcao.
  // Agora ele sabe de quem e, e se recusa a aceitar dado de outra conta.
  var LOJA_DONA = null;
  function definirLoja(id) {
    var novo = id ? String(id) : null;
    if (!novo) return;
    if (LOJA_DONA && LOJA_DONA !== novo) { zerar('troca de conta: ' + LOJA_DONA + ' -> ' + novo); }
    LOJA_DONA = novo;
  }
  function lojaDona() { return LOJA_DONA; }
  function zerar(motivo) {
    LOJA_DONA = null;
    COFRE.porProduto = {};
    COFRE.porCampanha = {};
    COFRE.conta = {};
    COFRE.loja = {};
    COFRE.ads = {};
    COFRE.funil = {};
    COFRE.afiliados = {};
    COFRE.financeiro = {};
    COFRE.gerenciais = {};
    COFRE.incentivos = {};
    COFRE.algoritmo = {};
    COFRE.busca = {};
    try { console.debug('[Seller.IA] cofre zerado:', motivo || ''); } catch (e) { /* noop */ }
  }
  window.SIA_Diamantes = { versao: VERSAO, processar: processar, estado: estado, resumo: resumo, persistir: persistir, carregar: carregar, zerar: zerar, definirLoja: definirLoja, lojaDona: lojaDona };
})();

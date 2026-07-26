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

  var VERSAO = '1.1.0';

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
    ads: {},         // meta roas, estrategia, cpm
    porProduto: {},  // { itemid: { ...diamantes do produto } }
    porCampanha: {}, // { campaign_id: { veredito, motivo } }
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
        COFRE.porCampanha[e.campaign_id] = {
          nota: (e.summary && e.summary.result) || null,
          problema: (e.summary && e.summary.main_issue) || null,
          eixos: vs
        };
      });
      logar('diagnostico_campanhas', entradas.length + ' campanhas', url);
    } else if (dataObj.verdict_list) {
      var vs2 = dataObj.verdict_list.map(function (v) { return { eixo: v.type, nota: v.result, motivo: v.issue }; });
      COFRE.porCampanha[dataObj.campaign_id || 'atual'] = {
        nota: dataObj.summary && dataObj.summary.result,
        eixos: vs2
      };
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

  // ---- roteador: decide qual extrator roda pra cada rota ----
  function processar(url, dados) {
    if (!url || !dados) return;
    try {
      if (/get_recommended_target_roi|recommended_roi_two_target|estimated_auto_ads_data|budget_data_for_creation|bidding_strategy_eligibility/.test(url)) exLeilaoRoas(url, dados);
      if (/diagnosis\/(list_verdict|homepage_batch_list_verdict)/.test(url)) exDiagnostico(url, dados);
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
          cofre: { conta: COFRE.conta, ads: COFRE.ads, porProduto: COFRE.porProduto, porCampanha: COFRE.porCampanha, busca: COFRE.busca }
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

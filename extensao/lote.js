// ============================================================
// SELLER.IA — COLETOR EM LOTE (disparo automatico)
// v1.0.0
// ------------------------------------------------------------
// Em vez de esperar voce navegar, a extensao DISPARA sozinha as
// chamadas de API que enchem as 6 inteligencias. Com barra de
// progresso. Roda ao abrir a extensao.
//
// Como funciona (clean-room): usa o mesmo fetch que a propria
// pagina da Shopee usa, com os cookies da sua sessao (o navegador
// anexa sozinho). Nao inventa credencial, nao invade — so pede os
// mesmos dados que apareceriam se voce clicasse em cada tela.
//
// 2 ondas:
//   Onda 1 (diretas): gerenciais, funil, performance, saude, afiliados
//   Onda 2 (dependentes): ratings e financeiro dos itens/pedidos achados
// ============================================================
(function () {
  'use strict';
  if (window.SIA_Lote) return;

  var VERSAO = '1.0.0';
  var BASE = 'https://seller.shopee.com.br';

  // ---- descobrir o SPC_CDS (cracha da sessao) de chamadas ja vistas ----
  // o coletor.js guarda as urls brutas; pegamos o SPC_CDS de qualquer uma.
  function acharCDS() {
    try {
      if (window.SIA_ULTIMO_CDS) return window.SIA_ULTIMO_CDS;
      // tenta dos cookies (SPC_CDS costuma estar la)
      var m = document.cookie.match(/SPC_CDS=([^;]+)/);
      if (m) return m[1];
    } catch (e) { }
    return null;
  }

  // ---- datas do periodo (mes atual por padrao) ----
  function periodo(dias) {
    var fim = Math.floor(Date.now() / 1000);
    var ini;
    if (dias) {
      ini = fim - dias * 86400;
    } else {
      // mes corrente: do dia 1 ate agora
      var d = new Date();
      var primeiro = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0);
      ini = Math.floor(primeiro.getTime() / 1000);
    }
    return { start: ini, end: fim };
  }

  // ---- montar a lista de chamadas da Onda 1 ----
  function montarOnda1(cds) {
    var p = periodo();              // mes corrente
    var qBase = 'SPC_CDS=' + cds + '&SPC_CDS_VER=2';
    var qData = qBase + '&start_time=' + p.start + '&end_time=' + p.end + '&period=month';
    return [
      { nome: 'Saude da conta', url: '/api/accounthealth/v1/sc/shops/overview?' + qBase },
      { nome: 'Visao gerencial', url: '/api/mydata/v3/dashboard/key-metrics/?' + qData + '&fetag=fetag' },
      { nome: 'Vendas e cancelamentos', url: '/api/mydata/dashboard/order-performance/?' + qData },
      { nome: 'Funil de visitantes', url: '/api/mydata/v1/product/traffic/overview/?' + qData + '&order_type=paid' },
      { nome: 'Performance de produtos', url: '/api/mydata/v4/product/performance/?' + qData + '&category_type=shopee&category_id=-1&page_size=20&page_num=1&order_type=paid&order_by=paid_sales.desc' },
      { nome: 'Afiliados (resumo)', url: '/api/v3/affiliateplatform/dashboard/seller_daily?start_time=' + p.start + '&end_time=' + (p.end - 1) + '&is_real_time=0&order_type=2&channel=0' },
      { nome: 'Afiliados (top 5)', url: '/api/v3/affiliateplatform/dashboard/affiliate_performance/top5?start_time=' + p.start + '&end_time=' + (p.end - 1) + '&order_type=2&channel=0&has_meta_feature=1' }
    ];
  }

  // ---- disparar uma chamada e entregar o resultado ao diamantes ----
  function disparar(item) {
    return fetch(BASE + item.url, {
      method: 'GET',
      credentials: 'include',       // manda os cookies da sessao (clean-room)
      headers: { 'accept': 'application/json' }
    }).then(function (r) {
      return r.json();
    }).then(function (dados) {
      // entrega ao cerebro exatamente como se tivesse passado na tela
      try { if (window.SIA_Diamantes) window.SIA_Diamantes.processar(BASE + item.url, dados); } catch (e) { }
      return { ok: true, nome: item.nome, dados: dados };
    }).catch(function (e) {
      return { ok: false, nome: item.nome, erro: String(e) };
    });
  }

  // ---- Onda 2: com os produtos/pedidos achados, buscar ratings e financeiro ----
  function montarOnda2(cds) {
    var chamadas = [];
    var qBase = 'SPC_CDS=' + cds + '&SPC_CDS_VER=2';
    try {
      var cofre = window.SIA_Diamantes ? window.SIA_Diamantes.estado() : null;
      if (cofre && cofre.porProduto) {
        // pegar ate 5 produtos com mais venda pra buscar avaliacoes
        var ids = Object.keys(cofre.porProduto);
        // performance 30d de todos de uma vez (a rota aceita lista)
        if (ids.length) {
          chamadas.push({
            nome: 'Performance 30 dias', tipo: 'perf30',
            url: '/api/v3/opt/mpsku/list/v2/get_product_performance_info?' + qBase + '&product_ids=' + ids.slice(0, 50).join(',')
          });
        }
        // avaliacoes dos 5 top produtos
        var top = ids.filter(function (k) { return cofre.porProduto[k].perf; })
          .sort(function (a, b) {
            return (cofre.porProduto[b].perf.vendaPaga || 0) - (cofre.porProduto[a].perf.vendaPaga || 0);
          }).slice(0, 5);
        top.forEach(function (id) {
          chamadas.push({
            nome: 'Avaliacoes', tipo: 'rating',
            url: '/api/v2/item/get_ratings?itemid=' + id + '&filter=0&flag=1&limit=6&offset=0&type=0&exclude_filter=1'
          });
        });
      }
    } catch (e) { }
    return chamadas;
  }

  // ---- rodar tudo, reportando progresso ----
  // onProgress(feito, total, nomeAtual)
  function coletar(onProgress, onDone) {
    var cds = acharCDS();
    if (!cds) {
      if (onDone) onDone({ ok: false, erro: 'sessao nao encontrada. Navegue uma vez pela Shopee e tente de novo.' });
      return;
    }
    var onda1 = montarOnda1(cds);
    var total = onda1.length; // onda 2 soma depois
    var feito = 0;

    function passo(nome) { feito++; if (onProgress) onProgress(feito, total, nome); }

    // dispara Onda 1 em paralelo (rapido), mas reporta uma a uma
    var promessas1 = onda1.map(function (item) {
      return disparar(item).then(function (res) { passo(item.nome); return res; });
    });

    Promise.all(promessas1).then(function (res1) {
      // monta Onda 2 com o que a Onda 1 trouxe
      var onda2 = montarOnda2(cds);
      total += onda2.length;
      if (onProgress) onProgress(feito, total, 'preparando detalhes…');
      var promessas2 = onda2.map(function (item) {
        return disparar(item).then(function (res) { passo(item.nome); return res; });
      });
      return Promise.all(promessas2).then(function (res2) {
        // persiste o cofre atualizado
        try { if (window.SIA_Diamantes && window.SIA_Diamantes.persistir) window.SIA_Diamantes.persistir(); } catch (e) { }
        var todos = res1.concat(res2);
        var ok = todos.filter(function (r) { return r.ok; }).length;
        var falhas = todos.filter(function (r) { return !r.ok; });
        if (onDone) onDone({ ok: true, total: todos.length, sucesso: ok, falhas: falhas });
      });
    });
  }

  window.SIA_Lote = {
    versao: VERSAO,
    coletar: coletar,
    acharCDS: acharCDS
  };
})();

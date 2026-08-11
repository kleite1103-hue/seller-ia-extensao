/**
 * Seller.IA · Analista de Mercado
 *
 * Le um nicho da Shopee por dentro. Nao inventa numero: tudo que aparece
 * na tela vem da resposta da propria Shopee, e o que ela nao entrega a
 * tela diz que nao tem.
 *
 * IMPORTANTE sobre a leitura: os dados de venda so vem quando ha sessao
 * ativa. Deslogado, a Shopee devolve nome e preco e mais nada — foi
 * medido. Como a sessao e sua, o resultado e personalizado: seus proprios
 * produtos podem aparecer mais acima do que apareceriam para um
 * comprador. A tela avisa isso em vez de fingir neutralidade.
 */
(function () {
  'use strict';

  var VERSAO = '1.1.1';
  var MAX_PAGINAS = 3;          // 60 itens por pagina
  var PAUSA = 900;              // entre paginas, para nao parecer raspagem

  var E = {
    termo: '', buscando: false, erro: null,
    itens: [], categorias: {}, historico: null,
    aba: 'nicho', ordem: 'mes', progresso: null,
    detalhe: null, minhaLoja: null, paginasLidas: 0, quando: null,
    calc: null, consulta: null, consultando: false, consultaErro: null
  };

  /* ============ CHAMADAS ============ */
  /* A CHAMADA PRECISA SAIR DA PROPRIA PAGINA.
     Chamar do service worker devolvia erro 90309999, error_not_found: a
     Shopee assina cada requisicao com um cabecalho que so o codigo da
     pagina sabe montar. Do lado de fora, sem essa assinatura, ela recusa.
     Entao a extensao pede a pagina que chame — o mesmo caminho que o
     radar usa para escutar, so que ao contrario. */
  var pendentes = {}, seq = 0;
  window.addEventListener('SIA_MK_RESP', function (ev) {
    var r;
    try { r = JSON.parse(ev.detail); } catch (e) { return; }
    var f = pendentes[r.id];
    if (f) { delete pendentes[r.id]; f(r); }
  });

  function api(url, metodo, corpo) {
    return new Promise(function (ok) {
      var id = 'm' + (++seq) + '_' + Date.now();
      pendentes[id] = ok;
      try {
        window.dispatchEvent(new CustomEvent('SIA_MK_PEDE', {
          detail: JSON.stringify({ id: id, url: url, metodo: metodo || 'GET', corpo: corpo || null })
        }));
      } catch (e) {
        delete pendentes[id];
        ok({ ok: false, erro: 'ponte', detalhe: String(e && e.message || e) });
        return;
      }
      setTimeout(function () {
        if (pendentes[id]) { delete pendentes[id]; ok({ ok: false, erro: 'sem resposta em 25s' }); }
      }, 25000);
    });
  }
  function guardar(chave, valor) {
    return new Promise(function (ok) {
      try {
        chrome.runtime.sendMessage({ tipo: 'mercado:guardar', chave: chave, valor: valor },
          function () { void chrome.runtime.lastError; ok(); });
      } catch (e) { ok(); }
    });
  }
  function ler(chave) {
    return new Promise(function (ok) {
      try {
        chrome.runtime.sendMessage({ tipo: 'mercado:ler', chave: chave },
          function (r) { void chrome.runtime.lastError; ok(r && r.valor); });
      } catch (e) { ok(null); }
    });
  }
  function espera(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* A vitrine manda um identificador de sessao de visualizacao em toda
     busca. Um por analise basta. */
  /* A sessao e derivada do TERMO, nao sorteada. A Shopee personaliza o
     resultado por sessao de busca: com id novo a cada analise, a mesma
     palavra devolvia conjuntos diferentes — foi o que fez o faturamento
     sair 2,9 milhoes numa vez e 200 mil na outra. Mesmo termo, mesma
     sessao, resultado comparavel. */
  function sessaoDaBusca(termo) {
    var h = 0, s = String(termo || '');
    for (var i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h = h & h; }
    var b = Math.abs(h).toString(16).padStart(8, '0');
    return b + '-' + b.slice(0, 4) + '-4' + b.slice(1, 4) + '-8' + b.slice(2, 5) + '-' + b + b.slice(0, 4);
  }

  /* ============ LEITURA DO NICHO ============ */
  async function analisar(termo) {
    try { console.log('[Mercado] analisando:', termo); } catch (e) { }
    E.termo = termo; E.buscando = true; E.erro = null; E.itens = []; E.detalhe = null;
    desenhar();

    var todos = [];
    for (var pg = 0; pg < MAX_PAGINAS; pg++) {
      E.progresso = 'Lendo a pagina ' + (pg + 1) + ' de ' + MAX_PAGINAS + '...';
      desenhar();
      // A URL segue exatamente a que a propria vitrine usa. Faltavam
      // source=SRP e os identificadores de sessao — sem eles a Shopee
      // responde, mas sem itens.
      var url = '/api/v4/search/search_items?by=relevancy&keyword=' +
        encodeURIComponent(termo) + '&limit=60&newest=' + (pg * 60) +
        '&order=desc&page_type=search&scenario=PAGE_GLOBAL_SEARCH&version=2' +
        '&source=SRP&view_session_id=' + sessaoDaBusca(termo) +
        '&extra_params=' + encodeURIComponent(JSON.stringify({
          global_search_session_id: 'gs-' + sessaoDaBusca(termo).slice(0, 8)
        }));
      try { console.log('[Mercado] pagina ' + (pg + 1) + ' ->', url.slice(0, 90)); } catch (e) { }
      var r = await api(url);
      try {
        console.log('[Mercado] resposta:', r && r.ok, '| status:', r && r.status,
          '| erro:', r && r.erro, '| itens:',
          r && r.dados ? ((r.dados.items || (r.dados.data && r.dados.data.items) || []).length) : 'sem dados');
        if (r && r.dados && r.dados.error) console.warn('[Mercado] Shopee error:', r.dados.error, r.dados.error_msg);
      } catch (e) { }
      if (r.erro === 'ponte') {
        E.erro = 'A extensao foi atualizada com esta pagina aberta. ' +
          'Recarregue a Shopee com F5 e tente de novo.';
        break;
      }
      if (!r.ok || !r.dados) {
        E.erro = 'A Shopee nao respondeu a busca' + (r.status ? ' (codigo ' + r.status + ')' : '') +
          (r.erro ? ': ' + r.erro : '') + '.';
        break;
      }
      if (r.dados.error) {
        E.erro = 'A Shopee recusou a busca (erro ' + r.dados.error + ')' +
          (r.dados.error_msg ? ': ' + r.dados.error_msg : '') +
          '. Abra a Shopee logada nesta aba e tente de novo.';
        break;
      }
      var its = (r.dados.items || (r.dados.data && r.dados.data.items) || []);
      if (!its.length) {
        if (pg === 0) {
          E.erro = 'A Shopee respondeu mas nao devolveu produtos. ' +
            'Confira se voce esta logada na Shopee nesta aba \u2014 deslogada ela nao entrega os dados.';
        }
        break;
      }
      todos = todos.concat(its);
      E.paginasLidas = pg + 1;
      // A Shopee nem sempre devolve 60: quando vem menos, e o fim do que
      // ela tem para esse termo. Guardar isso importa porque o total lido
      // muda a leitura de faturamento.
      if (its.length < 60) break;
      await espera(PAUSA);
    }

    E.progresso = 'Organizando...';
    desenhar();

    // Diagnostico: se a resposta vier com outra estrutura, e aqui que se
    // descobre — em vez de a tela ficar vazia sem dizer por que.
    try {
      if (todos.length) {
        var am = todos[0];
        console.log('[Mercado] chaves do item:', Object.keys(am).slice(0, 20).join(', '));
        console.log('[Mercado] tem item_data:', !!am.item_data, '| tem item_basic:', !!am.item_basic,
          '| tem asset:', !!am.item_card_displayed_asset);
      }
    } catch (e) { }

    E.itens = todos.map(traduzirItem).filter(function (x) { return x.id; });

    try {
      console.log('[Mercado] traduzidos:', E.itens.length,
        '| com nome:', E.itens.filter(function (x) { return x.nome; }).length,
        '| com preco:', E.itens.filter(function (x) { return x.preco != null; }).length,
        '| com venda:', E.itens.filter(function (x) { return x.mes != null; }).length);
    } catch (e) { }
    await nomearCategorias();
    await guardarVolumes();
    await identificarMinhaLoja();

    // GUARDA A ANALISE. Fechar a gaveta nao pode perder o trabalho: a
    // pessoa fecha para olhar um anuncio e volta esperando encontrar tudo
    // no lugar.
    if (E.itens.length) {
      try {
        await guardar('ultima_analise', JSON.stringify({
          termo: E.termo, em: Date.now(), paginas: E.paginasLidas,
          itens: E.itens, categorias: E.categorias, minhaLoja: E.minhaLoja
        }));
      } catch (e) { }
    }

    E.buscando = false; E.progresso = null;
    if (!E.itens.length && !E.erro) E.erro = 'A Shopee nao devolveu resultados para este termo.';
    try { console.log('[Mercado] fim:', E.itens.length, 'produtos | erro:', E.erro || 'nenhum'); } catch (e) { }
    desenhar();
  }

  /* Traduz o item da busca para o que a analise usa. Cada campo aqui
     existe na resposta — nada e calculado por fora. */
  function traduzirItem(it) {
    // A vitrine ja devolveu duas formas: item_data com o asset ao lado, e
    // item_basic com tudo dentro. Aceita as duas em vez de assumir uma.
    var b = it.item_basic || {};
    var d = it.item_data || b;
    var a = it.item_card_displayed_asset || b;
    var sc = d.item_card_display_sold_count || {};
    var pr = d.item_card_display_price || {};
    var sd = d.shop_data || {};
    var t = {};
    try { t = JSON.parse(it.search_item_tracking || '{}'); } catch (e) { }

    var preco = pr.price != null ? pr.price / 100000
      : (b.price != null ? b.price / 100000 : null);
    var mes = sc.monthly_sold_count != null ? sc.monthly_sold_count
      : (b.sold != null ? b.sold : null);
    var total = sc.historical_sold_count != null ? sc.historical_sold_count
      : (b.historical_sold != null ? b.historical_sold : null);

    return {
      id: it.itemid || b.itemid || d.itemid,
      loja: it.shopid || b.shopid || d.shopid,
      link: (it.shopid && it.itemid)
        ? ('https://shopee.com.br/product/' + it.shopid + '/' + it.itemid)
        : null,
      nome: a.name || b.name || it.display_name || '',
      lojaNome: sd.shop_name || '',
      local: a.shop_location || sd.shop_location || '',
      preco: preco,
      precoAntes: pr.strikethrough_price != null ? pr.strikethrough_price / 100000 : null,
      desconto: pr.discount || null,
      mes: mes, total: total,
      // faturamento no mes: os dois numeros vem da Shopee, a multiplicacao
      // e nossa e a tela diz isso
      fatMes: (mes != null && preco != null) ? mes * preco : null,
      // A nota vive em item_data.item_rating, nao no asset: eu procurava no
      // lugar errado e ela vinha sempre vazia.
      nota: (d.item_rating && d.item_rating.rating_star != null) ? d.item_rating.rating_star
        : (a.rating && a.rating.rating_star != null ? a.rating.rating_star : null),
      estrelas: (d.item_rating && d.item_rating.rating_count) || (a.rating && a.rating.rating_count) || null,
      curtidas: d.liked_count != null ? d.liked_count : null,
      cadastro: d.ctime || null,
      catid: d.catid || null,
      // global_brand e um objeto com display_name dentro
      marca: (d.global_brand && d.global_brand.display_name) || d.brand || null,
      verificada: !!d.shopee_verified,
      oficial: !!d.is_official_shop,
      // Fotos: confirmado que existe na busca. Video, variacoes e estoque
      // NAO vem aqui — so na pagina do produto — entao nao invento.
      fotos: (d.images && d.images.length) || (b.images && b.images.length) ||
        (a.images && a.images.length) || null,
      anuncio: !!it.adsid,
      adRank: t.ads_rank_bid || null,
      imagem: a.image || null
    };
  }

  /* A Shopee entrega a arvore de categorias com o nome em portugues. */
  async function nomearCategorias() {
    var ids = {};
    E.itens.forEach(function (x) { if (x.catid) ids[x.catid] = 1; });
    if (!Object.keys(ids).length) return;
    if (Object.keys(E.categorias).length) return;   // ja temos
    // A arvore da vitrine. Se a Shopee mudar o caminho, a tela mostra o
    // numero da categoria em vez de quebrar — categoria e enfeite util,
    // nao a analise.
    var r = await api('/api/v4/pages/get_category_tree');
    if (!r.ok || !r.dados || r.dados.error) {
      try { console.warn('[Mercado] arvore de categorias indisponivel; mostrando o codigo'); } catch (e) { }
      return;
    }
    var lista = (r.dados.data && r.dados.data.category_list) || r.dados.category_list || [];
    function percorrer(ns, caminho) {
      for (var i = 0; i < ns.length; i++) {
        var n = ns[i];
        var nome = n.display_name || n.name || '';
        if (n.catid) E.categorias[n.catid] = caminho ? caminho + ' > ' + nome : nome;
        if (n.children && n.children.length) percorrer(n.children, caminho ? caminho + ' > ' + nome : nome);
      }
    }
    percorrer(lista, '');
  }

  /* O historico de volume. A Shopee da o numero de hoje; guardando o
     nosso, em duas semanas da para dizer quem esta acelerando. */
  async function guardarVolumes() {
    var h = E.historico;
    if (!h) { try { h = JSON.parse((await ler('hist_volume')) || '{}'); } catch (e) { h = {}; } }
    var hoje = new Date().toISOString().slice(0, 10);
    E.itens.forEach(function (x) {
      if (x.mes == null || !x.id) return;
      var k = String(x.id);
      h[k] = h[k] || [];
      var ult = h[k][h[k].length - 1];
      if (ult && ult.d === hoje) { ult.v = x.mes; ult.t = x.total; }
      else h[k].push({ d: hoje, v: x.mes, t: x.total });
      if (h[k].length > 90) h[k] = h[k].slice(-90);
    });
    var ks = Object.keys(h);
    if (ks.length > 3000) ks.slice(0, ks.length - 3000).forEach(function (k) { delete h[k]; });
    E.historico = h;
    await guardar('hist_volume', JSON.stringify(h));
  }

  function tendencia(id) {
    var h = E.historico; if (!h) return null;
    var s = h[String(id)]; if (!s || s.length < 2) return null;
    var a = s[0], b = s[s.length - 1];
    if (!a.v) return null;
    var dias = Math.round((new Date(b.d) - new Date(a.d)) / 86400000);
    if (dias < 1) return null;
    return { pct: ((b.v - a.v) / a.v) * 100, dias: dias };
  }

  /* O caminho certo tem o "basic" no meio: sem ele a Shopee devolve 404 e
     a aba "onde eu estou" nao sabe quais produtos sao seus. Confirmado na
     captura do radar. */
  async function identificarMinhaLoja() {
    if (E.minhaLoja) return;
    var caminhos = [
      '/api/v4/account/basic/get_account_info',
      '/api/v2/login/'
    ];
    for (var i = 0; i < caminhos.length; i++) {
      var r = await api(caminhos[i]);
      try {
        var d = (r.dados && (r.dados.data || r.dados)) || {};
        var id = d.shopid || d.shop_id;
        if (id) {
          E.minhaLoja = id;
          try { console.log('[Mercado] sua loja:', id, d.username || ''); } catch (e) { }
          return;
        }
      } catch (e) { }
    }
    try { console.warn('[Mercado] nao consegui identificar a loja logada'); } catch (e) { }
  }

  /* ============ AS CONTAS ============ */
  function resumo() {
    var I = E.itens.filter(function (x) { return x.mes != null; });
    if (!I.length) return null;
    var fat = I.reduce(function (a, b) { return a + (b.fatMes || 0); }, 0);
    var vend = I.reduce(function (a, b) { return a + (b.mes || 0); }, 0);
    var precos = I.filter(function (x) { return x.preco; }).map(function (x) { return x.preco; }).sort(function (a, b) { return a - b; });
    var lojas = {};
    I.forEach(function (x) { if (x.loja) lojas[x.loja] = (lojas[x.loja] || 0) + (x.fatMes || 0); });
    var top = Object.keys(lojas).sort(function (a, b) { return lojas[b] - lojas[a]; });
    var top5 = top.slice(0, 5).reduce(function (a, k) { return a + lojas[k]; }, 0);
    return {
      itens: I.length,
      vendas: vend,
      faturamento: fat,
      ticket: vend ? fat / vend : 0,
      precoMin: precos[0], precoMax: precos[precos.length - 1],
      precoMediano: precos[Math.floor(precos.length / 2)],
      lojas: top.length,
      concentracao: fat ? (top5 / fat) * 100 : 0,
      anuncios: E.itens.filter(function (x) { return x.anuncio; }).length,
      semVenda: E.itens.filter(function (x) { return x.mes === 0; }).length
    };
  }




  /* ============ O CONSULTOR ============
     A IA NAO calcula. Ela recebe os numeros ja prontos e diz o que fazer
     com eles — porque conta ela erra e a pessoa nao teria como conferir,
     enquanto leitura de mercado e justamente onde ela ajuda.

     O texto sai do cerebro que ja existe no Supabase, com a chave que
     nunca passa pela extensao. */

  var URL_CONSULTOR = 'https://mkfreezlizdbfpjjpxoo.supabase.co/functions/v1/mercado-consultor';

  function dossie() {
    var R = resumo();
    if (!R) return null;
    var ordV = E.itens.filter(function (x) { return x.mes != null; })
      .sort(function (a, b) { return (b.mes || 0) - (a.mes || 0); });
    var top = ordV.slice(0, 10), resto = ordV.slice(10);
    function m(l, c) {
      var v = l.map(function (x) { return x[c]; }).filter(function (x) { return x != null; });
      return v.length ? Math.round((v.reduce(function (a, b) { return a + b; }, 0) / v.length) * 100) / 100 : null;
    }
    var C = E.calc || {};
    var preco = C.preco || R.precoMediano;
    var comp = quantoPagar(preco, 15, C.roas || 10, C.imposto || 0, C.embalagem || 0);
    var saud = quantoPagar(preco, 20, C.roas || 10, C.imposto || 0, C.embalagem || 0);

    var lojas = {};
    E.itens.forEach(function (x) {
      if (!x.loja) return;
      lojas[x.loja] = lojas[x.loja] || { nome: x.lojaNome, itens: 0, fat: 0, local: x.local };
      lojas[x.loja].itens++; lojas[x.loja].fat += x.fatMes || 0;
    });
    var ordL = Object.keys(lojas).map(function (k) { return lojas[k]; })
      .sort(function (a, b) { return b.fat - a.fat; }).slice(0, 5);

    var meus = E.minhaLoja ? E.itens.filter(function (x) { return x.loja === E.minhaLoja; }) : [];

    return {
      termo: E.termo,
      amostra: { produtos: E.itens.length, paginas: E.paginasLidas || 1 },
      mercado: {
        vendasMes: R.vendas, faturamentoAmostra: Math.round(R.faturamento),
        ticket: Math.round(R.ticket * 100) / 100,
        precoMin: R.precoMin, precoMax: R.precoMax, precoMediano: R.precoMediano,
        vendedores: R.lojas, concentracaoTop5: Math.round(R.concentracao),
        anunciando: R.anuncios, semVenda: R.semVenda
      },
      campeoes: top.map(function (x) {
        return {
          nome: String(x.nome).slice(0, 70), vendeMes: x.mes, total: x.total,
          preco: x.preco, loja: x.lojaNome, fotos: x.fotos, nota: x.nota,
          anuncio: x.anuncio, local: x.local,
          diasNoAr: x.cadastro ? Math.round((Date.now() / 1000 - x.cadastro) / 86400) : null
        };
      }),
      comparacao: {
        top10: { fotos: m(top, 'fotos'), nota: m(top, 'nota'), preco: m(top, 'preco'), anunciando: top.filter(function (x) { return x.anuncio; }).length },
        resto: { fotos: m(resto, 'fotos'), nota: m(resto, 'nota'), preco: m(resto, 'preco'), anunciando: resto.filter(function (x) { return x.anuncio; }).length, quantos: resto.length }
      },
      lideres: ordL.map(function (l) { return { nome: l.nome, produtos: l.itens, faturamento: Math.round(l.fat), local: l.local }; }),
      custo: {
        precoBase: preco, roas: C.roas || 10, imposto: C.imposto || 0, embalagem: C.embalagem || 0,
        pagueAte15: Math.round(comp.teto * 100) / 100,
        pagueAte20: Math.round(saud.teto * 100) / 100,
        comissao: Math.round(comp.comissao * 100) / 100,
        ads: Math.round(comp.ads * 100) / 100
      },
      // A pergunta que importa mais que o preco: da para vender o
      // suficiente para pagar a operacao?
      viabilidade: (function () {
        var f = numeroPuro(C.fixo);
        if (!f || !saud.viavel) return null;
        var precisa = Math.ceil(f / saud.margem);
        var lider = ordV.length ? ordV[0].mes : 0;
        var mediana = ordV.length ? ordV[Math.floor(ordV.length / 2)].mes : 0;
        return {
          custoFixoMes: f,
          margemPorVenda: Math.round(saud.margem * 100) / 100,
          vendasParaEmpatar: precisa,
          liderVende: lider, medianaVende: mediana,
          pctDoLider: lider ? Math.round((precisa / lider) * 100) : null
        };
      })(),
      voce: E.minhaLoja ? {
        produtosAqui: meus.length,
        vendasMes: meus.reduce(function (a, b) { return a + (b.mes || 0); }, 0),
        faturamento: Math.round(meus.reduce(function (a, b) { return a + (b.fatMes || 0); }, 0)),
        posicoes: meus.map(function (x) { return { nome: String(x.nome).slice(0, 50), posicao: ordV.indexOf(x) + 1, vende: x.mes, preco: x.preco }; })
      } : null
    };
  }

  async function consultar() {
    var d = dossie();
    if (!d) { alert('Analise um nicho antes de pedir a leitura.'); return; }
    E.consultando = true; E.consulta = null; desenhar();
    try {
      var r = await fetch(URL_CONSULTOR, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dossie: d })
      });
      var j = await r.json();
      E.consulta = (j && j.texto) || null;
      if (!E.consulta) E.consultaErro = (j && j.erro) || 'nao veio resposta';
    } catch (e) {
      E.consultaErro = String(e && e.message || e);
    }
    E.consultando = false;
    desenhar();
  }

  /* ============ QUANTO PAGAR PELO PRODUTO ============
     A conta inversa da precificacao: partindo do preco que o mercado
     pratica, tira comissao, Ads, imposto e embalagem, e o que sobra e o
     maximo que da para pagar ao fornecedor mantendo a margem.

     Nao ha IA aqui de proposito: conta e matematica, e a pessoa precisa
     poder conferir cada linha. */

  function comissaoShopee(preco) {
    // Faixas confirmadas: ate 80 e 20% + R$4; acima disso 14% mais um fixo
    // que muda por faixa de preco.
    if (preco < 80) return preco * 0.20 + 4;
    if (preco < 100) return preco * 0.14 + 16;
    if (preco < 200) return preco * 0.14 + 20;
    return preco * 0.14 + 26;
  }

  function quantoPagar(preco, margemPct, roas, impostoPct, embalagem) {
    if (!preco) return null;
    var com = comissaoShopee(preco);
    var ads = roas > 0 ? preco / roas : 0;        // o que o anuncio come por venda
    var imp = preco * ((impostoPct || 0) / 100);
    var mar = preco * ((margemPct || 0) / 100);
    var teto = preco - com - ads - imp - mar - (embalagem || 0);
    return {
      preco: preco, comissao: com, ads: ads, imposto: imp, margem: mar,
      embalagem: embalagem || 0, teto: teto,
      viavel: teto > 0
    };
  }

  function renderCalculo() {
    var R = resumo();
    if (!R) return '';
    var C = E.calc = E.calc || { margem: 15, roas: 10, imposto: 0, embalagem: 0, preco: null };
    var preco = C.preco != null ? C.preco : R.precoMediano;

    function campo(id, rot, val, suf) {
      return '<div><div style="font:400 9.5px \'Space Mono\',monospace;color:#6B6355;margin-bottom:5px">' + rot + '</div>' +
        '<div style="display:flex;align-items:center;gap:6px">' +
        '<input data-calc="' + id + '" value="' + esc(String(val == null ? '' : val)) + '" ' +
        'style="width:100%;background:#fff;border:1px solid #D9CFBC;border-radius:10px;padding:9px 11px;font-size:14px;font-family:\'Space Mono\',monospace">' +
        (suf ? '<span style="font-size:12px;color:#6B6355">' + suf + '</span>' : '') + '</div></div>';
    }

    var h = olho('POR QUANTO VOCE PRECISA COMPRAR',
      'Partindo do preco que este nicho pratica, a conta tira a comissao da Shopee, o que o anuncio come, o imposto e a embalagem. O que sobra e o <b>maximo que da para pagar ao fornecedor</b> mantendo a margem que voce quer.');

    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:10px;margin-bottom:16px">' +
      campo('preco', 'PRECO DE VENDA', num(preco, 2), 'R$') +
      campo('margem', 'MARGEM', C.margem, '%') +
      campo('roas', 'ROAS ALVO', C.roas, 'x') +
      campo('imposto', 'IMPOSTO', C.imposto, '%') +
      campo('embalagem', 'EMBALAGEM', C.embalagem, 'R$') +
      campo('fixo', 'CUSTO FIXO/MES', C.fixo, 'R$') +
      '</div>';

    // os dois cenarios que a Karina pediu
    var comp = quantoPagar(preco, 15, C.roas, C.imposto, C.embalagem);
    var saud = quantoPagar(preco, 20, C.roas, C.imposto, C.embalagem);
    var seu = quantoPagar(preco, numeroPuro(C.margem), C.roas, C.imposto, C.embalagem);

    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:14px">';
    [['PARA COMPETIR \u00b7 margem 15%', comp, '#B07208'],
     ['PARA SER SAUDAVEL \u00b7 margem 20%', saud, '#0F7A4A']].forEach(function (c) {
      h += '<div style="background:#fff;border:1px solid #D9CFBC;border-left:3px solid ' + c[2] + ';border-radius:0 19px 19px 0;padding:16px 18px">' +
        '<div style="font:400 9.5px \'Space Mono\',monospace;color:#6B6355;letter-spacing:.06em;margin-bottom:8px">' + c[0] + '</div>' +
        '<div style="font:600 30px Archivo,Arial;letter-spacing:-.03em;color:' + (c[1].viavel ? c[2] : '#C1121F') + '">' +
        (c[1].viavel ? reais(c[1].teto) : 'nao fecha') + '</div>' +
        '<div style="font-size:13px;color:#463F33;margin-top:5px">' +
        (c[1].viavel ? 'e o maximo por unidade' : 'a este preco nao sobra nada') + '</div></div>';
    });
    h += '</div>';

    // de onde sai cada real
    h += '<div style="background:#fff;border:1px solid #D9CFBC;border-radius:19px;padding:16px 18px;margin-bottom:14px">';
    function ln(rot, v, cor) {
      return '<div style="display:flex;justify-content:space-between;font-size:14px;padding:5px 0;color:' + (cor || '#1A1610') + '">' +
        '<span>' + rot + '</span><span style="font-family:\'Space Mono\',monospace">' + v + '</span></div>';
    }
    h += ln('Preco de venda', reais(seu.preco), '#000');
    h += ln('\u2212 Comissao Shopee', '\u2212 ' + reais(seu.comissao), '#463F33');
    h += ln('\u2212 Ads (ROAS ' + C.roas + 'x)', '\u2212 ' + reais(seu.ads), '#463F33');
    if (seu.imposto) h += ln('\u2212 Imposto', '\u2212 ' + reais(seu.imposto), '#463F33');
    if (seu.embalagem) h += ln('\u2212 Embalagem', '\u2212 ' + reais(seu.embalagem), '#463F33');
    h += ln('\u2212 Sua margem (' + C.margem + '%)', '\u2212 ' + reais(seu.margem), '#463F33');
    h += '<div style="display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid #D9CFBC;margin-top:8px;padding-top:9px">' +
      '<span style="font-size:15px;font-weight:600">Pague ate</span>' +
      '<span style="font:600 26px Archivo,Arial;letter-spacing:-.02em;color:' + (seu.viavel ? '#0F7A4A' : '#C1121F') + '">' +
      (seu.viavel ? reais(seu.teto) : reais(seu.teto)) + '</span></div></div>';

    /* EU CONSIGO VENDER O SUFICIENTE AQUI?
       A margem de contribuicao nao e lucro: e o que sobra para pagar
       aluguel, salario e energia antes de virar lucro. Com o custo fixo
       na mao, da para dizer quantas vendas o produto precisa fazer — e
       cruzando com o volume do nicho, se isso e alcancavel. */
    var fixo = numeroPuro(C.fixo);
    if (fixo > 0 && seu.viavel) {
      var ordVol = E.itens.filter(function (x) { return x.mes != null; })
        .sort(function (a, b) { return b.mes - a.mes; });
      var precisa = Math.ceil(fixo / seu.margem);
      var lider = ordVol.length ? ordVol[0].mes : 0;
      var medianaVol = ordVol.length ? ordVol[Math.floor(ordVol.length / 2)].mes : 0;
      var pctLider = lider ? (precisa / lider) * 100 : null;

      h += olho('EU CONSIGO VENDER O SUFICIENTE AQUI?',
        'A margem de contribuicao nao e lucro \u2014 e o que sobra para pagar o custo fixo. Estas contas dizem quantas vendas o produto precisa fazer por mes so para empatar.');

      h += '<div style="background:#fff;border:1px solid #D9CFBC;border-radius:19px;padding:18px 20px;margin-bottom:12px">' +
        '<div style="display:flex;gap:28px;flex-wrap:wrap;margin-bottom:14px">' +
        '<div><div style="font:600 34px Archivo,Arial;letter-spacing:-.03em;line-height:1;color:' +
        (pctLider != null && pctLider <= 100 ? '#0F7A4A' : '#C1121F') + '">' + num(precisa) + '</div>' +
        '<div style="font:400 9.5px \'Space Mono\',monospace;color:#6B6355;margin-top:5px">VENDAS/MES SO PARA EMPATAR</div></div>' +
        '<div><div style="font:600 34px Archivo,Arial;letter-spacing:-.03em;line-height:1">' + num(lider) + '</div>' +
        '<div style="font:400 9.5px \'Space Mono\',monospace;color:#6B6355;margin-top:5px">O LIDER FAZ</div></div>' +
        '<div><div style="font:600 34px Archivo,Arial;letter-spacing:-.03em;line-height:1">' + num(medianaVol) + '</div>' +
        '<div style="font:400 9.5px \'Space Mono\',monospace;color:#6B6355;margin-top:5px">A MEDIANA FAZ</div></div>' +
        '</div>';

      if (pctLider != null) {
        h += '<div class="barra"><i style="width:' + Math.min(100, pctLider) + '%;background:' +
          (pctLider <= 60 ? '#0F7A4A' : pctLider <= 100 ? '#B07208' : '#C1121F') + '"></i></div>';
        h += '<div style="font-size:14.5px;line-height:1.6;color:#1A1610;margin-top:8px">';
        if (pctLider > 100) {
          h += 'Para cobrir <b>' + reais(fixo) + '</b> de custo fixo, este produto precisaria vender <b>' + num(precisa) +
            '</b> por mes \u2014 <b>mais que o lider do nicho</b>, que faz ' + num(lider) + '. ' +
            'Neste preco e com esta margem, o produto sozinho nao paga a operacao. ' +
            'Ou o custo fixo se divide entre mais produtos, ou a margem precisa ser maior.';
        } else if (pctLider > 60) {
          h += 'Precisa de <b>' + num(precisa) + '</b> vendas por mes, o que e <b>' + num(pctLider, 0) +
            '% do que o lider faz</b>. E possivel, mas exige chegar perto do topo \u2014 nao e um produto para ficar no meio da lista.';
        } else {
          h += 'Precisa de <b>' + num(precisa) + '</b> vendas por mes, <b>' + num(pctLider, 0) +
            '% do que o lider faz</b>. Cabe sem precisar liderar: ' +
            (medianaVol >= precisa
              ? 'ate a mediana do nicho ja vende mais que isso.'
              : 'mas a mediana vende ' + num(medianaVol) + ', entao voce precisa ficar acima da media.');
        }
        h += '</div>';
      }
      h += '</div>';

      // e se dividir entre varios produtos
      if (pctLider != null && pctLider > 60) {
        [2, 3, 5].forEach(function (n2, i2) {
          if (i2) return;
          var porProduto = Math.ceil(precisa / n2);
          h += '<div class="nota">Dividindo o custo fixo entre <b>' + n2 + ' produtos</b> como este, cada um precisa de <b>' +
            num(porProduto) + '</b> vendas por mes' +
            (medianaVol >= porProduto ? ' \u2014 o que a mediana do nicho ja faz.' : '.') + '</div>';
        });
      }
    }

    // o efeito do ROAS
    h += olho('O QUE MUDA SE O ANUNCIO RENDER MAIS OU MENOS');
    h += '<table><tr><th>ROAS</th><th class="num">ADS COME</th><th class="num">PAGUE ATE (15%)</th><th class="num">PAGUE ATE (20%)</th></tr>';
    [4, 6, 8, 10, 15, 20].forEach(function (r) {
      var a = quantoPagar(preco, 15, r, C.imposto, C.embalagem);
      var b2 = quantoPagar(preco, 20, r, C.imposto, C.embalagem);
      h += '<tr' + (String(r) === String(C.roas) ? ' style="background:rgba(230,62,27,.06)"' : '') + '>' +
        '<td><b>' + r + 'x</b></td><td class="num">' + reais(a.ads) + '</td>' +
        '<td class="num" style="color:' + (a.viavel ? '#0F7A4A' : '#C1121F') + '">' + reais(a.teto) + '</td>' +
        '<td class="num" style="color:' + (b2.viavel ? '#0F7A4A' : '#C1121F') + '">' + reais(b2.teto) + '</td></tr>';
    });
    h += '</table>';
    h += '<div class="nota">Quanto mais o anuncio rende, mais sobra para o produto. Um ROAS de <b>4x</b> come ' +
      reais(quantoPagar(preco, 15, 4, C.imposto, C.embalagem).ads) + ' por venda; a <b>20x</b>, apenas ' +
      reais(quantoPagar(preco, 15, 20, C.imposto, C.embalagem).ads) + '. ' +
      'A diferenca entre os dois e o que voce pode pagar a mais pelo produto.</div>';

    return h;
  }

  function numeroPuro(v) {
    if (v == null || v === '') return 0;
    var s = String(v).replace(/[^0-9,.-]/g, '').replace(/\.(?=.*[.,])/g, '').replace(',', '.');
    var n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }

  /* ============ RELATORIO ============
     Um arquivo que a pessoa guarda, manda para o time, ou abre depois. Os
     links sao clicaveis porque a analise so vale se der para ir ver o
     anuncio. */
  function gerarRelatorio() {
    var R = resumo();
    if (!R) { alert('Analise um nicho antes de gerar o relatorio.'); return; }
    var ordV = E.itens.filter(function (x) { return x.mes != null; })
      .sort(function (a, b) { return (b.mes || 0) - (a.mes || 0); });
    var top = ordV.slice(0, 10);
    var data = new Date().toLocaleDateString('pt-BR');

    var L = [];
    L.push('# ' + E.termo.toUpperCase());
    L.push('');
    L.push('Analise de ' + data + ' \u00b7 ' + E.itens.length + ' produtos lidos em ' +
      (E.paginasLidas || 1) + ' pagina(s) de busca.');
    L.push('');
    L.push('> **Isto e uma amostra, nao o mercado inteiro.** Os numeros abaixo somam apenas os ');
    L.push('> ' + E.itens.length + ' produtos que a Shopee mostrou para quem procura por "' + E.termo + '". ');
    L.push('> Existem outros vendedores alem destes. A leitura tambem vem de uma sessao logada, ');
    L.push('> e a Shopee personaliza a ordem dos resultados.');
    L.push('');
    L.push('## O retrato');
    L.push('');
    L.push('| | |');
    L.push('|---|---|');
    L.push('| Vendas no mes | ' + num(R.vendas) + ' |');
    L.push('| Faturamento da amostra | ' + reais(R.faturamento) + ' |');
    L.push('| Ticket medio | ' + reais(R.ticket) + ' |');
    L.push('| Faixa de preco | ' + reais(R.precoMin) + ' a ' + reais(R.precoMax) + ' |');
    L.push('| Preco mediano | ' + reais(R.precoMediano) + ' |');
    L.push('| Vendedores | ' + R.lojas + ' |');
    L.push('| Concentracao nos 5 maiores | ' + num(R.concentracao, 0) + '% |');
    L.push('| Anunciando | ' + R.anuncios + ' de ' + E.itens.length + ' |');
    L.push('| Sem venda no mes | ' + R.semVenda + ' |');
    L.push('');

    L.push('## Os 10 que mais vendem');
    L.push('');
    L.push('| # | Produto | Vende/mes | Preco | Fatura | Loja |');
    L.push('|---|---|---|---|---|---|');
    top.forEach(function (x, i) {
      var nome = String(x.nome).replace(/\|/g, ' ').slice(0, 60);
      L.push('| ' + (i + 1) + ' | ' + (x.link ? '[' + nome + '](' + x.link + ')' : nome) + ' | ' +
        num(x.mes) + ' | ' + reais(x.preco) + ' | ' + (x.fatMes != null ? reais(x.fatMes) : '\u2014') + ' | ' +
        String(x.lojaNome || '').replace(/\|/g, ' ') + ' |');
    });
    L.push('');

    // o que os campeoes tem
    if (ordV.length >= 10) {
      var resto = ordV.slice(10);
      function m(l, c) {
        var v = l.map(function (y) { return y[c]; }).filter(function (y) { return y != null; });
        return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
      }
      L.push('## O que os campeoes tem de diferente');
      L.push('');
      L.push('| | Top 10 | O resto |');
      L.push('|---|---|---|');
      var ft = m(top, 'fotos'), fr = m(resto, 'fotos');
      if (ft && fr) L.push('| Fotos | ' + num(ft, 1) + ' | ' + num(fr, 1) + ' |');
      var nt = m(top, 'nota'), nr = m(resto, 'nota');
      if (nt && nr) L.push('| Nota | ' + num(nt, 2) + ' | ' + num(nr, 2) + ' |');
      var pt = m(top, 'preco'), prr = m(resto, 'preco');
      if (pt && prr) L.push('| Preco medio | ' + reais(pt) + ' | ' + reais(prr) + ' |');
      L.push('| Anunciando | ' + top.filter(function (x) { return x.anuncio; }).length + ' de 10 | ' +
        resto.filter(function (x) { return x.anuncio; }).length + ' de ' + resto.length + ' |');
      L.push('');
    }

    // da para vender o suficiente
    var Cr = E.calc || {};
    var fixoR = numeroPuro(Cr.fixo);
    if (fixoR > 0) {
      var precoR = Cr.preco || R.precoMediano;
      var sr = quantoPagar(precoR, 20, Cr.roas || 10, Cr.imposto || 0, Cr.embalagem || 0);
      if (sr.viavel) {
        var precisaR = Math.ceil(fixoR / sr.margem);
        var liderR = ordV.length ? ordV[0].mes : 0;
        L.push('## Da para vender o suficiente?');
        L.push('');
        L.push('Com custo fixo de ' + reais(fixoR) + ' por mes e margem de ' + reais(sr.margem) + ' por venda,');
        L.push('este produto precisa vender **' + num(precisaR) + ' por mes** so para empatar.');
        L.push('');
        L.push('O lider do nicho faz ' + num(liderR) + ' por mes' +
          (liderR ? ' \u2014 ou seja, ' + num((precisaR / liderR) * 100, 0) + '% do que ele vende.' : '.'));
        L.push('');
        L.push('_Margem de contribuicao nao e lucro: e o que sobra para pagar o custo fixo._');
        L.push('');
      }
    }

    // quanto pagar
    var precoRel = (E.calc && E.calc.preco) || R.precoMediano;
    var c15 = quantoPagar(precoRel, 15, (E.calc && E.calc.roas) || 10, (E.calc && E.calc.imposto) || 0, (E.calc && E.calc.embalagem) || 0);
    var c20 = quantoPagar(precoRel, 20, (E.calc && E.calc.roas) || 10, (E.calc && E.calc.imposto) || 0, (E.calc && E.calc.embalagem) || 0);
    L.push('## Por quanto comprar');
    L.push('');
    L.push('Vendendo a ' + reais(precoRel) + ', com ROAS ' + ((E.calc && E.calc.roas) || 10) + 'x:');
    L.push('');
    L.push('| Margem | Pague ate |');
    L.push('|---|---|');
    L.push('| 15% (competitivo) | **' + reais(c15.teto) + '** |');
    L.push('| 20% (saudavel) | **' + reais(c20.teto) + '** |');
    L.push('');
    L.push('Descontando comissao ' + reais(c15.comissao) + ', Ads ' + reais(c15.ads) +
      (c15.imposto ? ', imposto ' + reais(c15.imposto) : '') +
      (c15.embalagem ? ', embalagem ' + reais(c15.embalagem) : '') + '.');
    L.push('');

    // os vendedores
    var LJ = {};
    E.itens.forEach(function (x) {
      if (!x.loja) return;
      var l = LJ[x.loja] = LJ[x.loja] || { nome: x.lojaNome, itens: 0, mes: 0, fat: 0, local: x.local };
      l.itens++; l.mes += x.mes || 0; l.fat += x.fatMes || 0;
    });
    var ordL = Object.keys(LJ).map(function (k) { return LJ[k]; }).sort(function (a, b) { return b.fat - a.fat; });
    L.push('## Quem domina');
    L.push('');
    L.push('| Loja | Produtos | Vendas/mes | Faturamento | Onde |');
    L.push('|---|---|---|---|---|');
    ordL.slice(0, 10).forEach(function (l) {
      L.push('| ' + String(l.nome || '?').replace(/\|/g, ' ') + ' | ' + l.itens + ' | ' + num(l.mes) + ' | ' +
        reais(l.fat) + ' | ' + (l.local || '') + ' |');
    });
    L.push('');

    // onde voce esta
    if (E.minhaLoja) {
      var meus = E.itens.filter(function (x) { return x.loja === E.minhaLoja; });
      L.push('## Onde voce esta');
      L.push('');
      if (!meus.length) {
        L.push('Nenhum produto seu apareceu nesta amostra de ' + E.itens.length + ' resultados.');
      } else {
        var meuFat = meus.reduce(function (a, b) { return a + (b.fatMes || 0); }, 0);
        L.push('Voce tem **' + meus.length + '** produto(s) aqui, somando **' + reais(meuFat) + '** por mes \u2014 ' +
          num(R.faturamento ? (meuFat / R.faturamento) * 100 : 0, 1) + '% da amostra.');
        L.push('');
        L.push('| Produto | Posicao | Vende/mes | Preco |');
        L.push('|---|---|---|---|');
        meus.forEach(function (x) {
          var nome = String(x.nome).replace(/\|/g, ' ').slice(0, 50);
          L.push('| ' + (x.link ? '[' + nome + '](' + x.link + ')' : nome) + ' | ' +
            (ordV.indexOf(x) + 1) + '\u00ba | ' + num(x.mes) + ' | ' + reais(x.preco) + ' |');
        });
      }
      L.push('');
    }

    L.push('---');
    L.push('');
    L.push('_Gerado pela Seller.IA \u00b7 Analista de Mercado. Os numeros de venda e preco vem da propria Shopee; ' +
      'o faturamento e a multiplicacao dos dois._');

    var texto = L.join('\n');
    try {
      var blob = new Blob([texto], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a2 = document.createElement('a');
      a2.href = url;
      a2.download = 'mercado-' + E.termo.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-' +
        new Date().toISOString().slice(0, 10) + '.md';
      document.documentElement.appendChild(a2);
      a2.click(); a2.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 20000);
    } catch (e) {
      alert('Nao consegui gerar o arquivo: ' + e.message);
    }
  }

  /* ============ TELA ============ */
  var host = document.createElement('div');
  host.id = 'sia-mercado';
  document.documentElement.appendChild(host);
  var raiz = host.attachShadow({ mode: 'open' });
  var $ = function (id) { return raiz.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function reais(n) {
    if (n == null) return '\u2014';
    return 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function num(n, casas) {
    if (n == null) return '\u2014';
    return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: casas || 0, maximumFractionDigits: casas || 0 });
  }
  /* O rotulo de secao, com o tracinho laranja antes. Estava sendo usado em
     cinco lugares e nunca foi definido — quebrava a tela inteira depois de
     a coleta terminar com sucesso, que e o pior momento para quebrar. */
  function olho(titulo, ajuda) {
    var h = '<div class="olho">' + esc(titulo) + '</div>';
    if (ajuda) h += '<div style="font-size:13.5px;color:#463F33;line-height:1.6;margin:-6px 0 12px">' + ajuda + '</div>';
    return h;
  }

  function idade(ts) {
    if (!ts) return null;
    var d = Math.round((Date.now() / 1000 - ts) / 86400);
    if (d < 60) return d + ' dias';
    if (d < 730) return Math.round(d / 30) + ' meses';
    return (Math.round(d / 365 * 10) / 10) + ' anos';
  }

  raiz.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:Outfit,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif}' +
    // No meio da lateral, nao no canto de baixo: ali ele cobria o chat da
    // Shopee e os botoes que a pessoa usa enquanto navega.
    '.btn{position:fixed;top:50%;transform:translateY(-50%);right:0;width:44px;height:60px;' +
      'border-radius:16px 0 0 16px;background:#1C1A17;' +
      'color:#FBF8F3;border:none;cursor:pointer;font:600 21px Archivo,Arial;box-shadow:-4px 4px 18px rgba(0,0,0,.22);' +
      'display:grid;place-items:center;z-index:2147483000;transition:width .15s,background .15s}' +
    '.btn:hover{width:52px;background:#E63E1B}' +
    '.btn em{font-style:normal;color:#E63E1B}' +
    '.painel{position:fixed;inset:0 0 0 auto;height:100vh;width:min(900px,100vw);background:#FEFCF9;color:#1A1610;' +
      'display:flex;flex-direction:column;transform:translateX(102%);transition:transform .26s;' +
      'box-shadow:-18px 0 60px rgba(72,56,38,.22);z-index:2147483000}' +
    '.painel.on{transform:none}' +
    '.cab{padding:18px 24px;border-bottom:1px solid #D9CFBC;display:flex;align-items:center;gap:14px}' +
    '.cab h1{margin:0;font:600 21px Archivo,Arial;letter-spacing:-.03em}' +
    '.cab .sub{font:400 11px "Space Mono",monospace;color:#6B6355;letter-spacing:.07em}' +
    '.x{margin-left:auto;background:none;border:1px solid #D9CFBC;color:#463F33;font-size:15px;' +
      'width:34px;height:34px;border-radius:10px;cursor:pointer}' +
    '.busca{padding:16px 24px;border-bottom:1px solid #D9CFBC;display:flex;gap:9px}' +
    'input{flex:1;background:#fff;border:1px solid #D9CFBC;border-radius:13px;padding:13px 15px;font-size:15px;color:#000}' +
    'input:focus{outline:none;border-color:#E63E1B}' +
    'button.go{background:#E63E1B;border:none;color:#fff;font:600 15px inherit;padding:13px 28px;border-radius:13px;cursor:pointer}' +
    '.abas{display:flex;gap:2px;padding:0 24px;border-bottom:1px solid #D9CFBC}' +
    '.aba{background:none;border:none;border-bottom:2px solid transparent;color:#463F33;font:inherit;' +
      'font-size:14px;padding:12px 15px;cursor:pointer}' +
    '.aba.on{color:#E63E1B;border-bottom-color:#E63E1B;font-weight:600}' +
    '.corpo{flex:1;overflow-y:auto;padding:20px 24px 40px}' +
    '.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:11px;margin-bottom:20px}' +
    '.card{background:#fff;border:1px solid #D9CFBC;border-radius:19px;padding:15px 17px}' +
    '.card .n{font:600 27px Archivo,Arial;letter-spacing:-.03em;line-height:1}' +
    '.card .r{font:400 9.5px "Space Mono",monospace;letter-spacing:.08em;color:#6B6355;margin-top:6px}' +
    'table{width:100%;border-collapse:collapse;font-size:13.5px}' +
    'th{text-align:left;font:400 9.5px "Space Mono",monospace;letter-spacing:.08em;color:#6B6355;' +
      'padding:9px 8px;border-bottom:1.5px solid #D9CFBC;cursor:pointer;white-space:nowrap}' +
    'th:hover{color:#E63E1B}' +
    'td{padding:10px 8px;border-bottom:1px solid #F2EDE4;vertical-align:top}' +
    'tr:hover td{background:#FEFCF9}' +
    '.num{text-align:right;font-family:"Space Mono",monospace;white-space:nowrap}' +
    '.eu{background:rgba(230,62,27,.06)!important}' +
    '.pill{display:inline-block;font:400 10px "Space Mono",monospace;padding:2px 8px;border-radius:99px;border:1px solid}' +
    '.p-ads{color:#B07208;border-color:#B07208}' +
    '.p-of{color:#6D28D9;border-color:#6D28D9}' +
    '.p-eu{color:#E63E1B;border-color:#E63E1B}' +
    '.olho{display:flex;align-items:center;gap:10px;font:400 10.5px "Space Mono",monospace;letter-spacing:.1em;' +
      'color:#463F33;margin:26px 0 12px}' +
    '.olho:before{content:"";width:15px;height:1px;background:#E63E1B;flex:none}' +
    '.nota{font-size:14px;color:#1A1610;line-height:1.6;margin:12px 0;background:#fff;border:1px solid #D9CFBC;' +
      'border-radius:17px;padding:14px 16px}' +
    '.aviso{background:rgba(176,114,8,.07);border-left:3px solid #B07208;border-radius:0 15px 15px 0;' +
      'padding:13px 15px;font-size:13.5px;line-height:1.55;margin-bottom:16px}' +
    '.vazio{text-align:center;padding:60px 24px;color:#6B6355;font-size:15px;line-height:1.7}' +
    '.barra{height:8px;background:#F2EDE4;border-radius:99px;overflow:hidden;display:flex;margin:10px 0}' +
    '.barra i{display:block;height:100%}' +
    '</style>' +
    '<button class="btn" id="abrir" title="Analista de Mercado">S<em>.</em></button>' +
    '<div class="painel" id="painel">' +
    '  <div class="cab"><div><h1>Analista de Mercado</h1>' +
    '    <div class="sub" id="sub">nenhum nicho lido ainda</div></div>' +
    '    <button class="x" id="relatorio" title="Baixar o relatorio" style="width:auto;padding:0 14px;margin-left:auto">relatorio</button>' +
    '    <button class="x" id="fechar" style="margin-left:8px">\u2715</button></div>' +
    '  <div class="busca"><input id="termo" placeholder="digite um nicho: comedouro lento, luminaria 3d..."><button class="go" id="ir">Analisar</button></div>' +
    '  <div class="abas" id="abas"></div>' +
    '  <div class="corpo" id="corpo"></div>' +
    '</div>';

  var ABAS = [
    { id: 'nicho', rot: 'O nicho' },
    { id: 'produtos', rot: 'Os produtos' },
    { id: 'lojas', rot: 'Os vendedores' },
    { id: 'calculo', rot: 'Quanto pagar' },
    { id: 'consultor', rot: 'A leitura' },
    { id: 'eu', rot: 'Onde eu estou' }
  ];

  function desenhar() {
    var quando = '';
    if (E.quando) {
      var min = Math.round((Date.now() - E.quando) / 60000);
      quando = min < 1 ? ' \u00b7 agora' : min < 60 ? ' \u00b7 ha ' + min + ' min'
        : min < 1440 ? ' \u00b7 ha ' + Math.round(min / 60) + 'h'
        : ' \u00b7 ' + new Date(E.quando).toLocaleDateString('pt-BR');
    }
    $('sub').textContent = E.itens.length
      ? (E.itens.length + ' produtos \u00b7 ' + E.termo + quando)
      : 'nenhum nicho lido ainda';
    $('ir').textContent = E.buscando ? 'Lendo...' : 'Analisar';

    $('abas').innerHTML = E.itens.length
      ? ABAS.map(function (a) {
          return '<button class="aba' + (E.aba === a.id ? ' on' : '') + '" data-aba="' + a.id + '">' + a.rot + '</button>';
        }).join('')
      : '';

    var c = $('corpo');
    if (E.buscando) { c.innerHTML = '<div class="vazio">' + esc(E.progresso || 'Lendo...') + '</div>'; return; }
    if (E.erro) { c.innerHTML = '<div class="vazio">' + esc(E.erro) + '</div>'; return; }
    if (!E.itens.length) {
      c.innerHTML = '<div class="vazio">Escreva um nicho e toque em <b>Analisar</b>.<br><br>' +
        'A leitura cobre ate ' + (MAX_PAGINAS * 60) + ' produtos e mostra quem vende, quanto vende,<br>' +
        'a que preco, e quanto do topo e anuncio.</div>';
      return;
    }
    if (E.detalhe) { c.innerHTML = viewDetalhe(); ligarTabela(); return; }
    c.innerHTML = E.aba === 'nicho' ? viewNicho()
      : E.aba === 'produtos' ? viewProdutos()
      : E.aba === 'lojas' ? viewLojas()
      : E.aba === 'calculo' ? renderCalculo()
      : E.aba === 'consultor' ? viewConsultor()
      : viewEu();
    ligarTabela();
    ligarCalculo();
  }

  function avisoSessao() {
    var lidas = E.paginasLidas || 1;
    return '<div class="aviso">' +
      '<b>Isto e uma amostra, nao o nicho inteiro.</b> Foram lidos ' + E.itens.length + ' produtos em ' +
      lidas + ' pagina' + (lidas > 1 ? 's' : '') + ' de busca \u2014 e o que a Shopee mostra para quem procura por ' +
      '<b>' + esc(E.termo) + '</b>. Existem outros vendedores alem destes, e o faturamento somado aqui e o <b>desta amostra</b>, ' +
      'nao do mercado todo.<br><br>' +
      'A leitura tambem vem da <b>sua sessao</b>: a Shopee so entrega volume de venda para quem esta logado, e personaliza a ordem ' +
      '\u2014 os seus produtos podem aparecer mais acima do que apareceriam para um comprador.</div>';
  }

  function viewNicho() {
    var R = resumo();
    if (!R) return avisoSessao() + '<div class="vazio">A Shopee nao devolveu volume de venda nesta busca. Confira se voce esta logada.</div>';
    var h = avisoSessao();
    h += '<div class="cards">' +
      card(num(R.vendas), 'VENDAS NO MES') +
      card(reais(R.faturamento).replace('R$ ', 'R$'), 'DESTES ' + R.itens + ' PRODUTOS') +
      card(reais(R.ticket), 'TICKET MEDIO') +
      card(R.lojas, 'VENDEDORES') +
      card(R.anuncios + '/' + E.itens.length, 'SAO ANUNCIO') +
      card(R.semVenda, 'SEM VENDA NO MES') +
      '</div>';

    h += '<div class="olho">A FAIXA DE PRECO</div>';
    h += '<div class="nota">De <b>' + reais(R.precoMin) + '</b> a <b>' + reais(R.precoMax) + '</b>, com a mediana em <b>' + reais(R.precoMediano) + '</b>.<br>' +
      'O ticket medio de <b>' + reais(R.ticket) + '</b> e onde o dinheiro realmente esta \u2014 ' +
      (R.ticket > R.precoMediano
        ? 'acima da mediana, o que significa que os produtos mais caros puxam o volume.'
        : 'abaixo da mediana, o que significa que o barato e quem vende.') + '</div>';

    h += '<div class="olho">CONCENTRACAO</div>';
    h += '<div class="nota">Os <b>5 maiores</b> ficam com <b>' + num(R.concentracao, 0) + '%</b> do faturamento do nicho.<br>' +
      (R.concentracao > 70
        ? 'Nicho dominado: entrar exige preco ou diferencial forte, porque o comprador ja tem para quem olhar.'
        : R.concentracao > 45
          ? 'Ha lideres, mas o bolo se divide. Da para pegar espaco sem enfrentar o primeiro.'
          : 'Nicho pulverizado: ninguem manda sozinho, e um produto bem feito encontra lugar.') + '</div>';

    var pctAds = (R.anuncios / E.itens.length) * 100;
    h += '<div class="olho">QUANTO DO TOPO E PAGO</div>';
    h += '<div class="nota"><b>' + R.anuncios + ' de ' + E.itens.length + '</b> resultados sao anuncio (' + num(pctAds, 0) + '%).<br>' +
      (pctAds < 15
        ? 'Pouca gente anunciando: da para aparecer organicamente, e quem anunciar tem pouca disputa.'
        : pctAds < 35
          ? 'Disputa moderada. Anuncio ajuda, mas o organico ainda entrega.'
          : 'Muita gente pagando. Sem anuncio, dificilmente voce aparece nas primeiras posicoes.') + '</div>';

    // O que os campeoes tem que os outros nao tem
    var ordV = E.itens.filter(function (x) { return x.mes != null; })
      .sort(function (a, b) { return (b.mes || 0) - (a.mes || 0); });
    if (ordV.length >= 10) {
      var topo = ordV.slice(0, 10), resto = ordV.slice(10);
      function med(l, c) {
        var v = l.map(function (x) { return x[c]; }).filter(function (x) { return x != null; });
        return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
      }
      var fotoT = med(topo, 'fotos'), fotoR = med(resto, 'fotos');
      var notaT = med(topo, 'nota'), notaR = med(resto, 'nota');
      var precoT = med(topo, 'preco'), precoR = med(resto, 'preco');
      function avals(l) {
        var v = l.map(function (x) { return x.estrelas ? x.estrelas.reduce(function (a, b) { return a + b; }, 0) : null; })
          .filter(function (x) { return x != null; });
        return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
      }
      var avT = avals(topo), avR = avals(resto);
      var adsT = topo.filter(function (x) { return x.anuncio; }).length;

      h += olho('O QUE OS 10 MAIS VENDIDOS TEM DE DIFERENTE',
        'Comparando os dez primeiros com todo o resto da amostra. E o que da para copiar sem adivinhar.');
      h += '<table><tr><th></th><th class="num">TOP 10</th><th class="num">O RESTO</th><th class="num">DIFERENCA</th></tr>';
      function linhaC(rot, a, b, fmt) {
        if (a == null || b == null) return '';
        var dif = b ? ((a - b) / b) * 100 : 0;
        return '<tr><td>' + rot + '</td><td class="num">' + fmt(a) + '</td><td class="num">' + fmt(b) + '</td>' +
          '<td class="num" style="color:' + (Math.abs(dif) < 8 ? '#6B6355' : dif > 0 ? '#0F7A4A' : '#C1121F') + '">' +
          (dif > 0 ? '+' : '') + num(dif, 0) + '%</td></tr>';
      }
      h += linhaC('Fotos no anuncio', fotoT, fotoR, function (v) { return num(v, 1); });
      h += linhaC('Nota', notaT, notaR, function (v) { return num(v, 2); });
      h += linhaC('Avaliacoes', avT, avR, function (v) { return num(v, 0); });
      h += linhaC('Preco', precoT, precoR, function (v) { return reais(v); });
      h += '<tr><td>Anunciando</td><td class="num">' + adsT + ' de 10</td>' +
        '<td class="num">' + resto.filter(function (x) { return x.anuncio; }).length + ' de ' + resto.length + '</td><td></td></tr>';
      h += '</table>';

      var recado = [];
      if (fotoT && fotoR && fotoT > fotoR * 1.15) recado.push('os campeoes tem <b>' + num(fotoT, 1) + ' fotos</b> contra ' + num(fotoR, 1) + ' do resto');
      if (avT && avR && avT > avR * 1.5) recado.push('tem <b>' + num(avT, 0) + ' avaliacoes</b> em media, contra ' + num(avR, 0));
      if (precoT && precoR && Math.abs(precoT - precoR) / precoR > 0.15) {
        recado.push('vendem <b>' + (precoT > precoR ? 'mais caro' : 'mais barato') + '</b>: ' + reais(precoT) + ' contra ' + reais(precoR));
      }
      if (recado.length) h += '<div class="nota">Em uma frase: ' + recado.join(', ') + '.</div>';
    }

    // categorias
    var cats = {};
    E.itens.forEach(function (x) { if (x.catid) cats[x.catid] = (cats[x.catid] || 0) + (x.fatMes || 0); });
    var ordC = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; });
    if (ordC.length) {
      h += '<div class="olho">POR CATEGORIA</div><table><tr><th>CATEGORIA</th><th class="num">FATURAMENTO</th><th class="num">%</th></tr>';
      var totC = ordC.reduce(function (a, k) { return a + cats[k]; }, 0);
      ordC.slice(0, 8).forEach(function (k) {
        h += '<tr><td>' + esc(E.categorias[k] || ('categoria ' + k)) + '</td>' +
          '<td class="num">' + reais(cats[k]) + '</td>' +
          '<td class="num">' + num((cats[k] / totC) * 100, 0) + '%</td></tr>';
      });
      h += '</table>';
    }
    return h;
  }
  function card(n, r) { return '<div class="card"><div class="n">' + n + '</div><div class="r">' + r + '</div></div>'; }

  function viewProdutos() {
    var I = E.itens.slice().sort(function (a, b) {
      if (E.ordem === 'fat') return (b.fatMes || 0) - (a.fatMes || 0);
      if (E.ordem === 'preco') return (b.preco || 0) - (a.preco || 0);
      if (E.ordem === 'total') return (b.total || 0) - (a.total || 0);
      return (b.mes || 0) - (a.mes || 0);
    });
    var h = '<div class="olho">' + I.length + ' PRODUTOS \u00b7 TOQUE NA COLUNA PARA ORDENAR</div>';
    h += '<table><tr><th>PRODUTO</th><th class="num" data-ord="mes">MES</th>' +
      '<th class="num" data-ord="total">TOTAL</th><th class="num" data-ord="preco">PRECO</th>' +
      '<th class="num" data-ord="fat">FATURA</th><th class="num">30 DIAS</th></tr>';
    I.slice(0, 120).forEach(function (x) {
      var t = tendencia(x.id);
      var meu = E.minhaLoja && x.loja === E.minhaLoja;
      h += '<tr class="' + (meu ? 'eu' : '') + '"><td style="cursor:pointer">' +
        '<b data-item="' + x.id + '">' + esc(x.nome.slice(0, 52)) + '</b>' +
        (x.link ? ' <a href="' + x.link + '" target="_blank" rel="noopener" title="abrir na Shopee" ' +
          'style="color:#E63E1B;text-decoration:none;font-size:12px">\u2197</a>' : '') +
        (x.anuncio ? ' <span class="pill p-ads">ads</span>' : '') +
        (meu ? ' <span class="pill p-eu">seu</span>' : '') +
        '<br><span style="color:#6B6355;font-size:12px">' + esc(x.lojaNome || '') +
        (x.local ? ' \u00b7 ' + esc(x.local) : '') + '</span></td>' +
        '<td class="num">' + num(x.mes) + '</td>' +
        '<td class="num">' + num(x.total) + '</td>' +
        '<td class="num">' + reais(x.preco) + '</td>' +
        '<td class="num">' + (x.fatMes != null ? reais(x.fatMes) : '\u2014') + '</td>' +
        '<td class="num" style="color:' + (t ? (t.pct > 0 ? '#0F7A4A' : '#C1121F') : '#6B6355') + '">' +
        (t ? (t.pct > 0 ? '+' : '') + num(t.pct, 0) + '%' : '\u2014') + '</td></tr>';
    });
    h += '</table>';
    h += '<div class="nota" style="font-size:13px;color:#463F33">A coluna <b>30 dias</b> compara o volume de hoje com o da primeira vez que voce leu este produto. ' +
      'A Shopee nao entrega historico \u2014 este e o nosso, e cresce a cada analise.</div>';
    return h;
  }

  function viewLojas() {
    var L = {};
    E.itens.forEach(function (x) {
      if (!x.loja) return;
      var l = L[x.loja] = L[x.loja] || {
        id: x.loja, nome: x.lojaNome, local: x.local, itens: 0, mes: 0, fat: 0,
        oficial: x.oficial, verificada: x.verificada, precos: []
      };
      l.itens++; l.mes += x.mes || 0; l.fat += x.fatMes || 0;
      if (x.preco) l.precos.push(x.preco);
    });
    var ord = Object.keys(L).map(function (k) { return L[k]; })
      .sort(function (a, b) { return b.fat - a.fat; });
    var h = '<div class="olho">' + ord.length + ' VENDEDORES NESTE NICHO</div>';
    h += '<table><tr><th>LOJA</th><th class="num">PRODUTOS</th><th class="num">VENDAS/MES</th>' +
      '<th class="num">FATURAMENTO</th><th class="num">PRECO MEDIO</th></tr>';
    ord.slice(0, 40).forEach(function (l) {
      var meu = E.minhaLoja && l.id === E.minhaLoja;
      var med = l.precos.length ? l.precos.reduce(function (a, b) { return a + b; }, 0) / l.precos.length : null;
      h += '<tr class="' + (meu ? 'eu' : '') + '"><td><b>' + esc(l.nome || ('loja ' + l.id)) + '</b>' +
        (l.oficial ? ' <span class="pill p-of">oficial</span>' : '') +
        (meu ? ' <span class="pill p-eu">voce</span>' : '') +
        '<br><span style="color:#6B6355;font-size:12px">' + esc(l.local || '') + '</span></td>' +
        '<td class="num">' + l.itens + '</td>' +
        '<td class="num">' + num(l.mes) + '</td>' +
        '<td class="num">' + reais(l.fat) + '</td>' +
        '<td class="num">' + reais(med) + '</td></tr>';
    });
    return h + '</table>';
  }

  function viewConsultor() {
    var h = olho('O QUE ESTES NUMEROS DIZEM',
      'A leitura le os numeros que ja estao na tela e diz o que fazer com eles. As contas continuam sendo do sistema \u2014 a IA nao calcula, porque conta errada ninguem confere.');

    if (E.consultando) {
      return h + '<div class="vazio">Lendo o mercado...</div>';
    }
    if (!E.consulta) {
      h += '<div class="nota">Ela vai olhar a concentracao, a faixa de preco, o que os campeoes fazem de diferente, ' +
        'quanto da para pagar pelo produto, e onde voce esta \u2014 e dizer se vale entrar, por qual preco, e o que copiar.</div>';
      h += '<button class="go" id="pedir-leitura" style="margin-top:6px">Pedir a leitura</button>';
      if (E.consultaErro) {
        h += '<div class="nota" style="color:#C1121F">Nao consegui: ' + esc(E.consultaErro) + '</div>';
      }
      return h;
    }

    // o texto vem em markdown simples; converte o basico
    var txt = esc(E.consulta)
      .replace(/^### (.+)$/gm, '<div class="olho">$1</div>')
      .replace(/^## (.+)$/gm, '<div style="font:600 18px Archivo,Arial;letter-spacing:-.02em;margin:22px 0 10px">$1</div>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/^- (.+)$/gm, '<div style="padding-left:14px;position:relative"><span style="position:absolute;left:0;color:#E63E1B">\u00b7</span>$1</div>')
      .replace(/\n\n/g, '<br><br>');
    h += '<div style="font-size:15px;line-height:1.7;color:#1A1610">' + txt + '</div>';
    h += '<button class="go" id="pedir-leitura" style="margin-top:20px;background:#F2EDE4;color:#463F33">Ler de novo</button>';
    return h;
  }

  function viewEu() {
    if (!E.minhaLoja) {
      return '<div class="vazio">Nao consegui identificar a sua loja nesta sessao.<br>Abra a Shopee logada e analise de novo.</div>';
    }
    var meus = E.itens.filter(function (x) { return x.loja === E.minhaLoja; });
    if (!meus.length) {
      return '<div class="vazio">Nenhum produto seu apareceu nos ' + E.itens.length + ' resultados de <b>' + esc(E.termo) + '</b>.<br><br>' +
        'Ou voce nao vende neste nicho, ou seus itens estao alem da terceira pagina \u2014 que na pratica e o mesmo que nao aparecer.</div>';
    }
    var R = resumo();
    var meuFat = meus.reduce(function (a, b) { return a + (b.fatMes || 0); }, 0);
    var meuMes = meus.reduce(function (a, b) { return a + (b.mes || 0); }, 0);
    var todos = E.itens.slice().sort(function (a, b) { return (b.mes || 0) - (a.mes || 0); });

    var h = '<div class="cards">' +
      card(meus.length, 'SEUS PRODUTOS AQUI') +
      card(num(meuMes), 'SUAS VENDAS/MES') +
      card(reais(meuFat), 'SEU FATURAMENTO') +
      card(num(R.faturamento ? (meuFat / R.faturamento) * 100 : 0, 1) + '%', 'DO NICHO') +
      '</div>';

    h += '<div class="olho">ONDE CADA UM ESTA</div><table>' +
      '<tr><th>SEU PRODUTO</th><th class="num">POSICAO</th><th class="num">VENDE</th><th class="num">O 1o VENDE</th><th class="num">PRECO</th></tr>';
    var lider = todos[0];
    meus.forEach(function (x) {
      var pos = todos.indexOf(x) + 1;
      h += '<tr><td><b>' + esc(x.nome.slice(0, 46)) + '</b></td>' +
        '<td class="num">' + pos + '\u00ba de ' + todos.length + '</td>' +
        '<td class="num">' + num(x.mes) + '</td>' +
        '<td class="num">' + num(lider.mes) + '</td>' +
        '<td class="num">' + reais(x.preco) + '</td></tr>';
    });
    h += '</table>';

    var meuPreco = meus.filter(function (x) { return x.preco; }).map(function (x) { return x.preco; });
    if (meuPreco.length && R) {
      var med = meuPreco.reduce(function (a, b) { return a + b; }, 0) / meuPreco.length;
      h += '<div class="nota">Seu preco medio e <b>' + reais(med) + '</b> e o do nicho e <b>' + reais(R.ticket) + '</b>. ' +
        (med > R.ticket * 1.2
          ? 'Voce esta acima do que o mercado paga \u2014 e preciso que o anuncio justifique a diferenca.'
          : med < R.ticket * 0.8
            ? 'Voce esta abaixo do mercado. Se a margem aguenta, e vantagem; se nao, e dinheiro deixado na mesa.'
            : 'Voce esta na faixa do mercado.') + '</div>';
    }
    return h;
  }

  function viewDetalhe() {
    var x = E.itens.find(function (y) { return String(y.id) === String(E.detalhe); });
    if (!x) return '<div class="vazio">Produto nao encontrado.</div>';
    var t = tendencia(x.id);
    var h = '<button class="aba" id="voltar">\u2190 voltar</button>';
    h += '<div class="olho">' + esc(x.lojaNome || '') + '</div>';
    h += '<div style="font:600 20px Archivo,Arial;letter-spacing:-.02em;margin-bottom:8px">' + esc(x.nome) + '</div>';
    if (x.link) {
      h += '<a href="' + x.link + '" target="_blank" rel="noopener" ' +
        'style="display:inline-block;color:#E63E1B;text-decoration:none;font-size:14px;margin-bottom:14px">' +
        'Abrir na Shopee \u2197</a>';
    }
    h += '<div class="cards">' +
      card(num(x.mes), 'VENDAS NO MES') +
      card(num(x.total), 'DESDE SEMPRE') +
      card(reais(x.preco), 'PRECO') +
      card(x.fatMes != null ? reais(x.fatMes) : '\u2014', 'FATURA POR MES') +
      '</div>';

    var linhas = [];
    if (x.catid) linhas.push(['Categoria', esc(E.categorias[x.catid] || x.catid)]);
    if (x.marca) linhas.push(['Marca', esc(x.marca)]);
    if (x.cadastro) linhas.push(['No ar ha', idade(x.cadastro)]);
    if (x.nota != null) linhas.push(['Nota', num(x.nota, 2) + (x.estrelas ? ' \u00b7 ' + num(x.estrelas.reduce(function (a, b) { return a + b; }, 0)) + ' avaliacoes' : '')]);
    if (x.curtidas != null) linhas.push(['Curtidas', num(x.curtidas)]);
    if (x.desconto) linhas.push(['Desconto', x.desconto + (x.precoAntes ? ' \u00b7 de ' + reais(x.precoAntes) : '')]);
    if (x.local) linhas.push(['Sai de', esc(x.local)]);
    linhas.push(['Anuncio', x.anuncio ? 'sim' : 'nao']);
    if (t) linhas.push(['Volume', (t.pct > 0 ? '+' : '') + num(t.pct, 0) + '% em ' + t.dias + ' dias']);

    h += '<div class="olho">O QUE SE SABE</div><table>';
    linhas.forEach(function (l) {
      h += '<tr><td style="color:#6B6355;width:34%">' + l[0] + '</td><td><b>' + l[1] + '</b></td></tr>';
    });
    h += '</table>';

    // ritmo: quanto vende por dia de vida
    if (x.total && x.cadastro) {
      var dias = Math.max(1, Math.round((Date.now() / 1000 - x.cadastro) / 86400));
      var porDia = x.total / dias;
      var agora = (x.mes || 0) / 30;
      h += '<div class="olho">ESTA ACELERANDO OU CAINDO?</div>';
      h += '<div class="nota">Na media da vida inteira, vende <b>' + num(porDia, 1) + '</b> por dia. ' +
        'Agora vende <b>' + num(agora, 1) + '</b> por dia.<br>' +
        (agora > porDia * 1.3
          ? 'Esta <b>acelerando</b> \u2014 vende bem mais agora do que vendeu na media.'
          : agora < porDia * 0.6
            ? 'Esta <b>desacelerando</b> \u2014 ja vendeu mais do que vende hoje.'
            : 'Esta em ritmo <b>constante</b>.') + '</div>';
    }

    if (x.estrelas && x.estrelas.length >= 6) {
      var tot = x.estrelas.reduce(function (a, b) { return a + b; }, 0);
      var ruins = (x.estrelas[1] || 0) + (x.estrelas[2] || 0);
      h += '<div class="olho">O QUE DIZEM</div>';
      h += '<div class="barra">';
      for (var e = 5; e >= 1; e--) {
        var q = x.estrelas[e] || 0;
        var cor = e >= 4 ? '#0F7A4A' : e === 3 ? '#B07208' : '#C1121F';
        h += '<i style="width:' + (tot ? (q / tot) * 100 : 0) + '%;background:' + cor + '"></i>';
      }
      h += '</div>';
      h += '<div class="nota">' + num(tot) + ' avaliacoes, sendo <b>' + num(ruins) + '</b> de uma ou duas estrelas (' +
        num(tot ? (ruins / tot) * 100 : 0, 1) + '%).<br>' +
        (ruins / tot > 0.08
          ? 'Proporcao alta de reclamacao para este nicho \u2014 vale ler o que dizem antes de copiar o produto.'
          : 'Reclamacao dentro do normal.') + '</div>';
    }
    return h;
  }

  /* ============ EVENTOS ============ */
  /* Os campos da calculadora leem do DOM no momento do toque, e nao por
     listener que se perde a cada redesenho — foi assim que a calculadora
     da extensao principal deixou de responder. */
  function ligarCalculo() {
    var campos = raiz.querySelectorAll('[data-calc]');
    if (!campos.length) return;
    var tmr = null;
    for (var i = 0; i < campos.length; i++) {
      campos[i].addEventListener('input', function () {
        E.calc = E.calc || {};
        var todos = raiz.querySelectorAll('[data-calc]');
        for (var j = 0; j < todos.length; j++) {
          E.calc[todos[j].getAttribute('data-calc')] = numeroPuro(todos[j].value);
        }
        if (tmr) clearTimeout(tmr);
        var foco = this.getAttribute('data-calc');
        tmr = setTimeout(function () {
          desenhar();
          var volta = raiz.querySelector('[data-calc="' + foco + '"]');
          if (volta) { volta.focus(); try { volta.setSelectionRange(volta.value.length, volta.value.length); } catch (e) { } }
        }, 500);
      });
    }
  }

  function ligarTabela() {
    raiz.querySelectorAll('[data-ord]').forEach(function (t) {
      t.addEventListener('click', function () { E.ordem = this.getAttribute('data-ord'); desenhar(); });
    });
    raiz.querySelectorAll('[data-item]').forEach(function (t) {
      t.addEventListener('click', function () { E.detalhe = this.getAttribute('data-item'); desenhar(); });
    });
    var v = $('voltar');
    if (v) v.addEventListener('click', function () { E.detalhe = null; desenhar(); });
    var pl = $('pedir-leitura');
    if (pl) pl.addEventListener('click', consultar);
    raiz.querySelectorAll('.aba[data-aba]').forEach(function (b) {
      b.addEventListener('click', function () { E.aba = this.getAttribute('data-aba'); E.detalhe = null; desenhar(); });
    });
  }

  $('abrir').addEventListener('click', function () { $('painel').classList.toggle('on'); });
  $('fechar').addEventListener('click', function () { $('painel').classList.remove('on'); });
  $('relatorio').addEventListener('click', gerarRelatorio);
  $('ir').addEventListener('click', function () {
    var t = $('termo').value.trim();
    try { console.log('[Mercado] clique no Analisar. termo:', t, '| ja buscando:', E.buscando); } catch (e) { }
    if (t && !E.buscando) analisar(t);
  });
  $('termo').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var t = this.value.trim(); if (t && !E.buscando) analisar(t); }
  });
  try {
    chrome.runtime.onMessage.addListener(function (m) {
      if (m && m.tipo === 'mercado:abrir') $('painel').classList.toggle('on');
    });
  } catch (e) { }

  // traz o historico guardado
  ler('hist_volume').then(function (v) {
    try { E.historico = JSON.parse(v || '{}'); } catch (e) { E.historico = {}; }
  });

  // e a ultima analise, para nao perder ao fechar
  ler('ultima_analise').then(function (v) {
    if (!v || E.itens.length || E.buscando) return;
    try {
      var a = JSON.parse(v);
      if (!a || !a.itens || !a.itens.length) return;
      E.termo = a.termo; E.itens = a.itens;
      E.categorias = a.categorias || {};
      E.minhaLoja = a.minhaLoja || null;
      E.paginasLidas = a.paginas || 1;
      E.quando = a.em;
      desenhar();
    } catch (e) { }
  });

  /* Se a ponte ja nasceu quebrada, avisa antes da pessoa tentar buscar. */
  (function conferirPonte() {
    try {
      chrome.runtime.sendMessage({ tipo: 'mercado:ler', chave: '__ping' }, function () {
        if (chrome.runtime.lastError) {
          E.erro = 'A extensao foi atualizada com esta pagina aberta. Recarregue a Shopee com F5.';
          desenhar();
        }
      });
    } catch (e) {
      E.erro = 'A extensao foi atualizada com esta pagina aberta. Recarregue a Shopee com F5.';
      desenhar();
    }
  })();

  desenhar();
  console.log('[Seller.IA Mercado] v' + VERSAO + ' pronto.');
})();

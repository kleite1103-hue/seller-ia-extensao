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

  var VERSAO = '1.0.0';
  var MAX_PAGINAS = 3;          // 60 itens por pagina
  var PAUSA = 900;              // entre paginas, para nao parecer raspagem

  var E = {
    termo: '', buscando: false, erro: null,
    itens: [], categorias: {}, historico: null,
    aba: 'nicho', ordem: 'mes', progresso: null,
    detalhe: null, minhaLoja: null
  };

  /* ============ CHAMADAS ============ */
  function api(url, metodo, corpo) {
    return new Promise(function (ok) {
      chrome.runtime.sendMessage(
        { tipo: 'mercado:buscar', url: url, metodo: metodo || 'GET', corpo: corpo || null },
        function (r) { void chrome.runtime.lastError; ok(r || { ok: false }); }
      );
    });
  }
  function guardar(chave, valor) {
    return new Promise(function (ok) {
      chrome.runtime.sendMessage({ tipo: 'mercado:guardar', chave: chave, valor: valor },
        function () { void chrome.runtime.lastError; ok(); });
    });
  }
  function ler(chave) {
    return new Promise(function (ok) {
      chrome.runtime.sendMessage({ tipo: 'mercado:ler', chave: chave },
        function (r) { void chrome.runtime.lastError; ok(r && r.valor); });
    });
  }
  function espera(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* A vitrine manda um identificador de sessao de visualizacao em toda
     busca. Um por analise basta. */
  var _sessao = null;
  function sessaoDaBusca() {
    if (_sessao) return _sessao;
    function h4() { return Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1); }
    _sessao = h4() + h4() + '-' + h4() + '-' + h4() + '-' + h4() + '-' + h4() + h4() + h4();
    return _sessao;
  }

  /* ============ LEITURA DO NICHO ============ */
  async function analisar(termo) {
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
        '&source=SRP&view_session_id=' + sessaoDaBusca() +
        '&extra_params=' + encodeURIComponent(JSON.stringify({ global_search_session_id: 'gs-' + Math.random().toString(16).slice(2, 10) }));
      var r = await api(url);
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
      if (its.length < 60) break;
      await espera(PAUSA);
    }

    E.progresso = 'Organizando...';
    desenhar();

    E.itens = todos.map(traduzirItem).filter(function (x) { return x.id; });
    await nomearCategorias();
    await guardarVolumes();
    await identificarMinhaLoja();

    E.buscando = false; E.progresso = null;
    if (!E.itens.length) E.erro = 'A Shopee nao devolveu resultados para este termo.';
    desenhar();
  }

  /* Traduz o item da busca para o que a analise usa. Cada campo aqui
     existe na resposta — nada e calculado por fora. */
  function traduzirItem(it) {
    var d = it.item_data || {};
    var a = it.item_card_displayed_asset || {};
    var sc = d.item_card_display_sold_count || {};
    var pr = d.item_card_display_price || {};
    var sd = d.shop_data || {};
    var t = {};
    try { t = JSON.parse(it.search_item_tracking || '{}'); } catch (e) { }

    var preco = pr.price != null ? pr.price / 100000 : null;
    var mes = sc.monthly_sold_count != null ? sc.monthly_sold_count : null;
    var total = sc.historical_sold_count != null ? sc.historical_sold_count : null;

    return {
      id: it.itemid, loja: it.shopid,
      nome: a.name || '',
      lojaNome: sd.shop_name || '',
      local: a.shop_location || sd.shop_location || '',
      preco: preco,
      precoAntes: pr.strikethrough_price != null ? pr.strikethrough_price / 100000 : null,
      desconto: pr.discount || null,
      mes: mes, total: total,
      // faturamento no mes: os dois numeros vem da Shopee, a multiplicacao
      // e nossa e a tela diz isso
      fatMes: (mes != null && preco != null) ? mes * preco : null,
      nota: a.item_rating && a.item_rating.rating_star != null ? a.item_rating.rating_star : null,
      estrelas: (a.item_rating && a.item_rating.rating_count) || null,
      curtidas: d.liked_count != null ? d.liked_count : null,
      cadastro: d.ctime || null,
      catid: d.catid || null,
      marca: d.brand || null,
      verificada: !!d.shopee_verified,
      oficial: !!d.is_official_shop,
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
    var r = await api('/api/v4/pages/get_category_tree');
    if (!r.ok || !r.dados) return;
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

  async function identificarMinhaLoja() {
    if (E.minhaLoja) return;
    var r = await api('/api/v4/account/get_account_info');
    try {
      var d = (r.dados && (r.dados.data || r.dados)) || {};
      if (d.shopid) E.minhaLoja = d.shopid;
    } catch (e) { }
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
    '    <button class="x" id="fechar">\u2715</button></div>' +
    '  <div class="busca"><input id="termo" placeholder="digite um nicho: comedouro lento, luminaria 3d..."><button class="go" id="ir">Analisar</button></div>' +
    '  <div class="abas" id="abas"></div>' +
    '  <div class="corpo" id="corpo"></div>' +
    '</div>';

  var ABAS = [
    { id: 'nicho', rot: 'O nicho' },
    { id: 'produtos', rot: 'Os produtos' },
    { id: 'lojas', rot: 'Os vendedores' },
    { id: 'eu', rot: 'Onde eu estou' }
  ];

  function desenhar() {
    $('sub').textContent = E.itens.length
      ? (E.itens.length + ' produtos \u00b7 ' + esc(E.termo))
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
      : viewEu();
    ligarTabela();
  }

  function avisoSessao() {
    return '<div class="aviso"><b>Esta leitura vem da sua sessao.</b> A Shopee so entrega volume de venda para quem esta logado, ' +
      'e personaliza a ordem dos resultados \u2014 os seus produtos podem aparecer mais acima do que apareceriam para um comprador.</div>';
  }

  function viewNicho() {
    var R = resumo();
    if (!R) return avisoSessao() + '<div class="vazio">A Shopee nao devolveu volume de venda nesta busca. Confira se voce esta logada.</div>';
    var h = avisoSessao();
    h += '<div class="cards">' +
      card(num(R.vendas), 'VENDAS NO MES') +
      card(reais(R.faturamento).replace('R$ ', 'R$'), 'FATURAMENTO DO NICHO') +
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
      h += '<tr class="' + (meu ? 'eu' : '') + '"><td data-item="' + x.id + '" style="cursor:pointer">' +
        '<b>' + esc(x.nome.slice(0, 52)) + '</b>' +
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
    h += '<div style="font:600 20px Archivo,Arial;letter-spacing:-.02em;margin-bottom:14px">' + esc(x.nome) + '</div>';
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
  function ligarTabela() {
    raiz.querySelectorAll('[data-ord]').forEach(function (t) {
      t.addEventListener('click', function () { E.ordem = this.getAttribute('data-ord'); desenhar(); });
    });
    raiz.querySelectorAll('[data-item]').forEach(function (t) {
      t.addEventListener('click', function () { E.detalhe = this.getAttribute('data-item'); desenhar(); });
    });
    var v = $('voltar');
    if (v) v.addEventListener('click', function () { E.detalhe = null; desenhar(); });
    raiz.querySelectorAll('.aba[data-aba]').forEach(function (b) {
      b.addEventListener('click', function () { E.aba = this.getAttribute('data-aba'); E.detalhe = null; desenhar(); });
    });
  }

  $('abrir').addEventListener('click', function () { $('painel').classList.toggle('on'); });
  $('fechar').addEventListener('click', function () { $('painel').classList.remove('on'); });
  $('ir').addEventListener('click', function () {
    var t = $('termo').value.trim();
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

  desenhar();
  console.log('[Seller.IA Mercado] v' + VERSAO + ' pronto.');
})();

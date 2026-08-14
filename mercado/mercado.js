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

  var VERSAO = '1.15.0';
  var MAX_PAGINAS = 3;          // 60 itens por pagina, ajustavel na tela
  var PAUSA = 900;              // entre paginas, para nao parecer raspagem

  var E = {
    termo: '', buscando: false, erro: null,
    itens: [], categorias: {}, historico: null,
    // Abre em "Por link": e o unico lugar que funciona sem analise previa,
    // e tambem o mais rapido de usar — cola e ve.
    aba: 'link', ordem: 'mes', progresso: null,
    paginas: 3, ampliar: false, variacoes: [], fotoDescricao: null,
    detalhe: null, minhaLoja: null, paginasLidas: 0, quando: null,
    calc: null, consulta: null, consultando: false, consultaErro: null,
    gravando: false, consultaLink: null, linkDigitado: '', nomeLojaAchada: null
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

  /* Pelo service worker. So e usado quando a ponte nao pode chamar por
     causa do dominio — do painel do vendedor para a vitrine. */
  function apiPeloWorker(url, metodo, corpo) {
    return new Promise(function (ok) {
      try {
        chrome.runtime.sendMessage(
          { tipo: 'mercado:buscar', url: url, metodo: metodo || 'GET', corpo: corpo || null },
          function (r) {
            if (chrome.runtime.lastError) { ok({ ok: false, erro: 'ponte' }); return; }
            ok(r || { ok: false });
          }
        );
      } catch (e) { ok({ ok: false, erro: 'ponte' }); }
    });
  }

  function api(url, metodo, corpo) {
    return new Promise(function (ok) {
      var id = 'm' + (++seq) + '_' + Date.now();
      pendentes[id] = function (r) {
        // a ponte nao pode chamar outro dominio: o worker assume
        if (r && r.erro === 'outro-dominio') {
          apiPeloWorker(url, metodo, corpo).then(ok);
          return;
        }
        ok(r);
      };
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


  /* ============ BUSCA POR FOTO ============
     A IA descreve o que ve e a descricao vira a busca. Ela acerta o tipo
     do produto, nao a marca — para pesquisa de mercado isso basta, e a
     tela diz o que ela entendeu antes de buscar, para a pessoa corrigir. */
  var URL_FOTO = 'https://mkfreezlizdbfpjjpxoo.supabase.co/functions/v1/mercado-foto';

  function lerFoto(arquivo) {
    if (!arquivo) return;
    if (arquivo.size > 5 * 1024 * 1024) {
      E.erro = 'A foto tem mais de 5 MB. Use uma menor.';
      desenhar(); return;
    }
    E.buscando = true;
    E.progresso = 'Olhando a foto...';
    E.erro = null;
    desenhar();

    var leitor = new FileReader();
    leitor.onload = function () {
      var base64 = String(leitor.result).split(',')[1];
      var tipo = arquivo.type || 'image/jpeg';
      fetch(URL_FOTO, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imagem: base64, tipo: tipo })
      }).then(function (r) { return r.json(); }).then(function (j) {
        E.buscando = false;
        E.progresso = null;
        if (!j || !j.ok || !j.termo) {
          E.erro = (j && j.erro) || 'Nao consegui entender a foto.';
          desenhar(); return;
        }
        E.fotoDescricao = j.descricao || null;
        var campo = $('termo');
        if (campo) campo.value = j.termo;
        analisar(j.termo);
      }).catch(function (e) {
        E.buscando = false; E.progresso = null;
        E.erro = /failed to fetch/i.test(String(e && e.message))
          ? 'Nao consegui falar com o servidor. Verifique se a funcao mercado-foto foi publicada no Supabase.'
          : String(e && e.message || e);
        desenhar();
      });
    };
    leitor.onerror = function () {
      E.buscando = false; E.erro = 'Nao consegui ler o arquivo.'; desenhar();
    };
    leitor.readAsDataURL(arquivo);
  }


  /* ============ CONSULTA POR LINK ============
     Cola o link de um produto e ve quanto ele vende; cola o link de uma
     loja e ve o faturamento dela.

     COMO FUNCIONA, e por que nao e direto: a pagina do produto NAO devolve
     venda — o campo sold vem nulo em todas as capturas. Quem devolve e a
     BUSCA. Entao para o produto a extensao busca pelo titulo dele e acha o
     item pelo id; para a loja, usa a busca interna da loja, que devolve os
     itens com o mesmo formato da busca geral. */

  function idsDoLink(link) {
    var s = String(link || '').trim();

    // PRODUTO: .../product/SHOPID/ITEMID  ou  ...-i.SHOPID.ITEMID
    var m = s.match(/\/product\/(\d+)\/(\d+)/) || s.match(/-i\.(\d+)\.(\d+)/);
    if (m) return { loja: m[1], item: m[2] };

    // LOJA por id: .../shop/SHOPID
    var l = s.match(/\/shop\/(\d+)/);
    if (l) return { loja: l[1], item: null };

    /* LOJA POR NOME. E o formato que a Shopee realmente usa quando voce
       copia o link de uma loja: shopee.com.br/nomedaloja. Nao ha id nele,
       entao a extensao pergunta a Shopee qual e o id daquele nome. */
    var n = s.replace(/^https?:\/\//, '').replace(/^(www\.)?shopee\.com\.br\/?/, '');
    n = n.split(/[?#]/)[0].replace(/\/$/, '');
    // um segmento so, sem numeros de produto, sem palavra reservada
    if (n && n.indexOf('/') < 0 && !/^\d+$/.test(n) &&
        ['search', 'daily_discover', 'mall', 'cart', 'buyer', 'user'].indexOf(n.toLowerCase()) < 0) {
      return { loja: null, item: null, nomeLoja: n };
    }
    return null;
  }

  /* O link por nome nao traz o id. Esta e a rota que a propria vitrine usa
     ao abrir a pagina de uma loja: POST com o username no corpo. A que eu
     tinha escrito antes, get_shop_base por GET, nao existe — o corpo abaixo
     foi copiado da captura do radar, sem inventar campo. */
  async function idDaLojaPeloNome(nome) {
    var r = await api('/api/v4/shop/get_shop_base_v2', 'POST', JSON.stringify({
      entry_point: 'ShopByPDP',
      request_source: 'pc_shop_home_page',
      livestream_params: {},
      user_address: {},
      username: nome
    }));
    try {
      var d = (r.dados && (r.dados.data || r.dados)) || {};
      var id = d.shopid || d.shop_id || null;
      if (id) E.nomeLojaAchada = d.name || (d.account && d.account.username) || nome;
      return id;
    } catch (e) { return null; }
  }

  async function consultarLink(link) {
    var ids = idsDoLink(link);
    if (!ids) {
      E.erro = 'Nao reconheci este link. Cole o endereco de um produto ou de uma loja da Shopee.';
      desenhar(); return;
    }
    E.buscando = true; E.erro = null; E.consultaLink = null;
    E.progresso = ids.item ? 'Procurando este produto...' : 'Lendo a loja...';
    desenhar();

    if (ids.item) {
      await consultarProduto(ids);
    } else {
      var shopid = ids.loja;
      if (!shopid && ids.nomeLoja) {
        E.progresso = 'Achando a loja "' + ids.nomeLoja + '"...';
        desenhar();
        shopid = await idDaLojaPeloNome(ids.nomeLoja);
        if (!shopid) {
          E.erro = 'Nao consegui abrir a loja "' + ids.nomeLoja + '". ' +
            'Isso costuma acontecer quando a consulta parte do painel do vendedor: ' +
            'abra shopee.com.br e use o Radar de la.';
          E.buscando = false; E.progresso = null; desenhar();
          return;
        }
      }
      await consultarLoja(shopid);
    }

    E.buscando = false; E.progresso = null;
    desenhar();
  }

  /* PRODUTO. A pagina dele nao traz venda, entao: pega o nome pela pagina,
     busca esse nome, e acha o item pelo id na resposta da busca. */
  async function consultarProduto(ids) {
    /* LE A PAGINA PRIMEIRO. Ela traz preco, nota, avaliacoes, curtidas e a
       data de cadastro — tudo menos o volume de venda, que vem nulo ali.
       Antes eu dependia da busca para tudo, entao quando o anuncio nao
       aparecia nas tres primeiras paginas a tela nao mostrava nada. Agora
       a pagina sustenta a leitura e a busca so acrescenta o volume. */
    var r = await api('/api/v4/pdp/get_pc?item_id=' + ids.item + '&shop_id=' + ids.loja);
    var it = null, sd = null;
    try {
      var d = (r.dados && (r.dados.data || r.dados)) || {};
      it = d.item || null;
      sd = d.shop_detailed || null;
    } catch (e) { }
    if (!it) {
      E.erro = 'Nao consegui abrir este produto. Confira o link e se voce esta logada na Shopee.';
      return;
    }

    var rt = it.item_rating || {};
    var base = {
      id: ids.item, loja: ids.loja,
      nome: it.title || it.name || '',
      lojaNome: (sd && (sd.name || sd.username)) || '',
      preco: it.price != null ? it.price / 100000 : null,
      precoAntes: it.price_before_discount != null ? it.price_before_discount / 100000 : null,
      nota: rt.rating_star != null ? rt.rating_star : null,
      estrelas: rt.rating_count || null,
      avaliacoes: it.cmt_count != null ? it.cmt_count : null,
      curtidas: it.liked_count != null ? it.liked_count : null,
      cadastro: it.ctime || null,
      fotos: (it.images && it.images.length) || null,
      estoque: it.stock != null ? it.stock : null,
      local: it.shop_location || (sd && sd.shop_location) || '',
      mes: null, total: null, fatMes: null,
      link: 'https://shopee.com.br/product/' + ids.loja + '/' + ids.item,
      linkLoja: 'https://shopee.com.br/shop/' + ids.loja,
      // da loja, que a pagina entrega junto
      lojaSeguidores: sd && sd.follower_count != null ? sd.follower_count : null,
      lojaProdutos: sd && sd.item_count != null ? sd.item_count : null,
      lojaNota: sd && sd.rating_star != null ? sd.rating_star : null,
      lojaDesde: sd && sd.ctime ? sd.ctime : null,
      lojaResposta: sd && sd.response_rate != null ? sd.response_rate : null
    };

    /* O VOLUME so existe na busca. Procura pelo titulo; se nao achar, a
       tela mostra o resto e diz que o volume nao veio — em vez de nao
       mostrar nada, como antes. */
    if (base.nome) {
      E.progresso = 'Procurando o volume de vendas...';
      desenhar();
      var achou = null;
      for (var pg = 0; pg < 3 && !achou; pg++) {
        var url = '/api/v4/search/search_items?by=relevancy&keyword=' +
          encodeURIComponent(base.nome.slice(0, 60)) + '&limit=60&newest=' + (pg * 60) +
          '&order=desc&page_type=search&scenario=PAGE_GLOBAL_SEARCH&version=2&source=SRP' +
          '&view_session_id=' + sessaoDaBusca(base.nome);
        var rb = await api(url);
        if (!rb.ok || !rb.dados) break;
        var its = (rb.dados.items || (rb.dados.data && rb.dados.data.items) || []);
        for (var q = 0; q < its.length; q++) {
          if (String(its[q].itemid) === String(ids.item)) { achou = traduzirItem(its[q]); break; }
        }
        if (its.length < 60) break;
        await espera(PAUSA);
      }
      if (achou) {
        base.mes = achou.mes;
        base.total = achou.total;
        base.fatMes = achou.fatMes;
        if (!base.lojaNome && achou.lojaNome) base.lojaNome = achou.lojaNome;
      }
    }

    E.consultaLink = { tipo: 'produto', item: base, semVolume: base.mes == null };
  }

  /* LOJA. A busca interna da loja devolve os itens no mesmo formato da
     busca geral, com o volume de venda junto. */
  async function consultarLoja(shopid) {
    var todos = [];
    for (var pg = 0; pg < 4; pg++) {
      E.progresso = 'Lendo os produtos da loja... (' + (pg * 30) + ')';
      desenhar();
      var url = '/api/v4/shop/search_items?shopid=' + shopid +
        '&limit=30&offset=' + (pg * 30) + '&order=desc&sort_by=pop' +
        '&filter_sold_out=1&use_case=4&item_card_use_scene=search_items_popular';
      var r = await api(url);
      if (!r.ok || !r.dados) break;
      /* A BUSCA DA LOJA NAO DEVOLVE "items". Os produtos vem em
         centralize_item_card.item_cards — conferido na captura do radar.
         Eu procurava "items" como na busca geral, achava vazio, e a
         consulta de loja terminava sem nada toda vez. */
      var dd = r.dados;
      var its = (dd.centralize_item_card && dd.centralize_item_card.item_cards) ||
        dd.items || (dd.data && (dd.data.items ||
          (dd.data.centralize_item_card && dd.data.centralize_item_card.item_cards))) || [];
      if (!its.length) break;
      todos = todos.concat(its);
      if (its.length < 30) break;
      await espera(PAUSA);
    }
    if (!todos.length) {
      E.erro = 'Esta loja nao devolveu produtos. Se voce esta no painel do vendedor, ' +
        'abra shopee.com.br e use o Radar de la.';
      return;
    }
    var itens = todos.map(traduzirItem).filter(function (x) { return x.id; });
    var comVenda = itens.filter(function (x) { return x.mes != null; });
    E.consultaLink = {
      tipo: 'loja', shopid: shopid,
      nome: E.nomeLojaAchada || (itens[0] && itens[0].lojaNome) || ('loja ' + shopid),
      itens: itens, comVenda: comVenda.length,
      vendas: comVenda.reduce(function (a, b) { return a + (b.mes || 0); }, 0),
      fat: comVenda.reduce(function (a, b) { return a + (b.fatMes || 0); }, 0)
    };
  }

  /* ============ LEITURA DO NICHO ============ */
  /* As variacoes que a propria Shopee sugere para o termo. Buscar so a
     palavra que a pessoa digitou mostra uma fatia; o nicho de verdade
     aparece quando se junta o que os compradores realmente escrevem. */
  async function variacoesDoTermo(termo) {
    var r = await api('/api/v4/search/search_suggestion?keyword=' +
      encodeURIComponent(termo) + '&limit=12&version=3');
    var out = [];
    try {
      var lista = (r.dados && (r.dados.data || r.dados)) || {};
      var arr = lista.suggestions || lista.items || lista.keywords || [];
      for (var i = 0; i < arr.length; i++) {
        var s2 = typeof arr[i] === 'string' ? arr[i] : (arr[i].keyword || arr[i].suggestion || arr[i].text);
        if (!s2) continue;
        s2 = String(s2).trim().toLowerCase();
        if (s2 === termo.toLowerCase()) continue;
        if (s2.indexOf(termo.toLowerCase().split(' ')[0]) < 0) continue;   // fora do assunto
        out.push(s2);
      }
    } catch (e) { }
    return out.slice(0, 4);
  }

  async function analisar(termo) {
    try { console.log('[Mercado] analisando:', termo); } catch (e) { }
    E.termo = termo; E.buscando = true; E.erro = null; E.itens = []; E.detalhe = null;
    E.variacoes = [];
    desenhar();

    var termos = [termo];
    if (E.ampliar) {
      E.progresso = 'Vendo como as pessoas procuram isto...';
      desenhar();
      var vs = await variacoesDoTermo(termo);
      E.variacoes = vs;
      termos = termos.concat(vs);
    }

    var vistos = {};
    var todos = [];
    for (var it2 = 0; it2 < termos.length; it2++) {
      var tAtual = termos[it2];
      var achou = await lerTermo(tAtual, termos.length > 1 ? (it2 + 1) + ' de ' + termos.length : null, vistos);
      todos = todos.concat(achou);
    }

    E.progresso = 'Organizando...';
    desenhar();
    await fecharAnalise(todos);
  }

  /* Le um termo inteiro, pagina por pagina, ignorando o que ja veio de
     outra busca — senao o mesmo produto conta duas vezes no faturamento. */
  async function lerTermo(termo, rotulo, vistos) {
    var todos = [];
    for (var pg = 0; pg < E.paginas; pg++) {
      E.progresso = (rotulo ? '\u201c' + termo + '\u201d (' + rotulo + ') \u00b7 ' : '') +
        'pagina ' + (pg + 1) + ' de ' + E.paginas + '...';
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
      if (r.dados && r.dados.error) {
        E.erro = 'A Shopee recusou a busca a partir desta pagina. ' +
          'Abra a vitrine em shopee.com.br e use o Radar de la \u2014 e onde a busca funciona.';
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
      // sem isto, o mesmo produto aparece em duas buscas e o faturamento
      // conta ele duas vezes
      for (var q = 0; q < its.length; q++) {
        var idq = its[q].itemid;
        if (idq && vistos[idq]) continue;
        if (idq) vistos[idq] = 1;
        todos.push(its[q]);
      }
      E.paginasLidas = (E.paginasLidas || 0) + 1;
      // A Shopee nem sempre devolve 60: quando vem menos, e o fim do que
      // ela tem para esse termo. Guardar isso importa porque o total lido
      // muda a leitura de faturamento.
      if (its.length < 60) break;
      await espera(PAUSA);
    }
    return todos;
  }

  /* Fecha a analise: traduz, nomeia, guarda e desenha. */
  async function fecharAnalise(todos) {
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
    if (E.aba === 'link') E.aba = 'nicho';   // terminou a analise: mostra ela
    await nomearLojas();

    // DIAGNOSTICO DO VOLUME: qual campo cada item trouxe. Sem isso nao da
    // para saber se o numero da tela e mensal ou historico.
    try {
      var a1 = todos[0] || {};
      var b1 = a1.item_basic || {};
      var d1 = a1.item_data || {};
      var s1 = d1.item_card_display_sold_count || b1.item_card_display_sold_count || {};
      console.log('[Mercado] CAMPOS DE VENDA no primeiro item:',
        'monthly_sold_count=', s1.monthly_sold_count,
        '| historical_sold_count=', s1.historical_sold_count,
        '| item_basic.sold=', b1.sold,
        '| item_basic.historical_sold=', b1.historical_sold);
      var comMonthly = todos.filter(function (x) {
        var dd = x.item_data || x.item_basic || {};
        var ss = dd.item_card_display_sold_count || {};
        return ss.monthly_sold_count != null;
      }).length;
      var comSold = todos.filter(function (x) {
        return (x.item_basic || {}).sold != null;
      }).length;
      console.log('[Mercado] de', todos.length, 'itens:', comMonthly, 'com monthly_sold_count,', comSold, 'com item_basic.sold');
    } catch (e) { }

    try {
      console.log('[Mercado] traduzidos:', E.itens.length,
        '| com nome:', E.itens.filter(function (x) { return x.nome; }).length,
        '| com preco:', E.itens.filter(function (x) { return x.preco != null; }).length,
        '| com venda:', E.itens.filter(function (x) { return x.mes != null; }).length);
    } catch (e) { }

    await guardarVolumes();
    await identificarMinhaLoja();

    // GUARDA A ANALISE. Fechar a gaveta nao pode perder o trabalho: a
    // pessoa fecha para olhar um anuncio e volta esperando encontrar tudo
    // no lugar.
    if (E.itens.length) {
      try {
        await guardar('ultima_analise', JSON.stringify({
          termo: E.termo, em: Date.now(), paginas: E.paginasLidas,
          itens: E.itens, minhaLoja: E.minhaLoja
        }));
      } catch (e) { }
    }

    E.buscando = false; E.progresso = null;
    if (!E.itens.length && !E.erro) E.erro = 'A Shopee nao devolveu resultados para este termo.';
    /* Quando NENHUM produto trouxe volume, a analise nao tem base. Mas
       apagar tudo era exagero: preco, loja e posicao continuam validos.
       Agora ela avisa e mantem o que veio. */
    if (E.itens.length && !E.erro) {
      var comMes = E.itens.filter(function (x) { return x.mes != null; }).length;
      E.semVolume = !comMes;
    } else {
      E.semVolume = false;
    }
    try { console.log('[Mercado] fim:', E.itens.length, 'produtos | erro:', E.erro || 'nenhum'); } catch (e) { }
    desenhar();
  }

  /* Traduz o item da busca para o que a analise usa. Cada campo aqui
     existe na resposta — nada e calculado por fora. */
  function traduzirItem(it) {
    /* TRES FORMAS ate agora: item_data com o asset ao lado (busca geral),
       item_basic com tudo dentro, e o item_card da busca DA LOJA, que traz
       os campos direto na raiz. Aceitar as tres evita o que ja aconteceu
       duas vezes: a tela vazia porque o dado estava um nivel acima ou
       abaixo do que eu procurava. */
    var b = it.item_basic || {};
    var d = it.item_data || (it.item_card_display_price ? it : b);
    var a = it.item_card_displayed_asset || b;
    var sc = d.item_card_display_sold_count || {};
    var pr = d.item_card_display_price || {};
    var sd = d.shop_data || {};
    var t = {};
    try { t = JSON.parse(it.search_item_tracking || '{}'); } catch (e) { }

    var preco = pr.price != null ? pr.price / 100000
      : (b.price != null ? b.price / 100000 : null);
    /* MEDIDO NAS CAPTURAS: em todas as respostas com dado, item_basic e
       item_data vem JUNTOS no mesmo item, e o volume esta sempre em
       item_data.item_card_display_sold_count.monthly_sold_count — o campo
       item_basic.sold nunca apareceu preenchido, em nenhuma das sete
       capturas. Ou seja, a reserva que eu tinha posto nunca chegou a ser
       usada, e tirar ou por nao muda o numero da tela.

       O mesmo vale para o preco: so existe em item_data. */
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
      linkLoja: it.shopid ? ('https://shopee.com.br/shop/' + it.shopid) : null,
      nome: a.name || b.name || it.display_name || '',
      // O nome da loja so vem em item_data.shop_data. Na estrutura
      // item_basic ele nao existe, e ai fica so o id — que nao serve para
      // ninguem ler. Quando faltar, buscamos depois pela pagina do produto.
      lojaNome: sd.shop_name || b.shop_name || d.shop_name || '',
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

  /* Quando o nome da loja nao vem na busca, pega das lojas que mais
     aparecem. Uma chamada por loja, so para as maiores, porque o nome
     importa mais nos lideres do que na cauda. */
  async function nomearLojas() {
    var semNome = {};
    E.itens.forEach(function (x) {
      if (x.loja && !x.lojaNome) semNome[x.loja] = (semNome[x.loja] || 0) + 1;
    });
    var ids = Object.keys(semNome).sort(function (a, b) { return semNome[b] - semNome[a]; }).slice(0, 12);
    if (!ids.length) return;
    E.progresso = 'Buscando o nome das lojas...';
    desenhar();
    for (var i = 0; i < ids.length; i++) {
      var r = await api('/api/v4/shop/get_shop_base?shopid=' + ids[i]);
      var nome = null;
      try {
        var dd = (r.dados && (r.dados.data || r.dados)) || {};
        nome = dd.name || dd.shop_name || (dd.account && dd.account.username) || null;
      } catch (e) { }
      if (nome) {
        E.itens.forEach(function (x) { if (String(x.loja) === String(ids[i]) && !x.lojaNome) x.lojaNome = nome; });
      }
      await espera(200);
    }
  }

  /* A Shopee entrega a arvore de categorias com o nome em portugues. */
  /* A funcao que buscava a arvore de categorias saiu daqui: ficou provado
     que ela nao serve. A vitrine entrega 284 categorias em 2 niveis, e o
     catid do produto e de nivel mais fundo — nenhum dos que aparecem na
     busca existe nela. O bloco virou EM QUE PRECO O DINHEIRO ESTA. */


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

      // o nicho aceita gente nova?
      idade: (function () {
        var ag = Date.now() / 1000;
        var cd = E.itens.filter(function (x) { return x.cadastro && x.mes != null; });
        if (cd.length < 10) return null;
        function ms(x) { return (ag - x.cadastro) / 2592000; }
        var nv = cd.filter(function (x) { return ms(x) <= 6; });
        var mt = ordV.slice(0, 10).filter(function (x) { return x.cadastro; }).map(ms);
        return {
          anunciosAte6Meses: nv.length,
          dessesVendendoBem: nv.filter(function (x) { return x.mes >= 30; }).length,
          anunciosComMaisDe1Ano: cd.filter(function (x) { return ms(x) > 12; }).length,
          mesesNoArDosDezMaioresNaMedia: mt.length ? Math.round(mt.reduce(function (a, b) { return a + b; }, 0) / mt.length) : null
        };
      })(),

      // vende bem apesar da nota baixa: brecha de atendimento
      brechasDeAtendimento: (function () {
        var cn = E.itens.filter(function (x) { return x.nota != null && x.mes > 0; });
        if (cn.length < 8) return null;
        var metade = cn.slice().sort(function (a, b) { return b.mes - a.mes; }).slice(0, Math.ceil(cn.length / 2));
        return metade.filter(function (x) { return x.nota < 4.6; })
          .sort(function (a, b) { return a.nota - b.nota; }).slice(0, 5)
          .map(function (x) {
            return { nome: String(x.nome).slice(0, 55), nota: Math.round(x.nota * 100) / 100, vendeMes: x.mes, preco: x.preco, loja: x.lojaNome };
          });
      })(),
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
      // "Failed to fetch" nao diz nada para quem le. O motivo quase sempre
      // e a funcao ainda nao publicada no Supabase.
      var m = String(e && e.message || e);
      E.consultaErro = /failed to fetch|networkerror/i.test(m)
        ? 'Nao consegui falar com o servidor. Verifique se a funcao mercado-consultor foi publicada no Supabase.'
        : m;
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

    /* UM cartao grande, o da SUA margem. Dois cartoes fixos em 15 e 20
       faziam parecer que a calculadora nao respondia: a pessoa trocava a
       margem e os numeros grandes ficavam parados na tela. */
    var suaMargem = numeroPuro(C.margem) || 15;
    var comp = quantoPagar(preco, 15, C.roas, C.imposto, C.embalagem);
    var saud = quantoPagar(preco, 20, C.roas, C.imposto, C.embalagem);
    var seu = quantoPagar(preco, suaMargem, C.roas, C.imposto, C.embalagem);

    var corTeto = !seu.viavel ? '#D64545' : (seu.teto / preco) > 0.30 ? '#1F8A5F' : '#C98A1E';
    h += '<div style="background:var(--surf);border:1px solid var(--bd2);border-left:3px solid ' + corTeto + ';' +
      'border-radius:0 22px 22px 0;padding:22px 24px;margin-bottom:12px">' +
      '<div style="font:400 9px \'Space Mono\',monospace;letter-spacing:.1em;color:var(--tx6);margin-bottom:10px">' +
      'PAGUE NO MAXIMO ISTO AO FORNECEDOR, POR UNIDADE</div>' +
      '<div style="display:flex;align-items:baseline;gap:18px;flex-wrap:wrap">' +
      '<div style="font:300 46px Outfit,Arial;letter-spacing:-.045em;color:' + corTeto + ';line-height:1">' +
      (seu.viavel ? reais(seu.teto) : 'nao fecha') + '</div>' +
      '<div style="font-size:14px;color:var(--tx2);line-height:1.5">vendendo a <b>' + reais(preco) +
      '</b><br>com margem de <b>' + num(suaMargem, 0) + '%</b></div></div>';
    if (seu.viavel) {
      h += '<div style="display:flex;gap:28px;flex-wrap:wrap;margin-top:17px;padding-top:15px;border-top:1px solid var(--bd5)">' +
        '<div><div style="font:400 9px \'Space Mono\',monospace;letter-spacing:.1em;color:var(--tx6);margin-bottom:5px">SOBRA POR VENDA</div>' +
        '<div style="font:400 21px Outfit,Arial;color:var(--tx1);letter-spacing:-.025em">' + reais(seu.margem) + '</div></div>' +
        '<div><div style="font:400 9px \'Space Mono\',monospace;letter-spacing:.1em;color:var(--tx6);margin-bottom:5px">O PRODUTO PODE CUSTAR</div>' +
        '<div style="font:400 21px Outfit,Arial;color:var(--tx1);letter-spacing:-.025em">ate ' + num((seu.teto / preco) * 100, 0) + '% do preco</div></div></div>';
    } else {
      h += '<div style="font-size:14px;color:#D64545;margin-top:13px;line-height:1.6">' +
        'A este preco, com margem de ' + num(suaMargem, 0) + '%, nao sobra nada para o produto. ' +
        'Ou o preco de venda sobe, ou a margem baixa.</div>';
    }
    h += '</div>';

    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:14px">';
    [['SE QUISER SER COMPETITIVO', 'margem de 15%', comp],
     ['SE QUISER SER SAUDAVEL', 'margem de 20%', saud]].forEach(function (c) {
      h += '<div style="background:var(--fill2);border:1px solid var(--bd3);border-radius:18px;padding:15px 17px">' +
        '<div style="font:400 9px \'Space Mono\',monospace;letter-spacing:.09em;color:var(--tx6);margin-bottom:7px">' + c[0] + '</div>' +
        '<div style="font:400 23px Outfit,Arial;letter-spacing:-.03em;color:' + (c[2].viavel ? 'var(--tx1)' : '#D64545') + '">' +
        (c[2].viavel ? reais(c[2].teto) : 'nao fecha') + '</div>' +
        '<div style="font-size:12.5px;color:var(--tx5);margin-top:5px">' + c[1] + '</div></div>';
    });
    h += '</div>';
    h += '<div class="nota">Este e o <b>teto por unidade</b>, ou por kit se voce vende em kit. ' +
      'Comprando abaixo dele a margem sobe. Comprando acima, ela some.</div>';

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
        '<div style="font:400 9.5px \'Space Mono\',monospace;color:var(--tx6);margin-top:5px">O DO MEIO DA LISTA FAZ</div></div>' +
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
              ? 'até o produto do meio da lista já vende mais que isso.'
              : 'mas o produto do meio da lista vende ' + num(medianaVol) + ', então você precisa ficar acima da maioria.');
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
            (medianaVol >= porProduto ? ', o que o produto do meio da lista já faz.' : '.') + '</div>';
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
    var top = ordV.slice(0, 10), resto = ordV.slice(10);
    var C = E.calc || {};
    var preco = C.preco || R.precoMediano;
    var c15 = quantoPagar(preco, 15, C.roas || 10, C.imposto || 0, C.embalagem || 0);
    var c20 = quantoPagar(preco, 20, C.roas || 10, C.imposto || 0, C.embalagem || 0);

    function m(l, c) {
      var v = l.map(function (y) { return y[c]; }).filter(function (y) { return y != null; });
      return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
    }
    function avals(l) {
      var v = l.map(function (x) { return x.estrelas ? x.estrelas.reduce(function (a, b) { return a + b; }, 0) : null; })
        .filter(function (x) { return x != null; });
      return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
    }

    // lojas
    var LJ = {};
    E.itens.forEach(function (x) {
      if (!x.loja) return;
      var l = LJ[x.loja] = LJ[x.loja] || { nome: x.lojaNome, id: x.loja, itens: 0, mes: 0, fat: 0, local: x.local, precos: [], link: x.linkLoja };
      l.itens++; l.mes += x.mes || 0; l.fat += x.fatMes || 0;
      if (x.preco) l.precos.push(x.preco);
    });
    var ordL = Object.keys(LJ).map(function (k) { return LJ[k]; }).sort(function (a, b) { return b.fat - a.fat; });

    // categorias
    var cats = {};
    E.itens.forEach(function (x) { if (x.catid) cats[x.catid] = (cats[x.catid] || 0) + (x.fatMes || 0); });
    var ordC = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; });
    var totC = ordC.reduce(function (a, k) { return a + cats[k]; }, 0);

    var meus = E.minhaLoja ? E.itens.filter(function (x) { return x.loja === E.minhaLoja; }) : [];
    var data = new Date().toLocaleDateString('pt-BR');

    /* HTML e nao markdown: abre no navegador, imprime em PDF com Ctrl+P,
       e os links funcionam de verdade. Markdown so vira PDF com ferramenta
       de fora, e ninguem vai instalar uma para ler um relatorio. */
    function lin(a, b2) { return '<tr><td>' + a + '</td><td class="n">' + b2 + '</td></tr>'; }
    function linkP(x, corta) {
      var nome = esc(String(x.nome).slice(0, corta || 70));
      return (x.link && !E.gravando) ? '<a href="' + x.link + '" target="_blank">' + nome + '</a>' : nome;
    }
    /* No relatorio o blur nao serve: em PDF ele imprime borrado e em HTML
       basta inspecionar. Em modo gravacao a loja simplesmente nao vai. */
    function lojaRel(nome, link) {
      if (E.gravando) return '<span style="color:#9C9484">loja oculta</span>';
      return link ? '<a href="' + link + '" target="_blank">' + esc(nome || 'ver loja') + '</a>' : esc(nome || '');
    }

    var H = [];
    H.push('<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">');
    H.push('<title>' + esc(E.termo) + ' · analise de mercado</title>');
    H.push('<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=Outfit:wght@300;400;500;600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">');
    H.push('<style>' +
      '*{box-sizing:border-box;margin:0;padding:0}' +
      'body{background:#FDFBF7;color:#2C2A26;font:400 14.5px/1.6 Outfit,Arial;padding:44px 32px 80px}' +
      '.pag{max-width:860px;margin:0 auto}' +
      'h1{font:500 34px Archivo,Arial;letter-spacing:-.035em;margin-bottom:6px}' +
      'h1 em{font-style:normal;color:#EE4D2D}' +
      'h2{font:500 21px Archivo,Arial;letter-spacing:-.025em;margin:38px 0 12px;padding-top:22px;border-top:1px solid #EAE2D6}' +
      'h2:first-of-type{border-top:none;padding-top:0}' +
      '.sub{font:400 10.5px "Space Mono",monospace;letter-spacing:.12em;color:#9C9484;margin-bottom:26px}' +
      '.aviso{background:#F5F1E9;border:1px dashed #DED5C6;border-radius:16px;padding:14px 18px;font-size:13px;color:#7C7466;margin-bottom:30px;line-height:1.6}' +
      '.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:8px}' +
      '.kpi{background:#FFFDFA;border:1px solid #EFE8DC;border-radius:18px;padding:16px 18px}' +
      '.kpi .r{font:400 9px "Space Mono",monospace;letter-spacing:.1em;color:#9C9484;margin-bottom:7px}' +
      '.kpi .v{font:300 27px Outfit,Arial;letter-spacing:-.03em;color:#2C2A26}' +
      'table{width:100%;border-collapse:collapse;background:#FFFDFA;border:1px solid #EFE8DC;border-radius:18px;overflow:hidden;margin-bottom:14px}' +
      'th{text-align:left;background:#F8F4ED;font:400 9px "Space Mono",monospace;letter-spacing:.09em;color:#9C9484;padding:11px 16px;border-bottom:1px solid #EFE8DC}' +
      'td{padding:12px 16px;border-bottom:1px solid #F3EEE5;font-size:14px;vertical-align:top}' +
      'tr:last-child td{border-bottom:none}' +
      'td.n{text-align:right;font:400 11.5px "Space Mono",monospace;white-space:nowrap}' +
      'td small{display:block;font:400 10px "Space Mono",monospace;color:#9C9484;margin-top:3px}' +
      'a{color:#EE4D2D;text-decoration:none}a:hover{text-decoration:underline}' +
      '.nota{background:#FFFDFA;border:1px solid #EFE8DC;border-radius:16px;padding:14px 18px;font-size:13.5px;color:#4A4238;line-height:1.65;margin-bottom:14px}' +
      '.leitura{background:#FFF4EF;border-left:3px solid #EE4D2D;border-radius:0 16px 16px 0;padding:16px 20px;font-size:14.5px;line-height:1.7;margin-bottom:14px}' +
      '.leituraIA{background:#FFFDFA;border:1px solid #EFE8DC;border-radius:16px;padding:18px 22px;margin-bottom:14px}' +
      '.leituraIA p{font-size:14.5px;line-height:1.65;margin:0 0 9px;color:#332D22}' +
      '.leituraIA p:last-child{margin-bottom:0}' +
      '.leituraIA h4{font:500 16px Archivo,Arial;letter-spacing:-.02em;color:#17150F;margin:18px 0 7px}' +
      '.leituraIA h4:first-child{margin-top:0}' +
      '.leituraIA li{font-size:14.5px;line-height:1.6;margin:0 0 5px 18px;color:#332D22}' +
      '.bom{color:#1F8A5F}.ruim{color:#D64545}.aten{color:#C98A1E}' +
      '.rod{margin-top:44px;padding-top:20px;border-top:1px solid #EAE2D6;font-size:12px;color:#9C9484;line-height:1.6}' +
      '.imprimir{position:fixed;top:20px;right:20px;background:#EE4D2D;color:#fff;border:none;font:500 14px Outfit,Arial;padding:12px 24px;border-radius:14px;cursor:pointer;box-shadow:0 6px 16px rgba(238,77,45,.3)}' +
      '@media print{.imprimir{display:none}body{padding:0;background:#fff}h2{page-break-after:avoid}table{page-break-inside:avoid}}' +
      '</style></head><body>');
    H.push('<button class="imprimir" onclick="window.print()">Salvar em PDF</button>');
    H.push('<div class="pag">');
    H.push('<h1>' + esc(E.termo) + '<em>.</em></h1>');
    H.push('<div class="sub">ANÁLISE DE MERCADO · ' + data + ' · SELLER.IA</div>');

    H.push('<div class="aviso">Esta leitura cobre <b>' + E.itens.length + ' produtos</b> em ' +
      (E.paginasLidas || 1) + ' página(s) da busca por &ldquo;' + esc(E.termo) + '&rdquo;. ' +
      'É uma amostra do que a Shopee mostra a quem procura, não o nicho inteiro. ' +
      'Os números de venda e preço vêm da própria Shopee; o faturamento é a multiplicação dos dois.</div>');

    // ---- o retrato ----
    H.push('<h2>O retrato</h2>');
    H.push('<div class="kpis">' +
      '<div class="kpi"><div class="r">VENDAS NO MÊS</div><div class="v">' + num(R.vendas) + '</div></div>' +
      '<div class="kpi"><div class="r">FATURAMENTO</div><div class="v">' + reais(R.faturamento) + '</div></div>' +
      '<div class="kpi"><div class="r">TICKET MÉDIO</div><div class="v">' + reais(R.ticket) + '</div></div>' +
      '<div class="kpi"><div class="r">VENDEDORES</div><div class="v">' + R.lojas + '</div></div>' +
      '</div>');
    H.push('<table><tr><th>O QUE</th><th style="text-align:right">QUANTO</th></tr>' +
      lin('Faixa de preço', reais(R.precoMin) + ' a ' + reais(R.precoMax)) +
      lin('Preço médio', reais(R.precoMediano)) +
      lin('Concentração nos 5 maiores', num(R.concentracao, 0) + '% do faturamento') +
      lin('Pagando anúncio', R.anuncios + ' de ' + E.itens.length + ' (' + num((R.anuncios / E.itens.length) * 100, 0) + '%)') +
      lin('Sem nenhuma venda no mês', R.semVenda + ' produtos') +
      '</table>');

    // a faixa de preco, que estava so na tela
    H.push('<h2>A faixa de preço</h2>');
    H.push('<div class="nota">Os produtos vão de <b>' + reais(R.precoMin) + '</b> a <b>' + reais(R.precoMax) +
      '</b>, com o preço do meio da lista em <b>' + reais(R.precoMediano) + '</b>. ' +
      'O ticket médio de <b>' + reais(R.ticket) + '</b> ' +
      (R.ticket > R.precoMediano
        ? 'está acima disso, então quem vende volume aqui são os produtos mais caros.'
        : 'está abaixo disso, então o volume está concentrado nos mais baratos.') + '</div>');

    var recado = [];
    if (R.concentracao > 70) recado.push('Poucas lojas concentram quase tudo: cinco delas ficam com ' + num(R.concentracao, 0) + '% do faturamento. Para entrar você precisa de preço melhor ou de algo que elas não ofereçam.');
    else if (R.concentracao < 45) recado.push('O faturamento está espalhado entre muitas lojas, sem uma dominante. Um produto bem feito consegue espaço aqui.');
    else recado.push('Existem lojas maiores, mas o faturamento se divide entre várias. Dá para conquistar espaço sem bater de frente com a primeira.');
    recado.push('<b>' + R.anuncios + ' dos ' + E.itens.length + '</b> produtos vieram marcados como anúncio nesta busca. ' +
      'A Shopee mostra anúncios diferentes a cada busca, então este é o número de agora, não o total de quem anuncia no nicho.');
    if (R.semVenda > E.itens.length * 0.25) recado.push('<b>' + R.semVenda + ' produtos não venderam nada no mês</b>, o que mostra que estar na busca não garante venda.');
    H.push('<div class="leitura">' + recado.join(' ') + '</div>');

    // ---- os dez ----
    H.push('<h2>Os dez que mais vendem</h2>');
    H.push('<table><tr><th>#</th><th>PRODUTO</th><th style="text-align:right">VENDE/MÊS</th>' +
      '<th style="text-align:right">PREÇO</th><th style="text-align:right">FATURA</th></tr>');
    top.forEach(function (x, i2) {
      H.push('<tr><td class="n">' + (i2 + 1) + '</td>' +
        '<td>' + linkP(x, 62) + '<small>' + lojaRel(x.lojaNome, x.linkLoja) +
        (x.local ? ' · ' + esc(x.local) : '') + (x.anuncio ? ' · ANÚNCIO' : '') + '</small></td>' +
        '<td class="n">' + num(x.mes) + '</td><td class="n">' + reais(x.preco) + '</td>' +
        '<td class="n">' + (x.fatMes != null ? reais(x.fatMes) : '—') + '</td></tr>');
    });
    H.push('</table>');
    H.push('<div class="nota">Clique no nome para abrir o anúncio na Shopee.</div>');

    // ---- o que eles tem de diferente ----
    if (resto.length) {
      H.push('<h2>O que os campeões têm de diferente</h2>');
      H.push('<table><tr><th>O QUE</th><th style="text-align:right">OS 10 PRIMEIROS</th>' +
        '<th style="text-align:right">OS OUTROS ' + resto.length + '</th><th style="text-align:right">DIFERENÇA</th></tr>');
      function linC(rot, a, b2, f) {
        if (a == null || b2 == null) return;
        var dif = b2 ? ((a - b2) / b2) * 100 : 0;
        var cls = Math.abs(dif) < 8 ? '' : dif > 0 ? 'bom' : 'ruim';
        H.push('<tr><td>' + rot + '</td><td class="n">' + f(a) + '</td><td class="n">' + f(b2) + '</td>' +
          '<td class="n ' + cls + '">' + (dif > 0 ? '+' : '') + num(dif, 0) + '%</td></tr>');
      }
      linC('Quantas fotos o anúncio tem', m(top, 'fotos'), m(resto, 'fotos'), function (v) { return num(v, 1) + ' fotos'; });
      linC('Nota do produto', m(top, 'nota'), m(resto, 'nota'), function (v) { return num(v, 2) + ' de 5'; });
      linC('Quantas pessoas avaliaram', avals(top), avals(resto), function (v) { return num(v, 0); });
      linC('Preço cobrado', m(top, 'preco'), m(resto, 'preco'), function (v) { return reais(v); });
      H.push('<tr><td>Quantos pagam anúncio</td><td class="n">' + top.filter(function (x) { return x.anuncio; }).length + ' de 10</td>' +
        '<td class="n">' + resto.filter(function (x) { return x.anuncio; }).length + ' de ' + resto.length + '</td><td></td></tr>');
      H.push('</table>');

      var dif2 = [];
      var ft = m(top, 'fotos'), fr = m(resto, 'fotos');
      if (ft && fr && Math.abs(ft - fr) / fr > 0.15) dif2.push('os campeões usam <b>' + num(ft, 1) + ' fotos</b> contra ' + num(fr, 1) + ' dos outros');
      var at = avals(top), ar = avals(resto);
      if (at && ar && at > ar * 1.5) dif2.push('têm <b>' + num(at, 0) + ' avaliações</b> em média, contra ' + num(ar, 0));
      var pt = m(top, 'preco'), pr2 = m(resto, 'preco');
      if (pt && pr2 && Math.abs(pt - pr2) / pr2 > 0.15) dif2.push('vendem <b>' + (pt > pr2 ? 'mais caro' : 'mais barato') + '</b>, ' + reais(pt) + ' contra ' + reais(pr2));
      if (dif2.length) {
        var fr2 = dif2.join(', ');
        H.push('<div class="leitura">' + fr2.charAt(0).toUpperCase() + fr2.slice(1) + '.</div>');
      }
    }

    // ---- quem domina ----
    H.push('<h2>Quem domina</h2>');
    H.push('<table><tr><th>LOJA</th><th style="text-align:right">PRODUTOS</th>' +
      '<th style="text-align:right">VENDE/MÊS</th><th style="text-align:right">FATURAMENTO</th>' +
      '<th style="text-align:right">FATIA</th></tr>');
    ordL.slice(0, 12).forEach(function (l) {
      H.push('<tr><td>' + lojaRel(l.nome || ('loja ' + l.id), l.link) +
        '<small>' + (l.local || '') + (l.id === E.minhaLoja ? ' · VOCÊ' : '') + '</small></td>' +
        '<td class="n">' + l.itens + '</td><td class="n">' + num(l.mes) + '</td>' +
        '<td class="n">' + reais(l.fat) + '</td>' +
        '<td class="n">' + num(R.faturamento ? (l.fat / R.faturamento) * 100 : 0, 1) + '%</td></tr>');
    });
    H.push('</table>');

    // ---- onde ha brecha ----
    var cdR = E.itens.filter(function (x) { return x.cadastro && x.mes != null; });
    if (cdR.length >= 10) {
      var agR = Date.now() / 1000;
      var nvR = cdR.filter(function (x) { return (agR - x.cadastro) / 2592000 <= 6; });
      var nvVend = nvR.filter(function (x) { return x.mes >= 30; });
      H.push('<h2>O nicho aceita gente nova?</h2>');
      H.push('<div class="kpis">' +
        '<div class="kpi"><div class="r">ANÚNCIOS COM ATÉ 6 MESES</div><div class="v">' + nvR.length + '</div></div>' +
        '<div class="kpi"><div class="r">DESSES, JÁ VENDEM BEM</div><div class="v">' + nvVend.length + '</div></div>' +
        '<div class="kpi"><div class="r">NO AR HÁ MAIS DE 1 ANO</div><div class="v">' +
        cdR.filter(function (x) { return (agR - x.cadastro) / 2592000 > 12; }).length + '</div></div></div>');
      H.push('<div class="leitura">' +
        (nvVend.length >= 3
          ? '<b>' + nvVend.length + ' anúncios com menos de 6 meses já vendem mais de 30 por mês.</b> O nicho aceita gente nova.'
          : 'Poucos anúncios recentes vendem bem aqui. Entrar exige paciência: o resultado não vem nas primeiras semanas.') +
        '</div>');
    }

    var cnR = E.itens.filter(function (x) { return x.nota != null && x.mes > 0; });
    if (cnR.length >= 8) {
      var metR = cnR.slice().sort(function (a, b) { return b.mes - a.mes; }).slice(0, Math.ceil(cnR.length / 2));
      var brR = metR.filter(function (x) { return x.nota < 4.6; }).sort(function (a, b) { return a.nota - b.nota; });
      if (brR.length) {
        H.push('<h2>Onde o vendedor deixa a desejar</h2>');
        H.push('<table><tr><th>PRODUTO</th><th style="text-align:right">NOTA</th>' +
          '<th style="text-align:right">VENDE/MÊS</th><th style="text-align:right">PREÇO</th></tr>');
        brR.slice(0, 6).forEach(function (x) {
          H.push('<tr><td>' + linkP(x, 50) + '<small>' + lojaRel(x.lojaNome, x.linkLoja) + '</small></td>' +
            '<td class="n ' + (x.nota < 4.3 ? 'ruim' : 'aten') + '">' + num(x.nota, 2) + '</td>' +
            '<td class="n">' + num(x.mes) + '</td><td class="n">' + reais(x.preco) + '</td></tr>');
        });
        H.push('</table>');
        H.push('<div class="leitura"><b>' + brR.length + ' produtos</b> vendem bem com nota abaixo de 4,6. ' +
          'A demanda está provada e o comprador está aceitando um atendimento ruim. ' +
          'Vender o mesmo produto com nota alta é a forma mais direta de tirar venda de alguém aqui.</div>');
      }
    }

    // ---- quanto pagar ----
    H.push('<h2>Por quanto comprar</h2>');
    H.push('<div class="nota">Partindo de um preço de venda de <b>' + reais(preco) + '</b>, com ROAS de ' +
      (C.roas || 10) + 'x' + (C.imposto ? ', imposto de ' + num(C.imposto, 0) + '%' : '') +
      (C.embalagem ? ' e embalagem de ' + reais(C.embalagem) : '') + '.</div>');
    H.push('<div class="kpis">' +
      '<div class="kpi"><div class="r">MARGEM 15% · COMPETITIVO</div><div class="v ' + (c15.viavel ? '' : 'ruim') + '">' +
      (c15.viavel ? reais(c15.teto) : 'não fecha') + '</div></div>' +
      '<div class="kpi"><div class="r">MARGEM 20% · SAUDÁVEL</div><div class="v ' + (c20.viavel ? '' : 'ruim') + '">' +
      (c20.viavel ? reais(c20.teto) : 'não fecha') + '</div></div>' +
      '</div>');
    H.push('<table><tr><th>DE ONDE SAI CADA REAL</th><th style="text-align:right">QUANTO</th></tr>' +
      lin('Preço de venda', reais(preco)) +
      lin('Comissão da Shopee', '− ' + reais(c20.comissao)) +
      lin('Anúncio, a ROAS ' + (C.roas || 10) + 'x', '− ' + reais(c20.ads)) +
      (c20.imposto ? lin('Imposto', '− ' + reais(c20.imposto)) : '') +
      (c20.embalagem ? lin('Embalagem', '− ' + reais(c20.embalagem)) : '') +
      lin('Margem de 20%', '− ' + reais(c20.margem)) +
      lin('<b>Sobra para o produto</b>', '<b>' + reais(c20.teto) + '</b>') +
      '</table>');

    // ---- da para vender o suficiente ----
    var fixo = numeroPuro(C.fixo);
    if (fixo > 0 && c20.viavel) {
      var precisa = Math.ceil(fixo / c20.margem);
      var lider = ordV.length ? ordV[0].mes : 0;
      var med = ordV.length ? ordV[Math.floor(ordV.length / 2)].mes : 0;
      H.push('<h2>Dá para vender o suficiente?</h2>');
      H.push('<div class="kpis">' +
        '<div class="kpi"><div class="r">VENDAS/MÊS SÓ PARA EMPATAR</div><div class="v">' + num(precisa) + '</div></div>' +
        '<div class="kpi"><div class="r">O LÍDER FAZ</div><div class="v">' + num(lider) + '</div></div>' +
        '<div class="kpi"><div class="r">A MÉDIA FAZ</div><div class="v">' + num(med) + '</div></div>' +
        '</div>');
      var pct2 = lider ? (precisa / lider) * 100 : null;
      H.push('<div class="leitura">Com um custo fixo de <b>' + reais(fixo) + '</b> por mês e margem de ' +
        reais(c20.margem) + ' por venda, este produto precisa vender <b>' + num(precisa) + ' por mês</b> só para empatar' +
        (pct2 != null ? ', o que é <b>' + num(pct2, 0) + '% do que o líder vende</b>. ' : '. ') +
        (pct2 != null && pct2 > 100
          ? 'Ou seja, <b class="ruim">mais que o líder do nicho</b>. Sozinho, este produto não paga a operação.'
          : pct2 != null && pct2 > 60
            ? 'É possível, mas exige chegar perto do topo.'
            : 'Cabe sem precisar liderar.') +
        '<br><br>Lembrando que margem de contribuição não é lucro: é o que sobra para pagar o custo fixo. O lucro vem depois.</div>');
    }

    // ---- onde voce esta ----
    if (E.minhaLoja) {
      H.push('<h2>Onde você está</h2>');
      if (!meus.length) {
        H.push('<div class="leitura">Nenhum produto seu apareceu nesta amostra de ' + E.itens.length +
          ' resultados. Ou você não vende neste nicho, ou seus itens estão além da terceira página, que na prática é o mesmo que não aparecer.</div>');
      } else {
        var meuFat = meus.reduce(function (a, b2) { return a + (b2.fatMes || 0); }, 0);
        var meuMes = meus.reduce(function (a, b2) { return a + (b2.mes || 0); }, 0);
        H.push('<div class="kpis">' +
          '<div class="kpi"><div class="r">SEUS PRODUTOS AQUI</div><div class="v">' + meus.length + '</div></div>' +
          '<div class="kpi"><div class="r">SUAS VENDAS/MÊS</div><div class="v">' + num(meuMes) + '</div></div>' +
          '<div class="kpi"><div class="r">SEU FATURAMENTO</div><div class="v">' + reais(meuFat) + '</div></div>' +
          '<div class="kpi"><div class="r">FATIA DA AMOSTRA</div><div class="v">' +
          num(R.faturamento ? (meuFat / R.faturamento) * 100 : 0, 1) + '%</div></div></div>');
        H.push('<table><tr><th>SEU PRODUTO</th><th style="text-align:right">POSIÇÃO</th>' +
          '<th style="text-align:right">VENDE/MÊS</th><th style="text-align:right">PREÇO</th></tr>');
        meus.forEach(function (x) {
          H.push('<tr><td>' + linkP(x, 54) + '</td>' +
            '<td class="n">' + (ordV.indexOf(x) + 1) + 'º de ' + ordV.length + '</td>' +
            '<td class="n">' + num(x.mes) + '</td><td class="n">' + reais(x.preco) + '</td></tr>');
        });
        H.push('</table>');
      }
    }

    // ---- a leitura da IA, se houver ----
    if (E.consulta) {
      H.push('<h2>A leitura</h2>');
      // paragrafo vira paragrafo de verdade, com espacamento controlado.
      // Dois <br> davam quase uma linha em branco entre cada frase.
      H.push('<div class="leituraIA">' + esc(E.consulta)
        .replace(/^### (.+)$/gm, '<h4>$1</h4>')
        .replace(/^## (.+)$/gm, '<h4>$1</h4>')
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .split(/\n{2,}/).map(function (p2) {
          p2 = p2.trim();
          if (!p2) return '';
          if (/^<h4>|^<li>/.test(p2)) return p2.replace(/\n/g, '');
          return '<p>' + p2.replace(/\n/g, ' ') + '</p>';
        }).join('') + '</div>');
    }

    H.push('<div class="rod"><b>Seller.IA · Analista de Mercado</b><br>' +
      'Volume de venda e preço vêm da Shopee. O faturamento é a multiplicação dos dois. ' +
      'A leitura cobre ' + E.itens.length + ' produtos da busca por &ldquo;' + esc(E.termo) + '&rdquo;, não o nicho inteiro.<br>' +
      'Para salvar em PDF, use o botão no topo ou Ctrl+P.' +
      (E.gravando ? '<br><br><b>Gerado em modo gravação:</b> os nomes das lojas foram omitidos.' : '') + '</div>');
    H.push('</div></body></html>');

    try {
      var blob = new Blob([H.join('\n')], { type: 'text/html;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var w2 = window.open(url, '_blank');
      if (!w2) {
        var a2 = document.createElement('a');
        a2.href = url;
        a2.download = 'mercado-' + E.termo.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-' +
          new Date().toISOString().slice(0, 10) + '.html';
        document.documentElement.appendChild(a2); a2.click(); a2.remove();
      }
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (e) {
      alert('Nao consegui gerar o relatorio: ' + e.message);
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

  /* Para os numeros grandes da tela. "R$ 1.097.975,37" tem quinze
     caracteres e estoura a caixa; "R$ 1,1 mi" diz a mesma coisa e cabe.
     Os centavos so importam no preco de um produto, nao no faturamento
     somado de cento e oitenta deles. */
  function reaisCurto(n) {
    if (n == null) return '\u2014';
    var v = Number(n);
    if (v >= 1000000) return 'R$ ' + (v / 1000000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' mi';
    if (v >= 100000) return 'R$ ' + Math.round(v / 1000).toLocaleString('pt-BR') + ' mil';
    if (v >= 10000) return 'R$ ' + (v / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' mil';
    return reais(v);
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
    if (ajuda) h += '<div style="font-size:14px;color:var(--tx2);line-height:1.65;margin:-4px 0 13px">' + ajuda + '</div>';
    return h;
  }

  /* Esconde a loja por inteiro. E o dado sensivel: mostrar que alguem
     fatura meio milhao com um anuncio, com nome e tudo, expoe o vendedor. */
  function sigLoja(nome) {
    if (!E.gravando) return esc(nome || '');
    return '<span class="sig">' + esc(nome || 'loja') + '</span>';
  }

  /* Do titulo fica um pedaco legivel. Quem assiste entende o produto, mas
     nao consegue procurar o anuncio pelo nome completo. */
  function sigTitulo(nome, corte) {
    var n = String(nome || '').slice(0, corte || 60);
    if (!E.gravando) return esc(n);
    // corta no espaco, e nao no meio da palavra: "Kit 48 Carrinhos De"
    // fica natural, "Kit 48 Carrinhos De M" parece defeito
    var alvo = Math.max(10, Math.round(n.length * 0.42));
    var espaco = n.indexOf(' ', alvo);
    var visivel = espaco > 0 && espaco < n.length - 4 ? espaco : alvo;
    return esc(n.slice(0, visivel)) +
      '<span class="sig-part">' + esc(n.slice(visivel)) + '</span>';
  }

  function idade(ts) {
    if (!ts) return null;
    var d = Math.round((Date.now() / 1000 - ts) / 86400);
    if (d < 60) return d + ' dias';
    if (d < 730) return Math.round(d / 30) + ' meses';
    return (Math.round(d / 365 * 10) / 10) + ' anos';
  }

  /* Os tokens vem da especificacao aprovada. Bege como padrao, laranja
     como unica cor de acao, e o escuro como alternativa. */
  var TEMAS = {
    claro: '--card:#FBF8F3;--surf:var(--surf);--fill:#F8F4ED;--fill2:#F5F1E9;--fill3:#F0EAE0;' +
      '--bd1:#EAE2D6;--bd2:#EFE8DC;--bd3:#E7DFD2;--bd4:#E3DBCD;--bd5:#F3EEE5;--bd6:#DED5C6;' +
      '--mut4:#D3CCC0;--mut5:#C9BFAD;' +
      '--tx1:#2C2A26;--tx2:#4A4238;--tx3:var(--tx3);--tx4:#7C7466;--tx5:#8A8272;--tx6:var(--tx6);--tx7:#A39A88;' +
      '--tintO:#FFF4EF;--tintObd:#FBD9CD;--tintO2:#FFF1EC;--tintO2bd:#F7C9BA;' +
      '--tintG:#EAF6EF;--tintB:#EDF3FB;' +
      '--shadow:0 40px 90px rgba(72,56,38,.22), 0 6px 18px rgba(72,56,38,.08);',
    escuro: '--card:#0F1115;--surf:#151920;--fill:#1A1F27;--fill2:#171B22;--fill3:#232833;' +
      '--bd1:#232833;--bd2:#232833;--bd3:#2A303B;--bd4:#2A303B;--bd5:#1C212A;--bd6:#2A303B;' +
      '--mut4:#3A4150;--mut5:#4A5262;' +
      '--tx1:#F2F4F7;--tx2:#DCE0E6;--tx3:#AEB5C0;--tx4:#98A0AC;--tx5:#8A929E;--tx6:#79818D;--tx7:#6A727E;' +
      '--tintO:#2A1712;--tintObd:#4A2418;--tintO2:#2A1712;--tintO2bd:#5A2C1C;' +
      '--tintG:#12251D;--tintB:#141E2A;' +
      '--shadow:0 40px 90px rgba(0,0,0,.5), 0 6px 18px rgba(0,0,0,.28);'
  };

  /* A MARCA DO RADAR 360. O zero de "Radar360" e o radar: um anel com o
     blip laranja sobre o traco, a 45 graus no quadrante superior direito.
     O ponto e o mesmo elemento do "S." da Seller.IA — la e pontuacao, aqui
     e deteccao, e e o que amarra a familia sem precisar de selo.
     Medidas da especificacao aprovada (opcao 3a). */
  var LOGO = '<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="0" y="0" width="128" height="128" rx="30" fill="#1A1815"/>' +
    '<circle cx="64" cy="66" r="27" fill="none" stroke="#FBF8F3" stroke-width="11"/>' +
    '<circle cx="83.5" cy="46.5" r="12.6" fill="#1A1815"/>' +
    '<circle cx="83.5" cy="46.5" r="9.4" fill="#EE4D2D"/></svg>';

  /* O zero desenhado, para o wordmark do cabecalho. E uma ELIPSE, nao um
     circulo: circulo perfeito vira alvo, e o zero precisa continuar lendo
     como letra da palavra. */
  var ZERO = '<svg viewBox="0 0 31 54" style="height:1em;width:auto;vertical-align:-.12em" xmlns="http://www.w3.org/2000/svg">' +
    '<ellipse cx="15.5" cy="35" rx="11" ry="16.25" fill="none" stroke="currentColor" stroke-width="5.5"/>' +
    '<circle cx="23.3" cy="23.5" r="6.8" fill="var(--card)"/>' +
    '<circle cx="23.3" cy="23.5" r="4.6" fill="#EE4D2D"/></svg>';

  var ICO_LUA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICO_SOL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke-linecap="round"/></svg>';
  var ICO_LUPA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="15" height="15"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4" stroke-linecap="round"/></svg>';

  raiz.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '#tudo{' + TEMAS.claro + '}' +
    '#tudo.escuro{' + TEMAS.escuro + '}' +
    '*{box-sizing:border-box;font-family:Outfit,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif}' +

    /* a aba lateral */
    /* AS DUAS ABAS NA LATERAL, SEM SOBREPOR. A Seller.IA fica acima do meio
       e o Radar logo abaixo, com 4px entre elas. Cor diferente para dar para
       distinguir de relance: a Seller.IA escura, o Radar no laranja. */
    '.btn{position:fixed;top:calc(50% + 34px);right:0;width:44px;height:60px;' +
      'border-radius:16px 0 0 16px;background:#1A1815;color:#fff;border:none;cursor:pointer;' +
      'font:500 21px Archivo,Arial;letter-spacing:-.035em;box-shadow:-4px 4px 18px rgba(0,0,0,.2);' +
      /* Acima da gaveta da Seller.IA, que vai ate 2147483200: sem isso a
         aba do Radar ficava por baixo e nao dava para clicar. */
      'display:grid;place-items:center;z-index:2147483300;transition:width .15s,background .15s}' +
    '.btn span{display:block;width:28px;height:28px;line-height:0}' +
    '.btn span svg{width:100%;height:100%;display:block;border-radius:8px}' +
    '.btn:hover{width:52px;background:#2A2622}' +


    /* o painel flutuante */
    /* Colado no topo e no fim: 24px de folga em cima e embaixo era quase
       uma linha de conteudo perdida de cada lado. */
    '.painel{position:fixed;top:12px;right:12px;bottom:12px;width:48vw;min-width:660px;max-width:860px;' +
      'background:var(--card);color:var(--tx1);border-radius:30px;display:flex;flex-direction:column;' +
      'overflow:hidden;box-shadow:var(--shadow);z-index:2147483290;' +
      'opacity:0;pointer-events:none;transform:translateX(24px) scale(.99);transition:opacity .2s,transform .2s}' +
    '.painel.on{opacity:1;pointer-events:auto;transform:none}' +

    /* cabecalho */
    '.cab{padding:14px 22px 0}' +
    '.cab .l1{display:flex;align-items:center;gap:11px}' +
    '.cab .l2{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:11px 0 11px}' +
    '.marca{font:500 20px Archivo,Arial;letter-spacing:-.045em;color:var(--tx1);line-height:1;flex:none}' +
    '.marca span{display:block;font:400 8.5px "Space Mono",monospace;letter-spacing:.13em;color:var(--tx6);margin-top:3px}' +

    '.logo{width:34px;height:34px;flex:none;line-height:0}' +
    '.logo svg{width:100%;height:100%;display:block;border-radius:11px}' +
    '.ico{background:none;border:1px solid var(--bd3);color:var(--tx3);border-radius:11px;' +
      'width:32px;height:32px;display:grid;place-items:center;cursor:pointer;flex:none}' +
    '.ico:hover{border-color:#EE4D2D;color:#EE4D2D}' +
    /* O botao pulsa sozinho. O aviso em texto empurrava o cabecalho para
       baixo toda vez que ligava, e o proprio botao ja diz o que precisa. */
    '.ico.ligado{background:#EE4D2D;border-color:#EE4D2D;color:#fff;animation:pulsa 1.6s infinite}' +
    '.ico.fechar{width:32px;height:32px}' +

    /* busca */
    '.campo{flex:1;min-width:180px;display:flex;align-items:center;gap:8px;background:var(--fill);' +
      'border:1px solid var(--bd3);border-radius:14px;padding:0 13px}' +
    '.campo:focus-within{border-color:#EE4D2D}' +
    '.campo svg{color:var(--tx6);flex:none}' +
    '.campo input{flex:1;background:none;border:none;outline:none;padding:11px 0;font-size:14px;color:var(--tx1)}' +
    '.campo input::placeholder{color:var(--tx6)}' +
    'button.go{background:#EE4D2D;border:none;color:#fff;font:500 13.5px Outfit,Arial;padding:0 20px;' +
      'height:38px;border-radius:14px;cursor:pointer;box-shadow:0 5px 14px rgba(238,77,45,.26);white-space:nowrap}' +
    'button.go:hover{background:#d94326}' +
    'button.go:disabled{opacity:.6;cursor:default;box-shadow:none}' +
    '.opcoes{display:flex;gap:5px;align-items:center;flex-wrap:wrap}' +
    '.opcoes select{background:var(--fill);border:1px solid var(--bd3);color:var(--tx2);' +
      'font:400 10.5px "Space Mono",monospace;padding:6px 9px;border-radius:10px;cursor:pointer;outline:none}' +
    '.opcoes select:focus{border-color:#EE4D2D}' +
    '.mini{display:inline-flex;align-items:center;gap:5px;background:var(--fill);border:1px solid var(--bd3);' +
      'color:var(--tx5);font:400 10.5px "Space Mono",monospace;padding:6px 11px;border-radius:10px;cursor:pointer}' +
    '.mini:hover{border-color:#EE4D2D;color:#EE4D2D}' +
    '.mini.on{background:var(--tintO2);border-color:#EE4D2D;color:#EE4D2D}' +
    '.ctx{font:400 10.5px "Space Mono",monospace;color:var(--tx6);letter-spacing:.05em;' +
      'padding-bottom:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
    '.p-sessao{background:var(--tintG);color:#1F8A5F;border-radius:999px;padding:3px 9px;' +
      'font-size:8.5px;letter-spacing:.06em}' +

    /* abas */
    '.abas{display:flex;gap:2px 4px;flex-wrap:wrap;padding:0 22px;border-bottom:1px solid var(--bd2)}' +
    '.aba{display:flex;align-items:center;gap:6px;background:none;border:none;' +
      'border-bottom:2px solid transparent;color:var(--tx5);font:400 11.5px "Space Mono",monospace;' +
      'letter-spacing:.01em;padding:9px 8px 8px;cursor:pointer;margin-bottom:-1px}' +
    '.aba svg{width:15px;height:15px;flex:none}' +
    '.aba:hover{color:var(--tx2)}' +
    '.aba.on{color:#EE4D2D;border-bottom-color:#EE4D2D}' +
    '.aba.off{opacity:.38;cursor:default}' +
    '.aba.off:hover{color:var(--tx5)}' +

    '.corpo{flex:1;overflow-y:auto;padding:16px 22px 26px}' +
    '.corpo::-webkit-scrollbar{width:8px}' +
    '.corpo::-webkit-scrollbar-thumb{background:var(--mut4);border-radius:99px}' +

    /* blocos */
    '.kicker{display:flex;align-items:center;gap:9px;font:400 10px "Space Mono",monospace;' +
      'letter-spacing:.16em;color:#EE4D2D;margin:26px 0 11px}' +
    '.kicker:before{content:"";width:18px;height:2px;background:#EE4D2D;flex:none}' +
    /* Os rotulos de secao e os numeros grandes em laranja: e a cor de acao
       da marca, e sem ela a tela fica sem ponto de foco. */
    '.olho{display:flex;align-items:center;gap:9px;font:400 9.5px "Space Mono",monospace;' +
      'letter-spacing:.13em;color:#EE4D2D;margin:24px 0 9px}' +
    '.olho:before{content:"";width:16px;height:2px;background:#EE4D2D;flex:none}' +
    '.olho:first-child{margin-top:0}' +
    '.card{background:var(--surf);border:1px solid var(--bd2);border-radius:22px;padding:16px 18px;margin-bottom:10px}' +
    '.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:10px}' +
    '.kpi{background:var(--surf);border:1px solid var(--bd2);border-radius:20px;padding:16px 18px}' +
    '.kpi .r{font:400 9px "Space Mono",monospace;letter-spacing:.1em;color:var(--tx6);margin-bottom:7px}' +
    '.kpi{min-width:0}' +
    '.kpi .n{font:400 30px Outfit,Arial;letter-spacing:-.035em;color:var(--tx1);line-height:1;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.kpi .o{font-size:12px;color:var(--tx5);margin-top:5px}' +
    '.heroi{font:300 46px Outfit,Arial;letter-spacing:-.045em;color:#EE4D2D;line-height:1}' +

    /* tabela */
    '.tab{background:var(--surf);border:1px solid var(--bd2);border-radius:22px;overflow:hidden;margin-bottom:12px}' +
    'table{width:100%;border-collapse:collapse}' +
    'th{text-align:left;background:var(--fill);font:400 9px "Space Mono",monospace;letter-spacing:.09em;' +
      'color:var(--tx6);padding:9px 16px;border-bottom:1px solid var(--bd2);white-space:nowrap}' +
    'td{padding:11px 16px;border-bottom:1px solid var(--bd5);font-size:14px;color:var(--tx1);vertical-align:top}' +
    'tr:last-child td{border-bottom:none}' +
    /* linhas alternadas: com trinta linhas na tela, o olho perde a fila */
    'tr:nth-child(even) td{background:var(--fill2)}' +
    'tbody tr:hover td{background:var(--tintO)}' +
    '.num{text-align:right;font-family:"Space Mono",monospace;font-size:12.5px;color:var(--tx1);white-space:nowrap}' +
    '.sub2{font:400 10px "Space Mono",monospace;color:var(--tx6);margin-top:3px;display:block}' +
    '.eu td{background:var(--tintG)!important}' +
    '.rodape{font-size:12.5px;color:var(--tx4);padding:12px 18px;background:var(--fill2);line-height:1.55}' +

    /* pilulas e barras */
    /* MODO GRAVACAO. Blur em vez de pontinhos: parece intencional, e nao
       parece erro de carregamento. O nome da loja some inteiro; do titulo
       fica um pedaco legivel, o suficiente para a pessoa do video entender
       do que se trata sem conseguir achar o anuncio. */
    '.sig{filter:blur(5px);user-select:none;pointer-events:none}' +
    '.sig-part{filter:blur(4.5px);user-select:none}' +
    '.rec{display:inline-flex;align-items:center;gap:6px;background:#EE4D2D;color:#fff;' +
      'font:400 8.5px "Space Mono",monospace;letter-spacing:.1em;padding:3px 9px;border-radius:999px}' +
    '.rec i{width:6px;height:6px;border-radius:50%;background:#fff;animation:pulsa 1.4s infinite}' +
    '@keyframes pulsa{0%,100%{opacity:1}50%{opacity:.25}}' +
    '.pill{display:inline-block;font:400 8.5px "Space Mono",monospace;letter-spacing:.06em;' +
      'padding:3px 8px;border-radius:999px;vertical-align:middle}' +
    '.p-ads{background:var(--tintO);color:#EE4D2D}' +
    '.p-eu{background:var(--tintG);color:#1F8A5F}' +
    '.p-of{background:var(--tintB);color:#3A6EA8}' +
    '.barra{height:7px;background:var(--fill3);border-radius:4px;overflow:hidden;display:flex;margin:10px 0}' +
    '.barra i{display:block;height:100%}' +

    /* entradas */
    'input.n{width:100%;background:var(--fill);border:1px solid var(--bd3);border-radius:14px;' +
      'padding:11px 14px;font:400 14px "Space Mono",monospace;color:var(--tx1);outline:none}' +
    'input.n:focus{border-color:#EE4D2D}' +
    '.rot{font:400 9px "Space Mono",monospace;letter-spacing:.1em;color:var(--tx6);margin-bottom:6px}' +
    '.chip{background:var(--fill);border:1px solid var(--bd3);color:var(--tx5);' +
      'font:400 10.5px "Space Mono",monospace;letter-spacing:.05em;padding:7px 13px;border-radius:12px;cursor:pointer}' +
    '.chip.on{background:var(--tintO2);border-color:#EE4D2D;color:#EE4D2D}' +
    'button.sec{background:var(--surf);border:1px solid var(--bd4);color:var(--tx2);' +
      'font:400 13.5px Outfit,Arial;padding:11px 20px;border-radius:14px;cursor:pointer}' +
    'button.sec:hover{border-color:#EE4D2D;color:#EE4D2D}' +

    '.nota{font-size:14px;color:var(--tx1);line-height:1.6;background:var(--surf);' +
      'border:1px solid var(--bd2);border-radius:16px;padding:12px 15px;margin-bottom:10px}' +
    '.aviso{background:var(--fill2);border:1px dashed var(--bd6);border-radius:18px;' +
      'padding:8px 13px;font-size:12px;color:var(--tx4);line-height:1.45;margin-bottom:14px}' +
    '.vazio{text-align:center;padding:56px 24px;color:var(--tx4);font-size:14.5px;line-height:1.7}' +
    'a{color:#EE4D2D;text-decoration:none}' +
    '</style>' +

    '<button class="btn" id="abrir" title="Radar 360 · analise de mercado"><span>' + LOGO + '</span><b>RADAR</b></button>' +
    '<div id="tudo"><div class="painel" id="painel">' +
    /* TUDO EM DUAS LINHAS. A marca dividia a linha sozinha, a busca outra,
       as opcoes outra e o contexto mais uma: quatro linhas de cabecalho
       comiam quase metade da altura util. */
    '  <div class="cab">' +
    '    <div class="l1">' +
    '      <div class="logo">' + LOGO + '</div>' +
    '      <div class="marca">Radar36' + ZERO + '<span>POR SELLER.IA</span></div>' +
    '      <div class="campo">' + ICO_LUPA +
    '        <input id="termo" placeholder="digite um nicho: copo descartavel, luminaria 3d...">' +
    '      </div>' +
    '      <button class="go" id="ir">Analisar</button>' +
    '      <input type="file" id="foto" accept="image/*" style="display:none">' +
    '      <button class="ico" id="zerar" title="Limpar e comecar uma analise nova">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="15" height="15" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5a8 8 0 1 1-2.6-5.9M20 4v5h-5"/></svg></button>' +
    '      <button class="ico" id="gravar" title="Modo gravacao: esconde o nome das lojas">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="15" height="15">' +
    '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/></svg></button>' +
    '      <button class="ico" id="tema" title="Trocar o tema">' + ICO_LUA + '</button>' +
    '      <button class="ico fechar" id="fechar" title="Fechar">\u2715</button>' +
    '    </div>' +
    '    <div class="l2"><div class="opcoes" id="opcoes"></div>' +
    '      <div class="ctx" id="ctx"></div></div>' +
    '  </div>' +
    '  <div class="abas" id="abas"></div>' +
    '  <div class="corpo" id="corpo"></div>' +
    '</div></div>';

  var ABAS = [
    { id: 'link', rot: 'Por link', d: 'M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5' },
    { id: 'nicho', rot: 'O nicho', d: 'M3.5 20.5V13M9 20.5V7M14.5 20.5v-5M20 20.5V3.5' },
    { id: 'produtos', rot: 'Os produtos', d: 'M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5zM3.5 7.5 12 12l8.5-4.5M12 12v9' },
    { id: 'lojas', rot: 'As lojas', d: 'M4 9.5h16M4 9.5 6 4h12l2 5.5M5.5 9.5v10a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-10' },
    { id: 'calculo', rot: 'Quanto pagar', d: 'M7.5 4.5h9a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3zM8.5 8.5h7M9 13h1.5M14 13h1.5M9 16.5h1.5M14 16.5h1.5' },
    { id: 'consultor', rot: 'A leitura', d: 'M12 3.5l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM18.5 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z' },
    { id: 'eu', rot: 'Onde eu estou', d: 'M12 2.5 3.5 7v6.5c0 4.6 3.6 7.4 8.5 8.5 4.9-1.1 8.5-3.9 8.5-8.5V7zM9 12l2.2 2.2L15.5 10' }
  ];
  function svgAba(d) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>';
  }

  function desenhar() {
    var quando = '';
    if (E.quando) {
      var min = Math.round((Date.now() - E.quando) / 60000);
      quando = min < 1 ? 'agora' : min < 60 ? 'ha ' + min + ' min'
        : min < 1440 ? 'ha ' + Math.round(min / 60) + 'h'
        : new Date(E.quando).toLocaleDateString('pt-BR');
    }
    // A descricao da foto vira dica do titulo, em vez de ocupar a linha
    $('ctx').innerHTML = E.itens.length
      ? ('<span' + (E.fotoDescricao ? ' title="A foto mostrava: ' + esc(E.fotoDescricao) + '"' : '') + '>' +
         (E.fotoDescricao ? '\u25c9 ' : '') + '\u201c' + esc(E.termo) + '\u201d</span> \u00b7 ' +
         E.itens.length + ' PRODUTOS' +
         (quando ? ' \u00b7 ' + quando.toUpperCase() : '') +
         (E.minhaLoja ? ' <span class="p-sessao">LOGADA</span>' : '') +
         '')
      : 'NENHUM NICHO LIDO AINDA';
    $('ir').textContent = E.buscando ? 'Lendo...' : 'Analisar';
    $('ir').disabled = !!E.buscando;

    // profundidade e busca ampliada
    /* Tudo numa linha. A barra com seis botoes comia a altura do resultado,
       que e o que a pessoa veio ver. */
    $('opcoes').innerHTML =
      '<select id="sel-pg" title="Quantos produtos ler">' +
      [3, 5, 10].map(function (n2) {
        return '<option value="' + n2 + '"' + (E.paginas === n2 ? ' selected' : '') + '>' + (n2 * 60) + ' produtos</option>';
      }).join('') + '</select>' +
      '<button class="mini' + (E.ampliar ? ' on' : '') + '" id="ampliar" ' +
      'title="Alem do termo que voce escreveu, busca tambem o que as pessoas digitam parecido, ' +
      'como copo descartavel 200ml ou copo descartavel festa. Junta tudo numa analise so.">' +
      (E.ampliar ? '\u2713 ' : '+ ') + 'termos parecidos</button>' +
      '<button class="mini" id="por-foto" title="Manda uma foto e eu descubro o produto">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13" style="vertical-align:-2px">' +
      '<path d="M3 8.5h3l1.5-2.5h9L18 8.5h3v11H3z" stroke-linejoin="round"/><circle cx="12" cy="13.5" r="3.5"/></svg> foto</button>' +
      (E.variacoes && E.variacoes.length
        ? '<span style="font:400 9.5px \'Space Mono\',monospace;color:var(--tx6)">+' + E.variacoes.length + ' VARIACOES</span>' : '');

    /* A CONSULTA POR LINK NAO DEPENDE DE ANALISE. Esconder toda a barra ate
       existir uma obrigava a pessoa a buscar um termo qualquer so para
       chegar nela. Agora a barra aparece sempre; as abas que precisam de
       analise ficam apagadas ate haver uma. */
    $('abas').innerHTML = ABAS.map(function (a) {
      var precisa = a.id !== 'link';
      var apagada = precisa && !E.itens.length;
      return '<button class="aba' + (E.aba === a.id ? ' on' : '') + (apagada ? ' off' : '') + '" ' +
        'data-aba="' + a.id + '"' + (apagada ? ' title="Analise um nicho para liberar"' : '') + '>' +
        svgAba(a.d) + a.rot + '</button>';
    }).join('');

    var c = $('corpo');
    if (E.buscando) { c.innerHTML = '<div class="vazio">' + esc(E.progresso || 'Lendo...') + '</div>'; return; }
    if (E.erro) { c.innerHTML = '<div class="vazio">' + esc(E.erro) + '</div>'; return; }
    if (!E.itens.length && E.aba === 'link') { c.innerHTML = viewLink(); ligarTabela(); ligarCalculo(); return; }
    if (!E.itens.length) {
      // No painel do vendedor a busca da vitrine e bloqueada pelo navegador
      // (dominios diferentes). Dizer isso antes evita a pessoa tentar e
      // levar um erro sem explicacao.
      var noPainel = location.hostname === 'seller.shopee.com.br';
      c.innerHTML = (noPainel
        ? '<div class="aviso" style="border-color:#EE4D2D;color:var(--tx2)">Você está no <b>painel do vendedor</b>. ' +
          'A leitura de nicho acontece na vitrine, então se a busca falhar aqui, abra <b>shopee.com.br</b> e use o Radar de lá.</div>'
        : '') +
        '<div class="vazio">Escreva um nicho e toque em <b>Analisar</b>.<br><br>' +
        'A leitura cobre ate ' + (MAX_PAGINAS * 60) + ' produtos e mostra quem vende, quanto vende,<br>' +
        'a que preco, e quanto do topo e anuncio.</div>';
      return;
    }
    if (E.detalhe) { c.innerHTML = viewDetalhe(); ligarTabela(); return; }
    c.innerHTML = E.aba === 'link' ? viewLink()
      : E.aba === 'nicho' ? viewNicho()
      : E.aba === 'produtos' ? viewProdutos()
      : E.aba === 'lojas' ? viewLojas()
      : E.aba === 'calculo' ? renderCalculo()
      : E.aba === 'consultor' ? viewConsultor()
      : viewEu();
    ligarTabela();
    ligarCalculo();
  }

  /* O aviso e curto de proposito: repetir tres paragrafos toda vez cansa e
     a pessoa para de ler. Uma linha, sempre visivel. */
  function avisoSessao() {
    var h = '';
    if (E.semVolume) {
      h += '<div class="aviso" style="border-color:#D64545;color:#D64545">' +
        '<b>A Shopee não devolveu o volume de vendas nesta busca.</b> Os preços e as lojas estão certos, ' +
        'mas o faturamento não pode ser calculado. Abra shopee.com.br logada e tente de novo.</div>';
    }
    return h + '<div class="aviso">Amostra de <b>' + E.itens.length + '</b> produtos, não o nicho inteiro.</div>';
  }

  function viewNicho() {
    var R = resumo();
    if (!R) return avisoSessao() + '<div class="vazio">A Shopee nao devolveu volume de venda nesta busca. Confira se voce esta logada.</div>';
    var h = avisoSessao();

    /* O numero heroi primeiro, sozinho, e o resto embaixo. Seis cartoes
       iguais nao dizem o que olhar antes. */
    h += '<div style="background:var(--surf);border:1px solid var(--bd2);border-radius:22px;padding:24px 26px;margin-bottom:12px">' +
      '<div style="display:flex;align-items:baseline;gap:26px;flex-wrap:wrap">' +
      '<div><div style="font:400 9px \'Space Mono\',monospace;letter-spacing:.11em;color:var(--tx6);margin-bottom:9px">' +
      'ESTES ' + R.itens + ' PRODUTOS FATURAM, POR MÊS</div>' +
      '<div style="font:300 46px Outfit,Arial;letter-spacing:-.045em;color:#EE4D2D;line-height:1;white-space:nowrap" ' +
      'title="' + reais(R.faturamento) + '">' + reaisCurto(R.faturamento) + '</div></div>' +
      '<div style="border-left:1px solid var(--bd5);padding-left:24px">' +
      '<div style="font:400 9px \'Space Mono\',monospace;letter-spacing:.11em;color:var(--tx6);margin-bottom:9px">UNIDADES VENDIDAS</div>' +
      '<div style="font:300 34px Outfit,Arial;letter-spacing:-.04em;color:#EE4D2D;line-height:1">' + num(R.vendas) + '</div></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:22px;margin-top:20px;padding-top:18px;border-top:1px solid var(--bd5)">' +
      celula(reais(R.ticket), 'TICKET MÉDIO') +
      celula(num(R.lojas), 'LOJAS VENDENDO') +
      celula(R.anuncios + ' de ' + E.itens.length, 'ESTAVAM ANUNCIANDO') +
      celula(num(R.semVenda), 'NÃO VENDERAM NADA') +
      '</div></div>';

    h += '<div class="olho">A FAIXA DE PREÇO</div>';
    h += '<div class="nota">De <b>' + reais(R.precoMin) + '</b> a <b>' + reais(R.precoMax) + '</b>, com o preço do meio da lista em <b>' + reais(R.precoMediano) + '</b>.<br>' +
      'O ticket médio de <b>' + reais(R.ticket) + '</b> é onde o dinheiro realmente está \u2014 ' +
      (R.ticket > R.precoMediano
        ? 'está acima do preço médio, então quem vende volume aqui são os produtos mais caros.'
        : 'está abaixo do preço médio, então o volume de vendas está concentrado nos produtos mais baratos.') + '</div>';

    h += '<div class="olho">CONCENTRAÇÃO</div>';
    h += '<div class="nota">Os <b>5 maiores</b> ficam com <b>' + num(R.concentracao, 0) + '%</b> do faturamento desta amostra.<br>' +
      (R.concentracao > 70
        ? 'Poucas lojas concentram quase tudo. Para entrar aqui você precisa de um preço melhor que o deles, ou de algo que elas não ofereçam.'
        : R.concentracao > 45
          ? 'Existem lojas maiores, mas o faturamento se divide entre várias. Dá para conquistar espaço sem precisar bater de frente com a primeira.'
          : 'O faturamento está espalhado entre muitas lojas, sem uma dominante. Um produto bem feito consegue espaço aqui.') + '</div>';

    var pctAds = (R.anuncios / E.itens.length) * 100;
    h += '<div class="olho">QUANTO DO TOPO É PAGO</div>';
    h += '<div class="nota"><b>' + R.anuncios + ' de ' + E.itens.length + '</b> resultados são anúncio (' + num(pctAds, 0) + '%).<br>' +
      (pctAds < 15
        ? 'Pouca gente anunciando. Dá para aparecer organicamente, e quem anunciar tem pouca disputa.'
        : pctAds < 35
          ? 'Disputa moderada. O anúncio ajuda, mas o orgânico ainda entrega.'
          : 'Muita gente pagando. Sem anúncio, dificilmente você aparece nas primeiras posições.') + '</div>';

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

      h += olho('O QUE OS 10 MAIS VENDIDOS TÊM DE DIFERENTE',
        'Cada linha mostra o valor médio entre os dez que mais vendem, ao lado do valor médio de todos os outros produtos da amostra. Diferenças acima de 15% indicam algo que os campeões fazem e vale copiar.');
      h += '<table><tr><th></th><th class="num">TOP 10</th><th class="num">O RESTO</th><th class="num">DIFERENCA</th></tr>';
      function linhaC(rot, a, b, fmt) {
        if (a == null || b == null) return '';
        var dif = b ? ((a - b) / b) * 100 : 0;
        return '<tr><td>' + rot + '</td><td class="num">' + fmt(a) + '</td><td class="num">' + fmt(b) + '</td>' +
          '<td class="num" style="color:' + (Math.abs(dif) < 8 ? 'var(--tx3)' : dif > 0 ? '#1F8A5F' : '#D64545') + '">' +
          (dif > 0 ? '+' : '') + num(dif, 0) + '%</td></tr>';
      }
      h += linhaC('Quantas fotos o anúncio tem', fotoT, fotoR, function (v) { return num(v, 1) + ' fotos'; });
      h += linhaC('Nota do produto', notaT, notaR, function (v) { return num(v, 2) + ' de 5'; });
      h += linhaC('Quantas pessoas avaliaram', avT, avR, function (v) { return num(v, 0); });
      h += linhaC('Preço cobrado', precoT, precoR, function (v) { return reais(v); });
      h += '<tr><td>Quantos pagam anúncio</td><td class="num">' + adsT + ' de 10</td>' +
        '<td class="num">' + resto.filter(function (x) { return x.anuncio; }).length + ' de ' + resto.length + '</td><td></td></tr>';
      h += '</table>';
      h += '<div class="rodape" style="margin:-12px 0 12px;border-radius:0 0 22px 22px">' +
        'Cada linha é a <b>média</b> dos dez que mais vendem, ao lado da média de todos os outros. ' +
        'A última coluna diz o quanto os campeões estão acima ou abaixo. Diferenças pequenas, abaixo de 8%, aparecem em cinza porque não significam nada.</div>';

      var recado = [];
      if (fotoT && fotoR && fotoT > fotoR * 1.15) recado.push('os campeoes tem <b>' + num(fotoT, 1) + ' fotos</b> contra ' + num(fotoR, 1) + ' do resto');
      if (avT && avR && avT > avR * 1.5) recado.push('tem <b>' + num(avT, 0) + ' avaliacoes</b> em media, contra ' + num(avR, 0));
      if (precoT && precoR && Math.abs(precoT - precoR) / precoR > 0.15) {
        recado.push('vendem <b>' + (precoT > precoR ? 'mais caro' : 'mais barato') + '</b>: ' + reais(precoT) + ' contra ' + reais(precoR));
      }
      if (recado.length) {
        var fr = recado.join(', ');
        h += '<div class="nota">' + fr.charAt(0).toUpperCase() + fr.slice(1) + '.</div>';
      }
    }

    /* O bloco do mesmo produto em varias lojas saiu. Ele agrupava por
       titulo parecido, e titulo parecido nao garante produto igual: um
       "Kit 48 Carrinhos" pode ser de metal e o outro de plastico, um pode
       ter 48 pecas e o outro 12 com nome enganoso. Comparando os dois eu
       diria que o mais caro vende mais quando ele so e melhor — inferencia
       sem base no dado. Melhor nao ter o bloco do que ter um que engana. */

    /* ---- QUEM ENTROU HA POUCO E JA VENDE ----
       Diz se o nicho ainda aceita gente nova ou se so quem esta ha anos
       consegue vender. */
    var comData = E.itens.filter(function (x) { return x.cadastro && x.mes != null; });
    if (comData.length >= 10) {
      var agora = Date.now() / 1000;
      function meses(x) { return (agora - x.cadastro) / 2592000; }
      var novos = comData.filter(function (x) { return meses(x) <= 6; });
      var velhos = comData.filter(function (x) { return meses(x) > 12; });
      var novosVendendo = novos.filter(function (x) { return x.mes >= 30; });

      h += olho('O NICHO ACEITA GENTE NOVA?',
        'Quanto tempo os anúncios que vendem estão no ar. Se só produto antigo vende, entrar é mais difícil.');
      h += '<div style="display:flex;gap:28px;flex-wrap:wrap;background:var(--surf);border:1px solid var(--bd2);' +
        'border-radius:22px;padding:18px 20px;margin-bottom:12px">' +
        celula(num(novos.length), 'ANÚNCIOS COM ATÉ 6 MESES') +
        celula(num(novosVendendo.length), 'DESSES, JÁ VENDEM BEM') +
        celula(num(velhos.length), 'ESTÃO NO AR HÁ MAIS DE 1 ANO') +
        '</div>';

      var pctNovos = comData.length ? (novos.length / comData.length) * 100 : 0;
      var ordVendas = E.itens.filter(function (x) { return x.mes != null; })
        .sort(function (a, b) { return b.mes - a.mes; });
      var mesesTop = ordVendas.slice(0, 10)
        .filter(function (x) { return x.cadastro; })
        .map(meses);
      var medTop = mesesTop.length ? mesesTop.reduce(function (a, b) { return a + b; }, 0) / mesesTop.length : null;

      h += '<div class="nota">';
      if (novosVendendo.length >= 3) {
        h += '<b>' + novosVendendo.length + ' anúncios com menos de 6 meses já vendem mais de 30 por mês.</b> ' +
          'O nicho aceita gente nova, e o algoritmo ainda dá espaço para quem chega.';
      } else if (pctNovos < 15) {
        h += 'Quase tudo que vende aqui está no ar <b>há mais de 6 meses</b>. ' +
          'Entrar exige paciência: o resultado não vem nas primeiras semanas.';
      } else {
        h += 'Há anúncios novos na busca, mas <b>poucos deles vendem bem ainda</b>. ' +
          'Dá para entrar, mas o volume demora a aparecer.';
      }
      if (medTop != null) {
        h += '<br><br>Os dez que mais vendem estão no ar há <b>' +
          (medTop < 12 ? num(medTop, 0) + ' meses' : num(medTop / 12, 1) + ' anos') + '</b> em média.';
      }
      h += '</div>';
    }

    /* ---- ONDE O VENDEDOR E RUIM ----
       Nota baixa com venda alta e a brecha mais concreta que existe: o
       produto vende apesar do vendedor. */
    var comNota = E.itens.filter(function (x) { return x.nota != null && x.mes != null && x.mes > 0; });
    if (comNota.length >= 8) {
      var vendeMuito = comNota.slice().sort(function (a, b) { return b.mes - a.mes; }).slice(0, Math.ceil(comNota.length / 2));
      var brechas = vendeMuito.filter(function (x) { return x.nota < 4.6; })
        .sort(function (a, b) { return a.nota - b.nota; });
      if (brechas.length) {
        h += olho('ONDE O VENDEDOR DEIXA A DESEJAR',
          'Produtos que vendem bem apesar da nota baixa. Se o comprador aceita comprar de quem atende mal, ele aceitaria melhor de quem atende bem.');
        h += '<div class="tab"><table><tr><th>PRODUTO</th><th class="num">NOTA</th>' +
          '<th class="num">VENDE/MÊS</th><th class="num">PREÇO</th></tr>';
        brechas.slice(0, 8).forEach(function (x) {
          h += '<tr><td><b>' + sigTitulo(x.nome, 44) + '</b>' +
            (x.link && !E.gravando ? ' <a href="' + x.link + '" target="_blank" rel="noopener" style="font-size:12px">\u2197</a>' : '') +
            '<span class="sub2">' + sigLoja(x.lojaNome) + '</span></td>' +
            '<td class="num" style="color:' + (x.nota < 4.3 ? '#D64545' : '#C98A1E') + '">' + num(x.nota, 2) + '</td>' +
            '<td class="num">' + num(x.mes) + '</td>' +
            '<td class="num">' + reais(x.preco) + '</td></tr>';
        });
        h += '</table></div>';
        h += '<div class="nota"><b>' + brechas.length + ' produtos</b> vendem bem com nota abaixo de 4,6. ' +
          'Isso significa que a demanda existe e o comprador está engolindo um atendimento ruim. ' +
          'Vender o mesmo produto com nota alta é a forma mais direta de tirar venda de alguém aqui.</div>';
      } else {
        h += olho('QUALIDADE DO ATENDIMENTO');
        h += '<div class="nota">Todos os que vendem bem têm nota <b>4,6 ou mais</b>. ' +
          'Não há brecha de atendimento neste nicho: para tirar venda de alguém, será por produto ou preço.</div>';
      }
    }

    return h;
  }
  function card(n, r) { return '<div class="kpi"><div class="r">' + r + '</div><div class="n">' + n + '</div></div>'; }
  function celula(n, r) {
    return '<div style="min-width:0"><div style="font:400 9px \'Space Mono\',monospace;letter-spacing:.1em;color:var(--tx6);margin-bottom:6px;white-space:nowrap">' + r + '</div>' +
      '<div style="font:400 21px Outfit,Arial;letter-spacing:-.025em;color:var(--tx1);white-space:nowrap">' + n + '</div></div>';
  }

  function viewProdutos() {
    var I = E.itens.slice().sort(function (a, b) {
      if (E.ordem === 'fat') return (b.fatMes || 0) - (a.fatMes || 0);
      if (E.ordem === 'preco') return (b.preco || 0) - (a.preco || 0);
      if (E.ordem === 'total') return (b.total || 0) - (a.total || 0);
      return (b.mes || 0) - (a.mes || 0);
    });
    var h = '<div class="olho">' + I.length + ' PRODUTOS · TOQUE NA COLUNA PARA ORDENAR</div>';
    h += '<table><tr><th>PRODUTO</th><th class="num" data-ord="mes">MES</th>' +
      '<th class="num" data-ord="total">TOTAL</th><th class="num" data-ord="preco">PRECO</th>' +
      '<th class="num" data-ord="fat">FATURA</th><th class="num">30 DIAS</th></tr>';
    I.slice(0, 120).forEach(function (x) {
      var t = tendencia(x.id);
      var meu = E.minhaLoja && x.loja === E.minhaLoja;
      h += '<tr class="' + (meu ? 'eu' : '') + '"><td style="cursor:pointer">' +
        '<b data-item="' + x.id + '">' + sigTitulo(x.nome, 52) + '</b>' +
        (x.link ? ' <a href="' + x.link + '" target="_blank" rel="noopener" title="abrir na Shopee" ' +
          'style="color:#EE4D2D;text-decoration:none;font-size:12px">\u2197</a>' : '') +
        (x.anuncio ? ' <span class="pill p-ads">ads</span>' : '') +
        (meu ? ' <span class="pill p-eu">seu</span>' : '') +
        '<br><span style="color:var(--tx3);font-size:12px">' +
        (E.gravando
          ? sigLoja(x.lojaNome)
          : (x.linkLoja ? '<a href="' + x.linkLoja + '" target="_blank" rel="noopener">' + esc(x.lojaNome || 'ver loja') + '</a>' : esc(x.lojaNome || ''))) +
        (x.local ? ' \u00b7 ' + esc(x.local) : '') + '</span></td>' +
        '<td class="num">' + num(x.mes) + '</td>' +
        '<td class="num">' + num(x.total) + '</td>' +
        '<td class="num">' + reais(x.preco) + '</td>' +
        '<td class="num">' + (x.fatMes != null ? reais(x.fatMes) : '\u2014') + '</td>' +
        '<td class="num" style="color:' + (t ? (t.pct > 0 ? '#1F8A5F' : '#D64545') : 'var(--tx3)') + '">' +
        (t ? (t.pct > 0 ? '+' : '') + num(t.pct, 0) + '%' : '\u2014') + '</td></tr>';
    });
    h += '</table>';
    h += '<div class="nota" style="font-size:13px;color:var(--tx2)">A coluna <b>30 dias</b> compara o volume de hoje com o da primeira vez que voce leu este produto. ' +
      'A Shopee nao entrega historico \u2014 este e o nosso, e cresce a cada analise.</div>';
    return h;
  }

  function viewLojas() {
    var L = {};
    E.itens.forEach(function (x) {
      if (!x.loja) return;
      var l = L[x.loja] = L[x.loja] || {
        id: x.loja, nome: x.lojaNome, local: x.local, itens: 0, mes: 0, fat: 0,
        oficial: x.oficial, verificada: x.verificada, precos: [], link: x.linkLoja
      };
      l.itens++; l.mes += x.mes || 0; l.fat += x.fatMes || 0;
      if (x.preco) l.precos.push(x.preco);
    });
    var ord = Object.keys(L).map(function (k) { return L[k]; })
      .sort(function (a, b) { return b.fat - a.fat; });
    var h = '<div class="olho">' + ord.length + ' VENDEDORES NESTA AMOSTRA</div>';
    h += '<table><tr><th>LOJA</th><th class="num">PRODUTOS</th><th class="num">VENDAS/MES</th>' +
      '<th class="num">FATURAMENTO</th><th class="num">PRECO MEDIO</th></tr>';
    ord.slice(0, 40).forEach(function (l) {
      var meu = E.minhaLoja && l.id === E.minhaLoja;
      var med = l.precos.length ? l.precos.reduce(function (a, b) { return a + b; }, 0) / l.precos.length : null;
      h += '<tr class="' + (meu ? 'eu' : '') + '"><td><b>' + sigLoja(l.nome || ('loja ' + l.id)) + '</b>' +
        (l.link && !E.gravando ? ' <a href="' + l.link + '" target="_blank" rel="noopener" title="abrir a loja na Shopee" ' +
          'style="font-size:12px">\u2197</a>' : '') +
        (l.oficial ? ' <span class="pill p-of">oficial</span>' : '') +
        (meu ? ' <span class="pill p-eu">voce</span>' : '') +
        '<br><span style="color:var(--tx3);font-size:12px">' + esc(l.local || '') + '</span></td>' +
        '<td class="num">' + l.itens + '</td>' +
        '<td class="num">' + num(l.mes) + '</td>' +
        '<td class="num">' + reais(l.fat) + '</td>' +
        '<td class="num">' + reais(med) + '</td></tr>';
    });
    return h + '</table>';
  }

  function viewLink() {
    var h = olho('CONSULTAR PELO LINK',
      'Cole o endereço de um <b>produto</b> para ver quanto ele vende, ou de uma <b>loja</b> para ver o faturamento dela inteira. Os dois no mesmo campo.');
    h += '<div style="display:flex;gap:9px;margin-bottom:14px">' +
      '<input id="campo-link" class="n" placeholder="https://shopee.com.br/..." ' +
      'style="flex:1;font-family:Outfit,Arial;font-size:14px" value="' + esc(E.linkDigitado || '') + '">' +
      '<button class="go" id="ir-link"' + (E.buscando ? ' disabled' : '') + '>' +
      (E.buscando ? 'Lendo...' : 'Consultar') + '</button></div>';

    if (E.buscando) return h + '<div class="vazio">' + esc(E.progresso || 'Lendo...') + '</div>';
    if (E.erro) h += '<div class="nota" style="color:#D64545">' + esc(E.erro) + '</div>';

    var C = E.consultaLink;
    if (!C) {
      return h + '<div class="nota">Funciona com os dois formatos de link da Shopee, o que tem <b>/product/</b> e o que termina em <b>-i.numero.numero</b>. Para loja, use o link que tem <b>/shop/</b>.</div>';
    }

    if (C.tipo === 'produto') {
      var x = C.item;
      h += '<div style="background:var(--surf);border:1px solid var(--bd2);border-radius:22px;padding:20px 22px;margin-bottom:12px">' +
        '<div style="font-size:15px;font-weight:600;color:var(--tx1);margin-bottom:4px">' + sigTitulo(x.nome, 70) + '</div>' +
        '<div style="font:400 10px \'Space Mono\',monospace;color:var(--tx6);margin-bottom:16px">' + sigLoja(x.lojaNome) +
        (x.local ? ' \u00b7 ' + esc(x.local) : '') + '</div>';

      if (x.mes != null) {
        h += '<div style="display:flex;align-items:baseline;gap:22px;flex-wrap:wrap">' +
          '<div><div style="font:400 9px \'Space Mono\',monospace;letter-spacing:.1em;color:var(--tx6);margin-bottom:7px">VENDE POR MÊS</div>' +
          '<div style="font:300 46px Outfit,Arial;letter-spacing:-.045em;color:#EE4D2D;line-height:1">' + num(x.mes) + '</div></div>' +
          '<div style="border-left:1px solid var(--bd5);padding-left:22px">' +
          '<div style="font:400 9px \'Space Mono\',monospace;letter-spacing:.1em;color:var(--tx6);margin-bottom:7px">FATURA POR MÊS</div>' +
          '<div style="font:300 34px Outfit,Arial;letter-spacing:-.04em;color:#EE4D2D;line-height:1" title="' +
          (x.fatMes != null ? reais(x.fatMes) : '') + '">' + (x.fatMes != null ? reaisCurto(x.fatMes) : '\u2014') + '</div></div></div>';
      } else {
        h += '<div style="display:flex;align-items:baseline;gap:22px;flex-wrap:wrap">' +
          '<div><div style="font:400 9px \'Space Mono\',monospace;letter-spacing:.1em;color:var(--tx6);margin-bottom:7px">PREÇO</div>' +
          '<div style="font:300 46px Outfit,Arial;letter-spacing:-.045em;color:#EE4D2D;line-height:1">' + reais(x.preco) + '</div></div></div>';
      }

      h += '<div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:18px;padding-top:16px;border-top:1px solid var(--bd5)">' +
        (x.mes != null ? celula(reais(x.preco), 'PREÇO') : '') +
        (x.total != null ? celula(num(x.total), 'VENDEU DESDE QUE ENTROU') : '') +
        (x.nota != null ? celula(num(x.nota, 2) + ' de 5', 'NOTA') : '') +
        (x.avaliacoes != null ? celula(num(x.avaliacoes), 'AVALIAÇÕES') : '') +
        (x.curtidas != null ? celula(num(x.curtidas), 'CURTIDAS') : '') +
        (x.fotos != null ? celula(x.fotos + ' fotos', 'NO ANÚNCIO') : '') +
        (x.estoque != null ? celula(num(x.estoque), 'EM ESTOQUE') : '') +
        (x.cadastro ? celula(idade(x.cadastro), 'NO AR HÁ') : '') +
        '</div></div>';

      if (C.semVolume) {
        h += '<div class="aviso" style="border-color:#C98A1E;color:var(--tx2)">' +
          '<b>O volume de vendas não apareceu.</b> Ele só existe na busca, e este anúncio não saiu nas três primeiras páginas ' +
          'pelo próprio título. Isso já diz algo: ele está mal posicionado para o nome que tem. O resto dos dados vem da página do produto e está completo.</div>';
      }

      // o que a pagina entrega sobre a loja
      if (x.lojaSeguidores != null || x.lojaProdutos != null || x.lojaNota != null) {
        h += olho('A LOJA QUE VENDE ISTO');
        h += '<div style="display:flex;gap:24px;flex-wrap:wrap;background:var(--surf);border:1px solid var(--bd2);' +
          'border-radius:22px;padding:16px 20px;margin-bottom:12px">' +
          (x.lojaSeguidores != null ? celula(num(x.lojaSeguidores), 'SEGUIDORES') : '') +
          (x.lojaProdutos != null ? celula(num(x.lojaProdutos), 'PRODUTOS') : '') +
          (x.lojaNota != null ? celula(num(x.lojaNota, 2) + ' de 5', 'NOTA DA LOJA') : '') +
          (x.lojaDesde ? celula(idade(x.lojaDesde), 'ABERTA HÁ') : '') +
          (x.lojaResposta != null ? celula(num(x.lojaResposta, 0) + '%', 'RESPONDE') : '') +
          '</div>';
        if (x.linkLoja && !E.gravando) {
          h += '<div class="nota"><a href="' + x.linkLoja + '" target="_blank" rel="noopener">Ver a loja inteira \u2197</a> \u00b7 ' +
            'cole o link dela aqui em cima para ver o faturamento completo.</div>';
        }
      }

      if (x.link && !E.gravando) h += '<div class="nota"><a href="' + x.link + '" target="_blank" rel="noopener">Abrir o anúncio na Shopee \u2197</a></div>';
      return h;
    }

    // ---- LOJA ----
    var ord = C.itens.filter(function (y) { return y.mes != null; })
      .sort(function (a, b) { return (b.mes || 0) - (a.mes || 0); });
    h += '<div style="background:var(--surf);border:1px solid var(--bd2);border-radius:22px;padding:20px 22px;margin-bottom:12px">' +
      '<div style="font-size:15px;font-weight:600;color:var(--tx1);margin-bottom:14px">' + sigLoja(C.nome) + '</div>' +
      '<div style="display:flex;align-items:baseline;gap:22px;flex-wrap:wrap">' +
      '<div><div style="font:400 9px \'Space Mono\',monospace;letter-spacing:.1em;color:var(--tx6);margin-bottom:7px">FATURA POR MÊS</div>' +
      '<div style="font:300 46px Outfit,Arial;letter-spacing:-.045em;color:#EE4D2D;line-height:1" title="' + reais(C.fat) + '">' +
      reaisCurto(C.fat) + '</div></div>' +
      '<div style="border-left:1px solid var(--bd5);padding-left:22px">' +
      '<div style="font:400 9px \'Space Mono\',monospace;letter-spacing:.1em;color:var(--tx6);margin-bottom:7px">UNIDADES VENDIDAS</div>' +
      '<div style="font:300 34px Outfit,Arial;letter-spacing:-.04em;color:#EE4D2D;line-height:1">' + num(C.vendas) + '</div></div></div>' +
      '<div style="display:flex;gap:26px;flex-wrap:wrap;margin-top:18px;padding-top:16px;border-top:1px solid var(--bd5)">' +
      celula(C.itens.length, 'PRODUTOS LIDOS') +
      celula(C.comVenda, 'COM VENDA NO MÊS') +
      celula(C.vendas ? reais(C.fat / C.vendas) : '—', 'TICKET MÉDIO') +
      '</div></div>';

    h += '<div class="aviso">Foram lidos os <b>' + C.itens.length + '</b> produtos mais vendidos da loja. ' +
      'Se ela tiver mais que isso, o faturamento real é maior.</div>';

    if (ord.length) {
      h += olho('O QUE ELA MAIS VENDE');
      h += '<div class="tab"><table><tr><th>PRODUTO</th><th class="num">VENDE/MÊS</th>' +
        '<th class="num">PREÇO</th><th class="num">FATURA</th></tr>';
      ord.slice(0, 15).forEach(function (y) {
        h += '<tr><td><b>' + sigTitulo(y.nome, 46) + '</b>' +
          (y.link && !E.gravando ? ' <a href="' + y.link + '" target="_blank" rel="noopener" style="font-size:12px">↗</a>' : '') + '</td>' +
          '<td class="num">' + num(y.mes) + '</td>' +
          '<td class="num">' + reais(y.preco) + '</td>' +
          '<td class="num">' + (y.fatMes != null ? reaisCurto(y.fatMes) : '—') + '</td></tr>';
      });
      h += '</table></div>';
    }
    return h;
  }

  function viewConsultor() {
    var h = olho('O QUE ESTES NÚMEROS DIZEM',
      'A leitura le os numeros que ja estao na tela e diz o que fazer com eles. As contas continuam sendo do sistema \u2014 a IA nao calcula, porque conta errada ninguem confere.');

    if (E.consultando) {
      return h + '<div class="vazio">Lendo o mercado...</div>';
    }
    if (!E.consulta) {
      h += '<div class="nota">Ela vai olhar a concentracao, a faixa de preco, o que os campeoes fazem de diferente, ' +
        'quanto da para pagar pelo produto, e onde voce esta \u2014 e dizer se vale entrar, por qual preco, e o que copiar.</div>';
      h += '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:6px">' +
        '<button class="go" id="pedir-leitura">Pedir a leitura</button>' +
        '<button class="sec" id="baixar-relatorio">Gerar relatorio completo</button></div>';
      if (E.consultaErro) {
        h += '<div class="nota" style="color:#D64545">Nao consegui: ' + esc(E.consultaErro) + '</div>';
      }
      return h;
    }

    // o texto vem em markdown simples; converte o basico
    var txt = esc(E.consulta)
      .replace(/^### (.+)$/gm, '<div class="olho">$1</div>')
      .replace(/^## (.+)$/gm, '<div style="font:600 18px Archivo,Arial;letter-spacing:-.02em;margin:22px 0 10px">$1</div>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/^- (.+)$/gm, '<div style="padding-left:14px;position:relative"><span style="position:absolute;left:0;color:#EE4D2D">\u00b7</span>$1</div>')
      .replace(/\n\n/g, '<br><br>');
    h += '<div style="font-size:15px;line-height:1.7;color:var(--tx1)">' + txt + '</div>';
    h += '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:20px">' +
      '<button class="go" id="baixar-relatorio">Gerar relatorio completo</button>' +
      '<button class="sec" id="pedir-leitura">Ler de novo</button></div>';
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
      card(num(meuMes), 'SUAS VENDAS/MÊS') +
      card(reais(meuFat), 'SEU FATURAMENTO') +
      card(num(R.faturamento ? (meuFat / R.faturamento) * 100 : 0, 1) + '%', 'DA AMOSTRA') +
      '</div>';

    h += '<div class="olho">ONDE CADA UM ESTÁ</div><table>' +
      '<tr><th>SEU PRODUTO</th><th class="num">POSICAO</th><th class="num">VENDE</th><th class="num">O 1o VENDE</th><th class="num">PRECO</th></tr>';
    var lider = todos[0];
    meus.forEach(function (x) {
      var pos = todos.indexOf(x) + 1;
      h += '<tr><td><b>' + sigTitulo(x.nome, 46) + '</b></td>' +
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
    h += '<div class="olho">' + sigLoja(x.lojaNome || '') + '</div>';
    h += '<div style="font:600 20px Archivo,Arial;letter-spacing:-.02em;margin-bottom:8px">' + sigTitulo(x.nome, 90) + '</div>';
    if (x.link && !E.gravando) {
      h += '<a href="' + x.link + '" target="_blank" rel="noopener" ' +
        'style="display:inline-block;color:#EE4D2D;text-decoration:none;font-size:14px;margin-bottom:14px">' +
        'Abrir na Shopee \u2197</a>';
    }
    h += '<div class="cards">' +
      card(num(x.mes), 'VENDAS NO MÊS') +
      card(num(x.total), 'DESDE SEMPRE') +
      card(reais(x.preco), 'PRECO') +
      card(x.fatMes != null ? reais(x.fatMes) : '\u2014', 'FATURA POR MES') +
      '</div>';

    var linhas = [];
    // a Shopee nao expoe o nome da categoria profunda na busca, e so o
    // codigo nao diz nada — a linha saiu
    if (x.marca) linhas.push(['Marca', esc(x.marca)]);
    if (x.cadastro) {
      linhas.push(['Anuncio no ar ha', idade(x.cadastro) +
        ' <span style="color:var(--tx6);font-size:12px">(cadastrado em ' +
        new Date(x.cadastro * 1000).toLocaleDateString('pt-BR') + ')</span>']);
    }
    if (x.nota != null) linhas.push(['Nota', num(x.nota, 2) + (x.estrelas ? ' \u00b7 ' + num(x.estrelas.reduce(function (a, b) { return a + b; }, 0)) + ' avaliacoes' : '')]);
    if (x.curtidas != null) linhas.push(['Curtidas', num(x.curtidas)]);
    if (x.desconto) linhas.push(['Desconto', x.desconto + (x.precoAntes ? ' \u00b7 de ' + reais(x.precoAntes) : '')]);
    if (x.local) linhas.push(['Sai de', esc(x.local)]);
    linhas.push(['Anuncio', x.anuncio ? 'sim' : 'nao']);
    if (t) linhas.push(['Volume', (t.pct > 0 ? '+' : '') + num(t.pct, 0) + '% em ' + t.dias + ' dias']);

    h += '<div class="olho">O QUE SE SABE</div><table>';
    linhas.forEach(function (l) {
      h += '<tr><td style="color:var(--tx3);width:34%">' + l[0] + '</td><td><b>' + l[1] + '</b></td></tr>';
    });
    h += '</table>';

    // ritmo: quanto vende por dia de vida
    if (x.total && x.cadastro) {
      var dias = Math.max(1, Math.round((Date.now() / 1000 - x.cadastro) / 86400));
      var porDia = x.total / dias;
      var agora = (x.mes || 0) / 30;
      h += '<div class="olho">ESTÁ ACELERANDO OU CAINDO?</div>';
      h += '<div class="nota">Desde que o anuncio foi criado, vende <b>' + num(porDia, 1) + '</b> por dia na media. ' +
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
      h += '<div class="olho">O QUE OS COMPRADORES DIZEM</div>';
      h += '<div class="barra">';
      for (var e = 5; e >= 1; e--) {
        var q = x.estrelas[e] || 0;
        var cor = e >= 4 ? '#1F8A5F' : e === 3 ? '#C98A1E' : '#D64545';
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
    var bl = $('ir-link');
    if (bl) bl.addEventListener('click', function () {
      var v = $('campo-link');
      if (v && v.value.trim() && !E.buscando) { E.linkDigitado = v.value.trim(); consultarLink(v.value.trim()); }
    });
    var cl = $('campo-link');
    if (cl) cl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && this.value.trim() && !E.buscando) { E.linkDigitado = this.value.trim(); consultarLink(this.value.trim()); }
    });
    var pl = $('pedir-leitura');
    if (pl) pl.addEventListener('click', consultar);
    var br = $('baixar-relatorio');
    if (br) br.addEventListener('click', gerarRelatorio);
    raiz.querySelectorAll('.aba[data-aba]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (this.classList.contains('off')) return;
        E.aba = this.getAttribute('data-aba'); E.detalhe = null; desenhar();
      });
    });
  }

  $('abrir').addEventListener('click', function () { $('painel').classList.toggle('on'); });
  $('tema').addEventListener('click', function () {
    var r = $('tudo');
    var escuro = r.classList.toggle('escuro');
    this.innerHTML = escuro ? ICO_SOL : ICO_LUA;
    guardar('tema', escuro ? 'escuro' : 'claro');
  });
  $('fechar').addEventListener('click', function () { $('painel').classList.remove('on'); });

  $('ir').addEventListener('click', function () {
    var t = $('termo').value.trim();
    try { console.log('[Mercado] clique no Analisar. termo:', t, '| ja buscando:', E.buscando); } catch (e) { }
    if (t && !E.buscando) analisar(t);
  });
  raiz.addEventListener('click', function (ev) {
    var alvo = ev.target.closest ? ev.target.closest('button') : ev.target;
    if (!alvo) return;
    if (alvo.id === 'zerar') {
      if (E.itens.length && !confirm('Limpar esta análise e começar do zero?')) return;
      E.termo = ''; E.itens = []; E.erro = null; E.detalhe = null; E.aba = 'nicho';
      E.consulta = null; E.consultaErro = null; E.fotoDescricao = null;
      E.variacoes = []; E.paginasLidas = 0; E.quando = null; E.calc = null;
      var campo0 = $('termo');
      if (campo0) { campo0.value = ''; campo0.focus(); }
      guardar('ultima_analise', '');
      desenhar();
      return;
    }
    if (alvo.id === 'gravar') {
      E.gravando = !E.gravando;
      $('gravar').classList.toggle('ligado', E.gravando);
      guardar('gravando', E.gravando ? '1' : '');
      desenhar();
      return;
    }
    if (alvo.id === 'ampliar') { E.ampliar = !E.ampliar; desenhar(); return; }
    if (alvo.id === 'por-foto') { $('foto').click(); return; }
  });
  raiz.addEventListener('change', function (ev) {
    if (ev.target.id === 'sel-pg') E.paginas = parseInt(ev.target.value, 10) || 3;
  });
  $('foto').addEventListener('change', function () {
    if (this.files && this.files[0]) lerFoto(this.files[0]);
    this.value = '';
  });
  $('termo').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var t = this.value.trim(); if (t && !E.buscando) analisar(t); }
  });
  try {
    chrome.runtime.onMessage.addListener(function (m) {
      if (m && m.tipo === 'mercado:abrir') $('painel').classList.toggle('on');
    });
  } catch (e) { }

  ler('gravando').then(function (v) {
    if (v) { E.gravando = true; $('gravar').classList.add('ligado'); desenhar(); }
  });
  ler('tema').then(function (v) {
    if (v === 'escuro') { $('tudo').classList.add('escuro'); $('tema').innerHTML = ICO_SOL; }
  });

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
  console.log('[Radar 360] v' + VERSAO + ' pronto.');
})();

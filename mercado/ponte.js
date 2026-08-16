/**
 * Seller.IA Mercado · a ponte
 *
 * Roda no mundo da PAGINA, e nao no da extensao. E o unico lugar de onde
 * a chamada sai com a assinatura que a Shopee exige — do service worker
 * ela devolve erro 90309999, error_not_found.
 *
 * Nao decide nada: recebe um pedido, chama, devolve o que veio.
 */
(function () {
  'use strict';

  /* ============ ESCUTA O SHOPID ============
     O problema de sempre foi traduzir o nome da loja em id: nenhuma rota
     da Shopee faz isso de forma confiavel, e eu tentei tres.

     Mas quando a pessoa ABRE a pagina da loja, a propria Shopee faz varias
     chamadas com o shopid dentro — get_shop_seo, is_show, get_categories,
     search_items. Nao precisamos perguntar o id a ninguem: basta escutar o
     que a pagina ja pede.

     Isto e o mesmo principio da Seller.IA: nao fabricamos chamada, so
     ouvimos a conversa que ja acontece. */
  var SIA_LOJA_VISTA = null;

  function anotarLoja(url) {
    try {
      var s = String(url || '');
      if (s.indexOf('shopee.com.br') < 0 && s.charAt(0) !== '/') return;
      var m = s.match(/[?&]shopid=(\d{6,12})/) || s.match(/[?&]shop_id=(\d{6,12})/);
      if (!m) return;
      var id = m[1];
      // ids de 11+ digitos sao de produto, nao de loja
      if (id.length > 10) return;
      if (SIA_LOJA_VISTA === id) return;
      SIA_LOJA_VISTA = id;
      window.dispatchEvent(new CustomEvent('SIA_MK_LOJA', {
        detail: JSON.stringify({ shopid: id, url: location.href })
      }));
    } catch (e) { /* noop */ }
  }

  // fetch
  try {
    var _fetch = window.fetch;
    window.fetch = function (entrada, opcoes) {
      try { anotarLoja(typeof entrada === 'string' ? entrada : (entrada && entrada.url)); } catch (e) { }
      return _fetch.apply(this, arguments);
    };
  } catch (e) { /* noop */ }

  // XHR: a Shopee usa os dois
  try {
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (metodo, url) {
      try { anotarLoja(url); } catch (e) { }
      return _open.apply(this, arguments);
    };
  } catch (e) { /* noop */ }

  // quando o painel pergunta "que loja e esta?"
  window.addEventListener('SIA_MK_QUAL_LOJA', function () {
    window.dispatchEvent(new CustomEvent('SIA_MK_LOJA', {
      detail: JSON.stringify({ shopid: SIA_LOJA_VISTA, url: location.href })
    }));
  });



  window.addEventListener('SIA_MK_PEDE', function (ev) {
    var p;
    try { p = JSON.parse(ev.detail); } catch (e) { return; }
    if (!p || !p.url) return;

    function responder(r) {
      r.id = p.id;
      try {
        window.dispatchEvent(new CustomEvent('SIA_MK_RESP', { detail: JSON.stringify(r) }));
      } catch (e) {
        // resposta gigante que nao serializa: devolve o essencial
        try {
          window.dispatchEvent(new CustomEvent('SIA_MK_RESP', {
            detail: JSON.stringify({ id: p.id, ok: false, erro: 'resposta muito grande' })
          }));
        } catch (e2) { /* noop */ }
      }
    }

    /* A BUSCA E SEMPRE NA VITRINE, e a ponte pode estar rodando no painel
       do vendedor. Sao dominios diferentes: chamar shopee.com.br a partir
       do seller.shopee.com.br e bloqueado por CORS pelo navegador.

       Quando isso acontece, o pedido volta com um aviso para o outro lado
       repassar ao service worker, que nao tem essa restricao. */
    var alvo = /^https?:/.test(p.url) ? p.url : ('https://shopee.com.br' + p.url);
    var souVitrine = location.hostname === 'shopee.com.br' || location.hostname === 'www.shopee.com.br';
    if (!souVitrine && alvo.indexOf('https://shopee.com.br') === 0) {
      responder({ ok: false, erro: 'outro-dominio' });
      return;
    }

    // fetch da propria pagina: leva os cookies e a assinatura dela
    fetch(alvo, {
      method: p.metodo || 'GET',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: p.corpo || undefined
    })
      .then(function (r) {
        return r.json()
          .then(function (d) { responder({ ok: r.ok, status: r.status, dados: d }); })
          .catch(function () { responder({ ok: false, status: r.status, erro: 'resposta nao e json' }); });
      })
      .catch(function (e) {
        responder({ ok: false, erro: String(e && e.message || e) });
      });
  });

  try { console.log('[Mercado ponte] pronta no contexto da pagina.'); } catch (e) { }
})();

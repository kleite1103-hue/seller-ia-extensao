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

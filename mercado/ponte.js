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

    // URL absoluta: caminho relativo depende da pagina atual, e a pessoa
    // pode estar na vitrine ou no painel do vendedor, que sao dominios
    // diferentes. A busca e sempre na vitrine.
    var alvo = /^https?:/.test(p.url) ? p.url : ('https://shopee.com.br' + p.url);

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

/**
 * Analista de Mercado · service worker
 * Faz as chamadas com a sessao da pessoa e guarda o historico de volume.
 */

chrome.runtime.onInstalled.addListener(function () {
  console.log('[Mercado] instalado. Abra a Shopee e clique no icone.');
});

chrome.runtime.onMessage.addListener(function (msg, remetente, responder) {
  if (!msg || !msg.tipo) return;

  /* PLANO B: quando a pessoa esta no painel do vendedor, a ponte nao pode
     chamar a vitrine — dominios diferentes, o navegador bloqueia por CORS.
     O service worker nao tem essa restricao, entao ele assume.

     A resposta pode vir sem a assinatura da vitrine e a Shopee recusar;
     nesse caso a tela pede para abrir a vitrine, que e onde funciona. */
  if (msg.tipo === 'mercado:buscar') {
    var alvo = /^https?:/.test(msg.url) ? msg.url : ('https://shopee.com.br' + msg.url);
    console.log('[Mercado bg] plano B, chamando:', alvo.slice(0, 100));
    fetch(alvo, {
      method: msg.metodo || 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-api-source': 'pc',
        'x-shopee-language': 'pt-BR',
        'x-requested-with': 'XMLHttpRequest',
        'Referer': 'https://shopee.com.br/'
      },
      body: msg.corpo || undefined
    })
      .then(function (r) {
        return r.json()
          .then(function (d) { return { ok: r.ok, status: r.status, dados: d }; })
          .catch(function () { return { ok: false, status: r.status, erro: 'resposta nao e json' }; });
      })
      .then(function (r) {
        var qtd = 0;
        try { qtd = (r.dados.items || (r.dados.data && r.dados.data.items) || []).length; } catch (e) { }
        console.log('[Mercado bg] status', r.status, '| itens', qtd,
          r.dados && r.dados.error ? ('| ERRO ' + r.dados.error) : '');
        responder(r);
      })
      .catch(function (e) {
        console.error('[Mercado bg] falhou:', e);
        responder({ ok: false, erro: String(e && e.message || e) });
      });
    return true;
  }


  // ---- historico ----
  if (msg.tipo === 'mercado:guardar') {
    var o = {}; o[msg.chave] = msg.valor;
    chrome.storage.local.set(o, function () { responder({ ok: true }); });
    return true;
  }
  if (msg.tipo === 'mercado:ler') {
    chrome.storage.local.get([msg.chave], function (r) {
      responder({ ok: true, valor: r ? r[msg.chave] : null });
    });
    return true;
  }
});

chrome.action.onClicked.addListener(function (aba) {
  if (!aba || !aba.id) return;
  chrome.tabs.sendMessage(aba.id, { tipo: 'mercado:abrir' }, function () {
    void chrome.runtime.lastError;
  });
});

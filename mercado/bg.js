/**
 * Analista de Mercado · service worker
 * Faz as chamadas com a sessao da pessoa e guarda o historico de volume.
 */

chrome.runtime.onInstalled.addListener(function () {
  console.log('[Mercado] instalado. Abra a Shopee e clique no icone.');
});

chrome.runtime.onMessage.addListener(function (msg, remetente, responder) {
  if (!msg || !msg.tipo) return;

  // ---- chamada a Shopee, com os cookies da pessoa ----
  if (msg.tipo === 'mercado:buscar') {
    fetch('https://shopee.com.br' + msg.url, {
      method: msg.metodo || 'GET',
      credentials: 'include',
      // Cabecalhos que a vitrine manda. O af-ac-enc-dat vazio e proposital:
      // a Shopee aceita, e mandar um valor inventado seria pior.
      headers: {
        'Content-Type': 'application/json',
        'x-api-source': 'pc',
        'x-shopee-language': 'pt-BR',
        'x-requested-with': 'XMLHttpRequest',
        'af-ac-enc-dat': 'null',
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
        // a Shopee responde 200 com error dentro; sem olhar isso o erro
        // aparece como "sem resultado" e a pessoa nao sabe o motivo
        if (r.dados && r.dados.error) {
          console.warn('[Mercado] Shopee devolveu erro', r.dados.error, r.dados.error_msg || '');
        }
        responder(r);
      })
      .catch(function (e) { responder({ ok: false, erro: String(e && e.message || e) }); });
    return true;   // resposta assincrona
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

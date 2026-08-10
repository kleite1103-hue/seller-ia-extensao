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
      headers: {
        'Content-Type': 'application/json',
        'af-ac-enc-dat': '',
        'x-api-source': 'pc',
        'x-shopee-language': 'pt-BR',
        'x-requested-with': 'XMLHttpRequest'
      },
      body: msg.corpo || undefined
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, dados: d }; }); })
      .then(function (r) { responder(r); })
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

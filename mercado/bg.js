/**
 * Analista de Mercado · service worker
 * Faz as chamadas com a sessao da pessoa e guarda o historico de volume.
 */

chrome.runtime.onInstalled.addListener(function () {
  console.log('[Mercado] instalado. Abra a Shopee e clique no icone.');
});

chrome.runtime.onMessage.addListener(function (msg, remetente, responder) {
  if (!msg || !msg.tipo) return;

  // A chamada a Shopee NAO passa mais por aqui: do service worker ela
  // devolve erro 90309999, porque falta a assinatura que so o codigo da
  // pagina monta. Quem chama e a ponte, no mundo da pagina.

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

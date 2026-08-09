/**
 * Radar Shopee · service worker
 * Nao faz quase nada de proposito: o radar so escuta, e escutar
 * acontece na propria pagina.
 */
chrome.runtime.onInstalled.addListener(function () {
  console.log('[Radar Shopee] instalado. Abra a Central do Vendedor e navegue.');
});

chrome.action.onClicked.addListener(function (aba) {
  if (!aba || !aba.id) return;
  chrome.tabs.sendMessage(aba.id, { tipo: 'radar:abrir' }, function () {
    void chrome.runtime.lastError;
  });
});

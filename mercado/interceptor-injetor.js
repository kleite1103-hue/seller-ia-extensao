/**
 * Radar Shopee · injetor
 * Coloca o interceptor no mundo da pagina, que e o unico lugar onde
 * da para escutar fetch e XHR da Shopee.
 */
(function () {
  'use strict';
  try {
    var s = document.createElement('script');
    s.src = chrome.runtime.getURL('interceptor.js');
    s.onload = function () { this.remove(); };
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* pagina sem permissao: ignora */ }
})();

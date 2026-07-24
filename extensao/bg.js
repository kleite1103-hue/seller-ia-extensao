/**
 * Seller.IA — bg.js (service worker) · v0.1.0
 * Na beta interna: apenas persistencia local da coleta normalizada,
 * para o painel sobreviver a recarregamentos de pagina.
 * Etapa 2 conecta licenca + cerebro aqui. Nenhum segredo neste arquivo.
 */
function ler(chaves) { return new Promise(function (r) { chrome.storage.local.get(chaves, r); }); }
function gravar(obj) { return new Promise(function (r) { chrome.storage.local.set(obj, r); }); }

chrome.runtime.onMessage.addListener(function (msg, remetente, responder) {
  if (!msg || !msg.tipo) return;

  if (msg.tipo === 'sia:salvar') {
    gravar({ sia_coleta: msg.coleta, sia_coleta_ts: Date.now() }).then(function () {
      responder({ ok: true });
    });
    return true;
  }

  if (msg.tipo === 'sia:carregar') {
    ler(['sia_coleta', 'sia_coleta_ts']).then(function (v) {
      responder({ ok: true, coleta: v.sia_coleta || null, ts: v.sia_coleta_ts || null });
    });
    return true;
  }

  if (msg.tipo === 'sia:limpar') {
    gravar({ sia_coleta: null, sia_coleta_ts: null }).then(function () {
      responder({ ok: true });
    });
    return true;
  }
});

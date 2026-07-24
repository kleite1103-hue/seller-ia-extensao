/**
 * Seller.IA — bg.js (service worker) · v0.6.0
 * Persistencia local + ponte com o Cerebro (Supabase Edge Function).
 * A chave abaixo e a ANON key (publica por desenho); as regras e os
 * segredos reais vivem no servidor. Licenciamento entra na Etapa 4.
 */
var SIA_CEREBRO_URL = 'https://mkfreezlizdbfpjjpxoo.supabase.co/functions/v1/cerebro';
var SIA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZnJlZXpsaXpkYmZwampweG9vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5MTczMTcsImV4cCI6MjEwMDQ5MzMxN30.ZavM7iPnecJdIfEyUMfStcShUEMjlUZf5GKfDaQ7zxQ';

function ler(chaves) { return new Promise(function (r) { chrome.storage.local.get(chaves, r); }); }
function gravar(obj) { return new Promise(function (r) { chrome.storage.local.set(obj, r); }); }

async function analisar(payload) {
  try {
    var r = await fetch(SIA_CEREBRO_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + SIA_ANON,
        'apikey': SIA_ANON
      },
      body: JSON.stringify(payload)
    });
    var data = null;
    try { data = await r.json(); } catch (e) { /* noop */ }
    if (!r.ok) return { ok: false, erro: (data && data.erro) || ('HTTP ' + r.status) };
    return data;
  } catch (e) {
    return { ok: false, erro: 'Cerebro Seller.IA indisponivel. Verifique a conexao.' };
  }
}

chrome.runtime.onMessage.addListener(function (msg, remetente, responder) {
  if (!msg || !msg.tipo) return;

  if (msg.tipo === 'sia:salvar') {
    // FUSAO: abas diferentes somam, nunca se apagam
    ler(['sia_coleta']).then(function (v) {
      var antigo = v.sia_coleta || {};
      var novo = msg.coleta || {};
      function fundirMapa(a, b) {
        var r = a || {};
        for (var k in (b || {})) {
          if (!r[k]) { r[k] = b[k]; continue; }
          var ra = r[k], rb = b[k];
          if (ra && rb && typeof ra === 'object' && typeof rb === 'object') {
            if ((rb.visto_em || 0) >= (ra.visto_em || 0)) {
              var met = Object.assign({}, ra.metricas || {}, rb.metricas || {});
              r[k] = Object.assign({}, ra, rb);
              r[k].metricas = met;
            } else {
              var met2 = Object.assign({}, rb.metricas || {}, ra.metricas || {});
              r[k] = Object.assign({}, rb, ra);
              r[k].metricas = met2;
            }
          } else r[k] = rb;
        }
        return r;
      }
      function fundirPainel(a, b) {
        a = a || { campos: {} }; b = b || { campos: {} };
        return {
          campos: Object.assign({}, a.campos || {}, b.campos || {}),
          atualizadoEm: Math.max(a.atualizadoEm || 0, b.atualizadoEm || 0) || null
        };
      }
      var fundido = {
        versao: novo.versao || antigo.versao,
        gerado_em: new Date().toISOString(),
        pagina: novo.pagina || antigo.pagina,
        loja: novo.loja || antigo.loja,
        periodo_ads: novo.periodo_ads || antigo.periodo_ads,
        conta: fundirPainel(antigo.conta, novo.conta),
        afiliados: fundirPainel(antigo.afiliados, novo.afiliados),
        anuncio_publico: novo.anuncio_publico || antigo.anuncio_publico,
        cadastro: novo.cadastro || antigo.cadastro,
        campanhas: fundirMapa(antigo.campanhas, novo.campanhas),
        produtos: fundirMapa(antigo.produtos, novo.produtos)
      };
      gravar({ sia_coleta: fundido, sia_coleta_ts: Date.now() }).then(function () { responder({ ok: true }); });
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
    gravar({ sia_coleta: null, sia_coleta_ts: null }).then(function () { responder({ ok: true }); });
    return true;
  }
  if (msg.tipo === 'sia:analisar') {
    analisar(msg.payload).then(responder);
    return true;
  }
});

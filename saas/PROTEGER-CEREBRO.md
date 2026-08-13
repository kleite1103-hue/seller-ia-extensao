// ============================================================
// PROTEGER O CEREBRO · trecho para colar no cerebro-v2
//
// POR QUE: testei a funcao publicada e ela responde a qualquer
// um que tenha a chave anon — e a chave anon esta dentro do ZIP
// que todo assinante baixa. Ou seja, quem instalar a extensao e
// abrir o arquivo bg.js consegue chamar o cerebro por fora, de
// qualquer lugar, sem assinatura. A receita ja exige token; o
// cerebro nao exigia.
//
// O QUE FAZER: cole o bloco abaixo logo depois de ler o body,
// ANTES de qualquer processamento.
// ============================================================


// ---------- 1. no topo do arquivo, se ainda nao houver ----------
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";


// ---------- 2. logo apos ler o body ----------
// (assumindo que o body ja foi lido em uma variavel chamada `body`)

const _url = Deno.env.get("SUPABASE_URL");
const _key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!_url || !_key) {
  return new Response(JSON.stringify({ ok: false, erro: "faltam secrets" }), {
    status: 500,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
const _db = createClient(_url, _key);

// SO COM TOKEN VALIDO. Mesma regra da receita: sessao existente,
// nao encerrada e dentro do prazo.
const _token = String(body.token || "");
if (!_token) {
  return new Response(JSON.stringify({ ok: false, erro: "sem token" }), {
    status: 401,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

const { data: _sessao } = await _db.from("sia_sessoes")
  .select("usuario_id, encerrada_em, expira_em")
  .eq("token", _token)
  .maybeSingle();

if (!_sessao || _sessao.encerrada_em ||
    (_sessao.expira_em && new Date(_sessao.expira_em) < new Date())) {
  return new Response(JSON.stringify({ ok: false, erro: "sessao invalida" }), {
    status: 401,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// daqui para baixo, segue o codigo que ja existe


// ============================================================
// E NA EXTENSAO
//
// O bg.js precisa mandar o token junto. Onde ele monta a chamada
// ao cerebro, o corpo deve incluir:
//
//   body: JSON.stringify({ token: <o token da sessao>, ...resto })
//
// Se o bg nao tiver o token em maos, ele ja e guardado no
// chrome.storage pela portaria — basta ler antes de chamar.
// ============================================================

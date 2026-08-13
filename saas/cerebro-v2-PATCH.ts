// ============================================================
// CEREBRO v2 · TRECHO CORRIGIDO
//
// Substitua o bloco `Deno.serve(...)` do inicio pelo que esta
// abaixo. O resto do arquivo continua igual — nao mexa em mais
// nada.
//
// COMO ACHAR: procure por `Deno.serve(async (req) => {`. Ele
// esta perto do fim do arquivo, logo depois de `function json`.
//
// O QUE MUDA: entre a criacao do `supa` e a linha
// `let K: any;` entram 20 linhas que exigem token de sessao.
// ============================================================


// ---------- APAGUE ISTO ----------
//
// Deno.serve(async (req) => {
//   if (req.method === "OPTIONS") return json({ ok: true });
//   if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);
//
//   let body: any;
//   try { body = await req.json(); } catch { return json({ ok: false, erro: "json invalido" }, 400); }
//
//   const supa = createClient(
//     Deno.env.get("SUPABASE_URL")!,
//     Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
//   );


// ---------- COLE ISTO NO LUGAR ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, erro: "json invalido" }, 400); }

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  /* ==================== SO COM ASSINATURA ====================
     Esta funcao respondia a qualquer um que tivesse a chave anon — e a
     chave anon vai dentro do ZIP que todo assinante baixa. Bastava abrir
     o pacote, copiar a linha do bg.js e chamar daqui de fora, sem pagar
     nada, para o metodo inteiro rodar.

     Mesma regra da receita: sessao que existe, nao foi encerrada e ainda
     esta no prazo. A extensao ja manda o token junto do payload. */
  const token = String(body.token || "");
  if (!token) return json({ ok: false, erro: "sem token" }, 401);

  const { data: sessao } = await supa
    .from("sia_sessoes")
    .select("usuario_id, encerrada_em, expira_em")
    .eq("token", token)
    .maybeSingle();

  if (!sessao) return json({ ok: false, erro: "sessao invalida" }, 401);
  if (sessao.encerrada_em) return json({ ok: false, erro: "sessao encerrada em outra maquina" }, 401);
  if (sessao.expira_em && new Date(sessao.expira_em) < new Date()) {
    return json({ ok: false, erro: "sessao expirada" }, 401);
  }


// ---------- DAQUI PARA BAIXO NAO MUDA NADA ----------
//
//   let K: any;
//   try { K = await carregarConhecimento(supa); }
//   ... (o resto do arquivo continua exatamente como esta)


// ============================================================
// DEPOIS DE PUBLICAR, CONFIRA
//
// Rode isto no terminal. Deve devolver 401:
//
//   curl -s -X POST \
//     "https://mkfreezlizdbfpjjpxoo.supabase.co/functions/v1/cerebro-v2" \
//     -H "Content-Type: application/json" \
//     -H "Authorization: Bearer <a chave anon do bg.js>" \
//     -d '{}'
//
// Se voltar {"ok":false,"erro":"sem token"}, esta fechado.
// Se voltar {"ok":true,...}, o deploy nao pegou.
//
// E teste a extensao logo em seguida: ela precisa continuar
// analisando normalmente, porque agora manda o token junto.
// ============================================================

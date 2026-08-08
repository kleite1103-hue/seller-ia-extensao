// ============================================================
// SELLER.IA · EMAIL
// Boas-vindas, recuperacao de acesso e avisos de assinatura.
// Usa Resend, que entrega bem e nao e o SMTP gratuito que cai
// na caixa de spam.
//
// Publicar como funcao "email", Verify JWT DESLIGADO.
// Secret necessaria: RESEND_API_KEY
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
}

const DE = "Seller.IA <acesso@selleriaclub.com>";
const SITE = "https://selleriaclub.com";

// ---------- molde comum ----------
function molde(titulo: string, corpo: string, botao?: { texto: string; link: string }): string {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo}</title></head>
<body style="margin:0;padding:0;background:#F7F3EC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F3EC;padding:32px 16px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:22px;overflow:hidden;box-shadow:0 6px 24px rgba(72,56,38,.10)">

<tr><td style="padding:28px 32px 20px;border-bottom:1px solid #EDE6D9">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="width:42px;height:42px;background:#1C1A17;border-radius:14px;text-align:center;vertical-align:middle;color:#FBF8F3;font-size:24px;font-weight:600">S<span style="color:#EE4D2D">.</span></td>
    <td style="padding-left:12px;font-size:21px;font-weight:600;color:#000">Seller<span style="color:#EE4D2D">.</span>ia</td>
  </tr></table>
</td></tr>

<tr><td style="padding:30px 32px 26px">
  <h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#000;font-weight:600;letter-spacing:-.02em">${titulo}</h1>
  <div style="font-size:15.5px;line-height:1.65;color:#241F18">${corpo}</div>
  ${botao ? `<div style="margin-top:26px"><a href="${botao.link}" style="display:inline-block;background:#E63E1B;color:#fff;text-decoration:none;font-size:15.5px;font-weight:600;padding:14px 30px;border-radius:14px">${botao.texto}</a></div>` : ""}
</td></tr>

<tr><td style="padding:20px 32px 26px;border-top:1px solid #EDE6D9;font-size:13px;line-height:1.6;color:#6B6355">
  Seller.IA &middot; Efeito Vendas<br>
  Duvidas? Responda este email que a gente le.
</td></tr>

</table></td></tr></table></body></html>`;
}

async function enviar(para: string, assunto: string, html: string, tipo: string, db: any) {
  const chave = Deno.env.get("RESEND_API_KEY");
  if (!chave) {
    await db?.from("sia_emails").insert({ para, tipo, assunto, ok: false, erro: "falta RESEND_API_KEY" });
    return { ok: false, erro: "falta a secret RESEND_API_KEY na funcao" };
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: DE, to: [para], subject: assunto, html }),
  });
  const ok = r.ok;
  const txt = ok ? null : await r.text();
  await db?.from("sia_emails").insert({ para, tipo, assunto, ok, erro: txt?.slice(0, 300) || null });
  return ok ? { ok: true } : { ok: false, erro: txt };
}

Deno.serve(async (req) => {
  try { return await atender(req); }
  catch (e) { return json({ ok: false, erro: String((e as Error)?.message || e) }, 500); }
});

async function atender(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
  if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const db = (url && key) ? createClient(url, key) : null;

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, erro: "json invalido" }, 400); }
  const tipo = String(body.tipo || "");
  const para = String(body.email || "").trim().toLowerCase();
  if (!para.includes("@")) return json({ ok: false, erro: "email invalido" }, 400);

  // ---------- BOAS-VINDAS ----------
  if (tipo === "boas_vindas") {
    const nome = body.nome ? String(body.nome).split(" ")[0] : "";
    const html = molde(
      nome ? `Bem-vinda, ${nome}` : "Seu acesso esta liberado",
      `<p style="margin:0 0 14px">A Seller.IA le a sua conta Shopee por dentro e diz onde o dinheiro esta indo embora — campanha por campanha, produto por produto.</p>
       <p style="margin:0 0 14px"><b>Para comecar, tres passos:</b></p>
       <ol style="margin:0 0 14px;padding-left:20px">
         <li style="margin-bottom:8px">Instale a extensao no Chrome pelo botao abaixo.</li>
         <li style="margin-bottom:8px">Abra o Seller Centre da Shopee e faca login.</li>
         <li>Clique no icone da Seller.IA e entre com <b>${para}</b>.</li>
       </ol>
       <p style="margin:0;color:#4A443A">Seu acesso vale para <b>uma maquina por vez</b>. Se entrar em outra, a primeira e encerrada.</p>`,
      { texto: "Instalar a extensao", link: `${SITE}/instalar` }
    );
    return json(await enviar(para, "Seu acesso a Seller.IA esta pronto", html, tipo, db));
  }

  // ---------- RECUPERAR ACESSO ----------
  if (tipo === "recuperar") {
    const codigo = String(Math.floor(100000 + Math.random() * 900000));
    if (db) {
      await db.from("sia_usuarios").update({
        token_recuperar: codigo,
        token_expira: new Date(Date.now() + 30 * 60000).toISOString(),
      }).ilike("email", para);
    }
    const html = molde(
      "Seu codigo de acesso",
      `<p style="margin:0 0 20px">Use este codigo para entrar na Seller.IA. Ele vale por 30 minutos.</p>
       <div style="background:#F7F3EC;border:1px solid #EDE6D9;border-radius:16px;padding:22px;text-align:center">
         <div style="font-family:'SF Mono',Menlo,monospace;font-size:36px;font-weight:700;letter-spacing:10px;color:#000">${codigo}</div>
       </div>
       <p style="margin:20px 0 0;color:#6B6355;font-size:14px">Se nao foi voce que pediu, ignore este email — seu acesso continua seguro.</p>`
    );
    return json(await enviar(para, `${codigo} e o seu codigo da Seller.IA`, html, tipo, db));
  }

  // ---------- ASSINATURA VENCENDO ----------
  if (tipo === "vencendo") {
    const dias = parseInt(body.dias || "3", 10);
    const html = molde(
      dias > 1 ? `Sua assinatura vence em ${dias} dias` : "Sua assinatura vence amanha",
      `<p style="margin:0 0 14px">Depois disso a Seller.IA para de ler a sua conta, e voce perde o acompanhamento no meio do mes — que e justamente quando da para corrigir.</p>
       <p style="margin:0;color:#4A443A">A renovacao e automatica se o cartao estiver em dia. Se preferir conferir, o botao abaixo leva direto.</p>`,
      { texto: "Ver minha assinatura", link: `${SITE}/assinatura` }
    );
    return json(await enviar(para, dias > 1 ? `Sua Seller.IA vence em ${dias} dias` : "Sua Seller.IA vence amanha", html, tipo, db));
  }

  // ---------- SUSPENSA ----------
  if (tipo === "suspenso") {
    const html = molde(
      "Seu acesso foi pausado",
      `<p style="margin:0 0 14px">Nao identificamos o pagamento desta renovacao, entao a Seller.IA parou de ler a sua conta.</p>
       <p style="margin:0 0 14px"><b>Seus dados continuam aqui.</b> Assim que o pagamento entrar, tudo volta exatamente como estava — historico, custos cadastrados e relatorios.</p>`,
      { texto: "Regularizar agora", link: `${SITE}/assinatura` }
    );
    return json(await enviar(para, "Seu acesso a Seller.IA foi pausado", html, tipo, db));
  }

  return json({ ok: false, erro: "tipo desconhecido", tipos: ["boas_vindas", "recuperar", "vencendo", "suspenso"] }, 400);
}

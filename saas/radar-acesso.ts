// ============================================================
// RADAR 360 · ACESSO
//
// Mesma base de usuarios da Seller.IA, assinatura separada. Quem
// assina os dois entra nos dois com o mesmo email.
//
// Publicar como funcao "radar-acesso", Verify JWT DESLIGADO.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PRODUTO = "radar360";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), {
    status: s,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function token() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
    }
    if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);

    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return json({ ok: false, erro: "faltam secrets" }, 500);
    const db = createClient(url, key);

    let body: any;
    try { body = await req.json(); } catch { return json({ ok: false, erro: "json invalido" }, 400); }
    const acao = String(body.acao || "");

    // ---------- ENTRAR ----------
    if (acao === "entrar") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!email || !email.includes("@")) return json({ ok: false, erro: "email invalido" }, 400);

      const { data: u } = await db.from("sia_usuarios")
        .select("id, email, papel, status, nome")
        .eq("email", email).maybeSingle();

      if (!u) {
        return json({
          ok: false,
          erro: "Nao encontramos este email. Confira se e o mesmo usado na compra do Radar 360.",
        }, 404);
      }

      // a mesma funcao que a Seller.IA usa, so mudando o produto
      const { data: perm } = await db.rpc("sia_pode_produto", {
        p_usuario: u.id, p_produto: PRODUTO,
      });
      const p = Array.isArray(perm) ? perm[0] : perm;

      if (!p || !p.pode) {
        const motivo = p?.motivo || "sem assinatura";
        return json({
          ok: false,
          /* O TEXTO IMPORTA AQUI. Quem chega nesta tela ja e cliente da
             Seller.IA: tratar como recusa e desperdicar a melhor hora de
             vender. Ela veio ate aqui, instalou, digitou o email — ja
             quer usar. */
          erro: motivo === "sem assinatura deste produto"
            ? "Voce ja e da casa! O Radar 360 e a nossa analise de mercado e tem assinatura propria, separada da Seller.IA. Ative com o mesmo email e comece a usar agora."
            : motivo === "assinatura vencida"
              ? "Sua assinatura do Radar 360 venceu. Renove com este mesmo email e tudo volta de onde parou."
              : motivo === "assinatura cancelada"
                ? "Sua assinatura do Radar 360 esta cancelada. Da para reativar com este mesmo email."
                : "Este email ainda nao tem acesso ao Radar 360.",
          motivo,
        }, 403);
      }

      /* UMA MAQUINA POR VEZ. Encerra as sessoes anteriores antes de abrir a
         nova: assinatura compartilhada e o vazamento mais comum, e a regra
         so vale se for aplicada de verdade. */
      await db.from("sia_sessoes")
        .update({ encerrada_em: new Date().toISOString() })
        .eq("usuario_id", u.id)
        .eq("produto_id", PRODUTO)
        .is("encerrada_em", null);

      const tok = token();
      const expira = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      await db.from("sia_sessoes").insert({
        usuario_id: u.id, produto_id: PRODUTO, token: tok,
        dispositivo: String(body.dispositivo || "").slice(0, 120),
        expira_em: expira,
      });

      return json({
        ok: true, token: tok, expira_em: expira,
        usuario: { email: u.email, nome: u.nome, papel: u.papel },
        vence_em: p.vence_em || null,
      });
    }

    // ---------- VALIDAR (a cada abertura) ----------
    if (acao === "validar") {
      const tok = String(body.token || "");
      if (!tok) return json({ ok: false, erro: "sem token" }, 401);

      const { data: s } = await db.from("sia_sessoes")
        .select("usuario_id, encerrada_em, expira_em")
        .eq("token", tok).eq("produto_id", PRODUTO).maybeSingle();

      if (!s) return json({ ok: false, erro: "sessao invalida", recomecar: true }, 401);
      if (s.encerrada_em) {
        return json({
          ok: false, recomecar: true,
          erro: "Sua conta foi aberta em outra maquina. O acesso vale para uma por vez.",
        }, 401);
      }
      if (s.expira_em && new Date(s.expira_em) < new Date()) {
        return json({ ok: false, erro: "sessao expirada", recomecar: true }, 401);
      }

      // a assinatura pode ter vencido depois do login
      const { data: perm } = await db.rpc("sia_pode_produto", {
        p_usuario: s.usuario_id, p_produto: PRODUTO,
      });
      const p = Array.isArray(perm) ? perm[0] : perm;
      if (!p || !p.pode) {
        return json({ ok: false, erro: "Assinatura do Radar 360 sem acesso.", motivo: p?.motivo, recomecar: true }, 403);
      }

      const { data: u } = await db.from("sia_usuarios")
        .select("email, nome, papel").eq("id", s.usuario_id).maybeSingle();

      return json({ ok: true, usuario: u, vence_em: p.vence_em || null });
    }

    // ---------- SAIR ----------
    if (acao === "sair") {
      const tok = String(body.token || "");
      if (tok) {
        await db.from("sia_sessoes")
          .update({ encerrada_em: new Date().toISOString() })
          .eq("token", tok);
      }
      return json({ ok: true });
    }

    // ---------- WEBHOOK DO CHECKOUT ----------
    // Chamado pela plataforma de pagamento. Cria o usuario se nao existir e
    // liga a assinatura do produto certo pelo codigo da oferta.
    /* ---------- WEBHOOK DA HOTMART ----------
       Aceita tanto o formato da Hotmart quanto uma chamada simples com
       email e evento, para dar para liberar na mao quando precisar.

       A Hotmart NAO manda {email, evento}: ela manda o comprador dentro de
       data.buyer e o tipo em event, com nomes como PURCHASE_APPROVED. Ler
       body.email direto funcionaria no meu teste e falharia em toda compra
       real — foi assim que a Seller.IA ja aprendeu. */
    if (acao === "webhook" || acao === "hotmart" || req.headers.get("x-hotmart-hottok")) {
      /* VALIDA A ORIGEM ANTES DE QUALQUER COISA. Sem isto, qualquer pessoa
         que soubesse o endereco liberava acesso para o email que quisesse —
         testei e um email inventado entrou no Radar sem compra nenhuma.

         Enquanto o segredo nao estiver configurado, o webhook fica FECHADO
         em vez de aberto: liberar por engano custa mais que recusar. */
      const segredo = Deno.env.get("HOTMART_HOTTOK");
      const veio = req.headers.get("x-hotmart-hottok") || body.hottok;
      if (!segredo) {
        return json({ ok: false, erro: "webhook sem segredo configurado" }, 503);
      }
      if (veio !== segredo) {
        return json({ ok: false, erro: "origem nao reconhecida" }, 401);
      }

      const d = body.data || body;
      const comprador = d.buyer || d.subscriber || {};
      const email = String(comprador.email || d.email || body.email || "").trim().toLowerCase();
      const nome = comprador.name || d.name || null;
      const evt = String(body.event || d.event || body.evento || "").toUpperCase();

      // o codigo da oferta diz QUAL produto foi comprado
      const oferta = String(
        d.purchase?.offer?.code || d.offer?.code ||
        body.codigo_oferta || body.oferta || ""
      );

      if (!email) return json({ ok: false, erro: "webhook sem email" }, 400);

      const LIBERA = ["PURCHASE_APPROVED", "PURCHASE_COMPLETE",
        "SUBSCRIPTION_REACTIVATION", "PURCHASE_PROTEST_REVERSED", "COMPRA"];
      const SUSPENDE = ["PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK",
        "PURCHASE_CANCELED", "SUBSCRIPTION_CANCELLATION", "CANCELAMENTO"];

      // evento que nao libera nem suspende (boleto impresso, compra atrasada)
      if (evt && LIBERA.indexOf(evt) < 0 && SUSPENDE.indexOf(evt) < 0) {
        return json({ ok: true, acao: "ignorado", evento: evt });
      }

      /* A OFERTA DECIDE O PRODUTO. Sem ela cadastrada, nao da para saber se
         a compra foi do Radar ou da Seller.IA — e chutar liberaria o produto
         errado, que e pior que nao liberar. */
      const { data: of } = await db.from("sia_ofertas")
        .select("produto_id, meses").eq("codigo", oferta).eq("ativo", true).maybeSingle();

      if (!of && oferta) {
        return json({
          ok: false,
          erro: "oferta nao cadastrada: " + oferta,
          dica: "cadastre em sia_ofertas dizendo a que produto ela corresponde",
        }, 400);
      }
      const produto = of?.produto_id || PRODUTO;
      const meses = of?.meses || 1;

      let { data: u } = await db.from("sia_usuarios").select("id").eq("email", email).maybeSingle();
      if (!u) {
        const { data: novo } = await db.from("sia_usuarios")
          .insert({ email, nome, papel: "usuario", status: "ativo", origem: "hotmart" })
          .select("id").maybeSingle();
        u = novo;
      }
      if (!u) return json({ ok: false, erro: "nao consegui criar o usuario" }, 500);

      if (SUSPENDE.indexOf(evt) >= 0) {
        await db.from("sia_assinaturas")
          .update({ status: "cancelado", atualizado_em: new Date().toISOString() })
          .eq("usuario_id", u.id).eq("produto_id", produto);
        return json({ ok: true, acao: "cancelado", produto, evento: evt });
      }

      const vence = new Date(Date.now() + meses * 30 * 24 * 3600 * 1000).toISOString();
      await db.from("sia_assinaturas").upsert({
        usuario_id: u.id, produto_id: produto, status: "ativo",
        vence_em: vence, origem: "hotmart", codigo_oferta: oferta || null,
        atualizado_em: new Date().toISOString(),
      }, { onConflict: "usuario_id,produto_id" });

      return json({ ok: true, acao: "liberado", produto, vence_em: vence, evento: evt });
    }

    return json({ ok: false, erro: "acao desconhecida", acoes: ["entrar", "validar", "sair", "webhook"] }, 400);
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});

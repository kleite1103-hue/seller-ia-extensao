// ============================================================
// SELLER.IA · ACESSO
// Edge Function: valida email, entrega token, controla sessao
// unica por usuario e conta a cota.
//
// Publicar como funcao "acesso" no Supabase, com Verify JWT
// DESLIGADO (a extensao chama sem chave; a seguranca e o token
// que esta funcao mesma emite).
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CODE_VERSION = "acesso-1.0.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// --- token opaco, sem nada legivel dentro ---
function novoToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function hash(txt: string): Promise<string> {
  const dados = new TextEncoder().encode(txt);
  const d = await crypto.subtle.digest("SHA-256", dados);
  return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// nome legivel do dispositivo, para a pessoa se reconhecer no painel
function nomeDispositivo(ua: string): string {
  const u = String(ua || "");
  const nav = /Edg\//.test(u) ? "Edge"
    : /OPR\//.test(u) ? "Opera"
    : /Chrome\//.test(u) ? "Chrome"
    : /Firefox\//.test(u) ? "Firefox"
    : /Safari\//.test(u) ? "Safari" : "navegador";
  const so = /Windows/.test(u) ? "Windows"
    : /Macintosh|Mac OS/.test(u) ? "Mac"
    : /Linux/.test(u) ? "Linux"
    : /Android/.test(u) ? "Android"
    : /iPhone|iPad/.test(u) ? "iPhone" : "";
  return so ? `${nav} no ${so}` : nav;
}

Deno.serve(async (req) => {
  try {
    return await atender(req);
  } catch (e) {
    return json({ ok: false, erro: "erro interno: " + String((e as Error)?.message || e) }, 500);
  }
});

async function atender(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
  }
  if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ ok: false, erro: "faltam secrets no Supabase" }, 500);
  const db = createClient(url, key);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, erro: "json invalido" }, 400); }

  const ip = req.headers.get("cf-connecting-ip")
    || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || null;
  const ua = req.headers.get("user-agent") || "";
  const acao = String(body.acao || "");

  // ---------- registrar evento ----------
  async function evento(nome: string, email: string | null, usuarioId: string | null, detalhe: unknown = null) {
    try {
      await db.from("sia_eventos").insert({
        usuario_id: usuarioId, email, evento: nome, detalhe, ip,
      });
    } catch { /* nao derruba a chamada */ }
  }

  // ============================================================
  // ENTRAR — email libera, token sai, sessao anterior cai
  // ============================================================
  if (acao === "entrar") {
    const email = String(body.email || "").trim().toLowerCase();
    const dispositivo = String(body.dispositivo || "").slice(0, 120) || null;
    if (!email || !email.includes("@")) return json({ ok: false, erro: "email invalido" }, 400);

    const { data: u } = await db.from("sia_usuarios").select("*").ilike("email", email).maybeSingle();

    if (!u) {
      await evento("login_negado", email, null, { motivo: "nao cadastrado" });
      return json({
        ok: false,
        erro: "Este email nao tem acesso a Seller.IA. Se voce acabou de assinar, aguarde alguns minutos — a liberacao e automatica.",
      }, 403);
    }
    if (u.status !== "ativo" && u.status !== "teste") {
      await evento("login_negado", email, u.id, { motivo: u.status });
      return json({
        ok: false,
        erro: u.status === "suspenso"
          ? "Sua assinatura esta suspensa. Verifique o pagamento na Hotmart."
          : "Sua assinatura foi cancelada. Reative para voltar a usar.",
        status: u.status,
      }, 403);
    }
    if (u.expira_em && new Date(u.expira_em) < new Date()) {
      await db.from("sia_usuarios").update({ status: "suspenso" }).eq("id", u.id);
      await evento("login_negado", email, u.id, { motivo: "expirada" });
      return json({ ok: false, erro: "Sua assinatura venceu. Renove para continuar.", status: "suspenso" }, 403);
    }

    // SESSAO UNICA: derruba a anterior, seja qual for a maquina
    const { data: antigas } = await db.from("sia_sessoes")
      .select("id, dispositivo, dispositivo_nome")
      .eq("usuario_id", u.id).is("encerrada_em", null);

    let derrubou: string | null = null;
    if (antigas && antigas.length) {
      const outra = antigas.find((s: any) => s.dispositivo !== dispositivo);
      if (outra) derrubou = outra.dispositivo_nome || "outro dispositivo";
      await db.from("sia_sessoes")
        .update({ encerrada_em: new Date().toISOString(), motivo_fim: "outra_sessao" })
        .eq("usuario_id", u.id).is("encerrada_em", null);
      if (derrubou) await evento("sessao_derrubada", email, u.id, { anterior: derrubou });
    }

    const token = novoToken();
    const expira = new Date(Date.now() + 24 * 3600 * 1000);
    await db.from("sia_sessoes").insert({
      usuario_id: u.id, token, dispositivo,
      dispositivo_nome: nomeDispositivo(ua), ip,
      expira_em: expira.toISOString(),
    });
    await db.from("sia_usuarios").update({ ultimo_acesso: new Date().toISOString() }).eq("id", u.id);
    await evento("login", email, u.id, { dispositivo: nomeDispositivo(ua) });

    const { data: cota } = await db.rpc("sia_cota", { p_usuario: u.id });
    const c = Array.isArray(cota) ? cota[0] : cota;

    return json({
      ok: true,
      token,
      expira_em: expira.toISOString(),
      usuario: {
        nome: u.nome, email: u.email, papel: u.papel, plano: u.plano,
        status: u.status, expira_em: u.expira_em,
        cota_mensal: c?.mensal ?? 1, cota_semanal: c?.semanal ?? 4,
        ilimitado: !!c?.ilimitado,
        admin: u.papel === "adm" || u.papel === "ceo",
      },
      aviso: derrubou ? `A sessao em ${derrubou} foi encerrada — cada acesso vale para uma maquina por vez.` : null,
    });
  }

  // ============================================================
  // VALIDAR — a extensao confirma a sessao a cada abertura
  // ============================================================
  if (acao === "validar") {
    const token = String(body.token || "");
    if (!token) return json({ ok: false, erro: "sem token" }, 401);

    const { data: s } = await db.from("sia_sessoes").select("*").eq("token", token).maybeSingle();
    if (!s || s.encerrada_em) {
      return json({ ok: false, erro: "sessao encerrada", motivo: s?.motivo_fim || "invalida" }, 401);
    }
    if (new Date(s.expira_em) < new Date()) {
      await db.from("sia_sessoes").update({ encerrada_em: new Date().toISOString(), motivo_fim: "expirou" }).eq("id", s.id);
      return json({ ok: false, erro: "sessao expirada", motivo: "expirou" }, 401);
    }

    const { data: u } = await db.from("sia_usuarios").select("*").eq("id", s.usuario_id).maybeSingle();
    if (!u || (u.status !== "ativo" && u.status !== "teste")) {
      return json({ ok: false, erro: "assinatura " + (u?.status || "invalida"), motivo: "assinatura" }, 403);
    }

    await db.from("sia_sessoes").update({ ultima_batida: new Date().toISOString() }).eq("id", s.id);
    const { data: cota } = await db.rpc("sia_cota", { p_usuario: u.id });
    const c = Array.isArray(cota) ? cota[0] : cota;

    return json({
      ok: true,
      usuario: {
        nome: u.nome, email: u.email, papel: u.papel, plano: u.plano,
        status: u.status, expira_em: u.expira_em,
        cota_mensal: c?.mensal ?? 1, cota_semanal: c?.semanal ?? 4,
        ilimitado: !!c?.ilimitado,
        admin: u.papel === "adm" || u.papel === "ceo",
      },
    });
  }

  // ============================================================
  // COTA — pode gerar este relatorio?
  // ============================================================
  if (acao === "cota") {
    const token = String(body.token || "");
    const tipo = String(body.tipo || "relatorio_mensal");
    const { data: s } = await db.from("sia_sessoes").select("usuario_id, encerrada_em, expira_em").eq("token", token).maybeSingle();
    if (!s || s.encerrada_em || new Date(s.expira_em) < new Date()) {
      return json({ ok: false, erro: "sessao invalida" }, 401);
    }
    const { data } = await db.rpc("sia_pode_gerar", { p_usuario: s.usuario_id, p_tipo: tipo });
    const r = Array.isArray(data) ? data[0] : data;
    return json({ ok: true, pode: !!r?.pode, usado: r?.usado ?? 0, limite: r?.limite ?? 0, motivo: r?.motivo });
  }

  // ============================================================
  // REGISTRAR USO — chamado depois que o relatorio sai
  // ============================================================
  if (acao === "uso") {
    const token = String(body.token || "");
    const tipo = String(body.tipo || "coleta");
    const { data: s } = await db.from("sia_sessoes").select("usuario_id, encerrada_em").eq("token", token).maybeSingle();
    if (!s || s.encerrada_em) return json({ ok: false, erro: "sessao invalida" }, 401);

    await db.from("sia_uso").insert({
      usuario_id: s.usuario_id, tipo,
      loja_id: body.loja || null, loja_nome: body.loja_nome || null,
      detalhe: body.detalhe || null,
    });
    const campo = tipo.startsWith("relatorio") ? "total_relatorios" : "total_coletas";
    const { data: atual } = await db.from("sia_usuarios").select(campo).eq("id", s.usuario_id).maybeSingle();
    await db.from("sia_usuarios")
      .update({ [campo]: ((atual as any)?.[campo] || 0) + 1 })
      .eq("id", s.usuario_id);
    return json({ ok: true });
  }

  // ============================================================
  // SAIR
  // ============================================================
  if (acao === "sair") {
    const token = String(body.token || "");
    await db.from("sia_sessoes")
      .update({ encerrada_em: new Date().toISOString(), motivo_fim: "logout" })
      .eq("token", token);
    return json({ ok: true });
  }

  // ============================================================
  // WEBHOOK DA HOTMART — libera e suspende sozinho
  // ============================================================
  if (acao === "hotmart" || req.headers.get("x-hotmart-hottok")) {
    const segredo = Deno.env.get("HOTMART_HOTTOK");
    const veio = req.headers.get("x-hotmart-hottok") || body.hottok;
    if (segredo && veio !== segredo) {
      await evento("hotmart_recusado", null, null, { motivo: "hottok invalido" });
      return json({ ok: false, erro: "assinatura do webhook invalida" }, 401);
    }

    const d = body.data || body;
    const comprador = d.buyer || d.subscriber || {};
    const email = String(comprador.email || d.email || "").trim().toLowerCase();
    const nome = comprador.name || d.name || null;
    const evt = String(body.event || d.event || "").toUpperCase();
    const plano = d.subscription?.plan?.name || d.product?.name || null;
    if (!email) return json({ ok: false, erro: "webhook sem email" }, 400);

    // eventos que LIBERAM
    const libera = ["PURCHASE_APPROVED", "PURCHASE_COMPLETE", "SUBSCRIPTION_REACTIVATION", "PURCHASE_PROTEST_REVERSED"];
    // eventos que SUSPENDEM
    const suspende = ["PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_CANCELED", "SUBSCRIPTION_CANCELLATION", "PURCHASE_DELAYED", "PURCHASE_BILLET_PRINTED"];

    let status = "ativo";
    if (suspende.includes(evt)) status = evt.includes("CANCEL") ? "cancelado" : "suspenso";
    else if (!libera.includes(evt)) status = "ativo";

    const expira = new Date(Date.now() + 32 * 86400 * 1000).toISOString();
    const { data: existente } = await db.from("sia_usuarios").select("id, papel").ilike("email", email).maybeSingle();

    if (existente) {
      await db.from("sia_usuarios").update({
        status, plano, origem: "hotmart",
        hotmart_id: d.subscription?.subscriber?.code || d.purchase?.transaction || null,
        expira_em: status === "ativo" ? expira : null,
        atualizado_em: new Date().toISOString(),
      }).eq("id", existente.id);
      if (status !== "ativo") {
        await db.from("sia_sessoes")
          .update({ encerrada_em: new Date().toISOString(), motivo_fim: "revogada" })
          .eq("usuario_id", existente.id).is("encerrada_em", null);
      }
    } else if (status === "ativo") {
      await db.from("sia_usuarios").insert({
        email, nome, papel: "usuario", status: "ativo", origem: "hotmart", plano,
        hotmart_id: d.subscription?.subscriber?.code || d.purchase?.transaction || null,
        expira_em: expira,
      });
    }
    await evento("hotmart_" + evt.toLowerCase(), email, existente?.id || null, { plano, status });
    return json({ ok: true, email, status, evento: evt });
  }

  return json({ ok: false, erro: "acao desconhecida", acoes: ["entrar", "validar", "cota", "uso", "sair", "hotmart"] }, 400);
}

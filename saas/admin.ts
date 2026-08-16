// ============================================================
// SELLER.IA · ADMIN
// Edge Function: tudo que o painel precisa. So responde a token
// de usuario com papel adm ou ceo.
//
// Publicar como funcao "admin", Verify JWT DESLIGADO.
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

Deno.serve(async (req) => {
  try { return await atender(req); }
  catch (e) { return json({ ok: false, erro: String((e as Error)?.message || e) }, 500); }
});

async function atender(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
  if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ ok: false, erro: "faltam secrets" }, 500);
  const db = createClient(url, key);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, erro: "json invalido" }, 400); }

  // ---------- so admin passa daqui ----------
  const token = String(body.token || "");
  const { data: s } = await db.from("sia_sessoes").select("usuario_id, encerrada_em, expira_em").eq("token", token).maybeSingle();
  if (!s || s.encerrada_em || new Date(s.expira_em) < new Date()) return json({ ok: false, erro: "sessao invalida" }, 401);
  const { data: eu } = await db.from("sia_usuarios").select("id, email, papel").eq("id", s.usuario_id).maybeSingle();
  if (!eu || (eu.papel !== "adm" && eu.papel !== "ceo")) return json({ ok: false, erro: "sem permissao" }, 403);

  const acao = String(body.acao || "");
  async function registrar(evento: string, detalhe: unknown) {
    try { await db.from("sia_eventos").insert({ usuario_id: eu.id, email: eu.email, evento, detalhe }); } catch { }
  }

  // ---------- PAINEL: tudo de uma vez ----------
  if (acao === "painel") {
    const [resumo, usuarios, diario, top, eventos] = await Promise.all([
      db.from("sia_painel_resumo").select("*").maybeSingle(),
      db.from("sia_painel_usuarios").select("*").order("ultimo_acesso", { ascending: false, nullsFirst: false }).limit(500),
      db.from("sia_painel_uso_diario").select("*").limit(30),
      db.from("sia_painel_top_uso").select("*").limit(20),
      db.from("sia_eventos").select("*").order("em", { ascending: false }).limit(60),
    ]);
    const { data: papeis } = await db.from("sia_papeis").select("*").order("ordem");
    const { data: planos } = await db.from("sia_planos").select("*").order("ordem");
    const { data: lojas } = await db.from("sia_painel_lojas").select("*").limit(200);
    return json({
      ok: true,
      resumo: resumo.data, usuarios: usuarios.data || [],
      uso_diario: diario.data || [], top_uso: top.data || [],
      eventos: eventos.data || [], papeis: papeis || [],
      planos: planos || [], lojas: lojas || [],
    });
  }

  // ---------- CRIAR ou ATUALIZAR ----------
  if (acao === "salvar") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email.includes("@")) return json({ ok: false, erro: "email invalido" }, 400);
    const campos: any = {
      email, nome: body.nome || null,
      papel: body.papel || "usuario",
      status: body.status || "ativo",
      plano: body.plano || null,
      plano_id: body.plano_id || null,
      lojas_extra: body.lojas_extra !== undefined ? parseInt(body.lojas_extra, 10) || 0 : undefined,
      observacao: body.observacao || null,
      atualizado_em: new Date().toISOString(),
    };
    // cota manual: so grava quando veio numero
    if (body.cota_mensal === null || body.cota_mensal === "") campos.cota_mensal = null;
    else if (body.cota_mensal !== undefined) campos.cota_mensal = parseInt(body.cota_mensal, 10);
    if (body.cota_semanal === null || body.cota_semanal === "") campos.cota_semanal = null;
    else if (body.cota_semanal !== undefined) campos.cota_semanal = parseInt(body.cota_semanal, 10);
    if (body.expira_em) campos.expira_em = body.expira_em;
    if (body.dias) campos.expira_em = new Date(Date.now() + parseInt(body.dias, 10) * 86400000).toISOString();

    const { data: existe } = await db.from("sia_usuarios").select("id").ilike("email", email).maybeSingle();
    if (existe) {
      await db.from("sia_usuarios").update(campos).eq("id", existe.id);
      if (campos.status !== "ativo" && campos.status !== "teste") {
        await db.from("sia_sessoes").update({ encerrada_em: new Date().toISOString(), motivo_fim: "revogada" })
          .eq("usuario_id", existe.id).is("encerrada_em", null);
      }
      await registrar("usuario_atualizado", { email, campos });
      return json({ ok: true, criado: false });
    }
    campos.origem = "manual";
    const { error } = await db.from("sia_usuarios").insert(campos);
    if (error) return json({ ok: false, erro: error.message }, 400);
    await registrar("usuario_criado", { email, papel: campos.papel });
    return json({ ok: true, criado: true, enviar_boas_vindas: true, email });
  }

  // ---------- CADASTRO EM LOTE ----------
  if (acao === "lote") {
    const linhas = String(body.emails || "").split(/[\n,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.includes("@"));
    if (!linhas.length) return json({ ok: false, erro: "nenhum email valido" }, 400);
    const papel = body.papel || "usuario";
    const dias = parseInt(body.dias || "32", 10);
    const expira = new Date(Date.now() + dias * 86400000).toISOString();
    let criados = 0, existentes = 0;
    for (const email of linhas) {
      const { data: ja } = await db.from("sia_usuarios").select("id").ilike("email", email).maybeSingle();
      if (ja) { existentes++; continue; }
      await db.from("sia_usuarios").insert({
        email, papel, status: "ativo", origem: "manual",
        expira_em: expira, observacao: body.observacao || "cadastro em lote",
      });
      criados++;
    }
    await registrar("lote_criado", { total: linhas.length, criados, papel });
    return json({ ok: true, criados, existentes, emails: linhas });
  }

  // ---------- LIBERAR UMA LOJA DO SLOT ----------
  if (acao === "liberar_loja") {
    await db.from("sia_lojas").update({ ativa: false, liberada_em: new Date().toISOString() })
      .eq("usuario_id", body.usuario_id).eq("shop_id", body.shop_id);
    await registrar("loja_liberada", { usuario_id: body.usuario_id, shop_id: body.shop_id });
    return json({ ok: true });
  }

  // ---------- HISTORICO DE UMA LOJA ----------
  if (acao === "historico") {
    const [col, rel] = await Promise.all([
      db.from("sia_coletas").select("id, periodo_ini, periodo_fim, modo, conta, em")
        .eq("shop_id", body.shop_id).order("em", { ascending: false }).limit(40),
      db.from("sia_relatorios").select("id, tipo, periodo, custo_estimado, em")
        .eq("shop_id", body.shop_id).order("em", { ascending: false }).limit(30),
    ]);
    return json({ ok: true, coletas: col.data || [], relatorios: rel.data || [] });
  }

  // ---------- LER UM RELATORIO GUARDADO ----------
  if (acao === "relatorio") {
    const { data } = await db.from("sia_relatorios").select("*").eq("id", body.id).maybeSingle();
    return json({ ok: true, relatorio: data });
  }

  // ---------- AJUSTAR UM PLANO ----------
  if (acao === "plano") {
    await db.from("sia_planos").update({
      nome: body.nome, lojas: parseInt(body.lojas, 10),
      cota_mensal: parseInt(body.cota_mensal, 10),
      cota_semanal: parseInt(body.cota_semanal, 10),
      preco: body.preco ? parseFloat(body.preco) : null,
      hotmart_oferta: body.hotmart_oferta || null,
    }).eq("id", body.id);
    await registrar("plano_ajustado", { id: body.id });
    return json({ ok: true });
  }

  /* ---------- LIGAR E DESLIGAR PRODUTO ----------
     Antes so dava para liberar o Radar rodando SQL na mao, o que e um
     convite ao erro: um email digitado errado libera a pessoa errada e
     ninguem percebe. Aqui a acao registra quem mexeu e quando. */
  if (acao === "assinatura") {
    const usuarioId = String(body.usuario_id || "");
    const produto = String(body.produto || "");
    const ligar = body.ligar !== false;
    const meses = parseInt(body.meses, 10) || 12;

    if (!usuarioId || !produto) {
      return json({ ok: false, erro: "faltam usuario_id e produto" }, 400);
    }

    if (!ligar) {
      await db.from("sia_assinaturas")
        .update({ status: "cancelado", atualizado_em: new Date().toISOString() })
        .eq("usuario_id", usuarioId).eq("produto_id", produto);
      await registrar("assinatura_cancelada", { usuario: usuarioId, produto });
      return json({ ok: true, estado: "cancelado" });
    }

    const vence = new Date(Date.now() + meses * 30 * 24 * 3600 * 1000).toISOString();
    await db.from("sia_assinaturas").upsert({
      usuario_id: usuarioId, produto_id: produto, status: "ativo",
      vence_em: vence, origem: "painel",
      atualizado_em: new Date().toISOString(),
    }, { onConflict: "usuario_id,produto_id" });

    await registrar("assinatura_liberada", { usuario: usuarioId, produto, meses });
    return json({ ok: true, estado: "ativo", vence_em: vence });
  }

  // ---------- DERRUBAR SESSAO ----------
  if (acao === "derrubar") {
    await db.from("sia_sessoes").update({ encerrada_em: new Date().toISOString(), motivo_fim: "revogada" })
      .eq("usuario_id", body.usuario_id).is("encerrada_em", null);
    await registrar("sessao_revogada", { usuario_id: body.usuario_id });
    return json({ ok: true });
  }

  // ---------- APAGAR ----------
  if (acao === "apagar") {
    const { data: alvo } = await db.from("sia_usuarios").select("email, papel").eq("id", body.usuario_id).maybeSingle();
    if (alvo?.papel === "adm" && eu.papel !== "adm") return json({ ok: false, erro: "so um adm remove outro adm" }, 403);
    await db.from("sia_usuarios").delete().eq("id", body.usuario_id);
    await registrar("usuario_apagado", { email: alvo?.email });
    return json({ ok: true });
  }

  // ---------- DETALHE DE UM USUARIO ----------
  if (acao === "detalhe") {
    const [u, uso, sess, ev] = await Promise.all([
      db.from("sia_painel_usuarios").select("*").eq("id", body.usuario_id).maybeSingle(),
      db.from("sia_uso").select("*").eq("usuario_id", body.usuario_id).order("em", { ascending: false }).limit(60),
      db.from("sia_sessoes").select("*").eq("usuario_id", body.usuario_id).order("criada_em", { ascending: false }).limit(20),
      db.from("sia_eventos").select("*").eq("usuario_id", body.usuario_id).order("em", { ascending: false }).limit(40),
    ]);
    const { data: lojas } = await db.from("sia_lojas").select("*")
      .eq("usuario_id", body.usuario_id).order("ultimo_uso", { ascending: false, nullsFirst: false });
    return json({ ok: true, usuario: u.data, uso: uso.data || [], sessoes: sess.data || [], eventos: ev.data || [], lojas: lojas || [] });
  }

  // ---------- AJUSTAR COTA DO PAPEL ----------
  if (acao === "papel") {
    await db.from("sia_papeis").update({
      cota_mensal: parseInt(body.cota_mensal, 10),
      cota_semanal: parseInt(body.cota_semanal, 10),
    }).eq("papel", body.papel);
    await registrar("papel_ajustado", { papel: body.papel, mensal: body.cota_mensal, semanal: body.cota_semanal });
    return json({ ok: true });
  }

  // ---------- ZERAR COTA DO CICLO ----------
  if (acao === "zerar_cota") {
    await db.from("sia_uso").delete().eq("usuario_id", body.usuario_id).gte("em", new Date(Date.now() - 30 * 86400000).toISOString());
    await registrar("cota_zerada", { usuario_id: body.usuario_id });
    return json({ ok: true });
  }

  return json({ ok: false, erro: "acao desconhecida" }, 400);
}

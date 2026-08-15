// ============================================================
// SELLER.IA · MERCADO POR FOTO
//
// Recebe uma foto e devolve o termo de busca. A IA descreve o que
// ve; ela acerta o TIPO do produto, nao a marca — e isso basta
// para pesquisa de mercado, desde que a tela diga o que ela
// entendeu antes de buscar.
//
// Publicar como funcao "mercado-foto", Verify JWT DESLIGADO.
// Secret necessaria: ANTHROPIC_API_KEY
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

const SISTEMA = `Voce olha a foto de um produto e devolve o termo que um comprador
brasileiro digitaria na Shopee para encontrar algo assim.

REGRAS
1. O termo tem de 2 a 5 palavras. Nem generico demais ("brinquedo"), nem
   especifico demais a ponto de nao existir busca ("carrinho de metal amarelo
   com friccao de 8cm").
2. Portugues do Brasil, como se digita numa busca: minusculas, sem acento
   quando o normal e digitar sem, sem plural desnecessario.
3. NAO invente marca. Se a marca aparece na foto e e conhecida, pode usar. Se
   voce nao tem certeza, nao escreva.
4. Se a foto nao mostra um produto vendavel — e uma pessoa, um cenario, um
   texto — devolva termo vazio e diga o que voce viu.

RESPONDA SO COM JSON, sem cercas de markdown, neste formato:
{"termo":"comedouro lento gato","descricao":"comedouro plastico com labirinto interno, para gatos"}

A descricao e uma linha curta do que voce viu, para a pessoa conferir se voce
entendeu certo antes de a busca rodar.`;

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
    }
    if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);

    const chave = Deno.env.get("ANTHROPIC_API_KEY");
    if (!chave) return json({ ok: false, erro: "falta a secret ANTHROPIC_API_KEY" }, 500);

    let body: any;
    try { body = await req.json(); } catch { return json({ ok: false, erro: "json invalido" }, 400); }

    /* SO COM ASSINATURA DO RADAR. Estas funcoes gastam cota da Anthropic a
       cada chamada: sem porteiro, quem tivesse a chave anon do pacote
       poderia rodar em volume e a conta viria para nos. */
    const _url = Deno.env.get("SUPABASE_URL");
    const _key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!_url || !_key) return json({ ok: false, erro: "faltam secrets" }, 500);
    const _db = createClient(_url, _key);

    const _tok = String(body.token || "");
    if (!_tok) return json({ ok: false, erro: "sem token" }, 401);

    const { data: _s } = await _db.from("sia_sessoes")
      .select("usuario_id, encerrada_em, expira_em")
      .eq("token", _tok).eq("produto_id", "radar360").maybeSingle();

    if (!_s || _s.encerrada_em ||
        (_s.expira_em && new Date(_s.expira_em) < new Date())) {
      return json({ ok: false, erro: "sessao invalida" }, 401);
    }
    if (!body.imagem) return json({ ok: false, erro: "sem imagem" }, 400);

    const tipo = String(body.tipo || "image/jpeg");
    if (!/^image\/(jpeg|png|webp|gif)$/.test(tipo)) {
      return json({ ok: false, erro: "formato nao aceito: use JPG, PNG ou WEBP" }, 400);
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": chave,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        system: SISTEMA,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: tipo, data: body.imagem } },
            { type: "text", text: "Que produto e este, e o que eu digitaria na Shopee para encontrar algo assim?" },
          ],
        }],
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      return json({ ok: false, erro: "a IA recusou: " + t.slice(0, 200) }, 502);
    }
    const j = await r.json();
    const texto = (j.content || [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    let saida: any;
    try { saida = JSON.parse(texto); }
    catch { return json({ ok: false, erro: "nao consegui entender a resposta da IA" }, 502); }

    if (!saida.termo) {
      return json({
        ok: false,
        erro: "Nao vi um produto nesta foto" + (saida.descricao ? ": " + saida.descricao : "") + ".",
      }, 400);
    }

    return json({ ok: true, termo: String(saida.termo).slice(0, 60), descricao: saida.descricao || null });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});

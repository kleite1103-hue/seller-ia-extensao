// ============================================================
// SELLER.IA · RECEITA
//
// A extensao nao sabe MAIS o que coletar. Ela pergunta aqui, a
// cada sessao, e recebe a lista de chamadas para executar.
//
// Quem copiar o arquivo da extensao leva um executor vazio: sem
// esta funcao ele nao sabe qual rota chamar, com qual corpo, nem
// em que ordem. E esta funcao so responde a token valido.
//
// Publicar como funcao "receita", Verify JWT DESLIGADO.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CODE_VERSION = "receita-1.0.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
}

/* ============================================================
   A RECEITA
   Cada passo diz: id, rota, metodo, corpo e quando executar.
   Os marcadores {ini}, {fim}, {fimAds}, {spc} sao trocados pela
   extensao com os valores da sessao dela.
   ============================================================ */
function montarReceita(modo: string, ctx: any) {
  const PROFUNDA = modo === "profunda";
  const p: any[] = [];

  // ---------- 1. IDENTIDADE E SAUDE ----------
  p.push({ id: "loja", url: "/api/selleraccount/shop_info/?{spc}", metodo: "GET", fase: "Lendo a loja" });
  p.push({ id: "saude", url: "/api/accounthealth/v1/sc/shops/overview?{spc}", metodo: "GET", fase: "Lendo a saude da conta" });

  // ---------- 2. GERENCIAIS ----------
  // period=month e obrigatorio: custom e day sao recusados pela Shopee,
  // mas start_time e end_time livres funcionam dentro dele.
  p.push({
    id: "key_metrics",
    url: "/api/mydata/v3/dashboard/key-metrics/?{spc}&start_time={ini}&end_time={fim}&period=month",
    metodo: "GET", fase: "Lendo as informacoes gerenciais",
  });
  p.push({
    id: "key_metrics_anterior",
    url: "/api/mydata/v3/dashboard/key-metrics/?{spc}&start_time={iniAnt}&end_time={fimAnt}&period=month",
    metodo: "GET", fase: "Lendo o periodo anterior", opcional: true,
  });
  p.push({
    id: "ordem",
    url: "/api/mydata/dashboard/order-performance/?{spc}&start_time={ini}&end_time={fim}&period=month",
    metodo: "GET", fase: "Lendo os pedidos", opcional: true,
  });
  p.push({
    id: "fontes",
    url: "/api/mydata/v1/dashboard/traffic-sources/?{spc}&start_time={ini}&end_time={fim}&period=month",
    metodo: "GET", fase: "Lendo de onde vem o trafego", opcional: true,
  });

  // ---------- 3. PRODUTOS ----------
  // page_size 50: com 10 a primeira pagina ja parava o laco.
  p.push({
    id: "produtos", paginado: true, paginas: 12, tamanho: 50,
    url: "/api/mydata/v4/product/performance/?{spc}&start_time={ini}&end_time={fim}&period=month&keyword=&category_type=shopee&category_id=-1&page_size=50&page_num={pagina}&order_type=paid&order_by=paid_sales.desc",
    metodo: "GET", fase: "Lendo os produtos",
  });
  p.push({
    id: "produtos_trafego", paginado: true, paginas: 12, tamanho: 50,
    url: "/api/mydata/v1/product/traffic/item-list/?{spc}&keyword=&order_by=&page_size=50&page_num={pagina}&category_type=shop&start_time={ini}&end_time={fim}&period=month&category_id=-1",
    metodo: "GET", fase: "Lendo o trafego dos produtos", opcional: true,
  });
  p.push({
    id: "funil_overview",
    url: "/api/mydata/v1/product/traffic/overview/?{spc}&start_time={ini}&end_time={fim}&period=month&order_type=paid",
    metodo: "GET", fase: "Lendo o funil", opcional: true,
  });

  // ---------- 4. ADS ----------
  // ongoing sempre; paused so as que faturaram, senao a coleta arrasta.
  p.push({
    id: "campanhas_ativas", paginado: true, paginas: 10, tamanho: 20,
    url: "/api/pas/v1/homepage/query/?{spc}",
    metodo: "POST", carimbaPeriodo: true,
    corpo: {
      start_time: "{ini}", end_time: "{fimAds}",
      offset: "{offset}", limit: 20,
      filter_list: [{ field: "state", value: ["ongoing"] }],
      sort_by: "cost", sort_type: "desc", need_total: true,
    },
    fase: "Lendo as campanhas ativas",
  });
  p.push({
    id: "campanhas_pausadas", paginado: true, paginas: 2, tamanho: 20,
    url: "/api/pas/v1/homepage/query/?{spc}",
    metodo: "POST", carimbaPeriodo: true, soComReceita: true,
    corpo: {
      start_time: "{ini}", end_time: "{fimAds}",
      offset: "{offset}", limit: 20,
      filter_list: [{ field: "state", value: ["paused"] }],
      sort_by: "cost", sort_type: "desc", need_total: true,
    },
    fase: "Lendo as campanhas pausadas", opcional: true,
  });

  // diagnostico completo: a rota EM LOTE devolve so bidding; a individual
  // devolve os quatro eixos.
  p.push({
    id: "diagnostico", porCampanha: true, limite: PROFUNDA ? 60 : 25, so: "ativa_com_gasto",
    url: "/api/pas/v1/diagnosis/list_verdict/?{spc}",
    metodo: "POST",
    corpo: { reference_id: "{uuid}", campaign_id: "{campanha}" },
    fase: "Lendo o diagnostico da Shopee", pausa: 180,
  });

  p.push({
    id: "serie_horaria", porCampanha: true, limite: PROFUNDA ? 40 : 12, so: "ativa_com_gasto",
    url: "/api/pas/v1/report/get_time_graph/?{spc}",
    metodo: "POST",
    corpo: {
      start_time: "{ini}", end_time: "{fimAds}",
      agg_interval: 4, campaign_type: "product",
      filter_params: { campaign_id: "{campanha}" },
      need_roi_target_setting: true,
    },
    fase: "Lendo a serie hora a hora", somenteProfunda: true,
  });

  p.push({
    id: "vinculo_itens", loteItens: true, tamanho: 50,
    url: "/api/v3/opt/product/get_campaign_info_by_item_list/?{spc}",
    metodo: "POST",
    corpo: { item_id_list: "{itens}" },
    fase: "Ligando produto e campanha",
  });

  p.push({
    id: "recomendacoes", url: "/api/pas/v1/todo/list_task/?{spc}",
    metodo: "POST", corpo: {}, fase: "Lendo o que a Shopee recomenda", opcional: true,
  });

  // ---------- 5. MARKETING ----------
  p.push({ id: "cupons", url: "/api/marketing/v3/voucher/list/?{spc}&offset=0&limit=30&promotion_type=0", metodo: "GET", fase: "Lendo os cupons", opcional: true });
  p.push({ id: "relampago", url: "/api/marketing/v4/shop_flash_sale/get_shop_flash_sale_list/?{spc}&offset=0&limit=30&type=3", metodo: "GET", fase: "Lendo a oferta relampago", opcional: true });
  p.push({ id: "descontos", url: "/api/marketing/v3/public/discount/list/?{spc}&discount_type=0&time_status=1&offset=0&limit=30", metodo: "GET", fase: "Lendo os descontos", opcional: true });
  p.push({ id: "campanhas_shopee", url: "/api/marketing/v4/public/get_marketing_center_campaign_list/?{spc}&language=pt-br", metodo: "GET", fase: "Lendo as campanhas da Shopee", opcional: true });
  p.push({ id: "ferramentas", url: "/api/marketing/v4/public/get_toggle/?{spc}", metodo: "GET", fase: "Lendo as ferramentas liberadas", opcional: true });

  // ---------- 6. AFILIADOS ----------
  const paramsAf = "&order_type=2&channel=0&has_meta_feature=1&sm_parameter=0&sort_rule=3&is_real_time=0&period_type=1";
  p.push({ id: "afiliados_resumo", url: "/api/v3/affiliateplatform/dashboard/seller_daily?start_time={ini}&end_time={fimAds}" + paramsAf, metodo: "GET", fase: "Lendo os afiliados", opcional: true });
  p.push({ id: "afiliados_itens", url: "/api/v3/affiliateplatform/dashboard/seller_item_detail/top5?start_time={ini}&end_time={fimAds}" + paramsAf, metodo: "GET", fase: "Lendo os produtos no canal", opcional: true });
  p.push({ id: "afiliados_top", url: "/api/v3/affiliateplatform/dashboard/affiliate_performance/top5?start_time={ini}&end_time={fimAds}" + paramsAf, metodo: "GET", fase: "Lendo quem mais vende", opcional: true });

  // ---------- 7. PROFUNDA ----------
  if (PROFUNDA) {
    p.push({
      id: "palavras", porCampanha: true, limite: 20, so: "ativa_com_gasto",
      url: "/api/pas/v1/shop/manual/list_keyword_with_recommended_price/?{spc}",
      metodo: "POST", corpo: { campaign_id: "{campanha}" },
      fase: "Lendo as palavras por campanha", pausa: 200,
    });
    p.push({
      id: "palavras_sugeridas", url: "/api/pas/v1/setup_helper/list_recommended_keyword/?{spc}",
      metodo: "POST",
      corpo: { campaign_type: "shop", suggest_log_data: { page: "suggest_creation" } },
      fase: "Lendo as palavras sugeridas", opcional: true,
    });
    p.push({
      id: "avaliacoes", porProduto: true, limite: 12,
      url: "/api/v2/item/get_ratings?{spc}&item_id={produto}&limit=6&offset=0&filter=0&flag=1&type=0",
      metodo: "GET", fase: "Lendo as avaliacoes", opcional: true, pausa: 200,
    });
  }

  return p;
}

/* ============================================================ */

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

  // ---------- SO COM TOKEN VALIDO ----------
  const token = String(body.token || "");
  if (!token) return json({ ok: false, erro: "sem token" }, 401);

  const { data: s } = await db.from("sia_sessoes")
    .select("usuario_id, encerrada_em, expira_em").eq("token", token).maybeSingle();
  if (!s || s.encerrada_em || new Date(s.expira_em) < new Date()) {
    return json({ ok: false, erro: "sessao invalida" }, 401);
  }
  const { data: u } = await db.from("sia_usuarios")
    .select("id, status, papel").eq("id", s.usuario_id).maybeSingle();
  if (!u || (u.status !== "ativo" && u.status !== "teste")) {
    return json({ ok: false, erro: "assinatura " + (u?.status || "invalida") }, 403);
  }

  // ---------- REGISTRA QUEM PEDIU ----------
  // Pedido demais em pouco tempo e raspagem, nao uso.
  const desde = new Date(Date.now() - 3600 * 1000).toISOString();
  const { count } = await db.from("sia_eventos")
    .select("id", { count: "exact", head: true })
    .eq("usuario_id", u.id).eq("evento", "receita").gte("em", desde);
  if ((count || 0) > 40) {
    await db.from("sia_eventos").insert({
      usuario_id: u.id, evento: "receita_bloqueada",
      detalhe: { motivo: "mais de 40 pedidos na ultima hora", total: count },
    });
    return json({ ok: false, erro: "muitos pedidos em pouco tempo. Aguarde alguns minutos." }, 429);
  }
  await db.from("sia_eventos").insert({
    usuario_id: u.id, evento: "receita",
    detalhe: { modo: body.modo || "normal", loja: body.loja || null },
  });

  // ---------- CONSULTAS AVULSAS ----------
  // O Espiao e o volume de palavras rodam sob demanda, fora da coleta.
  // Ficam aqui pelo mesmo motivo: nao deixar rota escrita na extensao.
  if (body.consulta) {
    const c = String(body.consulta);
    if (c === "volume_palavras") {
      const termos = Array.isArray(body.termos) ? body.termos.slice(0, 12) : [];
      return json({
        ok: true,
        url: "/api/pas/v1/setup_helper/list_recommended_keyword/?{spc}",
        metodo: "POST",
        corpo: { campaign_type: "shop", keyword_list: termos, limit: 40 },
      });
    }
    return json({ ok: false, erro: "consulta desconhecida" }, 400);
  }

  const passos = montarReceita(String(body.modo || "normal"), body);
  return json({
    ok: true,
    versao: CODE_VERSION,
    validade: 3600,          // a extensao pode reusar por 1 hora na mesma sessao
    passos,
    // limiares que a extensao usa para decidir o que buscar
    limites: {
      campanhasAtivas: 200,
      campanhasPausadas: 40,
      tetoCampanhas: 280,
      produtos: 600,
      pausaEntreChamadas: 250,
    },
  });
}

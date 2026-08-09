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
    url: "/api/mydata/v3/dashboard/key-metrics/?{spc}&start_time={ini}&end_time={fim}&period=month&fetag=fetag",
    metodo: "GET", fase: "Lendo as informacoes gerenciais",
  });
  p.push({
    id: "key_metrics_anterior",
    url: "/api/mydata/v3/dashboard/key-metrics/?{spc}&start_time={iniAnt}&end_time={fimAnt}&period=month&fetag=fetag",
    metodo: "GET", fase: "Lendo o periodo anterior", opcional: true,
  });
  p.push({
    id: "ordem",
    url: "/api/mydata/dashboard/order-performance/?{spc}&start_time={ini}&end_time={fim}&period=month&fetag=fetag&order_type=paid",
    metodo: "GET", fase: "Lendo os pedidos", opcional: true,
  });
  p.push({
    id: "fontes",
    url: "/api/mydata/v1/dashboard/traffic-sources/?{spc}&start_time={ini}&end_time={fim}&period=month&order_type=paid",
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
  // evolucao diaria: alimenta o grafico de tendencia
  p.push({
    id: "tendencia",
    url: "/api/mydata/v2/product/overview/metric-trends/?{spc}&start_time={ini}&end_time={fim}&period=day",
    metodo: "GET", fase: "Lendo a evolucao diaria", opcional: true,
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
    // CORPO EXATO da captura. Eu tinha inventado field/value e sort_by, que
    // nao existem: o filtro real leva campaign_type, state, search_term e
    // is_valid_rebate_only dentro do mesmo objeto.
    corpo: {
      start_time: "{ini}", end_time: "{fimAds}",
      filter_list: [{
        campaign_type: "product_homepage_v3",
        state: "ongoing",
        search_term: "",
        is_valid_rebate_only: false,
      }],
      offset: "{offset}", limit: 20, use_paid_gmv: false,
    },
    fase: "Lendo as campanhas ativas",
  });
  p.push({
    id: "campanhas_pausadas", paginado: true, paginas: 2, tamanho: 20,
    url: "/api/pas/v1/homepage/query/?{spc}",
    metodo: "POST", carimbaPeriodo: true, soComReceita: true,
    corpo: {
      start_time: "{ini}", end_time: "{fimAds}",
      filter_list: [{
        campaign_type: "product_homepage_v3",
        state: "paused",
        search_term: "",
        is_valid_rebate_only: false,
      }],
      offset: "{offset}", limit: 20, use_paid_gmv: false,
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

  // variacao por campanha: e o que permite dizer "subiu 20% contra o
  // periodo anterior" em cada card
  p.push({
    id: "variacao_campanha", porCampanha: true, limite: PROFUNDA ? 60 : 30, so: "ativa_com_gasto",
    url: "/api/pas/v1/report/get/?{spc}",
    metodo: "POST",
    corpo: {
      start_time: "{ini}", end_time: "{fimAds}",
      campaign_type: "product", agg_type: "campaign_id",
      filter_params: { campaign_id: "{campanha}" },
      need_ratio: true,
    },
    fase: "Lendo a variacao das campanhas", pausa: 200,
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
  // quanto cada ferramenta de marketing rendeu no periodo
  p.push({
    id: "metricas_desconto", url: "/api/marketing/v4/discount/metrics/?{spc}",
    metodo: "POST", corpo: { start_time: "{ini}", end_time: "{fim}" },
    fase: "Lendo o resultado dos descontos", opcional: true,
  });
  p.push({
    id: "metricas_cupom", url: "/api/marketing/v3/voucher/promotion_tool/metrics/?{spc}&tool_name=marketing_voucher",
    metodo: "GET", fase: "Lendo o resultado dos cupons", opcional: true,
  });
  p.push({
    id: "metricas_combo", url: "/api/marketing/v3/bundle_deal/metrics/?{spc}",
    metodo: "POST", corpo: { start_time: "{ini}", end_time: "{fim}" },
    fase: "Lendo o resultado dos combos", opcional: true,
  });

  // ---------- 6. AFILIADOS ----------
  const paramsAf = "&order_type=2&channel=0&has_meta_feature=1&sm_parameter=0&sort_rule=3&is_real_time=0&period_type=1";
  p.push({ id: "afiliados_resumo", url: "/api/v3/affiliateplatform/dashboard/seller_daily?start_time={ini}&end_time={fimAds}&is_real_time=0&order_type=2&channel=0", metodo: "GET", fase: "Lendo os afiliados", opcional: true });
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
      const spc = String(body.spc || "");
      if (!spc) return json({ ok: false, erro: "sem sessao" }, 400);
      // URL ja montada: a extensao nao aprende o formato
      return json({
        ok: true,
        chamada: {
          url: "/api/pas/v1/setup_helper/list_recommended_keyword/?" + spc,
          metodo: "POST",
          corpo: JSON.stringify({ campaign_type: "shop", keyword_list: termos, limit: 40 }),
        },
      });
    }
    return json({ ok: false, erro: "consulta desconhecida" }, 400);
  }

  /* ============================================================
     ENTREGA PASSO A PASSO
     A receita inteira numa resposta so ficava legivel no console:
     bastava abrir a aba de rede para ler as 28 rotas de uma vez.
     Agora o servidor entrega UMA chamada por vez, ja montada, e a
     extensao devolve o resultado para receber a proxima. Quem
     quiser a receita completa precisa rodar a coleta inteira e
     juntar os pedacos — e cada pedido fica registrado.
     ============================================================ */
  if (body.passo !== undefined) {
    const modo = String(body.modo || "normal");
    const passos0 = montarReceita(modo, body);
    const idx = parseInt(String(body.passo), 10) || 0;
    if (idx >= passos0.length) {
      return json({ ok: true, fim: true, total: passos0.length });
    }
    const passo = passos0[idx];
    const vals = body.vals || {};
    // o reference_id que algumas rotas exigem e gerado AQUI: a extensao nao
    // sabe nem que ele existe
    vals.uuid = crypto.randomUUID();

    // troca os marcadores AQUI, no servidor: a extensao recebe a URL
    // final e nao aprende o formato dela
    function preencher(txt: string): string {
      return String(txt).replace(/\{(\w+)\}/g, (m, k) => vals[k] !== undefined ? String(vals[k]) : m);
    }
    function preencherObj(o: any): any {
      if (o == null) return o;
      if (typeof o === "string") {
        const so = o.match(/^\{(\w+)\}$/);
        if (so && vals[so[1]] !== undefined) return vals[so[1]];
        return preencher(o);
      }
      if (Array.isArray(o)) return o.map(preencherObj);
      if (typeof o === "object") {
        const out: any = {};
        for (const k in o) out[k] = preencherObj(o[k]);
        return out;
      }
      return o;
    }

    return json({
      ok: true,
      indice: idx,
      total: passos0.length,
      fase: passo.fase,
      // so o que a extensao precisa para EXECUTAR, nada sobre o formato
      chamada: {
        url: preencher(passo.url),
        metodo: passo.metodo,
        corpo: passo.corpo ? JSON.stringify(preencherObj(passo.corpo)) : null,
      },
      // como repetir, quando o passo tem varias chamadas
      repete: passo.paginado ? { tipo: "pagina", ate: passo.paginas, tamanho: passo.tamanho }
        : passo.porCampanha ? { tipo: "campanha", limite: passo.limite, so: passo.so }
        : passo.porProduto ? { tipo: "produto", limite: passo.limite }
        : passo.loteItens ? { tipo: "itens", tamanho: passo.tamanho }
        : null,
      carimbaPeriodo: !!passo.carimbaPeriodo,
      opcional: !!passo.opcional,
      somenteProfunda: !!passo.somenteProfunda,
      pausa: passo.pausa || 250,
    });
  }

  // modo antigo, mantido so para depuracao com papel de administrador
  if (u.papel !== "adm") {
    return json({ ok: false, erro: "peca um passo por vez" }, 400);
  }
  const passos = montarReceita(String(body.modo || "normal"), body);
  return json({
    ok: true,
    versao: CODE_VERSION,
    validade: 3600,
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

// ============================================================
// SELLER.IA · CEREBRO v2
// Supabase Edge Function · Deno
// ============================================================
// O QUE MUDA EM RELACAO AO v1 (ocpm-1.3):
// 1. As regras nao estao mais escritas aqui. Vem da tabela `conhecimento`.
//    Trocar um limiar deixa de exigir deploy.
// 2. Conhece os 6 formatos de Ads e o que cada um PROIBE, entao nunca
//    recomenda o impossivel (meta em formato sem meta, custo por produto
//    dentro de grupo).
// 3. Sabe que os campos cpc e cpm da API nao podem ser lidos pelo nome.
// 4. Usa o piso de ROAS pela margem quando o Cofre existe, e recusa a
//    sugestao da Shopee quando ela cai abaixo desse piso.
// 5. Ordena por DINHEIRO EM JOGO, nunca por gravidade.
// 6. Devolve prosa pronta. Nunca desce formula, peso ou limiar.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CODE_VERSION = "cerebro-2.0.0";
let CACHE: { em: number; dados: any } | null = null;
const CACHE_MS = 5 * 60 * 1000;

interface Veredito {
  escopo: "conta" | "campanha" | "produto";
  id?: string;
  nivel: "vermelho" | "amarelo" | "verde" | "cinza";
  titulo: string;
  texto: string;
  passos: string[];
  dinheiro?: number;   // usado para ordenar. em reais
  fonte?: string;      // "shopee" quando o veredito e dela, "seller.ia" quando e nosso
}

/* ==================== CONHECIMENTO ==================== */

async function carregarConhecimento(supa: any) {
  if (CACHE && Date.now() - CACHE.em < CACHE_MS) return CACHE.dados;
  const { data, error } = await supa
    .from("conhecimento")
    .select("dominio,chave,versao,condicao,veredito,observacao,prioridade")
    .eq("ativo", true)
    .order("prioridade", { ascending: true });
  if (error) throw new Error("conhecimento: " + error.message);

  const porDominio: Record<string, any[]> = {};
  const porChave: Record<string, any> = {};
  for (const r of data || []) {
    (porDominio[r.dominio] = porDominio[r.dominio] || []).push(r);
    porChave[r.dominio + "." + r.chave] = r;
  }
  // A versao vem da TABELA, nao do codigo. Antes era constante aqui, o que
  // fazia a resposta parecer saudavel mesmo com a tabela vazia.
  const total = (data || []).length;
  const versao = (data || [])[0]?.versao || "sem-conhecimento";
  const contagem: Record<string, number> = {};
  for (const d of Object.keys(porDominio)) contagem[d] = porDominio[d].length;
  const dados = { porDominio, porChave, versao, total, contagem };
  CACHE = { em: Date.now(), dados };
  return dados;
}

function limiar(K: any, chave: string, campo = "valor", padrao: any = null) {
  const r = K.porChave["limiar." + chave];
  if (!r || !r.condicao) return padrao;
  const v = r.condicao[campo];
  return v === undefined || v === null ? padrao : v;
}

/* ==================== NORMALIZACAO ==================== */
// A API mistura escalas: taxas vem como fracao (0,0414 = 4,14%), valores
// vem em micro (x100.000). Nada entra no julgamento sem passar por aqui.

const num = (v: any) => (typeof v === "number" && isFinite(v) ? v : null);
const pct = (v: any) => { const n = num(v); return n === null ? null : (n <= 1 ? n * 100 : n); };
const reais = (v: any) => { const n = num(v); return n === null ? null : n / 100000; };
const fmt = (v: any, d = 1) => (num(v) === null ? "—" : Number(v).toFixed(d).replace(".", ","));
const dinheiro = (v: any) => (num(v) === null ? "—" : "R$ " + Number(v).toFixed(2).replace(".", ","));

function preencher(txt: string, vars: Record<string, any>) {
  return String(txt || "").replace(/\{(\w+)\}/g, (_m, k) =>
    vars[k] === undefined || vars[k] === null ? "—" : String(vars[k]));
}

/* ==================== FORMATO DE ADS ==================== */

function formatoDe(K: any, camp: any) {
  const tipo = camp?.type ?? camp?.tipo ?? null;
  const sub = camp?.subtype ?? camp?.subtipo ?? null;
  const lista = K.porDominio["ads_formato"] || [];
  // casa por type + subtype; se nao achar, casa so por type
  let achou = lista.find((r: any) => r.condicao?.type === tipo && (r.condicao?.subtype ?? null) === (sub ?? null));
  if (!achou) achou = lista.find((r: any) => r.condicao?.type === tipo);
  return achou || null;
}

function proibe(fmtRegra: any, oque: string) {
  const p: string[] = fmtRegra?.veredito?.proibe || [];
  return p.some((x) => String(x).toLowerCase().includes(oque));
}

/* ==================== PISO DE ROAS ==================== */
// O piso real e 1/margem. Sem margem, cai no padrao (8x) e o texto avisa
// que a leitura esta limitada.

function pisoRoas(K: any, margemPct: number | null) {
  if (margemPct && margemPct > 0) {
    return { valor: 100 / margemPct, origem: "margem" as const };
  }
  return { valor: limiar(K, "roas_piso_padrao", "valor", 8), origem: "padrao" as const };
}

function lucroDe(gasto: number | null, roas: number | null, margemPct: number | null) {
  if (!gasto || !roas || !margemPct) return null;
  return gasto * (roas * (margemPct / 100) - 1);
}

/* ==================== PRODUTO ==================== */

function julgarProdutos(K: any, snap: any, saida: Veredito[]) {
  const produtos = snap?.produtos || {};
  const cofre = snap?.cofre || {};
  const pisoVisitas = limiar(K, "visitas_minimas_julgamento", "valor", 100);
  const regras = (K.porDominio["produto"] || []);

  for (const id of Object.keys(produtos)) {
    const p = produtos[id] || {};
    const m = p.metricas || p.perf || {};

    const visitas = num(m.visitantes ?? m.uv);
    const ctr = pct(m.ctr_card ?? m.ctr);
    const conv = pct(m.conversao_pago ?? m.convPago);
    const rej = pct(m.rejeicao);
    const fatia = pct(m.fatia_vendas ?? m.fatiaVendas);
    const venda = num(m.vendas_pagas ?? m.vendaPaga) ?? 0;
    const pedidos = num(m.pedidos_pagos ?? m.pedidosPagos);
    let ticket = num(m.ticket_pedido ?? m.ticket);
    if (!ticket && venda && pedidos) ticket = venda / pedidos;
    const temAds = !!(p.campaignId || m.temAds);

    const ctx: Record<string, any> = {
      visitas: visitas === null ? "0" : fmt(visitas, 0),
      ctr: fmt(ctr, 1), conversao: fmt(conv, 1), rejeicao: fmt(rej, 0),
      fatia: fmt(fatia, 0), ticket: dinheiro(ticket),
    };

    // sem volume corta tudo: percentual com pouca visita engana
    if (visitas === null || visitas < pisoVisitas) {
      const r = K.porChave["produto.sem_visita"];
      if (r) saida.push(montar("produto", id, r, ctx, venda));
      continue;
    }

    let casou = false;
    for (const r of regras) {
      const c = r.condicao || {};
      if (c.visitas_menor_que !== undefined) continue; // ja tratado acima
      if (c.ctr_menor_que !== undefined && !(ctr !== null && ctr < c.ctr_menor_que)) continue;
      if (c.ctr_maior_igual !== undefined && !(ctr !== null && ctr >= c.ctr_maior_igual)) continue;
      if (c.conversao_menor_que !== undefined && !(conv !== null && conv < c.conversao_menor_que)) continue;
      if (c.conversao_maior_igual !== undefined && !(conv !== null && conv >= c.conversao_maior_igual)) continue;
      if (c.rejeicao_maior_igual !== undefined && !(rej !== null && rej >= c.rejeicao_maior_igual)) continue;
      if (c.fatia_maior_igual !== undefined && !(fatia !== null && fatia >= c.fatia_maior_igual)) continue;
      if (c.ticket_menor_que !== undefined && !(ticket !== null && ticket < c.ticket_menor_que)) continue;
      if (c.ticket_maior_que !== undefined && !(ticket !== null && ticket > c.ticket_maior_que)) continue;
      if (c.tem_ads !== undefined && c.tem_ads !== temAds) continue;
      saida.push(montar("produto", id, r, ctx, venda));
      casou = true;
      break;
    }
    if (!casou) {
      saida.push({
        escopo: "produto", id, nivel: "verde", titulo: "Sem alerta",
        texto: conv !== null ? `De cada 100 que entram, ${fmt(conv, 1)} compram.` : "Nenhum degrau do funil chamou atenção.",
        passos: ["Nada urgente aqui."], dinheiro: venda, fonte: "seller.ia",
      });
    }

    // custo cadastrado permite falar de lucro, nao so de sobra
    const custo = num(cofre?.custos?.[id]);
    if (custo && ticket) {
      const emb = num(cofre.embalagem) || 0;
      const imp = ticket * ((num(cofre.imposto) || 0) / 100);
      const com = comissao(ticket);
      const liq = ticket - com - custo - emb - imp;
      const margem = (liq / ticket) * 100;
      if (margem < 10) {
        saida.push({
          escopo: "produto", id, nivel: "vermelho",
          titulo: `Margem de ${fmt(margem, 1)}% neste produto`,
          texto: `Cada pedido de ${dinheiro(ticket)} deixa ${dinheiro(liq)} depois de comissão, custo, embalagem e imposto. Isso é antes do anúncio.`,
          passos: ["Com margem abaixo de 10% o anúncio precisa de ROAS muito alto para dar lucro", "Rever preço ou custo antes de investir mais"],
          dinheiro: venda, fonte: "seller.ia",
        });
      }
    }
  }
}

function comissao(preco: number) {
  if (preco < 80) return preco * 0.20 + 4;
  if (preco < 100) return preco * 0.14 + 16;
  if (preco < 200) return preco * 0.14 + 20;
  return preco * 0.14 + 26;
}

function montar(escopo: any, id: string, r: any, ctx: Record<string, any>, dinheiroEmJogo: number): Veredito {
  const v = r.veredito || {};
  return {
    escopo, id,
    nivel: v.nivel || "amarelo",
    titulo: preencher(v.titulo || "", ctx),
    texto: preencher(v.texto || "", ctx),
    passos: (v.passos || []).map((s: string) => preencher(s, ctx)),
    dinheiro: dinheiroEmJogo,
    fonte: "seller.ia",
  };
}

/* ==================== CAMPANHA ==================== */

function julgarCampanhas(K: any, snap: any, saida: Veredito[]) {
  const camps = snap?.campanhas || {};
  const margemMedia = num(snap?.margemMediaPct);
  const piso = pisoRoas(K, margemMedia);

  for (const id of Object.keys(camps)) {
    const c = camps[id] || {};
    const rep = c.report || c.metricas || {};
    const fmtRegra = formatoDe(K, c);
    const rotulo = fmtRegra?.veredito?.rotulo || "Campanha";

    const gasto = num(rep.gasto) ?? reais(rep.cost);
    const impr = num(rep.impressoes ?? rep.impression);
    const cliques = num(rep.cliques ?? rep.click);
    const pedidos = num(rep.pedidos ?? rep.broad_order);
    const roas = num(rep.roas ?? rep.broad_roi);
    const roasDireto = num(rep.direct_roi);

    // NUNCA usar os campos cpc/cpm da API como taxa
    const cpcReal = gasto && cliques ? gasto / cliques : null;
    const cpmReal = gasto && impr ? (gasto / impr) * 1000 : null;
    const cpa = gasto && pedidos ? gasto / pedidos : null;

    // --- veredito da propria Shopee, quando existir
    const vd = c.verdict || c.metaShopee || null;
    // A meta pode chegar ja em "x" (metaShopee.atual) ou crua em micro
    // (current_roi_two_target). Ler na ordem certa evita 1.060.000x na tela.
    const metaAtual = vd == null ? null
      : (num(vd.atual) ?? (vd.current_roi_two_target != null ? reais(vd.current_roi_two_target) : null));
    const metaSug = vd == null ? null
      : (num(vd.sugerida) ?? (vd.suggested_roi_two_target != null ? reais(vd.suggested_roi_two_target) : null));
    // estimate_gmv_pct vem inflado por 100 (3000 = 30%)
    const ganho = vd == null ? null
      : (num(vd.ganhoGmvPct) ?? (vd.estimate_gmv_pct != null ? vd.estimate_gmv_pct / 100 : null));

    if (metaSug !== null && !proibe(fmtRegra, "meta")) {
      if (metaSug < piso.valor) {
        // a plataforma otimiza GMV, a conta otimiza lucro. Nomear a diferenca.
        saida.push({
          escopo: "campanha", id, nivel: "amarelo", fonte: "seller.ia",
          titulo: "Não siga a meta que a Shopee sugere aqui",
          texto: `Ela recomenda ${fmt(metaSug, 1)}x, e o seu ponto de equilibrio e ${fmt(piso.valor, 1)}x` +
            (piso.origem === "margem" ? " pela sua margem." : " pelo padrão, já que a margem deste produto não está cadastrada.") +
            ` Abaixo do equilíbrio cada real investido volta menos que um real. A recomendação dela otimiza faturamento; a sua conta precisa otimizar lucro.`,
          passos: [
            `Não descer abaixo de ${fmt(piso.valor * 1.2, 1)}x`,
            piso.origem === "padrao" ? "Cadastre o custo deste produto no Cofre para o equilíbrio virar exato" : "Desça em degraus de 20% e meça 7 dias",
            "Pare quando o lucro em reais parar de crescer, não quando o ROAS parar de cair",
          ],
          dinheiro: gasto || 0,
        });
      } else if (metaAtual !== null && metaAtual > metaSug * 1.2) {
        const lucroHoje = lucroDe(gasto, roas, margemMedia);
        saida.push({
          escopo: "campanha", id, nivel: "vermelho", fonte: "shopee",
          titulo: "A Shopee considera sua meta alta demais",
          texto: `Sua meta e ${fmt(metaAtual, 1)}x e ela recomenda ${fmt(metaSug, 1)}x` +
            (ganho !== null ? `, projetando ${fmt(ganho, 0)}% mais faturamento` : "") +
            `. Meta alta te tira dos leilões: economiza por impressão e perde volume.` +
            (lucroHoje !== null ? ` Hoje esta campanha deixa ${dinheiro(lucroHoje)} de lucro.` : ""),
          passos: [
            `Seu equilíbrio é ${fmt(piso.valor, 1)}x, então há espaço entre ${fmt(metaSug, 1)}x e ${fmt(metaAtual, 1)}x`,
            "Desça em degraus de até 20% por vez",
            "Meça 7 dias antes do próximo degrau",
            "Pare quando o lucro em reais parar de crescer",
          ],
          dinheiro: gasto || 0,
        });
      }
    }

    // --- leitura exclusiva do Grupo de Anuncios
    if (fmtRegra?.chave === "grupo_de_anuncios" && roas && roasDireto) {
      const dist = roas / roasDireto;
      if (dist >= 2) {
        saida.push({
          escopo: "campanha", id, nivel: "amarelo", fonte: "seller.ia",
          titulo: "Este grupo está vendendo outros produtos",
          texto: `O retorno amplo é ${fmt(roas, 1)}x e o direto é ${fmt(roasDireto, 1)}x. A maior parte da venda atribuída a este grupo não é dos produtos que estão dentro dele.`,
          passos: [
            "Se o faturamento total da loja cresceu no período, o grupo está gerando descoberta e vale manter",
            "Se não cresceu, o grupo está pagando por venda que o orgânico já faria",
            "Não existe custo por produto dentro do grupo: para decidir quem sai, use o retorno de cada item",
          ],
          dinheiro: gasto || 0,
        });
      }
    }

    // --- alerta de formato sem meta rodando solto
    if (fmtRegra?.chave === "anuncio_automatico_loja") {
      const inicio = num(c.campaign?.start_time);
      const dias = inicio ? Math.round((Date.now() / 1000 - inicio) / 86400) : null;
      if (dias && dias > 60) {
        saida.push({
          escopo: "campanha", id, nivel: "amarelo", fonte: "seller.ia",
          titulo: "Anúncio de loja rodando há meses sem meta",
          texto: `Este formato não tem meta de ROAS: o único controle é o orçamento. Está ativo há ${dias} dias` +
            (gasto ? `, com ${dinheiro(gasto)} no periodo.` : "."),
          passos: ["Confira se o retorno justifica", "Se não houver leitura de resultado, reduza o orçamento ao piso ou pause"],
          dinheiro: gasto || 0,
        });
      }
    }

    // --- eficiencia, sempre com metrica derivada
    if (roas !== null && gasto) {
      if (roas < 1) {
        saida.push({
          escopo: "campanha", id, nivel: "vermelho", fonte: "seller.ia",
          titulo: "Cada real investido aqui volta menos que um real",
          texto: `Gastou ${dinheiro(gasto)} e devolveu ${fmt(roas, 2)}x` +
            (cpa ? `. Cada pedido custou ${dinheiro(cpa)}` : "") +
            (cpcReal ? ` e cada clique ${dinheiro(cpcReal)}.` : "."),
          passos: ["Antes de mexer em meta, confirme se o produto converte", "Se a página não vende, mais tráfego só aumenta o prejuízo"],
          dinheiro: gasto,
        });
      }
    }
    void cpmReal; void rotulo;
  }
}

/* ==================== CONTA ==================== */

function julgarConta(K: any, snap: any, saida: Veredito[]) {
  const c = snap?.conta?.campos || snap?.conta || {};
  const fontes = snap?.fontes || {};
  const alerta = limiar(K, "dependencia_ads", "alerta", 50);
  const severo = limiar(K, "dependencia_ads", "severo", 95);
  const adsPct = pct(fontes.adsPct);

  if (adsPct !== null && adsPct >= alerta) {
    saida.push({
      escopo: "conta", nivel: adsPct >= severo ? "vermelho" : "amarelo", fonte: "seller.ia",
      titulo: `${fmt(adsPct, 0)}% do faturamento vem de Shopee Ads`,
      texto: adsPct >= severo
        ? "Praticamente toda a venda depende de anúncio. Se o investimento parar, a loja para."
        : "Mais da metade da venda depende de anúncio. O orgânico não sustenta a loja hoje.",
      passos: [
        "Escolha os produtos que já convertem e trabalhe a ficha deles para ganhar orgânico",
        "Não reduza o anúncio antes de o orgânico crescer",
      ],
      dinheiro: num(c.gmv) || 0,
    });
  }

  const pen = num(c.pontosPenalidade);
  if (pen && pen > 0) {
    saida.push({
      escopo: "conta", nivel: "vermelho", fonte: "shopee",
      titulo: `A conta tem ${fmt(pen, 0)} ponto(s) de penalidade`,
      texto: "Conta penalizada tem alcance reduzido. Otimizar anúncio antes de resolver isso é investir num teto mais baixo.",
      passos: ["Resolva a penalidade antes de escalar investimento"],
      dinheiro: (num(c.gmv) || 0) + 1e9, // sobe para o topo da fila
    });
  }
}

/* ==================== ORQUESTRACAO ==================== */

function ordenar(v: Veredito[]) {
  const peso: Record<string, number> = { vermelho: 3, amarelo: 2, verde: 1, cinza: 0 };
  return v.sort((a, b) => {
    if (peso[a.nivel] !== peso[b.nivel]) return peso[b.nivel] - peso[a.nivel];
    return (b.dinheiro || 0) - (a.dinheiro || 0);   // dinheiro em jogo, nao gravidade
  });
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, erro: "json invalido" }, 400); }

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let K: any;
  try { K = await carregarConhecimento(supa); }
  catch (e) { return json({ ok: false, erro: String(e) }, 500); }

  const snap = body.snapshot || body.snap || {};
  const loja = String(body.loja || snap?.loja?.shop_id || "desconhecida");

  const vereditos: Veredito[] = [];
  try { julgarConta(K, snap, vereditos); } catch (_e) { /* nunca derruba a resposta */ }
  try { julgarCampanhas(K, snap, vereditos); } catch (_e) { /* idem */ }
  try { julgarProdutos(K, snap, vereditos); } catch (_e) { /* idem */ }
  ordenar(vereditos);

  try {
    await supa.from("diagnosticos").insert({
      shop_id: loja,
      rules_version: K.versao,
      code_version: CODE_VERSION,
      vereditos,
    });
  } catch (_e) { /* log e opcional */ }

  return json({
    ok: true,
    loja,
    rules_version: K.versao,
    code_version: CODE_VERSION,
    regras_carregadas: K.total,          // prova que a tabela foi lida
    regras_por_dominio: K.contagem,      // e quais dominios chegaram
    total: vereditos.length,
    vereditos,
  });
});

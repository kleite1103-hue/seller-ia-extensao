// ============================================================
// SELLER.IA — CEREBRO v1 (Edge Function)
// Supabase Dashboard > Edge Functions > Deploy new function
// Nome da function: cerebro  ->  colar este arquivo inteiro
// ------------------------------------------------------------
// Recebe o snapshot da extensao, grava no banco e devolve os
// vereditos do metodo (regras oCPM v1). As regras vivem AQUI,
// no servidor — nunca na extensao.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const RULES_VERSION = "ocpm-1.0";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "content-type": "application/json" } });

// ---------- utilidades ----------
type Num = number | null | undefined;
const n = (v: Num): number => (typeof v === "number" && isFinite(v) ? v : 0);
const reais = (v: number) => "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const x2 = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Veredito {
  escopo: "conta" | "campanha" | "produto";
  id: string;
  nome: string;
  status: "forte" | "atencao" | "critico";
  veredito: string;
  manchete: string;
  diagnostico: string;
  acao: { fazer: string; se_fizer: string; se_nao_fizer: string };
}

// ---------- regras (metodo Efeito Vendas · oCPM) ----------
// Calibragens deliberadamente no servidor. Sem Cofre (Etapa 3),
// o ponto de empate usa piso conservador da conta.
const CONFIG = {
  ruido_pedidos: 30,        // Lei da Legibilidade: < 30 conversoes = zona de ruido
  maduro_pedidos: 20,       // produto/campanha madura p/ Meta de ROAS
  roas_piso: 6,             // piso conservador sem margem cadastrada (Cofre substitui)
  escala_fator: 1.5,        // ROAS >= 1.5x do piso e legivel -> escalar
  mix_ads_teto: 0.68,       // faixa saudavel de dependencia de ads (topo)
  mix_ads_piso: 0.54,       //                                    (base)
  cliques_sem_venda: 50,    // gastou cliques sem pedido -> problema de oferta/pagina
};

function analisarConta(snap: any, saida: Veredito[]) {
  const campanhas = Object.values(snap?.campanhas ?? {}) as any[];
  let gastoAds = 0, gmvAds = 0;
  for (const c of campanhas) { gastoAds += n(c?.metricas?.gasto); gmvAds += n(c?.metricas?.gmv); }

  // GMV pago da loja vem das Informacoes Gerenciais (paid_gmv.value)
  const campos = snap?.conta?.campos ?? {};
  const gmvLoja = n(campos["paid_gmv.value"]) || n(campos["key_metrics.sales"]);

  if (gmvLoja > 0 && gmvAds > 0) {
    const mix = Math.min(gmvAds / gmvLoja, 1);
    const pct = Math.round(mix * 100);
    if (mix > CONFIG.mix_ads_teto) {
      saida.push({
        escopo: "conta", id: "mix", nome: "Dependencia de anuncios",
        status: "atencao", veredito: "FORTALECER ORGANICO",
        manchete: `Ads responde por ~${pct}% do faturamento — acima da faixa saudavel (54–68%).`,
        diagnostico: `GMV via ads ${reais(gmvAds)} contra ${reais(gmvLoja)} de vendas pagas. O trafego pago esta carregando a loja; o organico nao sustenta sozinho. Atencao: as janelas de ads e da loja podem diferir — confirme os periodos.`,
        acao: {
          fazer: "Fortalecer o card (foto principal, preco, titulo) e fontes gratuitas antes de escalar mais verba.",
          se_fizer: "O organico cresce, o mix volta a faixa saudavel e cada real de ads rende mais.",
          se_nao_fizer: "Qualquer instabilidade no ads derruba o faturamento inteiro da loja.",
        },
      });
    } else if (mix < CONFIG.mix_ads_piso) {
      saida.push({
        escopo: "conta", id: "mix", nome: "Espaco para investir",
        status: "forte", veredito: "ACELERAR ADS",
        manchete: `Ads responde por ~${pct}% do faturamento — ha espaco para investir mais.`,
        diagnostico: `GMV via ads ${reais(gmvAds)} contra ${reais(gmvLoja)} de vendas pagas. A loja tem base organica forte e pode acelerar o pago sem risco de dependencia.`,
        acao: {
          fazer: "Aumentar orcamento das campanhas vencedoras em +20% por semana.",
          se_fizer: "Crescimento com seguranca, mantendo o organico como alicerce.",
          se_nao_fizer: "Dinheiro na mesa: concorrentes ocupam o espaco pago da categoria.",
        },
      });
    } else {
      saida.push({
        escopo: "conta", id: "mix", nome: "Mix de faturamento",
        status: "forte", veredito: "MANTER",
        manchete: `Mix pago/organico saudavel (~${pct}% via ads).`,
        diagnostico: `GMV via ads ${reais(gmvAds)} sobre ${reais(gmvLoja)} de vendas pagas — dentro da faixa 54–68% do metodo.`,
        acao: {
          fazer: "Manter a estrategia atual e acompanhar semanalmente.",
          se_fizer: "Equilibrio preservado entre alcance pago e base organica.",
          se_nao_fizer: "—",
        },
      });
    }
  }
}

function analisarCampanha(c: any, saida: Veredito[]) {
  const m = c?.metricas ?? {};
  const id = String(c?.id ?? "");
  const nome = c?.nome || "(campanha)";
  const gasto = n(m.gasto), gmv = n(m.gmv), pedidos = n(m.pedidos), cliques = n(m.cliques);
  const roas = m.roas != null ? n(m.roas) : (gasto > 0 ? gmv / gasto : 0);
  const pausada = c?.estado && c.estado !== "ongoing" && c.estado !== "Ativa";
  if (gasto === 0 && pedidos === 0 && !pausada) return; // sem dados uteis

  const piso = CONFIG.roas_piso;
  const legivel = pedidos >= CONFIG.ruido_pedidos;

  // 1) Gastou, teve cliques e nao vendeu -> problema de oferta/pagina, nao de campanha
  if (gasto > 0 && pedidos === 0 && cliques >= CONFIG.cliques_sem_venda) {
    saida.push({
      escopo: "campanha", id, nome, status: "critico", veredito: "CORRIGIR",
      manchete: `Gastou ${reais(gasto)} com ${cliques} cliques e nenhuma venda.`,
      diagnostico: "O anuncio atrai clique mas a pagina nao converte: o problema esta na oferta (preco, foto, avaliacoes, frete), nao no leilao. Pausar sem corrigir so adia; escalar queima verba.",
      acao: {
        fazer: "Revisar preco vs concorrencia, foto principal e primeira dobra da pagina antes de mexer na campanha.",
        se_fizer: "Cada clique ja pago passa a ter chance real de virar pedido.",
        se_nao_fizer: "A verba continua comprando visita para uma pagina que nao fecha venda.",
      },
    });
    return;
  }

  // 2) Zona de ruido — Lei da Legibilidade
  if (!legivel) {
    saida.push({
      escopo: "campanha", id, nome, status: "atencao", veredito: "AVALIAR",
      manchete: `Apenas ${pedidos} pedido(s) no periodo — zona de ruido estatistico.`,
      diagnostico: `Abaixo de ${CONFIG.ruido_pedidos} conversoes o ROAS (${x2(roas)}x) e ilegivel: pode dobrar ou cair pela metade por puro acaso. Otimizar agora e reagir a barulho, nao a sinal.`,
      acao: {
        fazer: "Alimentar com orcamento estavel ou aguardar acumular 30 conversoes antes de qualquer decisao.",
        se_fizer: "A leitura fica confiavel e a proxima decisao sera baseada em sinal real.",
        se_nao_fizer: "Risco classico: pausar um futuro campeao ou escalar um numero de sorte.",
      },
    });
    return;
  }

  // 3) Legivel: comparar com o ponto de empate
  if (roas >= piso * CONFIG.escala_fator) {
    saida.push({
      escopo: "campanha", id, nome, status: "forte", veredito: "ESCALAR",
      manchete: `ROAS ${x2(roas)}x com ${pedidos} pedidos — vencedora com folga.`,
      diagnostico: `Bem acima do ponto de referencia (${piso}x) com volume legivel. E exatamente o perfil que merece mais verba — em degraus, sem choque.`,
      acao: {
        fazer: "Subir o orcamento em +20% e reavaliar em 7 dias; repetir enquanto o ROAS segurar.",
        se_fizer: "Crescimento composto sobre o que ja funciona.",
        se_nao_fizer: "Teto artificial em cima do seu melhor ativo de trafego.",
      },
    });
  } else if (roas >= piso) {
    saida.push({
      escopo: "campanha", id, nome, status: "forte", veredito: "MANTER",
      manchete: `ROAS ${x2(roas)}x — acima do ponto de referencia, operacao saudavel.`,
      diagnostico: `Com ${pedidos} pedidos o numero e confiavel. Cadastre o custo do produto (Cofre, em breve) para trocar o piso generico de ${piso}x pelo SEU ponto de empate real.`,
      acao: {
        fazer: "Manter orcamento e acompanhar a tendencia semanal.",
        se_fizer: "Estabilidade e leitura limpa para decidir a proxima escala.",
        se_nao_fizer: "—",
      },
    });
  } else {
    saida.push({
      escopo: "campanha", id, nome, status: "atencao", veredito: "OTIMIZAR",
      manchete: `ROAS ${x2(roas)}x abaixo do ponto de referencia (${piso}x).`,
      diagnostico: `Volume legivel (${pedidos} pedidos), entao o sinal e real — mas a resposta do metodo NAO e pausar: cortar destroi o faturamento sem devolver eficiencia, e parte dos produtos se recupera. O caminho e otimizar a ponta fraca do funil.`,
      acao: {
        fazer: "Identificar a etapa fraca (CTR baixo = criativo; conversao baixa = pagina/preco) e corrigir; so considerar pausa apos 2 ciclos sem resposta.",
        se_fizer: "O ROAS sobe pela causa raiz, preservando o volume ja conquistado.",
        se_nao_fizer: "Ou a verba segue rendendo pouco, ou um corte precipitado leva junto o GMV.",
      },
    });
  }

  // 4) Estrategia de lance vs maturidade
  const estrategia = String(c?.estrategia ?? "");
  if (/Automatico/i.test(estrategia) && pedidos >= CONFIG.maduro_pedidos) {
    saida.push({
      escopo: "campanha", id: id + ":lance", nome, status: "atencao", veredito: "MIGRAR LANCE",
      manchete: "Campanha madura ainda no lance Automatico.",
      diagnostico: `Com ${pedidos} pedidos o algoritmo ja aprendeu o publico. O Automatico serve para a fase de aprendizado; na maturidade, a Meta de ROAS ancora a eficiencia e protege de turbulencia.`,
      acao: {
        fazer: "Migrar para Meta de ROAS partindo do ROAS atual (nunca meta agressiva de inicio) e nao mexer por 7 dias.",
        se_fizer: "Eficiencia ancorada — o metodo mediu: contas em Meta de ROAS atravessam turbulencia estaveis.",
        se_nao_fizer: "O Automatico segue otimizando por volume, nao pelo SEU ponto de lucro.",
      },
    });
  }

  // 5) Queda forte de entrega vs periodo anterior
  const varGasto = c?.variacao?.gasto;
  if (typeof varGasto === "number" && varGasto <= -0.3 && !pausada) {
    saida.push({
      escopo: "campanha", id: id + ":queda", nome, status: "atencao", veredito: "INVESTIGAR",
      manchete: `Entrega caiu ${Math.round(Math.abs(varGasto) * 100)}% vs periodo anterior.`,
      diagnostico: "Queda de gasto com campanha ativa costuma indicar perda de leilao: funil enfraquecendo (CTR/conversao) encarece o CPM efetivo e o algoritmo entrega menos. Nao e punicao — e o leilao reverso operando.",
      acao: {
        fazer: "Conferir posicao media e CTR na tendencia; reforcar criativo/oferta antes de subir lance.",
        se_fizer: "Recupera entrega pagando pelo funil, nao pelo lance.",
        se_nao_fizer: "A campanha murcha aos poucos e a receita some sem alarde.",
      },
    });
  }
}

function analisar(snap: any): Veredito[] {
  const saida: Veredito[] = [];
  analisarConta(snap, saida);
  const campanhas = Object.values(snap?.campanhas ?? {}) as any[];
  campanhas.sort((a, b) => n(b?.metricas?.gasto) - n(a?.metricas?.gasto));
  for (const c of campanhas.slice(0, 25)) analisarCampanha(c, saida);
  return saida;
}

// ---------- servidor ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erro: "metodo" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, erro: "json invalido" }, 400); }

  const snap = body?.snapshot;
  if (!snap || typeof snap !== "object") return json({ ok: false, erro: "snapshot ausente" }, 400);
  const raw = JSON.stringify(snap);
  if (raw.length > 900_000) return json({ ok: false, erro: "snapshot grande demais" }, 413);

  const shop = String(body?.loja ?? snap?.loja?.shop_id ?? "desconhecida").slice(0, 60);
  const nomeLoja = String(snap?.loja?.nome ?? "").slice(0, 120);

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // grava (conta, snapshot bruto, resumos, diagnostico) — falha de gravacao nao bloqueia o veredito
  const agora = new Date().toISOString();
  try {
    await supa.from("contas").upsert({ shop_id: shop, nome: nomeLoja || null, visto_em: agora });
    await supa.from("snapshots").insert({ shop_id: shop, dados: snap });
    const camps = Object.values(snap?.campanhas ?? {}) as any[];
    if (camps.length) {
      await supa.from("snapshots_campanha").insert(camps.slice(0, 200).map((c: any) => ({
        shop_id: shop, campaign_id: String(c?.id ?? ""), nome: c?.nome ?? null,
        estado: c?.estado ?? null, estrategia: c?.estrategia ?? null,
        metricas: c?.metricas ?? {}, variacao: c?.variacao ?? null,
      })));
    }
    const prods = Object.values(snap?.produtos ?? {}) as any[];
    const comDados = prods.filter((p: any) => p?.metricas && Object.keys(p.metricas).length);
    if (comDados.length) {
      await supa.from("snapshots_produto").insert(comDados.slice(0, 400).map((p: any) => ({
        shop_id: shop, item_id: String(p?.id ?? ""), nome: p?.nome ?? null, metricas: p?.metricas ?? {},
      })));
    }
  } catch (_e) { /* gravacao nao bloqueia analise */ }

  const vereditos = analisar(snap);
  try {
    await supa.from("diagnosticos").insert({ shop_id: shop, rules_version: RULES_VERSION, vereditos });
  } catch (_e) { /* idem */ }

  return json({ ok: true, rules_version: RULES_VERSION, loja: shop, vereditos });
});

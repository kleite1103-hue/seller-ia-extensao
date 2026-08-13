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
// 7. SO RESPONDE COM TOKEN DE SESSAO VALIDO. Sem isso, qualquer um com a
//    chave anon — que vai dentro do ZIP do assinante — chamava daqui de
//    fora e rodava o metodo inteiro sem pagar.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CODE_VERSION = "cerebro-2.1.0";
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
// A API manda taxa como fracao (0,0414 = 4,14%). O corte em 1 e ambiguo:
// conversao de exatamente 1,0% chegaria como 1 e viraria 100%. Um produto
// com 1% de conversao apareceria como "de cada 100, 100 compram" e passaria
// no filtro de vendendo bem. Corte em 0,999: acima disso ja esta em percentual,
// porque taxa real de 100% nao existe em e-commerce.
const pct = (v: any) => { const n = num(v); return n === null ? null : (n < 0.999 ? n * 100 : n); };
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

/* A margem media da conta serve para leitura geral, mas cada produto tem a
   sua. Quando o Cofre traz o custo daquele item, o piso da campanha dele
   passa a ser o piso REAL, nao a media — que e o que a Karina faz na
   planilha de custo que a agencia manda ao cliente. */
function margemDoProduto(snap: any, produtoId: any): number | null {
  if (!produtoId) return null;
  const cofre = snap?.cofre || {};
  const custo = num((cofre.custos || {})[String(produtoId)]);
  if (!custo) return null;
  const p = (snap?.produtos || {})[String(produtoId)] || {};
  const m = p.metricas || p.perf || {};
  let ticket = num(m.ticket_pedido ?? m.ticket);
  if (!ticket) {
    const v = num(m.vendas_pagas ?? m.vendaPaga), pd = num(m.pedidos_pagos ?? m.pedidosPagos);
    if (v && pd) ticket = v / pd;
  }
  if (!ticket || ticket <= 0) return null;
  const emb = num(cofre.embalagem) || 0;
  const imp = ticket * ((num(cofre.imposto) || 0) / 100);
  const com = comissaoFaixa(ticket);
  const liq = ticket - com - custo - emb - imp;
  return (liq / ticket) * 100;
}
function comissaoFaixa(preco: number) {
  if (preco < 80) return preco * 0.20 + 4;
  if (preco < 100) return preco * 0.14 + 16;
  if (preco < 200) return preco * 0.14 + 20;
  return preco * 0.14 + 26;
}

function pisoRoas(K: any, margemPct: number | null) {
  // Margem NEGATIVA (produto vendido abaixo do custo) daria piso negativo,
  // e ai qualquer sugestao da Shopee passaria no teste "abaixo do piso" —
  // o cerebro aprovaria meta que da prejuizo. Sem piso possivel: nenhum
  // ROAS salva quem perde dinheiro na venda em si.
  if (margemPct !== null && margemPct <= 0) {
    return { valor: Infinity, origem: "margem_negativa" as const };
  }
  // Margem muito baixa gera piso estratosferico (1% -> 100x). Teto no maximo
  // configuravel da plataforma, senao o texto vira ficcao.
  if (margemPct && margemPct > 0) {
    return { valor: Math.min(100 / margemPct, 50), origem: "margem" as const };
  }
  return { valor: limiar(K, "roas_piso_padrao", "valor", 8), origem: "padrao" as const };
}

function lucroDe(gasto: number | null, roas: number | null, margemPct: number | null) {
  if (!gasto || !roas || !margemPct) return null;
  return gasto * (roas * (margemPct / 100) - 1);
}


/* ==================== A REGUA DA PROPRIA LOJA ====================
   Julgar "37 cliques e nenhuma venda" contra um limiar fixo e errado: numa
   loja que converte a cada 20 cliques isso e um problema real; numa que
   converte a cada 200, e o comportamento normal e a sugestao seria ruido.
   O certo e comparar cada produto com a MEDIA DA PROPRIA LOJA — e so
   apontar problema quando ha volume suficiente para a leitura significar
   alguma coisa. */

interface Regua {
  conversaoMedia: number | null;
  ctrMedio: number | null;
  ticketMedio: number | null;
  cliquesPorVenda: number | null;   // quantos cliques esta loja gasta por venda
  amostra: number;
}

function calcularRegua(snap: any): Regua {
  const prods = snap?.produtos || {};
  let somaConv = 0, nConv = 0, somaCtr = 0, nCtr = 0;
  let totCliques = 0, totPedidos = 0, somaTicket = 0, nTicket = 0;

  for (const k of Object.keys(prods)) {
    const m = prods[k]?.metricas || prods[k]?.perf || {};
    const visitas = num(m.visitantes ?? m.uv);
    if (visitas === null || visitas < 30) continue;   // ruido nao entra na media
    const cv = pct(m.conversao_pago ?? m.convPago);
    if (cv !== null) { somaConv += cv; nConv++; }
    const ct = pct(m.ctr_card ?? m.ctr);
    if (ct !== null) { somaCtr += ct; nCtr++; }
    const cl = num(m.cliques ?? m.click);
    const pd = num(m.pedidos_pagos ?? m.pedidosPagos);
    if (cl !== null) totCliques += cl;
    if (pd !== null) totPedidos += pd;
    const tk = num(m.ticket_pedido ?? m.ticket);
    if (tk !== null && tk > 0) { somaTicket += tk; nTicket++; }
  }
  return {
    conversaoMedia: nConv ? somaConv / nConv : null,
    ctrMedio: nCtr ? somaCtr / nCtr : null,
    ticketMedio: nTicket ? somaTicket / nTicket : null,
    cliquesPorVenda: totPedidos > 0 ? totCliques / totPedidos : null,
    amostra: nConv,
  };
}

/* Quantos cliques esta loja precisa antes de "nao vendeu" significar algo.
   Duas vezes a media da loja: abaixo disso e cedo demais para concluir. */
function cliquesMinimosParaJulgar(r: Regua): number {
  if (r.cliquesPorVenda && r.amostra >= 3) return Math.max(30, Math.ceil(r.cliquesPorVenda * 2));
  return 100;   // sem regua propria, usa um piso conservador
}

/* ==================== PRODUTO ==================== */

function julgarProdutos(K: any, snap: any, saida: Veredito[]) {
  const produtos = snap?.produtos || {};
  const regua = calcularRegua(snap);
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

    // A loja tem uma regua propria: um produto so e "ruim" comparado ao que
    // esta loja costuma fazer, nunca contra um numero fixo.
    const cliques = num(m.cliques ?? m.click);
    const pedidos0 = num(m.pedidos_pagos ?? m.pedidosPagos) ?? 0;
    const minCliques = cliquesMinimosParaJulgar(regua);
    if (pedidos0 === 0 && cliques !== null && cliques < minCliques && (visitas ?? 0) >= pisoVisitas) {
      saida.push({
        escopo: "produto", id, nivel: "cinza", fonte: "seller.ia",
        titulo: "Ainda cedo para julgar este produto",
        texto: `Recebeu ${fmt(cliques, 0)} cliques e nenhuma venda. Nesta loja, cada venda custa em média ${regua.cliquesPorVenda ? fmt(regua.cliquesPorVenda, 0) : "—"} cliques, então esse volume ainda não diz nada.`,
        passos: [`Reavalie quando passar de ${minCliques} cliques`],
        dinheiro: venda,
      });
      continue;
    }

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
      if (c.conversao_menor_que !== undefined) {
        // limiar relativo: metade da media da loja, com o valor da regra como
        // teto. Numa loja que converte 4%, um produto de 1,5% e ruim mesmo
        // estando acima do limiar fixo de 1%.
        const alvo = regua.conversaoMedia && regua.amostra >= 3
          ? Math.min(c.conversao_menor_que, regua.conversaoMedia * 0.5)
          : c.conversao_menor_que;
        if (!(conv !== null && conv < alvo)) continue;
      }
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
      const com = comissao(ticket, K);
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

// A tabela de comissao vive na tabela `conhecimento` (limiar.degrau_comissao).
// Estava escrita em codigo aqui e na extensao, com a versao em dado nunca
// sendo lida — quando a Shopee mudar a comissao, e ela muda, seria preciso
// republicar codigo, que e exatamente o que a arquitetura deveria evitar.
function comissao(preco: number, K?: any) {
  const faixas = K?.porChave?.["limiar.degrau_comissao"]?.condicao?.faixas;
  if (Array.isArray(faixas) && faixas.length) {
    for (const f of faixas) {
      if (f.ate === null || f.ate === undefined || preco <= Number(f.ate)) {
        return preco * (Number(f.pct) / 100) + Number(f.fixo);
      }
    }
  }
  // fallback: se a tabela nao carregou, usa a vigente para nao travar o julgamento
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
    // ROAS acima de 1000x nao existe em e-commerce real: e escala errada ou
    // campo trocado. Deixar entrar produz veredito "escalando" numa campanha
    // que ninguem deveria escalar.
    let roas = num(rep.roas ?? rep.broad_roi);
    if (roas !== null && (roas > 1000 || roas < 0)) roas = null;
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
      if (piso.origem === "margem_negativa") {
        saida.push({
          escopo: "campanha", id, nivel: "vermelho", fonte: "seller.ia",
          titulo: "Este produto perde dinheiro em cada venda",
          texto: "Pelo custo cadastrado no Cofre, cada unidade vendida sai no prejuízo antes mesmo do anúncio. Nenhuma meta de ROAS resolve isso: mais tráfego só aumenta a perda.",
          passos: ["Reveja preço ou custo antes de investir qualquer valor aqui", "Enquanto a conta não fechar, pausar é mais barato que otimizar"],
          dinheiro: gasto || 0,
        });
      } else if (metaSug < piso.valor) {
        // a plataforma otimiza GMV, a conta otimiza lucro. Nomear a diferenca.
        saida.push({
          escopo: "campanha", id, nivel: "amarelo", fonte: "seller.ia",
          titulo: "Não siga a meta que a Shopee sugere aqui",
          texto: `Ela recomenda ${fmt(metaSug, 1)}x, e o seu ponto de equilíbrio é ${fmt(piso.valor, 1)}x` +
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
            (gasto ? `, com ${dinheiro(gasto)} no período.` : "."),
          passos: ["Confira se o retorno justifica", "Se não houver leitura de resultado, reduza o orçamento ao piso ou pause"],
          dinheiro: gasto || 0,
        });
      }
    }

    // --- eficiencia: SO o caso extremo de nao devolver nem o investido.
    // O resto (abaixo do piso, com folga, gastou sem vender, pausada que
    // rendia) agora e do julgarCampanhasNovo, que usa a regua da conta.
    if (roas !== null && gasto) {
      if (false && roas < 1) {
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


/* ==================== OPORTUNIDADES ====================
   Ate aqui o cerebro so apontava problema. Uma conta boa abria a extensao e
   via uma lista vazia — ou pior, ruido. Consultor de verdade tambem diz onde
   colocar mais dinheiro, nao so onde parar de perder. */

function julgarOportunidades(K: any, snap: any, regua: Regua, saida: Veredito[]) {
  const camps = snap?.campanhas || {};
  const prods = snap?.produtos || {};
  const margem = num(snap?.margemMediaPct);
  const piso = pisoRoas(K, margem);

  // 1) campanhas que batem com folga o piso: e onde escalar custa menos
  const escalaveis: Array<{ id: string; roas: number; gasto: number; lucro: number | null }> = [];
  for (const id of Object.keys(camps)) {
    const r = camps[id]?.report || camps[id]?.metricas || {};
    const g = num(r.gasto) ?? (num(r.cost) !== null ? Number(r.cost) / 100000 : null);
    let ro = num(r.roas ?? r.broad_roi);
    if (ro !== null && (ro > 1000 || ro < 0)) ro = null;
    if (g === null || ro === null || g <= 0) continue;
    if (piso.origem !== "margem_negativa" && ro >= piso.valor * 1.5) {
      escalaveis.push({ id, roas: ro, gasto: g, lucro: lucroDe(g, ro, margem) });
    }
  }
  escalaveis.sort((a, b) => (b.lucro ?? b.gasto) - (a.lucro ?? a.gasto));
  for (const e of escalaveis.slice(0, 3)) {
    const ganho = e.lucro !== null ? e.lucro * 0.2 : null;
    saida.push({
      escopo: "campanha", id: e.id, nivel: "verde", fonte: "seller.ia",
      titulo: "Aqui cabe mais investimento",
      texto: `Entrega ${fmt(e.roas, 1)}x com seu equilíbrio em ${fmt(piso.valor, 1)}x — sobra folga.` +
        (e.lucro !== null ? ` Hoje deixa ${dinheiro(e.lucro)} de lucro com ${dinheiro(e.gasto)} investidos.` : "") +
        (ganho !== null ? ` Subir 20% pode render cerca de ${dinheiro(ganho)} a mais.` : ""),
      passos: [
        "Suba o orçamento em 20%, não mais que isso de uma vez",
        "Meça 7 dias antes do próximo aumento",
        "Se o ROAS cair abaixo do equilíbrio, volte ao valor anterior",
      ],
      dinheiro: e.gasto,
    });
  }

  // 2) produto que converte acima da media da loja e nao tem anuncio:
  //    e o trafego mais barato que existe, porque a pagina ja sabe vender
  if (regua.conversaoMedia && regua.amostra >= 3) {
    const semAds: Array<{ id: string; conv: number; venda: number; nome: string }> = [];
    for (const id of Object.keys(prods)) {
      const p = prods[id] || {};
      const m = p.metricas || p.perf || {};
      const temAds = !!(p.campaignId || m.temAds);
      if (temAds) continue;
      const visitas = num(m.visitantes ?? m.uv);
      const cv = pct(m.conversao_pago ?? m.convPago);
      if (visitas === null || visitas < 100 || cv === null) continue;
      if (cv >= regua.conversaoMedia * 1.3) {
        semAds.push({ id, conv: cv, venda: num(m.vendas_pagas ?? m.vendaPaga) ?? 0, nome: p.nome || id });
      }
    }
    semAds.sort((a, b) => b.venda - a.venda);
    for (const s of semAds.slice(0, 3)) {
      saida.push({
        escopo: "produto", id: s.id, nivel: "verde", fonte: "seller.ia",
        titulo: "Vende sozinho e ainda não tem anúncio",
        texto: `Converte ${fmt(s.conv, 1)}% contra a média de ${fmt(regua.conversaoMedia, 1)}% da loja, sem nenhum investimento. É o tráfego mais barato que você pode comprar, porque a página já provou que vende.`,
        passos: [
          "Comece com orçamento pequeno e meta de ROAS igual ao seu equilíbrio",
          "Este é o primeiro lugar para colocar dinheiro novo",
        ],
        dinheiro: s.venda,
      });
    }
  }
}


/* ==================== CPM — LEITURA CORRETA ====================
   Correcao conceitual apontada pela Karina em 03/08/2026.
   No oCPM o CPM NAO e uma taxa que voce paga: e o preco que o algoritmo
   calculou que sua impressao vale. Pela lei do leilao:

       eCPM = lance x CTR x 1000
       CPM  = (Ticket x Conversao x CTR x 1000) / ROAS

   Ou seja, CPM alto e CONSEQUENCIA de ticket bom, boa conversao e bom CTR.
   E bonificacao por funil de qualidade, nao desperdicio. Eu tinha escrito
   "esta pagando caro para aparecer" como se fosse defeito — errado.

   O CPM so vira problema num caso: alto E sem venda. Ai o algoritmo previu
   conversao que nao aconteceu, e voce paga premium por atencao que nao
   converte. CPM sozinho nao diz nada; ele so tem leitura junto do resultado. */

function cpmDe(rep: any): number | null {
  const g = num(rep.gasto) ?? (num(rep.cost) !== null ? Number(rep.cost) / 100000 : null);
  const i = num(rep.impressoes ?? rep.impression);
  return (g && i) ? (g / i) * 1000 : null;
}

/* O CPM que a conta PRECISARIA entregar para bater a meta, pela lei do
   leilao. Comparado com o real, mostra se o algoritmo esta cobrando acima
   ou abaixo do que a matematica do produto sustenta. */
function cpmAlvo(ticket: number | null, conv: number | null, ctr: number | null, metaRoas: number | null): number | null {
  if (!ticket || !conv || !ctr || !metaRoas || metaRoas <= 0) return null;
  return (ticket * (conv / 100) * (ctr / 100) * 1000) / metaRoas;
}

function lerCpm(rep: any, roas: number | null, pedidos: number, R: ReguaConta, ticket: number | null, conv: number | null, ctr: number | null, metaRoas: number | null) {
  const cpm = cpmDe(rep);
  if (cpm === null) return null;
  const media = R.cpmMedio;
  const acima = media !== null && cpm > media * 1.3;
  const abaixo = media !== null && cpm < media * 0.7;
  const alvo = cpmAlvo(ticket, conv, ctr, metaRoas);

  let leitura = "";
  if (acima && pedidos > 0) {
    leitura = `Voce paga ${dinheiro(cpm)} por mil impressoes contra ${dinheiro(media)} da media da conta — e isso aqui e bom sinal: no oCPM o algoritmo cobra mais quando calcula que a impressao vale mais, e ele so calcula isso quando ticket, conversao e clique deste anuncio estao acima do resto. Voce esta comprando posicao melhor porque o funil merece.`;
  } else if (acima && pedidos === 0) {
    leitura = `Voce paga ${dinheiro(cpm)} por mil impressoes contra ${dinheiro(media)} da media da conta. O algoritmo previu que este anuncio converteria e cobrou premium por isso — mas a venda nao veio. Esse e o unico caso em que CPM alto e problema: premium pago por atencao que nao converte.`;
  } else if (abaixo && pedidos === 0) {
    leitura = `O CPM de ${dinheiro(cpm)} esta abaixo da media da conta (${dinheiro(media)}). O algoritmo esta entregando este anuncio em posicao barata, o que costuma significar que ele nao ve ticket, conversao ou clique suficientes para disputar as posicoes boas.`;
  } else if (cpm !== null) {
    leitura = `CPM de ${dinheiro(cpm)} por mil impressoes` + (media !== null ? `, na faixa da conta (${dinheiro(media)})` : "") + ".";
  }
  if (alvo !== null) {
    leitura += ` Pela matematica deste produto, o CPM que sustenta a meta e ${dinheiro(alvo)}` +
      (cpm > alvo * 1.2 ? " — voce esta pagando acima do que a conta deste produto aguenta." :
       cpm < alvo * 0.8 ? " — ha espaco para disputar posicao melhor sem perder margem." : ", entao esta equilibrado.");
  }
  return { cpm, alvo, leitura, acima, abaixo };
}

/* ==================== REGUA DA CONTA PARA CAMPANHAS ====================
   Regras definidas pela Karina em 03/08/2026 (cerebro/regras-campanha.md).
   O principio: nenhum limiar e fixo. Uma campanha pausada que gerava R$300
   e critica numa loja de R$1.000 e irrelevante numa de R$30.000 — mesmo
   numero, diagnosticos opostos. Onde falta dado para calcular a regua, o
   veredito DIZ qual padrao esta usando e por que. */

interface ReguaConta {
  gmvConta: number | null;
  cliquesPorVenda: number | null;   // quantos cliques esta conta gasta por venda
  cpmMedio: number | null;          // custo por mil impressoes medio da conta
  investimentoTotal: number;
  temCofre: boolean;
}

function reguaConta(snap: any, margem: number | null): ReguaConta {
  const camps = snap?.campanhas || {};
  let cliques = 0, pedidos = 0, gasto = 0, impressoes = 0;
  for (const k of Object.keys(camps)) {
    const r = camps[k]?.report || camps[k]?.metricas || {};
    cliques += num(r.cliques ?? r.click) || 0;
    pedidos += num(r.pedidos ?? r.broad_order) || 0;
    impressoes += num(r.impressoes ?? r.impression) || 0;
    gasto += num(r.gasto) ?? (num(r.cost) !== null ? Number(r.cost) / 100000 : 0);
  }
  const c = snap?.conta?.campos || snap?.conta || {};
  return {
    gmvConta: num(c.gmv ?? c.gmvPago ?? c.vendas),
    cliquesPorVenda: pedidos > 0 ? cliques / pedidos : null,
    cpmMedio: impressoes > 0 ? (gasto / impressoes) * 1000 : null,
    investimentoTotal: gasto,
    temCofre: margem !== null && margem > 0,
  };
}

/* Uma campanha so pode ser julgada quando comprou cliques suficientes para
   esta conta ter chance de vender. Menos que isso e cedo demais. */
function teveChance(cliques: number | null, r: ReguaConta): boolean {
  if (cliques === null) return false;
  if (r.cliquesPorVenda && r.cliquesPorVenda > 0) return cliques >= r.cliquesPorVenda;
  return cliques >= 50;   // sem regua propria, piso conservador
}

function pctDaConta(valor: number | null, r: ReguaConta): number | null {
  if (valor === null || !r.gmvConta || r.gmvConta <= 0) return null;
  return (valor / r.gmvConta) * 100;
}

function julgarCampanhasNovo(K: any, snap: any, saida: Veredito[]) {
  const camps = snap?.campanhas || {};
  const margem = num(snap?.margemMediaPct);
  const piso = pisoRoas(K, margem);
  const R = reguaConta(snap, margem);
  const nota = R.temCofre
    ? ""
    : " Estou usando margem assumida de 25% porque o custo destes produtos nao esta cadastrado no Cofre — cadastre e este numero vira o seu.";

  for (const id of Object.keys(camps)) {
    const c = camps[id] || {};
    const rep = c.report || c.metricas || {};
    const fmtRegra = formatoDe(K, c);
    const ehGrupo = fmtRegra?.chave === "grupo_de_anuncios";
    const avisoGrupo = ehGrupo
      ? " Este e um Grupo de Anuncios: a Shopee nao entrega metrica por produto dentro dele. Para eu analisar item a item, abra o grupo no painel, exporte a planilha e suba na aba Cofre — com ela consigo dizer qual produto sustenta e qual parasita o grupo."
      : "";

    // piso do PRODUTO desta campanha quando o custo dele existe no Cofre;
    // so cai para a media da conta quando nao existe
    const margemProd = margemDoProduto(snap, c.produtoId);
    const margemAqui = margemProd !== null ? margemProd : margem;
    const pisoAqui = pisoRoas(K, margemAqui);
    const notaAqui = margemProd !== null
      ? ` O ponto de equilibrio de ${fmt(pisoAqui.valor, 1)}x usa o custo real deste produto, cadastrado no Cofre.`
      : nota;

    const gasto = num(rep.gasto) ?? (num(rep.cost) !== null ? Number(rep.cost) / 100000 : null);
    const cliques = num(rep.cliques ?? rep.click);
    const pedidos = num(rep.pedidos ?? rep.broad_order) ?? 0;
    let roas = num(rep.roas ?? rep.broad_roi);
    if (roas !== null && (roas > 1000 || roas < 0)) roas = null;
    const receita = (gasto !== null && roas !== null) ? gasto * roas : null;
    const estado = String(c.estado || c.state || "").toLowerCase();
    const pausada = estado === "paused" || estado === "ended" || estado === "closed";

    // ---- 1) GASTOU E NAO VENDEU ----
    if (!pausada && gasto && pedidos === 0) {
      if (!teveChance(cliques, R)) {
        saida.push({
          escopo: "campanha", id, nivel: "cinza", fonte: "seller.ia",
          titulo: "Ainda cedo para julgar esta campanha",
          texto: `Gastou ${dinheiro(gasto)} e comprou ${fmt(cliques, 0)} cliques. Nesta conta, cada venda custa em media ${R.cliquesPorVenda ? fmt(R.cliquesPorVenda, 0) : "—"} cliques, entao esse volume ainda nao permite concluir nada.` + avisoGrupo,
          passos: [`Reavalie quando passar de ${R.cliquesPorVenda ? fmt(R.cliquesPorVenda, 0) : "50"} cliques`],
          dinheiro: gasto,
        });
      } else {
        const impr = num(rep.impressoes ?? rep.impression);

        // NAO basta dizer que nao vendeu: e preciso dizer ONDE quebrou.
        // O funil da campanha aponta o degrau, e o produto vinculado aponta
        // o motivo provavel. Sem isso o veredito manda o analista procurar
        // sozinho o que o dado ja responde.
        const ctr = impr ? (Number(cliques) / impr) * 100 : null;
        const prodV = c.produtoId ? (snap?.produtos || {})[String(c.produtoId)] : null;
        const mp = (prodV && (prodV.metricas || prodV.perf)) || {};
        const carrinho = num(mp.carrinho ?? mp.atc);
        const convProd = pct(mp.conversao_pago ?? mp.convPago);
        const preco = num(mp.ticket_pedido ?? mp.ticket);
        const compet = num(prodV?.competitividade);

        const metaCamp = num(c.metaRoas ?? c.roi_two_target);
        const leituraCpm = lerCpm(rep, roas, pedidos, R, preco, convProd, ctr, metaCamp);
        const diag: string[] = [];
        let onde = "";
        if (ctr !== null && ctr < 1.8) {
          onde = "vitrine";
          diag.push(`o card recebe pouco clique: ${fmt(ctr, 1)} de cada 100 que veem clicam, e o normal e ao menos 2`);
        } else if (carrinho !== null && carrinho > 0) {
          onde = "checkout";
          diag.push(`${fmt(carrinho, 0)} pessoas colocaram no carrinho e nenhuma fechou — o freio esta no frete, no prazo ou no preco final`);
        } else if (carrinho === 0 || carrinho === null) {
          onde = "pagina";
          diag.push("ninguem chegou a colocar no carrinho, entao a pagina nao convenceu antes disso");
        }
        if (convProd !== null && convProd > 0) diag.push(`no organico este produto converte ${fmt(convProd, 1)}%, entao a pagina vende — o problema pode ser o publico que o anuncio traz`);
        if (compet !== null && compet < 40) diag.push(`a Shopee marca a competitividade de preco em ${fmt(compet, 0)} de 100, ou seja, caro para a categoria`);
        if (preco !== null) diag.push(`o ticket deste produto e ${dinheiro(preco)}`);

        const passos: string[] = [];
        if (onde === "vitrine") {
          passos.push("Troque a primeira foto e revise o comeco do titulo");
          passos.push("Compare o preco no card com os primeiros da mesma busca");
        } else if (onde === "checkout") {
          passos.push("Confira frete e prazo — e onde a desistencia acontece");
          passos.push("Teste um cupom pequeno em vez de baixar o preco");
        } else {
          passos.push("Abra a pagina no celular e compare com quem aparece na mesma busca");
          passos.push("Verifique variacao sem estoque e avaliacoes sem resposta");
        }
        passos.push("Enquanto a pagina nao fechar venda, mais trafego so aumenta a perda");

        saida.push({
          escopo: "campanha", id, nivel: "vermelho", fonte: "seller.ia",
          titulo: onde === "vitrine" ? "Paga para aparecer e nao recebe clique"
            : onde === "checkout" ? "Enche o carrinho e nao fecha"
            : "Gastou o suficiente para vender e nao vendeu",
          texto: `${dinheiro(gasto)} compraram ${fmt(cliques, 0)} cliques e nenhuma venda. Nesta conta, ${fmt(R.cliquesPorVenda, 0)} cliques normalmente viram um pedido.` +
            (diag.length ? ` ${diag.join("; ")}.` : "") +
            (leituraCpm ? ` ${leituraCpm.leitura}` : "") + avisoGrupo,
          passos,
          dinheiro: gasto,
        });
      }
      continue;
    }

    // ---- 2) PAUSADA QUE RENDIA ----
    if (pausada && receita) {
      const part = pctDaConta(receita, R);
      if (part !== null && part >= 3) {
        // O sistema TEM como conferir a cobertura e a substituta: mandar o
        // analista fazer isso na mao e devolver trabalho que o dado responde.
        let cobertura = "";
        const passosP: string[] = [];
        if (ehGrupo) {
          cobertura = " Como e um Grupo de Anuncios, nao da para saber quais produtos ficaram descobertos sem a planilha do grupo.";
          passosP.push("Exporte a planilha do grupo no painel e suba na Seller.IA para saber quais itens pararam");
        } else if (c.produtoId) {
          const outras = Object.keys(camps).filter((o) => {
            if (o === id) return false;
            const oc = camps[o] || {};
            if (String(oc.produtoId || "") !== String(c.produtoId)) return false;
            const oe = String(oc.estado || oc.state || "").toLowerCase();
            return oe !== "paused" && oe !== "ended" && oe !== "closed";
          });
          if (!outras.length) {
            cobertura = " Nenhuma outra campanha ativa esta anunciando este produto: ele ficou descoberto.";
            passosP.push("Este produto nao tem cobertura: religar esta campanha ou criar uma nova recupera a fonte");
          } else {
            const sub = camps[outras[0]] || {};
            const sr = sub.report || sub.metricas || {};
            const sg = num(sr.gasto) ?? (num(sr.cost) !== null ? Number(sr.cost) / 100000 : null);
            let sro = num(sr.roas ?? sr.broad_roi);
            if (sro !== null && (sro > 1000 || sro < 0)) sro = null;
            const sReceita = (sg !== null && sro !== null) ? sg * sro : null;
            if (sReceita !== null && receita !== null) {
              cobertura = sReceita >= receita
                ? ` A campanha que ocupou o lugar dela rende mais: ${dinheiro(sReceita)} contra ${dinheiro(receita)}. A troca foi boa.`
                : ` A campanha que ocupou o lugar dela rende MENOS: ${dinheiro(sReceita)} contra ${dinheiro(receita)}. A troca custou ${dinheiro(receita - sReceita)} no periodo.`;
              if (sReceita < receita) passosP.push("A substituta rende menos: vale religar a antiga ou revisar a meta da nova");
            } else {
              cobertura = ` Ha ${outras.length} outra(s) campanha(s) ativa(s) para este produto.`;
            }
          }
        } else {
          cobertura = " Nao consegui identificar o produto desta campanha para checar se ficou descoberto.";
        }

        saida.push({
          escopo: "campanha", id, nivel: "amarelo", fonte: "seller.ia",
          titulo: `Esta campanha parada respondia por ${fmt(part, 0)}% do que a loja vende`,
          texto: `Ela gerou ${dinheiro(receita)} com ${dinheiro(gasto)} investidos, e hoje esta pausada.` + cobertura + avisoGrupo,
          passos: passosP.length ? passosP : ["Confirme se a pausa foi decisao sua e se o resultado dela foi substituido"],
          dinheiro: receita,
        });
      }
      continue;
    }

    if (pausada) continue;   // pausada sem receita nao diz nada

    // ---- 3) ABAIXO DO PISO ----
    if (roas !== null && gasto && pisoAqui.origem !== "margem_negativa" && roas < pisoAqui.valor) {
      const lucro = lucroDe(gasto, roas, margemAqui);
      saida.push({
        escopo: "campanha", id, nivel: "vermelho", fonte: "seller.ia",
        titulo: "Vende, mas cada venda sai no negativo",
        texto: `Entrega ${fmt(roas, 1)}x e o seu ponto de equilibrio e ${fmt(pisoAqui.valor, 1)}x.` +
          (lucro !== null ? ` Com ${dinheiro(gasto)} investidos, o resultado e ${dinheiro(lucro)}.` : "") +
          notaAqui + avisoGrupo,
        passos: [
          "Suba a meta em degraus de 20% e meca 7 dias",
          "Se o volume cair sem o lucro subir, o problema e a pagina, nao a meta",
        ],
        dinheiro: gasto,
      });
      continue;
    }

    // ---- 4) COM FOLGA ----
    if (roas !== null && gasto && pisoAqui.origem !== "margem_negativa" && roas >= pisoAqui.valor * 1.5) {
      const lucro = lucroDe(gasto, roas, margemAqui);
      saida.push({
        escopo: "campanha", id, nivel: "verde", fonte: "seller.ia",
        titulo: "Aqui cabe mais investimento",
        texto: `Entrega ${fmt(roas, 1)}x contra o equilibrio de ${fmt(pisoAqui.valor, 1)}x.` +
          (lucro !== null ? ` Deixa ${dinheiro(lucro)} de lucro com ${dinheiro(gasto)} investidos.` : "") +
          notaAqui + avisoGrupo,
        passos: [
          "Suba o orcamento em 20%, nao mais que isso de uma vez",
          "Meca 7 dias antes do proximo aumento",
        ],
        dinheiro: gasto,
      });
    }
  }
  void piso;
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



/* ==================== AUDITORIA DE ENTRADA ====================
   O risco estrutural deste projeto: a API da Shopee nao e documentada e
   pode mudar sem aviso. Se um campo for renomeado, as campanhas somem do
   julgamento e a tela mostra ZERO problemas — uma falha silenciosa que se
   parece com boa noticia, que e o pior tipo possivel numa ferramenta de
   decisao. Isto conta o que chegou e denuncia quando o padrao quebra. */

interface Auditoria {
  campanhas_recebidas: number;
  campanhas_com_roas: number;
  campanhas_com_gasto: number;
  produtos_recebidos: number;
  produtos_com_funil: number;
  alertas: string[];
}

function auditar(snap: any): Auditoria {
  const camps = snap?.campanhas || {};
  const prods = snap?.produtos || {};
  const a: Auditoria = {
    campanhas_recebidas: 0, campanhas_com_roas: 0, campanhas_com_gasto: 0,
    produtos_recebidos: 0, produtos_com_funil: 0, alertas: [],
  };

  for (const k of Object.keys(camps)) {
    a.campanhas_recebidas++;
    const r = camps[k]?.report || camps[k]?.metricas || {};
    if (num(r.roas ?? r.broad_roi) !== null) a.campanhas_com_roas++;
    if (num(r.gasto) !== null || num(r.cost) !== null) a.campanhas_com_gasto++;
  }
  for (const k of Object.keys(prods)) {
    a.produtos_recebidos++;
    const m = prods[k]?.metricas || prods[k]?.perf || {};
    if (num(m.visitantes ?? m.uv) !== null) a.produtos_com_funil++;
  }

  // ESCALA: a Shopee manda dinheiro em micro (x100.000). Se ela passar a
  // mandar em unidade, nao ha erro nenhum — so numeros absurdamente pequenos.
  // Um gasto medio abaixo de um centavo com dezenas de campanhas ativas nao
  // e uma conta economica, e uma mudanca de escala.
  let somaGasto = 0, comValor = 0;
  for (const k of Object.keys(camps)) {
    const r = camps[k]?.report || camps[k]?.metricas || {};
    const g = num(r.gasto) ?? (num(r.cost) !== null ? Number(r.cost) / 100000 : null);
    if (g !== null && g > 0) { somaGasto += g; comValor++; }
  }
  if (comValor >= 10 && somaGasto / comValor < 0.01) {
    a.alertas.push("O valor investido veio numa escala improvavel (media de menos de um centavo por campanha). A Shopee pode ter mudado a unidade dos valores.");
  }
  if (comValor >= 10 && somaGasto / comValor > 500000) {
    a.alertas.push("O valor investido veio numa escala improvavel (media acima de R$ 500 mil por campanha). A Shopee pode ter mudado a unidade dos valores.");
  }

  // as proporcoes sao o sinal: campanha sem ROAS e normal, TODAS sem ROAS nao e
  if (a.campanhas_recebidas >= 5 && a.campanhas_com_roas === 0) {
    a.alertas.push("Nenhuma das " + a.campanhas_recebidas + " campanhas trouxe retorno. O campo de ROAS pode ter mudado de nome na Shopee.");
  } else if (a.campanhas_recebidas >= 10 && a.campanhas_com_roas / a.campanhas_recebidas < 0.3) {
    a.alertas.push("Só " + a.campanhas_com_roas + " de " + a.campanhas_recebidas + " campanhas trouxeram retorno. A leitura pode estar incompleta.");
  }
  if (a.campanhas_recebidas >= 5 && a.campanhas_com_gasto === 0) {
    a.alertas.push("Nenhuma campanha trouxe valor investido. O campo de gasto pode ter mudado.");
  }
  if (a.produtos_recebidos >= 5 && a.produtos_com_funil === 0) {
    a.alertas.push("Nenhum dos " + a.produtos_recebidos + " produtos trouxe dado de visita. O funil de produto pode ter mudado.");
  }
  return a;
}

/* ==================== HISTORICO ====================
   Uma linha por loja por dia. O dia gravado e o dia dos DADOS (D-1),
   nao o da coleta: reabrir a mesma conta tres vezes no dia atualiza a
   mesma linha em vez de criar tres. */

function resumoDiario(snap: any, loja: string, vereditos: Veredito[]) {
  const c = snap?.conta?.campos || snap?.conta || {};
  const num = (v: any) => (typeof v === "number" && isFinite(v) ? v : null);
  const camps = snap?.campanhas || {};
  const prods = snap?.produtos || {};

  let inv = 0, impr = 0, cliq = 0, pedAds = 0, gmvAds = 0, nCamp = 0;
  for (const k of Object.keys(camps)) {
    const r = camps[k]?.report || camps[k]?.metricas || {};
    const g = num(r.gasto) ?? (num(r.cost) !== null ? Number(r.cost) / 100000 : null);
    const ro = num(r.roas ?? r.broad_roi);
    if (g !== null) inv += g;
    if (g !== null && ro !== null) gmvAds += g * ro;
    impr += num(r.impressoes ?? r.impression) || 0;
    cliq += num(r.cliques ?? r.click) || 0;
    pedAds += num(r.pedidos ?? r.broad_order) || 0;
    nCamp++;
  }

  const cont = { vermelho: 0, amarelo: 0, verde: 0, cinza: 0 };
  let cVerm = 0, cAmar = 0, cVerd = 0;
  for (const v of vereditos) {
    if (v.escopo === "produto") (cont as any)[v.nivel] = ((cont as any)[v.nivel] || 0) + 1;
    if (v.escopo === "campanha") {
      if (v.nivel === "vermelho") cVerm++;
      else if (v.nivel === "amarelo") cAmar++;
      else if (v.nivel === "verde") cVerd++;
    }
  }

  const gmv = num(c.vendas ?? c.gmvPago);
  const margem = num(snap?.margemMediaPct);

  // O dia dos dados e D-1 em BRT — MAS quando a leitura e de um periodo
  // passado (o relatorio coleta meses anteriores), gravar como "ontem"
  // sobrescreveria o dia de ontem com numeros de marco. Nesse caso a
  // extensao manda o dia real do recorte.
  const d = new Date(Date.now() - 24 * 3600 * 1000 - 3 * 3600 * 1000);
  const dia = (typeof snap?.diaReferencia === "string" && /^\d{4}-\d{2}-\d{2}$/.test(snap.diaReferencia))
    ? snap.diaReferencia
    : d.toISOString().slice(0, 10);

  return {
    shop_id: loja,
    loja_nome: snap?.loja?.nome || null,
    dia,
    gmv_pago: gmv,
    pedidos_pagos: num(c.pedidos),
    visitantes: num(c.uv ?? c.visitantes),
    visualizacoes: num(c.pv),
    carrinho: num(c.atc),
    conversao_pct: pct(c.conv ?? c.conversaoPaga),
    ticket_medio: num(c.ticket),
    cancelamentos: num(c.cancelados),
    nota_loja: num(c.nota),
    penalidade: num(c.pontosPenalidade),
    ads_investido: inv || null,
    ads_impressoes: impr || null,
    ads_cliques: cliq || null,
    ads_pedidos: pedAds || null,
    ads_gmv: gmvAds || null,
    ads_roas: inv ? gmvAds / inv : null,
    ads_ctr_pct: impr ? (cliq / impr) * 100 : null,
    ads_cpa: pedAds ? inv / pedAds : null,
    ads_campanhas: nCamp || null,
    afil_gmv: num(c.afil_vendas),
    afil_comissao: num(c.afil_comissao),
    afil_pedidos: num(c.afil_pedidos),
    tacos_pct: (gmv && inv) ? (inv / gmv) * 100 : null,
    dependencia_ads_pct: (gmv && gmvAds) ? (gmvAds / gmv) * 100 : null,
    margem_media_pct: margem,
    piso_roas: margem ? 100 / margem : null,
    prod_total: Object.keys(prods).length || null,
    prod_ruins: cont.vermelho || null,
    prod_atencao: cont.amarelo || null,
    prod_bons: cont.verde || null,
    camp_prejuizo: cVerm || null,
    camp_sufocadas: cAmar || null,
    camp_escalando: cVerd || null,
  };
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

  /* ==================== SO COM ASSINATURA ====================
     Esta funcao respondia a qualquer um que tivesse a chave anon — e a chave
     anon vai dentro do ZIP que todo assinante baixa. Bastava abrir o pacote,
     copiar a linha do bg.js e chamar daqui de fora, sem pagar nada, para o
     metodo inteiro rodar.

     Mesma regra da receita: sessao que existe, nao foi encerrada e ainda
     esta no prazo. A extensao manda o token junto do payload. */
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

  let K: any;
  try { K = await carregarConhecimento(supa); }
  catch (e) { return json({ ok: false, erro: String(e) }, 500); }

  const snap = body.snapshot || body.snap || {};
  const loja = String(body.loja || snap?.loja?.shop_id || "desconhecida");

  const auditoria = auditar(snap);
  const vereditos: Veredito[] = [];

  // o alerta entra como veredito no topo: o analista precisa saber que a
  // tela pode estar mentindo, e nao descobrir isso semanas depois
  for (const msg of auditoria.alertas) {
    vereditos.push({
      escopo: "conta", nivel: "vermelho", fonte: "seller.ia",
      titulo: "A leitura desta conta pode estar incompleta",
      texto: msg + " Enquanto isso nao for verificado, a ausencia de alertas nesta tela nao significa que esta tudo bem.",
      passos: ["Avise o time da Seller.IA", "Nao tome decisao com base nesta leitura"],
      dinheiro: 1e12,   // sempre no topo da fila
    });
  }
  try { julgarConta(K, snap, vereditos); } catch (_e) { /* nunca derruba a resposta */ }
  try { julgarCampanhas(K, snap, vereditos); } catch (_e) { /* idem */ }
  try { julgarCampanhasNovo(K, snap, vereditos); } catch (_e) { /* idem */ }
  try { julgarProdutos(K, snap, vereditos); } catch (_e) { /* idem */ }
  try { julgarOportunidades(K, snap, calcularRegua(snap), vereditos); } catch (_e) { /* idem */ }
  ordenar(vereditos);

  // historico: nunca deixa o relatorio ou o veredito falharem por causa dele.
  // `semHistorico` vem quando a leitura e de um periodo passado e nao
  // representa o estado atual da conta.
  // shop_id invalido somaria contas diferentes numa linha so, misturando
  // dado de clientes distintos. Melhor nao gravar do que gravar errado.
  const lojaValida = loja && loja !== "desconhecida" && /^\d+$/.test(loja);
  if (!body.semHistorico && lojaValida) {
    try {
      await supa.rpc("gravar_historico", { p: resumoDiario(snap, loja, vereditos) });
    } catch (_e) { /* noop */ }
  }

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
    auditoria,                            // o que chegou de verdade na entrada
    total: vereditos.length,
    vereditos,
  });
});

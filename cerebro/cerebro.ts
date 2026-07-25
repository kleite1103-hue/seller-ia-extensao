// ============================================================
// SELLER.IA — CEREBRO v1.2 (Edge Function)
// Substituir TODO o codigo da function "cerebro" por este arquivo.
// ------------------------------------------------------------
// ocpm-1.2:
//  - Comunicacao no padrao das IAs Efeito Vendas: linguagem de
//    gente, numeros concretos, acao em passo a passo numerado.
//  - Formato novo: manchete / o que esta acontecendo / faca assim
//    (passos) / impacto. Sem "se fizer / se nao fizer".
//  - Campanhas com poucas vendas viram UM card agrupado.
//  - Analise por PRODUTO (funil da Central de Dados): CTR do card,
//    conversao da pagina, rejeicao, ticket, concentracao, produto
//    vendendo sem ads.
//  - IDs sempre presentes nos vereditos.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const RULES_VERSION = "ocpm-1.3";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "content-type": "application/json" } });

// ---------- utilidades ----------
const SENTINELA = -999999; // Shopee usa -1000000 para "sem dado"
const n = (v: unknown): number => {
  const x = typeof v === "number" && isFinite(v) ? v : 0;
  return x <= SENTINELA ? 0 : x;
};
const temNum = (v: unknown): boolean => typeof v === "number" && isFinite(v) && v > SENTINELA;
const reais = (v: number) => "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const x2 = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pc = (v: number) => x2(v <= 1 ? v * 100 : v) + "%";

interface Veredito {
  escopo: "conta" | "campanha" | "produto" | "grupo";
  id: string;
  nome: string;
  status: "forte" | "atencao" | "critico";
  veredito: string;
  manchete: string;
  diagnostico: string;
  passos: string[];
  impacto: string;
}

const CONFIG = {
  ruido_mes: 30,
  maduro_pedidos: 20,
  roas_piso: 6,
  escala_fator: 1.5,
  mix_teto: 0.68,
  mix_piso: 0.54,
  cliques_sem_venda: 50,
  ctr_card_min: 1.5,     // % — abaixo disso o card nao conquista o clique
  conv_prod_min: 1.0,    // % — conversao da pagina do produto
  rejeicao_max: 35,      // %
  concentracao_max: 0.30 // um produto com 30%+ das vendas da loja
};

function limiarRuido(dias: number | null): number {
  if (!dias || dias <= 0 || dias > 45) return CONFIG.ruido_mes;
  return Math.max(5, Math.round(CONFIG.ruido_mes * (dias / 30)));
}

// ============================================================
// CONTA (Informacoes Gerenciais + Ads)
// ============================================================
function analisarConta(snap: any, saida: Veredito[]) {
  const campanhas = Object.values(snap?.campanhas ?? {}) as any[];
  let gastoAds = 0, gmvAds = 0;
  for (const c of campanhas) { gastoAds += n(c?.metricas?.gasto); gmvAds += n(c?.metricas?.gmv); }
  const campos = snap?.conta?.campos ?? {};
  const v = (k: string) => n(campos[k + ".value"]) || n(campos[k]);
  const gmvLoja = v("paid_gmv") || v("key_metrics.sales");

  if (gmvLoja > 0 && gmvAds > 0) {
    const mix = Math.min(gmvAds / gmvLoja, 1);
    const pct = Math.round(mix * 100);
    if (mix > CONFIG.mix_teto) {
      saida.push({
        escopo: "conta", id: "mix", nome: "Dependencia de anuncios", status: "atencao", veredito: "FORTALECER ORGANICO",
        manchete: `De cada R$100 que a loja vende, ~R$${pct} vem de anuncio.`,
        diagnostico: `As vendas via ads somam ${reais(gmvAds)} de um total de ${reais(gmvLoja)}. A faixa saudavel do metodo e entre 54% e 68%: acima disso, a loja fica pendurada no trafego pago — e o organico, que e a venda que nao custa nada, perde espaco.`,
        passos: [
          "Escolha os 3 produtos que mais vendem e revise a foto principal de cada um: ela precisa vencer a concorrencia na primeira olhada.",
          "Confira o preco desses 3 contra os concorrentes diretos na busca — preco fora de posicao mata a venda organica.",
          "Ative as fontes gratuitas que estiverem paradas: cupom da loja, leve-mais-pague-menos e presenca no feed.",
        ],
        impacto: "Cada ponto de organico recuperado e venda que entra sem pagar leilao — e ainda barateia o proprio ads, porque o algoritmo premia produto que converte.",
      });
    } else if (mix < CONFIG.mix_piso) {
      saida.push({
        escopo: "conta", id: "mix", nome: "Espaco para investir", status: "forte", veredito: "ACELERAR ADS",
        manchete: `So ~R$${pct} de cada R$100 vendidos vem de anuncio — da para investir mais.`,
        diagnostico: `Vendas via ads de ${reais(gmvAds)} sobre ${reais(gmvLoja)} totais. A base organica esta forte e sustenta crescimento pago sem risco.`,
        passos: [
          "Liste as campanhas com melhor retorno no periodo.",
          "Suba o orcamento delas em 20% e espere 7 dias sem mexer.",
          "Repita o aumento enquanto o retorno se mantiver.",
        ],
        impacto: "Crescimento por cima do que ja funciona, com o organico de alicerce.",
      });
    }
  }

  // Ticket medio + degrau de comissao
  const paidGmv = v("paid_gmv"), paidOrder = v("paid_order");
  if (paidGmv > 0 && paidOrder > 0) {
    const ticket = paidGmv / paidOrder;
    if (ticket < 80) {
      saida.push({
        escopo: "conta", id: "ticket", nome: "Ticket medio", status: "atencao", veredito: "SUBIR TICKET",
        manchete: `Ticket medio de ${reais(ticket)} — toda venda paga a comissao mais cara da Shopee (20% + R$4).`,
        diagnostico: `Foram ${reais(paidGmv)} em ${paidOrder} pedidos pagos. Ate R$79,99 a Shopee cobra 20% + R$4 por item vendido; a partir de R$80,00 a comissao cai para 14% + R$16. Hoje a loja inteira opera no degrau mais pesado.`,
        passos: [
          "Monte 2 ou 3 kits com os produtos que mais vendem, com preco entre R$80 e R$99.",
          "Publique como anuncio novo (nao mexa no anuncio que ja vende).",
          "Compare a margem por pedido do kit contra a do item avulso apos 2 semanas.",
        ],
        impacto: "Um pedido de R$85 paga R$27,90 de comissao; dois pedidos de R$42,50 pagam R$25 — mas com o dobro de custo de frete, embalagem e ads. Kit certo = mais margem no mesmo trafego.",
      });
    }
  }

  // Conversao da loja
  const conv = v("conversion_rate");
  if (conv > 0) {
    const pct2 = conv <= 1 ? conv * 100 : conv;
    if (pct2 < 1) {
      saida.push({
        escopo: "conta", id: "conv", nome: "Conversao da loja", status: "atencao", veredito: "OTIMIZAR FUNIL",
        manchete: `De cada 100 visitantes, menos de 1 compra (${x2(pct2)}%).`,
        diagnostico: "O trafego chega, mas a pagina nao fecha a venda. Os suspeitos de sempre, em ordem: preco fora da concorrencia, foto principal fraca, poucas avaliacoes, frete caro na tela final.",
        passos: [
          "Abra seus 3 produtos de maior trafego como se fosse cliente, no celular.",
          "Compare preco e foto com os 3 primeiros concorrentes da busca.",
          "Corrija o que perder na comparacao — um item por vez, para saber o que funcionou.",
        ],
        impacto: "Conversao e o multiplicador da loja inteira: subir de 0,9% para 1,3% e vender 44% mais com o MESMO trafego — e ainda baratear o leilao de todas as campanhas.",
      });
    } else {
      saida.push({
        escopo: "conta", id: "conv", nome: "Conversao da loja", status: "forte", veredito: "PROTEGER",
        manchete: `De cada 100 visitantes, ${x2(pct2)} compram — funil saudavel.`,
        diagnostico: "Essa conversao e o que faz o algoritmo entregar seus anuncios mais barato: quem converte bem paga menos por aparecer. E o seu maior patrimonio invisivel.",
        passos: [
          "Antes de mudar preco ou foto de um produto que vende, teste em anuncio duplicado.",
          "Acompanhe esta taxa toda semana — queda aqui encarece todas as campanhas juntas.",
        ],
        impacto: "Proteger a conversao = manter o leilao barato para a loja inteira.",
      });
    }
  }

  // Carrinho abandonado
  const atc = v("atc_uv"), paidBuyers = v("paid_buyers");
  if (atc > 0 && paidBuyers > 0 && atc > paidBuyers) {
    const abandono = (1 - paidBuyers / atc) * 100;
    if (abandono >= 70) {
      saida.push({
        escopo: "conta", id: "carrinho", nome: "Carrinho abandonado", status: "atencao", veredito: "RECUPERAR",
        manchete: `${atc} pessoas colocaram no carrinho, so ${paidBuyers} pagaram (${Math.round(abandono)}% ficaram pelo caminho).`,
        diagnostico: "Quem adiciona ao carrinho ja decidiu que quer — algo na etapa final trava: quase sempre o frete que aparece na tela de fechamento, ou a falta de um empurrao para concluir agora.",
        passos: [
          "Ative um cupom de loja pequeno (ex: 5% acima de R$40) — ele aparece justamente no carrinho.",
          "Configure leve-mais-pague-menos nos produtos de maior trafego.",
          "Simule uma compra e veja o frete que o cliente ve — se estiver alto, avalie o programa de frete e o CEP de origem.",
        ],
        impacto: "Cada 10% desses carrinhos recuperados = dezenas de pedidos sem gastar um real a mais em trafego.",
      });
    }
  }
}

// ============================================================
// PRODUTOS (funil da Central de Dados — Performance)
// ============================================================
function analisarProdutos(snap: any, saida: Veredito[]) {
  const produtos = Object.values(snap?.produtos ?? {}) as any[];
  const comFunil = produtos.filter((p: any) => temNum(p?.metricas?.visitantes) || temNum(p?.metricas?.vendas_pagas));
  if (!comFunil.length) return;
  comFunil.sort((a: any, b: any) => n(b?.metricas?.vendas_pagas) - n(a?.metricas?.vendas_pagas));

  // Concentracao de vendas
  const top = comFunil[0];
  const fatia = n(top?.metricas?.fatia_vendas);
  if (fatia >= CONFIG.concentracao_max) {
    saida.push({
      escopo: "produto", id: String(top.id), nome: top.nome || "", status: "atencao", veredito: "DESCONCENTRAR",
      manchete: `Um unico produto responde por ${Math.round(fatia * 100)}% das vendas da loja.`,
      diagnostico: `"${(top.nome || "").slice(0, 60)}" carrega a loja. Otimo sinal do produto — e um risco da conta: qualquer soluco nele (estoque, concorrente, avaliacao ruim) derruba o faturamento inteiro.`,
      passos: [
        "Escolha os 2 produtos com melhor funil depois dele (boa conversao, vendas crescendo).",
        "De verba de ads dedicada a esses 2 pelo protocolo de lancamento.",
        "Garanta estoque de seguranca do campeao — ruptura nele e o maior risco da loja hoje.",
      ],
      impacto: "Loja com 3 fortes aguenta tempestade; loja com 1 forte reza para nao chover.",
    });
  }

  // Funil por produto — top 8 por vendas
  for (const p of comFunil.slice(0, 8)) {
    const m = p.metricas || {};
    const id = String(p.id);
    const nome = (p.nome || "(produto)").slice(0, 60);
    const ctr = temNum(m.ctr_card) ? (m.ctr_card <= 1 ? m.ctr_card * 100 : m.ctr_card) : null;
    const conv = temNum(m.conversao_pago) ? (m.conversao_pago <= 1 ? m.conversao_pago * 100 : m.conversao_pago) : null;
    const rej = temNum(m.rejeicao) ? (m.rejeicao <= 1 ? m.rejeicao * 100 : m.rejeicao) : null;
    const ticket = temNum(m.ticket_pedido) ? m.ticket_pedido : null;

    if (ctr !== null && ctr < CONFIG.ctr_card_min) {
      saida.push({
        escopo: "produto", id, nome, status: "atencao", veredito: "TROCAR VITRINE",
        manchete: `CTR do card de ${x2(ctr)}% — o produto aparece muito e e pouco clicado.`,
        diagnostico: `${nome}: de cada 100 pessoas que veem o card na busca, menos de ${Math.ceil(CONFIG.ctr_card_min)} clicam. O problema esta na vitrine — foto principal, preco exibido e promessa do titulo — porque a decisao de clicar acontece antes de abrir a pagina.`,
        passos: [
          "Troque a foto principal por uma com o produto em uso, fundo limpo e beneficio visivel.",
          "Confira se o preco exibido esta competitivo com os 3 primeiros da busca pelo termo principal.",
          "Coloque o beneficio mais forte nas primeiras palavras do titulo.",
        ],
        impacto: "CTR e a porta do funil: dobrar o clique dobra visitante sem pagar um real a mais — e o algoritmo premia com mais exibicao.",
      });
    } else if (conv !== null && conv < CONFIG.conv_prod_min && ctr !== null && ctr >= CONFIG.ctr_card_min) {
      saida.push({
        escopo: "produto", id, nome, status: "atencao", veredito: "ARRUMAR PAGINA",
        manchete: `${nome}: o card atrai (CTR ${x2(ctr)}%), mas so ${x2(conv)}% dos visitantes compram.`,
        diagnostico: "O clique existe — a pagina e que nao fecha. Quando CTR e bom e conversao e fraca, a promessa do card nao esta sendo confirmada la dentro: preco, variacao esgotada, avaliacoes ou frete.",
        passos: [
          "Abra a pagina no celular e confira: a primeira foto interna confirma o que o card prometeu?",
          "Verifique variacoes esgotadas — variacao principal sem estoque derruba conversao na hora.",
          "Responda as ultimas avaliacoes e perguntas: pagina abandonada espanta comprador.",
        ],
        impacto: "Consertar a pagina converte o trafego que voce JA tem — organico e pago ao mesmo tempo.",
      });
    }

    if (rej !== null && rej > CONFIG.rejeicao_max) {
      saida.push({
        escopo: "produto", id, nome, status: "atencao", veredito: "REVISAR PROMESSA",
        manchete: `${nome}: ${x2(rej)}% dos visitantes saem sem interagir com a pagina.`,
        diagnostico: "Rejeicao alta e quebra de expectativa: o cliente clicou esperando uma coisa (preco, modelo, kit) e encontrou outra. O card esta prometendo o que a pagina nao entrega.",
        passos: [
          "Compare a foto do card com a primeira dobra da pagina — precisam contar a mesma historia.",
          "Se o preco do card e 'a partir de', confira se a variacao barata esta disponivel.",
        ],
        impacto: "Alinhar promessa e entrega segura o visitante — e visitante que fica e o unico que compra.",
      });
    }

    if (ticket !== null && ticket >= 60 && ticket < 80) {
      saida.push({
        escopo: "produto", id, nome, status: "forte", veredito: "OPORTUNIDADE DE KIT",
        manchete: `${nome}: ticket de ${reais(ticket)} — a R$${x2(80 - ticket)} do degrau de comissao.`,
        diagnostico: `Este produto vende a ${reais(ticket)} por pedido. Cruzando R$80,00, a comissao cai de 20%+R$4 para 14%+R$16 — a Shopee passa a cobrar menos por venda.`,
        passos: [
          "Crie uma versao kit (2 unidades ou produto + complemento) entre R$80 e R$99.",
          "Publique como anuncio novo e aponte um pouco de ads para validar.",
        ],
        impacto: `No ticket atual, cada venda paga ~${reais(ticket * 0.20 + 4)} de comissao; um kit de R$85 paga R$27,90 — proporcionalmente muito menos, com um so frete e uma so embalagem.`,
      });
    }
  }

  // Produto vendendo bem SEM campanha ativa
  for (const p of comFunil.slice(0, 15)) {
    const m = p.metricas || {};
    if (n(m.vendas_pagas) > 0 && !p.campanha && p.pode_ads) {
      saida.push({
        escopo: "produto", id: String(p.id), nome: (p.nome || "").slice(0, 60), status: "forte", veredito: "LIGAR ADS",
        manchete: `"${(p.nome || "").slice(0, 45)}" vende no organico e esta SEM anuncio.`,
        diagnostico: `${reais(n(m.vendas_pagas))} em vendas sem nenhuma campanha ativa. Produto que converte sozinho e o melhor candidato a ads que existe: o funil ja provou que funciona — falta so dar alcance.`,
        passos: [
          "Crie uma campanha nova para ele: lance Automatico, R$15–30 por dia.",
          "Nao mexa em nada por 7 dias — e a fase de aprendizado do algoritmo.",
          "Depois de 7 dias, avalie aqui no diagnostico se escala ou ajusta.",
        ],
        impacto: "E o caminho de menor risco para vender mais: amplificar o que ja funciona em vez de apostar no que nunca vendeu.",
      });
      break; // um por analise, o melhor candidato
    }
  }
}

// ============================================================
// CAMPANHAS (Ads)
// ============================================================
function analisarCampanhas(snap: any, saida: Veredito[], limiar: number, dias: number | null) {
  const campanhas = (Object.values(snap?.campanhas ?? {}) as any[])
    .sort((a, b) => n(b?.metricas?.gasto) - n(a?.metricas?.gasto));
  const emObservacao: any[] = [];
  const janela = dias ? `${dias} dias` : "no periodo";

  for (const c of campanhas.slice(0, 30)) {
    const m = c?.metricas ?? {};
    const id = String(c?.id ?? "");
    const nome = (c?.nome || "(campanha)").slice(0, 60);
    const gasto = n(m.gasto), gmv = n(m.gmv), pedidos = n(m.pedidos), cliques = n(m.cliques);
    const roas = temNum(m.roas) ? m.roas : (gasto > 0 ? gmv / gasto : 0);
    const pausada = c?.estado && c.estado !== "ongoing" && c.estado !== "Ativa";
    if (gasto === 0 && pedidos === 0) continue;

    // Gastou, clicou, nao vendeu
    if (gasto > 0 && pedidos === 0 && cliques >= CONFIG.cliques_sem_venda) {
      saida.push({
        escopo: "campanha", id, nome, status: "critico", veredito: "CORRIGIR OFERTA",
        manchete: `${nome}: ${reais(gasto)} gastos, ${cliques} cliques, zero vendas.`,
        diagnostico: "O anuncio esta fazendo a parte dele — trazer gente. A pagina e que nao esta fechando nenhuma venda. Pausar sem corrigir so empurra o problema; escalar seria queimar dinheiro.",
        passos: [
          "Compare o preco com os 3 primeiros concorrentes da busca — e o motivo numero 1 de clique sem venda.",
          "Confira estoque das variacoes e as avaliacoes recentes.",
          "So volte a investir depois de mudar algo na oferta.",
        ],
        impacto: "Com a oferta corrigida, os mesmos cliques passam a virar pedido — sem gastar mais.",
      });
      continue;
    }

    // Volume baixo -> agrupar
    if (pedidos < limiar) { emObservacao.push({ nome, pedidos, roas, id }); continue; }

    // Legiveis
    if (roas >= CONFIG.roas_piso * CONFIG.escala_fator) {
      saida.push({
        escopo: "campanha", id, nome, status: "forte", veredito: "ESCALAR",
        manchete: `${nome}: ROAS ${x2(roas)}x com ${pedidos} vendas em ${janela} — vencedora com folga.`,
        diagnostico: `Cada R$1 investido volta ${x2(roas)} em vendas, com volume suficiente para confiar no numero. E o perfil exato que merece mais verba.`,
        passos: [
          "Suba o orcamento diario em 20% (nao mais que isso de uma vez).",
          "Espere 7 dias sem nenhum outro ajuste.",
          "Se o ROAS segurar, repita o aumento na semana seguinte.",
        ],
        impacto: "Escalar em degraus preserva o aprendizado do algoritmo — e transforma sua melhor campanha no motor de crescimento da conta.",
      });
    } else if (roas >= CONFIG.roas_piso) {
      saida.push({
        escopo: "campanha", id, nome, status: "forte", veredito: "MANTER",
        manchete: `${nome}: ROAS ${x2(roas)}x com ${pedidos} vendas — operacao saudavel.`,
        diagnostico: `Acima do ponto de referencia da conta (${CONFIG.roas_piso}x). Quando o Cofre de Custos entrar, este numero sera comparado com o ponto de equilibrio REAL deste produto (baseado na sua margem), e o veredito fica ainda mais preciso.`,
        passos: [
          "Manter orcamento como esta.",
          "Acompanhar semanalmente pelo diagnostico.",
        ],
        impacto: "Estabilidade aqui libera sua atencao para os pontos que precisam de acao.",
      });
    } else {
      saida.push({
        escopo: "campanha", id, nome, status: "atencao", veredito: "OTIMIZAR",
        manchete: `${nome}: ROAS ${x2(roas)}x, abaixo do ponto de referencia (${CONFIG.roas_piso}x).`,
        diagnostico: `Com ${pedidos} vendas o numero e confiavel — e a resposta do metodo NAO e pausar (cortar derruba o faturamento e nao devolve eficiencia). O caminho e achar a etapa fraca do funil e corrigir.`,
        passos: [
          `CTR ${temNum(m.ctr) ? "de " + pc(m.ctr) : "baixo?"} — se estiver abaixo de 1,5%, o problema e a vitrine: troque a foto principal.`,
          "Se o CTR estiver bom, o problema e a pagina: preco, variacoes e avaliacoes.",
          "Faca UMA correcao, espere 7 dias, e reavalie aqui. So pense em pausar apos 2 ciclos sem melhora.",
        ],
        impacto: "Otimizar pela causa raiz recupera o retorno mantendo as vendas que a campanha ja traz.",
      });
    }

    // Estrategia de lance
    if (/Automatico/i.test(String(c?.estrategia ?? "")) && pedidos >= CONFIG.maduro_pedidos) {
      saida.push({
        escopo: "campanha", id: id + ":lance", nome, status: "atencao", veredito: "MIGRAR LANCE",
        manchete: `${nome}: madura (${pedidos} vendas) e ainda no lance Automatico.`,
        diagnostico: "O Automatico e perfeito para a fase de aprendizado. Depois que o algoritmo ja conhece o publico, a Meta de ROAS trava a eficiencia no SEU numero — e protege a campanha em semanas turbulentas.",
        passos: [
          `Anote o ROAS atual da campanha (${x2(roas)}x).`,
          "Mude o lance para Meta de ROAS usando esse mesmo numero como meta (nunca comece com meta mais alta).",
          "Nao mexa em nada por 7 dias.",
        ],
        impacto: "Meta de ROAS partindo do numero atual = mesma entrega, eficiencia protegida. Meta agressiva de inicio = entrega despenca.",
      });
    }

    // Leilao
    const pos = m.posicao;
    if (temNum(pos) && !pausada) {
      const ctr = temNum(m.ctr) ? (m.ctr <= 1 ? m.ctr * 100 : m.ctr) : null;
      if (pos <= 10) {
        saida.push({
          escopo: "campanha", id: id + ":leilao", nome, status: "forte", veredito: "VITRINE NOBRE",
          manchete: `${nome}: posicao media ${Math.round(pos)} — primeira pagina do leilao.`,
          diagnostico: "O algoritmo esta colocando este anuncio onde todo mundo ve. Isso nao se compra so com lance: e o funil (clique + conversao) pagando o espaco. Posicao boa e consequencia, nao sorte.",
          passos: [
            "Nao mude foto, preco ou titulo deste anuncio sem testar em duplicado antes.",
            "Garanta estoque — ruptura aqui joga fora a posicao conquistada.",
          ],
          impacto: "Manter o funil intacto = continuar na vitrine nobre pagando menos que os concorrentes.",
        });
      } else if (pos > 40) {
        const clicaBem = ctr !== null && ctr >= 2;
        saida.push({
          escopo: "campanha", id: id + ":leilao", nome, status: "atencao", veredito: "SUBIR NO LEILAO",
          manchete: `${nome}: posicao media ${Math.round(pos)} — o anuncio aparece onde pouca gente chega.`,
          diagnostico: clicaBem
            ? `Quando aparece, o anuncio e clicado (CTR ${x2(ctr!)}%) — o card esta bom. O que nao esta pagando o leilao e o conjunto preco x conversao da pagina: para cada exibicao, seus concorrentes geram mais venda que voce, entao o algoritmo prefere eles. Por isso subir lance sozinho so encarece: voce pagaria mais pelo mesmo funil.`
            : `O anuncio aparece pouco E e pouco clicado${ctr !== null ? ` (CTR ${x2(ctr)}%)` : ""}. O algoritmo rebaixa card que nao engaja — foto principal e titulo sao o alvo, nao o lance.`,
          passos: clicaBem
            ? [
                "Abra a pagina do produto e ataque a conversao: preco psicologico (ex: 27,90 em vez de 28,50), variacao principal com estoque, avaliacoes respondidas.",
                "Suba o valor que cada venda gera: kit/combo aumenta o ticket, entao cada clique passa a render mais — e e isso que compra posicao no leilao novo, nao o lance.",
                "So depois disso, se quiser, teste um ajuste fino de lance (+10%).",
              ]
            : [
                "Troque a foto principal: produto em uso, fundo limpo, diferencial visivel em miniatura.",
                "Reescreva o inicio do titulo com o beneficio mais buscado.",
                "De 7 dias e acompanhe a posicao aqui no diagnostico.",
              ],
          impacto: "No leilao da Shopee, quem converte melhor paga menos por aparecer. Melhorar o funil sobe a posicao SEM subir o custo — lance so compra posicao enquanto voce paga.",
        });
      }
    }
  }

  // Card agrupado das campanhas em observacao
  if (emObservacao.length) {
    const lista = emObservacao.slice(0, 12)
      .map((c) => `• ${c.nome} — ${c.pedidos} venda(s), ROAS ${x2(c.roas)}x`)
      .join("\n");
    const extra = emObservacao.length > 12 ? `\n...e mais ${emObservacao.length - 12}.` : "";
    saida.push({
      escopo: "grupo", id: "observacao", nome: `${emObservacao.length} campanhas em observacao`, status: "atencao", veredito: "DEIXAR RODAR",
      manchete: `${emObservacao.length} campanhas ainda tem poucas vendas para uma leitura confiavel (${janela}).`,
      diagnostico: `Com poucas vendas, o ROAS engana — pode dobrar ou cair pela metade por acaso, para o bem e para o mal. Decidir agora seria chutar. Elas estao aqui, aguardando volume:\n${lista}${extra}`,
      passos: [
        "Nao pause nem escale nenhuma delas por enquanto.",
        "Mantenha orcamento estavel — o algoritmo precisa de constancia para aprender.",
        `Quando alguma passar de ${Math.max(5, Math.round(30 * ((dias || 30) / 30)))} vendas na janela, ela ganha veredito proprio aqui.`,
      ],
      impacto: "Paciencia nesta fase evita os dois erros classicos: matar um futuro campeao cedo demais ou escalar um golpe de sorte.",
    });
  }
}

function analisar(snap: any): Veredito[] {
  const saida: Veredito[] = [];
  const dias = n(snap?.periodo_ads?.dias) || null;
  const limiar = limiarRuido(dias);
  analisarConta(snap, saida);
  analisarProdutos(snap, saida);
  analisarCampanhas(snap, saida, limiar, dias);
  const peso: Record<string, number> = { critico: 0, atencao: 1, forte: 2 };
  const escopoPeso: Record<string, number> = { conta: 0, produto: 1, campanha: 2, grupo: 3 };
  saida.sort((a, b) => (escopoPeso[a.escopo] - escopoPeso[b.escopo]) || (peso[a.status] - peso[b.status]));
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
  if (JSON.stringify(snap).length > 1_500_000) return json({ ok: false, erro: "snapshot grande demais" }, 413);

  const shop = String(body?.loja ?? snap?.loja?.shop_id ?? "desconhecida").slice(0, 60);
  const nomeLoja = String(snap?.loja?.nome ?? "").slice(0, 120);
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const agora = new Date().toISOString();
  try {
    await supa.from("contas").upsert({ shop_id: shop, nome: nomeLoja || null, visto_em: agora });
    await supa.from("snapshots").insert({ shop_id: shop, dados: snap });
    const camps = Object.values(snap?.campanhas ?? {}) as any[];
    if (camps.length) await supa.from("snapshots_campanha").insert(camps.slice(0, 200).map((c: any) => ({
      shop_id: shop, campaign_id: String(c?.id ?? ""), nome: c?.nome ?? null, estado: c?.estado ?? null,
      estrategia: c?.estrategia ?? null, metricas: c?.metricas ?? {}, variacao: c?.variacao ?? null,
    })));
    const prods = (Object.values(snap?.produtos ?? {}) as any[]).filter((p: any) => p?.metricas && Object.keys(p.metricas).length);
    if (prods.length) await supa.from("snapshots_produto").insert(prods.slice(0, 400).map((p: any) => ({
      shop_id: shop, item_id: String(p?.id ?? ""), nome: p?.nome ?? null, metricas: p?.metricas ?? {},
    })));
  } catch (_e) { /* gravacao nao bloqueia analise */ }

  const vereditos = analisar(snap);
  try { await supa.from("diagnosticos").insert({ shop_id: shop, rules_version: RULES_VERSION, vereditos }); } catch (_e) { /* noop */ }
  return json({ ok: true, rules_version: RULES_VERSION, loja: shop, vereditos });
});

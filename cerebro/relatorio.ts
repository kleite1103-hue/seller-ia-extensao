// ============================================================
// SELLER.IA · GERADOR DE RELATORIO
// Supabase Edge Function · Deno
// ============================================================
// A extensao manda os numeros dos dois periodos e recebe o relatorio
// pronto. O PROMPT NAO VIVE AQUI: ele mora na tabela `conhecimento`,
// dominio 'prompt', chave 'relatorio'. Assim a Karina reescreve o metodo
// sem deploy — e ele nunca chega ao navegador do cliente.
//
// A chave da Anthropic vive nas secrets da funcao. Nunca na extensao.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CODE_VERSION = "relatorio-2.0.0";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

const n = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);
const br = (v: unknown) => (n(v) === null ? "nao disponivel" : "R$ " + Number(v).toFixed(2).replace(".", ","));
const pc = (v: unknown) => (n(v) === null ? "nao disponivel" : Number(v).toFixed(2).replace(".", ",") + "%");
const nu = (v: unknown) => (n(v) === null ? "nao disponivel" : Number(v).toLocaleString("pt-BR"));

function variacao(atual: unknown, ant: unknown) {
  const a = n(atual), b = n(ant);
  if (a === null || b === null || b === 0) return "nao disponivel";
  const d = ((a - b) / Math.abs(b)) * 100;
  return (d >= 0 ? "+" : "") + d.toFixed(2).replace(".", ",") + "%";
}

/* ---------- monta o texto compacto que sobe para o modelo ----------
   Nunca subir o payload cru: sao dezenas de milhares de tokens de ruido
   e o custo por relatorio explode quando forem 251 contas. Aqui viram
   umas poucas dezenas de numeros ja rotulados. */
function montarDados(b: any) {
  const A = b.atual || {}, P = b.anterior || {};
  const cA = A.conta || {}, cP = P.conta || {};
  const aA = A.ads || {}, aP = P.ads || {};
  const fA = A.afiliados || {}, fP = P.afiliados || {};

  const linha = (rot: string, va: unknown, vp: unknown, fmt: (x: unknown) => string) =>
    `${rot}: atual ${fmt(va)} | anterior ${fmt(vp)} | variacao ${variacao(va, vp)}`;

  const L: string[] = [];
  L.push(`LOJA: ${b.loja_nome || b.loja || "nao informado"}`);
  L.push(`PERIODO ATUAL: ${A.periodo || "nao informado"}`);
  L.push(`PERIODO ANTERIOR: ${P.periodo || "nao informado"}`);
  if (n(b.margemMediaPct) !== null) {
    L.push(`MARGEM LIQUIDA MEDIA INFORMADA PELO LOJISTA: ${pc(b.margemMediaPct)}`);
    L.push(`PISO DE ROAS DESTA CONTA (1/margem): ${(100 / Number(b.margemMediaPct)).toFixed(2).replace(".", ",")}x`);
  } else {
    L.push("MARGEM: nao disponivel — use a regra padrao de ROAS 8x e diga no relatorio que a leitura esta limitada por falta do custo dos produtos");
  }

  L.push("\n== CONTA ==");
  L.push(linha("GMV pago", cA.gmvPago, cP.gmvPago, br));
  L.push(linha("Pedidos pagos", cA.pedidosPagos, cP.pedidosPagos, nu));
  L.push(linha("Visitantes", cA.visitantes, cP.visitantes, nu));
  L.push(linha("Conversao real paga", cA.conversaoPaga, cP.conversaoPaga, pc));
  L.push(linha("Ticket medio", cA.ticketMedio, cP.ticketMedio, br));
  L.push(linha("Cancelamentos", cA.cancelamentos, cP.cancelamentos, nu));
  L.push(linha("Visualizacoes de pagina", cA.visualizacoes, cP.visualizacoes, nu));
  L.push(linha("Adicoes ao carrinho", cA.carrinho, cP.carrinho, nu));

  L.push("\n== SHOPEE ADS ==");
  L.push(linha("Investimento", aA.investimento, aP.investimento, br));
  L.push(linha("Impressoes", aA.impressoes, aP.impressoes, nu));
  L.push(linha("Cliques", aA.cliques, aP.cliques, nu));
  L.push(linha("CTR", aA.ctr, aP.ctr, pc));
  L.push(linha("GMV Ads painel", aA.gmvPainel, aP.gmvPainel, br));
  L.push(linha("GMV Ads real pago", aA.gmvReal, aP.gmvReal, br));
  L.push(linha("Pedidos Ads", aA.pedidos, aP.pedidos, nu));
  L.push(linha("ROAS painel", aA.roasPainel, aP.roasPainel, (x) => (n(x) === null ? "nao disponivel" : Number(x).toFixed(2).replace(".", ","))));
  L.push(linha("ROAS real pago", aA.roasReal, aP.roasReal, (x) => (n(x) === null ? "nao disponivel" : Number(x).toFixed(2).replace(".", ","))));
  L.push(linha("CPA Ads", aA.cpa, aP.cpa, br));
  L.push("OBS: CPC e CPM foram derivados de gasto/cliques e gasto/impressoes. Os campos cpc e cpm da API da Shopee nao sao taxa e foram descartados.");

  if (Object.keys(fA).length) {
    L.push("\n== AFILIADOS ==");
    L.push(linha("GMV do canal", fA.gmv, fP.gmv, br));
    L.push(linha("Comissao paga", fA.comissao, fP.comissao, br));
    L.push(linha("Pedidos do canal", fA.pedidos, fP.pedidos, nu));
    L.push(linha("Novos compradores", fA.novosCompradores, fP.novosCompradores, nu));
    L.push(linha("ROI do canal", fA.roi, fP.roi, (x) => (n(x) === null ? "nao disponivel" : Number(x).toFixed(2).replace(".", ","))));
    if (n(fA.comissao) !== null && n(fA.pedidos) && Number(fA.pedidos) > 0) {
      L.push(`Custo por venda do canal afiliados: ${br(Number(fA.comissao) / Number(fA.pedidos))} — compare diretamente com o CPA de Ads`);
    }
  } else {
    L.push("\n== AFILIADOS ==\nnao disponivel nesta coleta");
  }

  // funil
  L.push("\n== FUNIL DA LOJA (periodo atual) ==");
  L.push(`Impressoes: ${nu(aA.impressoes)} -> Visitantes: ${nu(cA.visitantes)} -> Carrinho: ${nu(cA.carrinho)} -> Pedidos pagos: ${nu(cA.pedidosPagos)}`);

  // formatos de campanha em uso
  if (Array.isArray(A.formatos) && A.formatos.length) {
    L.push("\n== FORMATOS DE ADS EM USO ==");
    for (const f of A.formatos) {
      L.push(`${f.rotulo}: ${f.qtd} campanhas, investimento ${br(f.gasto)}, ROAS ${f.roas != null ? Number(f.roas).toFixed(2).replace(".", ",") : "nao disponivel"}`);
    }
  }

  // produtos
  const prods = Array.isArray(A.produtos) ? A.produtos.slice(0, 25) : [];
  if (prods.length) {
    L.push("\n== PRODUTOS (periodo atual) ==");
    L.push("nome | id | visitantes | cliques | carrinho | unidades pagas | vendas R$ | conversao %");
    for (const p of prods) {
      L.push(`${p.nome} | ${p.id} | ${nu(p.visitantes)} | ${nu(p.cliques)} | ${nu(p.carrinho)} | ${nu(p.unidades)} | ${br(p.vendas)} | ${pc(p.conversao)}`);
    }
  }

  // campanhas
  const camps = Array.isArray(A.campanhas) ? A.campanhas.slice(0, 25) : [];
  if (camps.length) {
    L.push("\n== CAMPANHAS (periodo atual) ==");
    L.push("nome | id produto | formato | investimento | GMV | ROAS amplo | ROAS direto | pedidos | CPA | meta atual | meta sugerida pela Shopee");
    for (const c of camps) {
      L.push([c.nome, c.produtoId, c.formato, br(c.gasto), br(c.gmv),
        c.roas != null ? Number(c.roas).toFixed(2).replace(".", ",") : "nd",
        c.roasDireto != null ? Number(c.roasDireto).toFixed(2).replace(".", ",") : "nd",
        nu(c.pedidos), br(c.cpa),
        c.metaAtual != null ? Number(c.metaAtual).toFixed(1).replace(".", ",") + "x" : "sem meta",
        c.metaSugerida != null ? Number(c.metaSugerida).toFixed(1).replace(".", ",") + "x" : "nd"].join(" | "));
    }
  }

  return L.join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, erro: "json invalido" }, 400); }

  // Responde na hora, sem chamar a API: e a unica forma de provar QUAL versao
  // esta publicada. Sem isso, um 504 nao distingue "codigo antigo sem stream"
  // de "codigo novo que mesmo assim demorou".
  if (body.ping) {
    return json({ ok: true, code_version: CODE_VERSION, streaming: true, aceita_partes: true });
  }

  const chave = Deno.env.get("ANTHROPIC_API_KEY");
  if (!chave) return json({ ok: false, erro: "falta a secret ANTHROPIC_API_KEY na funcao" }, 500);

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // o metodo vem da tabela, nunca do codigo
  let prompt = "";
  try {
    const { data, error } = await supa
      .from("conhecimento")
      .select("veredito")
      .eq("dominio", "prompt").eq("chave", "relatorio").eq("ativo", true).limit(1);
    if (error) throw error;
    prompt = data?.[0]?.veredito?.texto || "";
  } catch (e) {
    return json({ ok: false, erro: "nao consegui ler o prompt: " + String(e) }, 500);
  }
  if (!prompt) return json({ ok: false, erro: "prompt do relatorio nao encontrado na tabela conhecimento (dominio=prompt, chave=relatorio)" }, 500);

  const dados = montarDados(body);

  // GERACAO EM DUAS PARTES: mesmo com stream, um relatorio inteiro pode
  // encostar nos 150s. A extensao pede a parte 1 (diagnostico) e depois a
  // parte 2 (plano e projecao), e junta. Cada chamada cabe folgado no limite.
  const parte = Number(body.parte || 0);
  let instrucao = "Gere o relatorio completo no formato definido, usando exclusivamente os dados abaixo.";
  if (parte === 1) {
    instrucao = "Gere APENAS as secoes 1 a 8 do relatorio (Identificacao, Snapshot Executivo, Visao Geral, Analise Detalhada de KPIs, Shopee Ads, Analise de Produtos, Pontos Positivos e Pontos de Atencao). NAO escreva as secoes 9 e 10 nem qualquer conclusao final: elas serao geradas em outra chamada. Use exclusivamente os dados abaixo.";
  } else if (parte === 2) {
    instrucao = "Gere APENAS as secoes 9 e 10 do relatorio: a Projecao de Crescimento para os proximos 30 dias (com a coluna de LUCRO e recomendando o cenario de maior lucro, nao de maior GMV) e o Plano Tatico de 30 dias dividido em quatro semanas. Nao repita as secoes anteriores nem escreva introducao. Use exclusivamente os dados abaixo.";
  }

  // ============================================================
  // STREAMING E OBRIGATORIO AQUI.
  // O Supabase mata a Edge Function com IDLE_TIMEOUT quando ela fica 150s
  // sem enviar nada, e um relatorio completo leva mais que isso para ser
  // escrito. Sem stream, a funcao SEMPRE morre em 150s — foi o que
  // aconteceu no teste. Com stream, cada pedaco que chega da API conta
  // como atividade e o relogio nao estoura.
  // ============================================================
  let resposta: Response;
  try {
    resposta = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": chave,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: body.modelo || "claude-sonnet-4-5",
        max_tokens: parte ? 9000 : 16000,
        stream: true,
        system: prompt,
        messages: [{
          role: "user",
          content: instrucao + "\n\n" + dados,
        }],
      }),
    });
  } catch (e) {
    return json({ ok: false, erro: "falha ao chamar a API: " + String(e) }, 502);
  }

  if (!resposta.ok) {
    const errTxt = await resposta.text();
    return json({ ok: false, erro: "API respondeu " + resposta.status, detalhe: errTxt.slice(0, 600) }, 502);
  }

  // ============================================================
  // O STREAM PRECISA CHEGAR AO CLIENTE, NAO SO VIR DA API.
  // Meu diagnostico anterior estava pela metade: eu liguei o streaming na
  // chamada a Anthropic mas continuava ACUMULANDO tudo em memoria e so
  // respondendo no fim. Para o Supabase, a funcao seguia 150s sem enviar
  // nada ao chamador — e o IDLE_TIMEOUT continuou estourando, que foi
  // exatamente o que aconteceu com dados reais.
  // Agora a resposta e ela mesma um stream: cada pedaco que chega da API
  // e repassado na hora, a conexao nunca fica ociosa e nao ha limite de
  // tamanho de relatorio.
  // ============================================================
  const enc = new TextEncoder();
  const saida = new ReadableStream({
    async start(controller) {
      let markdown = "";
      try {
        const reader = resposta.body!.getReader();
        const dec = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });
          const linhas = buffer.split("\n");
          buffer = linhas.pop() || "";
          for (const linha of linhas) {
            if (!linha.startsWith("data:")) continue;
            const payload = linha.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const ev = JSON.parse(payload);
              if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
                const pedaco = ev.delta.text || "";
                markdown += pedaco;
                controller.enqueue(enc.encode(pedaco));   // mantem a conexao viva
              }
            } catch { /* pedaco incompleto */ }
          }
        }
      } catch (e) {
        controller.enqueue(enc.encode("\n\n[ERRO: o stream foi interrompido — " + String(e) + "]"));
      }

      // log opcional, ja com o texto completo
      try {
        if (parte !== 1 && markdown.trim()) {
          await supa.from("relatorios").insert({
            shop_id: String(body.loja || "desconhecida"),
            periodo_atual: body?.atual?.periodo || null,
            periodo_anterior: body?.anterior?.periodo || null,
            markdown,
          });
        }
      } catch (_e) { /* nunca derruba o relatorio */ }

      controller.close();
    },
  });

  return new Response(saida, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Code-Version": CODE_VERSION,
      "X-Parte": String(parte),
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "X-Code-Version, X-Parte",
    },
  });
});

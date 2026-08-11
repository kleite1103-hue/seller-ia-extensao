// ============================================================
// SELLER.IA · CONSULTOR DE MERCADO
//
// Recebe os numeros JA CALCULADOS pela extensao e devolve a leitura.
// Nao faz conta: se a IA calculasse, erraria e ninguem conferiria.
// Ela olha o que ja esta pronto e diz o que fazer.
//
// Publicar como funcao "mercado-consultor", Verify JWT DESLIGADO.
// Secret necessaria: ANTHROPIC_API_KEY
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
}

const SISTEMA = `Voce e um consultor de mercado da Shopee falando com uma vendedora experiente.
Ela ja sabe vender: nao explique o obvio, nao ensine o que ela faz todo dia.

O QUE VOCE RECEBE
Um dossie com numeros ja calculados pela ferramenta. Volume de venda e preco
vem da propria Shopee; o faturamento e volume vezes preco; o "pague ate" e a
conta inversa da precificacao, ja descontando comissao, Ads, imposto e margem.

REGRAS QUE NAO SE QUEBRAM
1. NAO CALCULE NADA. Os numeros ja vieram prontos. Use-os como estao. Se voce
   precisar de um numero que nao esta no dossie, diga que nao tem em vez de
   estimar.
2. NAO INVENTE. Nada de "provavelmente", "deve ser", "geralmente o mercado".
   Se o dossie nao diz, voce nao sabe.
3. A AMOSTRA NAO E O MERCADO. O dossie cobre X produtos de uma busca, nao o
   nicho inteiro. Nunca escreva "o mercado fatura Y" — escreva "estes X
   produtos somam Y".
4. Portugues do Brasil, com acentos. Frases curtas.
5. TERMO TECNICO SO COM EXPLICACAO NA MESMA FRASE. Voce pode dizer
   "commodity", "cauda longa", "ticket medio" — mas nunca sozinho. Escreva
   "commodity, ou seja, produto sem diferenca entre um vendedor e outro, onde
   so o preco decide". A pessoa que le e vendedora experiente, nao consultora:
   ela conhece o mercado dela, nao o vocabulario de quem faz slide.

O QUE ESCREVER

## Vale entrar?
Uma resposta direta, com o numero que a sustenta. Olhe a concentracao, quantos
vendem zero, e quanto do topo e anuncio. Se nao vale, diga que nao vale.

## Por qual preco
Use o "pague ate" do dossie. Diga o preco de venda que faz sentido e o teto de
compra. Se o teto for baixo demais para o produto ser importavel, diga.

## Da para vender o suficiente?
So escreva esta secao se vier "viabilidade" no dossie. Ela e mais importante
que o preco: diz quantas vendas por mes o produto precisa fazer so para pagar
o custo fixo, e compara com o que o lider e a mediana do nicho fazem.
Se "vendasParaEmpatar" passa do que o lider vende, seja direto: o produto
sozinho nao paga a operacao. Se fica abaixo da mediana, diga que cabe sem
precisar liderar. E lembre que a margem de contribuicao NAO e lucro — o lucro
vem depois do custo fixo.

## O que os campeoes fazem
Compare top10 com o resto usando os numeros da comparacao. Fotos, nota, preco,
quantos anunciam. Aponte so as diferencas que passam de 15% — o resto e ruido.

## Onde voce esta
Se houver dados da loja dela, diga a posicao real e o que muda a posicao. Se
nao houver produto dela na amostra, diga que ela nao aparece nesta busca e o
que isso significa.

## O primeiro passo
Uma acao concreta para esta semana. Nao uma lista — uma coisa so, a que muda
mais.

TAMANHO
Nao passe de 500 palavras. Cada frase precisa carregar um numero ou uma
decisao. Se uma frase nao tem nenhum dos dois, corte.`;

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
    const d = body.dossie;
    if (!d || !d.termo) return json({ ok: false, erro: "sem dossie" }, 400);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": chave,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system: SISTEMA,
        messages: [{
          role: "user",
          content: "Leia este mercado e me diga o que fazer.\n\n```json\n" +
            JSON.stringify(d, null, 1) + "\n```",
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
      .join("\n");

    return json({
      ok: true,
      texto,
      custo: j.usage
        ? Math.round(((j.usage.input_tokens * 3 + j.usage.output_tokens * 15) / 1000000) * 5.5 * 10000) / 10000
        : null,
    });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});

# COMO A SELLER.IA FUNCIONA
**Efeito Vendas** · v0.79.0 · 04/08/2026

Documento para o time entender de onde vem cada número antes de decidir com base nele.

---

## 1 · DE ONDE VEM O PERÍODO

**A extensão não escolhe o período. Ela herda o que está aberto no painel da Shopee.**

Quando você navega pela Central de Dados, a Shopee faz chamadas com um `start_time` e um `end_time`. A extensão captura essa URL e reaproveita o mesmo intervalo em tudo que ela pede depois.

**Consequência prática:** se você estava com "Por mês" selecionado, a leitura é do mês. Se estava com "Últimos 7 dias", é de 7 dias. **O número de campanhas e o investimento mudam junto.**

Foi por isso que apareceram "301 campanhas com R$ 230" — era o recorte que estava na tela naquele momento, não o mês inteiro.

**Onde conferir:** a Conta 360 mostra no topo qual intervalo foi lido, com o rótulo que a Shopee usa.

**Para trocar:** mude o período no painel da Shopee e colete de novo. Não existe seletor na extensão — tentamos três vezes e sempre quebrou a leitura.

**Exceção:** o Relatório força o período dos dois meses que você escolhe, porque comparar exige recortes específicos.

---

## 2 · AS DUAS LEITURAS

**Leitura normal** (o botão Coletar) — cerca de 40 segundos:
conta, produtos, campanhas ativas, funil, afiliados, saúde, origem das vendas, palavras-chave da loja.

**Leitura profunda** (botão próprio na Conta 360) — alguns minutos:
tudo acima, mais a série hora a hora das 12 campanhas que mais gastam, posição no leilão de até 60 campanhas, palavras-chave de 8 produtos, e as palavras com lance de cada campanha de Busca de Loja.

**O que só existe na profunda:** o mapa de horas, a posição no leilão, a competitividade e as palavras por campanha.

---

## 3 · QUAIS CAMPANHAS SÃO LIDAS

Numa conta com 300 campanhas, ler todas deixa a coleta lenta e enche a tela de coisa que não acontece mais.

**Ativas:** até 200.
**Pausadas:** até 60, e **só as que pararam há menos de 60 dias**. Acima disso é arqueologia.

A tela de Shopee Ads mostra **só as ativas** por padrão. As pausadas ficam num seletor, ordenadas por retorno — porque numa campanha parada o que interessa é quanto ela gerava.

---

## 4 · AS PALAVRAS-CHAVE — os dois grupos

Existem **duas chamadas diferentes** para a mesma rota, e é isso que gera os dois conjuntos:

**Da loja** (`campaign_type: shop`) — a Shopee devolve os termos que ela considera relevantes para a loja inteira. Vem na leitura normal. Costuma trazer entre 40 e 60 termos.

**Por produto** (`campaign_type: product` + `item_id`) — para cada um dos 8 produtos de maior venda, ela devolve os termos daquele item. Só na leitura profunda.

**A diferença não é de qualidade nem de fonte** — é o escopo que a Shopee usou para sugerir. Os dois conjuntos são juntados e os repetidos removidos, ficando com o maior volume.

**Limitação importante:** a rota **não aceita busca livre**. Não existe parâmetro de termo — ela devolve o que ela decide. Por isso não é possível consultar o volume de uma palavra qualquer, só filtrar dentro da lista que ela deu.

**O volume é real**, não estimativa: vem do campo `search_volume` da própria Shopee.

---

## 5 · O QUE É CALCULADO E O QUE É LIDO

**Lido direto da Shopee:** GMV, pedidos, visitantes, impressões, cliques, ROAS, posição no leilão, competitividade, volume de busca, estoque do concorrente.

**Calculado por nós:**

| número | fórmula | por quê |
|---|---|---|
| CPC | gasto ÷ cliques | o campo `cpc` da API é custo por PEDIDO, não por clique |
| CPM | gasto ÷ impressões × 1000 | o campo `cpm` não é taxa |
| CPA | gasto ÷ pedidos | |
| Ponto de equilíbrio | 1 ÷ margem | vem do custo cadastrado |
| Margem | preço − comissão − custo − embalagem − imposto | |

**A régua da loja:** vários julgamentos comparam o produto com a média da própria conta, não com um número fixo. "37 cliques sem venda" é problema numa loja que converte a cada 20 cliques e normal numa que converte a cada 200.

---

## 6 · O QUE A SHOPEE NÃO ENTREGA

- **CPM de categoria** — não existe benchmark de mercado em lugar nenhum
- **Métrica por produto dentro de Grupo de Anúncios** — só o agregado. Para ver item a item, exporte a planilha do grupo e suba na tela de Shopee Ads
- **Volume de busca de palavra arbitrária** — só a lista que ela sugere
- **Segmentação de público em anúncio de produto** — não existe mais

---

## 7 · ONDE OS DADOS FICAM

**Na máquina, não na nuvem.** O custo dos produtos e as leituras ficam no armazenamento local do navegador.

- Até 40 contas guardadas, expirando em 7 dias
- **Trocar de computador perde os custos cadastrados**
- Existe "apagar dados de todas as contas" no banner da tela inicial

Guardar no Supabase está planejado para a versão de administração dos consultores.

---

## 8 · O RELATÓRIO

Ele faz **duas leituras completas** — o mês escolhido e o anterior — e manda os dois para o cérebro, que chama a IA com o prompt do método.

**Leva alguns minutos**, porque são duas coletas mais a escrita.

**Ele se recusa a gerar quando:**
- Um dos meses vier sem GMV e sem pedidos
- Os dois períodos saírem com números idênticos
- O mês escolhido tiver menos de 7 dias de dados

**Mês em curso:** se você escolher o mês atual com poucos dias, ele recorta o mês anterior no mesmo número de dias — senão a comparação vira queda falsa.

---

## 9 · O QUE SIGNIFICA CADA SELO

🟢 **análise Seller.IA · ocpm-2.0** — o veredito veio do cérebro, com as 37 regras e o piso pela sua margem.

🟡 **leitura local** — o cérebro não respondeu e a extensão julgou com as regras básicas. Clique em Analisar para trazer a completa.

---

## 10 · MODO GRAVAÇÃO

Botão **gravar** no cabeçalho. Borra o nome da loja, os nomes dos seus produtos e das campanhas.

**Continua legível:** todos os números, os vereditos e os produtos dos concorrentes que o Espião traz — porque é o conteúdo que se quer mostrar.

Passar o mouse sobre um nome borrado revela por um instante.

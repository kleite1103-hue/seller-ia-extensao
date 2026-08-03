# REGRAS DE ANÁLISE DE CAMPANHA
**Seller.IA · Efeito Vendas** · definidas por Karina em 03/08/2026
**Status: alinhado, implementação pendente**

---

## O PRINCÍPIO QUE MUDA TUDO

Karina rejeitou os limiares fixos que eu propus (R$20 de gasto, R$300 de receita, 1,5× o piso) e definiu outro critério:

> **Toda régua vem da própria conta, nunca de um número fixo.**

O exemplo dela: uma campanha pausada que gerava R$300/mês é **crítica** numa loja que fatura R$1.000 e **irrelevante** numa que fatura R$30 mil. O mesmo número, dois diagnósticos opostos.

Isso vale para todos os limiares deste documento. Onde não houver dado da conta para calcular a régua, o sistema **declara que está usando um padrão e explica por quê** — nunca finge que o número é da conta.

---

## 1 · GASTO RELEVANTE — não é um valor, é uma leitura

Em vez de perguntar *"gastou mais de R$20?"*, perguntar:

**Quantos cliques esse investimento comprou?**
E comparar com a régua da conta: `cliques da conta ÷ pedidos da conta` = quantos cliques essa loja gasta por venda.

Se a campanha comprou **menos cliques do que a conta gasta para fazer uma venda**, ela ainda não teve chance. Julgar aqui é cedo demais.

Se comprou **mais do que isso e não vendeu**, aí sim é problema — e o tamanho do problema é o gasto.

### O que analisar junto, antes de dar veredito

| métrica | pergunta que ela responde |
|---|---|
| CTR | o card chama clique? |
| Taxa de conversão | a página fecha venda? |
| Adição ao carrinho | a pessoa quis e não fechou? |
| Competitividade de preço | o preço está fora da régua da categoria? |
| CPM real (`gasto ÷ impressões × 1000`) | quanto custa aparecer para essa conta? |
| CPM médio da conta | esta campanha paga mais caro que as outras? |

**Sobre CPM de categoria:** verificado nas capturas — **a Shopee não entrega esse dado.** O que existe é `recommendation_percentiles` e o `upper_bound` da meta recomendada por categoria, que servem como referência indireta. O sistema deve dizer isso quando o assunto aparecer, em vez de inventar um benchmark.

---

## 2 · PAUSADA QUE RENDIA — relativo ao faturamento da conta

Não existe "R$300 é relevante". Existe:

```
participação = receita que a campanha gerava ÷ faturamento da conta no período
```

Loja de R$1.000/mês com campanha de R$300 → **30% do faturamento parado**. Crítico.
Loja de R$30.000/mês com a mesma campanha → **1%**. Ruído.

A leitura na tela deve ser a participação, não o valor absoluto: *"esta campanha respondia por 30% do que a loja vendia e está parada."*

---

## 3 · TEMPO PAUSADA — o que importa é o que a conta perdeu

Não é "30 dias é problema". É:

> Desde que pausou, o que a conta deixou de faturar?

Uma campanha parada há 3 dias que representava 40% da receita é mais urgente que uma parada há 60 dias que representava 2%.

**Cálculo:** `receita média por dia que ela gerava × dias parada` = o buraco acumulado.

E as três perguntas que precisam ser respondidas:
1. A pausada rendia mais que a ativa que a substituiu?
2. O produto dela ficou sem nenhuma campanha cobrindo?
3. Quanto a conta perdeu desde que ela parou?

---

## 4 · "COM FOLGA" — depende do custo, e o custo tem que ser dito

O corte de 1,5× o piso **só faz sentido com a margem real cadastrada**.

**Sem o Cofre preenchido**, o sistema deve dizer exatamente isto na tela:

> *"Estou usando 5x como referência de folga porque o custo destes produtos não está cadastrado. Com margem de 25% assumida, o ponto de equilíbrio é 4x. Cadastre o custo no Cofre e este número vira o seu."*

**Nunca mostrar o número sem a ressalva.** A agência envia planilha de custo ao cliente e ajusta preço a partir dela — o número certo existe, só não está no sistema ainda.

---

## 5 · O QUE FICA DE FORA

Campanha **sem gasto e sem venda** no período não entra na lista. Não diz nada e é o que enche a fila de ruído numa conta com 300 campanhas.

Campanha **em aprendizado** fica fora do julgamento, mas é contada e explicada — 7 dias em Meta de ROAS, 14 em Lance Automático.

---

## 6 · GRUPO DE ANÚNCIOS — limitação declarada

**Não existe métrica por produto dentro de Grupo de Anúncios.** A rota devolve um bloco agregado.

Consequência para esta análise: quando um Grupo é pausado, o sistema consegue dizer **que o grupo parou e quanto ele gerava**, mas não **qual produto ficou descoberto**.

**Regra de conduta:** declarar essa limitação na tela, sempre. Vale para toda análise, não só esta.

### Pendente — resolver quando aparecer conta relevante em Grupo

Se uma conta da carteira depender de Grupo de Anúncios, será preciso:

1. Cruzar `mpd.item_list` (os IDs dentro do grupo) com o desempenho de produto, que traz `campaign_id` — isso dá **retorno** por item, nunca custo
2. Definir como atribuir o gasto: rateio por participação na venda é a única aproximação possível, e precisa ser declarada como estimativa
3. Usar a leitura exclusiva do grupo — `broad_roi` vs `direct_roi` — para separar descoberta de canibalização

**Guardado para quando for necessário. Não implementar antes disso.**

---

## RESUMO DA CONDUTA

1. Régua da própria conta, sempre
2. Quando faltar dado para a régua, **dizer qual padrão está usando e por quê**
3. Nunca inventar benchmark de categoria — a Shopee não entrega
4. Limitação de Grupo de Anúncios declarada em toda análise
5. Participação percentual comunica melhor que valor absoluto

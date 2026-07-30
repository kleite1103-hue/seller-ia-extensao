# LEVANTAMENTO — Grupo de Anúncios e Anúncio Automático de Loja
**Seller.IA · Efeito Vendas** · levantado das 16 coletas reais · 27/07/2026
**Status: documentado, implementação pendente**

---

## COMO OS DOIS APARECEM NA API

A rota `pas/v1/homepage/query` devolve o campo `type` em cada campanha. Nas coletas apareceram **seis** combinações:

| type | subtype | capturas | o que é |
|---|---|---|---|
| `product_manual` | `product_homepage__roi_two__target` | 126 | GMV Max · Meta de ROAS |
| `product_manual` | `null` | 76 | GMV Max · Lance Automático |
| `product_manual` | `product_homepage__roi_two__simple` | 14 | GMV Max · ROI2 simples |
| **`product_mpd`** | `product_homepage__roi_two__target` | **11** | **Grupo de Anúncios** |
| `shop_manual` | `null` | 11 | Busca de Loja (palavra-chave) |
| **`shop_auto`** | `null` | **2** | **Anúncio Automático de Loja** |

`mpd` = multi-product. É o identificador do Grupo de Anúncios.

---

## 1 · GRUPO DE ANÚNCIOS — `product_mpd`

### Exemplo real capturado

```
título ......... "Conjunto EF - Produtos Roas baixo"
campaign_id .... 109613040
daily_budget ... 5.000.000  →  R$ 50,00/dia   (ÚNICO para o grupo)
roi_two_target . 1.500.000  →  15x            (ÚNICA para o grupo)

mpd.item_list:
  22198923228
  23094087706
  58212151381
  58262160850
```

Confirma o que você descreveu: **vários produtos, um orçamento, uma meta.** O `item_list` entrega os IDs de todos os produtos de dentro.

### O relatório do grupo é agregado — e isso é o problema central

```
cost .......... R$ 52,00        impression .... 12.929
click ......... 358             avg_rank ...... 85
broad_roi ..... 13,72x          direct_roi .... 5,25x
broad_order ... 20              direct_order .. 8
ctr ........... 2,77%           cr ............ 5,59%
```

**Não existe report por produto dentro do grupo.** A API devolve um único bloco de métricas para os quatro juntos. Ou seja: pela rota de Ads, é impossível saber **qual dos quatro produtos está consumindo a verba** e qual está parasitando.

Isso explica tecnicamente por que a regra de "extrair o produto bom do grupo" existe: **dentro do grupo você é cego.**

### A saída para enxergar dentro do grupo

O `mydata/v4/product/performance` traz `campaign_id` por produto. Cruzando os dois:

```
mpd.item_list  ─┐
                ├─→  atribuição de venda por produto dentro do grupo
performance     ─┘    (venda paga, conversão, ticket por item)
```

**Não resolve o custo por produto** — só a Shopee sabe como distribuiu a verba. Mas resolve o retorno por produto, que é o suficiente para decidir quem sai e quem fica.

### O sinal mais forte do grupo: a distância entre amplo e direto

Neste grupo, `broad_roi` é **13,72x** e `direct_roi` é **5,25x** — uma diferença de 2,6 vezes.

ROAS amplo conta toda venda da loja atribuída ao anúncio. ROAS direto conta só a venda do produto anunciado. **Quando a distância é grande num grupo, significa que o grupo está gerando venda de outros produtos** — o que pode ser bom (descoberta) ou ruim (canibalização do orgânico).

É uma leitura que só faz sentido em grupo, e que hoje não fazemos em lugar nenhum.

### Dois campos que ainda não sabemos usar

```
current_roi_two_list = null
new_roi_two_list     = null
```

O nome sugere **meta de ROAS por item dentro do grupo**. Vieram nulos nesta conta. Se em alguma conta vierem preenchidos, muda a leitura: significaria que dá para ter metas diferentes dentro do mesmo grupo.

### Regras do config que valem para o grupo

```
product_ads.default_product_selection ... auto
product_ads.default_bidding_strategy .... auto
product_ads.default_product_placement ... all
product_ads.auto.learning_duration ...... 14 dias
product_ads.auto.all.min_daily_budget ... R$ 15,00
product_ads.manual.*.min_daily_budget ... R$ 10,00

product_ads.default_for_roi2:
  selection = manual · strategy = roi_two · placement = all
```

**Duas coisas importantes aqui:**

1. **O aprendizado do modo automático é de 14 dias**, e o grupo nasce em automático por padrão. Quem cria grupo e mexe no quinto dia reinicia a contagem.
2. **Quando a estratégia é ROI2, a seleção de produto vira manual.** Ou seja: no modo Meta de ROAS a Shopee espera que você escolha os produtos; no modo automático ela escolhe.

---

## 2 · ANÚNCIO AUTOMÁTICO DE LOJA — `shop_auto`

### Exemplo real capturado

```
título ......... "Anúncio de Loja"
campaign_id .... 20009044        ← ID curto: criado pela plataforma
daily_budget ... 1.600.000  →  R$ 16,00/dia
roi_two_target . 0               ← SEM meta de ROAS
start_time ..... 31/01/2025      ← rodando há 6 meses
end_time ....... 0               ← sem data de fim
manual_shop_ads. null
report ......... {}              ← vazio no período
```

### O que isso confirma e o que revela

Confirma sua descrição: é um anúncio de loja em lance automático, criado pela própria Shopee, que absorve produto novo automaticamente.

**Mas revela três coisas que importam:**

1. **`roi_two_target = 0`.** Não existe meta de ROAS aqui. Não há como controlar rentabilidade por meta — o único controle é o orçamento diário.
2. **Sem data de fim, rodando desde janeiro.** É uma campanha perpétua que ninguém abriu. Consome verba todos os dias por padrão.
3. **O report veio vazio.** Precisa de outra rota ou de outro período para medir. **Não sabemos ainda se ela está performando ou queimando.** É a lacuna mais importante deste levantamento.

### Config do formato

```
auto_shop_ads.min_daily_budget ..... R$ 15,00
auto_shop_ads.default_daily_budget . R$ 15,00
auto_shop_ads.default_time_length .. 30 dias
auto_shop_ads.default_cpc_constant . R$ 0,08
```

O piso é R$15/dia. Uma conta com esse anúncio ligado e esquecido gasta **no mínimo R$450/mês** sem meta de rentabilidade.

---

## 3 · O QUE FAZER COM ISSO — PENDENTE DE IMPLEMENTAÇÃO

| # | O que | Depende de |
|---|---|---|
| 1 | Identificar o tipo de campanha pelo `type` e mudar a leitura conforme o formato | nada — já dá pra fazer |
| 2 | No card de grupo: listar os produtos de dentro e atribuir venda a cada um via `performance` | cruzamento das duas rotas |
| 3 | Alerta de distância amplo vs direto em grupo (canibalização ou descoberta) | definir o limiar |
| 4 | Alerta de Anúncio Automático de Loja sem meta rodando há meses | achar a rota que traz o report dele |
| 5 | Nunca sugerir ajuste de meta em `shop_auto` — ela não tem meta | nada |
| 6 | Nunca sugerir mexer em grupo antes de 14 dias | nada |
| 7 | Verificar se `current_roi_two_list` vem preenchido em outra conta | mais uma coleta |

---

## 4 · CORREÇÃO AO PROMPT v2

O prompt v2 descreve o Grupo de Anúncios como "permite escolher Meta de ROAS ou lance automático". **Está incompleto.** Precisa acrescentar:

- O grupo tem **orçamento único e meta única** para todos os produtos de dentro
- **Não existe métrica por produto dentro do grupo** na rota de Ads
- O aprendizado do modo automático é de **14 dias**
- No modo Meta de ROAS a seleção de produto é **manual**; no automático a Shopee escolhe

E acrescentar o formato que faltava por completo:

- **Anúncio Automático de Loja** (`shop_auto`): sem meta de ROAS, piso de R$15/dia, perpétuo por padrão. Nunca sugerir ajuste de meta. Sinalizar quando estiver ligado há muito tempo sem leitura de resultado.

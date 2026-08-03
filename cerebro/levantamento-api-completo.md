# O QUE A API DA SHOPEE ENTREGA — LEVANTAMENTO COMPLETO
**Seller.IA · Efeito Vendas** · 03/08/2026 · 288 rotas capturadas, 116 com dado analítico

---

## O QUE MUDA O JOGO

Três descobertas que sozinhas justificam a ferramenta.

### 1 · SÉRIE HORA A HORA — `pas/v1/report/get_time_graph`

24 pontos por dia, **36 métricas em cada ponto**, por campanha.

**O que os dados reais mostraram** (10 campanhas, um dia):

| faixa | CPM | gasto | CTR | pedidos | **custo/pedido** |
|---|---|---|---|---|---|
| madrugada | 3,24 | R$ 11,58 | 2,88% | 4 | **R$ 2,90** |
| manhã | 3,44 | R$ 49,90 | 2,47% | 8 | R$ 6,24 |
| tarde | 3,10 | R$ 74,40 | 2,23% | 3 | **R$ 24,80** |
| noite | 2,98 | R$ 104,63 | 2,17% | 20 | R$ 5,23 |

**A tarde consome 42% do dinheiro e entrega 13% dos pedidos.** Custa 8x mais por pedido que a noite.

E o contraintuitivo: **o CPM da tarde é o segundo mais barato**. Não se paga mais por impressão — paga-se por impressão que não converte. Nenhum número consolidado mostra isso.

Cada ponto ainda traz:
- `roi_target_setting` com **`is_cold_start`** — aprendizado dito pela Shopee, não estimado
- O valor da meta naquela hora — comparando pontos, **revela quando a meta foi alterada**
- `new_product_boost_setting.is_boosting` — impulsionamento ativo
- `avg_rank` e `location_in_ads` — posição no leilão hora a hora

**Campos que vieram zerados nesta captura:** `sov`, `reach`, `unique_visitors`, `product_impression`. Existem no contrato, mas a Shopee não preencheu. Não exibir como se fossem dado.

---

### 2 · FONTE DE VENDA POR CANAL — `mydata/v1/product/traffic/overview`

Responde **de onde vem cada real**, com variação vs período anterior:

```
total ........... R$ 9.799,46   +18,7%
card de produto . R$ 9.584,61   = 97,8% do total
afiliados ....... R$   214,85   = 2,2%   −12,2%
ads pago ........ R$ 7.496,49   +4,0%
live / vídeo .... R$ 0,00
```

E o **breakdown de onde vem a visita** que virou venda:

| origem | % das vendas | % dos pedidos | % dos cliques |
|---|---|---|---|
| busca | **58,0%** | 56,6% | 64,6% |
| recomendação | 18,6% | 20,8% | 18,8% |
| outros | 18,0% | 19,6% | 11,8% |
| loja | 1,9% | 0,3% | 0,8% |
| carrinho | 1,7% | 1,8% | 2,8% |
| minhas compras | 1,5% | 0,7% | 1,1% |
| chat | 0,3% | 0,3% | 0,01% |

Cada origem traz 30 campos, incluindo `ctr`, `sales_per_order`, `product_clicks_to_orders_rate`, `product_impressions` e a variação de cada um.

**Por que importa:** separa o que a loja conquista na busca do que ela ganha por recomendação do algoritmo. Loja que vive de recomendação é frágil — a Shopee pode cortar amanhã.

---

### 3 · SÉRIE DIÁRIA POR PRODUTO — `mydata/v2/product/overview/metric-trends`

**34 métricas × 23 dias**, por produto. O funil completo, dia a dia:

```
uv → pv → iv → search_clicks → atc_uv → placed_buyers → paid_buyers → confirmed_buyers
```

Com `bounce_rate`, `atc_rate`, `sales_per_buyer`, e as taxas de conversão de cada degrau separadas: colocado, pago e confirmado.

**O degrau que ninguém olha:** `placed_buyers_to_confirmed_buyers_rate`. No dado real ele varia de **1,00 a 0,67** — ou seja, em alguns dias **um terço dos pedidos colocados não se confirma**. Isso é dinheiro que aparece no painel e some depois.

---

## JÁ USAMOS

`homepage/query` (campanhas e formatos) · `mydata/v4/product/performance` (funil por produto) · `dashboard/key-metrics` · `search_product_list` (estoque e vendas por variação) · `todo/list_task` (competitividade e ROAS recomendado) · `diagnosis/list_verdict` · `config/get` · `accounthealth` · `search_items` (Espião) · `list_recommended_keyword` (volume de busca)

## NÃO USAMOS AINDA — por ordem de valor

| rota | o que entrega |
|---|---|
| `report/get_time_graph` | **as 24 horas** — coletando desde a v0.59, falta a tela |
| `product/traffic/overview` | fonte de venda por canal + de onde vem a visita |
| `product/overview/metric-trends` | 34 métricas × 23 dias por produto |
| `product/traffic/item-list` | tráfego por item com origem |
| `affiliateplatform/creator/list` | creators disponíveis por nicho |
| `mydata/v3/product/overview/product-rankings` | rankings prontos da Shopee |
| `order/get_order_list_card_list` | pedidos individuais |
| `setup_helper/product_selector/query` | produtos elegíveis para anúncio |
| `get_product_extensive_info` | ficha estendida do produto |
| `pas/v1/meta/get_ads_data` | metadados de Ads |

---

## O QUE NÃO EXISTE

- **CPM de categoria** — não há benchmark de mercado em lugar nenhum
- **Métrica por produto dentro de Grupo de Anúncios** — só o agregado
- **Volume de busca para palavra arbitrária** — só a lista que a Shopee sugere
- **Data da última alteração de campanha** — mas dá para inferir pela série horária

---

## A MÁQUINA QUE ISSO PERMITE

Juntando as três descobertas:

**Mapa de horas** → em que faixa o dinheiro rende e em qual drena, por campanha
**Alerta de orçamento esgotado** → gasto que desaba às 15h significa sumir do pico da noite
**Origem da venda** → quanto vem de busca (mérito) vs recomendação (empréstimo do algoritmo)
**Funil diário por produto** → o dia exato em que a conversão caiu, e qual degrau
**Perda pós-pedido** → quanto do colocado não vira confirmado

Nenhuma dessas leituras existe no painel da Shopee, e nenhuma ferramenta de mercado faz.

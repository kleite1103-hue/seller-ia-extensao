# SELLER.IA — MAPA MESTRE DA CONSTRUÇÃO
## "tudo de uma vez, com calma, sem esquecer nada"

---

## PARTE A — COLETA (o que alimenta tudo)
- [x] Interceptor com buffer desde ms zero
- [x] Coletor com fusão multi-aba
- [x] Coleta completa em 1 clique (busca ativa paginada)
- [x] Auto-coleta ao entrar (12h)
- [ ] **Barra de progresso VISUAL na coleta** (pedido Karina)
- [ ] **Seletor de datas próprio na análise** (7/30/mês/custom) — resolve bug de janela
- [ ] Captura dos DIAMANTES da API:
  - [ ] avg_rank (posição leilão)
  - [ ] competitiveness + uplift (competitividade preço)
  - [ ] boosting_status / deboost (produto limitado)
  - [ ] cold_start_duration (fase aprendizado)
  - [ ] new_product_period + first_publish_time (janela produto novo)
  - [ ] suggested_roi_two_target + recommended (meta ROAS + percentis)
  - [ ] get_estimated_auto_ads_data (projeção uplift)
  - [ ] diagnosis/list_verdict (diagnóstico oficial Shopee por campanha)
  - [ ] penalty + performance_rating + percentile (saúde conta)
  - [ ] listing_quality (qualidade anúncio)
  - [ ] traffic_level + boost (exposição grátis)
  - [ ] paid_ads_ratio / affiliate_ratio (fontes cruzadas)
  - [ ] search_clicks (cliques busca)

## PARTE B — PÁGINA DE VENDAS DO PRODUTO (Karina lembrou — NÃO FUNCIONA HOJE)
- [ ] **Ler a página pública do produto** (os 2 formatos de URL)
- [ ] Cruzar o ID da página com os dados já coletados no banco
- [ ] Mostrar o CARD do produto ali, com margem + veredito + funil

## PARTE B2 — ESPIÃO DE BUSCA (tela do sistema, estava fora do mapa)
Layout aprovado: `mockups/espiao.html`. Motor de dados: `diamantes.js → exBusca()`.
- [x] Motor lê `monthly_sold_count` + `historical_sold_count` + preço → **faturamentoMesEstimado**
- [x] Layout das 3 telas: Radar (automático) · Sonda (manual) · Duelo (comparativo)
- [ ] **Disparo ativo da busca pelo `bg.js`** (service worker, host_permissions já cobre shopee.com.br — resolve o CORS entre seller.* e shopee.com.br)
- [ ] Radar automático: extrair termo principal do título de `COFRE.porProduto` → 1 busca por produto top
- [ ] Cálculo da BARREIRA = média do TOP 5 (preço, vendas/mês, faturamento) — líder entra só como referência
- [ ] Diff de palavras: termos do título do TOP 5 que não estão no título dela
- [ ] **APOSENTAR `mockups/sondador.html`** — versão v3 de console, não extrai sold_count, ficou obsoleta
- [ ] Consultor do Duelo com texto do cérebro treinado (não inventado)

## PARTE C — CÉREBRO (ocpm-2.0)
- [x] Regras base: campanha, funil, conta, leilão (ocpm-1.3)
- [ ] Camada VERDADE SHOPEE: lê deboost, diagnóstico oficial, aprendizado, meta sugerida → cruza com método
- [ ] Camada DINHEIRO REAL: base da calculadora de margem (preço − comissão − ads − afiliado − custo Cofre)
- [ ] Camada COMPETIÇÃO: sondador de busca → "pra subir nessa busca faça X"
- [ ] Camada OPORTUNIDADE: deboost corrigir, janela novo escalar, boost ativar, créditos pegar
- [ ] Comunicação: SEMPRE número → nota (bom/ruim + referência) → porquê → o que fazer em passos
- [ ] Texto do consultor treinado no gabarito (dado → análise → sugestão + meta + janela + critério)

## PARTE D — INTERFACE (gaveta lateral, aprovada)
- [ ] Gaveta lateral (não cobre, desliza) com navegação deslizável interna
- [ ] Card do produto (dinheiro + ROAS explicado + consultor + ouro + funil círculos)
- [ ] Painel: Início (coleta+progresso+saúde) · Card Produto · Produtos · Especialista · Espião Busca · Ferramentas
- [ ] Sem barra de arrastar; cards recolhíveis onde precisa

## PARTE E — FERRAMENTAS (aba)
- [ ] Calculadora Shopee (base da margem)
- [ ] Cofre de Custos (custo 1x por produto, salvo no servidor por ID+licença)
- [ ] ClipSeller (botão externo + sugestão no card do produto)
- [ ] Suporte

## PARTE F — ESPECIALISTA + EXPORT
- [ ] Análise do Especialista (molde do gabarito CB Shop)
- [ ] Exportar PDF com a marca

## REGRAS DE OURO (nunca esquecer)
- Vilão nunca é a Shopee, só desinformação/erro operacional
- Design: #07080a / #ff4d1c / #7B2FFF · Bebas Neue · Space Mono · sem emoji
- Deploy sempre GitHub Pages com URL viva, arquivos soltos, mobile-first
- Frete JÁ está na comissão (não somar); antecipa fora (3 níveis)
- Comissão: ≤79,99=20%+4 · 80-99,99=14%+16 · 100-199,99=14%+20 · 200+=14%+26
- ROAS mínimo = 100 ÷ margem%
- Segredos das fórmulas protegidos

## ORDEM DE CONSTRUÇÃO SUGERIDA (camadas testáveis)
1. **Coleta dos diamantes** (Parte A) — sem dado, nada funciona
2. **Cérebro 2.0** (Parte C) — a inteligência que usa os diamantes
3. **Interface + Card + Página de vendas** (Partes B, D) — onde tudo aparece
4. **Ferramentas + Cofre** (Parte E) — margem real
5. **Especialista + PDF** (Parte F) — o entregável final

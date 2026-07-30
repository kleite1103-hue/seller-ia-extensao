-- ============================================================
-- SELLER.IA · ACENTUACAO DOS TEXTOS QUE O VENDEDOR LE
-- ============================================================
-- Rodar DEPOIS de conhecimento-2-regras.sql.
-- Seguro rodar mais de uma vez.
--
-- Isto e a prova pratica da arquitetura: corrigir o texto que o cliente
-- le e um UPDATE, nao um deploy. As frases que estao escritas dentro do
-- cerebro-v2.ts exigiram republicar a funcao. As que estao aqui, nao.
-- ============================================================

update conhecimento set veredito = '{"nivel":"cinza","titulo":"Visitas insuficientes para julgar","texto":"Recebeu {visitas} visitantes no período. Com menos de 100, qualquer percentual vira ruído: 1 venda em 3 visitas daria 33% e não significa nada.","passos":["Traga visita antes de tirar conclusão deste produto"]}'::jsonb
where dominio='produto' and chave='sem_visita';

update conhecimento set veredito = '{"nivel":"vermelho","titulo":"Aparece na vitrine e recebe pouco clique","texto":"De cada 100 pessoas que viram este produto na busca, {ctr} clicaram. O normal é ao menos 2.","passos":["Troque a primeira foto","Revise o começo do título","Compare o preço no card com os primeiros da busca"]}'::jsonb
where dominio='produto' and chave='clique_baixo';

update conhecimento set veredito = '{"nivel":"vermelho","titulo":"Recebe clique e não vende","texto":"O card funciona: {ctr} de cada 100 clicam. Mas de cada 100 que entram na página, menos de 1 compra.","passos":["Abra a página no celular","Compare o preço com o concorrente da mesma busca","Verifique se há variação sem estoque","Responda as avaliações pendentes"]}'::jsonb
where dominio='produto' and chave='nao_converte';

update conhecimento set veredito = '{"nivel":"amarelo","titulo":"A maioria sai sem olhar nada","texto":"De cada 100 que entram, {rejeicao} saem sem clicar em nada. Normalmente é porque a página não entrega o que o card prometeu.","passos":["Confira se a primeira foto e o título descrevem o que a pessoa encontra ao entrar"]}'::jsonb
where dominio='produto' and chave='rejeicao_alta';

update conhecimento set veredito = '{"nivel":"amarelo","titulo":"{fatia}% do faturamento vem deste produto","texto":"Se ele perder posição, sair de estoque ou ganhar um concorrente mais barato, a loja perde {fatia}% de uma vez.","passos":["Não mexa neste sem motivo","Coloque esforço no segundo colocado para reduzir a dependência"]}'::jsonb
where dominio='produto' and chave='concentracao';

update conhecimento set veredito = '{"nivel":"amarelo","titulo":"Preço na faixa de comissão mais cara","texto":"Cada pedido sai a {ticket}. Até R$ 79,99 a Shopee cobra 20% + R$ 4. Passando de R$ 80 cai para 14% + R$ 16 — em muitos casos sobra mais dinheiro vendendo mais caro.","passos":["Um kit ou combo que passe de R$ 80 aumenta a sobra sem precisar de visita nova"]}'::jsonb
where dominio='produto' and chave='faixa_comissao';

update conhecimento set veredito = '{"nivel":"verde","titulo":"Vende bem sem nenhum anúncio","texto":"De cada 100 que entram, {conversao} compram, sem investimento nenhum.","passos":["É o produto mais barato para começar a anunciar: você paga por visita que já sabe converter"]}'::jsonb
where dominio='produto' and chave='converte_sem_ads';

update conhecimento set veredito = '{"nivel":"verde","titulo":"Vende bem e já tem anúncio","texto":"De cada 100 que entram, {conversao} compram.","passos":["Suba o orçamento em 20% e reavalie em 7 dias, uma mudança por vez"]}'::jsonb
where dominio='produto' and chave='converte_com_ads';

-- ---- diagnostico da propria Shopee ----
update conhecimento set veredito = '{"nivel":"vermelho","titulo":"Queda forte na semana","texto":"A Shopee marcou este produto por queda acima de 50% em 7 dias: de {d1} para {d2}.","passos":["Verifique o estoque","Verifique se saiu de alguma campanha","Compare o preço com os primeiros da busca"]}'::jsonb
where dominio='shopee_diagnostico' and chave='metric_10000';

update conhecimento set veredito = '{"nivel":"amarelo","titulo":"Alerta de problema por pedido","texto":"{d2} de {d1} pedidos deram problema em 45 dias, ou {d3}%.","passos":["Verifique se o problema está em uma variação específica","Grade, cor e estoque trocado são as causas mais comuns"]}'::jsonb
where dominio='shopee_diagnostico' and chave='metric_10003';

update conhecimento set veredito = '{"nivel":"vermelho","titulo":"Alerta com limite apertado","texto":"Regra que exige ao menos 10 pedidos e tolera só 5%. Produto marcado aqui merece olhar antes dos outros.","passos":["Priorize este produto na fila"]}'::jsonb
where dominio='shopee_diagnostico' and chave='metric_10004';

update conhecimento set veredito = '{"nivel":"amarelo","titulo":"Condição sinalizada pela Shopee","texto":"Regra sem limite numérico: é uma condição verdadeira ou falsa, não uma taxa.","passos":["Abra a tela de Diagnóstico de Produto para ver o motivo"]}'::jsonb
where dominio='shopee_diagnostico' and chave in ('metric_10002','metric_10006');

-- ---- eixos de veredito de campanha ----
update conhecimento set veredito = '{"nivel":"vermelho","titulo":"A Shopee considera sua meta alta demais","texto":"Sua meta é {meta_atual}x e ela recomenda {meta_sugerida}x, projetando {ganho_gmv}% mais faturamento.","passos":["Confira o seu piso pela margem antes de mexer","Se a sugestão estiver abaixo do piso, não siga","Descendo, vá em degraus de 20% e meça 7 dias"]}'::jsonb
where dominio='shopee_verdict' and chave='bidding_v2';

update conhecimento set veredito = '{"nivel":"amarelo","titulo":"Orçamento ou saldo limitando","texto":"A Shopee sinalizou este eixo. Ainda não sabemos qual alvo ela entrega quando ele falha.","passos":["Verifique o orçamento diário e o saldo da conta"]}'::jsonb
where dominio='shopee_verdict' and chave='budget_and_balance_v2';

update conhecimento set veredito = '{"nivel":"amarelo","titulo":"Campanha alterada demais","texto":"A Shopee sinalizou continuidade. Mexer com frequência reinicia o aprendizado.","passos":["Não altere antes do fim do aprendizado: 7 dias em Meta de ROAS, 14 em automático"]}'::jsonb
where dominio='shopee_verdict' and chave='continuance_v2';

update conhecimento set veredito = '{"nivel":"amarelo","titulo":"O produto não compete na categoria","texto":"Este eixo não se resolve no anúncio. Se ele está ruim, mexer em meta é jogar dinheiro fora.","passos":["Compare o preço com os primeiros da busca","Reveja a ficha e a prova social antes de investir mais"]}'::jsonb
where dominio='shopee_verdict' and chave='competitiveness_v2';

-- ---- checklist de qualidade ----
update conhecimento set veredito = '{"nivel":"amarelo","titulo":"Faltam {n_faltando} tarefas de qualidade","texto":"A Shopee pontua {n_total} itens neste anúncio e {n_faltando} não estão cumpridos. Restam {prazo} dias da janela de produto novo.","passos":["Cumpra as tarefas pendentes antes do fim da janela"]}'::jsonb
where dominio='qualidade_anuncio' and chave='checklist';

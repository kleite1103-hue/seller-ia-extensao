-- ============================================================
-- SELLER.IA · CORRIGE A ORDEM DAS REGRAS DE PRODUTO
-- ============================================================
-- BUG: as regras rodam de cima para baixo e param na primeira que casa.
-- 'faixa_comissao' (prioridade 60) vinha ANTES de 'converte_sem_ads' (70),
-- entao um produto que converte 2,4% e nao tem anuncio recebia
-- "Preco na faixa de comissao mais cara" em vez de
-- "Vende bem sem nenhum anuncio". O melhor produto da loja aparecia como
-- problema de preco, e a recomendacao que importa — comecar a anunciar por
-- ele — nunca chegava na tela.
--
-- CORRECAO: o que o produto E vem antes do que ele PODERIA melhorar.
-- Problema grave -> saudavel -> oportunidade.
-- ============================================================

update conhecimento set prioridade = 10 where dominio='produto' and chave='sem_visita';
update conhecimento set prioridade = 20 where dominio='produto' and chave='clique_baixo';
update conhecimento set prioridade = 30 where dominio='produto' and chave='nao_converte';
update conhecimento set prioridade = 40 where dominio='produto' and chave='rejeicao_alta';

-- saudaveis passam na frente das oportunidades
update conhecimento set prioridade = 50 where dominio='produto' and chave='converte_sem_ads';
update conhecimento set prioridade = 55 where dominio='produto' and chave='converte_com_ads';

-- risco de concentracao continua relevante mesmo em produto que vende bem,
-- mas so aparece se ele nao caiu em nenhuma das anteriores
update conhecimento set prioridade = 60 where dominio='produto' and chave='concentracao';

-- faixa de comissao e a ULTIMA: e otimizacao, nao diagnostico
update conhecimento set prioridade = 90 where dominio='produto' and chave='faixa_comissao';

-- confere
-- select chave, prioridade from conhecimento where dominio='produto' order by prioridade;

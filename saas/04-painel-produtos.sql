-- ============================================================
-- SELLER.IA · 04-painel-produtos.sql
--
-- A view do painel passa a dizer quais produtos cada pessoa assina.
-- Sem isso o admin nao ve quem tem o Radar sem consultar a tabela na mao.
--
-- Esta view e a MESMA do 02-planos, com tres colunas a mais no fim. Copiei
-- a original inteira em vez de reescrever de memoria: as colunas que o
-- painel ja usa continuam exatamente onde estavam.
--
-- Rodar DEPOIS do 03-produtos.sql.
-- ============================================================

/* O create or replace nao aceita mudar as colunas de uma view existente.
   Apagar antes resolve: ela nao guarda dado, e so uma leitura. */
drop view if exists sia_painel_usuarios;

create view sia_painel_usuarios as
select
  u.id, u.email, u.nome, u.papel, pa.rotulo as papel_rotulo,
  u.status, u.origem, u.plano, u.plano_id, pl.nome as plano_nome,
  u.expira_em, u.aceite_em,
  sia_limite_lojas(u.id) as limite_lojas,
  (select count(*) from sia_lojas l where l.usuario_id = u.id and l.ativa) as lojas_usadas,
  (select string_agg(coalesce(l.shop_nome, l.shop_id), ', ' order by l.ultimo_uso desc)
     from sia_lojas l where l.usuario_id = u.id and l.ativa) as lojas,
  coalesce(pl.cota_mensal, 1) as cota_mensal,
  coalesce(pl.cota_semanal, 4) as cota_semanal,
  u.total_relatorios, u.total_coletas, u.ultimo_acesso,
  (select count(*) from sia_sessoes s
    where s.usuario_id = u.id and s.encerrada_em is null and s.expira_em > now()) as sessoes_ativas,
  (select s.dispositivo_nome from sia_sessoes s
    where s.usuario_id = u.id and s.encerrada_em is null
    order by s.ultima_batida desc limit 1) as dispositivo_atual,
  case when u.expira_em is null then null
       else floor(extract(epoch from (u.expira_em - now())) / 86400)::int end as dias_para_vencer,
  u.observacao, u.criado_em,

  /* OS PRODUTOS ATIVOS DA PESSOA. Equipe entra em tudo por papel, entao
     aparece com os dois mesmo sem linha na tabela de assinaturas. */
  case when u.papel in ('adm','ceo','consultor') then true
       else exists (
         select 1 from sia_assinaturas a
         where a.usuario_id = u.id and a.produto_id = 'seller_ia'
           and a.status <> 'cancelado'
           and (a.vence_em is null or a.vence_em >= now())
       ) end as tem_seller_ia,

  case when u.papel in ('adm','ceo','consultor') then true
       else exists (
         select 1 from sia_assinaturas a
         where a.usuario_id = u.id and a.produto_id = 'radar360'
           and a.status <> 'cancelado'
           and (a.vence_em is null or a.vence_em >= now())
       ) end as tem_radar360,

  (select a.vence_em from sia_assinaturas a
   where a.usuario_id = u.id and a.produto_id = 'radar360') as vence_radar360

from sia_usuarios u
join sia_papeis pa on pa.papel = u.papel
left join sia_planos pl on pl.id = u.plano_id;

-- ============================================================
-- CONFIRA
--
--   select email, tem_seller_ia, tem_radar360 from sia_painel_usuarios limit 5;
--
-- Equipe aparece com os dois em true. Quem so assina a Seller.IA aparece
-- com o Radar em false.
-- ============================================================

-- ============================================================
-- SELLER.IA · HISTORICO DIARIO POR CONTA
-- Rodar depois de prompt-relatorio.sql
-- ============================================================
-- POR QUE ISTO EXISTE: sem historico a extensao e uma foto do momento.
-- Nao da para dizer se a conta melhorou, se a acao que o analista tomou
-- funcionou, nem gerar comparativo sem recoletar dois meses toda vez.
--
-- POR QUE RESUMO E NAO PAYLOAD BRUTO: sao ~40 numeros por conta por dia,
-- uns 2 KB. Com 1000 lojas da ~700 MB/ano, que cabe folgado no plano Pro.
-- Guardar produtos e campanhas inteiros TODO DIA viraria deposito.
-- ============================================================

create table if not exists historico_diario (
  id             bigserial primary key,
  shop_id        text not null,
  loja_nome      text,
  dia            date not null,              -- o dia dos DADOS (D-1), nao o da coleta
  coletado_em    timestamptz not null default now(),

  -- conta
  gmv_pago       numeric,
  pedidos_pagos  integer,
  visitantes     integer,
  visualizacoes  integer,
  carrinho       integer,
  conversao_pct  numeric,
  ticket_medio   numeric,
  cancelamentos  integer,
  nota_loja      numeric,
  penalidade     integer,

  -- shopee ads
  ads_investido  numeric,
  ads_impressoes bigint,
  ads_cliques    integer,
  ads_pedidos    integer,
  ads_gmv        numeric,
  ads_roas       numeric,
  ads_ctr_pct    numeric,
  ads_cpa        numeric,
  ads_campanhas  integer,

  -- afiliados
  afil_gmv       numeric,
  afil_comissao  numeric,
  afil_pedidos   integer,

  -- agregados derivados
  tacos_pct      numeric,                    -- investido / gmv
  dependencia_ads_pct numeric,
  margem_media_pct    numeric,               -- so existe se o Cofre estiver preenchido
  piso_roas      numeric,

  -- contagens de veredito, para ver a conta melhorando ou piorando
  prod_total     integer,
  prod_ruins     integer,
  prod_atencao   integer,
  prod_bons      integer,
  camp_prejuizo  integer,
  camp_sufocadas integer,
  camp_escalando integer,

  origem         text default 'extensao',
  unique (shop_id, dia)
);

create index if not exists hist_loja_dia on historico_diario (shop_id, dia desc);
create index if not exists hist_dia on historico_diario (dia desc);
alter table historico_diario enable row level security;

-- ============================================================
-- CADASTRO DE LOJAS — para o painel de administracao
-- ============================================================
-- Conta nunca e apagada: e ARQUIVADA. Assim o historico continua
-- respondendo "como esse cliente estava quando saiu" e um retorno nao
-- comeca do zero.

create table if not exists lojas (
  shop_id        text primary key,
  nome           text,
  arquivada      boolean not null default false,
  arquivada_em   timestamptz,
  motivo         text,
  primeira_leitura timestamptz not null default now(),
  ultima_leitura   timestamptz not null default now(),
  dias_com_dado    integer not null default 0,
  observacao     text
);
alter table lojas enable row level security;

-- ativa = teve leitura nos ultimos 14 dias e nao esta arquivada.
-- 14 dias porque uma agencia nao abre toda conta toda semana; abaixo
-- disso a lista encheria de falso inativo.
create or replace view lojas_status as
select
  l.shop_id,
  l.nome,
  l.arquivada,
  l.ultima_leitura,
  l.dias_com_dado,
  case
    when l.arquivada then 'arquivada'
    when l.ultima_leitura > now() - interval '14 days' then 'ativa'
    else 'inativa'
  end as situacao,
  extract(day from now() - l.ultima_leitura)::int as dias_sem_leitura,
  (select h.gmv_pago from historico_diario h
    where h.shop_id = l.shop_id order by h.dia desc limit 1) as ultimo_gmv,
  (select h.ads_roas from historico_diario h
    where h.shop_id = l.shop_id order by h.dia desc limit 1) as ultimo_roas
from lojas l;

-- ============================================================
-- LIMPEZA — retencao de 24 meses
-- ============================================================
-- 24 meses porque cobre comparacao ano contra ano, que e o que importa
-- em e-commerce com sazonalidade. Loja arquivada NAO e afetada: o dado
-- dela e justamente o que se quer preservar.

create or replace function limpar_historico_antigo()
returns integer language plpgsql as $$
declare n integer;
begin
  delete from historico_diario h
  where h.dia < (current_date - interval '24 months')
    and not exists (
      select 1 from lojas l where l.shop_id = h.shop_id and l.arquivada
    );
  get diagnostics n = row_count;
  return n;
end $$;

-- ============================================================
-- GRAVACAO — uma linha por loja por dia, sempre a mais recente vence
-- ============================================================

create or replace function gravar_historico(p jsonb)
returns void language plpgsql as $$
begin
  insert into lojas (shop_id, nome, ultima_leitura)
  values (p->>'shop_id', p->>'loja_nome', now())
  on conflict (shop_id) do update
    set nome = coalesce(excluded.nome, lojas.nome),
        ultima_leitura = now();

  insert into historico_diario (
    shop_id, loja_nome, dia,
    gmv_pago, pedidos_pagos, visitantes, visualizacoes, carrinho,
    conversao_pct, ticket_medio, cancelamentos, nota_loja, penalidade,
    ads_investido, ads_impressoes, ads_cliques, ads_pedidos, ads_gmv,
    ads_roas, ads_ctr_pct, ads_cpa, ads_campanhas,
    afil_gmv, afil_comissao, afil_pedidos,
    tacos_pct, dependencia_ads_pct, margem_media_pct, piso_roas,
    prod_total, prod_ruins, prod_atencao, prod_bons,
    camp_prejuizo, camp_sufocadas, camp_escalando
  )
  values (
    p->>'shop_id', p->>'loja_nome', (p->>'dia')::date,
    (p->>'gmv_pago')::numeric, (p->>'pedidos_pagos')::int, (p->>'visitantes')::int,
    (p->>'visualizacoes')::int, (p->>'carrinho')::int,
    (p->>'conversao_pct')::numeric, (p->>'ticket_medio')::numeric,
    (p->>'cancelamentos')::int, (p->>'nota_loja')::numeric, (p->>'penalidade')::int,
    (p->>'ads_investido')::numeric, (p->>'ads_impressoes')::bigint, (p->>'ads_cliques')::int,
    (p->>'ads_pedidos')::int, (p->>'ads_gmv')::numeric, (p->>'ads_roas')::numeric,
    (p->>'ads_ctr_pct')::numeric, (p->>'ads_cpa')::numeric, (p->>'ads_campanhas')::int,
    (p->>'afil_gmv')::numeric, (p->>'afil_comissao')::numeric, (p->>'afil_pedidos')::int,
    (p->>'tacos_pct')::numeric, (p->>'dependencia_ads_pct')::numeric,
    (p->>'margem_media_pct')::numeric, (p->>'piso_roas')::numeric,
    (p->>'prod_total')::int, (p->>'prod_ruins')::int, (p->>'prod_atencao')::int, (p->>'prod_bons')::int,
    (p->>'camp_prejuizo')::int, (p->>'camp_sufocadas')::int, (p->>'camp_escalando')::int
  )
  on conflict (shop_id, dia) do update set
    loja_nome = excluded.loja_nome, coletado_em = now(),
    gmv_pago = excluded.gmv_pago, pedidos_pagos = excluded.pedidos_pagos,
    visitantes = excluded.visitantes, visualizacoes = excluded.visualizacoes,
    carrinho = excluded.carrinho, conversao_pct = excluded.conversao_pct,
    ticket_medio = excluded.ticket_medio, cancelamentos = excluded.cancelamentos,
    nota_loja = excluded.nota_loja, penalidade = excluded.penalidade,
    ads_investido = excluded.ads_investido, ads_impressoes = excluded.ads_impressoes,
    ads_cliques = excluded.ads_cliques, ads_pedidos = excluded.ads_pedidos,
    ads_gmv = excluded.ads_gmv, ads_roas = excluded.ads_roas,
    ads_ctr_pct = excluded.ads_ctr_pct, ads_cpa = excluded.ads_cpa,
    ads_campanhas = excluded.ads_campanhas,
    afil_gmv = excluded.afil_gmv, afil_comissao = excluded.afil_comissao,
    afil_pedidos = excluded.afil_pedidos,
    tacos_pct = excluded.tacos_pct, dependencia_ads_pct = excluded.dependencia_ads_pct,
    margem_media_pct = excluded.margem_media_pct, piso_roas = excluded.piso_roas,
    prod_total = excluded.prod_total, prod_ruins = excluded.prod_ruins,
    prod_atencao = excluded.prod_atencao, prod_bons = excluded.prod_bons,
    camp_prejuizo = excluded.camp_prejuizo, camp_sufocadas = excluded.camp_sufocadas,
    camp_escalando = excluded.camp_escalando;

  update lojas set dias_com_dado = (
    select count(*) from historico_diario h where h.shop_id = p->>'shop_id'
  ) where shop_id = p->>'shop_id';
end $$;

-- ============================================================
-- ARQUIVAR E REATIVAR
-- ============================================================

create or replace function arquivar_loja(p_shop_id text, p_motivo text default null)
returns void language sql as $$
  update lojas set arquivada = true, arquivada_em = now(), motivo = p_motivo
  where shop_id = p_shop_id;
$$;

create or replace function reativar_loja(p_shop_id text)
returns void language sql as $$
  update lojas set arquivada = false, arquivada_em = null, motivo = null
  where shop_id = p_shop_id;
$$;

-- ============================================================
-- CONSULTAS PRONTAS PARA O PAINEL DE ADMINISTRACAO
-- ============================================================

-- carteira: ativas, inativas e arquivadas
--   select situacao, count(*) from lojas_status group by situacao;

-- quem parou de ser olhada
--   select nome, dias_sem_leitura from lojas_status
--   where situacao = 'inativa' order by dias_sem_leitura desc;

-- evolucao de uma loja no mes
--   select dia, gmv_pago, ads_investido, ads_roas, tacos_pct
--   from historico_diario where shop_id = 'XXX'
--   and dia >= current_date - 30 order by dia;

-- contas piorando: ROAS caiu comparando as duas ultimas semanas
--   with s as (
--     select shop_id,
--       avg(ads_roas) filter (where dia >= current_date - 7)  as agora,
--       avg(ads_roas) filter (where dia >= current_date - 14
--                               and dia < current_date - 7)   as antes
--     from historico_diario where dia >= current_date - 14 group by shop_id
--   )
--   select l.nome, s.antes, s.agora from s join lojas l using (shop_id)
--   where s.antes is not null and s.agora < s.antes * 0.8 and not l.arquivada
--   order by s.agora - s.antes;

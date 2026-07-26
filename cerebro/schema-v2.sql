-- ============================================================
-- SELLER.IA — SCHEMA v2 (Camada 2 — Cerebro Coletivo)
-- Colar inteiro no Supabase: SQL Editor > New query > Run.
-- Roda por cima do v1 (usa "create table if not exists"), nao apaga nada.
--
-- OBJETIVO: virar o maior banco de comportamento real do
-- algoritmo Shopee do Brasil. Guarda TUDO com shop_id
-- (decisao da Karina: anonimizar depois, na hora de consultar).
-- ============================================================

-- ------------------------------------------------------------
-- 1) CAMPANHAS EM ESCALA (o coracao do banco)
-- Cada linha = foto de UMA campanha num momento. Guardamos o
-- leilao (cpm, posicao), o funil, o resultado e a meta que a
-- propria Shopee sugeriu. E dessa massa que sai a sabedoria.
-- ------------------------------------------------------------
create table if not exists campanhas_leilao (
  id             bigint generated always as identity primary key,
  shop_id        text not null,
  campaign_id    text not null,
  titulo         text,
  categoria_id   text,               -- pra agrupar "produtos como o seu"
  faixa_preco    text,               -- 'ate80' | '80a100' | '100a200' | '200mais'
  -- leilao
  cpm_real       numeric,            -- R$ por mil impressoes (JA corrigido)
  posicao        int,                -- avg_rank
  sov            numeric,            -- share of voice
  custo_posicao  numeric,            -- location_in_ads
  gasto          numeric,
  -- funil
  impressoes     int,
  cliques        int,
  ctr            numeric,
  atc            int,
  checkout       int,
  cr             numeric,            -- conversion rate
  -- resultado
  roas_amplo     numeric,
  roas_direto    numeric,
  pedidos        int,
  gmv            numeric,
  -- o que a Shopee acha (ouro)
  roas_atual     numeric,            -- current_roi_two_target
  roas_sugerido  numeric,            -- suggested_roi_two_target
  ganho_gmv_pct  numeric,            -- estimate_gmv_pct
  problema       text,               -- issue: low_traffic, etc
  -- triagem (semaforo) no momento da captura
  semaforo       text,               -- vermelho|amarelo|verde|cinza
  estrategia     text,               -- roi_two, auto, manual
  estado         text,               -- ongoing, paused
  capturado_em   timestamptz not null default now()
);
create index if not exists idx_camp_leilao_shop on campanhas_leilao (shop_id, capturado_em desc);
create index if not exists idx_camp_leilao_cat  on campanhas_leilao (categoria_id, faixa_preco);
create index if not exists idx_camp_leilao_cid  on campanhas_leilao (campaign_id, capturado_em desc);
create index if not exists idx_camp_leilao_sem  on campanhas_leilao (semaforo);

-- ------------------------------------------------------------
-- 2) ALGORITMO OBSERVADO (regras do config por conta/momento)
-- Guardamos as regras que vimos pra detectar quando a Shopee
-- muda o jogo (ex: cold start deixa de ser 7 dias).
-- ------------------------------------------------------------
create table if not exists algoritmo_snapshots (
  id                bigint generated always as identity primary key,
  shop_id           text not null,
  aprendizado_dias  int,
  mudanca_max_pct   int,
  bloqueio_dias     int,
  teto_multiplicador int,
  lance_min_produto numeric,
  lance_min_loja    numeric,
  nota_min_auto     numeric,
  percentis         jsonb,
  capturado_em      timestamptz not null default now()
);
create index if not exists idx_algo_shop on algoritmo_snapshots (shop_id, capturado_em desc);

-- ------------------------------------------------------------
-- 3) SAUDE DA LOJA (rating, seguidores, tag) por momento
-- ------------------------------------------------------------
create table if not exists loja_snapshots (
  id             bigint generated always as identity primary key,
  shop_id        text not null,
  rating         numeric,
  avaliacoes     int,
  seguidores     int,
  itens          int,
  tag            text,               -- preferred, mall, etc
  resposta_chat  int,
  capturado_em   timestamptz not null default now()
);
create index if not exists idx_loja_shop on loja_snapshots (shop_id, capturado_em desc);

-- ------------------------------------------------------------
-- 4) TRIAGEM (o resultado do semaforo, agregado por conta)
-- Guarda a foto do semaforo pra acompanhar evolucao no tempo.
-- ------------------------------------------------------------
create table if not exists triagens (
  id             bigint generated always as identity primary key,
  shop_id        text not null,
  total          int,
  vermelho       int,
  amarelo        int,
  verde          int,
  cinza          int,
  gasto_total    numeric,
  rules_version  text,
  capturado_em   timestamptz not null default now()
);
create index if not exists idx_triagem_shop on triagens (shop_id, capturado_em desc);

-- ------------------------------------------------------------
-- 5) VISAO AGREGADA — a SABEDORIA COLETIVA (view, anonima)
-- E daqui que sai "produtos nessa categoria e faixa convertem
-- melhor em ROAS X". Nunca expoe shop_id — so o agregado.
-- So conta grupos com 5+ campanhas pra nao vazar individuo.
-- ------------------------------------------------------------
create or replace view sabedoria_coletiva as
select
  categoria_id,
  faixa_preco,
  count(*)                                as amostras,
  count(distinct shop_id)                 as lojas,
  round(avg(cpm_real)::numeric, 2)        as cpm_medio,
  round(avg(posicao)::numeric, 0)         as posicao_media,
  round(avg(roas_amplo)::numeric, 1)      as roas_medio,
  round(avg(roas_sugerido)::numeric, 1)   as roas_sugerido_medio,
  round(avg(ctr)::numeric, 4)             as ctr_medio,
  round(avg(cr)::numeric, 4)              as cr_medio,
  -- ROAS mediano das campanhas VERDES (as que funcionam)
  round(percentile_cont(0.5) within group (order by roas_amplo)
        filter (where semaforo = 'verde')::numeric, 1) as roas_vencedor_mediano
from campanhas_leilao
where categoria_id is not null
group by categoria_id, faixa_preco
having count(*) >= 5;   -- privacidade: so grupos com 5+ campanhas

-- ------------------------------------------------------------
-- Seguranca: RLS ligado, nenhuma policy publica.
-- Somente o Cerebro (service role) le e escreve.
-- ------------------------------------------------------------
alter table campanhas_leilao    enable row level security;
alter table algoritmo_snapshots enable row level security;
alter table loja_snapshots      enable row level security;
alter table triagens            enable row level security;

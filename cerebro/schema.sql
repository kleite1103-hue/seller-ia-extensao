-- ============================================================
-- SELLER.IA — SCHEMA v1 (Etapa 2)
-- Colar inteiro no Supabase: SQL Editor > New query > Run
-- Camada 1: dados do assinante. RLS ligado sem policies =
-- somente o Cerebro (service role) le e escreve.
-- ============================================================

create table if not exists contas (
  shop_id      text primary key,
  nome         text,
  perfil       jsonb not null default '{}'::jsonb,  -- imposto%, antecipacao, etc (Etapa 3)
  criado_em    timestamptz not null default now(),
  visto_em     timestamptz not null default now()
);

create table if not exists snapshots (
  id           bigint generated always as identity primary key,
  shop_id      text not null,
  dados        jsonb not null,            -- foto completa enviada pela extensao
  capturado_em timestamptz not null default now()
);
create index if not exists idx_snapshots_shop on snapshots (shop_id, capturado_em desc);

create table if not exists snapshots_produto (
  id           bigint generated always as identity primary key,
  shop_id      text not null,
  item_id      text not null,
  nome         text,
  metricas     jsonb not null default '{}'::jsonb,
  capturado_em timestamptz not null default now()
);
create index if not exists idx_snap_prod on snapshots_produto (shop_id, item_id, capturado_em desc);

create table if not exists snapshots_campanha (
  id           bigint generated always as identity primary key,
  shop_id      text not null,
  campaign_id  text not null,
  nome         text,
  estado       text,
  estrategia   text,
  metricas     jsonb not null default '{}'::jsonb,
  variacao     jsonb,
  capturado_em timestamptz not null default now()
);
create index if not exists idx_snap_camp on snapshots_campanha (shop_id, campaign_id, capturado_em desc);

create table if not exists produtos_custos (
  shop_id      text not null,
  item_id      text not null,
  custo        numeric,
  embalagem    numeric not null default 0,
  origem       text not null default 'manual',   -- manual | massa | estimado
  atualizado_em timestamptz not null default now(),
  primary key (shop_id, item_id)
);

create table if not exists diagnosticos (
  id            bigint generated always as identity primary key,
  shop_id       text not null,
  rules_version text not null,
  vereditos     jsonb not null,
  criado_em     timestamptz not null default now()
);
create index if not exists idx_diag_shop on diagnosticos (shop_id, criado_em desc);

-- Seguranca: RLS ligado, nenhuma policy publica.
alter table contas            enable row level security;
alter table snapshots         enable row level security;
alter table snapshots_produto enable row level security;
alter table snapshots_campanha enable row level security;
alter table produtos_custos   enable row level security;
alter table diagnosticos      enable row level security;

-- ============================================================
-- SELLER.IA · PLANOS E LOJAS
-- Rodar DEPOIS do 01-banco.sql, uma vez.
-- Acrescenta: planos com limite de lojas, registro das lojas de
-- cada assinante, e a guarda de todos os dados coletados.
-- ============================================================

-- ---------- PLANOS ----------
create table if not exists sia_planos (
  id             text primary key,
  nome           text not null,
  lojas          int  not null,          -- -1 = ilimitado
  cota_mensal    int  not null,          -- por LOJA
  cota_semanal   int  not null,          -- por LOJA
  preco          numeric(10,2),
  hotmart_oferta text,                   -- codigo da oferta na Hotmart
  ordem          int not null default 0,
  ativo          boolean not null default true
);

insert into sia_planos (id, nome, lojas, cota_mensal, cota_semanal, preco, ordem) values
  ('individual', 'Individual',  1,  1, 4, 147.00, 1),
  ('duo',        'Duo',         3,  1, 4, 267.00, 2),
  ('time',       'Time',        5,  1, 4, 397.00, 3),
  ('agencia',    'Agencia',    -1, -1, -1, null,  4)
on conflict (id) do update
  set nome = excluded.nome, lojas = excluded.lojas,
      cota_mensal = excluded.cota_mensal, cota_semanal = excluded.cota_semanal;

-- o usuario aponta para um plano
alter table sia_usuarios add column if not exists plano_id text references sia_planos(id);
alter table sia_usuarios add column if not exists lojas_extra int not null default 0;  -- avulsas vendidas
alter table sia_usuarios add column if not exists aceite_em timestamptz;               -- consentimento LGPD
alter table sia_usuarios add column if not exists aceite_versao text;

update sia_usuarios set plano_id = 'individual' where plano_id is null and papel = 'usuario';

-- ---------- LOJAS DE CADA ASSINANTE ----------
create table if not exists sia_lojas (
  id             uuid primary key default gen_random_uuid(),
  usuario_id     uuid not null references sia_usuarios(id) on delete cascade,
  shop_id        text not null,
  shop_nome      text,
  registrada_em  timestamptz not null default now(),
  ultimo_uso     timestamptz,
  liberada_em    timestamptz,           -- quando trocou de loja neste slot
  ativa          boolean not null default true,
  unique (usuario_id, shop_id)
);

create index if not exists ix_sia_lojas_usuario on sia_lojas (usuario_id, ativa);

-- ---------- OS DADOS COLETADOS ----------
-- Guarda o retrato de cada leitura. Fica por usuario E por loja, para
-- historico e comparacao entre periodos sem precisar recoletar.
create table if not exists sia_coletas (
  id             bigserial primary key,
  usuario_id     uuid not null references sia_usuarios(id) on delete cascade,
  shop_id        text not null,
  shop_nome      text,
  periodo_ini    bigint,
  periodo_fim    bigint,
  modo           text,                  -- normal | profunda
  conta          jsonb,                 -- gerenciais do periodo
  campanhas      jsonb,                 -- resumo por campanha
  produtos       jsonb,                 -- resumo por produto
  afiliados      jsonb,
  marketing      jsonb,
  em             timestamptz not null default now()
);

create index if not exists ix_sia_coletas_loja on sia_coletas (shop_id, em desc);
create index if not exists ix_sia_coletas_usuario on sia_coletas (usuario_id, em desc);

-- ---------- OS RELATORIOS GERADOS ----------
create table if not exists sia_relatorios (
  id             bigserial primary key,
  usuario_id     uuid not null references sia_usuarios(id) on delete cascade,
  shop_id        text,
  shop_nome      text,
  tipo           text not null,         -- mensal | semanal
  periodo        text,
  markdown       text,
  tokens_entrada int,
  tokens_saida   int,
  custo_estimado numeric(10,4),
  em             timestamptz not null default now()
);

create index if not exists ix_sia_relatorios_usuario on sia_relatorios (usuario_id, em desc);
create index if not exists ix_sia_relatorios_loja on sia_relatorios (shop_id, em desc);

-- ============================================================
-- FUNCOES
-- ============================================================

-- Quantas lojas o usuario pode ter
create or replace function sia_limite_lojas(p_usuario uuid)
returns int
language sql stable as $$
  select case
    when u.papel in ('adm','ceo','consultor') then -1
    when p.lojas < 0 then -1
    else p.lojas + coalesce(u.lojas_extra, 0)
  end
  from sia_usuarios u
  left join sia_planos p on p.id = u.plano_id
  where u.id = p_usuario;
$$;

-- Pode usar esta loja? Registra se houver espaco.
create or replace function sia_pode_loja(p_usuario uuid, p_shop text, p_nome text default null)
returns table (pode boolean, motivo text, usadas int, limite int)
language plpgsql as $$
declare
  v_limite int; v_usadas int; v_ja boolean;
begin
  select sia_limite_lojas(p_usuario) into v_limite;

  -- ilimitado: registra e libera
  if v_limite < 0 then
    insert into sia_lojas (usuario_id, shop_id, shop_nome, ultimo_uso)
    values (p_usuario, p_shop, p_nome, now())
    on conflict (usuario_id, shop_id) do update
      set ultimo_uso = now(), shop_nome = coalesce(excluded.shop_nome, sia_lojas.shop_nome);
    return query select true, 'ilimitado'::text, 0, -1; return;
  end if;

  -- ja registrada: so atualiza o uso
  select exists(select 1 from sia_lojas where usuario_id = p_usuario and shop_id = p_shop and ativa)
    into v_ja;
  if v_ja then
    update sia_lojas set ultimo_uso = now(),
      shop_nome = coalesce(p_nome, shop_nome)
      where usuario_id = p_usuario and shop_id = p_shop;
    select count(*)::int into v_usadas from sia_lojas where usuario_id = p_usuario and ativa;
    return query select true, 'ja registrada'::text, v_usadas, v_limite; return;
  end if;

  -- loja nova: cabe?
  select count(*)::int into v_usadas from sia_lojas where usuario_id = p_usuario and ativa;
  if v_usadas >= v_limite then
    return query select false, 'limite de lojas do plano'::text, v_usadas, v_limite; return;
  end if;

  insert into sia_lojas (usuario_id, shop_id, shop_nome, ultimo_uso)
  values (p_usuario, p_shop, p_nome, now())
  on conflict (usuario_id, shop_id) do update set ultimo_uso = now();
  return query select true, 'registrada agora'::text, v_usadas + 1, v_limite;
end;
$$;

-- Cota POR LOJA, nao por pessoa
create or replace function sia_pode_gerar_loja(p_usuario uuid, p_shop text, p_tipo text)
returns table (pode boolean, usado int, limite int, motivo text)
language plpgsql stable as $$
declare
  v_limite int; v_usado int; v_status text; v_papel text;
begin
  select status, papel into v_status, v_papel from sia_usuarios where id = p_usuario;
  if v_status is null then
    return query select false, 0, 0, 'usuario nao encontrado'; return;
  end if;
  if v_status not in ('ativo','teste') then
    return query select false, 0, 0, ('assinatura ' || v_status)::text; return;
  end if;
  if v_papel in ('adm','ceo','consultor') then
    return query select true, 0, -1, 'ilimitado'::text; return;
  end if;

  select case when p_tipo = 'relatorio_semanal' then p.cota_semanal else p.cota_mensal end
    into v_limite
  from sia_usuarios u left join sia_planos p on p.id = u.plano_id
  where u.id = p_usuario;

  if v_limite is null or v_limite < 0 then
    return query select true, 0, -1, 'ilimitado'::text; return;
  end if;

  select count(*)::int into v_usado
  from sia_uso
  where usuario_id = p_usuario and tipo = p_tipo and loja_id = p_shop
    and em >= now() - interval '30 days';

  if v_usado >= v_limite then
    return query select false, v_usado, v_limite, 'cota desta loja esgotada'::text;
  else
    return query select true, v_usado, v_limite, 'ok'::text;
  end if;
end;
$$;

-- ============================================================
-- PAINEL: visao atualizada
-- ============================================================
create or replace view sia_painel_usuarios as
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
  u.observacao, u.criado_em
from sia_usuarios u
join sia_papeis pa on pa.papel = u.papel
left join sia_planos pl on pl.id = u.plano_id;

create or replace view sia_painel_resumo as
select
  (select count(*) from sia_usuarios where status = 'ativo')    as ativos,
  (select count(*) from sia_usuarios where status = 'suspenso') as suspensos,
  (select count(*) from sia_usuarios where status = 'cancelado') as cancelados,
  (select count(*) from sia_usuarios where expira_em between now() and now() + interval '7 days') as vencendo,
  (select count(*) from sia_sessoes where encerrada_em is null and expira_em > now()) as sessoes_agora,
  (select count(*) from sia_lojas where ativa) as lojas_total,
  (select count(*) from sia_relatorios where em > now() - interval '30 days') as relatorios_30d,
  (select count(*) from sia_coletas where em > now() - interval '30 days')    as coletas_30d,
  (select count(*) from sia_usuarios where ultimo_acesso > now() - interval '7 days')   as ativos_7d,
  (select count(*) from sia_usuarios where ultimo_acesso > now() - interval '24 hours') as ativos_hoje,
  (select coalesce(sum(custo_estimado),0) from sia_relatorios where em > now() - interval '30 days') as custo_ia_30d;

-- lojas atendidas, para o painel
create or replace view sia_painel_lojas as
select l.shop_id, coalesce(l.shop_nome, l.shop_id) as nome,
  u.email, u.nome as dono, u.papel,
  l.registrada_em, l.ultimo_uso,
  (select count(*) from sia_coletas c where c.shop_id = l.shop_id) as coletas,
  (select count(*) from sia_relatorios r where r.shop_id = l.shop_id) as relatorios
from sia_lojas l
join sia_usuarios u on u.id = l.usuario_id
where l.ativa
order by l.ultimo_uso desc nulls last;

alter table sia_planos     enable row level security;
alter table sia_lojas      enable row level security;
alter table sia_coletas    enable row level security;
alter table sia_relatorios enable row level security;

-- confere:
-- select * from sia_planos order by ordem;
-- select email, plano_nome, lojas_usadas, limite_lojas, lojas from sia_painel_usuarios;

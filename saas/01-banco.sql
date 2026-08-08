-- ============================================================
-- SELLER.IA · CONTROLE DE ACESSO
-- Rodar UMA VEZ no SQL Editor do Supabase.
-- Nao toca em nada do que ja existe: cria tabelas novas.
-- ============================================================

-- ---------- PAPEIS E COTAS PADRAO ----------
-- Cada papel tem uma cota sugerida. A cota individual, quando
-- preenchida, sempre vence a do papel.
create table if not exists sia_papeis (
  papel            text primary key,
  rotulo           text not null,
  cota_mensal      int  not null,   -- -1 = ilimitado
  cota_semanal     int  not null,
  pode_admin       boolean not null default false,
  ordem            int  not null default 0
);

insert into sia_papeis (papel, rotulo, cota_mensal, cota_semanal, pode_admin, ordem) values
  ('adm',       'Administrador', -1, -1, true,  1),
  ('ceo',       'CEO',           -1, -1, true,  2),
  ('consultor', 'Consultor',     -1, -1, false, 3),
  ('usuario',   'Usuario',        1,  4, false, 4)
on conflict (papel) do update
  set rotulo = excluded.rotulo,
      cota_mensal = excluded.cota_mensal,
      cota_semanal = excluded.cota_semanal,
      pode_admin = excluded.pode_admin;

-- ---------- USUARIOS ----------
create table if not exists sia_usuarios (
  id               uuid primary key default gen_random_uuid(),
  email            text unique not null,
  nome             text,
  papel            text not null default 'usuario' references sia_papeis(papel),

  -- cota individual: quando preenchida, ignora a do papel
  cota_mensal      int,
  cota_semanal     int,

  -- assinatura
  status           text not null default 'ativo',   -- ativo | suspenso | cancelado | teste
  origem           text not null default 'manual',  -- manual | hotmart
  hotmart_id       text,
  plano            text,
  expira_em        timestamptz,

  -- seguranca
  senha_hash       text,
  token_recuperar  text,
  token_expira     timestamptz,
  precisa_trocar   boolean not null default true,

  -- uso
  ultimo_acesso    timestamptz,
  total_relatorios int not null default 0,
  total_coletas    int not null default 0,

  observacao       text,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now()
);

create index if not exists ix_sia_usuarios_email  on sia_usuarios (lower(email));
create index if not exists ix_sia_usuarios_status on sia_usuarios (status);

-- ---------- SESSOES ----------
-- Uma sessao ativa por usuario: entrar numa maquina derruba a outra.
create table if not exists sia_sessoes (
  id             uuid primary key default gen_random_uuid(),
  usuario_id     uuid not null references sia_usuarios(id) on delete cascade,
  token          text unique not null,
  dispositivo    text,              -- impressao digital do navegador
  dispositivo_nome text,            -- "Chrome no Windows"
  ip             text,
  criada_em      timestamptz not null default now(),
  expira_em      timestamptz not null,
  ultima_batida  timestamptz not null default now(),
  encerrada_em   timestamptz,
  motivo_fim     text               -- logout | outra_sessao | expirou | revogada
);

create index if not exists ix_sia_sessoes_token   on sia_sessoes (token);
create index if not exists ix_sia_sessoes_usuario on sia_sessoes (usuario_id, encerrada_em);

-- ---------- USO ----------
-- Cada acao que consome cota fica registrada, com a loja envolvida.
create table if not exists sia_uso (
  id           bigserial primary key,
  usuario_id   uuid not null references sia_usuarios(id) on delete cascade,
  tipo         text not null,        -- relatorio_mensal | relatorio_semanal | coleta
  loja_id      text,
  loja_nome    text,
  detalhe      jsonb,
  em           timestamptz not null default now()
);

create index if not exists ix_sia_uso_usuario on sia_uso (usuario_id, em desc);
create index if not exists ix_sia_uso_tipo    on sia_uso (tipo, em desc);

-- ---------- REGISTRO DE EVENTOS ----------
-- Tudo que importa para auditoria: quem entrou, o que mudou, o que falhou.
create table if not exists sia_eventos (
  id          bigserial primary key,
  usuario_id  uuid references sia_usuarios(id) on delete set null,
  email       text,
  evento      text not null,   -- login | login_negado | sessao_derrubada | cota_excedida | ...
  detalhe     jsonb,
  ip          text,
  em          timestamptz not null default now()
);

create index if not exists ix_sia_eventos_em on sia_eventos (em desc);

-- ---------- EMAILS ENVIADOS ----------
create table if not exists sia_emails (
  id          bigserial primary key,
  para        text not null,
  tipo        text not null,   -- boas_vindas | recuperar_senha | assinatura_vencendo | suspenso
  assunto     text,
  enviado_em  timestamptz not null default now(),
  ok          boolean not null default true,
  erro        text
);

-- ============================================================
-- FUNCOES DE APOIO
-- ============================================================

-- A cota que vale para o usuario: a individual quando existe,
-- senao a do papel.
create or replace function sia_cota(p_usuario uuid)
returns table (mensal int, semanal int, ilimitado boolean)
language sql stable as $$
  select
    coalesce(u.cota_mensal,  p.cota_mensal)  as mensal,
    coalesce(u.cota_semanal, p.cota_semanal) as semanal,
    (coalesce(u.cota_mensal, p.cota_mensal) < 0) as ilimitado
  from sia_usuarios u
  join sia_papeis p on p.papel = u.papel
  where u.id = p_usuario;
$$;

-- Quanto ja foi usado no ciclo corrente (30 dias a partir da
-- assinatura, nao do dia 1: assim o custo se distribui).
create or replace function sia_uso_no_ciclo(p_usuario uuid, p_tipo text)
returns int
language sql stable as $$
  select count(*)::int
  from sia_uso
  where usuario_id = p_usuario
    and tipo = p_tipo
    and em >= (
      select coalesce(
        criado_em + (floor(extract(epoch from (now() - criado_em)) / 2592000) * interval '30 days'),
        now() - interval '30 days'
      )
      from sia_usuarios where id = p_usuario
    );
$$;

-- Pode gerar? Devolve o veredito com o que sobrou.
create or replace function sia_pode_gerar(p_usuario uuid, p_tipo text)
returns table (pode boolean, usado int, limite int, motivo text)
language plpgsql stable as $$
declare
  v_mensal int; v_semanal int; v_ilimitado boolean;
  v_limite int; v_usado int; v_status text;
begin
  select status into v_status from sia_usuarios where id = p_usuario;
  if v_status is null then
    return query select false, 0, 0, 'usuario nao encontrado'; return;
  end if;
  if v_status <> 'ativo' and v_status <> 'teste' then
    return query select false, 0, 0, 'assinatura ' || v_status; return;
  end if;

  select mensal, semanal, ilimitado into v_mensal, v_semanal, v_ilimitado
  from sia_cota(p_usuario);

  if v_ilimitado then
    return query select true, 0, -1, 'ilimitado'::text; return;
  end if;

  v_limite := case when p_tipo = 'relatorio_semanal' then v_semanal else v_mensal end;
  v_usado  := sia_uso_no_ciclo(p_usuario, p_tipo);

  if v_usado >= v_limite then
    return query select false, v_usado, v_limite, 'cota do ciclo esgotada'::text;
  else
    return query select true, v_usado, v_limite, 'ok'::text;
  end if;
end;
$$;

-- ============================================================
-- PAINEL: VISOES PRONTAS
-- ============================================================

create or replace view sia_painel_usuarios as
select
  u.id, u.email, u.nome, u.papel, p.rotulo as papel_rotulo,
  u.status, u.origem, u.plano, u.expira_em,
  coalesce(u.cota_mensal,  p.cota_mensal)  as cota_mensal,
  coalesce(u.cota_semanal, p.cota_semanal) as cota_semanal,
  (u.cota_mensal is not null or u.cota_semanal is not null) as cota_manual,
  sia_uso_no_ciclo(u.id, 'relatorio_mensal')  as usou_mensal,
  sia_uso_no_ciclo(u.id, 'relatorio_semanal') as usou_semanal,
  u.total_relatorios, u.total_coletas, u.ultimo_acesso,
  (select count(*) from sia_sessoes s
    where s.usuario_id = u.id and s.encerrada_em is null and s.expira_em > now()) as sessoes_ativas,
  (select s.dispositivo_nome from sia_sessoes s
    where s.usuario_id = u.id and s.encerrada_em is null
    order by s.ultima_batida desc limit 1) as dispositivo_atual,
  case
    when u.expira_em is null then null
    else floor(extract(epoch from (u.expira_em - now())) / 86400)::int
  end as dias_para_vencer,
  u.observacao, u.criado_em
from sia_usuarios u
join sia_papeis p on p.papel = u.papel;

create or replace view sia_painel_resumo as
select
  (select count(*) from sia_usuarios where status = 'ativo')                      as ativos,
  (select count(*) from sia_usuarios where status = 'suspenso')                   as suspensos,
  (select count(*) from sia_usuarios where status = 'cancelado')                  as cancelados,
  (select count(*) from sia_usuarios where expira_em between now() and now() + interval '7 days') as vencendo,
  (select count(*) from sia_sessoes where encerrada_em is null and expira_em > now()) as sessoes_agora,
  (select count(*) from sia_uso where tipo like 'relatorio%' and em > now() - interval '30 days') as relatorios_30d,
  (select count(*) from sia_uso where tipo = 'coleta' and em > now() - interval '30 days')        as coletas_30d,
  (select count(*) from sia_usuarios where ultimo_acesso > now() - interval '7 days')             as ativos_7d,
  (select count(*) from sia_usuarios where ultimo_acesso > now() - interval '24 hours')           as ativos_hoje;

-- uso por dia, para o grafico
create or replace view sia_painel_uso_diario as
select
  date_trunc('day', em)::date as dia,
  count(*) filter (where tipo = 'relatorio_mensal')  as mensais,
  count(*) filter (where tipo = 'relatorio_semanal') as semanais,
  count(*) filter (where tipo = 'coleta')            as coletas,
  count(distinct usuario_id)                         as pessoas
from sia_uso
where em > now() - interval '60 days'
group by 1 order by 1 desc;

-- quem mais usa
create or replace view sia_painel_top_uso as
select u.email, u.nome, u.papel,
  count(*) filter (where x.tipo like 'relatorio%') as relatorios,
  count(*) filter (where x.tipo = 'coleta')        as coletas,
  count(distinct x.loja_id)                        as lojas,
  max(x.em)                                        as ultimo_uso
from sia_uso x
join sia_usuarios u on u.id = x.usuario_id
where x.em > now() - interval '30 days'
group by u.email, u.nome, u.papel
order by relatorios desc, coletas desc;

-- ============================================================
-- SEGURANCA: so a funcao com service_role enxerga estas tabelas
-- ============================================================
alter table sia_usuarios enable row level security;
alter table sia_sessoes  enable row level security;
alter table sia_uso      enable row level security;
alter table sia_eventos  enable row level security;
alter table sia_emails   enable row level security;
alter table sia_papeis   enable row level security;

-- sem policy nenhuma: a chave anon nao le nada.
-- O service_role, usado pelas Edge Functions, ignora RLS.

-- ============================================================
-- PRIMEIRO ADMINISTRADOR — troque o email antes de rodar
-- ============================================================
insert into sia_usuarios (email, nome, papel, status, origem, plano, observacao)
values ('karina@selleriaclub.com', 'Karina', 'adm', 'ativo', 'manual', 'Interno', 'primeiro acesso')
on conflict (email) do update set papel = 'adm', status = 'ativo';

-- confere:
-- select * from sia_painel_resumo;
-- select email, papel, status, cota_mensal, cota_semanal from sia_painel_usuarios;

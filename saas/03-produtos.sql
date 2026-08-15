-- ============================================================
-- SELLER.IA · 03-produtos.sql
-- Acesso por produto na MESMA base de usuarios.
--
-- POR QUE ASSIM: uma pessoa que assina os dois entra nos dois com o
-- mesmo email. Duas bases separadas obrigariam a cadastrar duas vezes,
-- e a agencia que gerencia varias lojas teria o dobro de trabalho para
-- a mesma pessoa.
--
-- Rodar DEPOIS do 01-banco.sql e do 02-planos.sql.
-- ============================================================

-- ---------- 1. QUAIS PRODUTOS EXISTEM ----------
create table if not exists sia_produtos (
  id          text primary key,          -- 'seller_ia' | 'radar360'
  nome        text not null,
  ativo       boolean not null default true,
  criado_em   timestamptz not null default now()
);

insert into sia_produtos (id, nome) values
  ('seller_ia', 'Seller.IA'),
  ('radar360',  'Radar 360')
on conflict (id) do nothing;


-- ---------- 2. QUEM ASSINA O QUE ----------
-- Uma linha por pessoa por produto. Assinar o Radar nao mexe na
-- assinatura da Seller.IA, e vice-versa: sao cobrancas separadas com
-- vencimentos proprios.
create table if not exists sia_assinaturas (
  id           bigserial primary key,
  usuario_id   uuid not null references sia_usuarios(id) on delete cascade,
  produto_id   text   not null references sia_produtos(id),
  status       text   not null default 'ativo',   -- ativo | vencido | cancelado
  vence_em     timestamptz,
  origem       text,                              -- hotmart, manual, cortesia
  codigo_oferta text,                             -- o codigo que veio do checkout
  criado_em    timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (usuario_id, produto_id)
);

create index if not exists ix_assin_usuario on sia_assinaturas(usuario_id);
create index if not exists ix_assin_produto on sia_assinaturas(produto_id, status);


-- ---------- 3. MIGRA QUEM JA EXISTE ----------
-- Todo mundo que ja usa a Seller.IA continua usando: sem isto, publicar
-- a mudanca trancaria a base inteira do lado de fora.
insert into sia_assinaturas (usuario_id, produto_id, status, origem)
select u.id, 'seller_ia', 'ativo', 'migracao'
from sia_usuarios u
where not exists (
  select 1 from sia_assinaturas a
  where a.usuario_id = u.id and a.produto_id = 'seller_ia'
);


-- ---------- 4. CODIGOS DE OFERTA POR PRODUTO ----------
-- O webhook do checkout manda o codigo da oferta; esta tabela diz a que
-- produto e a que plano ele corresponde. Trocar de oferta deixa de exigir
-- deploy.
create table if not exists sia_ofertas (
  codigo      text primary key,
  produto_id  text not null references sia_produtos(id),
  plano_id    text references sia_planos(id),
  meses       int not null default 1,
  ativo       boolean not null default true
);


-- ---------- 4b. SESSAO POR PRODUTO ----------
-- A sessao precisa saber de QUAL produto ela e: sem isso, entrar no Radar
-- encerraria a sessao da Seller.IA na outra aba, e a pessoa seria expulsa
-- de um produto ao abrir o outro.
alter table sia_sessoes
  add column if not exists produto_id text not null default 'seller_ia'
  references sia_produtos(id);

create index if not exists ix_sessoes_produto on sia_sessoes(usuario_id, produto_id, encerrada_em);


-- ---------- 5. A PERGUNTA QUE A PORTARIA FAZ ----------
-- "Esta pessoa pode usar este produto agora?" Uma funcao so, usada pelas
-- duas extensoes, para a regra nao divergir entre elas.
create or replace function sia_pode_produto(p_usuario uuid, p_produto text)
returns table (pode boolean, motivo text, vence_em timestamptz)
language plpgsql
as $$
declare
  v_papel  text;
  v_status text;
  v_assin  record;
begin
  select papel, status into v_papel, v_status
  from sia_usuarios where id = p_usuario;

  if v_papel is null then
    return query select false, 'usuario nao encontrado'::text, null::timestamptz;
    return;
  end if;

  if v_status <> 'ativo' then
    return query select false, 'conta inativa'::text, null::timestamptz;
    return;
  end if;

  -- quem toca a casa entra em tudo, sempre
  -- os papeis reais da base: adm, ceo, consultor, usuario
  if v_papel in ('adm', 'ceo', 'consultor') then
    return query select true, 'equipe'::text, null::timestamptz;
    return;
  end if;

  select * into v_assin
  from sia_assinaturas
  where usuario_id = p_usuario and produto_id = p_produto;

  if v_assin is null then
    return query select false, 'sem assinatura deste produto'::text, null::timestamptz;
    return;
  end if;

  if v_assin.status = 'cancelado' then
    return query select false, 'assinatura cancelada'::text, v_assin.vence_em;
    return;
  end if;

  if v_assin.vence_em is not null and v_assin.vence_em < now() then
    return query select false, 'assinatura vencida'::text, v_assin.vence_em;
    return;
  end if;

  return query select true, 'ok'::text, v_assin.vence_em;
end;
$$;


-- ---------- 6. O QUE A PESSOA ASSINA, PARA A TELA MOSTRAR ----------
create or replace view sia_v_assinaturas as
select
  u.id            as usuario_id,
  u.email,
  u.papel,
  u.status        as status_conta,
  p.id            as produto_id,
  p.nome          as produto,
  a.status        as status_assinatura,
  a.vence_em,
  a.origem,
  case
    when u.papel in ('adm','ceo','consultor') then true
    when a.id is null then false
    when a.status = 'cancelado' then false
    when a.vence_em is not null and a.vence_em < now() then false
    else true
  end             as ativa
from sia_usuarios u
cross join sia_produtos p
left join sia_assinaturas a
  on a.usuario_id = u.id and a.produto_id = p.id
where p.ativo;


-- ============================================================
-- DEPOIS DE RODAR, CONFIRA
--
--   select * from sia_v_assinaturas where email = 'seu@email.com';
--
-- Deve trazer duas linhas, uma por produto, dizendo se cada uma esta
-- ativa. Quem ja usava a Seller.IA aparece com ela ativa e o Radar nao.
-- ============================================================

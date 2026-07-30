-- ============================================================
-- SELLER.IA · TABELA DE CONHECIMENTO
-- ============================================================
-- POR QUE AS REGRAS SAO DADO E NAO CODIGO:
-- em poucos meses a Shopee trocou o item_basic, migrou para oCPM, criou
-- Grupo de Anuncios e Anuncio Automatico de Loja. Se cada mudanca exigir
-- reescrever cerebro.ts e republicar, o conhecimento envelhece mais rapido
-- do que a gente atualiza. Como dado, a Karina edita um limiar sem deploy.
--
-- E o mais importante: isto vive no Supabase, nunca na extensao.
-- A extensao e codigo aberto na maquina do usuario. Isto e o metodo.
-- ============================================================

create table if not exists conhecimento (
  id            bigserial primary key,
  dominio       text not null,          -- 'produto' | 'campanha' | 'conta' | 'ads_formato' | 'limiar'
  chave         text not null,          -- identificador estavel da regra
  versao        text not null default 'ocpm-2.0',
  ativo         boolean not null default true,
  prioridade    int not null default 100,   -- menor roda primeiro
  condicao      jsonb,                  -- quando a regra vale
  veredito      jsonb,                  -- nivel, titulo, texto, passos
  fonte         text,                   -- de onde saiu (rota da API, doc, medicao)
  observacao    text,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (dominio, chave, versao)
);

create index if not exists conhecimento_busca on conhecimento (dominio, ativo, prioridade);

-- Mesma politica das outras tabelas: RLS ligado, sem policy publica.
-- Somente a service_role (usada pela Edge Function) le e escreve.
-- O metodo NUNCA pode ser lido pela chave anon que vive na extensao.
alter table conhecimento enable row level security;


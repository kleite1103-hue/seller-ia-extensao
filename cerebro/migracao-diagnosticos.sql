-- coluna nova para separar versao de conhecimento de versao de codigo
alter table diagnosticos add column if not exists code_version text;

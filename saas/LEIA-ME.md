# Seller.IA · Controle de acesso

Estrutura independente. Não toca em nada do que já existe — cria tabelas
e funções novas, com prefixo `sia_`.

---

## O que cada arquivo é

| Arquivo | Onde vai | O que faz |
|---|---|---|
| `01-banco.sql` | SQL Editor do Supabase | Cria tabelas, funções e visões |
| `acesso.ts` | Edge Function `acesso` | Login, sessão única, cota, webhook Hotmart |
| `admin.ts` | Edge Function `admin` | Tudo que o painel consome |
| `email.ts` | Edge Function `email` | Boas-vindas, recuperação, avisos |
| `painel.html` | Cloudflare Pages ou VPS | O painel de controle |

---

## Ordem de instalação

### 1 · Banco

No Supabase, **SQL Editor**, cola o `01-banco.sql` inteiro e roda.

**Antes de rodar**, troque o email da última linha pelo seu — é o primeiro
administrador, e sem ele você não entra no painel.

Confere com:
```sql
select * from sia_painel_resumo;
```

### 2 · Secrets

Em **Edge Functions → Secrets**, cadastre:

| Nome | Onde consegue |
|---|---|
| `RESEND_API_KEY` | resend.com → API Keys |
| `HOTMART_HOTTOK` | Hotmart → Ferramentas → Webhook |

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` o Supabase injeta sozinho.

### 3 · Funções

Crie três funções novas — `acesso`, `admin`, `email` — cole cada arquivo
e publique.

**Em todas: desligue o Verify JWT.** A extensão chama sem chave; a
segurança é o token que a própria função emite.

### 4 · Painel

Suba o `painel.html` em qualquer lugar que sirva HTML. Se for Cloudflare
Pages, é arrastar o arquivo.

Antes, troque a primeira linha do script se o projeto Supabase for outro:
```js
var SUPABASE = 'https://SEU-PROJETO.supabase.co/functions/v1';
```

### 5 · Hotmart

No painel da Hotmart, **Ferramentas → Webhook (Postback)**, aponte para:

```
https://SEU-PROJETO.supabase.co/functions/v1/acesso
```

Marque os eventos:

**Liberam acesso** — Compra aprovada, Compra completa, Assinatura reativada
**Suspendem** — Reembolso, Chargeback, Compra cancelada, Assinatura cancelada

Cada compra aprovada cadastra a pessoa sozinha e envia as boas-vindas.

---

## Cloudflare

O Supabase já fica atrás de Cloudflare, então TLS e proteção básica você
tem de graça. O que vale acrescentar:

### Se o painel for no Cloudflare Pages

**Access** — protege o painel com login antes mesmo de chegar no HTML.
Em Zero Trust → Access → Applications, aponte para o domínio do painel e
libere só os emails da diretoria. Fica uma camada antes da nossa.

### Se quiser proteger as funções

Coloque um domínio próprio na frente, tipo `api.selleria.com.br`, apontando
para o Supabase por CNAME. Aí você ganha:

**Rate limiting** — trave `/acesso` em 10 chamadas por minuto por IP. Login
legítimo não passa disso; força bruta passa.

**WAF** — as regras gerenciadas cobrem injeção e varredura automática.

**Bot Fight Mode** — barra raspagem automatizada.

**Analytics** — você vê de onde vêm as chamadas, e picos estranhos aparecem.

Custo: o plano Pro é 20 dólares por mês e cobre tudo isso.

---

## Como funciona a sessão

Uma sessão por pessoa. Entrar em outra máquina **derruba a primeira** e
avisa quem entrou: *"a sessão em Chrome no Windows foi encerrada"*.

Token vale 24 horas. Depois disso, a extensão pede o email de novo.

O painel mostra quem está online, em qual dispositivo, e você pode derrubar
qualquer sessão a qualquer momento.

---

## Cotas

Cada papel tem uma cota. A individual, quando preenchida, sempre vence.

| Papel | Mensal | Semanal |
|---|---|---|
| Administrador | ilimitado | ilimitado |
| CEO | ilimitado | ilimitado |
| Consultor | ilimitado | ilimitado |
| Usuário | 1 | 4 |

Use `-1` para ilimitado. O ciclo conta 30 dias a partir do cadastro da
pessoa, não do dia 1 do mês — assim o custo se distribui e você não leva
todos os relatórios no mesmo dia.

---

## Para testar antes de vender

1. Rode o SQL com o seu email como `adm`
2. Publique as três funções
3. Abra o painel e entre com o seu email
4. Cadastre o time em lote, papel `consultor`
5. Cada um recebe o email e entra na extensão

Na segunda-feira você vê quem entrou, quantas coletas fez e em quais lojas.

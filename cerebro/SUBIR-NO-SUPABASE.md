# O QUE SUBIR NO SUPABASE
**Projeto:** `mkfreezlizdbfpjjpxoo` (cérebro da extensão)
Tudo abaixo é seguro de rodar mais de uma vez — usa `if not exists` e `on conflict do nothing`.

---

## PASSO 1 · SQL Editor — na ordem

Abra **SQL Editor → New query**, cole um arquivo por vez e rode.

| ordem | arquivo | o que faz | já rodou antes? |
|---|---|---|---|
| 1 | `cerebro/schema.sql` | tabelas base: `contas`, `snapshots`, `snapshots_produto`, `snapshots_campanha`, `produtos_custos`, `diagnosticos` | provavelmente sim |
| 2 | `cerebro/schema-v2.sql` | `campanhas_leilao`, `algoritmo_snapshots`, `loja_snapshots`, `triagens` | provavelmente sim |
| 3 | **`cerebro/migracao-diagnosticos.sql`** | adiciona a coluna `code_version` | **não — é novo** |
| 4 | **`cerebro/schema-conhecimento.sql`** | cria a tabela `conhecimento` e insere todas as regras | **não — é novo** |

Se o 1 e o 2 já rodaram, pode rodar de novo sem risco: nada é apagado.

**O 4 é o importante.** É ele que coloca o método no servidor.

---

## PASSO 2 · Conferir se o conhecimento entrou

Rode no SQL Editor:

```sql
select dominio, count(*) as regras
from conhecimento
where ativo = true
group by dominio
order by dominio;
```

**Resultado esperado:**

| dominio | regras |
|---|---|
| ads_formato | 6 |
| algoritmo | 4 |
| limiar | 7 |
| postura | 1 |
| produto | 8 |
| qualidade_anuncio | 1 |
| restricao | 1 |
| shopee_diagnostico | 5 |
| shopee_verdict | 4 |

**Total: 37 regras.** Se vier menos, algum `insert` falhou — me manda o erro.

---

## PASSO 3 · Publicar a Edge Function

**Recomendo subir como função NOVA**, não substituir a que está rodando. Assim você testa em paralelo e só troca quando estiver de pé.

1. **Edge Functions → Deploy a new function**
2. Nome: `cerebro-v2`
3. Cole o conteúdo de **`cerebro/cerebro-v2.ts`**
4. Deploy

**Variáveis de ambiente** — em Edge Functions → Settings → Secrets:

| nome | valor |
|---|---|
| `SUPABASE_URL` | `https://mkfreezlizdbfpjjpxoo.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | a service role key do projeto |

> A `service_role` é obrigatória: a tabela `conhecimento` tem RLS ligado e sem policy pública. **A chave `anon` que vive na extensão não consegue ler o método** — é assim que ele fica protegido.

---

## PASSO 4 · Testar a função direto, antes de ligar na extensão

No terminal, ou em qualquer cliente HTTP:

```bash
curl -X POST \
  'https://mkfreezlizdbfpjjpxoo.supabase.co/functions/v1/cerebro-v2' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer SUA_ANON_KEY' \
  -d '{
    "loja": "413140457",
    "snapshot": {
      "margemMediaPct": 30,
      "produtos": {
        "111": { "nome": "Teste sem visita",  "metricas": { "visitantes": 40 } },
        "222": { "nome": "Teste nao converte", "metricas": { "visitantes": 2000, "ctr_card": 0.035, "conversao_pago": 0.006, "vendas_pagas": 8240 } }
      },
      "campanhas": {
        "999": {
          "type": "product_manual",
          "subtype": "product_homepage__roi_two__target",
          "report": { "gasto": 110.75, "impression": 66150, "click": 2740, "broad_order": 21, "broad_roi": 9.14 },
          "metaShopee": { "atual": 10.6, "sugerida": 3.0, "ganhoGmvPct": 30 }
        }
      }
    }
  }'
```

**O que tem que voltar:**

- `rules_version: "ocpm-2.0"` e `code_version: "cerebro-2.0.0"`
- Um veredito para o produto `111` dizendo **"Visitas insuficientes para julgar"**
- Um veredito para o produto `222` dizendo **"Recebe clique e não vende"**
- Para a campanha `999`, com margem de 30% o piso é **3,33x** e a Shopee sugere **3,0x** — abaixo do piso. Então tem que voltar **"Não siga a meta que a Shopee sugere aqui"**

Esse último é o teste que mais importa: **é a prova de que o cérebro protege a margem em vez de repetir a plataforma.**

---

## PASSO 5 · Apontar a extensão para a função nova

No arquivo `extensao/bg.js`, a constante `SIA_CEREBRO_URL` aponta para a função atual. Troque `/cerebro` por `/cerebro-v2` quando o passo 4 estiver passando.

Se preferir, me avisa que eu troco e subo.

---

## RESUMO — o que é novo de verdade

Só duas coisas:

1. **`cerebro/schema-conhecimento.sql`** — a tabela `conhecimento` com as 37 regras
2. **`cerebro/cerebro-v2.ts`** — a função que lê essas regras

O resto é infraestrutura que já existia.

E uma observação que importa: **a partir do momento que isso sobe, atualizar uma regra deixa de exigir deploy.** Você abre a tabela `conhecimento`, edita um limiar ou um texto de veredito, e todas as contas passam a usar o novo na próxima análise. O cache da função é de 5 minutos.

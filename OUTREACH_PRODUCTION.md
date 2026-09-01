# LeadMap Pro — Outreach: infraestrutura de produção (Fase C)

Transforma o Outreach de um protótipo local numa infraestrutura com
persistência real, autenticação e fila durável — **sem ativar nenhum
fornecedor de Instagram**.

> ## ⚠ Estado
>
> **Nenhuma mensagem real é enviada.** O `MetaInstagramProvider` continua
> `ARCHITECTURE ONLY / NOT VALIDATED FOR PRODUCTION` e bloqueado; o
> fornecedor externo continua genérico e não configurado. O worker usa um
> fornecedor controlado, e **em produção recusa-se a correr** em vez de
> simular envios.

---

## 1. Arquitetura

```
Browser (index.html)
   │  cookie HttpOnly de sessão
   ▼
/api/outreach/*            ← autenticação + autorização em TODAS as rotas
   │
   ▼
OutreachService            ← casos de uso, validação, auditoria
   │
   ▼
OutreachRepository         ← interface
   ├── InMemoryOutreachRepository    (dev / testes)
   └── PostgresOutreachRepository    (produção)
            │
            ▼
      PostgreSQL           ← constraints, transações, FOR UPDATE SKIP LOCKED
```

A UI **nunca** fala com a base de dados. As credenciais vivem só em
variáveis de ambiente do backend.

| Ficheiro | Papel |
|---|---|
| `providers/outreach/domain.mjs` | Regras puras: idempotência, backoff, transições, elegibilidade, validação, redação |
| `providers/outreach/repository.mjs` | Interface + implementação em memória |
| `providers/outreach/postgres.mjs` | Implementação PostgreSQL por HTTP (PostgREST) |
| `providers/outreach/pg-client.mjs` | Cliente PostgreSQL nativo, sem dependências |
| `providers/outreach/pg-repository.mjs` | Implementação PostgreSQL por protocolo nativo |
| `providers/outreach/service.mjs` | Casos de uso e auditoria |
| `providers/outreach/worker.mjs` | Worker: claim → envio → persistência |
| `providers/outreach/auth.mjs` | Sessão assinada, hash de password, guardas |
| `providers/outreach/http.mjs` | Plumbing das rotas: método, auth, erros |
| `providers/outreach/remote-store.mjs` | `RemoteOutreachStore` para a UI |
| `providers/outreach/migrate-local.mjs` | Migração local → remoto |
| `migrations/*.sql` | Esquema, índices e funções transacionais |

---

## 2. Dois adapters PostgreSQL, e porquê

Neste repositório o `package.json` está no `.gitignore` por decisão
anterior do projeto: **nenhuma dependência npm é versionada**, logo um
driver como `pg` não chega ao deployment.

Em vez de mudar essa decisão às escondidas, o `PostgresOutreachRepository`
fala com o PostgreSQL **por HTTP** (PostgREST/Supabase), usando apenas
`fetch` — nativo no runtime da Vercel.

**A atomicidade não é sacrificada:** vive toda em funções SQL
(`migrations/003`), invocadas por RPC. O `FOR UPDATE SKIP LOCKED`
continua a ser executado pelo PostgreSQL, e cada RPC é uma transação.

### O que o adapter HTTP NÃO consegue fazer

A auditoria mostrou dois limites reais:

1. **Não aplica migrations.** PostgREST expõe tabelas e funções; não
   executa DDL nem SQL arbitrário. As migrations têm de ser aplicadas por
   outro caminho.
2. **Não abre transações que atravessem vários pedidos.** Cada pedido é
   a sua própria transação. Chega para o runtime (as operações compostas
   já são um único RPC), mas não permite manter linhas bloqueadas
   enquanto outra sessão tenta reclamá-las — que é como se prova o
   `SKIP LOCKED`.

### `pg-client.mjs` + `PgOutreachRepository`

Por isso existe um segundo adapter, sobre o **protocolo nativo do
PostgreSQL** implementado em `providers/outreach/pg-client.mjs`:
`node:net`/`node:tls` + SCRAM-SHA-256, **sem dependências npm**. Cobre
migrations, sessões independentes e queries parametrizadas.

### Qual adapter corre em produção

**O caminho de request usa exclusivamente o adapter HTTP.**
`construirRepositorio()` (em `http.mjs`) só constrói
`PostgresOutreachRepository` ou, fora de produção,
`InMemoryOutreachRepository` — nunca `PgOutreachRepository`. Nenhum
ficheiro de `api/` importa `pg-client.mjs` ou `pg-repository.mjs`.

| | Adapter HTTP (`postgres.mjs`) | Adapter nativo (`pg-repository.mjs`) |
|---|---|---|
| Caminho de request na Vercel | **sim, único** | não |
| Migrations (DDL) | não consegue | sim |
| Testes de integração e concorrência | não consegue | sim |
| Ligações TCP por invocação | nenhuma | uma, fechada no fim |

A razão é operacional, não estética: funções serverless escalam a frio e
em paralelo; abrir uma ligação TCP por invocação esgota `max_connections`
muito antes de o tráfego ser interessante. O adapter HTTP não abre
nenhuma. O adapter nativo existe para o que o HTTP não consegue fazer —
DDL e transações que atravessam pedidos — e corre onde isso é seguro:
migrations, testes e ferramentas administrativas deliberadas.

Ambas as implementações cumprem a mesma interface: o domínio, a API e os
testes não mudam consoante o adapter.

**Postura de segurança do cliente nativo:** o certificado TLS é sempre
validado (`rejectUnauthorized` só é desligado por um opt-in explícito
`tlsInsecure`, recusado quando `OUTREACH_ENV` é de produção); há timeout
de ligação (15 s por omissão) e de inatividade, ambos fechando o socket;
a password e o material SCRAM são apagados da memória assim que a sessão
fica pronta; autenticação por password em claro é recusada sem TLS; e
qualquer falha destrói o socket em vez de o deixar pendurado. O cliente
nunca escreve credenciais em log — `descricaoSegura()` devolve host,
base e utilizador redigidos.

---

## 3. Tabelas

Esquema `outreach`:

| Tabela | Constraints que interessam |
|---|---|
| `instagram_account` | `UNIQUE(provider, username)`; trigger que impõe **máximo 5 contas ativas** |
| `contact` | Índices UNIQUE parciais: `normalized_instagram`, ou `lead_id` quando não há Instagram |
| `template` | `body` entre 1 e 2000 caracteres; apagar é soft-delete |
| `campaign` | FK para conta e template; estados verificados por CHECK |
| `campaign_contact` | **`UNIQUE(campaign_id, contact_id)`** — impede dupla inclusão |
| `message` | **`UNIQUE(idempotency_key)`** — impede duplo envio |
| `queue_item` | `UNIQUE(message_id)`; estados por CHECK |
| `webhook_event` | **`UNIQUE(provider, provider_event_id)`** |
| `audit_event` | Append-only |

Nenhuma tabela guarda password, cookie, token ou fingerprint.

---

## 4. Idempotência

```
idempotencyKey = campaignId : contactId : accountId : v<messageVersion>
```

Determinística, sem `Math.random`, com `UNIQUE` real no banco.

Consequência: clicar duas vezes, repetir o pedido, reiniciar o worker ou
a Vercel repetir a função **não cria uma segunda mensagem**. O segundo
`start` colide com a constraint e é ignorado.

---

## 5. Fila e claim atómico

`outreach.claim_queue_items(worker_id, limit, lock_timeout_seconds)`:

```sql
SELECT … FROM queue_item q JOIN campaign c ON c.id = q.campaign_id
 WHERE c.status = 'RUNNING' AND (…)
 ORDER BY priority DESC, available_at ASC, id ASC
 LIMIT p_limit
 FOR UPDATE OF q SKIP LOCKED
```

Seleção e marcação na **mesma instrução**, dentro da mesma transação.
Nunca há "SELECT primeiro, UPDATE depois".

**Locks expirados:** um item `PROCESSING` cujo `locked_at` passou de 300 s
volta a ser elegível. Um worker que morre não deixa trabalho preso.

---

## 6. Retries e backoff

| Tentativa | Espera |
|---|---|
| 1.ª | 30 s |
| 2.ª | 2 min |
| 3.ª | 10 min |
| seguintes | 30 min (teto) |

`maxAttempts` = 3 por omissão; depois disso, `FAILED` e não se tenta mais.

Se o fornecedor devolver `retryAfterSec`, esse valor **tem precedência**,
limitado a 6 h — respeitar não é obedecer a um valor absurdo.

Tudo persiste em `attempt_count`, `available_at`, `last_error_code` e
`last_error_message`. Nada depende de `setTimeout` em memória.

---

## 7. Pause, resume, cancel

- **Pause** → campanha `PAUSED`, itens `PENDING` passam a `PAUSED`.
  **Um item já reclamado não é interrompido** — interromper a meio de uma
  operação já iniciada arriscaria duplicar o envio. O item em curso
  termina; nenhum outro arranca.
- **Resume** → itens voltam a `PENDING`. **Não recria mensagens nem
  repõe `attempt_count`.**
- **Cancel** → itens `PENDING`/`PAUSED` passam a `CANCELLED`. **O que já
  foi `SENT` não é apagado nem reenviado.**

Estados terminais (`SENT`, `CANCELLED`, `SKIPPED`, `FAILED`) nunca
reabrem.

---

## 8. Opt-out

Validado **no backend**, em dois momentos: ao construir a campanha e
outra vez imediatamente antes do envio — porque o opt-out pode acontecer
depois de o item entrar na fila. Nesse caso o item fica `SKIPPED` com
`OPTED_OUT`.

---

## 9. Autenticação

O LeadMap não tinha autenticação. Agora:

- sessão assinada com **HMAC-SHA256** (`OUTREACH_AUTH_SECRET`);
- cookie **HttpOnly + Secure + SameSite=Strict** — nunca `localStorage`;
- password do operador guardada como **hash scrypt**, comparada em tempo
  constante;
- **todas** as rotas verificam sessão (401) e papel (403) — esconder o
  botão no frontend não protege nada;
- o endpoint do worker tem **segredo próprio** (`OUTREACH_WORKER_SECRET`)
  e não aceita sessão de browser;
- **sem segredo configurado, o backend recusa tudo.** Não existe modo
  "aberto por omissão".

Isto autentica o **operador do LeadMap**. Não há password de Instagram em
lado nenhum.

---

## 10. API

Todas as rotas exigem sessão; `audit` exige o papel `outreach:admin`.

```
POST   /api/outreach/session                    login
DELETE /api/outreach/session                    logout
GET    /api/outreach/session                    estado (auth + configuração)

GET    /api/outreach/contacts?limit&offset&status
POST   /api/outreach/contacts                   importar

GET    /api/outreach/templates
POST   /api/outreach/templates
PATCH  /api/outreach/templates?id=…
DELETE /api/outreach/templates?id=…

GET    /api/outreach/accounts
POST   /api/outreach/accounts

GET    /api/outreach/campaigns
GET    /api/outreach/campaigns?id=…             detalhe + KPIs
POST   /api/outreach/campaigns                  criar
POST   /api/outreach/campaigns?id=…&action=start|pause|resume|cancel

GET    /api/outreach/queue?campaignId&status
GET    /api/outreach/audit                      (admin)

POST   /api/outreach/worker                     X-Outreach-Worker-Secret
```

Paginação obrigatória: 50 por omissão, **200 no máximo**.
Erros normalizados: `{ success:false, errorCode, message, requestId }`,
sem stack trace em produção.

---

## 11. Variáveis de ambiente

Ver `.env.example`. **Nenhuma tem valor real neste repositório** e
nenhuma chega ao browser.

```
OUTREACH_DB_URL, OUTREACH_DB_SERVICE_KEY, OUTREACH_DB_SCHEMA
OUTREACH_AUTH_SECRET, OUTREACH_OPERATOR_EMAIL, OUTREACH_OPERATOR_PASSWORD_HASH
OUTREACH_WORKER_SECRET
OUTREACH_ENV
```

Gerar o hash da password:

```js
import { criarHashPassword } from './providers/outreach/auth.mjs';
console.log(criarHashPassword('a-sua-password'));
```

---

## 12. Migração local → remoto

`analisarEstadoLocal()` mostra primeiro o que existe; `migrarParaRemoto()`
executa, e é **idempotente**: correr duas vezes não duplica nada
(contactos por Instagram/leadId, templates por nome+corpo).

**O estado local não é apagado.**

| Migra | Não migra |
|---|---|
| Contactos | Mensagens produzidas pelo fornecedor de teste |
| Templates | Itens de fila locais |
| Campanhas `DRAFT` (só a pedido, sem fila) | Contas locais |

Mensagens e respostas de teste ficam de fora deliberadamente: migrá-las
transformaria atividade fabricada em histórico de produção — exatamente o
que a v1.0.1 corrigiu.

---

## 13. Ambiente

`OUTREACH_ENV`: `development` · `test` · `production`.

O fornecedor de teste só é aceite fora de produção. **Em produção, sem
fornecedor real aprovado, o worker devolve `PROVIDER_NOT_AVAILABLE` e não
processa a fila.** Nunca há simulação silenciosa a passar por produção.

Sem `OUTREACH_DB_URL`, a aplicação principal continua a arrancar: a
pesquisa e o histórico funcionam, e o Outreach responde `NOT_CONFIGURED`.

---

## 14. Serverless

Nenhum estado crítico fica em RAM. A fila, os locks, as tentativas e o
agendamento vivem no PostgreSQL, pelo que a função pode morrer, mudar de
instância ou reiniciar sem perder trabalho.

**Não há Vercel Cron configurado nesta fase.** O endpoint do worker existe
e está protegido; ligá-lo a um agendador é uma decisão separada.

---

## 15. Limitações conhecidas

### PostgreSQL: VALIDADO

As migrations correram em **PostgreSQL 16.15** real e isolado. Estão
verificados no catálogo: 9 tabelas, 33 índices (8 parciais), as
constraints UNIQUE críticas, as foreign keys, os CHECK e o trigger do
teto de 5 contas. O `SKIP LOCKED` foi provado com duas sessões
concorrentes: a segunda saltou as linhas bloqueadas em vez de esperar.
Concorrência real com 10 workers e 1000 itens: **0 duplicações**.

Correr a bateria:

```bash
OUTREACH_TEST_DATABASE_URL=postgresql://user:pass@host:port/db node --test
```

Sem essa variável os testes de PostgreSQL são **saltados** com mensagem
explícita — nunca passam a fingir que validaram.

### Crash entre o envio e a persistência

Se o fornecedor aceitar a mensagem e o processo morrer antes de gravar o
resultado, o item volta a ser elegível quando o lock expirar — e seria
enviado outra vez.

**Mitigação desenhada, por concluir:** a `idempotencyKey` é passada ao
fornecedor em cada envio. Um fornecedor que a respeite devolve a mesma
mensagem em vez de criar uma segunda. **A API oficial da Meta não expõe
esse mecanismo**, por isso, quando o provider real for ligado, esta
janela tem de ser fechada por reconciliação: consultar o fornecedor pelo
`idempotencyKey`/conversa antes de reenviar um item recuperado.

### Sem UI para a Fase C

A interface do Outreach continua a usar o `LocalOutreachStore`. O
`RemoteOutreachStore` existe, está testado, mas ligá-lo à UI — com ecrã
de login e botão de migração — é trabalho de interface que não foi
pedido nesta fase.

---

## 16. Ligar fornecedores no futuro

Ponto de conexão único: `OutreachWorker` recebe `provider` no
construtor. Qualquer fornecedor que cumpra o contrato da Fase A
(`sendMessage` → resposta normalizada) encaixa sem alterar a fila.

**Meta:** validar primeiro os sete itens da tabela em
`INSTAGRAM_PROVIDERS.md` §2 e só depois `INSTAGRAM_META_ENABLED_FOR_REAL_REQUESTS=1`.

**External:** escolher fornecedor, confirmar que não exige automação de
browser nem sessões capturadas (o adapter recusa essas configurações em
código), e configurar `INSTAGRAM_EXTERNAL_*`.

Enquanto isso não acontecer, o worker não envia nada.

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
| `providers/outreach/routes.mjs` | Os oito handlers + tabela de despacho |
| `api/outreach/[...rota].mjs` | **Única** Serverless Function do Outreach |
| `providers/outreach/remote-store.mjs` | `RemoteOutreachStore` para a UI |
| `providers/outreach/migrate-local.mjs` | Migração local → remoto |
| `migrations/*.sql` | Esquema, índices e funções transacionais |

### Uma função, oito endpoints

Cada ficheiro em `api/` é uma Serverless Function, e o plano tem um teto
de doze por deployment. Oito ficheiros de outreach levavam o projeto a
catorze funções e o build falhava **por inteiro** — nem as funções
antigas nem os ficheiros estáticos chegavam a produção, o que se
manifesta como um deployment que simplesmente não substitui o anterior.

Os handlers passaram para `routes.mjs` sem alteração de lógica e
`api/outreach/[...rota].mjs` escolhe qual chamar pelo nome da rota. São
sete funções no total e **os URLs públicos não mudaram**. Um nome
desconhecido devolve 404 no mesmo formato das outras respostas.

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

| Variável | Uso | Secret | Preview | Production | Browser | Obrigatória |
|---|---|---|---|---|---|---|
| `OUTREACH_DB_URL` | URL do PostgREST/Supabase | não | opcional | sim | **nunca** | sim |
| `OUTREACH_DB_SERVICE_KEY` | Chave de serviço do PostgREST | **sim** | opcional | sim | **nunca** | sim |
| `OUTREACH_DB_SCHEMA` | Esquema (omissão: `outreach`) | não | opcional | opcional | **nunca** | não |
| `OUTREACH_AUTH_SECRET` | Assina a sessão (≥32 chars aleatórios) | **sim** | opcional | sim | **nunca** | sim |
| `OUTREACH_OPERATOR_EMAIL` | Email do operador autorizado | não | opcional | sim | **nunca** | sim |
| `OUTREACH_OPERATOR_PASSWORD_HASH` | Hash scrypt da password | **sim** | opcional | sim | **nunca** | sim |
| `OUTREACH_WORKER_SECRET` | Segredo do endpoint do worker | **sim** | opcional | sim | **nunca** | sim |
| `OUTREACH_ENV` | `development` / `test` / `production` | não | sim | sim | **nunca** | sim |
| `OUTREACH_ADMIN_DATABASE_URL` | DSN direta, **só para migrations** | **sim** | não | **não** | **nunca** | apenas local |
| `OUTREACH_TEST_DATABASE_URL` | DSN da suite de testes | **sim** | não | **não** | **nunca** | apenas local |

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` são aceites como alternativa
às duas primeiras. Prefira os nomes `OUTREACH_DB_*`: dizem para que
servem e não colidem com convenções de frameworks que expõem variáveis
`SUPABASE_*` ao browser.

As duas últimas **nunca** vão para a Vercel. São DSNs diretas de
PostgreSQL, usadas por ferramentas que correm na máquina de quem
administra; pô-las no ambiente do runtime daria à função serverless um
caminho para executar DDL, que é precisamente o que se quer impedir.

Gerar o hash da password — a password não é escrita em ficheiro, log nem
histórico da shell:

```bash
node tools/hash-password.mjs
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

---

## 15A. Sessão e armazenamento remoto (Fase D)

### O que a interface mostra

`providers/outreach/session-gate.mjs` pergunta ao backend em que estado
está e decide o ecrã. Nunca adivinha.

| Resposta de `/session` | Ecrã | Dados visíveis |
|---|---|---|
| `configured: false` | «Outreach ainda não configurado» | **nenhum** — anuncia-se apenas quantos registos existem por migrar |
| `authenticated: false` | Ecrã de entrada | nenhum |
| `databaseConfigured: false` | «Base de dados por configurar» | nenhum |
| tudo verdadeiro | Aplicação | **do servidor** |
| erro / sem resposta | «Outreach temporariamente indisponível» | **nenhum** |

### A regra que manda em tudo

**Quando o backend falha, não se volta ao armazenamento local.** Mostrar
dados locais a quem entrou numa conta é mostrar-lhe uma realidade que não
existe: acredita estar a ver a base de dados, edita em cima disso, e as
duas versões separam-se em silêncio. Um erro visível é sempre melhor.

Consequências no código: `guardar()` recusa-se **em voz alta** em sessão
remota (se algo lá chegar é um caminho de escrita por ligar, e é melhor
dar erro à vista do que gravar no sítio errado), e `carregarRemoto()`
**limpa** o estado em memória antes de mostrar o erro, para que nem dados
remotos antigos fiquem no ecrã a passar por atuais.

**Não há modo local de operação.** A partir da Fase D o
`LocalOutreachStore` existe para exatamente quatro coisas: detetar dados
antigos nesta máquina, mostrar a previsão da migração, executá-la, e
servir de cópia até haver autorização para limpeza. Não se opera
contactos, templates nem campanhas através dele.

### Escritas em sessão remota

| Ação | Caminho |
|---|---|
| Importar contactos (de Leads) | `POST /contacts` |
| Criar, editar, duplicar, eliminar template | `/templates` |
| Registar conta | `POST /accounts` (teto de 5 imposto pela base) |
| Remover conta | **sem rota** — recusa visível |
| Gerar fila, mudar estado de campanha | **sem rota exposta** — recusa visível |
| Opt-out / reativar contacto | **sem rota** — recusa visível |

As três últimas dizem-no ao utilizador em vez de fingirem que
funcionaram. Ligá-las é trabalho de backend (rotas novas), não de
interface.

A sessão é reavaliada **sempre que se entra na vista** — é assim que se
descobre uma sessão expirada ou um backend que caiu entretanto. Custa seis
pedidos por entrada; é o preço de não mentir.

### Autenticação

| | |
|---|---|
| Login | `POST /api/outreach/session`, email + password |
| Password | hash scrypt em variável de ambiente, `timingSafeEqual` |
| Sessão | HMAC-SHA256, cookie `HttpOnly + Secure + SameSite=Strict` |
| Expiração | 12 horas, verificada no servidor |
| Fixação | cada entrada emite uma sessão nova; não há sessão pré-login |
| Logout | `DELETE /api/outreach/session` — invalida o cookie, **não apaga dados** |
| Força bruta | 8 tentativas por origem em 5 minutos → `429` com `Retry-After` |
| CSRF | `SameSite=Strict` + validação de `Origin`/`Referer` nas mutações |
| Cache | `no-store, no-cache, must-revalidate, private` + `Vary: Cookie` |

**Limitação honesta do limitador:** a janela vive em memória e cada
instância serverless tem a sua. Atrasa um atacante, não o bloqueia em
definitivo. É o «limitador simples» pedido, não um serviço distribuído.

### Migração

O botão «Migrar dados locais» mostra primeiro o que vai acontecer:

```
Contactos: 2 · Templates: 1 · Campanhas em rascunho: 1
Fica de fora — mensagens de simulação: 2 · itens de fila: 1 ·
campanhas já executadas: 1 · contactos sem identidade: 1 · contas locais: 1
```

Só depois de o utilizador confirmar é que algo é escrito
(`executarMigracao` recusa-se sem `confirmado: true`). É idempotente e
**o estado local nunca é apagado**.

---

## 15B. Ferramentas administrativas

Correm na máquina de quem administra. Não são servidas pela Vercel e
**não existe nenhuma rota HTTP equivalente** — uma rota capaz de DDL é
uma rota capaz de destruir a base de dados.

| Ferramenta | Para quê |
|---|---|
| `node tools/hash-password.mjs` | Gerar `OUTREACH_OPERATOR_PASSWORD_HASH` |
| `OUTREACH_ADMIN_DATABASE_URL=… node tools/apply-migrations.mjs` | Aplicar migrations (`--dry-run` mostra o plano) |
| `OUTREACH_ADMIN_DATABASE_URL=… node tools/check-schema.mjs` | Confirmar o esquema real contra o catálogo |

`apply-migrations` recusa-se a correr contra a base da suite de testes.

### Cópias de segurança

Não há automatismo nesta fase, e não vale a pena fingir que há. O que
existe depende do fornecedor escolhido: o Supabase inclui *point-in-time
recovery* e retenção de backups **conforme o plano contratado** — antes
de confiar nisso, confirme no painel do projeto qual é a retenção real do
seu plano. Independentemente disso, `pg_dump` contra
`OUTREACH_ADMIN_DATABASE_URL` produz um backup completo e é o mínimo
recomendado antes de qualquer migration nova.

### Desligar a Fase D (rollback)

Remover `OUTREACH_DB_URL` e `OUTREACH_DB_SERVICE_KEY` do ambiente da
Vercel faz o backend voltar a `NOT_CONFIGURED`: as rotas respondem 503, a
interface do Outreach mostra «ainda não configurado», e **o LeadMap
continua a funcionar exatamente na mesma** — pesquisa, histórico,
IndexedDB e XLSX não dependem de nada disto.

Remover também `OUTREACH_AUTH_SECRET` desativa a autenticação. Os dados
já gravados ficam na base de dados, intactos; nada é apagado por
desligar variáveis.

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

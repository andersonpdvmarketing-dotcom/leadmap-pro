# LeadMap Pro — arquitetura multi-provider de Instagram

Camada de abstração que permite ao Outreach falar com **mais do que um
fornecedor de Instagram** — a API oficial da Meta e, quando existir, uma
API de terceiros — sem que o resto da aplicação saiba qual está a ser
usado.

> **Estado desta fase:** a abstração, os adapters, a fila, a auditoria e
> os testes estão feitos. **Nenhum fornecedor externo real foi escolhido
> nem integrado**, e não há App Meta configurada. Os dois adapters reais
> arrancam como *não configurados* até existirem variáveis de ambiente.
>
> Não existe interface de Outreach nesta aplicação. Os ecrãs descritos em
> "Interface" abaixo são o contrato que esta camada já serve — não estão
> construídos. Não há nenhuma rota HTTP nesta fase.

> ## ⚠ META PROVIDER STATUS: ARCHITECTURE ONLY / NOT VALIDATED FOR PRODUCTION
>
> O `MetaInstagramProvider` está **bloqueado para pedidos reais** e não
> faz um único `fetch` enquanto `INSTAGRAM_META_ENABLED_FOR_REAL_REQUESTS`
> não for `1`. Qualquer tentativa devolve
> `{ success: false, status: "NOT_CONFIGURED", errorCode: "META_PROVIDER_NOT_VALIDATED" }`.
>
> ## ⚠ OUTREACH QUEUE: DOMAIN / TEST COMPONENT — NÃO USAR PARA ENVIO REAL
>
> `OutreachQueue` é lógica de domínio em memória. Ver §15.

---

## 1. Arquitetura

```
Campaign
   │  (fixa accountId + provider)
   ▼
OutreachQueue ── limites internos + retryAfter do fornecedor
   │
   ▼
InstagramRegistry.providerForAccount(accountId)
   │
   ├── MetaInstagramProvider      (API oficial da Meta)
   ├── ExternalInstagramProvider  (API de terceiros, por configuração)
   └── MockInstagramProvider      (desenvolvimento e testes)
   │
   ▼
resposta normalizada → OutreachAudit
```

Ficheiros, todos em `providers/instagram/`:

| Ficheiro | Papel |
|---|---|
| `contract.mjs` | Capacidades, estados, códigos de erro, resposta normalizada, forma da conta, recusa de configurações não conformes, redação de segredos |
| `base.mjs` | `BaseInstagramProvider` — interface comum, validação, tradução de HTTP para erros, `fetch` com timeout |
| `mock.mjs` | `MockInstagramProvider` — guionável, sem rede |
| `meta.mjs` | `MetaInstagramProvider` — Graph API |
| `external.mjs` | `ExternalInstagramProvider` — adapter genérico HTTP+JSON |
| `registry.mjs` | Registo de fornecedores e de contas; resolve o fornecedor de cada conta |
| `queue.mjs` | Fila de envio, limites, retry, reencaminhamento manual |
| `audit.mjs` | Registo de auditoria, sem credenciais |
| `config.mjs` | Lê o ambiente e constrói tudo; vista pública para o UI |
| `index.mjs` | **Única** fronteira de importação para o resto do LeadMap |

O resto da aplicação importa de `providers/instagram/index.mjs` e de mais
lado nenhum. Nenhum endpoint de fornecedor aparece fora de `external.mjs`
ou `meta.mjs`.

---

## 2. Provider Meta

**STATUS: ARCHITECTURE ONLY / NOT VALIDATED FOR PRODUCTION.**

Fala com `graph.facebook.com` em HTTP+JSON, com um token que vive só no
backend — mas **está desligado**.

### O que falta validar antes de qualquer envio real

| Item | Estado |
|---|---|
| Endpoints (`/{id}/messages`, `/{id}/conversations`, `business_discovery`) | **NÃO VALIDADO** |
| Versão da Graph API (`v21.0`) | **NÃO VALIDADO** |
| Permissões da App exigidas | **NÃO VALIDADO** |
| Elegibilidade do destinatário | **NÃO VALIDADO** |
| Formato e subscrição de webhooks | **NÃO VALIDADO** |
| Janela e regras de messaging (24 h e afins) | **NÃO VALIDADO — nem implementado** |
| Códigos de erro (190, 4, 17, 613, 10) | **NÃO VALIDADO** |

Tudo isto foi escrito por presunção. Os testes usam `fetch` injetado:
provam a tradução de erros e a forma dos dados, **não provam que a Meta
aceita estes pedidos**.

### Como o bloqueio funciona

`enabledForRealRequests` é `false` por omissão. Com o bloqueio ativo:

- nenhum `fetch` sai — a guarda está em `pedir()`, o ponto único de rede,
  e também no início de `_sendMessage()` e `_connect()`;
- `sendMessage()` devolve
  `{ success: false, status: "NOT_CONFIGURED", errorCode: "META_PROVIDER_NOT_VALIDATED", retryable: false }`;
- `connect()`, `fetchProfile()` e `listConversations()` lançam;
- `isConfigured()` é `false` mesmo com token válido, por isso o UI mostra
  o fornecedor como não configurado;
- a fila marca o item `FAILED` **sem** retry — o bloqueio não se resolve
  com tempo.

Levantar o bloqueio exige `INSTAGRAM_META_ENABLED_FOR_REAL_REQUESTS=1`,
exatamente `"1"` (`true`, `yes` ou `TRUE` não servem). **Só depois de
validar tudo o que está na tabela acima.**

Os testes ativam a flag explicitamente através de `metaEmModoDeTeste()`,
sempre com `fetch` injetado — modo de teste, nunca rede real.

### Estrutura (para quando for validado)

**Capacidades declaradas:** enviar mensagens, ler conversas, receber
webhooks, obter perfil. **Não declara** `canCheckEligibility` nem
`canFetchDeliveryStatus`: a Meta não expõe um "esta conta pode receber
DM?" antes do envio, e declarar `false` é mais honesto do que devolver um
palpite. O estado de entrega chega por webhook, não por consulta.

Particularidade que o adapter não contorna: a API oficial endereça o
destinatário por **IGSID**, não por `@username`. Sem IGSID — que só
existe depois de uma conversa ou de um webhook — o envio é recusado com
`INVALID_REQUEST`. Nenhum identificador é inventado.

Erros da Meta traduzidos: `190`/`OAuthException` → `INVALID_TOKEN`;
`4`, `17`, `613` → `RATE_LIMITED`; `10` → `ACCOUNT_RESTRICTED`.

---

## 3. Provider externo

Adapter genérico para um fornecedor terceiro com API própria. Os
caminhos vêm da configuração, por isso trocar de fornecedor é editar
variáveis de ambiente, não reescrever código.

### Condições de integração — verificadas em código

O construtor **recusa** qualquer configuração que contenha chaves como
`cookie`, `sessionId`, `csrfToken`, `userAgent`, `deviceId`,
`fingerprint`, `proxy`, `puppeteer`, `playwright`, `selenium`,
`password`, `totpSecret` ou `checkpointBypass`, incluindo aninhadas. A
verificação está em `rejeitarConfigNaoConforme()`.

Isto quer dizer, na prática: **um fornecedor que dependa de automação de
browser, de cookies de sessão capturados, de injeção de sessão, de
simulação de dispositivo, de rotação de proxy para evasão, de spoofing
de fingerprint ou de contorno de checkpoints, de limites ou de bloqueios
da Meta não é integrável aqui** — o adapter falha a arrancar. A decisão
de não integrar está no código, não numa nota de rodapé.

`baseUrl` tem de ser **HTTPS**: a credencial nunca viaja em claro.

### Autenticação

Usa-se o fluxo do próprio fornecedor — OAuth, token ou API key. O
`connect()` aceita `authorizationCode` ou `providerSessionToken` emitidos
pelo fornecedor. **A password do Instagram nunca é aceite nem guardada**;
`BaseInstagramProvider.connect()` rejeita-a antes de chegar ao adapter.

---

## 4. Capacidades

Um fornecedor declara o que sabe fazer; o que não declarar fica `false`.

| Capacidade | Efeito quando ausente |
|---|---|
| `canSendMessage` | `sendMessage` devolve `NOT_SUPPORTED` |
| `canReadConversations` | `listConversations` lança `NOT_SUPPORTED` |
| `canReceiveWebhooks` | `parseWebhook` devolve `[]` |
| `canCheckEligibility` | elegibilidade fica `UNKNOWN` — nunca `ELIGIBLE` |
| `canFetchProfile` | `fetchProfile` lança `NOT_SUPPORTED` |
| `canFetchDeliveryStatus` | estado de entrega fica `UNKNOWN` |

O UI lê `capabilities` de cada conta (via `registry.accountsView()`) e
esconde as ações que aquele fornecedor não suporta. Nunca se finge
suporte.

---

## 5. Credenciais

Todas as credenciais vivem em variáveis de ambiente do backend. **Nenhuma
chega ao browser.**

```
INSTAGRAM_META_ACCESS_TOKEN        token da App Meta
INSTAGRAM_META_APP_SECRET          assinatura de webhooks
INSTAGRAM_META_VERIFY_TOKEN        handshake de subscrição
INSTAGRAM_META_GRAPH_VERSION       opcional (por omissão v21.0)

INSTAGRAM_EXTERNAL_PROVIDER        nome do fornecedor, mostrado no UI
INSTAGRAM_EXTERNAL_BASE_URL        origem HTTPS da API
INSTAGRAM_EXTERNAL_API_KEY         credencial
INSTAGRAM_EXTERNAL_ACCOUNT_ID      conta por omissão (opcional)
INSTAGRAM_EXTERNAL_CAPABILITIES    ex.: "canSendMessage,canFetchProfile"
INSTAGRAM_EXTERNAL_PATHS           JSON opcional com caminhos alternativos

OUTREACH_MAX_PER_HOUR              limite interno por conta (omissão 20)
OUTREACH_MAX_PER_DAY               limite interno por conta (omissão 100)
OUTREACH_ENABLE_MOCK               "1" para registar o fornecedor mock
```

**Não existe nenhuma rota HTTP nesta fase.** A vista pública
(`vistaPublica()`) devolve apenas id, nome, capacidades, se está
configurado e os **nomes** das variáveis em falta — nunca o `baseUrl`,
nunca o token, nunca a chave. Há testes que serializam todas as vias e
falham se algum segredo aparecer.

Quando existir uma rota que exponha isto, tem de ficar atrás de
autenticação: o nome do fornecedor externo e o estado de configuração
são informação operacional que não deve ser pública.

---

## 6. Contas

Máximo de **5 contas ligadas em simultâneo**. Cada uma guarda exatamente:

`provider` · `providerAccountId` · `username` · `displayName` · `status`
· `connectedAt` · `lastSyncAt`

O token não está aqui: vive no backend, indexado por `providerAccountId`.

**Cada conta pode usar um fornecedor diferente.** A chave local é
`provider:providerAccountId`, de propósito — a mesma conta Instagram
ligada por dois fornecedores são dois registos distintos.

Estados possíveis: `CONNECTED`, `DISCONNECTED`, `TOKEN_EXPIRED`,
`RESTRICTED`, `RATE_LIMITED`, `ERROR`.

---

## 7. Fila e envio

> **OUTREACH QUEUE: DOMAIN / TEST COMPONENT. NÃO USAR PARA ENVIO REAL**
> enquanto não existirem: persistência durável · idempotency key ·
> unique constraint · atomic claim · worker locking · cancelamento
> persistente · retry persistente. Ver §15.

Fluxo único para qualquer fornecedor:

```
Campaign → Queue → InstagramProvider → fornecedor → resposta normalizada
```

Toda a resposta tem a mesma forma:

```js
{ success, providerMessageId, status, errorCode, errorMessage, retryable, retryAfterSec }
```

`sendMessage()` **nunca lança** — a falha volta como resposta, para que a
fila decida sem `try/catch` espalhado pelo código.

Códigos de erro normalizados: `RATE_LIMITED`, `TIMEOUT`, `NETWORK`,
`PROVIDER_UNAVAILABLE`, `INVALID_TOKEN`, `ACCOUNT_RESTRICTED`,
`RECIPIENT_UNAVAILABLE`, `RECIPIENT_INELIGIBLE`, `MESSAGE_REJECTED`,
`NOT_SUPPORTED`, `NOT_CONFIGURED`, `INVALID_REQUEST`, `UNKNOWN`.

`retryable` significa "tentar mais tarde, **na mesma conta e no mesmo
fornecedor**" — nunca noutro.

---

## 8. Limites

Dois níveis, ambos respeitados:

1. **Internos**, por conta: `OUTREACH_MAX_PER_HOUR` e
   `OUTREACH_MAX_PER_DAY`. Atingido o limite, os itens ficam `DEFERRED`.
2. **Do fornecedor**: um `429` (ou `retryAfter` no corpo) põe a conta em
   pausa exatamente pelo tempo pedido e marca-a `RATE_LIMITED`.

Não existe nenhum caminho no código que contorne qualquer dos dois. Um
`429` adia o item — nunca o reencaminha, nunca acelera, nunca troca de
conta para continuar a enviar.

Erros recuperáveis usam recuo exponencial (30 s, 60 s, 120 s, com teto de
1 hora) quando o fornecedor não indica tempo próprio; ao fim de
`maxTentativas` (3) o item fica `FAILED`.

---

## 9. Elegibilidade

Se o fornecedor tiver endpoint de elegibilidade, usa-se: um destinatário
`INELIGIBLE` é ignorado sem gastar envio. Se não tiver, o estado é
`UNKNOWN` e o envio segue — mas **nunca se marca como elegível quem não
foi verificado**. Não se assume que um `@username` qualquer pode receber
DM.

---

## 10. Sem fallback automático

A campanha guarda `accountId` **e** `provider`, e o item da fila congela
o `provider` no momento em que entra.

Se a conta mudar de fornecedor a meio, o item é parado com `SKIPPED` e
uma mensagem explícita, em vez de ser enviado pelo novo. **Nunca há
fallback automático** entre fornecedores: uma mensagem que a Meta recusou
pode ter sido entregue à mesma, e reenviá-la por outro caminho
duplicá-la-ia.

O reencaminhamento manual existe e exige confirmação explícita:

```js
queue.reencaminharManualmente(itemId, novoAccountId, { confirmadoPeloUtilizador: true });
```

Sem essa flag, lança. Um item já enviado com sucesso nunca é
reencaminhado.

---

## 11. Webhooks

Cada adapter traduz o formato do seu fornecedor para eventos comuns:

`MESSAGE_DELIVERED` · `MESSAGE_READ` · `MESSAGE_FAILED` ·
`REPLY_RECEIVED` · `ACCOUNT_STATUS_CHANGED`

Eventos desconhecidos são descartados. Se o fornecedor não declarar
`canReceiveWebhooks`, `parseWebhook()` devolve `[]`.

A validação de assinatura (`INSTAGRAM_META_APP_SECRET` na Meta) pertence
ao endpoint HTTP que receber o webhook — endpoint que ainda não existe,
por não haver Outreach.

---

## 12. Auditoria

Cada envio processado grava: `timestamp`, `provider`, `accountId`,
`username`, `campaignId`, `recipient`, `providerMessageId`, `status`,
`errorCode`, `errorMessage`, `tentativa`.

Dupla proteção contra fugas: a lista de campos é **fechada** (um campo
novo com um token dentro não entra por acidente) e cada entrada passa por
`redigir()`, que mascara qualquer chave com aspeto de credencial,
incluindo aninhada. Há testes para ambas.

Para produção, injetar um `sink` com método `escrever(entrada)`; a
redação já foi feita antes de o sink ver o que quer que seja.

---

## 13. Interface (contrato já servido, ecrãs por construir)

**Outreach > Contas Instagram** — `registry.accountsView()` devolve, por
conta: `providerLabel` (`Meta` ou `External — <nome>`), `username`,
`status`, `connectedAt`, `lastSyncAt` e as `capabilities` do fornecedor
daquela conta, para o UI esconder ações não suportadas.

**Outreach > Configurações > Providers** — `vistaPublica(registry, env)`
devolve os fornecedores, capacidades, se estão configurados, as variáveis
em falta e os limites internos. **Nenhuma rota HTTP foi criada nesta
fase**, deliberadamente: o LeadMap não tem autenticação, e publicar esta
informação sem ela revelaria configuração operacional a qualquer pessoa.

---

## 14. Testes

```bash
node --test
```

85 testes, sem dependências, com `fetch` injetado — nenhuma chamada real
sai da máquina. Cobrem: capacidades e `NOT_SUPPORTED`; connect,
disconnect, teto de 5 contas; fornecedor por conta; envio e resposta
normalizada; `429` com `Retry-After`, timeout, token inválido,
destinatário indisponível, `success:false` com HTTP 200; webhooks de
entrega, leitura, falha e resposta; estado de entrega; limites horário e
diário; pausa por `429` e retoma depois do tempo pedido; elegibilidade
ausente a dar `UNKNOWN`; ausência de troca automática de fornecedor;
reencaminhamento manual com e sem confirmação; auditoria sem tokens;
recusa de configurações não conformes; e ausência de segredos na vista
pública.

---

## 15. Limitações conhecidas — ler antes de ligar a produção

Apuradas na auditoria pré-commit. Nenhuma é impeditiva para a fase de
arquitetura; **todas são impeditivas para envio real**.

### Persistência: não existe

`accounts`, `queue`, `audit`, contadores de limite e pausas vivem em
`Map`/array na instância. **Não há base de dados, ficheiro nem KV.**
Reiniciar o processo apaga tudo: contas ligadas, fila pendente, histórico
de limites e auditoria. `campaigns` e `messages` não têm sequer modelo —
o `campaignId` é só uma etiqueta que atravessa a fila.

### Fila: componente de domínio, não fila de produção

`OutreachQueue` é lógica de domínio testável, **não uma fila
production-ready**. Em Vercel serverless cada invocação é um processo
novo: uma fila em memória perde os itens ao terminar a função, e os
contadores de `OUTREACH_MAX_PER_HOUR`/`PER_DAY` reiniciam a cada
invocação — ou seja, **os limites não são fiáveis em serverless**.

Produção exige armazenamento partilhado (Postgres, Redis, Vercel KV) para
itens, contadores e pausas, e um worker persistente ou cron a drenar a
fila.

### Concorrência: sem reivindicação atómica

Dois workers que chamem `processarItem()` no mesmo item **enviam os dois**.
Há guarda de estado terminal (um item `SENT`/`FAILED`/`SKIPPED` nunca
volta ao fornecedor), mas não há lock: ambos leem `PENDING` antes de
qualquer um escrever. Só é seguro com **um único worker**.

A correção pertence à camada de persistência: `SELECT … FOR UPDATE SKIP
LOCKED`, lease com TTL, ou equivalente. O teste
`AUDITORIA §13` documenta a limitação e falha se alguém acrescentar um
lock sem atualizar esta secção.

### Idempotência: não existe

`enqueue()` não tem chave de idempotência. Enfileirar o mesmo
destinatário duas vezes na mesma campanha envia duas mensagens. Uma
campanha reexecutada duplica tudo. Falta uma chave
`(campaignId, accountId, recipient)` com unicidade no armazenamento.

### Cancelamento: não existe

Não há forma de cancelar uma campanha ou um item em fila.

### Meta: endpoints não validados — adapter bloqueado

Ver §2. O adapter está desligado por omissão e não faz nenhum pedido real
enquanto `INSTAGRAM_META_ENABLED_FOR_REAL_REQUESTS` não for `1`.

### Rota HTTP: nenhuma nesta fase (decisão deliberada)

`api/outreach/providers.js` chegou a existir e **foi removido antes do
commit**. O LeadMap não tem autenticação, e a rota — apesar de não expor
tokens, chaves nem `baseUrl` — revelaria o nome do fornecedor externo,
que fornecedores estão configurados, que variáveis faltam e os limites
internos. Não havendo UI a consumi-la, não havia razão para a publicar.

Quando existir uma, tem de nascer atrás de autenticação.

---

## 16. Como adicionar um fornecedor novo

1. Criar `providers/instagram/<nome>.mjs` com uma classe que estenda
   `BaseInstagramProvider`.
2. No `super()`, declarar `id`, `displayName` e **apenas** as capacidades
   que o fornecedor realmente tem.
3. Implementar os métodos `_*` correspondentes a essas capacidades.
   Traduzir os erros do fornecedor para os códigos normalizados —
   `erroDeHttp()` e `lerRetryAfter()` de `base.mjs` já fazem a maior
   parte do trabalho.
4. Registar em `config.mjs`, lendo a configuração do ambiente.
5. Exportar em `index.mjs`.
6. Escrever testes com `fetch` injetado, cobrindo pelo menos os mesmos
   cenários de falha dos adapters existentes.

Antes de escrever qualquer código, verificar a secção 3: se o fornecedor
exigir automação de browser, sessões capturadas ou contorno de limites,
**não integrar**.

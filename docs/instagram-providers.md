# LeadMap Pro — fornecedores de Instagram

O Outreach do LeadMap não depende de um fornecedor. Entre o motor e o
Instagram há um router; por baixo dele, adapters que cumprem o mesmo
contrato.

```
LeadMap Pro
     ↓
Outreach Engine  (fila, idempotência, opt-out, auditoria)
     ↓
InstagramProviderRouter
     ↓
┌──────────────┬──────────────────────┬─────────────────────┐
│ ManyChat     │ Meta Instagram (API) │ API Externa         │
└──────────────┴──────────────────────┴─────────────────────┘
```

Cada conta Instagram escolhe o seu. Uma pode usar Meta, outra ManyChat,
outra um fornecedor terceiro.

---

## Comparação

| Provider | Tipo | Custo para o LeadMap | Destinatário | Envio | Webhook |
|---|---|---|---|---|---|
| **Meta Instagram** | API oficial | nenhum (só o token) | IGSID | responder dentro de 24 h | sim, assinado |
| **ManyChat** | Fornecedor terceiro | conta ManyChat (a API exige plano Pro) | `subscriber_id` | `sendFlow` | não implementado |
| **API Externa** | Genérico, por configurar | depende do fornecedor | definido pelo fornecedor | HTTP configurado | depende |

Nenhum destes permite mensagem direta a fria para um `@perfil`
encontrado numa pesquisa. Isso não é uma limitação do LeadMap — é como
as plataformas funcionam.

---

## Resolução do fornecedor

`InstagramProviderRouter.resolve({ item, account })`.

**Precedência: o item de fila vence a conta.** O `idempotencyKey` da
mensagem foi calculado quando o item entrou na fila, e a linha de
`message` já existe com aquele fornecedor. Reencaminhar um item em voo
seria enviar por um canal que ninguém reviu, e arriscar um segundo envio
a coberto de uma chave que já não corresponde. Mudar o fornecedor de uma
conta afeta o que for enfileirado **a seguir**.

**Sem fallback automático.** Se o fornecedor falhar, não se tenta outro:
uma falha pode ser um timeout depois de a mensagem já ter sido aceite do
outro lado, e repetir noutro canal duplicaria a mensagem para uma pessoa
real. Trocar de fornecedor é decisão de quem opera, com o erro à frente.

---

## META INSTAGRAM OFFICIAL

### Fontes oficiais consultadas (setembro de 2026)

- [Instagram Platform](https://developers.facebook.com/docs/instagram-platform)
- [Send Messages — Instagram API with Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/)
- [Conversations API](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/conversations-api)
- [Webhooks](https://developers.facebook.com/docs/instagram-platform/webhooks)
- [Private Replies](https://developers.facebook.com/docs/instagram-platform/private-replies/)
- [Access Levels](https://developers.facebook.com/docs/graph-api/overview/access-levels)

### API usada e porquê

**Instagram API with Instagram Login**, host `https://graph.instagram.com`,
versão `v25.0`.

O adapter anterior apontava para `graph.facebook.com`, que é o caminho do
**Facebook Login**: exige a conta Instagram ligada a uma Página de
Facebook e autenticação pelo Facebook. O caminho com Instagram Login
autentica diretamente na conta profissional. Para o LeadMap — que liga
contas de negócio, sem Página obrigatória — é o mais direto. Os dois
modelos não se misturam.

### Endpoints

```
POST /v25.0/{IG_ID}/messages     { recipient: { id: IGSID }, message: { text } }
GET  /v25.0/me?fields=id,user_id,username,name,account_type,followers_count
GET  /v25.0/me/conversations?platform=instagram&user_id={IGSID}
GET  /v25.0/{CONVERSATION_ID}?fields=messages
```

### Permissões

```
instagram_business_basic
instagram_business_manage_messages
instagram_business_manage_comments   ← só para private replies
```

### Requisitos da conta

Conta **Instagram Business ou Creator**. Uma conta pessoal autentica e
depois falha no envio, por isso o teste de ligação verifica
`account_type` e recusa já.

### Níveis de acesso

| | Quem pode ligar contas | App Review |
|---|---|---|
| **Standard Access** | só pessoas com papel na app (admin/developer/tester) | não |
| **Advanced Access** | qualquer utilizador | sim, + verificação de negócio |

- **As nossas próprias contas** → Standard Access chega.
- **Clientes a ligarem as contas deles** → Advanced Access, com App
  Review por permissão e verificação de negócio.

### Identificador do destinatário

**IGSID** — Instagram-scoped ID.

**De onde vem:**

1. **Webhook `messages`** — quando alguém escreve para a conta, o IGSID
   vem em `entry[].messaging[].sender.id`. É a origem principal.
2. **Conversa existente** — `GET /me/conversations?platform=instagram`.

**De onde NÃO vem:** de um `@username`. Não existe endpoint que faça essa
conversão, e o LeadMap não a inventa.

### Início de conversa

Documentação, verbatim:

> «Only after an Instagram user has sent your app user's Instagram
> professional account a message can your app send a message to the
> Instagram user.»

**Não há DM fria.** `canInitiateFirstContact: false`.

Encontrar `@empresa` numa pesquisa dá `PROFILE_FOUND_ONLY` — perfil
existe, destinatário não. São coisas diferentes e o ecrã diz qual é qual.

### Janela de mensagem

**24 horas** para responder a uma mensagem recebida. Fora disso, a
plataforma recusa. O LeadMap normaliza para
`OUTSIDE_ALLOWED_WINDOW`, não-recuperável — insistir não abre a janela.

A documentação menciona uma etiqueta de *human agent* para respostas que
precisem de mais tempo. **Não está implementada, de propósito:** é para
interação humana, não para automação prolongar a janela.

### Private replies

Fluxo distinto, **documentado mas não implementado** nesta fase.

| | |
|---|---|
| Gatilho | comentário num post ou reel |
| Endpoint | `POST /{IG_ID}/messages` com `recipient: { comment_id }` |
| Permissão | `instagram_business_manage_comments` |
| Prazo | **7 dias** após o comentário |
| Quantidade | **uma** mensagem por comentário |
| Seguimento | só se a pessoa responder, e dentro de 24 h |

Não se mistura com DM fria: é uma oportunidade legítima aberta por uma
ação da própria pessoa. Quando for implementado, terá capacidade
própria (`canPrivateReplyToComment`).

### Webhooks

Campos disponíveis: `comments`, `live_comments`, `mentions`,
`message_echoes`, `message_reactions`, `messages`, `messaging_handover`,
`messaging_optins`, `messaging_policy_enforcement`,
`messaging_postbacks`, `messaging_referral`, `messaging_seen`,
`response_feedback`, `standby`, `story_insights`.

Relevantes para o LeadMap: **`messages`** (é daqui que o IGSID chega) e
`messaging_postbacks`.

**Segurança:**

- handshake com `hub.verify_token` → responder `hub.challenge`
- cada payload traz `X-Hub-Signature-256: sha256=…`, HMAC-SHA256 do
  corpo com o App Secret

Sem a verificação de assinatura, quem descobrir o URL pode injetar
"mensagens recebidas" e abrir janelas de resposta que nunca existiram.
A assinatura calcula-se sobre o corpo **em bruto** — reserializar o JSON
muda bytes e a assinatura deixa de bater.

### Identidade do destinatário

O IGSID é *Instagram-scoped*: só significa alguma coisa dentro da conta
que o recebeu, através daquele fornecedor. Por isso a identidade é
guardada **com escopo**:

```
contact.ig_user_id             o identificador
contact.ig_user_id_provider    de que fornecedor é
contact.ig_user_id_verified_at quando foi confirmado (NULL = por confirmar)
```

`UNIQUE(ig_user_id_provider, ig_user_id)` parcial: um destinatário
pertence a um contacto, e vários contactos sem identificador continuam
válidos.

| Estado | Quer dizer |
|---|---|
| `NO_RECIPIENT_ID` | não há identificador |
| `RECIPIENT_DISCOVERED` | vimos um IGSID num webhook, não sabemos de quem é |
| `RECIPIENT_UNVERIFIED` | associado, mas não confirmado pela API |
| `RECIPIENT_VERIFIED` | a API devolveu o username e ele coincide |
| `RECIPIENT_CONFLICT` | o identificador já pertence a outro contacto |

**Como se confirma.** `GET /<IGSID>?fields=username,name` devolve o
handle oficial — mas só depois de a pessoa ter escrito para a conta, que
é o consentimento. Compara-se esse username com o do contacto. Não é
semelhança: é a plataforma a dizer quem é. Se não coincidirem
exatamente, não se confirma.

**O que nunca acontece.** Um username não vira identificador, um
identificador não vira username, e nada é associado por nomes parecidos.
Um IGSID desconhecido fica por associar e espera por uma decisão de quem
opera — nunca cria um contacto novo.

**Conflito.** Se um identificador já pertence ao contacto A e alguém o
tenta associar ao B, a operação é recusada com `RECIPIENT_ALREADY_LINKED`.
Não há mudança automática de dono.

**Janela de 24 h.** Medida a partir de `webhook_event.received_at` do
último inbound daquele identificador. Não há coluna de "última
interação" no contacto: seria uma segunda cópia da mesma verdade, e as
duas acabariam por divergir.

### Limitações

- sem DM fria;
- sem procura por username;
- `business_discovery` (ler perfis de terceiros) é do caminho Facebook
  Login e **não** está disponível aqui — `canFetchProfile: false`;
- a Conversations API devolve detalhe só das **20 mensagens mais
  recentes** de cada conversa;
- não há consulta de estado de entrega — `canFetchDeliveryStatus: false`.

### Máquina de estados da ligação

```
NOT_CONFIGURED            sem token
     ↓
CONFIGURED                token presente, mas nunca se falou com a API
     ↓  testarLigacao() lê GET /me e confirma conta profissional
CONNECTION_VALIDATED      a ligação existe e a conta serve
     ↓  INSTAGRAM_META_ENABLED_FOR_REAL_REQUESTS=1
READY_FOR_CONTROLLED_TEST envio destravado, para teste controlado
```

`ERROR` em qualquer ponto onde a API recuse ou a conta não seja
profissional.

**Ter token no ambiente não chega para nada.** O envio continua bloqueado
até haver validação real **e** opt-in explícito. São duas condições, não
uma.

---

## MANYCHAT

Ver `INSTAGRAM_PROVIDERS.md` para o detalhe. Resumo:

- host `https://api.manychat.com`, `Authorization: Bearer <pageId>:<segredo>`
- `sendFlow` dispara automações desenhadas na ManyChat
- **não existe procura por username** — só email, telefone ou campo
  personalizado
- `getInfo` devolve `ig_username`, o que permite **confirmar** um par
  sem o inventar
- a API pública exige plano Pro

---

## API EXTERNA

Genérico e por configurar. `INSTAGRAM_EXTERNAL_*`.

Protegido contra SSRF: recusa `localhost`, `::1`, `169.254.*`, gamas
privadas RFC1918 e qualquer coisa que não seja `https:`.

O LeadMap fala com a **API HTTP documentada** do fornecedor. Não
implementa — e recusa integrar fornecedores que exijam — captura de
cookies, sessões de browser, automação stealth, rotação de proxies,
fingerprint spoofing ou contorno de limites.

---

## Elegibilidade

`ELIGIBLE` significa **há prova técnica suficiente para tentar o envio**.
Não significa "tem Instagram".

| Estado | Quer dizer |
|---|---|
| `ELIGIBLE` | há destinatário e canal |
| `PROFILE_FOUND_ONLY` | achámos o perfil, não o destinatário |
| `NO_RECIPIENT_ID` | sem identificador utilizável |
| `NOT_ELIGIBLE` | o fornecedor recusa |
| `OUTSIDE_ALLOWED_WINDOW` | fora da janela da plataforma |
| `OPTED_OUT` | pediu para não ser contactado |
| `ACCOUNT_NOT_CONNECTED` | a conta não está ligada |
| `PROVIDER_NOT_CONFIGURED` | falta configuração |
| `PROVIDER_ERROR` / `RATE_LIMITED` | falha do fornecedor |

---

## Idempotência

`idempotencyKey = campaignId:contactId:accountId:v{n}`

**Nenhum fornecedor entra na chave.** É o que impede que trocar de canal
reabra a porta a um segundo envio à mesma pessoa.

## Opt-out

Global. Verificado **antes** de o fornecedor ser resolvido. Nenhum canal
o contorna.

## Segredos

Todos em variáveis de ambiente do backend. Nenhum chega ao browser,
a localStorage, a IndexedDB, ao Git ou aos logs. Configurações →
Integrações mostra **nomes** de variáveis e se estão definidas — nunca
valores, nem prefixos.

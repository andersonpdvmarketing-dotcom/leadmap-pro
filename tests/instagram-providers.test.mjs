/**
 * LeadMap Pro — testes da arquitetura multi-provider de Instagram
 * ===============================================================
 * Corre com o runner nativo do Node, sem dependências:
 *
 *   node --test tests/
 *
 * Cobre o exigido em §14: connect, disconnect, send, falha, 429,
 * timeout, token inválido, destinatário indisponível, webhook, resposta
 * e estado de entrega — mais as regras estruturais (capabilities, teto
 * de 5 contas, provider por conta, limites internos, sem fallback
 * automático, auditoria sem tokens, recusa de configuração não conforme).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MockInstagramProvider, MetaInstagramProvider, ExternalInstagramProvider,
  InstagramRegistry, OutreachQueue, OutreachAudit, ITEM_STATUS,
  ACCOUNT_STATUS, MESSAGE_STATUS, ELIGIBILITY, MAX_CONTAS,
  ProviderError, redigir, construirRegistry, vistaPublica
} from '../providers/instagram/index.mjs';
import { WEBHOOK_EVENTS } from '../providers/instagram/base.mjs';

/* ---------------------------------------------------------------- *
 * Utilitários                                                       *
 * ---------------------------------------------------------------- */

/** fetch falso: devolve as respostas guionadas, por ordem de chamada. */
function fetchFalso(respostas) {
  const chamadas = [];
  const lista = Array.isArray(respostas) ? respostas.slice() : [respostas];
  const f = async (url, opts) => {
    chamadas.push({ url, opts });
    const r = lista.length > 1 ? lista.shift() : lista[0];
    if (typeof r === 'function') return r(url, opts);
    return respostaFalsa(r);
  };
  f.chamadas = chamadas;
  return f;
}

function respostaFalsa({ status = 200, body = {}, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: k => headers[k] || headers[String(k).toLowerCase()] || null },
    json: async () => body
  };
}

/**
 * MetaInstagramProvider em MODO DE TESTE.
 * O adapter está bloqueado por omissão (endpoints por validar). Aqui o
 * bloqueio é levantado DE PROPÓSITO e sempre com um `fetch` injetado —
 * nenhum teste toca na rede real.
 */
function metaEmModoDeTeste(config = {}, fetchImpl) {
  return new MetaInstagramProvider(
    { enabledForRealRequests: true, ...config },
    { fetch: fetchImpl }
  );
}

async function registoComMock(opts = {}) {
  const registry = new InstagramRegistry();
  const provider = new MockInstagramProvider(opts);
  registry.register(provider);
  const conta = await registry.connectAccount(provider.id, { username: 'loja_teste' });
  return { registry, provider, conta };
}

/* ---------------------------------------------------------------- *
 * 1. Contrato e capacidades                                         *
 * ---------------------------------------------------------------- */

test('capacidades não declaradas ficam a false — nunca se finge suporte', () => {
  const p = new MockInstagramProvider({ capabilities: { canSendMessage: true } });
  assert.equal(p.supports('canSendMessage'), true);
  assert.equal(p.supports('canReadConversations'), false);
  assert.equal(p.supports('canFetchDeliveryStatus'), false);
  assert.throws(() => p.assertCapability('canReadConversations'), /não suporta canReadConversations/);
});

test('describe() é seguro para o frontend e não traz credenciais', () => {
  const p = new ExternalInstagramProvider({
    providerName: 'Acme', baseUrl: 'https://api.acme.example', apiKey: 'segredo-abc',
    capabilities: { canSendMessage: true }
  });
  const d = p.describe();
  assert.equal(JSON.stringify(d).includes('segredo-abc'), false);
  assert.equal(d.displayName, 'External — Acme');
  assert.equal(d.configured, true);
});

test('sem capacidade de elegibilidade o estado é UNKNOWN, nunca ELIGIBLE', async () => {
  const p = new MockInstagramProvider({ capabilities: { canSendMessage: true } });
  const r = await p.checkEligibility({ providerAccountId: 'x' }, { username: 'alguem' });
  assert.equal(r.status, ELIGIBILITY.UNKNOWN);
});

test('sem canFetchDeliveryStatus o estado de entrega é UNKNOWN', async () => {
  const p = new MockInstagramProvider({ capabilities: { canSendMessage: true } });
  const r = await p.getDeliveryStatus({ providerAccountId: 'x' }, 'id-1');
  assert.equal(r.status, MESSAGE_STATUS.UNKNOWN);
});

/* ---------------------------------------------------------------- *
 * 2. Ligar e desligar contas                                        *
 * ---------------------------------------------------------------- */

test('connect devolve a conta com os sete campos do contrato', async () => {
  const { conta } = await registoComMock();
  for (const campo of ['provider', 'providerAccountId', 'username', 'displayName', 'status', 'connectedAt', 'lastSyncAt']) {
    assert.ok(campo in conta, 'falta o campo ' + campo);
  }
  assert.equal(conta.status, ACCOUNT_STATUS.CONNECTED);
  assert.equal(conta.provider, 'mock');
});

test('connect recusa password do Instagram', async () => {
  const p = new MockInstagramProvider();
  await assert.rejects(
    () => p.connect({ username: 'x', password: 'nao-deve-existir' }),
    /não aceita a password do Instagram/
  );
});

test('disconnect deixa a conta em DISCONNECTED', async () => {
  const { registry, conta } = await registoComMock();
  const desligada = await registry.disconnectAccount(conta.accountId);
  assert.equal(desligada.status, ACCOUNT_STATUS.DISCONNECTED);
});

test('teto de 5 contas ligadas em simultâneo', async () => {
  const registry = new InstagramRegistry();
  registry.register(new MockInstagramProvider());
  for (let i = 0; i < MAX_CONTAS; i++) {
    await registry.connectAccount('mock', { username: 'conta' + i });
  }
  assert.equal(registry.contasAtivas().length, MAX_CONTAS);
  await assert.rejects(
    () => registry.connectAccount('mock', { username: 'conta_extra' }),
    /Limite de 5 contas/
  );
});

test('desligar uma conta liberta espaço para outra', async () => {
  const registry = new InstagramRegistry();
  registry.register(new MockInstagramProvider());
  const contas = [];
  for (let i = 0; i < MAX_CONTAS; i++) {
    contas.push(await registry.connectAccount('mock', { username: 'conta' + i }));
  }
  await registry.disconnectAccount(contas[0].accountId);
  const nova = await registry.connectAccount('mock', { username: 'conta_nova' });
  assert.equal(nova.status, ACCOUNT_STATUS.CONNECTED);
});

/* ---------------------------------------------------------------- *
 * 3. Provider por conta (§6)                                        *
 * ---------------------------------------------------------------- */

test('cada conta pode usar um fornecedor diferente', async () => {
  const registry = new InstagramRegistry();
  registry.register(new MockInstagramProvider({ id: 'meta-sim', displayName: 'Meta' }));
  registry.register(new MockInstagramProvider({ id: 'external:acme', displayName: 'External — Acme' }));

  const a = await registry.connectAccount('meta-sim', { username: 'conta_a' });
  const b = await registry.connectAccount('external:acme', { username: 'conta_b' });
  const c = await registry.connectAccount('external:acme', { username: 'conta_c' });

  assert.equal(registry.providerForAccount(a.accountId).id, 'meta-sim');
  assert.equal(registry.providerForAccount(b.accountId).id, 'external:acme');
  assert.equal(registry.providerForAccount(c.accountId).id, 'external:acme');

  const vista = registry.accountsView();
  assert.deepEqual(vista.map(v => v.providerLabel).sort(),
    ['External — Acme', 'External — Acme', 'Meta']);
});

/* ---------------------------------------------------------------- *
 * 4. Envio e resposta normalizada (§8)                              *
 * ---------------------------------------------------------------- */

test('envio com sucesso devolve a forma normalizada', async () => {
  const { provider, conta } = await registoComMock();
  const r = await provider.sendMessage({
    account: conta, recipient: { username: 'lead1' }, message: 'Olá', campaignId: 'camp-1'
  });
  assert.deepEqual(Object.keys(r).sort(),
    ['errorCode', 'errorMessage', 'providerMessageId', 'retryAfterSec', 'retryable', 'status', 'success']);
  assert.equal(r.success, true);
  assert.equal(r.status, MESSAGE_STATUS.SENT);
  assert.ok(r.providerMessageId);
  assert.equal(r.errorCode, null);
});

test('sendMessage nunca lança: a falha vem como resposta normalizada', async () => {
  const { provider, conta } = await registoComMock({ script: { falharCom: 'MESSAGE_REJECTED' } });
  const r = await provider.sendMessage({ account: conta, recipient: { username: 'lead1' }, message: 'Olá' });
  assert.equal(r.success, false);
  assert.equal(r.errorCode, 'MESSAGE_REJECTED');
  assert.equal(r.providerMessageId, null);
  assert.equal(r.retryable, false);
});

test('mensagem vazia é recusada antes de chegar ao fornecedor', async () => {
  const { provider, conta } = await registoComMock();
  const r = await provider.sendMessage({ account: conta, recipient: { username: 'l' }, message: '   ' });
  assert.equal(r.success, false);
  assert.equal(r.errorCode, 'INVALID_REQUEST');
  assert.equal(provider.enviadas.length, 0);
});

/* ---------------------------------------------------------------- *
 * 5. Erros exigidos: 429, timeout, token inválido, destinatário      *
 * ---------------------------------------------------------------- */

test('429 do fornecedor: retryable com retryAfter respeitado', async () => {
  const { provider, conta } = await registoComMock({
    script: { falharCom: 'RATE_LIMITED', retryAfterSec: 120 }
  });
  const r = await provider.sendMessage({ account: conta, recipient: { username: 'l' }, message: 'Olá' });
  assert.equal(r.success, false);
  assert.equal(r.errorCode, 'RATE_LIMITED');
  assert.equal(r.retryable, true);
  assert.equal(r.retryAfterSec, 120);
});

test('timeout é retryable', async () => {
  const { provider, conta } = await registoComMock({ script: { falharCom: 'TIMEOUT' } });
  const r = await provider.sendMessage({ account: conta, recipient: { username: 'l' }, message: 'Olá' });
  assert.equal(r.errorCode, 'TIMEOUT');
  assert.equal(r.retryable, true);
});

test('token inválido NÃO é retryable', async () => {
  const { provider, conta } = await registoComMock({ script: { falharCom: 'INVALID_TOKEN' } });
  const r = await provider.sendMessage({ account: conta, recipient: { username: 'l' }, message: 'Olá' });
  assert.equal(r.errorCode, 'INVALID_TOKEN');
  assert.equal(r.retryable, false);
});

test('destinatário indisponível NÃO é retryable', async () => {
  const { provider, conta } = await registoComMock({ script: { falharCom: 'RECIPIENT_UNAVAILABLE' } });
  const r = await provider.sendMessage({ account: conta, recipient: { username: 'l' }, message: 'Olá' });
  assert.equal(r.errorCode, 'RECIPIENT_UNAVAILABLE');
  assert.equal(r.retryable, false);
});

/* ---------------------------------------------------------------- *
 * 6. Webhooks, respostas e estado de entrega                        *
 * ---------------------------------------------------------------- */

test('webhook traduz entrega, leitura, falha e resposta', () => {
  const p = new MockInstagramProvider();
  const eventos = p.parseWebhook({
    events: [
      { kind: 'delivered', messageId: 'm1' },
      { kind: 'read', messageId: 'm2' },
      { kind: 'failed', messageId: 'm3', errorCode: 'MESSAGE_REJECTED' },
      { kind: 'reply', from: 'lead1', text: 'Bom dia', accountId: 'a1' },
      { kind: 'desconhecido' }
    ]
  });
  assert.equal(eventos.length, 4);
  assert.equal(eventos[0].type, WEBHOOK_EVENTS.MESSAGE_DELIVERED);
  assert.equal(eventos[1].type, WEBHOOK_EVENTS.MESSAGE_READ);
  assert.equal(eventos[2].type, WEBHOOK_EVENTS.MESSAGE_FAILED);
  assert.equal(eventos[3].type, WEBHOOK_EVENTS.REPLY_RECEIVED);
  assert.equal(eventos[3].text, 'Bom dia');
});

test('webhook é ignorado se o fornecedor não declarar canReceiveWebhooks', () => {
  const p = new MockInstagramProvider({ capabilities: { canSendMessage: true } });
  assert.deepEqual(p.parseWebhook({ events: [{ kind: 'delivered', messageId: 'm1' }] }), []);
});

test('estado de entrega evolui de SENT para DELIVERED via webhook', async () => {
  const { provider, conta } = await registoComMock();
  const r = await provider.sendMessage({ account: conta, recipient: { username: 'l' }, message: 'Olá' });
  let estado = await provider.getDeliveryStatus(conta, r.providerMessageId);
  assert.equal(estado.status, MESSAGE_STATUS.SENT);

  provider.parseWebhook({ events: [{ kind: 'delivered', messageId: r.providerMessageId }] });
  estado = await provider.getDeliveryStatus(conta, r.providerMessageId);
  assert.equal(estado.status, MESSAGE_STATUS.DELIVERED);
});

/* ---------------------------------------------------------------- *
 * 7. Fila: limites internos e do fornecedor (§9)                    *
 * ---------------------------------------------------------------- */

test('fila respeita o limite interno por hora', async () => {
  const { registry, conta } = await registoComMock();
  const queue = new OutreachQueue({
    registry, limites: { OUTREACH_MAX_PER_HOUR: 2, OUTREACH_MAX_PER_DAY: 100 }
  });
  for (let i = 0; i < 4; i++) {
    queue.enqueue({ campaignId: 'c1', accountId: conta.accountId, recipient: { username: 'l' + i }, message: 'Olá' });
  }
  const resumo = await queue.processar();
  assert.equal(resumo.enviados, 2);
  assert.equal(queue.pendentes().length, 2);
  assert.equal(queue.podeEnviar(conta.accountId).motivo, 'INTERNAL_HOURLY_LIMIT');
});

test('fila respeita o limite interno diário', async () => {
  const { registry, conta } = await registoComMock();
  const queue = new OutreachQueue({
    registry, limites: { OUTREACH_MAX_PER_HOUR: 50, OUTREACH_MAX_PER_DAY: 3 }
  });
  for (let i = 0; i < 5; i++) {
    queue.enqueue({ campaignId: 'c1', accountId: conta.accountId, recipient: { username: 'l' + i }, message: 'Olá' });
  }
  const resumo = await queue.processar();
  assert.equal(resumo.enviados, 3);
  assert.equal(queue.podeEnviar(conta.accountId).motivo, 'INTERNAL_DAILY_LIMIT');
});

test('429 do fornecedor pausa a conta e marca RATE_LIMITED — sem contornar', async () => {
  let agora = 1_000_000;
  const { registry, provider, conta } = await registoComMock({
    script: { falharCom: 'RATE_LIMITED', retryAfterSec: 300 }
  });
  const queue = new OutreachQueue({ registry, now: () => agora });
  const item = queue.enqueue({ campaignId: 'c1', accountId: conta.accountId, recipient: { username: 'l' }, message: 'Olá' });

  await queue.processarItem(item);
  assert.equal(item.status, ITEM_STATUS.DEFERRED);
  assert.equal(item.naoAntesDe, agora + 300_000, 'o adiamento usa o retryAfter do fornecedor');
  assert.equal(registry.getAccount(conta.accountId).status, ACCOUNT_STATUS.RATE_LIMITED);

  /* enquanto a pausa dura, a fila não tenta de novo */
  const permissao = queue.podeEnviar(conta.accountId);
  assert.equal(permissao.ok, false);
  assert.equal(permissao.motivo, 'PROVIDER_RATE_LIMIT');

  /* passado o tempo pedido, e com o fornecedor a aceitar, o envio segue */
  agora += 301_000;
  provider.script.falharCom = null;
  await queue.processarItem(item);
  assert.equal(item.status, ITEM_STATUS.SENT);
});

test('erro não recuperável falha à primeira, sem retry', async () => {
  const { registry, conta } = await registoComMock({ script: { falharCom: 'INVALID_TOKEN' } });
  const queue = new OutreachQueue({ registry });
  const item = queue.enqueue({ campaignId: 'c1', accountId: conta.accountId, recipient: { username: 'l' }, message: 'Olá' });
  await queue.processarItem(item);
  assert.equal(item.status, ITEM_STATUS.FAILED);
  assert.equal(item.tentativas, 1);
  assert.equal(registry.getAccount(conta.accountId).status, ACCOUNT_STATUS.TOKEN_EXPIRED);
});

test('erro recuperável esgota as tentativas e termina em FAILED', async () => {
  let agora = 1_000_000;
  const { registry, conta } = await registoComMock({ script: { falharCom: 'TIMEOUT' } });
  const queue = new OutreachQueue({ registry, now: () => agora, maxTentativas: 3 });
  const item = queue.enqueue({ campaignId: 'c1', accountId: conta.accountId, recipient: { username: 'l' }, message: 'Olá' });
  for (let i = 0; i < 3; i++) {
    agora += 10 * 60 * 1000;
    await queue.processarItem(item);
  }
  assert.equal(item.tentativas, 3);
  assert.equal(item.status, ITEM_STATUS.FAILED);
});

test('destinatário inelegível é ignorado sem gastar envio', async () => {
  const { registry, provider, conta } = await registoComMock({ script: { inelegiveis: ['bloqueado'] } });
  const queue = new OutreachQueue({ registry });
  const item = queue.enqueue({ campaignId: 'c1', accountId: conta.accountId, recipient: { username: 'bloqueado' }, message: 'Olá' });
  await queue.processarItem(item);
  assert.equal(item.status, ITEM_STATUS.SKIPPED);
  assert.equal(item.resultado.errorCode, 'RECIPIENT_INELIGIBLE');
  assert.equal(provider.enviadas.length, 0);
});

test('sem endpoint de elegibilidade o item segue com estado UNKNOWN', async () => {
  const { registry, conta } = await registoComMock({
    capabilities: { canSendMessage: true }
  });
  const queue = new OutreachQueue({ registry });
  const item = queue.enqueue({ campaignId: 'c1', accountId: conta.accountId, recipient: { username: 'l' }, message: 'Olá' });
  await queue.processarItem(item);
  assert.equal(item.eligibility, ELIGIBILITY.UNKNOWN);
  assert.equal(item.status, ITEM_STATUS.SENT);
});

/* ---------------------------------------------------------------- *
 * 8. Sem troca automática de fornecedor (§15/§16)                   *
 * ---------------------------------------------------------------- */

test('o item guarda o fornecedor usado e a fila não o troca sozinha', async () => {
  const registry = new InstagramRegistry();
  registry.register(new MockInstagramProvider({ id: 'meta-sim' }));
  registry.register(new MockInstagramProvider({ id: 'external:acme' }));
  const conta = await registry.connectAccount('meta-sim', { username: 'conta_a' });

  const queue = new OutreachQueue({ registry });
  const item = queue.enqueue({ campaignId: 'c1', accountId: conta.accountId, recipient: { username: 'l' }, message: 'Olá' });
  assert.equal(item.provider, 'meta-sim');

  /* a conta passa a apontar para outro fornecedor a meio do caminho */
  registry.contas.set(conta.accountId, { ...registry.getAccount(conta.accountId), provider: 'external:acme' });
  await queue.processarItem(item);

  assert.equal(item.status, ITEM_STATUS.SKIPPED);
  assert.match(item.resultado.errorMessage, /não duplicar/);
});

test('reencaminhar para outro fornecedor exige confirmação explícita', async () => {
  const registry = new InstagramRegistry();
  registry.register(new MockInstagramProvider({ id: 'meta-sim', script: { falharCom: 'MESSAGE_REJECTED' } }));
  registry.register(new MockInstagramProvider({ id: 'external:acme' }));
  const contaA = await registry.connectAccount('meta-sim', { username: 'conta_a' });
  const contaB = await registry.connectAccount('external:acme', { username: 'conta_b' });

  const queue = new OutreachQueue({ registry });
  const item = queue.enqueue({ campaignId: 'c1', accountId: contaA.accountId, recipient: { username: 'l' }, message: 'Olá' });
  await queue.processarItem(item);
  assert.equal(item.status, ITEM_STATUS.FAILED);

  /* sem confirmação, recusa */
  assert.throws(
    () => queue.reencaminharManualmente(item.id, contaB.accountId),
    /confirmação explícita/
  );

  /* com confirmação, cria um item novo que regista a origem */
  const novo = queue.reencaminharManualmente(item.id, contaB.accountId, { confirmadoPeloUtilizador: true });
  assert.equal(novo.provider, 'external:acme');
  assert.equal(novo.reencaminhadoDe, item.id);
  assert.equal(item.reencaminhadoPara, novo.id);
});

test('não se reencaminha um item já enviado (evita duplicar)', async () => {
  const registry = new InstagramRegistry();
  registry.register(new MockInstagramProvider({ id: 'meta-sim' }));
  registry.register(new MockInstagramProvider({ id: 'external:acme' }));
  const a = await registry.connectAccount('meta-sim', { username: 'a' });
  const b = await registry.connectAccount('external:acme', { username: 'b' });
  const queue = new OutreachQueue({ registry });
  const item = queue.enqueue({ campaignId: 'c1', accountId: a.accountId, recipient: { username: 'l' }, message: 'Olá' });
  await queue.processarItem(item);
  assert.equal(item.status, ITEM_STATUS.SENT);
  assert.throws(
    () => queue.reencaminharManualmente(item.id, b.accountId, { confirmadoPeloUtilizador: true }),
    /já foi enviado/
  );
});

/* ---------------------------------------------------------------- *
 * 9. Auditoria (§17)                                                *
 * ---------------------------------------------------------------- */

test('auditoria guarda provider, conta, campanha, destinatário e resultado', async () => {
  const { registry, conta } = await registoComMock();
  const audit = new OutreachAudit();
  const queue = new OutreachQueue({ registry, audit });
  const item = queue.enqueue({ campaignId: 'camp-9', accountId: conta.accountId, recipient: { username: 'lead9' }, message: 'Olá' });
  await queue.processarItem(item);

  const linhas = audit.listar({ campaignId: 'camp-9' });
  assert.equal(linhas.length, 1);
  const l = linhas[0];
  assert.equal(l.provider, 'mock');
  assert.equal(l.accountId, conta.accountId);
  assert.equal(l.recipient, 'lead9');
  assert.equal(l.status, MESSAGE_STATUS.SENT);
  assert.ok(l.providerMessageId);
  assert.ok(l.timestamp);
});

test('auditoria nunca guarda tokens nem chaves', () => {
  const audit = new OutreachAudit();
  const linha = audit.registar({
    provider: 'external:acme', accountId: 'x', apiKey: 'chave-secreta',
    accessToken: 'token-secreto', errorMessage: 'falhou'
  });
  const serializado = JSON.stringify(linha);
  assert.equal(serializado.includes('chave-secreta'), false);
  assert.equal(serializado.includes('token-secreto'), false);
  /* campos fora da lista fechada nem sequer entram */
  assert.equal('apiKey' in linha, false);
});

test('redigir() mascara credenciais aninhadas', () => {
  const saida = redigir({ nome: 'ok', cfg: { apiKey: 'abc', nested: { authorization: 'Bearer xyz' } } });
  assert.equal(saida.nome, 'ok');
  assert.equal(saida.cfg.apiKey, '[redigido]');
  assert.equal(saida.cfg.nested.authorization, '[redigido]');
});

/* ---------------------------------------------------------------- *
 * 10. Recusa de fornecedores não conformes (§3)                     *
 * ---------------------------------------------------------------- */

for (const chave of ['cookies', 'sessionId', 'proxyUrl', 'userAgent', 'deviceId', 'puppeteer', 'password', 'checkpointBypass']) {
  test('configuração com "' + chave + '" é recusada', () => {
    assert.throws(
      () => new ExternalInstagramProvider({
        providerName: 'X', baseUrl: 'https://api.x.example', apiKey: 'k', [chave]: 'valor'
      }),
      /Configuração recusada/
    );
  });
}

test('configuração não conforme aninhada também é recusada', () => {
  assert.throws(
    () => new ExternalInstagramProvider({
      providerName: 'X', baseUrl: 'https://api.x.example', apiKey: 'k',
      opcoes: { rede: { proxy: 'http://1.2.3.4:8080' } }
    }),
    /Configuração recusada/
  );
});

test('baseUrl tem de ser HTTPS', () => {
  assert.throws(
    () => new ExternalInstagramProvider({ providerName: 'X', baseUrl: 'http://api.x.example', apiKey: 'k' }),
    /tem de ser HTTPS/
  );
});

/* ---------------------------------------------------------------- *
 * 11. ExternalInstagramProvider contra HTTP falso                   *
 * ---------------------------------------------------------------- */

function externo(fetchImpl, extra = {}) {
  return new ExternalInstagramProvider({
    providerName: 'Acme', baseUrl: 'https://api.acme.example', apiKey: 'chave',
    capabilities: {
      canSendMessage: true, canCheckEligibility: true, canFetchProfile: true,
      canFetchDeliveryStatus: true, canReceiveWebhooks: true, canReadConversations: true
    },
    ...extra
  }, { fetch: fetchImpl });
}

test('external: connect normaliza a resposta do fornecedor', async () => {
  const p = externo(fetchFalso({ body: { account: { id: '55', username: 'loja', name: 'Loja Lda' } } }));
  const { account } = await p.connect({ authorizationCode: 'code-do-fornecedor' });
  assert.equal(account.providerAccountId, '55');
  assert.equal(account.username, 'loja');
  assert.equal(account.displayName, 'Loja Lda');
  assert.equal(account.provider, 'external:acme');
});

test('external: a API key vai no cabeçalho e nunca no URL', async () => {
  const f = fetchFalso({ body: { messageId: 'm-1' } });
  const p = externo(f);
  await p.sendMessage({
    account: { providerAccountId: '55' }, recipient: { username: 'lead' }, message: 'Olá'
  });
  const chamada = f.chamadas[0];
  assert.equal(chamada.url.includes('chave'), false);
  assert.equal(chamada.opts.headers.Authorization, 'Bearer chave');
});

test('external: envio bem-sucedido devolve o providerMessageId', async () => {
  const p = externo(fetchFalso({ body: { messageId: 'm-42', status: 'SENT' } }));
  const r = await p.sendMessage({
    account: { providerAccountId: '55' }, recipient: { username: 'lead' }, message: 'Olá'
  });
  assert.equal(r.success, true);
  assert.equal(r.providerMessageId, 'm-42');
});

test('external: HTTP 429 vira RATE_LIMITED com Retry-After', async () => {
  const p = externo(fetchFalso({ status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '90' } }));
  const r = await p.sendMessage({
    account: { providerAccountId: '55' }, recipient: { username: 'lead' }, message: 'Olá'
  });
  assert.equal(r.errorCode, 'RATE_LIMITED');
  assert.equal(r.retryable, true);
  assert.equal(r.retryAfterSec, 90);
});

test('external: HTTP 401 vira INVALID_TOKEN não recuperável', async () => {
  const p = externo(fetchFalso({ status: 401, body: { message: 'bad key' } }));
  const r = await p.sendMessage({
    account: { providerAccountId: '55' }, recipient: { username: 'lead' }, message: 'Olá'
  });
  assert.equal(r.errorCode, 'INVALID_TOKEN');
  assert.equal(r.retryable, false);
});

test('external: HTTP 404 vira RECIPIENT_UNAVAILABLE', async () => {
  const p = externo(fetchFalso({ status: 404, body: { message: 'no such user' } }));
  const r = await p.sendMessage({
    account: { providerAccountId: '55' }, recipient: { username: 'inexistente' }, message: 'Olá'
  });
  assert.equal(r.errorCode, 'RECIPIENT_UNAVAILABLE');
});

test('external: 200 com success:false também é traduzido', async () => {
  const p = externo(fetchFalso({ body: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'wait', retryAfter: 30 } } }));
  const r = await p.sendMessage({
    account: { providerAccountId: '55' }, recipient: { username: 'lead' }, message: 'Olá'
  });
  assert.equal(r.errorCode, 'RATE_LIMITED');
  assert.equal(r.retryAfterSec, 30);
});

test('external: timeout de rede vira TIMEOUT recuperável', async () => {
  const abortar = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  const p = externo(abortar);
  const r = await p.sendMessage({
    account: { providerAccountId: '55' }, recipient: { username: 'lead' }, message: 'Olá'
  });
  assert.equal(r.errorCode, 'TIMEOUT');
  assert.equal(r.retryable, true);
});

test('external: sem configuração o envio devolve NOT_CONFIGURED', async () => {
  const p = new ExternalInstagramProvider({ providerName: 'Acme', capabilities: { canSendMessage: true } });
  const r = await p.sendMessage({
    account: { providerAccountId: '55' }, recipient: { username: 'lead' }, message: 'Olá'
  });
  assert.equal(r.errorCode, 'NOT_CONFIGURED');
  assert.equal(p.isConfigured(), false);
});

test('external: elegibilidade desconhecida não vira elegível', async () => {
  const p = externo(fetchFalso({ body: { status: 'MAYBE' } }));
  const r = await p.checkEligibility({ providerAccountId: '55' }, { username: 'lead' });
  assert.equal(r.status, ELIGIBILITY.UNKNOWN);
});

test('external: estado de entrega normalizado', async () => {
  const p = externo(fetchFalso({ body: { status: 'delivered', updatedAt: '2026-09-01T10:00:00Z' } }));
  const r = await p.getDeliveryStatus({ providerAccountId: '55' }, 'm-42');
  assert.equal(r.status, MESSAGE_STATUS.DELIVERED);
});

test('external: webhook de resposta é normalizado', () => {
  const p = externo(fetchFalso({ body: {} }));
  const eventos = p.parseWebhook({
    events: [
      { type: 'message.delivered', messageId: 'm1' },
      { type: 'message.received', from: 'lead1', text: 'Interessado', accountId: '55' }
    ]
  });
  assert.equal(eventos.length, 2);
  assert.equal(eventos[0].type, WEBHOOK_EVENTS.MESSAGE_DELIVERED);
  assert.equal(eventos[1].type, WEBHOOK_EVENTS.REPLY_RECEIVED);
  assert.equal(eventos[1].text, 'Interessado');
});

/* ---------------------------------------------------------------- *
 * 12. MetaInstagramProvider contra HTTP falso                       *
 * ---------------------------------------------------------------- */

test('meta: sem token, e ainda bloqueado, não está configurado', async () => {
  const p = new MetaInstagramProvider({});
  assert.equal(p.isConfigured(), false);
  assert.equal(p.isBlockedPendingValidation(), true);
});

test('meta: desbloqueado mas sem token falha com NOT_CONFIGURED', async () => {
  const p = metaEmModoDeTeste({}, fetchFalso({ body: {} }));
  const r = await p.sendMessage({
    account: { providerAccountId: '1' }, recipient: { providerUserId: '2' }, message: 'Olá'
  });
  assert.equal(r.errorCode, 'NOT_CONFIGURED');
});

test('meta: envio usa o IGSID e devolve o message_id', async () => {
  const f = fetchFalso({ body: { message_id: 'mid.123' } });
  const p = metaEmModoDeTeste({ accessToken: 'token-meta' }, f);
  const r = await p.sendMessage({
    account: { providerAccountId: '17841400000' }, recipient: { providerUserId: 'igsid-9' }, message: 'Olá'
  });
  assert.equal(r.success, true);
  assert.equal(r.providerMessageId, 'mid.123');
  assert.equal(f.chamadas[0].opts.headers.Authorization, 'Bearer token-meta');
  assert.equal(f.chamadas[0].url.includes('token-meta'), false);
});

test('meta: sem IGSID o envio é recusado, não se inventa destinatário', async () => {
  const p = metaEmModoDeTeste({ accessToken: 'token-meta' }, fetchFalso({ body: {} }));
  const r = await p.sendMessage({
    account: { providerAccountId: '1784' }, recipient: { username: 'so_username' }, message: 'Olá'
  });
  assert.equal(r.success, false);
  assert.equal(r.errorCode, 'INVALID_REQUEST');
  assert.match(r.errorMessage, /IGSID/);
});

test('meta: código 190 vira INVALID_TOKEN', async () => {
  const p = metaEmModoDeTeste({ accessToken: 't' },
    fetchFalso({ status: 400, body: { error: { code: 190, message: 'expired', type: 'OAuthException' } } }));
  const r = await p.sendMessage({
    account: { providerAccountId: '1' }, recipient: { providerUserId: '2' }, message: 'Olá'
  });
  assert.equal(r.errorCode, 'INVALID_TOKEN');
});

test('meta: código 613 vira RATE_LIMITED recuperável', async () => {
  const p = metaEmModoDeTeste({ accessToken: 't' },
    fetchFalso({ status: 400, body: { error: { code: 613, message: 'rate limit' } } }));
  const r = await p.sendMessage({
    account: { providerAccountId: '1' }, recipient: { providerUserId: '2' }, message: 'Olá'
  });
  assert.equal(r.errorCode, 'RATE_LIMITED');
  assert.equal(r.retryable, true);
});

test('meta: webhook traduz resposta recebida e entrega', () => {
  /* parseWebhook é puro: funciona mesmo com o adapter bloqueado. */
  const p = new MetaInstagramProvider({ accessToken: 't' });
  const eventos = p.parseWebhook({
    object: 'instagram',
    entry: [{
      id: '1784',
      messaging: [
        { sender: { id: 'igsid-9' }, message: { text: 'Olá de volta' }, timestamp: 1756684800000 },
        { delivery: { mids: ['mid.1', 'mid.2'] } }
      ]
    }]
  });
  assert.equal(eventos.length, 3);
  assert.equal(eventos[0].type, WEBHOOK_EVENTS.REPLY_RECEIVED);
  assert.equal(eventos[0].text, 'Olá de volta');
  assert.equal(eventos[1].providerMessageId, 'mid.1');
});

test('meta declara canCheckEligibility=false — não adivinha elegibilidade', async () => {
  const p = new MetaInstagramProvider({ accessToken: 't' });   /* bloqueado: não toca na rede */
  const r = await p.checkEligibility({ providerAccountId: '1' }, { username: 'x' });
  assert.equal(r.status, ELIGIBILITY.UNKNOWN);
});

/* ---------------------------------------------------------------- *
 * 13. Configuração a partir do ambiente (§12)                       *
 * ---------------------------------------------------------------- */

test('construirRegistry regista a Meta mesmo sem token, marcada como não configurada', () => {
  const registry = construirRegistry({});
  const vista = vistaPublica(registry, {});
  const meta = vista.providers.find(p => p.id === 'meta');
  assert.ok(meta);
  assert.equal(meta.configured, false);
  /* duas razões: falta o token E o adapter continua bloqueado por validar */
  assert.ok(meta.missingEnv.includes('INSTAGRAM_META_ACCESS_TOKEN'));
  assert.ok(meta.missingEnv.some(v => v.startsWith('INSTAGRAM_META_ENABLED_FOR_REAL_REQUESTS')));
});

test('construirRegistry cria o fornecedor externo com as capacidades declaradas', () => {
  const registry = construirRegistry({
    INSTAGRAM_EXTERNAL_PROVIDER: 'Acme',
    INSTAGRAM_EXTERNAL_BASE_URL: 'https://api.acme.example',
    INSTAGRAM_EXTERNAL_API_KEY: 'chave',
    INSTAGRAM_EXTERNAL_CAPABILITIES: 'canSendMessage,canFetchProfile,inventada'
  });
  const p = registry.getProvider('external:acme');
  assert.equal(p.supports('canSendMessage'), true);
  assert.equal(p.supports('canFetchProfile'), true);
  assert.equal(p.supports('canReceiveWebhooks'), false, 'capacidade não declarada fica false');
  assert.equal(p.capabilities.inventada, undefined, 'capacidade desconhecida é descartada');
});

test('vistaPublica nunca expõe baseUrl nem credenciais', () => {
  const env = {
    INSTAGRAM_META_ACCESS_TOKEN: 'token-meta-secreto',
    INSTAGRAM_EXTERNAL_PROVIDER: 'Acme',
    INSTAGRAM_EXTERNAL_BASE_URL: 'https://privado.acme.example',
    INSTAGRAM_EXTERNAL_API_KEY: 'chave-secreta'
  };
  const serializado = JSON.stringify(vistaPublica(construirRegistry(env), env));
  assert.equal(serializado.includes('token-meta-secreto'), false);
  assert.equal(serializado.includes('chave-secreta'), false);
  assert.equal(serializado.includes('privado.acme.example'), false);
});

test('limites internos vêm do ambiente com valores por omissão seguros', () => {
  const registry = construirRegistry({});
  assert.deepEqual(vistaPublica(registry, { OUTREACH_MAX_PER_HOUR: '5', OUTREACH_MAX_PER_DAY: '40' }).limites,
    { OUTREACH_MAX_PER_HOUR: 5, OUTREACH_MAX_PER_DAY: 40 });
  assert.deepEqual(vistaPublica(registry, {}).limites,
    { OUTREACH_MAX_PER_HOUR: 20, OUTREACH_MAX_PER_DAY: 100 });
});

/* ---------------------------------------------------------------- *
 * 14. Fluxo completo ponta a ponta                                  *
 * ---------------------------------------------------------------- */

test('campanha com duas contas e dois fornecedores mantém cada envio no seu', async () => {
  const registry = new InstagramRegistry();
  const meta = new MockInstagramProvider({ id: 'meta-sim', displayName: 'Meta' });
  const ext = new MockInstagramProvider({ id: 'external:acme', displayName: 'External — Acme' });
  registry.register(meta);
  registry.register(ext);

  const contaA = await registry.connectAccount('meta-sim', { username: 'conta_a' });
  const contaB = await registry.connectAccount('external:acme', { username: 'conta_b' });

  const audit = new OutreachAudit();
  const queue = new OutreachQueue({ registry, audit });
  queue.enqueue({ campaignId: 'camp-x', accountId: contaA.accountId, recipient: { username: 'lead1' }, message: 'Olá 1' });
  queue.enqueue({ campaignId: 'camp-x', accountId: contaB.accountId, recipient: { username: 'lead2' }, message: 'Olá 2' });

  const resumo = await queue.processar();
  assert.equal(resumo.enviados, 2);
  assert.equal(meta.enviadas.length, 1);
  assert.equal(ext.enviadas.length, 1);
  assert.equal(meta.enviadas[0].recipient, 'lead1');
  assert.equal(ext.enviadas[0].recipient, 'lead2');

  const linhas = audit.listar({ campaignId: 'camp-x' });
  assert.deepEqual(linhas.map(l => l.provider).sort(), ['external:acme', 'meta-sim']);
  const resumoAudit = audit.resumoPorCampanha('camp-x');
  assert.equal(resumoAudit.total, 2);
  assert.equal(resumoAudit.porEstado.SENT, 2);
});

/* ================================================================ *
 * 15. Testes de segurança acrescentados na auditoria pré-commit     *
 * ================================================================ */

test('AUDITORIA §6: chaves proibidas são bloqueadas em array e array 2D', () => {
  const chaves = ['password', 'cookie', 'cookies', 'session', 'sessionId', 'proxy', 'proxies',
    'userAgent', 'deviceId', 'fingerprint', 'puppeteer', 'playwright', 'selenium', 'checkpointBypass'];
  for (const k of chaves) {
    for (const cfg of [{ [k]: 'v' }, { o: { r: { [k]: 'v' } } }, { lista: [{ [k]: 'v' }] }, { a: [[{ [k]: 'v' }]] }]) {
      assert.throws(
        () => new ExternalInstagramProvider({ providerName: 'X', baseUrl: 'https://a.example', apiKey: 'k', ...cfg }),
        /Configuração recusada/,
        'não bloqueou "' + k + '" em ' + JSON.stringify(cfg)
      );
    }
  }
});

test('AUDITORIA §6: configuração legítima continua a passar', () => {
  const p = new ExternalInstagramProvider({
    providerName: 'X', baseUrl: 'https://a.example', apiKey: 'k',
    paths: { send: '/m' }, capabilities: { canSendMessage: true }
  });
  assert.equal(p.isConfigured(), true);
});

test('AUDITORIA §10: baseUrl interno é recusado (SSRF)', () => {
  const internos = [
    'https://localhost/api', 'https://127.0.0.1/api', 'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/api', 'https://172.16.4.4/api', 'https://192.168.1.10/api',
    'https://[::1]/api', 'https://[fe80::1]/api', 'https://[fd00::1]/api',
    'https://[::ffff:127.0.0.1]/api', 'https://metadata.google.internal/x',
    'https://algo.local/api', 'https://0.0.0.0/api', 'https://100.64.1.1/api'
  ];
  for (const u of internos) {
    assert.throws(
      () => new ExternalInstagramProvider({ providerName: 'X', baseUrl: u, apiKey: 'k' }),
      /endereço interno|HTTPS/,
      'aceitou o alvo interno ' + u
    );
  }
});

test('AUDITORIA §10: baseUrl com credenciais embutidas é recusado', () => {
  assert.throws(
    () => new ExternalInstagramProvider({ providerName: 'X', baseUrl: 'https://u:p@a.example', apiKey: 'k' }),
    /credenciais no URL/
  );
});

test('AUDITORIA §10: baseUrl público legítimo é aceite', () => {
  const p = new ExternalInstagramProvider({ providerName: 'X', baseUrl: 'https://api.acme.example/v1/', apiKey: 'k' });
  assert.equal(p.baseUrl, 'https://api.acme.example/v1');
});

test('AUDITORIA §8: serializar o provider por engano não expõe apiKey nem baseUrl', () => {
  const p = new ExternalInstagramProvider({
    providerName: 'Acme', baseUrl: 'https://privado.acme.example', apiKey: 'CHAVE-SECRETA'
  });
  for (const s of [JSON.stringify(p), JSON.stringify({ provider: p }), JSON.stringify([p])]) {
    assert.equal(s.includes('CHAVE-SECRETA'), false);
    assert.equal(s.includes('privado.acme.example'), false);
  }
  const meta = new MetaInstagramProvider({ accessToken: 'TOKEN-SECRETO', appSecret: 'APP-SECRETO', enabledForRealRequests: true });
  const sm = JSON.stringify(meta);
  assert.equal(sm.includes('TOKEN-SECRETO'), false);
  assert.equal(sm.includes('APP-SECRETO'), false);
});

test('AUDITORIA §8: nenhuma via de serialização revela refreshToken/clientSecret/appSecret', () => {
  const env = {
    INSTAGRAM_META_ACCESS_TOKEN: 'AT', INSTAGRAM_META_APP_SECRET: 'APPSEC',
    INSTAGRAM_EXTERNAL_PROVIDER: 'Acme', INSTAGRAM_EXTERNAL_BASE_URL: 'https://priv.example',
    INSTAGRAM_EXTERNAL_API_KEY: 'AK'
  };
  const reg = construirRegistry(env);
  const vias = [
    JSON.stringify(vistaPublica(reg, env)),
    JSON.stringify(reg.listProviders()),
    JSON.stringify(reg.getProvider('meta')),
    JSON.stringify(reg.getProvider('external:acme')),
    JSON.stringify(reg.accountsView())
  ];
  for (const s of vias) {
    for (const segredo of ['AT', 'APPSEC', 'AK', 'priv.example']) {
      assert.equal(s.includes('"' + segredo + '"'), false, 'fuga de ' + segredo);
    }
    assert.equal(s.includes('priv.example'), false);
  }
});

test('AUDITORIA §9: auditoria com segredos aninhados e em array não os grava', () => {
  const a = new OutreachAudit();
  const l = a.registar({
    provider: 'x', accessToken: 'TK', apiKey: 'AK',
    detalhe: { headers: { Authorization: 'Bearer TK' } },
    lista: [{ apiKey: 'AK' }]
  });
  const s = JSON.stringify(l);
  assert.equal(s.includes('TK'), false);
  assert.equal(s.includes('AK'), false);
  assert.equal('accessToken' in l, false);
  assert.equal('detalhe' in l, false, 'campos fora da lista fechada não entram');
});

test('AUDITORIA §11: item em estado terminal nunca volta ao fornecedor', async () => {
  const { registry, provider, conta } = await registoComMock();
  const queue = new OutreachQueue({ registry });
  const item = queue.enqueue({ campaignId: 'c', accountId: conta.accountId, recipient: { username: 'l' }, message: 'Olá' });
  await queue.processarItem(item);
  assert.equal(item.status, ITEM_STATUS.SENT);
  const depois = provider.enviadas.length;
  await queue.processarItem(item);
  await queue.processarItem(item);
  await queue.processar();
  assert.equal(provider.enviadas.length, depois, 'um item SENT foi reenviado');
});

test('AUDITORIA §13: LIMITAÇÃO CONHECIDA — sem lock, dois workers duplicam o envio', async () => {
  const { registry, provider, conta } = await registoComMock();
  const queue = new OutreachQueue({ registry });
  const item = queue.enqueue({ campaignId: 'c', accountId: conta.accountId, recipient: { username: 'l' }, message: 'Olá' });
  await Promise.all([queue.processarItem(item), queue.processarItem(item)]);
  /* Este teste DOCUMENTA a limitação em vez de a esconder: a fila é um
     componente de domínio em memória, sem reivindicação atómica do item.
     Só é seguro com um único worker. Uma fila production-ready precisa de
     armazenamento transacional com claim (SELECT ... FOR UPDATE SKIP LOCKED,
     lease com TTL, ou equivalente). */
  assert.equal(provider.enviadas.length, 2,
    'se este teste falhar, foi adicionado um lock — atualizar a documentação');
});

/* ================================================================ *
 * 16. Meta bloqueado para pedidos reais (ajuste pré-commit)         *
 * ================================================================ */

test('META BLOQUEADO: por omissão não faz fetch e devolve META_PROVIDER_NOT_VALIDATED', async () => {
  let chamou = false;
  const espia = async () => { chamou = true; return respostaFalsa({ body: { message_id: 'x' } }); };
  /* configuração completa de propósito: nem com token o adapter dispara */
  const p = new MetaInstagramProvider({ accessToken: 'token-real', appSecret: 's' }, { fetch: espia });

  const r = await p.sendMessage({
    account: { providerAccountId: '1784' }, recipient: { providerUserId: 'igsid-9' }, message: 'Olá'
  });

  assert.equal(chamou, false, 'foi feito um pedido real com o adapter bloqueado');
  assert.equal(r.success, false);
  assert.equal(r.status, 'NOT_CONFIGURED');
  assert.equal(r.errorCode, 'META_PROVIDER_NOT_VALIDATED');
  assert.equal(r.retryable, false, 'não pode ser reagendado: o bloqueio não se resolve com tempo');
});

test('META BLOQUEADO: connect, perfil e conversas também não tocam na rede', async () => {
  let chamadas = 0;
  const espia = async () => { chamadas += 1; return respostaFalsa({ body: {} }); };
  const p = new MetaInstagramProvider({ accessToken: 'token-real' }, { fetch: espia });
  const conta = { providerAccountId: '1784' };

  await assert.rejects(() => p.connect({ providerAccountId: '1784' }), /META_PROVIDER_NOT_VALIDATED|bloqueado/);
  await assert.rejects(() => p.listConversations(conta), /bloqueado/);
  /* `fetchProfile` deixou de ser recusado por bloqueio e passou a
     sê-lo por não existir: `business_discovery` é do caminho Facebook
     Login e não está documentado em graph.instagram.com. A garantia que
     interessa — não tocar na rede — continua a valer. */
  await assert.rejects(() => p.fetchProfile(conta, 'alguem'), /não suporta/i);
  assert.equal(chamadas, 0, 'alguma via chegou a fazer fetch com o adapter bloqueado');
});

test('META BLOQUEADO: sem IGSID o motivo reportado é o bloqueio, não o payload', async () => {
  const p = new MetaInstagramProvider({ accessToken: 't' }, { fetch: fetchFalso({ body: {} }) });
  const r = await p.sendMessage({
    account: { providerAccountId: '1' }, recipient: { username: 'so_username' }, message: 'Olá'
  });
  assert.equal(r.errorCode, 'META_PROVIDER_NOT_VALIDATED');
});

test('META BLOQUEADO: isConfigured() é false mesmo com token válido', () => {
  const p = new MetaInstagramProvider({ accessToken: 'token-real' });
  assert.equal(p.isConfigured(), false);
  assert.equal(p.isBlockedPendingValidation(), true);
  assert.equal(p.describe().configured, false);
});

test('META BLOQUEADO: a fila marca o item FAILED sem retry', async () => {
  const registry = new InstagramRegistry();
  let chamou = false;
  registry.register(new MetaInstagramProvider(
    { accessToken: 't' }, { fetch: async () => { chamou = true; return respostaFalsa({ body: {} }); } }
  ));
  /* conta injetada diretamente: connect também está bloqueado */
  registry.contas.set('meta:1784', {
    accountId: 'meta:1784', provider: 'meta', providerAccountId: '1784',
    username: 'loja', displayName: 'Loja', status: ACCOUNT_STATUS.CONNECTED,
    connectedAt: null, lastSyncAt: null
  });
  const queue = new OutreachQueue({ registry });
  const item = queue.enqueue({
    campaignId: 'c', accountId: 'meta:1784', recipient: { providerUserId: 'igsid-1' }, message: 'Olá'
  });
  await queue.processarItem(item);
  assert.equal(chamou, false);
  assert.equal(item.status, ITEM_STATUS.FAILED);
  assert.equal(item.tentativas, 1, 'não deve haver segunda tentativa');
  assert.equal(item.resultado.errorCode, 'META_PROVIDER_NOT_VALIDATED');
});

test('META BLOQUEADO: construirRegistry só desbloqueia com a variável explícita', () => {
  const semFlag = construirRegistry({ INSTAGRAM_META_ACCESS_TOKEN: 't' });
  assert.equal(semFlag.getProvider('meta').enabledForRealRequests, false);
  assert.equal(semFlag.getProvider('meta').isConfigured(), false);

  const comFlag = construirRegistry({
    INSTAGRAM_META_ACCESS_TOKEN: 't', INSTAGRAM_META_ENABLED_FOR_REAL_REQUESTS: '1'
  });
  assert.equal(comFlag.getProvider('meta').enabledForRealRequests, true);
  assert.equal(comFlag.getProvider('meta').isConfigured(), true);

  /* qualquer valor que não seja exatamente "1" mantém o bloqueio */
  for (const v of ['true', 'yes', 'sim', '0', '', 'TRUE']) {
    assert.equal(
      construirRegistry({ INSTAGRAM_META_ACCESS_TOKEN: 't', INSTAGRAM_META_ENABLED_FOR_REAL_REQUESTS: v })
        .getProvider('meta').enabledForRealRequests,
      false, 'valor "' + v + '" não devia desbloquear'
    );
  }
});

test('META BLOQUEADO: a vista pública diz porque está bloqueado', () => {
  const env = { INSTAGRAM_META_ACCESS_TOKEN: 't' };
  const meta = vistaPublica(construirRegistry(env), env).providers.find(p => p.id === 'meta');
  assert.equal(meta.configured, false);
  assert.ok(meta.missingEnv.some(v => v.startsWith('INSTAGRAM_META_ENABLED_FOR_REAL_REQUESTS')));
});

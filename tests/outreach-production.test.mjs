/**
 * LeadMap Pro — testes da infraestrutura de produção do Outreach (Fase C)
 * =======================================================================
 *   node --test
 *
 * Nenhum teste toca na rede. Há um teste que instrumenta `fetch` e falha
 * se sair qualquer pedido para a Meta, o Instagram ou um fornecedor
 * externo durante o trabalho do worker.
 *
 * NOTA SOBRE POSTGRESQL: estes testes correm contra
 * `InMemoryOutreachRepository`, que reproduz as mesmas regras e não exige
 * infraestrutura. As constraints, transações e o claim atómico do SQL
 * real são exercitados contra um PostgreSQL verdadeiro em
 * `postgres-integration.test.mjs`, que salta quando não há
 * `OUTREACH_TEST_DATABASE_URL`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  idempotencyKey, planoDeRetry, backoffSegundos, lockExpirado, motivoDeExclusao,
  separarElegiveis, transicaoValida, exigirTransicao, resolverTemplate,
  redigir, contemSegredos, extrair, paginacao, ValidationError,
  ambienteDe, mockPermitido, MAX_ACCOUNTS, MAX_ATTEMPTS_PADRAO,
  CAMPAIGN_STATUS, QUEUE_STATUS, LIMITE_PAGINA_MAX
} from '../providers/outreach/domain.mjs';
import { InMemoryOutreachRepository, RepositoryError } from '../providers/outreach/repository.mjs';
import { OutreachService } from '../providers/outreach/service.mjs';
import { OutreachWorker, novoWorkerId } from '../providers/outreach/worker.mjs';
import {
  criarHashPassword, verificarPassword, criarSessao, verificarSessao,
  autenticarOperador, exigirPapel, exigirSegredoDoWorker, cookieDeSessao,
  authConfigurada, AuthError, COOKIE_SESSAO
} from '../providers/outreach/auth.mjs';
import { PostgresOutreachRepository, bancoConfigurado } from '../providers/outreach/postgres.mjs';
import { analisarEstadoLocal, migrarParaRemoto } from '../providers/outreach/migrate-local.mjs';
import { MockInstagramProvider } from '../providers/instagram/index.mjs';

/* ---------------------------------------------------------------- *
 * Utilitários                                                       *
 * ---------------------------------------------------------------- */

async function cenario({ nContactos = 3, semInstagram = 0, optOut = 0 } = {}) {
  const repo = new InMemoryOutreachRepository();
  const conta = await repo.criarConta({ username: 'loja', displayName: 'Loja' });
  const ids = [];
  for (let i = 1; i <= nContactos; i++) {
    const { contacto } = await repo.upsertContacto({ normalizedInstagram: 'perfil' + i, name: 'Empresa ' + i, city: 'Lisboa' });
    ids.push(contacto.id);
  }
  for (let i = 1; i <= semInstagram; i++) {
    const { contacto } = await repo.upsertContacto({ leadId: 'L' + i, name: 'Sem IG ' + i });
    ids.push(contacto.id);
  }
  for (let i = 0; i < optOut; i++) await repo.definirOptOut(ids[i], true);
  const campanha = await repo.criarCampanha({ name: 'C', accountId: conta.id, body: 'Olá {{nome}}' });
  return { repo, conta, campanha, ids };
}

const ENV_AUTH = () => {
  const hash = criarHashPassword('password-de-teste-forte');
  return {
    OUTREACH_AUTH_SECRET: 'x'.repeat(48),
    OUTREACH_OPERATOR_EMAIL: 'op@example.com',
    OUTREACH_OPERATOR_PASSWORD_HASH: hash,
    OUTREACH_WORKER_SECRET: 'w'.repeat(40)
  };
};

/* ================================================================ *
 * §17/§79 Idempotência                                              *
 * ================================================================ */

test('idempotencyKey é determinística e não usa aleatoriedade', () => {
  const a = idempotencyKey({ campaignId: 'k1', contactId: 'c1', accountId: 'a1' });
  for (let i = 0; i < 50; i++) {
    assert.equal(idempotencyKey({ campaignId: 'k1', contactId: 'c1', accountId: 'a1' }), a);
  }
  assert.notEqual(a, idempotencyKey({ campaignId: 'k1', contactId: 'c2', accountId: 'a1' }));
  assert.notEqual(a, idempotencyKey({ campaignId: 'k1', contactId: 'c1', accountId: 'a1', messageVersion: 2 }));
  assert.throws(() => idempotencyKey({ campaignId: 'k1' }), /exige/);
});

test('§79 contacto: o mesmo Instagram não cria dois registos', async () => {
  const repo = new InMemoryOutreachRepository();
  const a = await repo.upsertContacto({ normalizedInstagram: 'loja', name: 'Loja' });
  const b = await repo.upsertContacto({ normalizedInstagram: 'loja', name: 'Loja outra vez' });
  assert.equal(a.criado, true);
  assert.equal(b.criado, false);
  assert.equal((await repo.listarContactos({})).total, 1);
});

test('§79 campaign_contact: o mesmo contacto não entra duas vezes', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 2 });
  await repo.iniciarCampanha(campanha.id, ids);
  await repo.iniciarCampanha(campanha.id, ids);
  const chaves = [...repo.campaignContacts.keys()];
  assert.equal(chaves.length, new Set(chaves).size);
  assert.equal(chaves.length, 2);
});

test('§79 message: idempotencyKey é única', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 3 });
  await repo.iniciarCampanha(campanha.id, ids);
  await repo.iniciarCampanha(campanha.id, ids);
  const chaves = [...repo.mensagens.values()].map(m => m.idempotencyKey);
  assert.equal(chaves.length, new Set(chaves).size);
  assert.equal(chaves.length, 3);
});

test('§79 webhook: o mesmo evento não é registado duas vezes', async () => {
  const repo = new InMemoryOutreachRepository();
  const a = await repo.registarWebhook({ provider: 'meta', providerEventId: 'ev1', eventType: 'delivered' });
  const b = await repo.registarWebhook({ provider: 'meta', providerEventId: 'ev1', eventType: 'delivered' });
  assert.equal(a.duplicado, false);
  assert.equal(b.duplicado, true);
  /* fornecedor diferente com o mesmo id continua a ser outro evento */
  assert.equal((await repo.registarWebhook({ provider: 'external', providerEventId: 'ev1', eventType: 'x' })).duplicado, false);
});

test('§79 máximo de 5 contas aplicado no repositório, não só na UI', async () => {
  const repo = new InMemoryOutreachRepository();
  for (let i = 1; i <= MAX_ACCOUNTS; i++) await repo.criarConta({ username: 'conta' + i });
  await assert.rejects(() => repo.criarConta({ username: 'conta6' }), /Limite máximo de 5/);
  const service = new OutreachService({ repository: repo });
  await assert.rejects(() => service.criarConta({ username: 'outra' }), /Limite máximo de 5/);
});

/* ================================================================ *
 * §80 Start de campanha                                             *
 * ================================================================ */

test('§80 start normal cria fila e mensagens', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 4 });
  const r = await repo.iniciarCampanha(campanha.id, ids);
  assert.equal(r.incluidos, 4);
  assert.equal(r.criados, 4);
  assert.equal((await repo.listarFila({ campaignId: campanha.id })).total, 4);
  assert.equal((await repo.lerCampanha(campanha.id)).status, CAMPAIGN_STATUS.RUNNING);
});

test('§54/§80 start duplicado NÃO duplica a fila', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 5 });
  const r1 = await repo.iniciarCampanha(campanha.id, ids);
  const r2 = await repo.iniciarCampanha(campanha.id, ids);
  const r3 = await repo.iniciarCampanha(campanha.id, ids);
  assert.equal(r1.criados, 5);
  assert.equal(r2.criados, 0);
  assert.equal(r3.criados, 0);
  assert.equal(r2.jaExistiam, 5);
  assert.equal((await repo.listarFila({ campaignId: campanha.id })).total, 5);
  assert.equal(repo.mensagens.size, 5);
});

test('§80 start concorrente (dois pedidos ao mesmo tempo) não duplica', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 6 });
  const [a, b] = await Promise.all([
    repo.iniciarCampanha(campanha.id, ids),
    repo.iniciarCampanha(campanha.id, ids)
  ]);
  assert.equal(a.criados + b.criados, 6, 'no total só podem existir 6 mensagens');
  assert.equal((await repo.listarFila({ campaignId: campanha.id })).total, 6);
});

test('§80 start exclui sem-Instagram e opt-out, com motivo', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 3, semInstagram: 2, optOut: 1 });
  const r = await repo.iniciarCampanha(campanha.id, ids);
  assert.equal(r.incluidos, 2);
  assert.equal(r.excluidos, 3);
  assert.equal(r.motivos.NO_INSTAGRAM, 2);
  assert.equal(r.motivos.OPTED_OUT, 1);
});

test('§80 start sem contactos é recusado', async () => {
  const { repo, campanha } = await cenario({ nContactos: 0 });
  const service = new OutreachService({ repository: repo });
  await assert.rejects(() => service.iniciarCampanha(campanha.id, { contactIds: [] }), /contacto/i);
});

test('§80 start de campanha cancelada é recusado', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 2 });
  await repo.cancelarCampanha(campanha.id);
  await assert.rejects(() => repo.iniciarCampanha(campanha.id, ids), /terminal/i);
});

test('§80 campanha com conta inexistente é recusada', async () => {
  const repo = new InMemoryOutreachRepository();
  await assert.rejects(() => repo.criarCampanha({ name: 'C', accountId: 'nao-existe', body: 'x' }), /Conta não encontrada/);
});

/* ================================================================ *
 * §19/§56/§57 Atomic claim e concorrência                           *
 * ================================================================ */

test('§56 dois workers a reclamar o mesmo item: só um recebe', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 1 });
  await repo.iniciarCampanha(campanha.id, ids);
  const [a, b] = await Promise.all([
    repo.reclamarItens({ workerId: 'w1', limit: 5 }),
    repo.reclamarItens({ workerId: 'w2', limit: 5 })
  ]);
  assert.equal(a.length + b.length, 1, 'o item foi entregue a dois workers');
  const dono = (a[0] || b[0]).lockedBy;
  assert.ok(dono === 'w1' || dono === 'w2');
});

test('§57 10 workers e 100 itens: cada item reclamado uma só vez', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 100 });
  await repo.iniciarCampanha(campanha.id, ids);
  const lotes = await Promise.all(
    Array.from({ length: 10 }, (_, i) => repo.reclamarItens({ workerId: 'w' + i, limit: 20 }))
  );
  const todos = lotes.flat().map(i => i.id);
  assert.equal(todos.length, new Set(todos).size, 'houve itens entregues a mais de um worker');
  assert.equal(todos.length, 100);
  assert.equal((await repo.listarFila({ campaignId: campanha.id, status: QUEUE_STATUS.PENDING })).total, 0);
});

test('§57 10 workers a processar 100 itens: zero duplicações de envio', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 100 });
  await repo.iniciarCampanha(campanha.id, ids);
  const provider = new MockInstagramProvider({ script: {} });
  const workers = Array.from({ length: 10 }, (_, i) =>
    new OutreachWorker({ repository: repo, provider, workerId: 'w' + i }));

  await Promise.all(workers.map(w => w.processar({ limit: 20 })));

  const enviadas = provider.enviadas.map(e => e.recipient);
  assert.equal(enviadas.length, new Set(enviadas).size, 'o mesmo destinatário recebeu duas vezes');
  const fila = await repo.listarFila({ campaignId: campanha.id, limit: 200 });
  assert.equal(fila.items.filter(i => i.status === QUEUE_STATUS.SENT).length, 100);
});

/* ================================================================ *
 * §22/§58/§59 Locks e falhas de worker                              *
 * ================================================================ */

test('§22 lock expirado permite reclaim; lock fresco não', () => {
  const agora = Date.parse('2026-09-01T12:00:00Z');
  const fresco = { status: 'PROCESSING', lockedAt: '2026-09-01T11:59:00Z' };
  const velho = { status: 'PROCESSING', lockedAt: '2026-09-01T11:50:00Z' };
  assert.equal(lockExpirado(fresco, { agora }), false);
  assert.equal(lockExpirado(velho, { agora }), true);
  assert.equal(lockExpirado({ status: 'PENDING', lockedAt: '2026-09-01T11:50:00Z' }, { agora }), false);
});

test('§58 worker morre depois do claim: outro reclama após o timeout', async () => {
  let agora = new Date('2026-09-01T12:00:00Z');
  const repo = new InMemoryOutreachRepository({ agora: () => agora });
  const conta = await repo.criarConta({ username: 'loja' });
  const { contacto } = await repo.upsertContacto({ normalizedInstagram: 'p1', name: 'A' });
  const k = await repo.criarCampanha({ name: 'C', accountId: conta.id, body: 'Olá' });
  await repo.iniciarCampanha(k.id, [contacto.id]);

  const primeiro = await repo.reclamarItens({ workerId: 'morto', limit: 1 });
  assert.equal(primeiro.length, 1);
  /* o worker morre aqui: não concluiu o item */
  assert.equal((await repo.reclamarItens({ workerId: 'outro', limit: 1 })).length, 0, 'lock fresco não pode ser roubado');

  agora = new Date('2026-09-01T12:06:00Z');            /* > 300 s */
  const recuperado = await repo.reclamarItens({ workerId: 'outro', limit: 1 });
  assert.equal(recuperado.length, 1);
  assert.equal(recuperado[0].lockedBy, 'outro');
  assert.equal(recuperado[0].attemptCount, 2, 'a tentativa recuperada conta');
});

test('§59/§60 SENT é terminal: um worker atrasado não reabre nem reenvia', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 1 });
  await repo.iniciarCampanha(campanha.id, ids);
  const [item] = await repo.reclamarItens({ workerId: 'w1', limit: 1 });
  await repo.concluirItem({ itemId: item.id, outcome: 'SENT', providerMessageId: 'm1' });

  /* o worker que morreu depois do envio volta a tentar concluir */
  const r = await repo.concluirItem({ itemId: item.id, outcome: 'FAILED', errorCode: 'X' });
  assert.equal(r.jaTerminal, true);
  const fila = await repo.listarFila({ campaignId: campanha.id });
  assert.equal(fila.items[0].status, QUEUE_STATUS.SENT);
  assert.equal((await repo.lerMensagem(item.messageId)).providerMessageId, 'm1');
});

/* ================================================================ *
 * §23–§26 Retries, backoff e maxAttempts                            *
 * ================================================================ */

test('§24 backoff determinístico e documentado', () => {
  assert.equal(backoffSegundos(1), 30);
  assert.equal(backoffSegundos(2), 120);
  assert.equal(backoffSegundos(3), 600);
  assert.equal(backoffSegundos(9), 1800, 'existe teto — não cresce para sempre');
});

test('§26 retryAfterSec do fornecedor tem precedência, com teto de segurança', () => {
  const base = Date.parse('2026-09-01T12:00:00Z');
  const p = planoDeRetry({ resposta: { success: false, retryable: true, retryAfterSec: 90 }, attemptCount: 1, agora: base });
  assert.equal(p.acao, 'RETRY');
  assert.equal(p.segundos, 90);
  assert.equal(p.availableAt, '2026-09-01T12:01:30.000Z');
  /* um valor absurdo é limitado, não obedecido cegamente */
  const abusivo = planoDeRetry({ resposta: { success: false, retryable: true, retryAfterSec: 999999 }, attemptCount: 1, agora: base });
  assert.equal(abusivo.segundos, 6 * 3600);
});

test('§25 erro não recuperável falha à primeira; recuperável esgota maxAttempts', () => {
  assert.equal(planoDeRetry({ resposta: { success: false, retryable: false }, attemptCount: 1 }).acao, 'FAILED');
  assert.equal(planoDeRetry({ resposta: { success: false, retryable: true }, attemptCount: 1 }).acao, 'RETRY');
  const fim = planoDeRetry({ resposta: { success: false, retryable: true }, attemptCount: MAX_ATTEMPTS_PADRAO });
  assert.equal(fim.acao, 'FAILED');
  assert.equal(fim.motivo, 'MAX_ATTEMPTS');
});

test('§23 retry persiste no item: availableAt, erro e contagem ficam gravados', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 1 });
  await repo.iniciarCampanha(campanha.id, ids);
  const provider = new MockInstagramProvider({ script: { falharCom: 'RATE_LIMITED', retryAfterSec: 60 } });
  const worker = new OutreachWorker({ repository: repo, provider, workerId: 'w1' });
  await worker.processar({ limit: 1 });

  const fila = await repo.listarFila({ campaignId: campanha.id });
  const item = fila.items[0];
  assert.equal(item.status, QUEUE_STATUS.PENDING, 'volta a PENDING, não fica preso');
  assert.equal(item.lastErrorCode, 'RATE_LIMITED');
  assert.equal(item.attemptCount, 1);
  assert.ok(Date.parse(item.availableAt) > Date.now(), 'o adiamento ficou persistido');
  assert.equal(item.lockedBy, null, 'o lock foi libertado');
});

test('§25 ao fim das tentativas o item fica FAILED e não volta a ser reclamado', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 1 });
  await repo.iniciarCampanha(campanha.id, ids);
  const provider = new MockInstagramProvider({ script: { falharCom: 'TIMEOUT' } });
  const worker = new OutreachWorker({ repository: repo, provider, workerId: 'w1' });

  for (let i = 0; i < MAX_ATTEMPTS_PADRAO; i++) {
    const fila = await repo.listarFila({ campaignId: campanha.id });
    fila.items[0].availableAt = new Date(0).toISOString();   /* torna elegível já */
    repo.fila.get(fila.items[0].id).availableAt = new Date(0).toISOString();
    await worker.processar({ limit: 1 });
  }
  const fila = await repo.listarFila({ campaignId: campanha.id });
  assert.equal(fila.items[0].status, QUEUE_STATUS.FAILED);
  assert.equal((await repo.reclamarItens({ workerId: 'w2', limit: 5 })).length, 0);
});

/* ================================================================ *
 * §27–§30 Pause, resume, cancel, opt-out                            *
 * ================================================================ */

test('§27 pause é persistente e impede novos claims', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 5 });
  await repo.iniciarCampanha(campanha.id, ids);
  await repo.pausarCampanha(campanha.id);

  assert.equal((await repo.lerCampanha(campanha.id)).status, CAMPAIGN_STATUS.PAUSED);
  const fila = await repo.listarFila({ campaignId: campanha.id });
  assert.ok(fila.items.every(i => i.status === QUEUE_STATUS.PAUSED));
  assert.equal((await repo.reclamarItens({ workerId: 'w1', limit: 10 })).length, 0);
});

test('§27 pause não interrompe um item já reclamado', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 2 });
  await repo.iniciarCampanha(campanha.id, ids);
  const [emCurso] = await repo.reclamarItens({ workerId: 'w1', limit: 1 });
  await repo.pausarCampanha(campanha.id);

  const item = await repo.lerItem(emCurso.id);
  assert.equal(item.status, QUEUE_STATUS.PROCESSING, 'o item em curso continua; só não arrancam novos');
  const r = await repo.concluirItem({ itemId: emCurso.id, outcome: 'SENT', providerMessageId: 'm' });
  assert.equal(r.status, QUEUE_STATUS.SENT);
});

test('§28 resume não recria mensagens nem repõe as tentativas', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 3 });
  await repo.iniciarCampanha(campanha.id, ids);
  const antes = repo.mensagens.size;
  const [i1] = await repo.reclamarItens({ workerId: 'w1', limit: 1 });
  await repo.concluirItem({ itemId: i1.id, outcome: 'RETRY', errorCode: 'TIMEOUT' });

  await repo.pausarCampanha(campanha.id);
  await repo.retomarCampanha(campanha.id);

  assert.equal(repo.mensagens.size, antes, 'resume não pode recriar mensagens');
  assert.equal((await repo.lerCampanha(campanha.id)).status, CAMPAIGN_STATUS.RUNNING);
  assert.equal((await repo.lerItem(i1.id)).attemptCount, 1, 'as tentativas não são repostas');
});

test('§29 cancel é persistente e não apaga nem reenvia o que já foi SENT', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 4 });
  await repo.iniciarCampanha(campanha.id, ids);
  const [i1] = await repo.reclamarItens({ workerId: 'w1', limit: 1 });
  await repo.concluirItem({ itemId: i1.id, outcome: 'SENT', providerMessageId: 'm1' });

  await repo.cancelarCampanha(campanha.id);

  const fila = await repo.listarFila({ campaignId: campanha.id });
  const enviado = fila.items.find(i => i.id === i1.id);
  assert.equal(enviado.status, QUEUE_STATUS.SENT, 'um envio concluído não pode ser cancelado');
  assert.ok(fila.items.filter(i => i.id !== i1.id).every(i => i.status === QUEUE_STATUS.CANCELLED));
  assert.equal((await repo.reclamarItens({ workerId: 'w2', limit: 10 })).length, 0);
});

test('§30 opt-out DEPOIS de entrar na fila impede o envio', async () => {
  const { repo, campanha, ids } = await cenario({ nContactos: 2 });
  await repo.iniciarCampanha(campanha.id, ids);
  /* o contacto pede para não ser contactado já com o item em fila */
  await repo.definirOptOut(ids[0], true);

  const provider = new MockInstagramProvider({ script: {} });
  const worker = new OutreachWorker({ repository: repo, provider, workerId: 'w1' });
  await worker.processar({ limit: 10 });

  const fila = await repo.listarFila({ campaignId: campanha.id });
  const doOptOut = fila.items.find(i => i.contactId === ids[0]);
  assert.equal(doOptOut.status, QUEUE_STATUS.SKIPPED);
  assert.equal(doOptOut.lastErrorCode, 'OPTED_OUT');
  assert.equal(provider.enviadas.length, 1, 'só o outro contacto recebeu');
});

test('§14 transições de campanha inválidas são recusadas', () => {
  assert.equal(transicaoValida('RUNNING', 'PAUSED'), true);
  assert.equal(transicaoValida('CANCELLED', 'RUNNING'), false);
  assert.equal(transicaoValida('COMPLETED', 'RUNNING'), false);
  assert.throws(() => exigirTransicao('CANCELLED', 'RUNNING'), /Transição inválida/);
});

/* ================================================================ *
 * §82 Autenticação e autorização                                    *
 * ================================================================ */

test('§82 sem sessão → 401', () => {
  const env = ENV_AUTH();
  assert.throws(() => verificarSessao(null, env), (e) => e.status === 401 && e.errorCode === 'UNAUTHENTICATED');
  assert.throws(() => verificarSessao('lixo', env), (e) => e.status === 401);
});

test('§82 sessão adulterada ou expirada → 401', () => {
  const env = ENV_AUTH();
  const tok = criarSessao({ subject: 'op@example.com' }, env);
  assert.throws(() => verificarSessao(tok.slice(0, -4) + 'aaaa', env), (e) => e.status === 401);
  const futuro = Date.now() + 13 * 3600 * 1000;
  assert.throws(() => verificarSessao(tok, env, futuro), (e) => e.status === 401);
});

test('§82 sessão válida sem o papel → 403', () => {
  const env = ENV_AUTH();
  const tok = criarSessao({ subject: 'op@example.com', roles: ['outreach:operator'] }, env);
  const sessao = verificarSessao(tok, env);
  assert.equal(exigirPapel(sessao, 'outreach:operator'), true);
  assert.throws(() => exigirPapel(sessao, 'outreach:admin'), (e) => e.status === 403 && e.errorCode === 'FORBIDDEN');
});

test('§82 credenciais válidas → sessão com papéis', () => {
  const env = ENV_AUTH();
  const tok = autenticarOperador({ email: 'op@example.com', password: 'password-de-teste-forte' }, env);
  const s = verificarSessao(tok, env);
  assert.equal(s.sub, 'op@example.com');
  assert.ok(s.roles.includes('outreach:admin'));
});

test('§7 password nunca é guardada em claro e é verificada por hash', () => {
  const h = criarHashPassword('segredo-do-operador');
  assert.equal(h.includes('segredo-do-operador'), false);
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(verificarPassword('segredo-do-operador', h), true);
  assert.equal(verificarPassword('outra', h), false);
  assert.equal(verificarPassword('x', 'formato-invalido'), false);
});

test('§7 o cookie de sessão é HttpOnly, Secure e SameSite=Strict', () => {
  const c = cookieDeSessao('tok');
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, new RegExp('^' + COOKIE_SESSAO + '='));
});

test('§37 endpoint do worker exige o seu próprio segredo', () => {
  const env = ENV_AUTH();
  assert.throws(() => exigirSegredoDoWorker({ headers: {} }, env), (e) => e.status === 401);
  assert.throws(() => exigirSegredoDoWorker({ headers: { 'x-outreach-worker-secret': 'errado' } }, env), (e) => e.status === 401);
  assert.equal(exigirSegredoDoWorker({ headers: { 'x-outreach-worker-secret': env.OUTREACH_WORKER_SECRET } }, env), true);
  /* sem segredo configurado, recusa em vez de abrir */
  assert.throws(() => exigirSegredoDoWorker({ headers: {} }, {}), (e) => e.status === 503);
});

test('§76 sem autenticação configurada nada fica aberto por omissão', () => {
  assert.equal(authConfigurada({}), false);
  assert.throws(() => criarSessao({ subject: 'x' }, {}), (e) => e.errorCode === 'NOT_CONFIGURED');
  assert.throws(() => autenticarOperador({ email: 'a', password: 'b' }, {}), (e) => e.status === 503);
});

/* ================================================================ *
 * §83 Segredos                                                      *
 * ================================================================ */

test('§83 redigir apanha credenciais aninhadas e em arrays', () => {
  const s = redigir({
    ok: 'visivel',
    accessToken: 'TK', cfg: { apiKey: 'AK', db: { DATABASE_URL: 'postgres://u:p@h/d' } },
    lista: [{ password: 'P' }, { authorization: 'Bearer X' }]
  });
  const txt = JSON.stringify(s);
  for (const seg of ['TK', 'AK', 'postgres://', 'Bearer X']) assert.equal(txt.includes(seg), false, 'fuga: ' + seg);
  assert.equal(s.ok, 'visivel');
  assert.deepEqual(contemSegredos(s), []);
});

test('§83 a auditoria nunca grava credenciais', async () => {
  const repo = new InMemoryOutreachRepository();
  const linha = await repo.registarAuditoria({
    actor: 'op', action: 'MESSAGE_SENT', entityType: 'message', entityId: 'm1',
    metadata: { accessToken: 'TK', service_role: 'SR', nested: [{ apiKey: 'AK' }] }
  });
  const txt = JSON.stringify(linha);
  for (const seg of ['TK', 'SR', 'AK']) assert.equal(txt.includes(seg), false);
  assert.deepEqual(contemSegredos(linha), []);
});

test('§4 a configuração do banco nunca sai numa resposta', () => {
  const repo = new PostgresOutreachRepository(
    { baseUrl: 'https://projeto.example', serviceKey: 'CHAVE-DE-SERVICO' }, { env: {} });
  const s = JSON.stringify({ repo });
  /* o objeto não é serializável para o cliente sem revelar a chave:
     por isso NENHUMA rota devolve o repositório — só dados mapeados */
  assert.ok(s.includes('CHAVE-DE-SERVICO'), 'sanidade do teste');
  const estadoPublico = { databaseConfigured: true, environment: 'production' };
  assert.equal(JSON.stringify(estadoPublico).includes('CHAVE-DE-SERVICO'), false);
});

/* ================================================================ *
 * §68/§69/§70 Validação, mass assignment e paginação                *
 * ================================================================ */

test('§68 campos desconhecidos são descartados, não inseridos', () => {
  const r = extrair(
    { name: 'Template', body: 'Olá', id: 'INJETADO', createdAt: 'FALSO', isAdmin: true },
    { name: { tipo: 'texto', obrigatorio: true }, body: { tipo: 'texto', obrigatorio: true, max: 2000 } }
  );
  assert.deepEqual(Object.keys(r).sort(), ['body', 'name']);
});

test('§69 validação recusa entradas fora do contrato', () => {
  assert.throws(() => extrair({}, { name: { tipo: 'texto', obrigatorio: true } }), ValidationError);
  assert.throws(() => extrair({ n: 'x'.repeat(500) }, { n: { tipo: 'texto', max: 10 } }), /máximo/);
  assert.throws(() => extrair({ s: 'INVALIDO' }, { s: { tipo: 'enum', valores: ['A', 'B'] } }), /não permitido/);
  assert.throws(() => extrair({ id: 'tem espaços' }, { id: { tipo: 'id' } }), /identificador inválido/);
  assert.throws(() => extrair({ n: 1.5 }, { n: { tipo: 'inteiro' } }), /inteiro/);
});

test('§70/§71 paginação tem sempre teto', () => {
  assert.deepEqual(paginacao({}), { limit: 50, offset: 0 });
  assert.equal(paginacao({ limit: 999999 }).limit, LIMITE_PAGINA_MAX);
  assert.equal(paginacao({ limit: -5 }).limit, 50);
  assert.equal(paginacao({ offset: -3 }).offset, 0);
});

test('§70 listagens respeitam limit e offset', async () => {
  const repo = new InMemoryOutreachRepository();
  for (let i = 0; i < 120; i++) await repo.upsertContacto({ normalizedInstagram: 'p' + i, name: 'N' + i });
  const p1 = await repo.listarContactos({ limit: 50, offset: 0 });
  const p2 = await repo.listarContactos({ limit: 50, offset: 50 });
  assert.equal(p1.items.length, 50);
  assert.equal(p2.items.length, 50);
  assert.equal(p1.total, 120);
  assert.equal(new Set([...p1.items, ...p2.items].map(c => c.id)).size, 100);
});

/* ================================================================ *
 * §84 Migração local → remoto                                       *
 * ================================================================ */

function clienteRemotoFalso(repo) {
  const service = new OutreachService({ repository: repo, actor: 'migracao' });
  return {
    importarContactos: async (contacts) => ({ resumo: await service.importarContactos({ contacts }) }),
    listarTemplates: (o) => service.listarTemplates(o || { limit: 200, offset: 0 }),
    criarTemplate: (d) => service.criarTemplate(d),
    listarContas: async () => ({ items: await service.listarContas() }),
    criarCampanha: (d) => service.criarCampanha(d)
  };
}

const ESTADO_LOCAL = () => ({
  contactos: [
    { id: 'c-1', leadId: 'L1', instagram: 'loja_a', temInstagram: true, nome: 'Loja A', cidade: 'Lisboa', atividade: 'talhos' },
    { id: 'c-2', leadId: 'L2', instagram: 'loja_b', temInstagram: true, nome: 'Loja B', cidade: 'Porto' },
    { id: 'c-3', leadId: 'L3', instagram: null, temInstagram: false, nome: 'Sem IG' }
  ],
  templates: [{ id: 't-1', nome: 'Intro', mensagem: 'Olá {{nome}}' }],
  campanhas: [{ id: 'k-1', nome: 'Antiga', status: 'DRAFT', mensagem: 'Olá' }],
  contas: [{ id: 'a-1', username: 'local', provider: 'mock' }],
  mensagens: [{ id: 'm-1', texto: 'simulada' }, { id: 'm-2', texto: 'simulada' }],
  fila: [{ id: 'q-1' }]
});

test('§44 a análise mostra o que vai migrar e o que fica de fora', () => {
  const a = analisarEstadoLocal(ESTADO_LOCAL());
  assert.equal(a.contactos, 3);
  assert.equal(a.comInstagram, 2);
  assert.equal(a.templates, 1);
  assert.equal(a.contas, 1);
  assert.equal(a.naoMigra.mensagens, 2, 'as mensagens de teste ficam de fora e isso é dito');
  assert.equal(a.naoMigra.fila, 1);
});

test('§45 migração é idempotente: correr duas vezes não duplica', async () => {
  const repo = new InMemoryOutreachRepository();
  const remoto = clienteRemotoFalso(repo);
  const estado = ESTADO_LOCAL();

  const r1 = await migrarParaRemoto(estado, remoto);
  const r2 = await migrarParaRemoto(estado, remoto);

  assert.equal(r1.contactos.criados, 3);
  assert.equal(r2.contactos.criados, 0);
  assert.equal(r2.contactos.atualizados, 3);
  assert.equal(r1.templates.criados, 1);
  assert.equal(r2.templates.criados, 0);
  assert.equal(r2.templates.jaExistiam, 1);

  assert.equal((await repo.listarContactos({ limit: 100 })).total, 3);
  assert.equal((await repo.listarTemplates({ limit: 100 })).total, 1);
});

test('§46 mensagens e fila simuladas NÃO são migradas', async () => {
  const repo = new InMemoryOutreachRepository();
  const estado = ESTADO_LOCAL();
  const r = await migrarParaRemoto(estado, clienteRemotoFalso(repo));
  assert.equal(repo.mensagens.size, 0, 'nenhuma mensagem simulada virou produção');
  assert.equal(repo.fila.size, 0);
  assert.equal(r.naoMigrado.mensagens, 2);
  assert.equal(r.campanhas.criadas, 0, 'campanhas só migram a pedido explícito');
});

/* ================================================================ *
 * §85 Zero rede real                                                *
 * ================================================================ */

test('§85 ZERO REDE: o worker não faz nenhum pedido externo', async () => {
  const originais = { fetch: globalThis.fetch };
  const tentativas = [];
  globalThis.fetch = async (url) => { tentativas.push(String(url)); throw new Error('rede proibida'); };
  try {
    const { repo, campanha, ids } = await cenario({ nContactos: 20 });
    await repo.iniciarCampanha(campanha.id, ids);
    const worker = new OutreachWorker({
      repository: repo, provider: new MockInstagramProvider({ script: {} }), workerId: 'w1'
    });
    await worker.processar({ limit: 20 });
    await repo.listarAuditoria({ limit: 100 });
  } finally { globalThis.fetch = originais.fetch; }
  assert.deepEqual(tentativas, [], 'saíram pedidos: ' + tentativas.join(', '));
});

test('§103 nenhum host da Meta/Instagram aparece no código da Fase C', async () => {
  const { readFileSync } = await import('node:fs');
  const ficheiros = [
    'providers/outreach/domain.mjs', 'providers/outreach/repository.mjs',
    'providers/outreach/service.mjs', 'providers/outreach/worker.mjs',
    'providers/outreach/postgres.mjs', 'providers/outreach/auth.mjs',
    'providers/outreach/http.mjs', 'providers/outreach/remote-store.mjs',
    'providers/outreach/migrate-local.mjs'
  ];
  for (const f of ficheiros) {
    const s = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.equal(/graph\.facebook\.com|api\.instagram\.com|www\.instagram\.com\/api/.test(s), false, f);
    assert.equal(/puppeteer|playwright|selenium|document\.cookie/.test(s), false, f);
  }
});

/* ================================================================ *
 * §41 Meta continua bloqueado                                       *
 * ================================================================ */

test('§41/§104 Meta continua bloqueado e não faz fetch', async () => {
  const { MetaInstagramProvider } = await import('../providers/instagram/index.mjs');
  let fetches = 0;
  const m = new MetaInstagramProvider({ accessToken: 'token' }, {
    fetch: async () => { fetches += 1; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }; }
  });
  const r = await m.sendMessage({ account: { providerAccountId: '1' }, recipient: { providerUserId: '2' }, message: 'x' });
  assert.equal(m.enabledForRealRequests, false);
  assert.equal(m.isConfigured(), false);
  assert.equal(r.errorCode, 'META_PROVIDER_NOT_VALIDATED');
  assert.equal(fetches, 0);
});

test('§65 proteção SSRF do fornecedor externo continua ativa', async () => {
  const { ExternalInstagramProvider } = await import('../providers/instagram/index.mjs');
  for (const u of ['https://127.0.0.1/x', 'https://169.254.169.254/x', 'https://10.0.0.1/x', 'http://api.acme.example/v1']) {
    assert.throws(() => new ExternalInstagramProvider({ providerName: 'X', baseUrl: u, apiKey: 'k' }));
  }
  const ok = new ExternalInstagramProvider({ providerName: 'X', baseUrl: 'https://api.acme.example/v1', apiKey: 'k' });
  assert.equal(ok.baseUrl, 'https://api.acme.example/v1');
});

/* ================================================================ *
 * §48/§76 Ambiente e ausência de configuração                       *
 * ================================================================ */

test('§48 o fornecedor de teste não é permitido em produção', () => {
  assert.equal(ambienteDe({ OUTREACH_ENV: 'production' }), 'production');
  assert.equal(mockPermitido({ OUTREACH_ENV: 'production' }), false);
  assert.equal(mockPermitido({ OUTREACH_ENV: 'development' }), true);
  assert.equal(mockPermitido({}), true);
});

test('§76 sem banco configurado a resposta é NOT_CONFIGURED, não um crash', async () => {
  assert.equal(bancoConfigurado({}), false);
  const repo = new PostgresOutreachRepository({}, { env: {} });
  assert.equal(await repo.disponivel(), false);
  await assert.rejects(() => repo.listarContas(), (e) => e.errorCode === 'NOT_CONFIGURED');
});

test('§75 o estado do subsistema não revela configuração sensível', async () => {
  const repo = new InMemoryOutreachRepository();
  const s = new OutreachService({ repository: repo, env: { OUTREACH_ENV: 'test' } });
  const estado = await s.estado();
  assert.deepEqual(Object.keys(estado).sort(), ['databaseConfigured', 'environment', 'maxAccounts', 'mockAllowed']);
  assert.deepEqual(contemSegredos(estado), []);
});

/* ================================================================ *
 * §31 Template no backend                                           *
 * ================================================================ */

test('§31 template resolvido no backend não inventa valores', () => {
  const r = resolverTemplate('Olá {{nome}}, de {{cidade}}', { name: 'Loja', city: null });
  assert.equal(r.texto, 'Olá Loja, de {{cidade}}');
  assert.deepEqual(r.faltam, ['cidade']);
  assert.equal(r.texto.includes('undefined'), false);
  assert.equal(r.texto.includes('null'), false);
});

test('§31/§66 o corpo resolvido é texto — nada de HTML injetado', () => {
  const r = resolverTemplate('Olá {{nome}}', { name: '<img src=x onerror=alert(1)>' });
  /* o domínio devolve o texto tal como está; a UI é que tem de escapar.
     O que importa aqui é não construir markup no backend. */
  assert.equal(typeof r.texto, 'string');
  assert.equal(r.texto.includes('<img'), true);
  assert.equal(r.texto.startsWith('<'), false);
});

/* ================================================================ *
 * §86/§87 Performance e concorrência                                *
 * ================================================================ */

test('§86 desempenho com 100, 1000 e 3000 contactos', async () => {
  const medidas = {};
  for (const n of [100, 1000, 3000]) {
    const repo = new InMemoryOutreachRepository();
    const conta = await repo.criarConta({ username: 'loja' });
    const t0 = Date.now();
    const ids = [];
    for (let i = 0; i < n; i++) {
      const { contacto } = await repo.upsertContacto({ normalizedInstagram: 'p' + i, name: 'N' + i });
      ids.push(contacto.id);
    }
    const tImport = Date.now() - t0;
    const k = await repo.criarCampanha({ name: 'C', accountId: conta.id, body: 'Olá {{nome}}' });
    const t1 = Date.now();
    const r = await repo.iniciarCampanha(k.id, ids);
    const tFila = Date.now() - t1;
    assert.equal(r.criados, n);
    const t2 = Date.now();
    await repo.listarContactos({ limit: 50, offset: 0 });
    const tPagina = Date.now() - t2;
    medidas[n] = { tImport, tFila, tPagina };
    assert.ok(tImport < 20000, n + ' contactos: import demorou ' + tImport + ' ms');
    assert.ok(tFila < 20000, n + ' contactos: fila demorou ' + tFila + ' ms');
    assert.ok(tPagina < 2000, 'consulta paginada demorou ' + tPagina + ' ms');
  }
  globalThis.__medidasFaseC = medidas;
});

test('§87 1000 itens em fila, 10 workers, zero duplicações', async () => {
  const repo = new InMemoryOutreachRepository();
  const conta = await repo.criarConta({ username: 'loja' });
  const ids = [];
  for (let i = 0; i < 1000; i++) {
    const { contacto } = await repo.upsertContacto({ normalizedInstagram: 'q' + i, name: 'N' + i });
    ids.push(contacto.id);
  }
  const k = await repo.criarCampanha({ name: 'C', accountId: conta.id, body: 'Olá' });
  const t0 = Date.now();
  await repo.iniciarCampanha(k.id, ids);
  const tFila = Date.now() - t0;

  const provider = new MockInstagramProvider({ script: {} });
  const workers = Array.from({ length: 10 }, (_, i) => new OutreachWorker({ repository: repo, provider, workerId: 'w' + i }));
  const t1 = Date.now();
  await Promise.all(workers.map(w => w.processar({ limit: 100 })));
  const tProc = Date.now() - t1;

  const destinos = provider.enviadas.map(e => e.recipient);
  assert.equal(destinos.length, new Set(destinos).size, 'houve envios duplicados');
  assert.equal(destinos.length, 1000);
  globalThis.__medidasFila = { itens: 1000, tFila, tProc, workers: 10, duplicados: 0 };
  assert.ok(tProc < 30000, 'processar 1000 demorou ' + tProc + ' ms');
});


/* ------------------------------------------------------------------ *
 * Conformidade dos adapters com o contrato                            *
 * ------------------------------------------------------------------ */

test('CONTRATO: todos os adapters implementam a interface completa', async () => {
  const { OutreachRepository } = await import('../providers/outreach/repository.mjs');
  const { PostgresOutreachRepository } = await import('../providers/outreach/postgres.mjs');
  const { PgOutreachRepository } = await import('../providers/outreach/pg-repository.mjs');

  const metodosDoContrato = Object.getOwnPropertyNames(OutreachRepository.prototype)
    .filter(n => n !== 'constructor' && typeof OutreachRepository.prototype[n] === 'function');
  assert.ok(metodosDoContrato.length >= 20, 'contrato demasiado pequeno — leitura errada?');

  /* Uma operação em falta num adapter só aparece em runtime, e só na
     implementação que estiver ligada nesse ambiente. Foi assim que
     `lerContacto` faltou ao adapter HTTP — o único que corre na Vercel.
     Este teste transforma isso num erro de suite. */
  for (const Impl of [InMemoryOutreachRepository, PostgresOutreachRepository, PgOutreachRepository]) {
    const emFalta = metodosDoContrato.filter(m => {
      const f = Impl.prototype[m];
      return typeof f !== 'function' || f === OutreachRepository.prototype[m];
    });
    assert.deepEqual(emFalta, [], Impl.name + ' não implementa: ' + emFalta.join(', '));
  }
});

test('CONTRATO: o worker só usa métodos que o contrato garante', async () => {
  const { readFileSync } = await import('node:fs');
  const { OutreachRepository } = await import('../providers/outreach/repository.mjs');
  const contrato = new Set(Object.getOwnPropertyNames(OutreachRepository.prototype));
  const fonte = readFileSync(new URL('../providers/outreach/worker.mjs', import.meta.url), 'utf8');

  /* `this.repo.<x>` tem de existir no contrato; aceder a estruturas
     internas de uma implementação concreta (this.repo.contactos) fez o
     worker funcionar em memória e falhar contra PostgreSQL. */
  const usados = [...fonte.matchAll(/this\.repo\.([a-zA-Z_]+)/g)].map(m => m[1]);
  const forasDoContrato = [...new Set(usados)].filter(n => !contrato.has(n));
  assert.deepEqual(forasDoContrato, [], 'worker usa fora do contrato: ' + forasDoContrato.join(', '));
});

/**
 * LeadMap Pro — testes do InstagramProviderRouter
 * ===============================================
 *   node --test
 *
 * O router é o sítio onde se decide por que canal sai uma mensagem para
 * uma pessoa real. Por isso a maioria destes testes verifica o que ele
 * **recusa** fazer: escolher um fornecedor por omissão, tentar outro
 * quando o primeiro falha, ou deixar passar um envio a quem pediu para
 * não ser contactado.
 *
 * Nenhum destes testes envia nada: os fornecedores são duplos.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { InstagramProviderRouter, PROVIDER_TYPES, PROVIDER_INFO } from '../providers/instagram/router.mjs';
import { InstagramRegistry } from '../providers/instagram/registry.mjs';
import { OutreachWorker } from '../providers/outreach/worker.mjs';
import { InMemoryOutreachRepository } from '../providers/outreach/repository.mjs';
import { OutreachService } from '../providers/outreach/service.mjs';
import { MESSAGE_STATUS } from '../providers/instagram/contract.mjs';

/* ---------------------------------------------------------------- *
 * Duplos                                                            *
 * ---------------------------------------------------------------- */

/** Fornecedor que regista o que lhe pedem e nunca sai da máquina. */
function duplo(id, { configurado = true, resposta = null, capabilities = {} } = {}) {
  const enviadas = [];
  return {
    id, displayName: id, enviadas, capabilities,
    isConfigured: () => configurado,
    describe: () => ({ id, displayName: id, capabilities, configured: configurado }),
    async sendMessage(p) {
      enviadas.push(p);
      return resposta || { success: true, providerMessageId: id + '-1', status: MESSAGE_STATUS.SENT,
                           errorCode: null, errorMessage: null, retryable: false, retryAfterSec: null };
    }
  };
}

function routerCom(providers) {
  return new InstagramProviderRouter({ providers });
}

/* ================================================================ *
 * 1–3 · cada conta resolve para o seu fornecedor                    *
 * ================================================================ */

test('ROUTER 1: conta ManyChat resolve ManyChat', () => {
  const mc = duplo('manychat'), mt = duplo('meta'), ex = duplo('external');
  const r = routerCom({ manychat: mc, meta: mt, external: ex });
  const e = r.resolve({ account: { provider: 'manychat' } });
  assert.equal(e.providerType, 'manychat');
  assert.equal(e.provider, mc);
  assert.equal(e.origem, 'account');
});

test('ROUTER 2: conta Meta resolve Meta', () => {
  const mc = duplo('manychat'), mt = duplo('meta'), ex = duplo('external');
  const r = routerCom({ manychat: mc, meta: mt, external: ex });
  assert.equal(r.resolve({ account: { provider: 'meta' } }).provider, mt);
});

test('ROUTER 3: conta External resolve External', () => {
  const mc = duplo('manychat'), mt = duplo('meta'), ex = duplo('external');
  const r = routerCom({ manychat: mc, meta: mt, external: ex });
  assert.equal(r.resolve({ account: { provider: 'external' } }).provider, ex);
});

test('ROUTER: também aceita providerType em vez de provider', () => {
  const mc = duplo('manychat');
  const r = routerCom({ manychat: mc });
  assert.equal(r.resolve({ account: { providerType: 'MANYCHAT' } }).provider, mc, 'devia ser insensível a maiúsculas');
});

/* ================================================================ *
 * 4 · fornecedor desconhecido                                       *
 * ================================================================ */

test('ROUTER 4: fornecedor desconhecido bloqueia — nunca cai num por omissão', () => {
  const mc = duplo('manychat'), mt = duplo('meta');
  const r = routerCom({ manychat: mc, meta: mt });
  for (const mau of ['telegram', 'whatsapp', 'META_OFICIAL', '', null, undefined, 'mc']) {
    assert.throws(() => r.resolve({ account: { provider: mau } }),
      (e) => e.errorCode === 'INVALID_REQUEST',
      'aceitou "' + String(mau) + '"');
  }
  assert.equal(mc.enviadas.length + mt.enviadas.length, 0);
});

test('ROUTER 4b: fornecedor conhecido mas não registado → NOT_CONFIGURED', () => {
  const r = routerCom({ manychat: duplo('manychat') });
  assert.throws(() => r.resolve({ account: { provider: 'meta' } }),
    (e) => e.errorCode === 'NOT_CONFIGURED' && /não está registado/.test(e.message));
});

/* ================================================================ *
 * 5 · fornecedor registado mas não configurado                      *
 * ================================================================ */

test('ROUTER 5: fornecedor sem configuração → erro normalizado', () => {
  const r = routerCom({ manychat: duplo('manychat', { configurado: false }) });
  assert.throws(() => r.resolve({ account: { provider: 'manychat' } }), (e) => {
    assert.equal(e.errorCode, 'NOT_CONFIGURED');
    assert.match(e.message, /não configurado/);
    return true;
  });
});

/* ================================================================ *
 * 6 · precedência: o item de fila manda                             *
 * ================================================================ */

test('ROUTER 6: item de fila vence a conta quando divergem', () => {
  const mc = duplo('manychat'), mt = duplo('meta');
  const r = routerCom({ manychat: mc, meta: mt });
  const e = r.resolve({ item: { provider: 'manychat' }, account: { provider: 'meta' } });
  /* o item foi enfileirado com a chave de idempotência calculada para
     manychat; reencaminhá-lo agora seria enviar por um canal que ninguém
     reviu e arriscar um segundo envio */
  assert.equal(e.providerType, 'manychat');
  assert.equal(e.provider, mc);
  assert.equal(e.origem, 'queue_item');
  assert.equal(e.divergente, true, 'a divergência devia ficar assinalada para a auditoria');
});

test('ROUTER 6b: sem provider no item, decide a conta', () => {
  const mc = duplo('manychat'), mt = duplo('meta');
  const r = routerCom({ manychat: mc, meta: mt });
  const e = r.resolve({ item: { provider: null }, account: { provider: 'meta' } });
  assert.equal(e.providerType, 'meta');
  assert.equal(e.origem, 'account');
  assert.equal(e.divergente, false);
});

test('ROUTER 6c: sem fornecedor em lado nenhum → recusa', () => {
  const r = routerCom({ manychat: duplo('manychat') });
  assert.throws(() => r.resolve({ item: {}, account: {} }), (e) => e.errorCode === 'INVALID_REQUEST');
});

/* ================================================================ *
 * Integração com o registry real                                    *
 * ================================================================ */

test('ROUTER: funciona sobre um InstagramRegistry a sério', () => {
  const reg = new InstagramRegistry();
  reg.register(duplo('manychat'));
  reg.register(duplo('meta'));
  const r = new InstagramProviderRouter({ registry: reg });
  assert.deepEqual(r.listar().sort(), ['manychat', 'meta']);
  assert.equal(r.resolve({ account: { provider: 'meta' } }).providerType, 'meta');
});

test('ROUTER: a vista para a UI não traz credenciais', () => {
  const r = routerCom({ manychat: duplo('manychat'), meta: duplo('meta', { configurado: false }) });
  const v = r.vista();
  assert.equal(v.length, 2);
  const mc = v.find(x => x.id === 'manychat');
  assert.equal(mc.nome, PROVIDER_INFO.manychat.nome);
  assert.equal(mc.configurado, true);
  assert.equal(v.find(x => x.id === 'meta').configurado, false);
  const txt = JSON.stringify(v);
  for (const proibido of ['token', 'apiKey', 'secret', 'Bearer']) {
    assert.equal(txt.toLowerCase().includes(proibido.toLowerCase()), false, 'fuga: ' + proibido);
  }
});

test('ROUTER: a lista de tipos conhecidos é fechada', () => {
  assert.deepEqual([...PROVIDER_TYPES].sort(), ['external', 'manychat', 'meta', 'mock']);
});

/* ================================================================ *
 * 7 · compatibilidade com o worker antigo                           *
 * ================================================================ */

async function cenario({ providerDaConta = 'manychat', providerDoItem = null } = {}) {
  const repo = new InMemoryOutreachRepository();
  const svc = new OutreachService({ repository: repo, actor: 'teste', env: { OUTREACH_ENV: 'test' } });
  const conta = await svc.criarConta({ username: 'loja', displayName: 'Loja', provider: providerDaConta === 'meta' ? 'meta' : 'mock' });
  await svc.importarContactos({ contacts: [
    { leadId: 'L1', normalizedInstagram: 'cliente_um', name: 'Cliente Um' }
  ] });
  const contactos = await svc.listarContactos({ limit: 10, offset: 0 });
  const camp = await svc.criarCampanha({ name: 'C', accountId: conta.id, body: 'Olá {{nome}}' });
  await svc.iniciarCampanha(camp.id, { contactIds: contactos.items.map(c => c.id) });
  const fila = await svc.listarFila({ campaignId: camp.id, limit: 10, offset: 0 });
  if (providerDoItem) {
    /* forçar o provider do item, como se tivesse sido enfileirado por outro */
    for (const it of repo.fila.values()) it.provider = providerDoItem;
  }
  return { repo, svc, conta, camp, fila, contactos };
}

test('ROUTER 7: worker construído com provider (modo antigo) continua a funcionar', async () => {
  const { repo } = await cenario();
  const p = duplo('mock');
  const w = new OutreachWorker({ repository: repo, provider: p, workerId: 'w1' });
  const r = await w.processar({ limit: 10 });
  assert.equal(r.enviados, 1);
  assert.equal(p.enviadas.length, 1, 'o provider injetado devia ter sido usado');
});

test('ROUTER 7b: worker sem provider e sem router recusa-se a existir', () => {
  assert.throws(() => new OutreachWorker({ repository: new InMemoryOutreachRepository() }),
    /provider ou um router/);
});

test('ROUTER 7c: worker com router usa o provider do item de fila', async () => {
  const { repo } = await cenario({ providerDoItem: 'manychat' });
  const mc = duplo('manychat'), mt = duplo('meta'), mk = duplo('mock');
  const w = new OutreachWorker({
    repository: repo, router: routerCom({ manychat: mc, meta: mt, mock: mk }), workerId: 'w2'
  });
  const r = await w.processar({ limit: 10 });
  assert.equal(r.enviados, 1);
  assert.equal(mc.enviadas.length, 1, 'devia ter saído pelo manychat, que é o provider do item');
  assert.equal(mt.enviadas.length, 0);
  assert.equal(mk.enviadas.length, 0);
});

test('ROUTER 7d: item com provider não configurado falha sem enviar por outro', async () => {
  const { repo } = await cenario({ providerDoItem: 'meta' });
  const mc = duplo('manychat'), mt = duplo('meta', { configurado: false });
  const w = new OutreachWorker({
    repository: repo, router: routerCom({ manychat: mc, meta: mt }), workerId: 'w3'
  });
  const r = await w.processar({ limit: 10 });
  assert.equal(r.falhados, 1);
  assert.equal(mc.enviadas.length, 0, 'HOUVE FALLBACK: enviou por outro fornecedor');
  assert.equal(mt.enviadas.length, 0);
});

/* ================================================================ *
 * 8 · opt-out é global                                              *
 * ================================================================ */

test('ROUTER 8: opt-out bloqueia antes de qualquer fornecedor', async () => {
  for (const tipo of ['manychat', 'meta', 'external']) {
    const { repo, contactos } = await cenario({ providerDoItem: tipo });
    await repo.definirOptOut(contactos.items[0].id, true);
    const providers = { manychat: duplo('manychat'), meta: duplo('meta'), external: duplo('external') };
    const w = new OutreachWorker({ repository: repo, router: routerCom(providers), workerId: 'w-opt' });
    const r = await w.processar({ limit: 10 });
    assert.equal(r.ignorados, 1, tipo + ': devia ter sido ignorado');
    for (const [id, p] of Object.entries(providers)) {
      assert.equal(p.enviadas.length, 0, tipo + ': o fornecedor ' + id + ' foi chamado apesar do opt-out');
    }
  }
});

/* ================================================================ *
 * 9 · idempotência acima do fornecedor                              *
 * ================================================================ */

test('ROUTER 9: a chave de idempotência não muda com o fornecedor', async () => {
  const { idempotencyKey } = await import('../providers/outreach/domain.mjs');
  const base = { campaignId: 'c1', contactId: 'k1', accountId: 'a1', messageVersion: 1 };
  const chave = idempotencyKey(base);
  /* a chave é do envio lógico: campanha + contacto + conta + versão.
     Nenhum fornecedor entra nela, e é isso que impede que trocar de
     canal reabra a porta a um segundo envio. */
  assert.equal(chave.includes('manychat'), false);
  assert.equal(chave.includes('meta'), false);
  assert.equal(chave, idempotencyKey({ ...base }));
});

test('ROUTER 9b: repetir o start não cria segunda mensagem, seja qual for o provider', async () => {
  const { repo, svc, camp, contactos } = await cenario({ providerDoItem: 'manychat' });
  const antes = (await svc.listarFila({ campaignId: camp.id, limit: 50, offset: 0 })).items.length;
  await svc.iniciarCampanha(camp.id, { contactIds: contactos.items.map(c => c.id) });
  const depois = (await svc.listarFila({ campaignId: camp.id, limit: 50, offset: 0 })).items.length;
  assert.equal(depois, antes, 'o segundo start duplicou a fila');
  assert.equal(repo.mensagens.size, 1);
});

test('ROUTER 9c: um item já terminal não é reenviado por outro fornecedor', async () => {
  const { repo } = await cenario({ providerDoItem: 'manychat' });
  const mc = duplo('manychat');
  const w = new OutreachWorker({ repository: repo, router: routerCom({ manychat: mc }), workerId: 'w4' });
  await w.processar({ limit: 10 });
  assert.equal(mc.enviadas.length, 1);
  /* forçar o item de volta a PENDING mas com outro provider, como se
     alguém tivesse mudado a conta a meio */
  for (const it of repo.fila.values()) { it.provider = 'meta'; }
  const mt = duplo('meta');
  const w2 = new OutreachWorker({ repository: repo, router: routerCom({ manychat: mc, meta: mt }), workerId: 'w5' });
  const r = await w2.processar({ limit: 10 });
  assert.equal(r.reclamados, 0, 'um item terminal foi reclamado outra vez');
  assert.equal(mt.enviadas.length, 0);
});

/* ================================================================ *
 * 10 · sem fallback automático                                      *
 * ================================================================ */

test('ROUTER 10: falha de envio NÃO tenta outro fornecedor', async () => {
  const { repo } = await cenario({ providerDoItem: 'manychat' });
  const mc = duplo('manychat', { resposta: {
    success: false, providerMessageId: null, status: MESSAGE_STATUS.FAILED,
    errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: 'em baixo', retryable: true, retryAfterSec: null
  } });
  const mt = duplo('meta'), ex = duplo('external');
  const w = new OutreachWorker({
    repository: repo, router: routerCom({ manychat: mc, meta: mt, external: ex }), workerId: 'w6'
  });
  await w.processar({ limit: 10 });
  assert.equal(mc.enviadas.length, 1);
  assert.equal(mt.enviadas.length, 0, 'HOUVE FALLBACK para meta');
  assert.equal(ex.enviadas.length, 0, 'HOUVE FALLBACK para external');
});

test('ROUTER 10b: o código do router não contém lógica de fallback', async () => {
  const { readFileSync } = await import('node:fs');
  const fonte = readFileSync(new URL('../providers/instagram/router.mjs', import.meta.url), 'utf8');
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '');   /* sem comentários */
  for (const padrao of [/fallback/i, /catch[\s\S]{0,120}?porId\(/, /for\s*\(.*of\s*PROVIDER_TYPES[\s\S]{0,200}?sendMessage/]) {
    assert.equal(padrao.test(codigo), false, 'o router parece tentar outro fornecedor: ' + padrao);
  }
});

/* ================================================================ *
 * Capacidades declaradas — não inventadas                           *
 * ================================================================ */

test('CAPS: a ManyChat declara o que a API dela permite mesmo', async () => {
  const { ManyChatInstagramProvider } = await import('../providers/instagram/manychat.mjs');
  const c = new ManyChatInstagramProvider({ apiToken: '1:t' }).capabilities;
  /* não existe procura por username — está provado na spec pública */
  assert.equal(c.canLookupByUsername, false);
  assert.equal(c.canLookupByEmailOrPhone, true);
  assert.equal(c.canInitiateFirstContact, false);
  assert.equal(c.requiresMessagingWindow, true);
  assert.equal(c.canSendFlow, true);
  assert.equal(c.canSendFreeText, false);
});

test('CAPS: a Meta não declara capacidades por validar', async () => {
  const { MetaInstagramProvider } = await import('../providers/instagram/meta.mjs');
  const c = new MetaInstagramProvider({ accessToken: 't' }).capabilities;
  assert.equal(c.canLookupByUsername, false);
  assert.equal(c.canInitiateFirstContact, false);
  assert.equal(c.requiresMessagingWindow, true);
});

test('CAPS: uma capacidade não declarada é sempre false', async () => {
  const { normalizarCapacidades, CAPABILITIES } = await import('../providers/instagram/contract.mjs');
  const c = normalizarCapacidades({ canSendMessage: true, inventada: true });
  assert.equal(c.canSendMessage, true);
  assert.equal(c.inventada, undefined, 'uma capacidade inventada entrou no mapa');
  for (const k of CAPABILITIES) assert.equal(typeof c[k], 'boolean');
});

/* ================================================================ *
 * Estados de elegibilidade                                          *
 * ================================================================ */

test('ELEGIBILIDADE: só ELIGIBLE autoriza envio', async () => {
  const { ELIGIBILITY, podeEnviar, ELIGIBILITY_ROTULO } = await import('../providers/instagram/contract.mjs');
  assert.equal(podeEnviar(ELIGIBILITY.ELIGIBLE), true);
  for (const [k, v] of Object.entries(ELIGIBILITY)) {
    if (k === 'ELIGIBLE') continue;
    assert.equal(podeEnviar(v), false, k + ' não devia autorizar envio');
    assert.ok(ELIGIBILITY_ROTULO[k], 'falta rótulo para ' + k);
  }
});

test('ELEGIBILIDADE: perfil encontrado não é o mesmo que poder escrever', async () => {
  const { ELIGIBILITY, podeEnviar } = await import('../providers/instagram/contract.mjs');
  assert.equal(podeEnviar(ELIGIBILITY.PROFILE_FOUND_ONLY), false);
  assert.equal(podeEnviar(ELIGIBILITY.NO_RECIPIENT_ID), false);
});

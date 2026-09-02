/**
 * LeadMap Pro — testes do MetaInstagramProvider (API oficial)
 * ===========================================================
 *   node --test
 *
 * Nenhum destes testes toca em graph.instagram.com: o `fetch` é sempre
 * injetado, e há um teste no fim que instrumenta o global e falha se
 * algo escapar.
 *
 * O que mais se testa aqui é a recusa. A documentação oficial diz, e
 * cito: «Only after an Instagram user has sent your app user's Instagram
 * professional account a message can your app send a message to the
 * Instagram user.» Um produto que encontre `@empresa` numa pesquisa e
 * deixe alguém carregar em «enviar» está a prometer o que a plataforma
 * não permite — e é isso que estes testes existem para impedir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  MetaInstagramProvider, CONNECTION_STATE, META_SCOPES, JANELA_HORAS, PRIVATE_REPLY_DIAS
} from '../providers/instagram/meta.mjs';
import { verificarSubscricao, verificarAssinatura } from '../providers/instagram/meta-webhook-crypto.mjs';
import { ELIGIBILITY, MESSAGE_STATUS } from '../providers/instagram/contract.mjs';

const TOKEN = 'IGAA-token-de-teste-SEGREDO';

function resposta(status, corpo, headers = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k] || headers[k.toLowerCase()] || null },
    json: async () => corpo
  };
}

/** fetch falso que responde por caminho e regista tudo. */
function fetchFalso(rotas, registo = []) {
  return async (url, opcoes = {}) => {
    const u = new URL(String(url));
    registo.push({ host: u.host, caminho: u.pathname, query: Object.fromEntries(u.searchParams),
                   metodo: (opcoes && opcoes.method) || 'GET',
                   corpo: opcoes && opcoes.body ? JSON.parse(opcoes.body) : null,
                   auth: (opcoes && opcoes.headers && opcoes.headers.Authorization) || null });
    for (const [padrao, r] of Object.entries(rotas)) {
      if (u.pathname.includes(padrao)) return typeof r === 'function' ? r(u) : r;
    }
    return resposta(404, { error: { message: 'not found', code: 803 } });
  };
}

const CONTA_OK = { id: '17841400000000000', user_id: '17841400000000000', username: 'aminhaloja',
                   name: 'A Minha Loja', account_type: 'BUSINESS', followers_count: 1234 };

const provider = (rotas, registo, cfg = {}) => new MetaInstagramProvider(
  { accessToken: TOKEN, appSecret: 'app-secret-teste', verifyToken: 'verify-teste', ...cfg },
  { fetch: fetchFalso(rotas, registo) }
);

/* ================================================================ *
 * 1–3 · configuração e token                                        *
 * ================================================================ */

test('META 1: sem token → NOT_CONFIGURED e zero rede', async () => {
  const registo = [];
  const p = new MetaInstagramProvider({}, { fetch: fetchFalso({}, registo) });
  const r = await p.testarLigacao();
  assert.equal(r.estado, CONNECTION_STATE.NOT_CONFIGURED);
  assert.equal(p.estadoLigacao(), CONNECTION_STATE.NOT_CONFIGURED);
  assert.equal(registo.length, 0);
});

test('META 2: token inválido → ERROR, e o token não vem na resposta', async () => {
  const r = await provider({ '/me': resposta(401, { error: { message: 'Invalid OAuth access token', code: 190 } }) })
    .testarLigacao();
  assert.equal(r.estado, CONNECTION_STATE.ERROR);
  assert.equal(JSON.stringify(r).includes(TOKEN), false, 'o token vazou');
});

test('META 3: token válido → CONNECTION_VALIDATED com a conta lida', async () => {
  const registo = [];
  const p = provider({ '/me': resposta(200, CONTA_OK) }, registo);
  const r = await p.testarLigacao();
  assert.equal(r.estado, CONNECTION_STATE.CONNECTION_VALIDATED);
  assert.equal(r.conta.username, 'aminhaloja');
  assert.equal(r.conta.tipo, 'BUSINESS');
  assert.equal(r.profissional, true);
  assert.deepEqual(r.scopes, META_SCOPES);
  /* host e caminho documentados */
  assert.equal(registo[0].host, 'graph.instagram.com');
  assert.match(registo[0].caminho, /^\/v25\.0\/me$/);
  assert.equal(registo[0].auth, 'Bearer ' + TOKEN);
});

/* ================================================================ *
 * 4–5 · conta e permissões                                          *
 * ================================================================ */

test('META 4: conta pessoal não serve — a API de mensagens exige profissional', async () => {
  const p = provider({ '/me': resposta(200, { ...CONTA_OK, account_type: 'PERSONAL' }) });
  const r = await p.testarLigacao();
  assert.equal(r.profissional, false);
  assert.equal(r.estado, CONNECTION_STATE.ERROR);
  assert.match(r.mensagem, /profissional/i);
});

test('META 4b: conta CREATOR é aceite', async () => {
  const r = await provider({ '/me': resposta(200, { ...CONTA_OK, account_type: 'MEDIA_CREATOR' }) }).testarLigacao();
  assert.equal(r.profissional, true);
});

test('META 5: permissão em falta → erro normalizado, sem inventar sucesso', async () => {
  const r = await provider({ '/me': resposta(403, {
    error: { message: 'Application does not have permission for this action', code: 200, type: 'OAuthException' }
  }) }).testarLigacao();
  assert.equal(r.estado, CONNECTION_STATE.ERROR);
  assert.equal(r.conta, null);
});

test('META 6: os scopes declarados são os documentados', () => {
  assert.deepEqual([...META_SCOPES], ['instagram_business_basic', 'instagram_business_manage_messages']);
});

/* ================================================================ *
 * 7–9 · destinatário: o coração da coisa                            *
 * ================================================================ */

test('META 7: um @username NUNCA vira destinatário', async () => {
  const registo = [];
  const p = provider({}, registo);
  const r = await p.resolveRecipient({ username: '@clinica_alfa' });
  assert.equal(r.status, ELIGIBILITY.PROFILE_FOUND_ONLY);
  assert.equal(r.recipientId, null);
  assert.match(r.motivo, /IGSID/);
  assert.equal(registo.length, 0, 'foi à API tentar adivinhar um destinatário');
});

test('META 8: PROFILE_FOUND_ONLY não autoriza envio', async () => {
  const { podeEnviar } = await import('../providers/instagram/contract.mjs');
  const r = await provider({}).resolveRecipient({ username: 'alguem' });
  assert.equal(podeEnviar(r.status), false);
});

test('META 9: sem username e sem IGSID → NO_RECIPIENT_ID', async () => {
  const r = await provider({}).resolveRecipient({});
  assert.equal(r.status, ELIGIBILITY.NO_RECIPIENT_ID);
});

test('META 10: com IGSID e conversa existente → ELIGIBLE', async () => {
  const registo = [];
  const p = provider({ '/me/conversations': resposta(200, { data: [{ id: 'conv-1' }] }) }, registo);
  const r = await p.resolveRecipient({ igsid: '99887766' });
  assert.equal(r.status, ELIGIBILITY.ELIGIBLE);
  assert.equal(r.recipientId, '99887766');
  assert.equal(r.conversationId, 'conv-1');
  assert.equal(registo[0].query.platform, 'instagram');
  assert.equal(registo[0].query.user_id, '99887766');
});

test('META 11: IGSID sem conversa → NOT_ELIGIBLE, com o motivo certo', async () => {
  const p = provider({ '/me/conversations': resposta(200, { data: [] }) });
  const r = await p.resolveRecipient({ igsid: '55443322' });
  assert.equal(r.status, ELIGIBILITY.NOT_ELIGIBLE);
  assert.match(r.motivo, /escreveu primeiro/);
});

test('META 12: canInitiateFirstContact é false — não há DM fria', () => {
  const c = new MetaInstagramProvider({ accessToken: 't' }).capabilities;
  assert.equal(c.canInitiateFirstContact, false);
  assert.equal(c.canLookupByUsername, false);
  assert.equal(c.requiresMessagingWindow, true);
  assert.equal(c.canFetchProfile, false, 'business_discovery não é deste caminho');
});

/* ================================================================ *
 * 13–16 · erros da rede                                             *
 * ================================================================ */

test('META 13: janela de mensagem — a constante é a documentada', () => {
  assert.equal(JANELA_HORAS, 24);
  assert.equal(PRIVATE_REPLY_DIAS, 7);
});

test('META 14: rate limit → RATE_LIMITED', async () => {
  const p = provider({ '/me/conversations': resposta(400, { error: { message: 'rate limit', code: 613 } }) });
  const r = await p.resolveRecipient({ igsid: '1' });
  assert.equal(r.status, ELIGIBILITY.RATE_LIMITED);
});

test('META 15: timeout não rebenta o teste de ligação', async () => {
  const p = new MetaInstagramProvider({ accessToken: TOKEN }, {
    fetch: async () => { const e = new Error('abort'); e.name = 'AbortError'; throw e; }
  });
  const r = await p.testarLigacao();
  assert.equal(r.estado, CONNECTION_STATE.ERROR);
  assert.equal(String(r.mensagem).includes(TOKEN), false);
});

test('META 16: falha de rede → ERROR, nunca sucesso', async () => {
  const p = new MetaInstagramProvider({ accessToken: TOKEN }, {
    fetch: async () => { throw new Error('ECONNREFUSED'); }
  });
  assert.equal((await p.testarLigacao()).estado, CONNECTION_STATE.ERROR);
});

test('META 17: corpo ilegível não vira conta inventada', async () => {
  const p = new MetaInstagramProvider({ accessToken: TOKEN }, {
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => null },
                          json: async () => { throw new Error('json partido'); } })
  });
  const r = await p.testarLigacao();
  assert.equal(r.profissional, false, 'sem corpo legível não há conta profissional');
});

/* ================================================================ *
 * 18–19 · segredos                                                  *
 * ================================================================ */

test('META 18: o token nunca aparece em describe() nem em JSON.stringify', () => {
  const p = new MetaInstagramProvider({ accessToken: TOKEN, appSecret: 's', verifyToken: 'v' });
  const txt = JSON.stringify(p) + JSON.stringify(p.describe());
  for (const seg of [TOKEN, 'app-secret', 'verify-teste']) {
    assert.equal(txt.includes(seg), false, 'fuga: ' + seg);
  }
});

test('META 19: o token não vai no URL — vai no cabeçalho', async () => {
  const registo = [];
  await provider({ '/me': resposta(200, CONTA_OK) }, registo).testarLigacao();
  assert.equal(registo[0].caminho.includes(TOKEN), false);
  assert.equal(JSON.stringify(registo[0].query).includes(TOKEN), false);
  assert.equal(registo[0].auth, 'Bearer ' + TOKEN);
});

/* ================================================================ *
 * 20–22 · webhooks                                                  *
 * ================================================================ */

const CORPO_WEBHOOK = JSON.stringify({
  object: 'instagram',
  entry: [{ id: '17841400000000000', messaging: [
    { sender: { id: '99887766' }, recipient: { id: '17841400000000000' },
      timestamp: 1758000000000, message: { mid: 'mid-1', text: 'olá' } }
  ] }]
});

test('META 20: webhook com assinatura válida é aceite', () => {
  const p = new MetaInstagramProvider({ accessToken: TOKEN, appSecret: 'segredo-app' });
  const assinatura = 'sha256=' + createHmac('sha256', 'segredo-app').update(CORPO_WEBHOOK, 'utf8').digest('hex');
  assert.equal(verificarAssinatura(p, CORPO_WEBHOOK, assinatura), true);
  const eventos = p.parseWebhook(JSON.parse(CORPO_WEBHOOK));
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].from, '99887766', 'é daqui que o IGSID chega');
});

test('META 21: assinatura errada, em falta ou de outro segredo é recusada', () => {
  const p = new MetaInstagramProvider({ accessToken: TOKEN, appSecret: 'segredo-app' });
  const doOutro = 'sha256=' + createHmac('sha256', 'outro-segredo').update(CORPO_WEBHOOK, 'utf8').digest('hex');
  for (const má of [doOutro, 'sha256=abc', '', null, 'sha1=xyz']) {
    assert.throws(() => verificarAssinatura(p, CORPO_WEBHOOK, má), (e) => {
      assert.ok(['INVALID_TOKEN', 'INVALID_REQUEST'].includes(e.errorCode));
      return true;
    }, 'aceitou: ' + String(má));
  }
});

test('META 21b: sem APP_SECRET não se finge que a assinatura está boa', () => {
  const p = new MetaInstagramProvider({ accessToken: TOKEN });
  assert.throws(() => verificarAssinatura(p, CORPO_WEBHOOK, 'sha256=x'), (e) => e.errorCode === 'NOT_CONFIGURED');
});

test('META 22: handshake de subscrição só passa com o verify token certo', () => {
  const p = new MetaInstagramProvider({ accessToken: TOKEN, verifyToken: 'v-certo' });
  assert.equal(verificarSubscricao(p, {
    'hub.mode': 'subscribe', 'hub.verify_token': 'v-certo', 'hub.challenge': '12345' }), '12345');
  for (const q of [
    { 'hub.mode': 'subscribe', 'hub.verify_token': 'v-errado', 'hub.challenge': '1' },
    { 'hub.mode': 'unsubscribe', 'hub.verify_token': 'v-certo', 'hub.challenge': '1' },
    { 'hub.challenge': '1' }
  ]) {
    assert.throws(() => verificarSubscricao(p, q), (e) => e.errorCode === 'INVALID_TOKEN');
  }
});

test('META 22b: o mesmo webhook duas vezes produz os mesmos eventos (idempotente na leitura)', () => {
  const p = new MetaInstagramProvider({ accessToken: TOKEN, appSecret: 's' });
  const a = p.parseWebhook(JSON.parse(CORPO_WEBHOOK));
  const b = p.parseWebhook(JSON.parse(CORPO_WEBHOOK));
  assert.deepEqual(a, b);
  /* a deduplicação de facto é do WebhookEvent, com UNIQUE(provider, event_id) */
});

/* ================================================================ *
 * 23–24 · o fail-safe                                               *
 * ================================================================ */

test('META 23: bloqueado antes da validação — envio não sai', async () => {
  const registo = [];
  const p = provider({ '/messages': resposta(200, { message_id: 'x' }) }, registo);
  const r = await p.sendMessage({
    account: { id: 'a', providerAccountId: '17841400000000000' },
    recipient: { username: 'alguem', providerUserId: '99887766' },
    message: 'olá'
  });
  assert.equal(r.success, false);
  assert.equal(r.errorCode, 'META_PROVIDER_NOT_VALIDATED');
  assert.equal(registo.filter(x => x.caminho.includes('/messages')).length, 0, 'ENVIOU com o adapter bloqueado');
});

test('META 24: CONNECTION_VALIDATED exige um teste real — não basta ter token', async () => {
  const p = provider({ '/me': resposta(200, CONTA_OK) });
  /* só com token: CONFIGURED, e mais nada */
  assert.equal(p.estadoLigacao(), CONNECTION_STATE.CONFIGURED);
  await p.testarLigacao();
  assert.equal(p.estadoLigacao(), CONNECTION_STATE.CONNECTION_VALIDATED);
  /* e mesmo validado continua bloqueado para envio, até opt-in explícito */
  assert.equal(p.isConfigured(), false);
});

test('META 24b: READY_FOR_CONTROLLED_TEST exige validação E opt-in', async () => {
  const semValidar = provider({ '/me': resposta(200, CONTA_OK) }, [], { enabledForRealRequests: true });
  /* opt-in sem teste real não chega a READY */
  assert.equal(semValidar.estadoLigacao(), CONNECTION_STATE.CONFIGURED);
  await semValidar.testarLigacao();
  assert.equal(semValidar.estadoLigacao(), CONNECTION_STATE.READY_FOR_CONTROLLED_TEST);
});

test('META 24c: uma conta não profissional nunca chega a READY', async () => {
  const p = provider({ '/me': resposta(200, { ...CONTA_OK, account_type: 'PERSONAL' }) },
    [], { enabledForRealRequests: true });
  await p.testarLigacao();
  assert.equal(p.estadoLigacao(), CONNECTION_STATE.ERROR);
});

/* ================================================================ *
 * Nenhum pedido real                                                *
 * ================================================================ */

test('META: nenhum teste deste ficheiro toca em graph.instagram.com', async () => {
  const fora = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (u) => { fora.push(String(u)); throw new Error('bloqueado'); };
  try {
    const p = provider({ '/me': resposta(200, CONTA_OK), '/me/conversations': resposta(200, { data: [] }) });
    await p.testarLigacao();
    await p.resolveRecipient({ igsid: '1' });
    await p.resolveRecipient({ username: 'x' });
    await new MetaInstagramProvider({}).testarLigacao();
  } finally { globalThis.fetch = original; }
  assert.deepEqual(fora, [], 'saiu tráfego real: ' + JSON.stringify(fora));
});

test('META: o host é graph.instagram.com, não graph.facebook.com', async () => {
  const { readFileSync } = await import('node:fs');
  const fonte = readFileSync(new URL('../providers/instagram/meta.mjs', import.meta.url), 'utf8');
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(codigo, /graph\.instagram\.com/);
  assert.equal(/graph\.facebook\.com/.test(codigo), false,
    'o código ainda aponta para o caminho do Facebook Login');
});

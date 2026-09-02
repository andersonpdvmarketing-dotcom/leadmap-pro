/**
 * LeadMap Pro — testes do ManyChatInstagramProvider
 * =================================================
 *   node --test
 *
 * O `fetch` é sempre injetado. **Nenhum teste toca em api.manychat.com**
 * e nenhum envia mensagem nenhuma: há um teste no fim que instrumenta o
 * `fetch` global e falha se algum pedido escapar.
 *
 * Os caminhos e limites verificados aqui vieram da spec pública
 * (`/swagger/compileJson?type=Page_API`), não de suposições.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ManyChatInstagramProvider, MANYCHAT_BASE_URL, LIMITES
} from '../providers/instagram/manychat.mjs';
import { ELIGIBILITY, MESSAGE_STATUS, ACCOUNT_STATUS } from '../providers/instagram/contract.mjs';

/* ---------------------------------------------------------------- *
 * Utilitários                                                       *
 * ---------------------------------------------------------------- */

/** Cria um fetch falso que responde por caminho. */
function fetchFalso(rotas, registo = []) {
  return async (url, opcoes = {}) => {
    const u = new URL(url);
    registo.push({ caminho: u.pathname, query: Object.fromEntries(u.searchParams),
                   metodo: opcoes.method || 'GET',
                   corpo: opcoes.body ? JSON.parse(opcoes.body) : null,
                   auth: (opcoes.headers || {}).Authorization || null });
    const r = rotas[u.pathname];
    if (!r) return resposta(404, { status: 'error', message: 'not found' });
    return typeof r === 'function' ? r(u, opcoes) : r;
  };
}

function resposta(status, corpo, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k] || headers[k.toLowerCase()] || null },
    json: async () => corpo
  };
}

const TOKEN = '123456:token-de-teste';
const provider = (rotas, registo) => new ManyChatInstagramProvider({
  apiToken: TOKEN, fetchImpl: fetchFalso(rotas, registo)
});

const PAGINA = { status: 'success', data: { id: 123456, name: 'Marques Produtora', username: 'marques', is_pro: true } };
const SUBSCRIBER = (extra = {}) => ({
  status: 'success',
  data: { id: 987654321, first_name: 'Ana', last_name: 'Silva', name: 'Ana Silva',
          ig_username: 'clinica_alfa', ig_id: 6384638, email: 'ana@exemplo.pt', phone: null, ...extra }
});

/* ================================================================ *
 * Configuração e identidade do provider                             *
 * ================================================================ */

test('MANYCHAT: identidade e capacidades declaradas com honestidade', () => {
  const p = new ManyChatInstagramProvider({});
  assert.equal(p.id, 'manychat');
  assert.equal(p.displayName, 'ManyChat');
  assert.equal(p.capabilities.canSendMessage, true);
  assert.equal(p.capabilities.canCheckEligibility, true);
  /* sendFlow não devolve id de mensagem: não há como consultar entrega */
  assert.equal(p.capabilities.canFetchDeliveryStatus, false);
  assert.equal(p.capabilities.canReadConversations, false);
  assert.equal(p.capabilities.canReceiveWebhooks, false);
});

test('MANYCHAT: sem token está NOT_CONFIGURED e não tenta rede', async () => {
  let tentou = false;
  const p = new ManyChatInstagramProvider({ fetchImpl: async () => { tentou = true; } });
  assert.equal(p.isConfigured(), false);
  const r = await p.testarLigacao();
  assert.equal(r.status, 'NOT_CONFIGURED');
  assert.equal(tentou, false, 'houve pedido sem token configurado');
});

test('MANYCHAT: o token nunca sai em describe() nem em JSON.stringify', () => {
  const p = new ManyChatInstagramProvider({ apiToken: TOKEN });
  const txt = JSON.stringify(p) + JSON.stringify(p.describe());
  assert.equal(txt.includes(TOKEN), false, 'o token vazou');
  assert.equal(txt.includes('token-de-teste'), false);
  assert.equal(txt.includes(MANYCHAT_BASE_URL), false, 'baseUrl exposto');
});

test('MANYCHAT: o token viaja no cabeçalho Authorization, formato Bearer', async () => {
  const reg = [];
  await provider({ '/fb/page/getInfo': resposta(200, PAGINA) }, reg).testarLigacao();
  assert.equal(reg[0].auth, 'Bearer ' + TOKEN);
});

/* ================================================================ *
 * Testar ligação — os estados que o §6 exige                        *
 * ================================================================ */

test('MANYCHAT: ligação boa → CONNECTED com dados da página', async () => {
  const reg = [];
  const r = await provider({ '/fb/page/getInfo': resposta(200, PAGINA) }, reg).testarLigacao();
  assert.equal(r.status, ACCOUNT_STATUS.CONNECTED);
  assert.equal(r.page.id, 123456);
  assert.equal(r.page.name, 'Marques Produtora');
  assert.equal(reg[0].caminho, '/fb/page/getInfo');
});

test('MANYCHAT: 401 → UNAUTHORIZED, e a mensagem não traz o token', async () => {
  const r = await provider({
    '/fb/page/getInfo': resposta(401, { status: 'error', message: 'Wrong token' })
  }).testarLigacao();
  assert.equal(r.status, 'UNAUTHORIZED');
  assert.equal(String(r.message).includes(TOKEN), false);
});

test('MANYCHAT: 429 → RATE_LIMITED; 500 → PROVIDER_ERROR', async () => {
  const a = await provider({ '/fb/page/getInfo': resposta(429, { status: 'error', message: 'Rate limit' }) }).testarLigacao();
  assert.equal(a.status, ACCOUNT_STATUS.RATE_LIMITED);
  const b = await provider({ '/fb/page/getInfo': resposta(500, { status: 'error', message: 'oops' }) }).testarLigacao();
  assert.equal(b.status, 'PROVIDER_ERROR');
});

test('MANYCHAT: timeout e falha de rede não rebentam o teste de ligação', async () => {
  const abort = new ManyChatInstagramProvider({
    apiToken: TOKEN,
    fetchImpl: async () => { const e = new Error('abortado'); e.name = 'AbortError'; throw e; }
  });
  assert.equal((await abort.testarLigacao()).status, 'PROVIDER_ERROR');
  const rede = new ManyChatInstagramProvider({
    apiToken: TOKEN, fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
  });
  assert.equal((await rede.testarLigacao()).status, 'PROVIDER_ERROR');
});

test('MANYCHAT: payload inválido (não-JSON) vira erro tratado', async () => {
  const p = new ManyChatInstagramProvider({
    apiToken: TOKEN,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null },
                              json: async () => { throw new Error('unexpected token'); } })
  });
  const r = await p.testarLigacao();
  /* corpo ilegível com HTTP 200: não há página, e não se inventa uma */
  assert.equal(r.status === ACCOUNT_STATUS.CONNECTED && r.page === null, true);
});

/* ================================================================ *
 * Flows                                                             *
 * ================================================================ */

test('MANYCHAT: listar flows devolve ns e nome, nunca inventados', async () => {
  const reg = [];
  const p = provider({
    '/fb/page/getFlows': resposta(200, { status: 'success', data: { flows: [
      { ns: 'content20240101000000_123456', name: 'Primeiro contacto', folder_id: 7 },
      { ns: 'content20240202000000_654321', name: 'Follow-up', folder_id: null },
      { name: 'Sem namespace' }
    ] } })
  }, reg);
  const flows = await p.listarFlows();
  assert.equal(flows.length, 2, 'um flow sem ns não é utilizável e não deve entrar');
  assert.deepEqual(flows[0], { ns: 'content20240101000000_123456', name: 'Primeiro contacto', folderId: 7 });
  assert.equal(reg[0].caminho, '/fb/page/getFlows');
});

/* ================================================================ *
 * §3 e §12 — identidade do destinatário                             *
 * ================================================================ */

test('MANYCHAT: NÃO há procura por username de Instagram', async () => {
  const p = provider({});
  await assert.rejects(
    () => p.procurarSubscriber({ instagram: 'clinica_alfa' }),
    (e) => e.errorCode === 'NOT_SUPPORTED' && /username de Instagram/i.test(e.message)
  );
});

test('MANYCHAT: procura por email usa findBySystemField', async () => {
  const reg = [];
  const p = provider({ '/fb/subscriber/findBySystemField': resposta(200, { status: 'success', data: [SUBSCRIBER().data] }) }, reg);
  const r = await p.procurarSubscriber({ email: 'ana@exemplo.pt' });
  assert.equal(reg[0].caminho, '/fb/subscriber/findBySystemField');
  assert.deepEqual(reg[0].query, { email: 'ana@exemplo.pt' });
  assert.equal(r[0].subscriberId, '987654321');
  assert.equal(r[0].igUsername, 'clinica_alfa');
});

test('MANYCHAT: procura por campo personalizado usa field_id + field_value', async () => {
  const reg = [];
  const p = provider({ '/fb/subscriber/findByCustomField': resposta(200, { status: 'success', data: [SUBSCRIBER().data] }) }, reg);
  await p.procurarSubscriber({ fieldId: 42, value: 'clinica_alfa' });
  assert.equal(reg[0].caminho, '/fb/subscriber/findByCustomField');
  assert.deepEqual(reg[0].query, { field_id: '42', field_value: 'clinica_alfa' });
});

test('MANYCHAT: confirmar par exige que o ig_username bata certo', async () => {
  const p = provider({ '/fb/subscriber/getInfo': resposta(200, SUBSCRIBER()) });
  const bom = await p.confirmarPar('987654321', '@clinica_alfa');
  assert.equal(bom.confirmado, true);
  assert.equal(bom.subscriber.igUsername, 'clinica_alfa');

  const mau = await p.confirmarPar('987654321', '@outra_clinica');
  assert.equal(mau.confirmado, false);
  assert.match(mau.motivo, /não é o esperado/);
});

test('MANYCHAT: subscriber sem Instagram associado nunca é confirmado', async () => {
  const p = provider({ '/fb/subscriber/getInfo': resposta(200, SUBSCRIBER({ ig_username: null, ig_id: null })) });
  const r = await p.confirmarPar('987654321', 'clinica_alfa');
  assert.equal(r.confirmado, false);
  assert.match(r.motivo, /não tem Instagram associado/);
});

test('MANYCHAT: elegibilidade sem subscriber_id é INELIGIBLE, não UNKNOWN', async () => {
  const p = provider({});
  const r = await p.checkEligibility({}, { username: 'clinica_alfa' });
  assert.equal(r.status, ELIGIBILITY.INELIGIBLE);
  assert.match(r.reason, /não é, por si só, um contacto da ManyChat/);
});

test('MANYCHAT: elegibilidade confirmada pela API', async () => {
  const p = provider({ '/fb/subscriber/getInfo': resposta(200, SUBSCRIBER()) });
  const r = await p.checkEligibility({}, { manychatSubscriberId: '987654321', username: 'clinica_alfa' });
  assert.equal(r.status, ELIGIBILITY.ELIGIBLE);
});

/* ================================================================ *
 * Envio                                                             *
 * ================================================================ */

test('MANYCHAT: sem subscriber_id o envio é recusado com NOT_IN_MANYCHAT', async () => {
  const reg = [];
  const p = provider({}, reg);
  const r = await p.sendMessage({
    account: { id: 'a', providerAccountId: '123456' },
    recipient: { username: 'clinica_alfa' },
    flowNs: 'content20240101000000_123456',
    message: 'olá'
  });
  assert.equal(r.success, false);
  assert.equal(r.errorCode, 'NOT_IN_MANYCHAT');
  assert.equal(r.retryable, false);
  assert.equal(reg.length, 0, 'não pode ter havido pedido nenhum');
});

test('MANYCHAT: sem flow_ns o envio é recusado antes de sair da máquina', async () => {
  const reg = [];
  const r = await provider({}, reg).sendMessage({
    account: { id: 'a', providerAccountId: '123456' },
    recipient: { username: 'clinica_alfa', manychatSubscriberId: '987654321' },
    message: 'olá'
  });
  assert.equal(r.success, false);
  assert.equal(r.errorCode, 'INVALID_REQUEST');
  assert.equal(reg.length, 0);
});

test('MANYCHAT: envio válido chama sendFlow com o corpo exato da spec', async () => {
  const reg = [];
  const p = provider({ '/fb/sending/sendFlow': resposta(200, { status: 'success' }) }, reg);
  const r = await p.sendMessage({
    account: { id: 'a', providerAccountId: '123456' },
    recipient: { username: 'clinica_alfa', manychatSubscriberId: '987654321' },
    flowNs: 'content20240101000000_123456',
    message: 'ignorado — o conteúdo vive na automação'
  });
  assert.equal(r.success, true);
  /* a ManyChat aceitou; o Instagram ainda não entregou nada */
  assert.equal(r.status, MESSAGE_STATUS.QUEUED);
  assert.equal(r.providerMessageId, null, 'a API não devolve id — não se inventa um');
  assert.equal(reg[0].caminho, '/fb/sending/sendFlow');
  assert.equal(reg[0].metodo, 'POST');
  assert.deepEqual(reg[0].corpo, { subscriber_id: 987654321, flow_ns: 'content20240101000000_123456' });
});

/* ================================================================ *
 * §21 — a matriz de erros HTTP                                      *
 * ================================================================ */

/* Sem `message`: no modelo da ManyChat o conteúdo vive na automação. */
const ENVIO = {
  account: { id: 'a', providerAccountId: '123456' },
  recipient: { username: 'clinica_alfa', manychatSubscriberId: '987654321' },
  flowNs: 'content20240101000000_123456'
};

/* [http, corpo, errorCode esperado, o envio teve sucesso?] — só o 200
   tem sucesso; `retryable` é verificado no teste seguinte. */
const CASOS = [
  [200, { status: 'success' },                                 null,                    true],
  [400, { status: 'error', message: 'Invalid flow_ns' },       'INVALID_REQUEST',       false],
  [401, { status: 'error', message: 'Wrong token' },           'INVALID_TOKEN',         false],
  [403, { status: 'error', message: 'Forbidden' },             'INVALID_TOKEN',         false],
  [404, { status: 'error', message: 'Subscriber not found' },  'NOT_IN_MANYCHAT',       false],
  [429, { status: 'error', message: 'Rate limit exceeded' },   'RATE_LIMITED',          false],
  [500, { status: 'error', message: 'Internal error' },        'PROVIDER_UNAVAILABLE',  false],
  [503, { status: 'error', message: 'Service unavailable' },   'PROVIDER_UNAVAILABLE',  false]
];

for (const [http, corpo, codigo, ok] of CASOS) {
  test('MANYCHAT: HTTP ' + http + ' → ' + (codigo || 'sucesso'), async () => {
    const p = provider({ '/fb/sending/sendFlow': resposta(http, corpo) });
    const r = await p.sendMessage(ENVIO);
    assert.equal(r.success, ok);
    if (!ok) {
      assert.equal(r.errorCode, codigo);
      assert.equal(typeof r.errorMessage, 'string');
      assert.equal(r.errorMessage.includes(TOKEN), false, 'o token foi para a mensagem de erro');
    }
  });
}

test('MANYCHAT: erros retryable são os certos', async () => {
  const esperado = { RATE_LIMITED: true, PROVIDER_UNAVAILABLE: true, TIMEOUT: true, NETWORK: true,
                     INVALID_TOKEN: false, NOT_IN_MANYCHAT: false, INVALID_REQUEST: false,
                     OUTSIDE_ALLOWED_WINDOW: false };
  for (const [http, corpo, codigo] of CASOS) {
    if (!codigo) continue;
    const r = await provider({ '/fb/sending/sendFlow': resposta(http, corpo) }).sendMessage(ENVIO);
    assert.equal(r.retryable, esperado[codigo], codigo + ' com retryable errado');
  }
});

test('MANYCHAT: 429 com Retry-After propaga os segundos', async () => {
  const p = provider({
    '/fb/sending/sendFlow': resposta(429, { status: 'error', message: 'Rate limit' }, { 'Retry-After': '90' })
  });
  const r = await p.sendMessage(ENVIO);
  assert.equal(r.errorCode, 'RATE_LIMITED');
  assert.equal(r.retryAfterSec, 90);
});

test('MANYCHAT: timeout e rede viram TIMEOUT/NETWORK, ambos retryable', async () => {
  const t = new ManyChatInstagramProvider({ apiToken: TOKEN,
    fetchImpl: async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; } });
  const a = await t.sendMessage(ENVIO);
  assert.equal(a.errorCode, 'TIMEOUT'); assert.equal(a.retryable, true);

  const n = new ManyChatInstagramProvider({ apiToken: TOKEN,
    fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  const b = await n.sendMessage(ENVIO);
  assert.equal(b.errorCode, 'NETWORK'); assert.equal(b.retryable, true);
});

/* ================================================================ *
 * §17/§18 — janela de mensagem                                      *
 * ================================================================ */

test('MANYCHAT: recusa por janela vira OUTSIDE_ALLOWED_WINDOW e NÃO é retryable', async () => {
  const mensagens = [
    'Cannot send message outside of 24h messaging window',
    'This message is outside the standard messaging window',
    'A message tag is required for this message'
  ];
  for (const m of mensagens) {
    const r = await provider({ '/fb/sending/sendFlow': resposta(400, { status: 'error', message: m }) }).sendMessage(ENVIO);
    assert.equal(r.errorCode, 'OUTSIDE_ALLOWED_WINDOW', 'falhou para: ' + m);
    /* repetir não abre a janela; insistir seria tentar contornar a regra */
    assert.equal(r.retryable, false);
  }
});

test('MANYCHAT: o provider não constrói nada com HUMAN_AGENT nem message_tag', async () => {
  const fonte = (await import('node:fs')).readFileSync(
    new URL('../providers/instagram/manychat.mjs', import.meta.url), 'utf8');
  /* §18: contornar a janela com HUMAN_AGENT seria usar para automação
     uma etiqueta que existe para conversa humana */
  assert.equal(/HUMAN_AGENT/.test(fonte), false, 'o código menciona HUMAN_AGENT');
  assert.equal(/message_tag\s*:/.test(fonte), false, 'o código envia message_tag');
  assert.equal(/otn_topic_name\s*:/.test(fonte), false, 'o código envia otn_topic_name');
});

/* ================================================================ *
 * Limites documentados                                              *
 * ================================================================ */

test('MANYCHAT: os limites são os que a spec documenta', () => {
  assert.equal(LIMITES.sendFlow, 20);
  assert.equal(LIMITES.sendFlowPorSubscriberHora, 100);
  assert.equal(LIMITES.sendContent, 25);
  assert.equal(LIMITES.subscriberInfo, 10);
  assert.equal(LIMITES.findBySystemField, 50);
  assert.equal(LIMITES.pageInfo, 100);
});

/* ================================================================ *
 * Nenhum pedido real                                                *
 * ================================================================ */

test('MANYCHAT: nenhum teste desta suite toca em api.manychat.com', async () => {
  const fora = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (u) => { fora.push(String(u)); throw new Error('bloqueado'); };
  try {
    const p = provider({ '/fb/page/getInfo': resposta(200, PAGINA), '/fb/sending/sendFlow': resposta(200, { status: 'success' }) });
    await p.testarLigacao();
    await p.sendMessage(ENVIO);
    /* e um provider sem fetch injetado também não deve sair sem token */
    await new ManyChatInstagramProvider({}).testarLigacao();
  } finally { globalThis.fetch = original; }
  assert.deepEqual(fora, [], 'saiu tráfego real: ' + JSON.stringify(fora));
});

test('MANYCHAT: o Meta continua bloqueado — este provider não o desbloqueia', async () => {
  const { MetaInstagramProvider } = await import('../providers/instagram/meta.mjs');
  const m = new MetaInstagramProvider({ accessToken: 'x' });
  assert.equal(m.enabledForRealRequests, false);
  const r = await m.sendMessage({
    account: { id: 'a', providerAccountId: '1' },
    recipient: { username: 'u', providerUserId: '2' }, message: 'olá'
  });
  assert.equal(r.errorCode, 'META_PROVIDER_NOT_VALIDATED');
});

/* ================================================================ *
 * A rota /api/outreach/manychat                                     *
 * ================================================================ */

import { despachar } from '../providers/outreach/routes.mjs';
import { criarHashPassword, criarSessao, COOKIE_SESSAO } from '../providers/outreach/auth.mjs';

const ENV_ROTA = () => ({
  OUTREACH_AUTH_SECRET: 'x'.repeat(48),
  OUTREACH_OPERATOR_EMAIL: 'op@example.com',
  OUTREACH_OPERATOR_PASSWORD_HASH: criarHashPassword('password-de-teste-forte'),
  OUTREACH_WORKER_SECRET: 'w'.repeat(40),
  OUTREACH_ENV: 'test',
  MANYCHAT_API_TOKEN: TOKEN
});

/** Chama a rota real com sessão de operador e um fetch global controlado. */
async function chamarRota({ metodo = 'GET', query = {}, corpo = null, rotas = {}, env = ENV_ROTA() }) {
  const registo = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFalso(rotas, registo);

  const anterior = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^OUTREACH|^MANYCHAT|^DATABASE|^SUPABASE/.test(k)) delete process.env[k];
  Object.assign(process.env, env);

  const tok = env.OUTREACH_AUTH_SECRET
    ? criarSessao({ subject: 'op@example.com', roles: ['outreach:operator', 'outreach:admin'] }, env) : null;
  const req = {
    method: metodo,
    url: '/api/outreach/manychat',
    headers: tok ? { cookie: COOKIE_SESSAO + '=' + encodeURIComponent(tok) } : {},
    query: { rota: ['manychat'], ...query },
    body: corpo || {}
  };
  const res = { _s: 0, _b: null, _h: {}, writableEnded: false };
  res.status = s => { res._s = s; return res; };
  res.json = b => { res._b = b; res.writableEnded = true; return res; };
  res.setHeader = (k, v) => { res._h[k] = v; return res; };
  res.end = () => { res.writableEnded = true; return res; };

  const errOriginal = console.error; console.error = () => {};
  try { await despachar(req, res); } finally {
    console.error = errOriginal;
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, anterior);
  }
  return { status: res._s, corpo: res._b || {}, registo };
}

test('ROTA MANYCHAT: action=test devolve o estado, sem token na resposta', async () => {
  delete globalThis.__outreachMemRepo;
  const r = await chamarRota({ query: { action: 'test' }, rotas: { '/fb/page/getInfo': resposta(200, PAGINA) } });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.manychat.status, ACCOUNT_STATUS.CONNECTED);
  assert.equal(r.corpo.manychat.page.name, 'Marques Produtora');
  assert.equal(JSON.stringify(r.corpo).includes(TOKEN), false, 'o token foi para a resposta');
});

test('ROTA MANYCHAT: sem token configurado devolve NOT_CONFIGURED sem tocar na rede', async () => {
  delete globalThis.__outreachMemRepo;
  const env = ENV_ROTA(); delete env.MANYCHAT_API_TOKEN;
  const r = await chamarRota({ query: { action: 'test' }, env, rotas: {} });
  assert.equal(r.corpo.manychat.status, 'NOT_CONFIGURED');
  assert.equal(r.registo.length, 0);
});

test('ROTA MANYCHAT: action=flows lista as automações reais', async () => {
  delete globalThis.__outreachMemRepo;
  const r = await chamarRota({
    query: { action: 'flows' },
    rotas: { '/fb/page/getFlows': resposta(200, { status: 'success', data: { flows: [
      { ns: 'content20240101000000_1', name: 'Primeiro contacto', folder_id: null }] } }) }
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo.flows, [{ ns: 'content20240101000000_1', name: 'Primeiro contacto', folderId: null }]);
});

test('ROTA MANYCHAT: procurar por @instagram é recusado explicitamente', async () => {
  delete globalThis.__outreachMemRepo;
  const r = await chamarRota({ query: { action: 'lookup', instagram: 'clinica_alfa' }, rotas: {} });
  assert.equal(r.corpo.success, false);
  assert.equal(r.corpo.errorCode, 'NOT_SUPPORTED');
  assert.match(r.corpo.message, /username de Instagram/i);
  assert.equal(r.registo.length, 0, 'não pode ter havido chamada à ManyChat');
});

test('ROTA MANYCHAT: envio de teste sem confirmação é recusado e não chama a API', async () => {
  delete globalThis.__outreachMemRepo;
  const r = await chamarRota({
    metodo: 'POST', query: { action: 'send-test' },
    corpo: { subscriberId: '987654321', flowNs: 'ns1' },
    rotas: { '/fb/sending/sendFlow': resposta(200, { status: 'success' }) }
  });
  assert.equal(r.corpo.success, false);
  assert.equal(r.corpo.errorCode, 'NOT_CONFIRMED');
  assert.equal(r.registo.filter(x => x.caminho === '/fb/sending/sendFlow').length, 0);
});

test('ROTA MANYCHAT: envio de teste com Instagram que não bate certo é bloqueado', async () => {
  delete globalThis.__outreachMemRepo;
  const r = await chamarRota({
    metodo: 'POST', query: { action: 'send-test' },
    corpo: { subscriberId: '987654321', flowNs: 'ns1', instagram: 'outra_clinica', confirmado: true },
    rotas: {
      '/fb/subscriber/getInfo': resposta(200, SUBSCRIBER()),
      '/fb/sending/sendFlow': resposta(200, { status: 'success' })
    }
  });
  assert.equal(r.corpo.success, false);
  assert.equal(r.corpo.errorCode, 'RECIPIENT_UNAVAILABLE');
  assert.equal(r.registo.filter(x => x.caminho === '/fb/sending/sendFlow').length, 0,
    'enviou para um subscriber que não corresponde ao Instagram pedido');
});

test('ROTA MANYCHAT: envio de teste confirmado e verificado chega ao sendFlow', async () => {
  delete globalThis.__outreachMemRepo;
  const r = await chamarRota({
    metodo: 'POST', query: { action: 'send-test' },
    corpo: { subscriberId: '987654321', flowNs: 'content20240101000000_1', instagram: 'clinica_alfa', confirmado: true },
    rotas: {
      '/fb/subscriber/getInfo': resposta(200, SUBSCRIBER()),
      '/fb/sending/sendFlow': resposta(200, { status: 'success' })
    }
  });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.envio.success, true);
  assert.equal(r.corpo.envio.status, MESSAGE_STATUS.QUEUED);
  assert.equal(r.corpo.subscriber.igUsername, 'clinica_alfa');
  const envio = r.registo.find(x => x.caminho === '/fb/sending/sendFlow');
  assert.deepEqual(envio.corpo, { subscriber_id: 987654321, flow_ns: 'content20240101000000_1' });
});

test('ROTA MANYCHAT: sem sessão devolve 401 e não fala com a ManyChat', async () => {
  delete globalThis.__outreachMemRepo;
  const registo = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFalso({}, registo);
  const anterior = { ...process.env };
  Object.assign(process.env, ENV_ROTA());
  const res = { _s: 0, _b: null, _h: {} };
  res.status = s => { res._s = s; return res; };
  res.json = b => { res._b = b; res.writableEnded = true; return res; };
  res.setHeader = () => res;
  const errOriginal = console.error; console.error = () => {};
  try {
    await despachar({ method: 'GET', url: '/api/outreach/manychat', headers: {},
                      query: { rota: ['manychat'], action: 'test' }, body: {} }, res);
  } finally {
    console.error = errOriginal; globalThis.fetch = originalFetch;
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, anterior);
  }
  assert.equal(res._s, 401);
  assert.equal(registo.length, 0);
});

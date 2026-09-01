/**
 * LeadMap Pro — testes do router de Outreach
 * ==========================================
 *   node --test
 *
 * Os oito endpoints passaram a ser servidos por uma única Serverless
 * Function (`api/outreach/[...rota].js`). Consolidar rotas é
 * exatamente o tipo de mudança que perde uma proteção sem ninguém dar
 * por isso, por isso estes testes verificam, endpoint a endpoint:
 * método certo, método errado, rota desconhecida, sessão, papel de
 * administração, segredo do worker e ausência de configuração.
 *
 * Nada aqui toca na rede nem numa base de dados.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ROTAS, nomeDaRota, despachar } from '../providers/outreach/routes.mjs';
import { criarHashPassword, criarSessao, COOKIE_SESSAO } from '../providers/outreach/auth.mjs';

/* ---------------------------------------------------------------- *
 * Utilitários                                                       *
 * ---------------------------------------------------------------- */

const NOMES = ['session', 'contacts', 'templates', 'accounts', 'campaigns', 'queue', 'audit', 'worker'];

function fingirRes() {
  const r = { _status: 0, _body: null, _headers: {}, writableEnded: false };
  r.status = (s) => { r._status = s; return r; };
  r.json = (b) => { r._body = b; r.writableEnded = true; return r; };
  r.setHeader = (k, v) => { r._headers[k] = v; return r; };
  r.end = () => { r.writableEnded = true; return r; };
  return r;
}

/** Pedido como a Vercel o entrega ao catch-all: segmentos em query.rota. */
function pedido(nome, metodo = 'GET', extra = {}) {
  return {
    method: metodo,
    url: '/api/outreach/' + nome,
    /* a sessão viaja no cabeçalho Cookie, que é onde `lerCookie()` a
       procura — não num objeto `req.cookies` */
    headers: { ...(extra.headers || {}), ...(extra.cookie ? { cookie: extra.cookie } : {}) },
    query: { rota: [nome], ...(extra.query || {}) },
    body: extra.body || {}
  };
}

const ENV_AUTH = () => ({
  OUTREACH_AUTH_SECRET: 'x'.repeat(48),
  OUTREACH_OPERATOR_EMAIL: 'op@example.com',
  OUTREACH_OPERATOR_PASSWORD_HASH: criarHashPassword('password-de-teste-forte'),
  OUTREACH_WORKER_SECRET: 'w'.repeat(40),
  OUTREACH_ENV: 'production'
});

/**
 * As rotas leem `process.env` directamente. Aplicar o ambiente do teste
 * e repor sempre o original, mesmo quando a asserção falha.
 */
async function comEnv(env, fn) {
  const original = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (/^OUTREACH|^SUPABASE|^POSTGRES|^DATABASE/.test(k)) delete process.env[k];
  }
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, original);
  }
}

/** Despacha e devolve { status, corpo }. */
async function chamar(req) {
  const res = fingirRes();
  await despachar(req, res);
  return { status: res._status, corpo: res._body || {}, headers: res._headers };
}

/** Valor pronto para o cabeçalho `Cookie:`. */
function cookieSessao(papeis, env) {
  const tok = criarSessao({ subject: 'op@example.com', roles: papeis }, env);
  return COOKIE_SESSAO + '=' + encodeURIComponent(tok);
}

/* ---------------------------------------------------------------- *
 * Resolução de rotas                                                *
 * ---------------------------------------------------------------- */

test('ROUTER: os oito endpoints continuam a existir', () => {
  assert.deepEqual(Object.keys(ROTAS).sort(), [...NOMES].sort());
  for (const n of NOMES) assert.equal(typeof ROTAS[n], 'function', n + ' não é um handler');
});

test('ROUTER: nome da rota vem dos segmentos da Vercel', () => {
  assert.equal(nomeDaRota({ query: { rota: ['session'] }, url: '/api/outreach/session' }), 'session');
  assert.equal(nomeDaRota({ query: { rota: 'queue' }, url: '/api/outreach/queue' }), 'queue');
});

test('ROUTER: nome da rota também se deduz do URL (proxies)', () => {
  assert.equal(nomeDaRota({ url: '/api/outreach/contacts' }), 'contacts');
  assert.equal(nomeDaRota({ url: '/api/outreach/campaigns?id=c1&action=start' }), 'campaigns');
  assert.equal(nomeDaRota({ url: '/api/outreach/audit/' }), 'audit');
  assert.equal(nomeDaRota({ url: '/api/outreach' }), '');
  assert.equal(nomeDaRota({}), '');
});

test('ROUTER: rota desconhecida → 404 no formato normal de erro', async () => {
  await comEnv(ENV_AUTH(), async () => {
    for (const nome of ['inexistente', 'contacts/extra', '', 'constructor', '__proto__', 'toString']) {
      const r = await chamar(pedido(nome));
      assert.equal(r.status, 404, 'rota "' + nome + '" devia dar 404');
      assert.equal(r.corpo.errorCode, 'NOT_FOUND');
      assert.equal(r.corpo.success, false);
      assert.ok(r.corpo.requestId, 'falta requestId');
    }
  });
});

/* ---------------------------------------------------------------- *
 * Métodos                                                           *
 * ---------------------------------------------------------------- */

test('ROUTER: método errado → 405 em cada endpoint', async () => {
  await comEnv(ENV_AUTH(), async () => {
    const errados = {
      session: 'PATCH', contacts: 'DELETE', templates: 'PUT', accounts: 'DELETE',
      campaigns: 'DELETE', queue: 'POST', audit: 'POST', worker: 'GET'
    };
    for (const [nome, metodo] of Object.entries(errados)) {
      const r = await chamar(pedido(nome, metodo));
      assert.equal(r.status, 405, nome + ' ' + metodo + ' devia dar 405, deu ' + r.status);
      assert.equal(r.corpo.errorCode, 'METHOD_NOT_ALLOWED');
    }
  });
});

test('ROUTER: 405 vem antes da autenticação — não revela nada', async () => {
  /* sem qualquer configuração, um método inválido continua a ser 405 */
  await comEnv({ OUTREACH_ENV: 'production' }, async () => {
    const r = await chamar(pedido('contacts', 'DELETE'));
    assert.equal(r.status, 405);
  });
});

/* ---------------------------------------------------------------- *
 * Autenticação e autorização                                        *
 * ---------------------------------------------------------------- */

test('ROUTER: sem sessão → 401 nas rotas protegidas', async () => {
  await comEnv(ENV_AUTH(), async () => {
    for (const nome of ['contacts', 'templates', 'accounts', 'campaigns', 'queue', 'audit']) {
      const r = await chamar(pedido(nome));
      assert.equal(r.status, 401, nome + ' sem sessão devia dar 401, deu ' + r.status);
      assert.equal(r.corpo.errorCode, 'UNAUTHENTICATED');
    }
  });
});

test('ROUTER: sessão de operador não abre a auditoria → 403', async () => {
  const env = ENV_AUTH();
  await comEnv(env, async () => {
    const cookie = cookieSessao(['outreach:operator'], env);
    const r = await chamar(pedido('audit', 'GET', { cookie }));
    assert.equal(r.status, 403);
    assert.equal(r.corpo.errorCode, 'FORBIDDEN');
  });
});

test('ROUTER: sessão de administração passa o papel e para na base de dados', async () => {
  const env = ENV_AUTH();
  await comEnv(env, async () => {
    const cookie = cookieSessao(['outreach:operator', 'outreach:admin'], env);
    const r = await chamar(pedido('audit', 'GET', { cookie }));
    /* o papel foi aceite; o que falta agora é a base de dados */
    assert.equal(r.status, 503);
    assert.equal(r.corpo.errorCode, 'NOT_CONFIGURED');
  });
});

test('ROUTER: sessão válida chega à base de dados nas rotas de operador', async () => {
  const env = ENV_AUTH();
  await comEnv(env, async () => {
    const cookie = cookieSessao(['outreach:operator'], env);
    for (const nome of ['contacts', 'templates', 'accounts', 'campaigns', 'queue']) {
      const r = await chamar(pedido(nome, 'GET', { cookie }));
      assert.equal(r.status, 503, nome + ' devia parar em 503, deu ' + r.status);
      assert.equal(r.corpo.errorCode, 'NOT_CONFIGURED');
    }
  });
});

/* ---------------------------------------------------------------- *
 * Worker                                                            *
 * ---------------------------------------------------------------- */

test('ROUTER: worker sem segredo → 401', async () => {
  await comEnv(ENV_AUTH(), async () => {
    const r = await chamar(pedido('worker', 'POST'));
    assert.equal(r.status, 401);
    assert.equal(r.corpo.errorCode, 'UNAUTHENTICATED');
  });
});

test('ROUTER: worker com segredo errado → 401', async () => {
  await comEnv(ENV_AUTH(), async () => {
    const r = await chamar(pedido('worker', 'POST', { headers: { 'x-outreach-worker-secret': 'z'.repeat(40) } }));
    assert.equal(r.status, 401);
  });
});

test('ROUTER: sessão de utilizador NÃO substitui o segredo do worker', async () => {
  const env = ENV_AUTH();
  await comEnv(env, async () => {
    const cookie = cookieSessao(['outreach:operator', 'outreach:admin'], env);
    const r = await chamar(pedido('worker', 'POST', { cookie }));
    assert.equal(r.status, 401, 'uma sessão de admin não pode abrir o worker');
  });
});

test('ROUTER: worker com o segredo certo passa a auth e para na base de dados', async () => {
  const env = ENV_AUTH();
  await comEnv(env, async () => {
    const r = await chamar(pedido('worker', 'POST', { headers: { 'x-outreach-worker-secret': env.OUTREACH_WORKER_SECRET } }));
    assert.equal(r.status, 503);
    assert.equal(r.corpo.errorCode, 'NOT_CONFIGURED');
  });
});

test('ROUTER: worker em produção recusa-se a usar o fornecedor de teste', async () => {
  /* com base de dados "configurada" o worker chega ao fornecedor — e em
     produção não há nenhum aprovado, por isso não processa a fila */
  const env = { ...ENV_AUTH(), OUTREACH_DB_URL: 'https://exemplo.invalid', OUTREACH_DB_SERVICE_KEY: 'k'.repeat(20) };
  await comEnv(env, async () => {
    const r = await chamar(pedido('worker', 'POST', { headers: { 'x-outreach-worker-secret': env.OUTREACH_WORKER_SECRET } }));
    assert.equal(r.status, 503);
    assert.equal(r.corpo.errorCode, 'PROVIDER_NOT_AVAILABLE');
  });
});

/* ---------------------------------------------------------------- *
 * Sem configuração nenhuma                                          *
 * ---------------------------------------------------------------- */

test('ROUTER: sem auth configurada → 503 NOT_CONFIGURED', async () => {
  await comEnv({ OUTREACH_ENV: 'production' }, async () => {
    for (const nome of ['contacts', 'templates', 'accounts', 'campaigns', 'queue', 'audit']) {
      const r = await chamar(pedido(nome));
      assert.equal(r.status, 503, nome + ' devia dar 503, deu ' + r.status);
      assert.equal(r.corpo.errorCode, 'NOT_CONFIGURED');
    }
    const w = await chamar(pedido('worker', 'POST'));
    assert.equal(w.status, 503);
    assert.equal(w.corpo.errorCode, 'NOT_CONFIGURED');
  });
});

test('ROUTER: GET /session é a sonda pública e não rebenta sem configuração', async () => {
  await comEnv({ OUTREACH_ENV: 'production' }, async () => {
    const r = await chamar(pedido('session', 'GET'));
    assert.equal(r.status, 200);
    assert.equal(r.corpo.success, true);
    assert.equal(r.corpo.authenticated, false);
    assert.equal(r.corpo.configured, false);
    /* a sonda não pode revelar nada além do estado */
    for (const k of Object.keys(r.corpo)) {
      assert.ok(['success', 'authenticated', 'configured', 'requestId'].includes(k), 'campo inesperado: ' + k);
    }
  });
});

test('ROUTER: POST /session sem configuração → 503, nunca 500', async () => {
  await comEnv({ OUTREACH_ENV: 'production' }, async () => {
    const r = await chamar(pedido('session', 'POST', { body: { email: 'a@b.c', password: 'x' } }));
    assert.equal(r.status, 503);
    assert.equal(r.corpo.errorCode, 'NOT_CONFIGURED');
  });
});

test('ROUTER: login correto devolve cookie HttpOnly, Secure, SameSite=Strict', async () => {
  await comEnv(ENV_AUTH(), async () => {
    const r = await chamar(pedido('session', 'POST', {
      body: { email: 'op@example.com', password: 'password-de-teste-forte' }
    }));
    assert.equal(r.status, 200);
    const cookie = r.headers['Set-Cookie'];
    assert.ok(cookie.includes('HttpOnly'), 'cookie sem HttpOnly');
    assert.ok(cookie.includes('Secure'), 'cookie sem Secure em produção');
    assert.ok(cookie.includes('SameSite=Strict'), 'cookie sem SameSite=Strict');
    assert.equal(cookie.includes('password-de-teste-forte'), false, 'a password foi para o cookie');
  });
});

test('ROUTER: credenciais erradas → 401 e sem cookie', async () => {
  await comEnv(ENV_AUTH(), async () => {
    const r = await chamar(pedido('session', 'POST', {
      body: { email: 'op@example.com', password: 'errada' }
    }));
    assert.equal(r.status, 401);
    assert.equal(r.headers['Set-Cookie'], undefined);
  });
});

/* ---------------------------------------------------------------- *
 * Nenhuma resposta pode escapar do formato                          *
 * ---------------------------------------------------------------- */

test('ROUTER: nenhum endpoint devolve 500 nem stack trace sem configuração', async () => {
  await comEnv({ OUTREACH_ENV: 'production' }, async () => {
    const metodos = { session: ['GET', 'POST', 'DELETE'], contacts: ['GET', 'POST'], templates: ['GET', 'POST', 'PATCH', 'DELETE'],
      accounts: ['GET', 'POST'], campaigns: ['GET', 'POST'], queue: ['GET'], audit: ['GET'], worker: ['POST'] };
    for (const [nome, ms] of Object.entries(metodos)) {
      for (const m of ms) {
        const r = await chamar(pedido(nome, m));
        assert.notEqual(r.status, 500, nome + ' ' + m + ' devolveu 500');
        assert.equal(Object.prototype.hasOwnProperty.call(r.corpo, 'stack'), false, nome + ' ' + m + ' vazou stack');
        assert.ok([200, 401, 403, 404, 405, 503].includes(r.status), nome + ' ' + m + ' → ' + r.status);
      }
    }
  });
});

test('ROUTER: sem configuração nenhum endpoint tenta ligar-se a nada', async () => {
  const original = globalThis.fetch;
  const tentativas = [];
  globalThis.fetch = async (u) => { tentativas.push(String(u)); throw new Error('rede bloqueada'); };
  try {
    await comEnv({ OUTREACH_ENV: 'production' }, async () => {
      for (const nome of NOMES) await chamar(pedido(nome, nome === 'worker' ? 'POST' : 'GET'));
    });
  } finally { globalThis.fetch = original; }
  assert.deepEqual(tentativas, [], 'houve pedidos de rede: ' + JSON.stringify(tentativas));
});

/**
 * LeadMap Pro — testes da área de Configurações → Integrações
 * ===========================================================
 *   node --test
 *
 * O que se testa aqui é sobretudo o que a API **não** devolve. Uma
 * página de configurações é o sítio mais tentador para mostrar "o token
 * começa por sk-…" — e um prefixo de token é um token parcialmente
 * vazado. Por isso os testes procuram os valores reais nas respostas e
 * falham se algum aparecer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { despachar, INTEGRACOES } from '../providers/outreach/routes.mjs';
import { criarHashPassword, criarSessao, COOKIE_SESSAO } from '../providers/outreach/auth.mjs';

/* ---------------------------------------------------------------- *
 * Valores-sentinela: se algum destes sair numa resposta, é fuga.     *
 * ---------------------------------------------------------------- */

const SEGREDOS = {
  MANYCHAT_API_TOKEN: '123456:mc-SEGREDO-abcdef',
  INSTAGRAM_META_ACCESS_TOKEN: 'IGAA-META-SEGREDO-xyz',
  INSTAGRAM_EXTERNAL_BASE_URL: 'https://fornecedor-SEGREDO.example',
  INSTAGRAM_EXTERNAL_API_KEY: 'ext-SEGREDO-key',
  GOOGLE_PLACES_API_KEY: 'AIza-PLACES-SEGREDO-123',
  GOOGLE_MAPS_API_KEY: 'AIza-MAPS-SEGREDO-456',
  OUTREACH_DB_URL: 'https://projeto-SEGREDO.supabase.co',
  OUTREACH_DB_SERVICE_KEY: 'eyJ-SERVICE-ROLE-SEGREDO',
  OUTREACH_AUTH_SECRET: 'A'.repeat(48),
  OUTREACH_OPERATOR_EMAIL: 'op@example.com',
  OUTREACH_OPERATOR_PASSWORD_HASH: criarHashPassword('password-de-teste-forte'),
  OUTREACH_WORKER_SECRET: 'W'.repeat(40),
  OUTREACH_ENV: 'test'
};

/** Tudo o que nunca pode aparecer numa resposta. */
const PROIBIDOS = [
  SEGREDOS.MANYCHAT_API_TOKEN, 'mc-SEGREDO-abcdef',
  SEGREDOS.GOOGLE_PLACES_API_KEY, SEGREDOS.GOOGLE_MAPS_API_KEY,
  SEGREDOS.OUTREACH_DB_URL, SEGREDOS.OUTREACH_DB_SERVICE_KEY,
  SEGREDOS.OUTREACH_AUTH_SECRET, SEGREDOS.OUTREACH_WORKER_SECRET,
  SEGREDOS.INSTAGRAM_META_ACCESS_TOKEN, SEGREDOS.INSTAGRAM_EXTERNAL_API_KEY,
  SEGREDOS.INSTAGRAM_EXTERNAL_BASE_URL,
  SEGREDOS.OUTREACH_OPERATOR_PASSWORD_HASH, 'scrypt$'
];

async function chamar(nome, { env = SEGREDOS, autenticado = false, metodo = 'GET', query = {}, fetchFalso = null } = {}) {
  const anterior = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^OUTREACH|^MANYCHAT|^GOOGLE|^DATABASE|^SUPABASE/.test(k)) delete process.env[k];
  Object.assign(process.env, env);

  const originalFetch = globalThis.fetch;
  if (fetchFalso) globalThis.fetch = fetchFalso;

  const cookie = autenticado && env.OUTREACH_AUTH_SECRET
    ? COOKIE_SESSAO + '=' + encodeURIComponent(
        criarSessao({ subject: 'op@example.com', roles: ['outreach:operator', 'outreach:admin'] }, env))
    : '';
  const req = { method: metodo, url: '/api/outreach/' + nome, headers: cookie ? { cookie } : {},
                query: { rota: [nome], ...query }, body: {} };
  const res = { _s: 0, _b: null, _h: {} };
  res.status = s => { res._s = s; return res; };
  res.json = b => { res._b = b; res.writableEnded = true; return res; };
  res.setHeader = (k, v) => { res._h[k] = v; return res; };
  res.end = () => { res.writableEnded = true; return res; };

  const errOriginal = console.error; const logs = []; console.error = (...a) => logs.push(a.join(' '));
  try { await despachar(req, res); } finally {
    console.error = errOriginal;
    if (fetchFalso) globalThis.fetch = originalFetch;
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, anterior);
  }
  return { status: res._s, corpo: res._b || {}, headers: res._h, logs };
}

const semSegredos = (obj, onde) => {
  const txt = JSON.stringify(obj);
  for (const v of PROIBIDOS) {
    assert.equal(txt.includes(v), false, 'fuga em ' + onde + ': ' + v.slice(0, 16));
  }
};

/* ================================================================ *
 * Estado das integrações                                            *
 * ================================================================ */

test('CONFIG: lista só integrações que existem mesmo neste projeto', async () => {
  const r = await chamar('integrations');
  assert.equal(r.status, 200);
  const ids = r.corpo.integracoes.map(i => i.id);
  assert.deepEqual(ids.sort(), [
    'enrich-email', 'enrich-social', 'external', 'google-maps', 'google-places',
    'manychat', 'meta', 'outreach-auth', 'outreach-db'
  ].sort());
});

test('CONFIG: com tudo configurado, tudo aparece configurado — e sem valores', async () => {
  const r = await chamar('integrations');
  for (const i of r.corpo.integracoes) {
    assert.equal(i.configurada, true, i.id + ' devia estar configurada');
    assert.deepEqual(i.emFalta, [], i.id + ' não devia ter variáveis em falta');
  }
  semSegredos(r.corpo, 'integrations');
});

test('CONFIG: sem nenhuma env, responde 200 e diz o que falta', async () => {
  const r = await chamar('integrations', { env: {} });
  assert.equal(r.status, 200, 'nunca pode ser 500');
  const porId = Object.fromEntries(r.corpo.integracoes.map(i => [i.id, i]));
  assert.equal(porId['manychat'].configurada, false);
  assert.deepEqual(porId['manychat'].emFalta, ['MANYCHAT_API_TOKEN']);
  assert.equal(porId['google-places'].configurada, false);
  assert.equal(porId['outreach-db'].configurada, false);
  assert.deepEqual(porId['outreach-db'].emFalta, ['OUTREACH_DB_URL', 'OUTREACH_DB_SERVICE_KEY']);
});

test('CONFIG: integrações sem chave nunca aparecem como "não configuradas"', async () => {
  const r = await chamar('integrations', { env: {} });
  for (const id of ['enrich-email', 'enrich-social']) {
    const i = r.corpo.integracoes.find(x => x.id === id);
    assert.equal(i.semChave, true);
    assert.equal(i.configurada, true, id + ' usa fontes públicas: não há nada para configurar');
    assert.deepEqual(i.variaveis, []);
  }
});

test('CONFIG: configuração parcial mostra exatamente a variável que falta', async () => {
  const r = await chamar('integrations', { env: { OUTREACH_DB_URL: 'https://x.supabase.co' } });
  const db = r.corpo.integracoes.find(i => i.id === 'outreach-db');
  assert.equal(db.configurada, false);
  assert.deepEqual(db.emFalta, ['OUTREACH_DB_SERVICE_KEY']);
  semSegredos(r.corpo, 'parcial');
});

test('CONFIG: só devolve nomes de variáveis, nunca valores', async () => {
  const r = await chamar('integrations');
  const nomes = new Set(r.corpo.integracoes.flatMap(i => i.variaveis));
  for (const n of nomes) assert.equal(typeof n, 'string');
  /* e nenhum campo do corpo é o VALOR de uma variável */
  semSegredos(r.corpo, 'nomes');
  assert.equal(JSON.stringify(r.corpo).includes('Bearer'), false);
});

test('CONFIG: método errado → 405, nunca 500', async () => {
  const r = await chamar('integrations', { metodo: 'POST' });
  assert.equal(r.status, 405);
  assert.equal(r.corpo.errorCode, 'METHOD_NOT_ALLOWED');
});

test('CONFIG: a resposta não é cacheável', async () => {
  const r = await chamar('integrations');
  assert.match(String(r.headers['Cache-Control']), /no-store/);
});

/* ================================================================ *
 * ManyChat visto pelas Configurações                                *
 * ================================================================ */

const respMc = (status, corpo) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => null }, json: async () => corpo
});

test('CONFIG: ManyChat sem token → NOT_CONFIGURED, sem tocar na rede', async () => {
  let saiu = false;
  const env = { ...SEGREDOS }; delete env.MANYCHAT_API_TOKEN;
  const r = await chamar('manychat', { env, autenticado: true, query: { action: 'test' },
    fetchFalso: async () => { saiu = true; return respMc(200, {}); } });
  assert.equal(r.corpo.manychat.status, 'NOT_CONFIGURED');
  assert.equal(saiu, false);
  semSegredos(r.corpo, 'manychat sem token');
});

test('CONFIG: ManyChat com token inválido → UNAUTHORIZED e o token não vem na resposta', async () => {
  const r = await chamar('manychat', { autenticado: true, query: { action: 'test' },
    fetchFalso: async () => respMc(401, { status: 'error', message: 'Wrong token' }) });
  assert.equal(r.corpo.manychat.status, 'UNAUTHORIZED');
  semSegredos(r.corpo, 'manychat 401');
  semSegredos(r.logs, 'logs do 401');
});

test('CONFIG: ManyChat conectado devolve a página, nunca o token', async () => {
  const r = await chamar('manychat', { autenticado: true, query: { action: 'test' },
    fetchFalso: async () => respMc(200, { status: 'success', data: { id: 123456, name: 'Marques Produtora', is_pro: true } }) });
  assert.equal(r.corpo.manychat.status, 'CONNECTED');
  assert.equal(r.corpo.manychat.page.name, 'Marques Produtora');
  semSegredos(r.corpo, 'manychat conectado');
});

test('CONFIG: testar a ManyChat exige sessão — não é uma sonda pública', async () => {
  let saiu = false;
  const r = await chamar('manychat', { autenticado: false, query: { action: 'test' },
    fetchFalso: async () => { saiu = true; return respMc(200, {}); } });
  assert.equal(r.status, 401);
  assert.equal(saiu, false, 'gastou quota da ManyChat sem sessão');
});

/* ================================================================ *
 * Base de dados                                                     *
 * ================================================================ */

test('CONFIG: sonda da base exige sessão', async () => {
  const r = await chamar('db-probe', { autenticado: false });
  assert.equal(r.status, 401);
});

test('CONFIG: base não configurada em produção → 503, nunca 500', async () => {
  const env = { ...SEGREDOS, OUTREACH_ENV: 'production' };
  delete env.OUTREACH_DB_URL; delete env.OUTREACH_DB_SERVICE_KEY;
  let saiu = false;
  const r = await chamar('db-probe', { env, autenticado: true,
    fetchFalso: async () => { saiu = true; throw new Error('não devia sair'); } });
  assert.equal(r.status, 503);
  assert.equal(r.corpo.errorCode, 'NOT_CONFIGURED');
  assert.equal(saiu, false, 'tentou ligar-se a uma base que não está configurada');
  semSegredos(r.corpo, 'db-probe 503');
});

test('CONFIG: base configurada mas em baixo → disponivel:false, sem expor a URL', async () => {
  const r = await chamar('db-probe', { autenticado: true,
    fetchFalso: async () => { throw new Error('ECONNREFUSED projeto-SEGREDO.supabase.co'); } });
  assert.equal(r.status, 200, 'uma base em baixo não é um erro do LeadMap');
  assert.equal(r.corpo.base.configurada, true);
  assert.equal(r.corpo.base.disponivel, false);
  /* o erro é um código do domínio, não a mensagem do fornecedor —
     que traria o host da base para dentro da resposta */
  semSegredos(r.corpo, 'db-probe em baixo');
});

test('CONFIG: base configurada e a responder → disponivel:true', async () => {
  const r = await chamar('db-probe', { autenticado: true,
    fetchFalso: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => [] }) });
  assert.equal(r.corpo.base.disponivel, true);
  semSegredos(r.corpo, 'db-probe ok');
});

/* ================================================================ *
 * O frontend                                                        *
 * ================================================================ */

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('FRONTEND: não há campo para escrever segredos na página', () => {
  const modal = HTML.slice(HTML.indexOf('id="modalConfig"'), HTML.indexOf('id="modalConfig"') + 2200);
  assert.equal(/type="password"/.test(modal), false, 'há um campo de password nas Configurações');
  assert.equal(/<input/.test(modal), false, 'as Configurações não devem ter campos de entrada');
});

test('FRONTEND: as Configurações nunca escrevem em localStorage nem IndexedDB', () => {
  const i = HTML.indexOf('CONFIGURAÇÕES → INTEGRAÇÕES');
  assert.ok(i > 0, 'bloco de configurações não encontrado');
  const bloco = HTML.slice(i, HTML.indexOf('let confirmResolve', i));
  assert.equal(/localStorage/.test(bloco), false);
  assert.equal(/sessionStorage/.test(bloco), false);
  assert.equal(/indexedDB/.test(bloco), false);
  /* copia-se o NOME da variável, e o valor nunca chega ao browser */
  assert.ok(/clipboard\.writeText\(nome\)/.test(bloco), 'a cópia devia ser só do nome');
});

test('FRONTEND: nenhum nome de variável de segredo tem valor escrito no HTML', () => {
  for (const nome of INTEGRACOES.flatMap(i => i.envs)) {
    const re = new RegExp(nome + '\\s*[=:]\\s*[\'"][^\'"]+[\'"]');
    assert.equal(re.test(HTML), false, 'o index.html atribui um valor a ' + nome);
  }
});

test('FRONTEND: a página fala só com o próprio backend', () => {
  const i = HTML.indexOf('CONFIGURAÇÕES → INTEGRAÇÕES');
  const bloco = HTML.slice(i, HTML.indexOf('let confirmResolve', i));
  const externos = bloco.match(/fetch\(\s*['"`]https?:\/\//g) || [];
  assert.deepEqual(externos, [], 'as Configurações fazem pedidos a hosts externos');
  assert.ok(/fetch\('\/api\/outreach\//.test(bloco), 'devia falar com o backend same-origin');
});

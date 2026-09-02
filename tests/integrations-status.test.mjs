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

/**
 * O mínimo para que exista autenticação configurada. Serve os testes que
 * querem medir integrações **em falta** sem que a própria autenticação
 * falte — sem ela a rota responde 503 antes de olhar para o resto.
 */
const AUTH = {
  OUTREACH_AUTH_SECRET: SEGREDOS.OUTREACH_AUTH_SECRET,
  OUTREACH_OPERATOR_EMAIL: SEGREDOS.OUTREACH_OPERATOR_EMAIL,
  OUTREACH_OPERATOR_PASSWORD_HASH: SEGREDOS.OUTREACH_OPERATOR_PASSWORD_HASH
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
  const r = await chamar('integrations', { autenticado: true });
  assert.equal(r.status, 200);
  const ids = r.corpo.integracoes.map(i => i.id);
  assert.deepEqual(ids.sort(), [
    'enrich-email', 'enrich-social', 'external', 'google-maps', 'google-places',
    'manychat', 'meta', 'outreach-auth', 'outreach-db'
  ].sort());
});

test('CONFIG: com tudo configurado, tudo aparece configurado — e sem valores', async () => {
  const r = await chamar('integrations', { autenticado: true });
  for (const i of r.corpo.integracoes) {
    assert.equal(i.configurada, true, i.id + ' devia estar configurada');
    assert.deepEqual(i.emFalta, [], i.id + ' não devia ter variáveis em falta');
  }
  semSegredos(r.corpo, 'integrations');
});

test('CONFIG: sem nenhuma env, responde 200 e diz o que falta', async () => {
  const r = await chamar('integrations', { env: AUTH, autenticado: true });
  assert.equal(r.status, 200, 'nunca pode ser 500');
  const porId = Object.fromEntries(r.corpo.integracoes.map(i => [i.id, i]));
  assert.equal(porId['manychat'].configurada, false);
  assert.deepEqual(porId['manychat'].emFalta, ['MANYCHAT_API_TOKEN']);
  assert.equal(porId['google-places'].configurada, false);
  assert.equal(porId['outreach-db'].configurada, false);
  assert.deepEqual(porId['outreach-db'].emFalta, ['OUTREACH_DB_URL', 'OUTREACH_DB_SERVICE_KEY']);
});

test('CONFIG: integrações sem chave nunca aparecem como "não configuradas"', async () => {
  const r = await chamar('integrations', { env: AUTH, autenticado: true });
  for (const id of ['enrich-email', 'enrich-social']) {
    const i = r.corpo.integracoes.find(x => x.id === id);
    assert.equal(i.semChave, true);
    assert.equal(i.configurada, true, id + ' usa fontes públicas: não há nada para configurar');
    assert.deepEqual(i.variaveis, []);
  }
});

test('CONFIG: configuração parcial mostra exatamente a variável que falta', async () => {
  const r = await chamar('integrations', { env: { ...AUTH, OUTREACH_DB_URL: 'https://x.supabase.co' }, autenticado: true });
  const db = r.corpo.integracoes.find(i => i.id === 'outreach-db');
  assert.equal(db.configurada, false);
  assert.deepEqual(db.emFalta, ['OUTREACH_DB_SERVICE_KEY']);
  semSegredos(r.corpo, 'parcial');
});

test('CONFIG: só devolve nomes de variáveis, nunca valores', async () => {
  const r = await chamar('integrations', { autenticado: true });
  const nomes = new Set(r.corpo.integracoes.flatMap(i => i.variaveis));
  for (const n of nomes) assert.equal(typeof n, 'string');
  /* e nenhum campo do corpo é o VALOR de uma variável */
  semSegredos(r.corpo, 'nomes');
  assert.equal(JSON.stringify(r.corpo).includes('Bearer'), false);
});

test('CONFIG: método errado → 405, nunca 500', async () => {
  const r = await chamar('integrations', { metodo: 'POST', autenticado: true });
  assert.equal(r.status, 405);
  assert.equal(r.corpo.errorCode, 'METHOD_NOT_ALLOWED');
});

test('CONFIG: a resposta não é cacheável', async () => {
  const r = await chamar('integrations', { autenticado: true });
  assert.match(String(r.headers['Cache-Control']), /no-store/);
});

/* ================================================================ *
 * O estado das integrações é privado                                *
 * ---------------------------------------------------------------- *
 * Esta rota já esteve aberta. Não vazava valores, mas dizia a       *
 * qualquer visitante quais integrações o negócio tem ligadas e      *
 * quais lhe faltam. Os testes abaixo existem para que não volte a   *
 * abrir por descuido.                                               *
 * ================================================================ */

test('PRIVADO: sem sessão → 401 e nenhum estado de integração', async () => {
  const r = await chamar('integrations', { autenticado: false });
  assert.equal(r.status, 401);
  assert.equal(r.corpo.integracoes, undefined, 'devolveu estados sem sessão');
  assert.equal(JSON.stringify(r.corpo).includes('manychat'), false);
  semSegredos(r.corpo, '401');
});

test('PRIVADO: sessão inválida → 401', async () => {
  /* cookie com a forma certa e a assinatura errada */
  const forjado = COOKIE_SESSAO + '=' + encodeURIComponent('nao.e.uma.sessao.assinada');
  const req = { method: 'GET', url: '/api/outreach/integrations',
                headers: { cookie: forjado }, query: { rota: ['integrations'] }, body: {} };
  const anterior = { ...process.env };
  Object.assign(process.env, SEGREDOS);
  const res = { _s: 0, _b: null };
  res.status = s => { res._s = s; return res; };
  res.json = b => { res._b = b; res.writableEnded = true; return res; };
  res.setHeader = () => res; res.end = () => { res.writableEnded = true; return res; };
  try { await despachar(req, res); } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, anterior);
  }
  assert.equal(res._s, 401);
  assert.equal((res._b || {}).integracoes, undefined);
});

test('PRIVADO: sessão assinada com outro segredo → 401', async () => {
  const outro = { ...SEGREDOS, OUTREACH_AUTH_SECRET: 'B'.repeat(48) };
  const cookie = COOKIE_SESSAO + '=' + encodeURIComponent(
    criarSessao({ subject: 'op@example.com', roles: ['outreach:operator'] }, outro));
  const req = { method: 'GET', url: '/api/outreach/integrations',
                headers: { cookie }, query: { rota: ['integrations'] }, body: {} };
  const anterior = { ...process.env };
  Object.assign(process.env, SEGREDOS);          /* o servidor usa o segredo verdadeiro */
  const res = { _s: 0, _b: null };
  res.status = s => { res._s = s; return res; };
  res.json = b => { res._b = b; res.writableEnded = true; return res; };
  res.setHeader = () => res; res.end = () => { res.writableEnded = true; return res; };
  try { await despachar(req, res); } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, anterior);
  }
  assert.equal(res._s, 401, 'aceitou uma sessão assinada com outra chave');
});

test('PRIVADO: sessão válida → 200 com os estados', async () => {
  const r = await chamar('integrations', { autenticado: true });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.corpo.integracoes));
  assert.equal(r.corpo.integracoes.length, INTEGRACOES.length);
});

test('PRIVADO: a resposta autenticada continua sem um único segredo', async () => {
  const r = await chamar('integrations', { autenticado: true });
  semSegredos(r.corpo, 'autenticado');
  const txt = JSON.stringify(r.corpo);
  for (const proibido of ['Bearer', 'Authorization', 'password', 'token=', 'sk_', 'eyJ']) {
    assert.equal(txt.includes(proibido), false, 'a resposta contém ' + proibido);
  }
  /* nenhum campo tem o valor de uma env, mesmo por acidente */
  for (const [nome, valor] of Object.entries(SEGREDOS)) {
    if (typeof valor === 'string' && valor.length >= 8) {
      assert.equal(txt.includes(valor), false, 'a resposta contém o valor de ' + nome);
    }
  }
});

test('PRIVADO: o estado da ManyChat só se lê com sessão', async () => {
  const semSessao = await chamar('integrations', { autenticado: false });
  assert.equal(semSessao.status, 401);
  const com = await chamar('integrations', { autenticado: true });
  const mc = com.corpo.integracoes.find(i => i.id === 'manychat');
  assert.equal(mc.configurada, true);
  assert.deepEqual(mc.variaveis, ['MANYCHAT_API_TOKEN']);
});

test('PRIVADO: o estado do Google só se lê com sessão', async () => {
  const semSessao = await chamar('integrations', { autenticado: false });
  assert.equal(semSessao.status, 401);
  assert.equal(JSON.stringify(semSessao.corpo).includes('google'), false);
  const com = await chamar('integrations', { autenticado: true });
  for (const id of ['google-places', 'google-maps']) {
    assert.equal(com.corpo.integracoes.find(i => i.id === id).configurada, true);
  }
});

test('PRIVADO: a Meta continua NOT_CONFIGURED e isso também é privado', async () => {
  const env = { ...SEGREDOS }; delete env.INSTAGRAM_META_ACCESS_TOKEN;
  const semSessao = await chamar('integrations', { env, autenticado: false });
  assert.equal(semSessao.status, 401);
  const com = await chamar('integrations', { env, autenticado: true });
  const meta = com.corpo.integracoes.find(i => i.id === 'meta');
  assert.equal(meta.configurada, false);
  assert.deepEqual(meta.emFalta, ['INSTAGRAM_META_ACCESS_TOKEN']);
});

test('PRIVADO: sem autenticação configurada → 503, e continua a não haver estados', async () => {
  /* o 503 é o mesmo que as outras rotas do Outreach dão; o que importa
     é que também aqui nada do estado das integrações sai */
  const env = { ...SEGREDOS }; delete env.OUTREACH_AUTH_SECRET;
  const r = await chamar('integrations', { env, autenticado: false });
  assert.equal(r.status, 503);
  assert.equal(r.corpo.errorCode, 'NOT_CONFIGURED');
  assert.equal(r.corpo.integracoes, undefined);
});

test('PRIVADO: nenhuma outra rota mudou de porta de entrada', async () => {
  /* `integrations` passou a ser privada; as restantes ficam onde estavam */
  for (const nome of ['providers', 'identity', 'db-probe', 'audit']) {
    const r = await chamar(nome, { autenticado: false });
    assert.equal(r.status, 401, nome + ' devia continuar a pedir sessão');
  }
  /* `session` é a única leitura pública, e continua a sê-lo */
  const s = await chamar('session', { autenticado: false });
  assert.equal(s.status, 200);
  assert.equal(s.corpo.authenticated, false);
  assert.equal(s.corpo.integracoes, undefined, 'a sessão não deve trazer integrações');
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

test('FRONTEND: sem sessão a página nem chega a pedir as integrações', () => {
  const i = HTML.indexOf('async function cfgCarregar');
  assert.ok(i > 0, 'cfgCarregar não encontrado');
  const corpo = HTML.slice(i, HTML.indexOf('function cfgEstadoTexto', i));

  /* a verificação de sessão tem de vir ANTES do pedido a /integrations,
     senão o utilizador deslogado vê um 401 em vez de uma explicação */
  const posSessao = corpo.indexOf('cfgSessao(');
  const posPedido = corpo.indexOf("cfgPedir('integrations')");
  assert.ok(posSessao > 0, 'cfgCarregar não verifica a sessão');
  assert.ok(posPedido > 0, 'cfgCarregar não pede as integrações');
  assert.ok(posSessao < posPedido, 'pede as integrações antes de saber se há sessão');

  /* e sai mesmo, em vez de continuar para o pedido */
  assert.ok(/!s\.autenticado[\s\S]{0,240}return;/.test(corpo), 'não interrompe quando não há sessão');
  assert.ok(/!s\.configurada[\s\S]{0,320}return;/.test(corpo), 'não interrompe quando o backend não tem auth');
});

test('FRONTEND: autenticada, a página continua a carregar as integrações', () => {
  const i = HTML.indexOf('async function cfgCarregar');
  const corpo = HTML.slice(i, HTML.indexOf('function cfgEstadoTexto', i));
  assert.ok(/CFG\.integracoes = r\.integracoes/.test(corpo), 'deixou de guardar as integrações');
  assert.ok(/cfgRender\(\)/.test(corpo), 'deixou de desenhar a lista');
  /* e um 401 tardio — sessão expirada — não vira "backend indisponível" */
  assert.ok(/err\.status === 401/.test(corpo), 'não distingue sessão expirada de backend em baixo');
});

test('FRONTEND: a leitura de sessão usa a rota pública, não inventa outra', () => {
  const i = HTML.indexOf('async function cfgSessao');
  assert.ok(i > 0, 'cfgSessao não encontrado');
  const corpo = HTML.slice(i, i + 700);
  assert.ok(/fetch\('\/api\/outreach\/session'/.test(corpo), 'devia usar /api/outreach/session');
  assert.ok(/credentials: 'same-origin'/.test(corpo), 'o cookie de sessão tem de ir no pedido');
});

test('FRONTEND: a página fala só com o próprio backend', () => {
  const i = HTML.indexOf('CONFIGURAÇÕES → INTEGRAÇÕES');
  const bloco = HTML.slice(i, HTML.indexOf('let confirmResolve', i));
  const externos = bloco.match(/fetch\(\s*['"`]https?:\/\//g) || [];
  assert.deepEqual(externos, [], 'as Configurações fazem pedidos a hosts externos');
  assert.ok(/fetch\('\/api\/outreach\//.test(bloco), 'devia falar com o backend same-origin');
});

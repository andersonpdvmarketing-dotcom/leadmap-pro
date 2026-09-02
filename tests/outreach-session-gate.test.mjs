/**
 * LeadMap Pro — testes da Fase D: sessão, store remoto e migração
 * ===============================================================
 *   node --test
 *
 * O `fetch` é substituído por um encaminhador que chama as **rotas
 * reais** (`despachar`) contra um repositório em memória. Assim o
 * caminho testado é o verdadeiro — RemoteOutreachStore → HTTP → auth →
 * service → repositório — sem tocar na rede.
 *
 * Nada aqui contacta a Meta, o Instagram ou uma base de dados real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { despachar } from '../providers/outreach/routes.mjs';
import { RemoteOutreachStore } from '../providers/outreach/remote-store.mjs';
import {
  SessaoOutreach, ESTADO_UI, decidirEstadoUI, preverMigracao, executarMigracao
} from '../providers/outreach/session-gate.mjs';
import { criarHashPassword, limparTentativas, LOGIN_MAX_TENTATIVAS } from '../providers/outreach/auth.mjs';

/* ---------------------------------------------------------------- *
 * Harness: fetch → rotas reais                                      *
 * ---------------------------------------------------------------- */

const PASSWORD = 'password-de-teste-forte';
const ENV = () => ({
  OUTREACH_AUTH_SECRET: 'x'.repeat(48),
  OUTREACH_OPERATOR_EMAIL: 'op@example.com',
  OUTREACH_OPERATOR_PASSWORD_HASH: criarHashPassword(PASSWORD),
  OUTREACH_WORKER_SECRET: 'w'.repeat(40),
  OUTREACH_ENV: 'test'                     /* fora de produção → repositório em memória */
});

/**
 * Cria um cliente remoto ligado às rotas reais.
 * `guardaCookie` imita o browser: guarda o Set-Cookie e reenvia-o.
 */
function montar({ env = ENV(), falhar = null } = {}) {
  const cookies = new Map();
  let pedidos = 0;

  const encaminhar = async (url, opcoes = {}) => {
    pedidos += 1;
    if (falhar && falhar(url, pedidos)) throw new Error('rede em baixo');

    const u = new URL(url, 'https://exemplo.test');
    const nome = u.pathname.replace(/^\/api\/outreach\//, '');
    const query = Object.fromEntries(u.searchParams);
    const req = {
      method: opcoes.method || 'GET',
      url: u.pathname + u.search,
      headers: { host: 'exemplo.test', cookie: [...cookies].map(([k, v]) => k + '=' + v).join('; ') },
      query: { rota: [nome], ...query },
      body: opcoes.body ? JSON.parse(opcoes.body) : {}
    };
    const res = { _s: 200, _b: null, _h: {}, writableEnded: false };
    res.status = s => { res._s = s; return res; };
    res.json = b => { res._b = b; res.writableEnded = true; return res; };
    res.setHeader = (k, v) => { res._h[k] = v; return res; };
    res.end = () => { res.writableEnded = true; return res; };

    const anterior = { ...process.env };
    for (const k of Object.keys(process.env)) if (/^OUTREACH|^SUPABASE|^DATABASE/.test(k)) delete process.env[k];
    Object.assign(process.env, env);
    try { await despachar(req, res); } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, anterior);
    }

    const sc = res._h['Set-Cookie'];
    if (sc) {
      const [par] = sc.split(';');
      const i = par.indexOf('=');
      const k = par.slice(0, i), v = par.slice(i + 1);
      if (v === '') cookies.delete(k); else cookies.set(k, v);
    }
    return {
      ok: res._s >= 200 && res._s < 300,
      status: res._s,
      headers: { get: (k) => res._h[k] || res._h[k.toLowerCase()] || null },
      json: async () => res._b
    };
  };

  const remoto = new RemoteOutreachStore({ fetchImpl: encaminhar });
  return { remoto, cookies, env, contarPedidos: () => pedidos };
}

/** Repositório em memória é global por processo; isolar entre testes. */
function limparRepositorio() {
  delete globalThis.__outreachMemRepo;
  limparTentativas();
}

/* ================================================================ *
 * Máquina de estados                                                *
 * ================================================================ */

test('GATE: cada combinação leva ao estado certo', () => {
  assert.equal(decidirEstadoUI({ configured: false }), ESTADO_UI.NAO_CONFIGURADO);
  assert.equal(decidirEstadoUI({ configured: true, authenticated: false }), ESTADO_UI.LOGIN);
  assert.equal(decidirEstadoUI({ configured: true, authenticated: true, databaseConfigured: false }), ESTADO_UI.SEM_BANCO);
  assert.equal(decidirEstadoUI({ configured: true, authenticated: true, databaseConfigured: true }), ESTADO_UI.PRONTO);
});

test('GATE: erro de rede ganha a qualquer estado — nunca se adivinha', () => {
  assert.equal(decidirEstadoUI({ configured: true, authenticated: true, databaseConfigured: true }, 'timeout'),
    ESTADO_UI.INDISPONIVEL);
  assert.equal(decidirEstadoUI(null, 'sem resposta'), ESTADO_UI.INDISPONIVEL);
});

test('GATE: sem auth configurada → NAO_CONFIGURADO, sem rebentar', async () => {
  limparRepositorio();
  const { remoto } = montar({ env: { OUTREACH_ENV: 'test' } });
  const s = new SessaoOutreach({ remoto });
  assert.equal(await s.avaliar(), ESTADO_UI.NAO_CONFIGURADO);
  assert.equal(s.autenticado, false);
});

test('GATE: backend em baixo → INDISPONIVEL', async () => {
  limparRepositorio();
  const { remoto } = montar({ falhar: () => true });
  const s = new SessaoOutreach({ remoto });
  assert.equal(await s.avaliar(), ESTADO_UI.INDISPONIVEL);
});

/* ================================================================ *
 * Login, sessão e logout                                            *
 * ================================================================ */

test('SESSÃO: login, restauro e logout através das rotas reais', async () => {
  limparRepositorio();
  const { remoto } = montar();
  const s = new SessaoOutreach({ remoto });

  assert.equal(await s.avaliar(), ESTADO_UI.LOGIN);

  await s.entrar('op@example.com', PASSWORD);
  assert.equal(s.estado, ESTADO_UI.PRONTO);
  assert.equal(s.info.subject, 'op@example.com');

  /* restauro: uma nova sessão sobre o mesmo cookie continua autenticada */
  const s2 = new SessaoOutreach({ remoto });
  assert.equal(await s2.avaliar(), ESTADO_UI.PRONTO);

  await s.sair();
  assert.equal(s.estado, ESTADO_UI.LOGIN);
  assert.equal(await s2.avaliar(), ESTADO_UI.LOGIN, 'o cookie devia ter sido invalidado');
});

test('SESSÃO: password errada não autentica', async () => {
  limparRepositorio();
  const { remoto } = montar();
  const s = new SessaoOutreach({ remoto });
  await assert.rejects(() => s.entrar('op@example.com', 'errada'), (e) => e.status === 401);
  assert.equal(await s.avaliar(), ESTADO_UI.LOGIN);
});

test('SESSÃO: força bruta é travada depois de N tentativas', async () => {
  limparRepositorio();
  const { remoto } = montar();
  const s = new SessaoOutreach({ remoto });
  let ultimo = null;
  for (let i = 0; i < LOGIN_MAX_TENTATIVAS + 2; i++) {
    try { await s.entrar('op@example.com', 'errada'); } catch (e) { ultimo = e; }
  }
  assert.equal(ultimo.status, 429, 'devia ter passado a 429');
  assert.equal(ultimo.errorCode, 'TOO_MANY_ATTEMPTS');
  /* e o bloqueio não deixa passar a password certa enquanto durar */
  await assert.rejects(() => s.entrar('op@example.com', PASSWORD), (e) => e.status === 429);
});

test('SESSÃO: entrada correta limpa o contador de tentativas', async () => {
  limparRepositorio();
  const { remoto } = montar();
  const s = new SessaoOutreach({ remoto });
  for (let i = 0; i < 3; i++) { try { await s.entrar('op@example.com', 'errada'); } catch (e) { /* esperado */ } }
  await s.entrar('op@example.com', PASSWORD);
  assert.equal(s.estado, ESTADO_UI.PRONTO);
  for (let i = 0; i < 3; i++) { try { await s.entrar('op@example.com', 'errada'); } catch (e) { /* esperado */ } }
  await s.entrar('op@example.com', PASSWORD);   /* não devia dar 429 */
  assert.equal(s.estado, ESTADO_UI.PRONTO);
});

/* ================================================================ *
 * Sem fallback silencioso (§17)                                     *
 * ================================================================ */

test('SEM FALLBACK: hidratar recusa-se sem sessão', async () => {
  limparRepositorio();
  const { remoto } = montar();
  const s = new SessaoOutreach({ remoto });
  await s.avaliar();
  await assert.rejects(() => s.hidratar(), (e) => e.errorCode === 'UNAUTHENTICATED');
});

test('SEM FALLBACK: falha a meio propaga o erro e não devolve dados locais', async () => {
  limparRepositorio();
  /* deixa passar login e /session, e parte os contactos */
  const { remoto } = montar({ falhar: (url) => String(url).includes('/contacts') });
  const s = new SessaoOutreach({ remoto });
  await s.entrar('op@example.com', PASSWORD);
  assert.equal(s.estado, ESTADO_UI.PRONTO);

  let dados = null, erro = null;
  try { dados = await s.hidratar(); } catch (e) { erro = e; }
  assert.ok(erro, 'devia ter falhado');
  assert.equal(dados, null, 'não pode devolver nada quando falha');
});

test('SEM FALLBACK: o store remoto nunca lê nem escreve localStorage', () => {
  const { remoto } = montar();
  /* o contrato do OutreachStore existe, mas em modo remoto é inerte */
  const vazio = remoto.load();
  assert.equal(vazio.remoto, true);
  assert.deepEqual(vazio.contactos, []);
  assert.equal(remoto.save({ contactos: [1, 2, 3] }), null);
  assert.equal(remoto.clear(), null);
  const fonte = RemoteOutreachStore.prototype.constructor.toString()
    + Object.getOwnPropertyNames(RemoteOutreachStore.prototype).join(',');
  assert.equal(/localStorage|sessionStorage|indexedDB/i.test(fonte), false);
});

/* ================================================================ *
 * Regras de negócio pelo caminho remoto                             *
 * ================================================================ */

async function sessaoPronta() {
  limparRepositorio();
  const m = montar();
  const s = new SessaoOutreach({ remoto: m.remoto });
  await s.entrar('op@example.com', PASSWORD);
  return { ...m, sessao: s };
}

test('REMOTO: importar o mesmo contacto duas vezes não duplica', async () => {
  const { remoto } = await sessaoPronta();
  const lead = { leadId: 'L1', normalizedInstagram: 'clinica_x', name: 'Clínica X' };
  await remoto.importarContactos([lead]);
  await remoto.importarContactos([lead]);
  const r = await remoto.listarContactos({ limit: 50, offset: 0 });
  assert.equal(r.items.length, 1, 'o Instagram normalizado devia ter deduplicado');
});

test('REMOTO: reimportar não apaga o opt-out', async () => {
  const { remoto } = await sessaoPronta();
  const lead = { leadId: 'L2', normalizedInstagram: 'estudio_y', name: 'Estúdio Y' };
  await remoto.importarContactos([lead]);
  const antes = (await remoto.listarContactos({ limit: 50, offset: 0 })).items[0];

  /* marcar opt-out directamente no repositório partilhado */
  const repo = globalThis.__outreachMemRepo;
  await repo.definirOptOut(antes.id, true);

  await remoto.importarContactos([lead]);
  const depois = (await remoto.listarContactos({ limit: 50, offset: 0 })).items[0];
  assert.equal(depois.status, 'OPTED_OUT', 'a reimportação apagou o opt-out');
});

test('REMOTO: a sexta conta é recusada pelo backend', async () => {
  const { remoto } = await sessaoPronta();
  for (let i = 1; i <= 5; i++) {
    await remoto.criarConta({ displayName: 'Conta ' + i, username: 'conta' + i, provider: 'mock' });
  }
  await assert.rejects(
    () => remoto.criarConta({ displayName: 'Conta 6', username: 'conta6', provider: 'mock' }),
    (e) => e.errorCode === 'MAX_ACCOUNTS' || e.status === 409,
    'a sexta conta passou'
  );
  const r = await remoto.listarContas();
  assert.equal(r.items.length, 5);
});

test('REMOTO: paginação respeita o contrato (50 por omissão, 200 no máximo)', async () => {
  const { remoto } = await sessaoPronta();
  const muitos = Array.from({ length: 60 }, (_, i) => ({ leadId: 'L' + i, normalizedInstagram: 'c' + i, name: 'C' + i }));
  await remoto.importarContactos(muitos);
  const omissao = await remoto.listarContactos({});
  assert.ok(omissao.items.length <= 50, 'devolveu ' + omissao.items.length + ' sem limite pedido');
  const demais = await remoto.listarContactos({ limit: 5000, offset: 0 });
  assert.ok(demais.items.length <= 200, 'o teto de 200 não foi aplicado');
});

/* ================================================================ *
 * Migração                                                          *
 * ================================================================ */

const ESTADO_LOCAL = () => ({
  contactos: [
    { id: 'c1', leadId: 'L1', instagram: 'clinica_a', nome: 'Clínica A', temInstagram: true },
    { id: 'c2', leadId: 'L2', instagram: 'clinica_b', nome: 'Clínica B', temInstagram: true },
    { id: 'c3', leadId: null, instagram: null, nome: 'Sem identidade', temInstagram: false }
  ],
  templates: [{ id: 't1', nome: 'Primeiro contacto', mensagem: 'Olá {nome}' }],
  campanhas: [
    { id: 'k1', nome: 'Rascunho', status: 'DRAFT', mensagem: 'Olá' },
    { id: 'k2', nome: 'Já correu', status: 'COMPLETED', mensagem: 'Olá' }
  ],
  contas: [{ id: 'a1', username: 'teste' }],
  mensagens: [
    { id: 'm1', status: 'SENT' }, { id: 'm2', status: 'DELIVERED' }, { id: 'm3', status: 'REPLIED' }
  ],
  fila: [{ id: 'q1', status: 'SENT' }, { id: 'q2', status: 'PENDING' }]
});

test('MIGRAÇÃO: a previsão separa trabalho real de simulação', () => {
  const p = preverMigracao(ESTADO_LOCAL());
  assert.equal(p.migravel.contactos, 2, 'só os que têm identidade');
  assert.equal(p.migravel.templates, 1);
  assert.equal(p.migravel.campanhasDraft, 1);
  assert.equal(p.ignorado.mensagensSimuladas, 3);
  assert.equal(p.ignorado.itensDeFila, 2);
  assert.equal(p.ignorado.campanhasJaExecutadas, 1);
  assert.equal(p.ignorado.contactosSemIdentidade, 1);
  assert.equal(p.nada, false);
});

test('MIGRAÇÃO: estado local vazio é reconhecido', () => {
  assert.equal(preverMigracao({}).nada, true);
  assert.equal(preverMigracao(null).nada, true);
});

test('MIGRAÇÃO: exige confirmação explícita', async () => {
  const { remoto } = await sessaoPronta();
  await assert.rejects(() => executarMigracao(ESTADO_LOCAL(), remoto, {}), (e) => e.errorCode === 'NOT_CONFIRMED');
  await assert.rejects(() => executarMigracao(ESTADO_LOCAL(), remoto, { confirmado: 'sim' }), (e) => e.errorCode === 'NOT_CONFIRMED');
  const r = await executarMigracao(ESTADO_LOCAL(), remoto, { confirmado: true });
  assert.ok(r.resumo);
});

test('MIGRAÇÃO: correr duas vezes não duplica nada', async () => {
  const { remoto } = await sessaoPronta();
  await executarMigracao(ESTADO_LOCAL(), remoto, { confirmado: true });
  const depoisDe1 = {
    contactos: (await remoto.listarContactos({ limit: 200, offset: 0 })).items.length,
    templates: (await remoto.listarTemplates({ limit: 200, offset: 0 })).items.length
  };
  await executarMigracao(ESTADO_LOCAL(), remoto, { confirmado: true });
  const depoisDe2 = {
    contactos: (await remoto.listarContactos({ limit: 200, offset: 0 })).items.length,
    templates: (await remoto.listarTemplates({ limit: 200, offset: 0 })).items.length
  };
  assert.deepEqual(depoisDe2, depoisDe1, 'a segunda migração duplicou');
  assert.equal(depoisDe1.contactos, 2);
  assert.equal(depoisDe1.templates, 1);
});

test('MIGRAÇÃO: nenhuma mensagem simulada entra como atividade real', async () => {
  const { remoto } = await sessaoPronta();
  await executarMigracao(ESTADO_LOCAL(), remoto, { confirmado: true });
  const fila = await remoto.listarFila({ limit: 200, offset: 0 });
  assert.equal(fila.items.length, 0, 'a fila devia ficar vazia');
  const repo = globalThis.__outreachMemRepo;
  assert.equal(repo.mensagens ? repo.mensagens.size : 0, 0, 'foram criadas mensagens a partir da simulação');
});

test('MIGRAÇÃO: campanhas não migram por omissão e nunca ficam a correr', async () => {
  const { remoto } = await sessaoPronta();
  const r = await executarMigracao(ESTADO_LOCAL(), remoto, { confirmado: true });
  assert.equal(r.resumo.campanhas.criadas, 0);
  const ks = await remoto.listarCampanhas({ limit: 50, offset: 0 });
  assert.equal(ks.items.length, 0);
});

test('MIGRAÇÃO: o estado local nunca é apagado', async () => {
  const { remoto } = await sessaoPronta();
  const local = ESTADO_LOCAL();
  const antes = JSON.stringify(local);
  const r = await executarMigracao(local, remoto, { confirmado: true });
  assert.equal(r.localApagado, false);
  assert.equal(JSON.stringify(local), antes, 'a migração mexeu no estado local');
});

/* ================================================================ *
 * Segredos e rede                                                   *
 * ================================================================ */

test('SEGURANÇA: nada do que a API devolve contém segredos', async () => {
  const { remoto } = await sessaoPronta();
  await remoto.importarContactos([{ leadId: 'L9', normalizedInstagram: 'x9', name: 'X' }]);
  const respostas = JSON.stringify([
    await remoto.estado(),
    await remoto.listarContactos({}),
    await remoto.listarTemplates({}),
    await remoto.listarContas()
  ]);
  for (const proibido of ['OUTREACH_AUTH_SECRET', 'x'.repeat(48), 'w'.repeat(40), 'scrypt$', PASSWORD]) {
    assert.equal(respostas.includes(proibido), false, 'fuga: ' + proibido.slice(0, 12));
  }
});

test('SEGURANÇA: durante toda a Fase D não há pedidos a Meta ou Instagram', async () => {
  const fora = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (u) => { fora.push(String(u)); throw new Error('bloqueado'); };
  try {
    const { remoto } = await sessaoPronta();
    await executarMigracao(ESTADO_LOCAL(), remoto, { confirmado: true });
    const s = new SessaoOutreach({ remoto });
    await s.avaliar();
  } finally { globalThis.fetch = original; }
  assert.deepEqual(fora, [], 'saiu tráfego: ' + JSON.stringify(fora));
});

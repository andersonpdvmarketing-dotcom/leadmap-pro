/**
 * LeadMap Pro — testes do modelo de identidade Meta
 * =================================================
 *   node --test
 *
 * Um IGSID prova que alguém escreveu. Não prova QUEM é essa pessoa na
 * lista de contactos do LeadMap. Quase todos os testes aqui verificam
 * que o sistema se recusa a fechar esse salto sozinho — porque fechá-lo
 * mal significa responder a uma pessoa com o nome de outra.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

import { despachar, mascararId } from '../providers/outreach/routes.mjs';
import { InMemoryOutreachRepository } from '../providers/outreach/repository.mjs';
import { OutreachService } from '../providers/outreach/service.mjs';
import { MetaInstagramProvider } from '../providers/instagram/meta.mjs';
import { IDENTITY_STATUS, ELIGIBILITY, podeEnviar, identidadeConfirmada } from '../providers/instagram/contract.mjs';

const IGSID = '17841499887766554';
const APP_SECRET = 'app-secret-identidade';

/* ---------------------------------------------------------------- *
 * Cenário                                                           *
 * ---------------------------------------------------------------- */

async function cenario() {
  const repo = new InMemoryOutreachRepository();
  const svc = new OutreachService({ repository: repo, actor: 't', env: { OUTREACH_ENV: 'test' } });
  await svc.importarContactos({ contacts: [
    { leadId: 'L1', normalizedInstagram: 'clinica_alfa', name: 'Clínica Alfa' },
    { leadId: 'L2', normalizedInstagram: 'studio_beta', name: 'Studio Beta' },
    { leadId: 'L3', name: 'Sem Instagram' }
  ] });
  const cs = (await svc.listarContactos({ limit: 10, offset: 0 })).items;
  return { repo, svc, alfa: cs.find(c => c.normalizedInstagram === 'clinica_alfa'),
           beta: cs.find(c => c.normalizedInstagram === 'studio_beta'),
           semIg: cs.find(c => !c.normalizedInstagram) };
}

const resposta = (status, corpo) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => null }, json: async () => corpo
});

const metaCom = (rotas, registo = []) => new MetaInstagramProvider(
  { accessToken: 'IGAA-t', appSecret: APP_SECRET, verifyToken: 'v' },
  { fetch: async (url) => {
      const u = new URL(String(url));
      registo.push(u.pathname + u.search);
      for (const [p, r] of Object.entries(rotas)) if (u.pathname.includes(p) || u.search.includes(p)) return r;
      return resposta(404, { error: { message: 'not found' } });
    } });

/* ================================================================ *
 * 1–5 · estados de identidade                                       *
 * ================================================================ */

test('IDENT 1: contacto sem destinatário → NO_RECIPIENT_ID', async () => {
  const { semIg } = await cenario();
  const p = metaCom({});
  assert.equal(p.estadoIdentidade(semIg), IDENTITY_STATUS.NO_RECIPIENT_ID);
  const r = await p.resolveRecipientDoContacto(semIg);
  assert.equal(r.status, ELIGIBILITY.NO_RECIPIENT_ID);
});

test('IDENT 2: só @perfil → PROFILE_FOUND_ONLY, e não autoriza envio', async () => {
  const { alfa } = await cenario();
  const registo = [];
  const r = await metaCom({}, registo).resolveRecipientDoContacto(alfa);
  assert.equal(r.status, ELIGIBILITY.PROFILE_FOUND_ONLY);
  assert.equal(r.identidade, IDENTITY_STATUS.NO_RECIPIENT_ID);
  assert.equal(podeEnviar(r.status), false);
  assert.equal(registo.length, 0, 'foi à API tentar adivinhar');
});

test('IDENT 3: destinatário descoberto não é destinatário identificado', () => {
  /* um IGSID visto num webhook fica em DISCOVERED — sem dono */
  assert.equal(identidadeConfirmada(IDENTITY_STATUS.RECIPIENT_DISCOVERED), false);
  assert.equal(identidadeConfirmada(IDENTITY_STATUS.RECIPIENT_UNVERIFIED), false);
  assert.equal(identidadeConfirmada(IDENTITY_STATUS.RECIPIENT_VERIFIED), true);
});

test('IDENT 4: associado mas por confirmar → RECIPIENT_UNVERIFIED, sem envio', async () => {
  const { repo, alfa } = await cenario();
  await repo.associarRecipient({ contactId: alfa.id, provider: 'meta', recipientId: IGSID, verificado: false });
  const c = await repo.lerContacto(alfa.id);
  const p = metaCom({});
  assert.equal(p.estadoIdentidade(c), IDENTITY_STATUS.RECIPIENT_UNVERIFIED);
  const r = await p.resolveRecipientDoContacto(c);
  assert.equal(r.status, ELIGIBILITY.NOT_ELIGIBLE);
  assert.equal(podeEnviar(r.status), false);
});

test('IDENT 5: confirmado + conversa aberta → ELIGIBLE', async () => {
  const { repo, alfa } = await cenario();
  await repo.associarRecipient({ contactId: alfa.id, provider: 'meta', recipientId: IGSID, verificado: true });
  const c = await repo.lerContacto(alfa.id);
  const p = metaCom({ '/me/conversations': resposta(200, { data: [{ id: 'conv-1' }] }) });
  assert.equal(p.estadoIdentidade(c), IDENTITY_STATUS.RECIPIENT_VERIFIED);
  const r = await p.resolveRecipientDoContacto(c);
  assert.equal(r.status, ELIGIBILITY.ELIGIBLE);
  assert.equal(r.recipientId, IGSID);
});

/* ================================================================ *
 * 6–7 · matching exato, zero aproximação                            *
 * ================================================================ */

test('IDENT 6: procura por destinatário é exata', async () => {
  const { repo, alfa } = await cenario();
  await repo.associarRecipient({ contactId: alfa.id, provider: 'meta', recipientId: IGSID, verificado: true });
  assert.equal((await repo.contactoPorRecipient('meta', IGSID)).id, alfa.id);
  /* nada de prefixos, sufixos ou "quase igual" */
  for (const quase of [IGSID.slice(0, -1), IGSID + '0', ' ' + IGSID, IGSID.toUpperCase() + 'X']) {
    assert.equal(await repo.contactoPorRecipient('meta', quase), null, 'aceitou aproximado: ' + quase);
  }
});

test('IDENT 7: não há fuzzy matching em lado nenhum do caminho', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['providers/outreach/routes.mjs', 'providers/outreach/repository.mjs',
                   'providers/instagram/meta.mjs']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const p of [/levenshtein/i, /fuzzy/i, /similarity/i, /\.startsWith\([^)]*igsid/i, /soundex/i]) {
      assert.equal(p.test(src), false, f + ' parece usar correspondência aproximada: ' + p);
    }
  }
});

/* ================================================================ *
 * 8–10 · webhook                                                    *
 * ================================================================ */

const PAYLOAD = (sender = IGSID, mid = 'mid-1') => JSON.stringify({
  object: 'instagram',
  entry: [{ id: '17841400000000000', messaging: [
    { sender: { id: sender }, recipient: { id: '17841400000000000' },
      timestamp: 1758000000000, message: { mid, text: 'olá' } }] }]
});

function pedidoWebhook(bruto) {
  const req = Readable.from([Buffer.from(bruto, 'utf8')]);
  req.method = 'POST';
  req.url = '/api/outreach/meta-webhook';
  req.headers = { 'content-type': 'application/json',
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', APP_SECRET).update(bruto, 'utf8').digest('hex') };
  req.query = { rota: ['meta-webhook'] };
  return req;
}

async function chamarWebhook(bruto, repo) {
  const anterior = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^OUTREACH|^INSTAGRAM|^MANYCHAT/.test(k)) delete process.env[k];
  Object.assign(process.env, { OUTREACH_ENV: 'test', INSTAGRAM_META_APP_SECRET: APP_SECRET,
                               INSTAGRAM_META_VERIFY_TOKEN: 'v' });
  if (repo) globalThis.__outreachMemRepo = repo;
  const res = { _s: 0, _b: null };
  res.status = s => { res._s = s; return res; };
  res.json = b => { res._b = b; res.writableEnded = true; return res; };
  res.setHeader = () => res; res.end = () => res;
  const err = console.error; console.error = () => {};
  try { await despachar(pedidoWebhook(bruto), res); } finally {
    console.error = err;
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, anterior);
  }
  return res;
}

test('IDENT 8: inbound de um IGSID desconhecido fica por associar', async () => {
  const { repo } = await cenario();
  const r = await chamarWebhook(PAYLOAD(), repo);
  assert.equal(r._b.resumo.semCorrespondencia, 1);
  assert.equal(r._b.resumo.correspondidos, 0);
  /* e não se criou contacto nenhum a partir do identificador */
  assert.equal(repo.contactos.size, 3);
});

test('IDENT 9: inbound de um IGSID associado é correspondido', async () => {
  const { repo, alfa } = await cenario();
  await repo.associarRecipient({ contactId: alfa.id, provider: 'meta', recipientId: IGSID, verificado: true });
  const r = await chamarWebhook(PAYLOAD(), repo);
  assert.equal(r._b.resumo.correspondidos, 1);
  const aud = (await repo.listarAuditoria({ limit: 50, offset: 0 })).items;
  const m = aud.find(e => e.action === 'META_INBOUND_MATCHED');
  assert.ok(m, 'faltou a auditoria de correspondência');
  assert.equal(m.entityId, alfa.id);
  assert.equal(String(m.metadata.recipientMascarado).includes(IGSID), false, 'o IGSID saiu completo na auditoria');
});

test('IDENT 10: o mesmo webhook duas vezes não duplica nada', async () => {
  const { repo, alfa } = await cenario();
  await repo.associarRecipient({ contactId: alfa.id, provider: 'meta', recipientId: IGSID, verificado: true });
  const a = await chamarWebhook(PAYLOAD(), repo);
  const b = await chamarWebhook(PAYLOAD(), repo);
  assert.equal(a._b.resumo.correspondidos, 1);
  assert.equal(b._b.resumo.duplicados, 1);
  assert.equal(b._b.resumo.correspondidos, 0);
  assert.equal(repo.webhooks.size, 1);
});

/* ================================================================ *
 * 11–13 · associação, conflito, fornecedor                          *
 * ================================================================ */

test('IDENT 11: associar duas vezes o mesmo par é idempotente', async () => {
  const { repo, alfa } = await cenario();
  const a = await repo.associarRecipient({ contactId: alfa.id, provider: 'meta', recipientId: IGSID, verificado: true });
  const b = await repo.associarRecipient({ contactId: alfa.id, provider: 'meta', recipientId: IGSID, verificado: true });
  assert.equal(a.jaExistia, false);
  assert.equal(b.jaExistia, true);
  assert.equal(a.contacto.igUserIdVerifiedAt, b.contacto.igUserIdVerifiedAt, 'a data de verificação mudou');
});

test('IDENT 12: um destinatário já associado NÃO muda de contacto sozinho', async () => {
  const { repo, alfa, beta } = await cenario();
  await repo.associarRecipient({ contactId: alfa.id, provider: 'meta', recipientId: IGSID, verificado: true });
  await assert.rejects(
    () => repo.associarRecipient({ contactId: beta.id, provider: 'meta', recipientId: IGSID }),
    (e) => e.errorCode === 'RECIPIENT_ALREADY_LINKED');
  /* e o dono original ficou intacto */
  assert.equal((await repo.contactoPorRecipient('meta', IGSID)).id, alfa.id);
  assert.equal((await repo.lerContacto(beta.id)).igUserId, null);
});

test('IDENT 12b: um contacto não recebe um segundo destinatário em silêncio', async () => {
  const { repo, alfa } = await cenario();
  await repo.associarRecipient({ contactId: alfa.id, provider: 'meta', recipientId: IGSID, verificado: true });
  await assert.rejects(
    () => repo.associarRecipient({ contactId: alfa.id, provider: 'meta', recipientId: '999999' }),
    (e) => e.errorCode === 'RECIPIENT_ALREADY_LINKED');
});

test('IDENT 13: identificador de outro fornecedor não serve para a Meta', async () => {
  const { repo, alfa } = await cenario();
  await repo.associarRecipient({ contactId: alfa.id, provider: 'manychat', recipientId: '555', verificado: true });
  const c = await repo.lerContacto(alfa.id);
  /* um subscriber_id da ManyChat não é um IGSID — não são o mesmo espaço */
  assert.equal(metaCom({}).estadoIdentidade(c), IDENTITY_STATUS.NO_RECIPIENT_ID);
  assert.equal(await repo.contactoPorRecipient('meta', '555'), null);
});

/* ================================================================ *
 * 14–16 · elegibilidade e janela                                    *
 * ================================================================ */

test('IDENT 14: opt-out bloqueia mesmo com identidade confirmada', async () => {
  const { repo, alfa } = await cenario();
  await repo.associarRecipient({ contactId: alfa.id, provider: 'meta', recipientId: IGSID, verificado: true });
  await repo.definirOptOut(alfa.id, true);
  const c = await repo.lerContacto(alfa.id);
  assert.equal(c.status, 'OPTED_OUT');
  const { motivoDeExclusao } = await import('../providers/outreach/domain.mjs');
  assert.ok(motivoDeExclusao(c), 'o opt-out devia continuar a excluir');
});

test('IDENT 15: a janela sai dos eventos de webhook, não de coluna nova', async () => {
  const { repo, alfa } = await cenario();
  await repo.associarRecipient({ contactId: alfa.id, provider: 'meta', recipientId: IGSID, verificado: true });
  assert.equal(await repo.ultimoInboundDe('meta', IGSID), null, 'sem inbound não há janela');
  await chamarWebhook(PAYLOAD(), repo);
  const t = await repo.ultimoInboundDe('meta', IGSID);
  assert.ok(t, 'o inbound devia ter deixado marca temporal');
  /* e o contacto não ganhou coluna de última interação */
  const c = await repo.lerContacto(alfa.id);
  assert.equal(c.lastInboundAt, undefined, 'foi criada uma segunda cópia da mesma verdade');
});

test('IDENT 16: sem conversa aberta o envio não é autorizado', async () => {
  const { repo, alfa } = await cenario();
  await repo.associarRecipient({ contactId: alfa.id, provider: 'meta', recipientId: IGSID, verificado: true });
  const c = await repo.lerContacto(alfa.id);
  const p = metaCom({ '/me/conversations': resposta(200, { data: [] }) });
  const r = await p.resolveRecipientDoContacto(c);
  assert.equal(r.status, ELIGIBILITY.NOT_ELIGIBLE);
  assert.equal(podeEnviar(r.status), false);
});

/* ================================================================ *
 * 17–18 · nunca trocar identificador por username                   *
 * ================================================================ */

test('IDENT 17: um IGSID nunca é usado como username', async () => {
  const registo = [];
  const p = metaCom({ '/me/conversations': resposta(200, { data: [{ id: 'c' }] }) }, registo);
  await p.resolveRecipient({ igsid: IGSID });
  for (const u of registo) {
    assert.equal(/username=/.test(u), false, 'o IGSID foi parar a um parâmetro de username');
  }
});

test('IDENT 18: um username nunca é usado como destinatário', async () => {
  const registo = [];
  const p = metaCom({}, registo);
  const r = await p.resolveRecipient({ username: 'clinica_alfa' });
  assert.equal(r.recipientId, null);
  assert.equal(registo.length, 0);
});

test('IDENT 18b: a verificação compara o username que a API devolveu', async () => {
  const p = metaCom({ 'fields=username': resposta(200, { username: 'clinica_alfa', name: 'Clínica Alfa' }) });
  const bom = await p.verificarIdentidade(IGSID, 'clinica_alfa');
  assert.equal(bom.verificado, true);
  const mau = await p.verificarIdentidade(IGSID, 'outra_clinica');
  assert.equal(mau.verificado, false);
  assert.match(mau.motivo, /não é o do contacto/);
});

test('IDENT 18c: sem username devolvido pela API, não se confirma nada', async () => {
  const p = metaCom({ 'fields=username': resposta(200, { name: 'Alguém' }) });
  const r = await p.verificarIdentidade(IGSID, 'clinica_alfa');
  assert.equal(r.verificado, false);
  assert.match(r.motivo, /não devolveu username/);
});

/* ================================================================ *
 * 19–20 · segredos e máscara                                        *
 * ================================================================ */

test('IDENT 19: nenhum segredo aparece nas respostas de identidade', async () => {
  const { repo, alfa } = await cenario();
  await repo.associarRecipient({ contactId: alfa.id, provider: 'meta', recipientId: IGSID, verificado: true });
  const r = await chamarWebhook(PAYLOAD(), repo);
  const tudo = JSON.stringify([r._b, (await repo.listarAuditoria({ limit: 50, offset: 0 })).items]);
  for (const seg of [APP_SECRET, 'IGAA-t']) {
    assert.equal(tudo.includes(seg), false, 'fuga: ' + seg);
  }
});

test('IDENT 20: o identificador vai mascarado para fora do backend', () => {
  assert.equal(mascararId(IGSID), '1784…6554');
  assert.equal(mascararId('12345'), '…345');
  assert.equal(mascararId(''), null);
  assert.equal(mascararId(null), null);
  /* a máscara não pode devolver o valor inteiro para ids curtos */
  assert.equal(mascararId('123456789').includes('123456789'), false);
});

/**
 * LeadMap Pro — testes do webhook da Meta
 * =======================================
 *   node --test
 *
 * O webhook é a única porta do Outreach que aceita pedidos sem sessão —
 * quem chama é a Meta, e a autenticação é a assinatura. Por isso quase
 * tudo aqui testa recusas: sem assinatura válida não se processa nada,
 * e um corpo alterado depois de assinado tem de ser rejeitado mesmo que
 * o JSON continue a fazer sentido.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

import { despachar, idDoEvento, lerCorpoBruto } from '../providers/outreach/routes.mjs';

const APP_SECRET = 'app-secret-de-teste';
const VERIFY = 'verify-token-de-teste';

const ENV = () => ({
  OUTREACH_ENV: 'test',
  INSTAGRAM_META_ACCESS_TOKEN: 'IGAA-token-SEGREDO',
  INSTAGRAM_META_APP_SECRET: APP_SECRET,
  INSTAGRAM_META_VERIFY_TOKEN: VERIFY
});

const PAYLOAD = (extra = {}) => ({
  object: 'instagram',
  entry: [{
    id: '17841400000000000',
    time: 1758000000000,
    messaging: [{
      sender: { id: '99887766' },
      recipient: { id: '17841400000000000' },
      timestamp: 1758000000000,
      message: { mid: 'mid-abc-1', text: 'olá, tenho uma pergunta' },
      ...extra
    }]
  }]
});

function assinar(corpoBruto, segredo = APP_SECRET) {
  return 'sha256=' + createHmac('sha256', segredo).update(corpoBruto, 'utf8').digest('hex');
}

/**
 * Pedido no formato que a Vercel entrega: um stream reproduzível
 * (`restoreBody`) mais a `body` já parseada.
 */
function pedido({ metodo = 'POST', bruto = null, assinatura = null, query = {}, comStream = true } = {}) {
  const req = comStream && bruto !== null
    ? Readable.from([Buffer.from(bruto, 'utf8')])
    : {};
  req.method = metodo;
  req.url = '/api/outreach/meta-webhook';
  req.headers = { 'content-type': 'application/json', ...(assinatura ? { 'x-hub-signature-256': assinatura } : {}) };
  req.query = { rota: ['meta-webhook'], ...query };
  if (bruto !== null) { try { req.body = JSON.parse(bruto); } catch (e) { req.body = {}; } }
  return req;
}

function fingirRes() {
  const r = { _s: 0, _b: null, _h: {}, _texto: null, writableEnded: false };
  r.status = s => { r._s = s; return r; };
  r.json = b => { r._b = b; r.writableEnded = true; return r; };
  r.setHeader = (k, v) => { r._h[k] = v; return r; };
  r.end = (t) => { r._texto = t === undefined ? null : String(t); r.writableEnded = true; return r; };
  return r;
}

const logs = [];
async function chamar(req, env = ENV()) {
  const anterior = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^OUTREACH|^INSTAGRAM|^MANYCHAT|^DATABASE|^SUPABASE/.test(k)) delete process.env[k];
  Object.assign(process.env, env);
  const res = fingirRes();
  const errOriginal = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try { await despachar(req, res); } finally {
    console.error = errOriginal;
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, anterior);
  }
  return res;
}

const limpar = () => { delete globalThis.__outreachMemRepo; logs.length = 0; };

/* ================================================================ *
 * 1–3 · handshake                                                   *
 * ================================================================ */

test('WEBHOOK 1: handshake correto devolve o challenge', async () => {
  limpar();
  const r = await chamar(pedido({ metodo: 'GET', query: {
    'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '1158201444' } }));
  assert.equal(r._s, 200);
  assert.equal(r._texto, '1158201444');
});

test('WEBHOOK 2: verify token errado → 403, sem dizer porquê', async () => {
  limpar();
  const r = await chamar(pedido({ metodo: 'GET', query: {
    'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': '999' } }));
  assert.equal(r._s, 403);
  assert.equal(r._b.errorCode, 'FORBIDDEN');
  /* o token verdadeiro nunca pode ser ecoado numa resposta de erro */
  assert.equal(JSON.stringify(r._b).includes(VERIFY), false);
  assert.equal(JSON.stringify(r._b).includes('999'), false);
});

test('WEBHOOK 3: o challenge é devolvido tal e qual, sem ser tratado como JSON', async () => {
  limpar();
  const r = await chamar(pedido({ metodo: 'GET', query: {
    'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '0012340' } }));
  assert.equal(r._texto, '0012340', 'zeros à esquerda perdidos — foi tratado como número');
  assert.equal(r._h['Content-Type'], 'text/plain');
});

test('WEBHOOK 3b: modo diferente de subscribe é recusado', async () => {
  limpar();
  const r = await chamar(pedido({ metodo: 'GET', query: {
    'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '1' } }));
  assert.equal(r._s, 403);
});

/* ================================================================ *
 * 4–7 · assinatura e corpo                                          *
 * ================================================================ */

test('WEBHOOK 4: assinatura válida é aceite e o evento é processado', async () => {
  limpar();
  const bruto = JSON.stringify(PAYLOAD());
  const r = await chamar(pedido({ bruto, assinatura: assinar(bruto) }));
  assert.equal(r._s, 200);
  assert.equal(r._b.success, true);
  assert.equal(r._b.resumo.recebidos, 1);
});

test('WEBHOOK 5: assinatura inválida → 401 e zero processamento', async () => {
  limpar();
  const bruto = JSON.stringify(PAYLOAD());
  for (const má of [assinar(bruto, 'outro-segredo'), 'sha256=abc', 'sha1=x', null, '']) {
    const r = await chamar(pedido({ bruto, assinatura: má }));
    assert.equal(r._s, 401, 'aceitou assinatura: ' + String(má));
    assert.equal(r._b.errorCode, 'INVALID_SIGNATURE');
  }
  const repo = globalThis.__outreachMemRepo;
  assert.equal(repo ? repo.webhooks.size : 0, 0, 'guardou evento com assinatura inválida');
});

test('WEBHOOK 6: corpo alterado depois de assinado é rejeitado', async () => {
  limpar();
  const original = JSON.stringify(PAYLOAD());
  const assinatura = assinar(original);
  /* mesma estrutura, remetente trocado — o JSON continua válido, mas a
     assinatura já não corresponde. É exatamente o ataque que a
     verificação existe para travar. */
  const alterado = original.replace('99887766', '11112222');
  assert.notEqual(alterado, original);
  const r = await chamar(pedido({ bruto: alterado, assinatura }));
  assert.equal(r._s, 401);
});

test('WEBHOOK 6b: reserializar o JSON quebraria a assinatura — por isso usamos os bytes', async () => {
  limpar();
  const original = JSON.stringify(PAYLOAD());
  const reserializado = JSON.stringify(JSON.parse(original), null, 2);
  assert.notEqual(assinar(original), assinar(reserializado),
    'se estes batessem certo, validar sobre JSON reserializado seria inofensivo — não é');
});

test('WEBHOOK 7: payload inválido → 400, sem persistir nada', async () => {
  limpar();
  for (const mau of ['{ isto não é json', JSON.stringify({ object: 'page', entry: [] }),
                     JSON.stringify({ object: 'instagram' })]) {
    const r = await chamar(pedido({ bruto: mau, assinatura: assinar(mau) }));
    assert.equal(r._s, 400, 'aceitou: ' + mau.slice(0, 24));
  }
  const repo = globalThis.__outreachMemRepo;
  assert.equal(repo ? repo.webhooks.size : 0, 0);
});

test('WEBHOOK 7b: sem corpo original legível recusa em vez de reconstruir', async () => {
  limpar();
  const bruto = JSON.stringify(PAYLOAD());
  /* pedido sem stream: os bytes originais não estão disponíveis */
  const req = pedido({ bruto, assinatura: assinar(bruto), comStream: false });
  const r = await chamar(req);
  assert.equal(r._s, 400);
  assert.equal(r._b.errorCode, 'RAW_BODY_UNAVAILABLE');
});

/* ================================================================ *
 * 8–9 · o evento e o IGSID                                          *
 * ================================================================ */

test('WEBHOOK 8: evento messages válido é persistido como WebhookEvent', async () => {
  limpar();
  const bruto = JSON.stringify(PAYLOAD());
  await chamar(pedido({ bruto, assinatura: assinar(bruto) }));
  const repo = globalThis.__outreachMemRepo;
  assert.equal(repo.webhooks.size, 1);
  const ev = [...repo.webhooks.values()][0];
  assert.equal(ev.provider, 'meta');
  assert.equal(ev.eventType, 'messages');
  assert.equal(ev.providerEventId, 'mid-abc-1', 'devia usar o mid oficial');
});

test('WEBHOOK 9: o IGSID do remetente é extraído tal como vem', async () => {
  limpar();
  const bruto = JSON.stringify(PAYLOAD());
  await chamar(pedido({ bruto, assinatura: assinar(bruto) }));
  const ev = [...globalThis.__outreachMemRepo.webhooks.values()][0];
  assert.equal(ev.payloadRedacted.senderIgsid, '99887766');
  assert.equal(ev.payloadRedacted.accountId, '17841400000000000');
});

test('WEBHOOK 9b: o texto da mensagem não é guardado — só que existe', async () => {
  limpar();
  const bruto = JSON.stringify(PAYLOAD());
  await chamar(pedido({ bruto, assinatura: assinar(bruto) }));
  const ev = [...globalThis.__outreachMemRepo.webhooks.values()][0];
  assert.equal(ev.payloadRedacted.temTexto, true);
  assert.equal(JSON.stringify(ev).includes('tenho uma pergunta'), false,
    'o conteúdo da conversa foi para a base de dados sem necessidade');
});

/* ================================================================ *
 * 10–11 · idempotência                                              *
 * ================================================================ */

test('WEBHOOK 10: o mesmo evento duas vezes conta como duplicado', async () => {
  limpar();
  const bruto = JSON.stringify(PAYLOAD());
  const a = await chamar(pedido({ bruto, assinatura: assinar(bruto) }));
  const b = await chamar(pedido({ bruto, assinatura: assinar(bruto) }));
  assert.equal(a._b.resumo.recebidos, 1);
  assert.equal(b._b.resumo.duplicados, 1);
  assert.equal(b._b.resumo.recebidos, 0);
  assert.equal(globalThis.__outreachMemRepo.webhooks.size, 1);
});

test('WEBHOOK 11: repetição não gera segunda mensagem nem segunda auditoria de receção', async () => {
  limpar();
  const bruto = JSON.stringify(PAYLOAD());
  await chamar(pedido({ bruto, assinatura: assinar(bruto) }));
  await chamar(pedido({ bruto, assinatura: assinar(bruto) }));
  const repo = globalThis.__outreachMemRepo;
  assert.equal(repo.mensagens.size, 0, 'inbound não cria Message — a tabela exige campanha e contacto');
  const recebidos = (await repo.listarAuditoria({ limit: 100, offset: 0 })).items
    .filter(e => e.action === 'META_WEBHOOK_RECEIVED');
  assert.equal(recebidos.length, 1);
});

test('WEBHOOK 11b: sem mid, a impressão digital é determinística e distingue eventos', () => {
  const entrada = { id: 'A' };
  const base = { sender: { id: 'S' }, timestamp: 1 };
  const a = idDoEvento(entrada, { ...base, delivery: { mids: ['x'] } });
  const b = idDoEvento(entrada, { ...base, delivery: { mids: ['x'] } });
  const c = idDoEvento(entrada, { ...base, timestamp: 2, delivery: { mids: ['x'] } });
  assert.equal(a, b, 'o mesmo evento devia dar a mesma impressão digital');
  assert.notEqual(a, c, 'eventos distintos colidiram');
  assert.match(a, /^fp:[0-9a-f]{32}$/);
});

/* ================================================================ *
 * 12–14 · correspondência e opt-out                                 *
 * ================================================================ */

test('WEBHOOK 12/13: inbound sem IGSID no contacto fica UNMATCHED, sem inventar ligação', async () => {
  limpar();
  const { OutreachService } = await import('../providers/outreach/service.mjs');
  const { InMemoryOutreachRepository } = await import('../providers/outreach/repository.mjs');
  globalThis.__outreachMemRepo = new InMemoryOutreachRepository();
  const svc = new OutreachService({ repository: globalThis.__outreachMemRepo, actor: 't', env: { OUTREACH_ENV: 'test' } });
  /* existe um contacto com Instagram — mas o contacto não guarda IGSID,
     por isso ligar os dois seria um palpite */
  await svc.importarContactos({ contacts: [{ leadId: 'L1', normalizedInstagram: 'clinica_alfa', name: 'Clínica Alfa' }] });

  const bruto = JSON.stringify(PAYLOAD());
  const r = await chamar(pedido({ bruto, assinatura: assinar(bruto) }));
  assert.equal(r._b.resumo.semCorrespondencia, 1);
  assert.equal(r._b.resumo.correspondidos, 0);
  const aud = (await globalThis.__outreachMemRepo.listarAuditoria({ limit: 100, offset: 0 })).items;
  const u = aud.find(e => e.action === 'META_INBOUND_UNMATCHED');
  assert.ok(u, 'faltou a auditoria de não correspondência');
  /* o motivo mudou com a migration 005: já existe onde guardar a
     identidade, o que falta é alguém tê-la associado */
  assert.equal(u.metadata.motivo, 'RECIPIENT_NOT_LINKED');
  assert.ok(u.metadata.recipientMascarado, 'faltou o identificador mascarado');
  assert.equal(String(u.metadata.recipientMascarado).includes('99887766'), false, 'o IGSID saiu completo');
});

test('WEBHOOK 14: um inbound não levanta o opt-out', async () => {
  limpar();
  const { OutreachService } = await import('../providers/outreach/service.mjs');
  const { InMemoryOutreachRepository } = await import('../providers/outreach/repository.mjs');
  const repo = new InMemoryOutreachRepository();
  globalThis.__outreachMemRepo = repo;
  const svc = new OutreachService({ repository: repo, actor: 't', env: { OUTREACH_ENV: 'test' } });
  await svc.importarContactos({ contacts: [{ leadId: 'L1', normalizedInstagram: 'clinica_alfa', name: 'C' }] });
  const c = (await svc.listarContactos({ limit: 10, offset: 0 })).items[0];
  await repo.definirOptOut(c.id, true);

  const bruto = JSON.stringify(PAYLOAD());
  await chamar(pedido({ bruto, assinatura: assinar(bruto) }));

  const depois = (await svc.listarContactos({ limit: 10, offset: 0 })).items[0];
  assert.equal(depois.status, 'OPTED_OUT', 'o inbound alterou a política de contacto');
});

/* ================================================================ *
 * 15–18 · segredos e efeitos                                        *
 * ================================================================ */

test('WEBHOOK 15/16: nem o App Secret nem o verify token saem em respostas ou logs', async () => {
  limpar();
  const bruto = JSON.stringify(PAYLOAD());
  const ok = await chamar(pedido({ bruto, assinatura: assinar(bruto) }));
  const má = await chamar(pedido({ bruto, assinatura: 'sha256=x' }));
  const hs = await chamar(pedido({ metodo: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': '1' } }));
  const tudo = JSON.stringify([ok._b, má._b, hs._b, logs]);
  for (const seg of [APP_SECRET, VERIFY, 'IGAA-token-SEGREDO']) {
    assert.equal(tudo.includes(seg), false, 'fuga: ' + seg);
  }
});

test('WEBHOOK 17: o evento é gravado com provider = meta', async () => {
  limpar();
  const bruto = JSON.stringify(PAYLOAD());
  await chamar(pedido({ bruto, assinatura: assinar(bruto) }));
  assert.equal([...globalThis.__outreachMemRepo.webhooks.values()][0].provider, 'meta');
});

test('WEBHOOK 18: receber um inbound NÃO dispara nenhum envio', async () => {
  limpar();
  const saidas = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (u) => { saidas.push(String(u)); throw new Error('bloqueado'); };
  try {
    const bruto = JSON.stringify(PAYLOAD());
    await chamar(pedido({ bruto, assinatura: assinar(bruto) }));
  } finally { globalThis.fetch = original; }
  assert.deepEqual(saidas, [], 'o webhook provocou tráfego de saída');
  const repo = globalThis.__outreachMemRepo;
  assert.equal(repo.fila.size, 0, 'o webhook criou itens de fila');
});

test('WEBHOOK: eventos que não são mensagens são ignorados, não persistidos', async () => {
  limpar();
  const corpo = { object: 'instagram', entry: [{ id: 'A', messaging: [
    { sender: { id: 'S' }, timestamp: 1, read: { mid: 'm' } },
    { sender: { id: 'S' }, timestamp: 2, message: { mid: 'eco', text: 'x', is_echo: true } }
  ] }] };
  const bruto = JSON.stringify(corpo);
  const r = await chamar(pedido({ bruto, assinatura: assinar(bruto) }));
  assert.equal(r._b.resumo.ignorados, 2);
  assert.equal(r._b.resumo.recebidos, 0);
});

/* ================================================================ *
 * 19–20 · arquitetura                                               *
 * ================================================================ */

test('WEBHOOK 19: a rota vive dentro do catch-all', async () => {
  const { ROTAS } = await import('../providers/outreach/routes.mjs');
  assert.equal(typeof ROTAS['meta-webhook'], 'function');
});

test('WEBHOOK 20: continuam 7 Serverless Functions', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const base = new URL('../api/', import.meta.url);
  const contar = (dir) => readdirSync(dir).reduce((n, f) => {
    const u = new URL(f + (statSync(new URL(f, dir)).isDirectory() ? '/' : ''), dir);
    return n + (statSync(u).isDirectory() ? contar(u) : (/\.(js|mjs)$/.test(f) ? 1 : 0));
  }, 0);
  assert.equal(contar(base), 7, 'o número de Serverless Functions mudou');
});

test('WEBHOOK: lerCorpoBruto devolve os bytes tal como chegaram', async () => {
  const texto = '{"a":1,  "b":  "acentuação ç"}';
  const req = Readable.from([Buffer.from(texto, 'utf8')]);
  assert.equal(await lerCorpoBruto(req), texto);
  /* e quando não há stream nem rawBody, devolve null em vez de inventar */
  assert.equal(await lerCorpoBruto({ body: { a: 1 } }), null);
});

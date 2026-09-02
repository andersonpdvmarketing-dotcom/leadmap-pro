/**
 * LeadMap Pro — testes de integração contra PostgreSQL REAL
 * ==========================================================
 * Executam-se apenas quando existe uma base de dados de teste:
 *
 *   OUTREACH_TEST_DATABASE_URL=postgresql://user:pass@host:port/db node --test
 *
 * Sem essa variável, os testes são SALTADOS com uma mensagem explícita —
 * nunca passam por omissão a fingir que validaram alguma coisa.
 *
 * A base indicada é APAGADA e recriada a cada execução: usar apenas uma
 * base de DEV/TEST isolada, nunca produção.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ligar } from '../providers/outreach/pg-client.mjs';

const DSN = process.env.OUTREACH_TEST_DATABASE_URL || null;
const saltar = !DSN;
/* `false` (não `null`) para o runner do Node não interpretar como skip */
const nota = saltar
  ? 'sem OUTREACH_TEST_DATABASE_URL — testes de PostgreSQL saltados'
  : false;

/* Lida da pasta, por ordem, em vez de escrita à mão: uma migration nova
   entrava em produção e a suite continuava a testar o esquema antigo —
   foi o que aconteceu com a 004. */
const MIGRATIONS = readdirSync(new URL('../migrations/', import.meta.url))
  .filter(f => f.endsWith('.sql')).sort().map(f => f.replace(/\.sql$/, ''));
const sql = nome => readFileSync(new URL('../migrations/' + nome + '.sql', import.meta.url), 'utf8');

async function abrir() {
  const c = await ligar(DSN);
  return c;
}

async function aplicarMigrations(c) {
  for (const m of MIGRATIONS) await c.query(sql(m));
}

async function limparDados(c) {
  await c.query(`TRUNCATE outreach.queue_item, outreach.message, outreach.campaign_contact,
                 outreach.campaign, outreach.contact, outreach.template,
                 outreach.instagram_account, outreach.webhook_event, outreach.audit_event
                 RESTART IDENTITY CASCADE`);
}

async function cenarioBase(c, nContactos = 5) {
  await limparDados(c);
  await c.query(`INSERT INTO outreach.instagram_account (id,display_name,username,provider)
                 VALUES ('a1','Conta','conta1','mock')`);
  await c.query(`INSERT INTO outreach.campaign (id,name,account_id,body)
                 VALUES ('k1','Campanha','a1','Olá {{nome}}')`);
  await c.query(`INSERT INTO outreach.contact (id,lead_id,normalized_instagram,name)
                 SELECT 'c'||i,'L'||i,'perfil'||i,'Empresa '||i FROM generate_series(1,$1) i`,
                 [nContactos]);
}

const n = r => Number(r.rows[0] && Object.values(r.rows[0])[0]);

/* ================================================================ *
 * Migrations e schema                                               *
 * ================================================================ */

test('PG: migrations aplicam-se numa base limpa', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await c.query('DROP SCHEMA IF EXISTS outreach CASCADE');
    await aplicarMigrations(c);
    const t = await c.query(`SELECT count(*)::int FROM pg_tables WHERE schemaname='outreach'`);
    assert.equal(n(t), 9, 'esperadas 9 tabelas no esquema outreach');
  } finally { await c.fim(); }
});

test('PG: migrations são idempotentes (segunda aplicação não corrompe)', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await aplicarMigrations(c);
    await aplicarMigrations(c);          /* segunda vez */
    const t = await c.query(`SELECT count(*)::int FROM pg_tables WHERE schemaname='outreach'`);
    assert.equal(n(t), 9);
    const i = await c.query(`SELECT count(*)::int FROM pg_indexes WHERE schemaname='outreach'`);
    assert.ok(n(i) >= 30, 'índices continuam lá: ' + n(i));
  } finally { await c.fim(); }
});

test('PG: constraints críticas existem no catálogo', { skip: nota }, async () => {
  const c = await abrir();
  try {
    const r = await c.query(`
      SELECT c.conname FROM pg_constraint c JOIN pg_namespace ns ON ns.oid=c.connamespace
      WHERE ns.nspname='outreach' AND c.contype IN ('u','f','c')`);
    const nomes = r.rows.map(x => x.conname);
    for (const esperada of ['campaign_contact_uk', 'message_idempotency_uk', 'webhook_event_uk',
                            'instagram_account_provider_username_uk', 'queue_item_message_uk']) {
      assert.ok(nomes.includes(esperada), 'falta a constraint ' + esperada);
    }
    assert.ok(nomes.filter(x => x.endsWith('_fkey')).length >= 9, 'foreign keys em falta');
  } finally { await c.fim(); }
});

test('PG: índices parciais de fila e de contacto existem', { skip: nota }, async () => {
  const c = await abrir();
  try {
    const r = await c.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='outreach'`);
    const porNome = Object.fromEntries(r.rows.map(x => [x.indexname, x.indexdef]));
    assert.match(porNome.queue_item_claim_idx || '', /WHERE \(status = 'PENDING'/);
    assert.match(porNome.contact_instagram_uk || '', /UNIQUE/);
    assert.match(porNome.contact_instagram_uk || '', /WHERE/);
  } finally { await c.fim(); }
});

/* ================================================================ *
 * Constraints em comportamento                                      *
 * ================================================================ */

test('PG: trigger impõe o máximo de 5 contas mesmo por SQL direto', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await limparDados(c);
    for (let i = 1; i <= 5; i++) {
      await c.query(`INSERT INTO outreach.instagram_account (id,display_name,username,provider)
                     VALUES ($1,$2,$3,'mock')`, ['a' + i, 'C' + i, 'conta' + i]);
    }
    await assert.rejects(
      () => c.query(`INSERT INTO outreach.instagram_account (id,display_name,username,provider)
                     VALUES ('a6','C6','conta6','mock')`),
      /MAX_ACCOUNTS/);
    assert.equal(n(await c.query('SELECT count(*)::int FROM outreach.instagram_account')), 5);
  } finally { await c.fim(); }
});

test('PG: contacto duplicado por Instagram é rejeitado', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await limparDados(c);
    await c.query(`INSERT INTO outreach.contact (id,lead_id,normalized_instagram,name)
                   VALUES ('c1','L1','empresa_teste','E1')`);
    await assert.rejects(
      () => c.query(`INSERT INTO outreach.contact (id,lead_id,normalized_instagram,name)
                     VALUES ('c2','L2','empresa_teste','E2')`),
      /contact_instagram_uk|duplicate key/);
  } finally { await c.fim(); }
});

test('PG: o mesmo contacto não entra duas vezes na mesma campanha', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await cenarioBase(c, 1);
    await c.query(`INSERT INTO outreach.campaign_contact (id,campaign_id,contact_id) VALUES ('x1','k1','c1')`);
    await assert.rejects(
      () => c.query(`INSERT INTO outreach.campaign_contact (id,campaign_id,contact_id) VALUES ('x2','k1','c1')`),
      /campaign_contact_uk|duplicate key/);
  } finally { await c.fim(); }
});

test('PG: idempotencyKey duplicada é rejeitada pelo banco', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await cenarioBase(c, 1);
    const ins = `INSERT INTO outreach.message (id,campaign_id,contact_id,account_id,provider,idempotency_key,body)
                 VALUES ($1,'k1','c1','a1','mock','k1:c1:a1:v1','Olá')`;
    await c.query(ins, ['m1']);
    await assert.rejects(() => c.query(ins, ['m2']), /message_idempotency_uk|duplicate key/);
  } finally { await c.fim(); }
});

test('PG: webhook com o mesmo (provider, eventId) é rejeitado', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await limparDados(c);
    const ins = `INSERT INTO outreach.webhook_event (id,provider,provider_event_id,event_type)
                 VALUES ($1,'mock','evt_001','delivered')`;
    await c.query(ins, ['w1']);
    await assert.rejects(() => c.query(ins, ['w2']), /webhook_event_uk|duplicate key/);
    /* outro fornecedor com o mesmo id é outro evento */
    await c.query(`INSERT INTO outreach.webhook_event (id,provider,provider_event_id,event_type)
                   VALUES ('w3','external','evt_001','delivered')`);
  } finally { await c.fim(); }
});

/* ================================================================ *
 * start_campaign                                                    *
 * ================================================================ */

test('PG: start cria fila; repetir não duplica (3 execuções)', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await cenarioBase(c, 100);
    const ids = `ARRAY(SELECT id FROM outreach.contact)`;
    const r1 = await c.query(`SELECT * FROM outreach.start_campaign('k1', ${ids})`);
    assert.equal(Number(r1.rows[0].incluidos), 100);
    assert.equal(Number(r1.rows[0].criados), 100);

    const r2 = await c.query(`SELECT * FROM outreach.start_campaign('k1', ${ids})`);
    const r3 = await c.query(`SELECT * FROM outreach.start_campaign('k1', ${ids})`);
    assert.equal(Number(r2.rows[0].criados), 0);
    assert.equal(Number(r3.rows[0].criados), 0);
    assert.equal(Number(r2.rows[0].ja_existiam), 100);

    assert.equal(n(await c.query(`SELECT count(*)::int FROM outreach.message WHERE campaign_id='k1'`)), 100);
    assert.equal(n(await c.query(`SELECT count(*)::int FROM outreach.queue_item WHERE campaign_id='k1'`)), 100);
    assert.equal(n(await c.query(`SELECT count(*)::int FROM outreach.campaign_contact WHERE campaign_id='k1'`)), 100);
  } finally { await c.fim(); }
});

test('PG: start exclui sem-Instagram e opt-out, com motivo gravado', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await cenarioBase(c, 3);
    await c.query(`INSERT INTO outreach.contact (id,lead_id,name) VALUES ('sem1','LS1','Sem IG')`);
    await c.query(`UPDATE outreach.contact SET opted_out_at = now(), status='OPTED_OUT' WHERE id='c1'`);
    const r = await c.query(`SELECT * FROM outreach.start_campaign('k1', ARRAY(SELECT id FROM outreach.contact))`);
    assert.equal(Number(r.rows[0].incluidos), 2);
    assert.equal(Number(r.rows[0].excluidos), 2);
    const motivos = await c.query(`SELECT skip_reason, count(*)::int AS n FROM outreach.campaign_contact
                                   WHERE campaign_id='k1' AND skip_reason IS NOT NULL GROUP BY 1 ORDER BY 1`);
    const mapa = Object.fromEntries(motivos.rows.map(x => [x.skip_reason, Number(x.n)]));
    assert.equal(mapa.NO_INSTAGRAM, 1);
    assert.equal(mapa.OPTED_OUT, 1);
  } finally { await c.fim(); }
});

test('PG: start numa transação que falha faz rollback total', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await cenarioBase(c, 50);
    await c.query('BEGIN');
    await c.query(`SELECT outreach.start_campaign('k1', ARRAY(SELECT id FROM outreach.contact))`);
    await c.query(`SELECT outreach.start_campaign('NAO-EXISTE', ARRAY['c1'])`).catch(() => {});
    await c.query('ROLLBACK');

    assert.equal(n(await c.query(`SELECT count(*)::int FROM outreach.message WHERE campaign_id='k1'`)), 0,
      'não pode ficar estado parcial');
    assert.equal(n(await c.query(`SELECT count(*)::int FROM outreach.queue_item WHERE campaign_id='k1'`)), 0);
    const st = await c.query(`SELECT status FROM outreach.campaign WHERE id='k1'`);
    assert.equal(st.rows[0].status, 'DRAFT', 'a campanha não ficou meio-iniciada');
  } finally { await c.fim(); }
});

/* ================================================================ *
 * Claim atómico e SKIP LOCKED                                       *
 * ================================================================ */

test('PG: SKIP LOCKED — sessão B salta as linhas bloqueadas por A', { skip: nota }, async () => {
  const a = await abrir();
  const b = await abrir();
  try {
    await cenarioBase(a, 30);
    await a.query(`SELECT outreach.start_campaign('k1', ARRAY(SELECT id FROM outreach.contact))`);

    await a.query('BEGIN');
    const bloqueadas = await a.query(
      `SELECT id FROM outreach.queue_item WHERE campaign_id='k1' AND status='PENDING'
       ORDER BY id LIMIT 10 FOR UPDATE`);
    assert.equal(bloqueadas.rows.length, 10);

    /* B não espera nem rouba: leva as outras 20 */
    const levadas = await b.query(`SELECT id FROM outreach.claim_queue_items('workerB', 100, 300)`);
    assert.equal(levadas.rows.length, 20, 'B devia saltar exatamente as 10 bloqueadas');

    const idsA = new Set(bloqueadas.rows.map(r => r.id));
    assert.ok(levadas.rows.every(r => !idsA.has(r.id)), 'B levou uma linha bloqueada por A');

    await a.query('ROLLBACK');
  } finally { await a.fim(); await b.fim(); }
});

test('PG: 2 workers concorrentes, 100 itens, zero duplicações', { skip: nota }, async () => {
  const c = await abrir();
  const w1 = await abrir();
  const w2 = await abrir();
  try {
    await cenarioBase(c, 100);
    await c.query(`SELECT outreach.start_campaign('k1', ARRAY(SELECT id FROM outreach.contact))`);
    const [r1, r2] = await Promise.all([
      w1.query(`SELECT id FROM outreach.claim_queue_items('w1', 100, 300)`),
      w2.query(`SELECT id FROM outreach.claim_queue_items('w2', 100, 300)`)
    ]);
    const todos = [...r1.rows, ...r2.rows].map(r => r.id);
    assert.equal(todos.length, 100);
    assert.equal(new Set(todos).size, 100, 'houve itens entregues a dois workers');
  } finally { await c.fim(); await w1.fim(); await w2.fim(); }
});

test('PG: 10 workers concorrentes, 1000 itens, zero duplicações', { skip: nota }, async () => {
  const c = await abrir();
  const workers = [];
  try {
    await cenarioBase(c, 1000);
    await c.query(`SELECT outreach.start_campaign('k1', ARRAY(SELECT id FROM outreach.contact))`);
    for (let i = 0; i < 10; i++) workers.push(await abrir());

    const t0 = Date.now();
    const lotes = await Promise.all(
      workers.map((w, i) => w.query(`SELECT id FROM outreach.claim_queue_items('w${i}', 200, 300)`)));
    const ms = Date.now() - t0;

    const todos = lotes.flatMap(l => l.rows.map(r => r.id));
    assert.equal(todos.length, 1000, 'nem todos os itens foram reclamados');
    assert.equal(new Set(todos).size, 1000, 'houve duplicações');
    assert.ok(ms < 30000, 'claim de 1000 por 10 workers demorou ' + ms + ' ms');
  } finally { await c.fim(); for (const w of workers) await w.fim(); }
});

/* ================================================================ *
 * Locks, ciclo de vida e estados terminais                          *
 * ================================================================ */

test('PG: lock fresco não é roubado; lock expirado é recuperado', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await cenarioBase(c, 3);
    await c.query(`SELECT outreach.start_campaign('k1', ARRAY(SELECT id FROM outreach.contact))`);
    await c.query(`SELECT outreach.claim_queue_items('workerA', 1, 300)`);

    const b = await c.query(`SELECT id FROM outreach.claim_queue_items('workerB', 10, 300)`);
    assert.equal(b.rows.length, 2, 'B não pode roubar o item fresco de A');

    await c.query(`UPDATE outreach.queue_item SET locked_at = now() - interval '10 minutes'
                   WHERE locked_by = 'workerA'`);
    const cc = await c.query(`SELECT id FROM outreach.claim_queue_items('workerC', 10, 300)`);
    assert.equal(cc.rows.length, 1, 'passado o timeout o item devia ser recuperável');

    const item = await c.query(`SELECT locked_by, attempt_count FROM outreach.queue_item WHERE id=$1`, [cc.rows[0].id]);
    assert.equal(item.rows[0].locked_by, 'workerC');
    assert.equal(Number(item.rows[0].attempt_count), 2, 'a tentativa recuperada conta');
  } finally { await c.fim(); }
});

test('PG: pause, resume e cancel persistem e respeitam SENT', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await cenarioBase(c, 5);
    await c.query(`SELECT outreach.start_campaign('k1', ARRAY(SELECT id FROM outreach.contact))`);

    await c.query(`SELECT outreach.pause_campaign('k1')`);
    assert.equal((await c.query(`SELECT status FROM outreach.campaign WHERE id='k1'`)).rows[0].status, 'PAUSED');
    assert.equal((await c.query(`SELECT id FROM outreach.claim_queue_items('w', 10, 300)`)).rows.length, 0,
      'campanha pausada não cede itens');

    await c.query(`SELECT outreach.resume_campaign('k1')`);
    assert.equal((await c.query(`SELECT status FROM outreach.campaign WHERE id='k1'`)).rows[0].status, 'RUNNING');
    assert.equal(n(await c.query(`SELECT count(*)::int FROM outreach.message WHERE campaign_id='k1'`)), 5,
      'resume não pode criar mensagens novas');

    const it = await c.query(`SELECT id FROM outreach.claim_queue_items('w1', 1, 300)`);
    await c.query(`SELECT outreach.complete_queue_item($1,'w1','SENT','pm-1',NULL,NULL,NULL)`, [it.rows[0].id]);
    await c.query(`SELECT outreach.cancel_campaign('k1')`);

    const enviado = await c.query(`SELECT status FROM outreach.queue_item WHERE id=$1`, [it.rows[0].id]);
    assert.equal(enviado.rows[0].status, 'SENT', 'cancel não pode desfazer um envio');
    assert.equal(n(await c.query(
      `SELECT count(*)::int FROM outreach.queue_item WHERE campaign_id='k1' AND status='CANCELLED'`)), 4);
  } finally { await c.fim(); }
});

test('PG: SENT é terminal — não reabre nem volta a ser reclamado', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await cenarioBase(c, 2);
    await c.query(`SELECT outreach.start_campaign('k1', ARRAY(SELECT id FROM outreach.contact))`);
    const it = await c.query(`SELECT id, message_id FROM outreach.claim_queue_items('w1', 1, 300)`);
    const id = it.rows[0].id;
    await c.query(`SELECT outreach.complete_queue_item($1,'w1','SENT','pm-1',NULL,NULL,NULL)`, [id]);
    /* worker atrasado tenta marcar falha */
    await c.query(`SELECT outreach.complete_queue_item($1,'w2','FAILED',NULL,'X','erro',NULL)`, [id]);

    const st = await c.query(`SELECT status FROM outreach.queue_item WHERE id=$1`, [id]);
    assert.equal(st.rows[0].status, 'SENT');
    const msg = await c.query(`SELECT provider_message_id, status FROM outreach.message WHERE id=$1`, [it.rows[0].message_id]);
    assert.equal(msg.rows[0].provider_message_id, 'pm-1');
    assert.equal(msg.rows[0].status, 'SENT');

    const reclamados = await c.query(`SELECT id FROM outreach.claim_queue_items('w9', 10, 300)`);
    assert.ok(reclamados.rows.every(r => r.id !== id), 'um item SENT foi reclamado outra vez');
  } finally { await c.fim(); }
});

test('PG: retry persiste availableAt, erro e contagem', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await cenarioBase(c, 1);
    await c.query(`SELECT outreach.start_campaign('k1', ARRAY(SELECT id FROM outreach.contact))`);
    const it = await c.query(`SELECT id FROM outreach.claim_queue_items('w1', 1, 300)`);
    const daqui = new Date(Date.now() + 90000).toISOString();
    await c.query(`SELECT outreach.complete_queue_item($1,'w1','RETRY',NULL,'RATE_LIMITED','limite',$2)`,
                  [it.rows[0].id, daqui]);

    const r = await c.query(`SELECT status, attempt_count, available_at, last_error_code, locked_by
                             FROM outreach.queue_item WHERE id=$1`, [it.rows[0].id]);
    const item = r.rows[0];
    assert.equal(item.status, 'PENDING');
    assert.equal(item.last_error_code, 'RATE_LIMITED');
    assert.equal(Number(item.attempt_count), 1);
    assert.equal(item.locked_by, null, 'o lock tem de ser libertado');
    assert.ok(Date.parse(item.available_at) > Date.now() + 60000, 'o adiamento ficou persistido');

    /* enquanto não chega a hora, não é reclamado */
    assert.equal((await c.query(`SELECT id FROM outreach.claim_queue_items('w2', 10, 300)`)).rows.length, 0);
  } finally { await c.fim(); }
});

test('PG: campanha fica COMPLETED quando não restam itens por processar', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await cenarioBase(c, 2);
    await c.query(`SELECT outreach.start_campaign('k1', ARRAY(SELECT id FROM outreach.contact))`);
    const itens = await c.query(`SELECT id FROM outreach.claim_queue_items('w1', 10, 300)`);
    for (const it of itens.rows) {
      await c.query(`SELECT outreach.complete_queue_item($1,'w1','SENT','pm',NULL,NULL,NULL)`, [it.id]);
    }
    const k = await c.query(`SELECT status, completed_at FROM outreach.campaign WHERE id='k1'`);
    assert.equal(k.rows[0].status, 'COMPLETED');
    assert.ok(k.rows[0].completed_at);
  } finally { await c.fim(); }
});

/* ================================================================ *
 * Segurança                                                         *
 * ================================================================ */

test('PG: SQL injection — o payload é dado, não código', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await limparDados(c);
    await c.query(`INSERT INTO outreach.contact (id,lead_id,normalized_instagram,name)
                   SELECT 'c'||i,'L'||i,'p'||i,'E'||i FROM generate_series(1,10) i`);
    const payload = "' OR 1=1 --";
    await c.query(`INSERT INTO outreach.contact (id,lead_id,name) VALUES ($1,$2,$3)`, ['inj', 'Linj', payload]);

    const lido = await c.query(`SELECT name FROM outreach.contact WHERE id=$1`, ['inj']);
    assert.equal(lido.rows[0].name, payload, 'o payload devia ser guardado tal e qual');

    const filtro = await c.query(`SELECT count(*)::int AS n FROM outreach.contact WHERE name = $1`, [payload]);
    assert.equal(Number(filtro.rows[0].n), 1, 'a query foi alterada pelo payload');

    const total = await c.query(`SELECT count(*)::int AS n FROM outreach.contact`);
    assert.equal(Number(total.rows[0].n), 11);
  } finally { await c.fim(); }
});

test('PG: XSS — o texto é preservado como dado, sem interpretação', { skip: nota }, async () => {
  const c = await abrir();
  try {
    await limparDados(c);
    const xss = '<script>alert(1)</script>';
    await c.query(`INSERT INTO outreach.contact (id,lead_id,name) VALUES ('x','Lx',$1)`, [xss]);
    const r = await c.query(`SELECT name FROM outreach.contact WHERE id='x'`);
    assert.equal(r.rows[0].name, xss, 'o armazenamento preserva o texto; escapar é da UI');
  } finally { await c.fim(); }
});

test('PG: a auditoria gravada não contém credenciais', { skip: nota }, async () => {
  const { InMemoryOutreachRepository } = await import('../providers/outreach/repository.mjs');
  const c = await abrir();
  try {
    await limparDados(c);
    const { redigir } = await import('../providers/outreach/domain.mjs');
    const metadata = redigir({ accessToken: 'TK', apiKey: 'AK', ok: 'visivel' });
    await c.query(`INSERT INTO outreach.audit_event (actor,action,entity_type,entity_id,metadata)
                   VALUES ('op','MESSAGE_SENT','message','m1',$1)`, [JSON.stringify(metadata)]);
    const r = await c.query(`SELECT metadata::text AS m FROM outreach.audit_event LIMIT 1`);
    assert.equal(r.rows[0].m.includes('TK'), false);
    assert.equal(r.rows[0].m.includes('AK'), false);
    assert.match(r.rows[0].m, /visivel/);
  } finally { await c.fim(); }
});

/* ================================================================ *
 * Desempenho real                                                   *
 * ================================================================ */

test('PG: desempenho com 100, 1000 e 3000 contactos', { skip: nota }, async () => {
  const c = await abrir();
  const medidas = {};
  try {
    for (const total of [100, 1000, 3000]) {
      await cenarioBase(c, 0);
      const t0 = Date.now();
      await c.query(`INSERT INTO outreach.contact (id,lead_id,normalized_instagram,name)
                     SELECT 'c'||i,'L'||i,'perfil'||i,'Empresa '||i FROM generate_series(1,$1) i`, [total]);
      const tImport = Date.now() - t0;

      const t1 = Date.now();
      const r = await c.query(`SELECT * FROM outreach.start_campaign('k1', ARRAY(SELECT id FROM outreach.contact))`);
      const tFila = Date.now() - t1;
      assert.equal(Number(r.rows[0].criados), total);

      const t2 = Date.now();
      await c.query(`SELECT * FROM outreach.contact ORDER BY created_at DESC LIMIT 50 OFFSET 0`);
      const tPagina = Date.now() - t2;

      const t3 = Date.now();
      await c.query(`SELECT id FROM outreach.claim_queue_items('perf', 100, 300)`);
      const tClaim = Date.now() - t3;

      medidas[total] = { tImport, tFila, tPagina, tClaim };
      assert.ok(tFila < 60000, total + ' contactos: gerar fila demorou ' + tFila + ' ms');
    }
    globalThis.__pgMedidas = medidas;
  } finally { await c.fim(); }
});

/* ================================================================ *
 * PgOutreachRepository e worker completos contra PostgreSQL real    *
 * ================================================================ */

import { PgOutreachRepository } from '../providers/outreach/pg-repository.mjs';
import { OutreachService } from '../providers/outreach/service.mjs';
import { OutreachWorker } from '../providers/outreach/worker.mjs';
import { MockInstagramProvider } from '../providers/instagram/index.mjs';

async function repoLimpo() {
  const c = await abrir();
  const repo = new PgOutreachRepository(c);
  await limparDados(c);
  return { c, repo };
}

test('PG-REPO: contactos, dedupe e paginação', { skip: nota }, async () => {
  const { c, repo } = await repoLimpo();
  try {
    const a = await repo.upsertContacto({ normalizedInstagram: 'loja_x', name: 'Loja X' });
    const b = await repo.upsertContacto({ normalizedInstagram: 'loja_x', name: 'Loja X', city: 'Lisboa' });
    assert.equal(a.criado, true);
    assert.equal(b.criado, false, 'o segundo upsert não pode criar');
    assert.equal(b.contacto.city, 'Lisboa', 'lacunas são preenchidas');

    for (let i = 0; i < 60; i++) await repo.upsertContacto({ normalizedInstagram: 'p' + i, name: 'N' + i });
    const p1 = await repo.listarContactos({ limit: 50, offset: 0 });
    assert.equal(p1.items.length, 50);
    assert.equal(p1.total, 61);
  } finally { await c.fim(); }
});

test('PG-REPO: teto de 5 contas propagado do banco para o serviço', { skip: nota }, async () => {
  const { c, repo } = await repoLimpo();
  try {
    const service = new OutreachService({ repository: repo, actor: 'op' });
    for (let i = 1; i <= 5; i++) await service.criarConta({ username: 'conta' + i });
    await assert.rejects(() => service.criarConta({ username: 'conta6' }), /Limite máximo de 5/);
  } finally { await c.fim(); }
});

test('PG-REPO: start idempotente através do repositório', { skip: nota }, async () => {
  const { c, repo } = await repoLimpo();
  try {
    const conta = await repo.criarConta({ username: 'loja' });
    const ids = [];
    for (let i = 0; i < 30; i++) {
      const { contacto } = await repo.upsertContacto({ normalizedInstagram: 'q' + i, name: 'N' + i });
      ids.push(contacto.id);
    }
    const k = await repo.criarCampanha({ name: 'C', accountId: conta.id, body: 'Olá {{nome}}' });
    const r1 = await repo.iniciarCampanha(k.id, ids);
    const r2 = await repo.iniciarCampanha(k.id, ids);
    assert.equal(r1.criados, 30);
    assert.equal(r2.criados, 0);
    assert.equal((await repo.listarFila({ campaignId: k.id, limit: 100 })).total, 30);
  } finally { await c.fim(); }
});

test('PG-REPO+WORKER: fluxo completo com o worker contra PostgreSQL', { skip: nota }, async () => {
  const { c, repo } = await repoLimpo();
  try {
    const conta = await repo.criarConta({ username: 'loja' });
    const ids = [];
    for (let i = 0; i < 20; i++) {
      const { contacto } = await repo.upsertContacto({ normalizedInstagram: 'w' + i, name: 'Empresa ' + i, city: 'Lisboa' });
      ids.push(contacto.id);
    }
    const k = await repo.criarCampanha({ name: 'C', accountId: conta.id, body: 'Olá {{nome}} de {{cidade}}' });
    await repo.iniciarCampanha(k.id, ids);

    const provider = new MockInstagramProvider({ script: {} });
    const worker = new OutreachWorker({ repository: repo, provider, workerId: 'w-pg-1' });
    const resumo = await worker.processar({ limit: 20 });

    assert.equal(resumo.reclamados, 20);
    assert.equal(resumo.enviados, 20);
    const fila = await repo.listarFila({ campaignId: k.id, limit: 100 });
    assert.equal(fila.items.filter(i => i.status === 'SENT').length, 20);
    assert.equal((await repo.lerCampanha(k.id)).status, 'COMPLETED');

    const destinos = provider.enviadas.map(e => e.recipient);
    assert.equal(new Set(destinos).size, 20, 'houve envios duplicados');
    /* o template foi resolvido com dados reais */
    assert.match(provider.enviadas[0].message, /^Olá Empresa \d+ de Lisboa$/);

    const audit = await repo.listarAuditoria({ limit: 200 });
    assert.ok(audit.items.some(a => a.action === 'MESSAGE_SENT'));
    assert.equal(JSON.stringify(audit.items).includes('accessToken'), false);
  } finally { await c.fim(); }
});

test('PG-REPO+WORKER: opt-out depois do enqueue impede o envio', { skip: nota }, async () => {
  const { c, repo } = await repoLimpo();
  try {
    const conta = await repo.criarConta({ username: 'loja' });
    const a = (await repo.upsertContacto({ normalizedInstagram: 'sim', name: 'Aceita' })).contacto;
    const b = (await repo.upsertContacto({ normalizedInstagram: 'nao', name: 'Recusa' })).contacto;
    const k = await repo.criarCampanha({ name: 'C', accountId: conta.id, body: 'Olá' });
    await repo.iniciarCampanha(k.id, [a.id, b.id]);

    await repo.definirOptOut(b.id, true);      /* já com o item em fila */

    const provider = new MockInstagramProvider({ script: {} });
    await new OutreachWorker({ repository: repo, provider, workerId: 'w1' }).processar({ limit: 10 });

    const fila = await repo.listarFila({ campaignId: k.id, limit: 10 });
    const doOptOut = fila.items.find(i => i.contactId === b.id);
    assert.equal(doOptOut.status, 'SKIPPED');
    assert.equal(doOptOut.lastErrorCode, 'OPTED_OUT');
    assert.equal(provider.enviadas.length, 1, 'só o contacto que não fez opt-out recebeu');
  } finally { await c.fim(); }
});

test('PG-REPO+WORKER: 10 workers reais, 100 itens, zero duplicações', { skip: nota }, async () => {
  const { c, repo } = await repoLimpo();
  const clientes = [];
  try {
    const conta = await repo.criarConta({ username: 'loja' });
    const ids = [];
    for (let i = 0; i < 100; i++) {
      const { contacto } = await repo.upsertContacto({ normalizedInstagram: 'z' + i, name: 'N' + i });
      ids.push(contacto.id);
    }
    const k = await repo.criarCampanha({ name: 'C', accountId: conta.id, body: 'Olá' });
    await repo.iniciarCampanha(k.id, ids);

    const provider = new MockInstagramProvider({ script: {} });
    const workers = [];
    for (let i = 0; i < 10; i++) {
      const cli = await abrir();
      clientes.push(cli);
      workers.push(new OutreachWorker({ repository: new PgOutreachRepository(cli), provider, workerId: 'wp' + i }));
    }
    const t0 = Date.now();
    await Promise.all(workers.map(w => w.processar({ limit: 20 })));
    const ms = Date.now() - t0;

    const destinos = provider.enviadas.map(e => e.recipient);
    assert.equal(destinos.length, 100, 'nem todos foram processados');
    assert.equal(new Set(destinos).size, 100, 'houve duplicações');
    const fila = await repo.listarFila({ campaignId: k.id, limit: 200 });
    assert.equal(fila.items.filter(i => i.status === 'SENT').length, 100);
    assert.ok(ms < 60000, '10 workers demoraram ' + ms + ' ms');
  } finally { await c.fim(); for (const cli of clientes) await cli.fim(); }
});

test('PG-REPO: retry com retryAfterSec persiste no banco', { skip: nota }, async () => {
  const { c, repo } = await repoLimpo();
  try {
    const conta = await repo.criarConta({ username: 'loja' });
    const { contacto } = await repo.upsertContacto({ normalizedInstagram: 'r1', name: 'R' });
    const k = await repo.criarCampanha({ name: 'C', accountId: conta.id, body: 'Olá' });
    await repo.iniciarCampanha(k.id, [contacto.id]);

    const provider = new MockInstagramProvider({ script: { falharCom: 'RATE_LIMITED', retryAfterSec: 120 } });
    await new OutreachWorker({ repository: repo, provider, workerId: 'w1' }).processar({ limit: 1 });

    const fila = await repo.listarFila({ campaignId: k.id, limit: 10 });
    const item = fila.items[0];
    assert.equal(item.status, 'PENDING');
    assert.equal(item.lastErrorCode, 'RATE_LIMITED');
    assert.equal(item.lockedBy, null);
    assert.ok(Date.parse(item.availableAt) > Date.now() + 60000, 'availableAt respeitou o retryAfterSec');
    /* enquanto não chega a hora, nenhum worker o leva */
    assert.equal((await repo.reclamarItens({ workerId: 'w2', limit: 5 })).length, 0);
  } finally { await c.fim(); }
});

test('PG-REPO: webhook idempotente através do repositório', { skip: nota }, async () => {
  const { c, repo } = await repoLimpo();
  try {
    const a = await repo.registarWebhook({ provider: 'mock', providerEventId: 'e1', eventType: 'delivered', payload: { token: 'SEGREDO', ok: 1 } });
    const b = await repo.registarWebhook({ provider: 'mock', providerEventId: 'e1', eventType: 'delivered' });
    assert.equal(a.duplicado, false);
    assert.equal(b.duplicado, true);
    const r = await c.query(`SELECT payload_redacted::text AS p FROM outreach.webhook_event WHERE provider_event_id='e1'`);
    assert.equal(r.rows[0].p.includes('SEGREDO'), false, 'o payload guardado tem de estar redigido');
  } finally { await c.fim(); }
});

/* ================================================================ *
 * §19 Migration 005 — identidade, contra PostgreSQL real            *
 * ================================================================ */

test('PG-005: a migration aplica e cria colunas, constraint e índices', { skip: nota }, async () => {
  const c = await ligar(DSN);
  try {
    const cols = await c.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='outreach' AND table_name='contact'
        AND column_name IN ('ig_user_id','ig_user_id_provider','ig_user_id_verified_at') ORDER BY 1`);
    assert.deepEqual(cols.rows.map(r => r.column_name),
      ['ig_user_id', 'ig_user_id_provider', 'ig_user_id_verified_at']);

    const idx = await c.query(`SELECT indexname FROM pg_indexes
      WHERE schemaname='outreach' AND indexname='contact_provider_recipient_uk'`);
    assert.equal(idx.rows.length, 1, 'falta o índice único parcial');

    const chk = await c.query(`SELECT conname FROM pg_constraint
      WHERE conname='contact_ig_identity_chk'`);
    assert.equal(chk.rows.length, 1, 'falta a constraint que mantém os dois campos juntos');
  } finally { await c.fim(); }
});

test('PG-005: vários contactos sem identificador continuam válidos', { skip: nota }, async () => {
  const c = await ligar(DSN);
  try {
    await c.query(`DELETE FROM outreach.contact WHERE id LIKE 'id005:%'`);
    for (let i = 1; i <= 4; i++) {
      await c.query(`INSERT INTO outreach.contact (id, name, lead_id) VALUES ($1, $2, $3)`, ['id005:n' + i, 'Sem id ' + i, 'L005n' + i]);
    }
    const r = await c.query(`SELECT count(*) AS n FROM outreach.contact WHERE id LIKE 'id005:n%'`);
    assert.equal(Number(r.rows[0].n), 4, 'o índice único bloqueou NULLs — devia ser parcial');
  } finally { await c.fim(); }
});

test('PG-005: o mesmo destinatário não pode pertencer a dois contactos', { skip: nota }, async () => {
  const c = await ligar(DSN);
  try {
    await c.query(`DELETE FROM outreach.contact WHERE id LIKE 'id005:%'`);
    await c.query(`INSERT INTO outreach.contact (id, name, lead_id, ig_user_id, ig_user_id_provider)
                   VALUES ('id005:a', 'A', 'L005a', '778899', 'meta')`);
    let bloqueou = false;
    try {
      await c.query(`INSERT INTO outreach.contact (id, name, lead_id, ig_user_id, ig_user_id_provider)
                     VALUES ('id005:b', 'B', 'L005b', '778899', 'meta')`);
    } catch (e) { bloqueou = true; }
    assert.equal(bloqueou, true, 'o banco deixou dois contactos ficar com o mesmo destinatário');

    /* o MESMO identificador noutro fornecedor é outra identidade */
    await c.query(`INSERT INTO outreach.contact (id, name, lead_id, ig_user_id, ig_user_id_provider)
                   VALUES ('id005:c', 'C', 'L005c', '778899', 'manychat')`);
    const r = await c.query(`SELECT count(*) AS n FROM outreach.contact WHERE ig_user_id = '778899'`);
    assert.equal(Number(r.rows[0].n), 2);
  } finally { await c.fim(); }
});

test('PG-005: identificador sem fornecedor é recusado pela constraint', { skip: nota }, async () => {
  const c = await ligar(DSN);
  try {
    await c.query(`DELETE FROM outreach.contact WHERE id LIKE 'id005:%'`);
    let bloqueou = false;
    try {
      await c.query(`INSERT INTO outreach.contact (id, name, lead_id, ig_user_id) VALUES ('id005:x', 'X', 'L005x', '111')`);
    } catch (e) { bloqueou = true; }
    assert.equal(bloqueou, true, 'aceitou um identificador sem dizer de que fornecedor é');
  } finally { await c.fim(); }
});

test('PG-005: dados anteriores à migration continuam intactos', { skip: nota }, async () => {
  const c = await ligar(DSN);
  try {
    await c.query(`DELETE FROM outreach.contact WHERE id LIKE 'id005:%'`);
    await c.query(`INSERT INTO outreach.contact (id, name, normalized_instagram, email)
                   VALUES ('id005:antigo', 'Antigo', 'perfil_antigo', 'a@b.pt')`);
    const r = await c.query(`SELECT name, normalized_instagram, email, ig_user_id
                               FROM outreach.contact WHERE id = 'id005:antigo'`);
    assert.equal(r.rows[0].name, 'Antigo');
    assert.equal(r.rows[0].normalized_instagram, 'perfil_antigo');
    assert.equal(r.rows[0].email, 'a@b.pt');
    assert.equal(r.rows[0].ig_user_id, null);
    await c.query(`DELETE FROM outreach.contact WHERE id LIKE 'id005:%'`);
  } finally { await c.fim(); }
});

test('PG-005: associarRecipient pelo repositório respeita o conflito', { skip: nota }, async () => {
  const { PgOutreachRepository } = await import('../providers/outreach/pg-repository.mjs');
  const c = await ligar(DSN);
  /* o repositório recebe a ligação já aberta, como nos outros testes */
  const repo = new PgOutreachRepository(c);
  try {
    await c.query(`DELETE FROM outreach.contact WHERE id LIKE 'id005:%'`);
    await c.query(`INSERT INTO outreach.contact (id, name, lead_id) VALUES ('id005:p1', 'P1', 'L005p1'), ('id005:p2', 'P2', 'L005p2')`);
    await repo.associarRecipient({ contactId: 'id005:p1', provider: 'meta', recipientId: '424242', verificado: true });
    const dono = await repo.contactoPorRecipient('meta', '424242');
    assert.equal(dono.id, 'id005:p1');
    await assert.rejects(
      () => repo.associarRecipient({ contactId: 'id005:p2', provider: 'meta', recipientId: '424242' }),
      (e) => e.errorCode === 'RECIPIENT_ALREADY_LINKED');
    await c.query(`DELETE FROM outreach.contact WHERE id LIKE 'id005:%'`);
  } finally { await c.fim(); }
});

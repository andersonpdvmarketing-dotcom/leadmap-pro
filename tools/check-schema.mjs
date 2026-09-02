#!/usr/bin/env node
/**
 * LeadMap Pro — verificar o esquema real do Outreach
 * ==================================================
 *   OUTREACH_ADMIN_DATABASE_URL=postgresql://… node tools/check-schema.mjs
 *
 * Lê o catálogo do PostgreSQL e confirma que o esquema `outreach` tem o
 * que as migrations prometem: as 9 tabelas, as constraints que impedem
 * duplicados, os índices parciais, as funções e o trigger do teto de
 * contas. Só faz SELECT — não altera nada.
 *
 * Serve para responder à pergunta certa depois de aplicar migrations:
 * não "correu sem erro?", mas "o que existe lá dentro é o que era
 * suposto existir?".
 */

import { ligar } from '../providers/outreach/pg-client.mjs';

const TABELAS = ['instagram_account', 'contact', 'template', 'campaign',
  'campaign_contact', 'message', 'queue_item', 'audit_event', 'webhook_event'];

const CONSTRAINTS = [
  ['instagram_account', 'UNIQUE(provider, username)'],
  ['campaign_contact', 'UNIQUE(campaign_id, contact_id)'],
  ['message', 'UNIQUE(idempotency_key)'],
  ['queue_item', 'UNIQUE(message_id)'],
  ['webhook_event', 'UNIQUE(provider, provider_event_id)']
];

const FUNCOES = ['claim_queue_items', 'complete_queue_item', 'start_campaign',
  'pause_campaign', 'resume_campaign', 'cancel_campaign', 'enforce_max_accounts', 'touch_updated_at'];

const dsn = process.env.OUTREACH_ADMIN_DATABASE_URL || '';
if (!dsn) { console.error('Falta OUTREACH_ADMIN_DATABASE_URL.'); process.exit(1); }

const cli = await ligar(dsn);
console.log('Ligado:', JSON.stringify(cli.descricaoSegura()), '\n');

let problemas = 0;
const falta = (o) => { problemas += 1; console.log('  ✗ EM FALTA: ' + o); };

/* ---- tabelas ---- */
const t = await cli.query(
  "SELECT tablename FROM pg_tables WHERE schemaname = 'outreach' ORDER BY tablename");
const achadas = t.rows.map(r => r.tablename);
console.log('Tabelas em `outreach`: ' + achadas.length);
for (const n of TABELAS) achadas.includes(n) ? console.log('  ✓ ' + n) : falta('tabela ' + n);
const extra = achadas.filter(n => !TABELAS.includes(n));
if (extra.length) console.log('  ⓘ tabelas não previstas: ' + extra.join(', '));

/* ---- constraints únicas ---- */
console.log('\nConstraints de unicidade:');
const c = await cli.query(`
  SELECT rel.relname AS tabela, con.conname AS nome
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
   WHERE ns.nspname = 'outreach' AND con.contype = 'u'`);
const porTabela = {};
for (const r of c.rows) (porTabela[r.tabela] = porTabela[r.tabela] || []).push(r.nome);
for (const [tab, desc] of CONSTRAINTS) {
  (porTabela[tab] || []).length ? console.log('  ✓ ' + tab + ' → ' + desc) : falta(desc + ' em ' + tab);
}

/* ---- índices parciais ---- */
const i = await cli.query(
  "SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'outreach' AND indexdef LIKE '%WHERE%'");
const ti = await cli.query("SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'outreach'");
console.log('\nÍndices: ' + ti.rows[0].n + ' (dos quais ' + i.rows[0].n + ' parciais)');
if (Number(i.rows[0].n) < 1) falta('índices parciais');

/* ---- funções ---- */
console.log('\nFunções:');
const f = await cli.query(`
  SELECT p.proname AS nome FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'outreach'`);
const nomes = f.rows.map(r => r.nome);
for (const n of FUNCOES) nomes.includes(n) ? console.log('  ✓ ' + n) : falta('função ' + n);

/* ---- trigger do teto de contas ---- */
const g = await cli.query(`
  SELECT t.tgname AS nome FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'outreach' AND NOT t.tgisinternal`);
console.log('\nTriggers: ' + g.rows.length);
for (const r of g.rows) console.log('  · ' + r.nome);
if (!g.rows.length) falta('trigger do teto de contas');

/* ---- Conversation continua ausente de propósito (§23) ---- */
console.log('\nConversation: ' + (achadas.includes('conversation')
  ? '⚠ existe — não devia, não há provider validado'
  : 'ausente, como esperado (sem provider real não há inbound)'));

await cli.fim();

console.log('\n' + (problemas === 0
  ? 'ESQUEMA CONFORME.'
  : 'ESQUEMA COM ' + problemas + ' PROBLEMA(S) — não usar em produção.'));
process.exit(problemas === 0 ? 0 : 2);

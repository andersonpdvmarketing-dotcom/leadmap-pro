#!/usr/bin/env node
/**
 * LeadMap Pro — aplicar migrations do Outreach
 * ============================================
 *   OUTREACH_ADMIN_DATABASE_URL=postgresql://… node tools/apply-migrations.mjs
 *   … node tools/apply-migrations.mjs --dry-run    (só mostra o plano)
 *
 * CANAL ADMINISTRATIVO, NÃO ROTA (§20)
 * ------------------------------------
 * As migrations executam DDL. Uma rota HTTP capaz de fazer DDL é uma
 * rota capaz de destruir a base de dados, por isso não existe nenhuma:
 * `/api/outreach/migrate` não foi criada e não deve ser.
 *
 * Esta ferramenta corre da máquina de quem administra, com uma ligação
 * direta ao PostgreSQL — o adapter HTTP não consegue executar DDL.
 *
 * A variável é propositadamente `OUTREACH_ADMIN_DATABASE_URL`, distinta
 * de `OUTREACH_TEST_DATABASE_URL` (testes) e de `OUTREACH_DB_URL`
 * (runtime, que é uma URL de PostgREST e não uma DSN). Assim não há
 * forma de apontar sem querer as migrations para a base errada.
 *
 * As migrations são idempotentes: `IF NOT EXISTS` e `CREATE OR REPLACE`.
 * Correr duas vezes não corrompe nada.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ligar } from '../providers/outreach/pg-client.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(RAIZ, 'migrations');

const dsn = process.env.OUTREACH_ADMIN_DATABASE_URL || '';
const soVer = process.argv.includes('--dry-run');

if (!dsn) {
  console.error('Falta OUTREACH_ADMIN_DATABASE_URL.');
  console.error('Exemplo: OUTREACH_ADMIN_DATABASE_URL=postgresql://user:pass@host:5432/db node tools/apply-migrations.mjs');
  process.exit(1);
}

/* Guarda contra o pior engano possível: aplicar DDL na base de testes.
   Compara a base de dados, não o host nem a porta — uma base de
   administração legítima pode viver em qualquer porta, e recusar por
   número seria recusar o caso normal. */
function nomeDaBase(u) {
  try { return decodeURIComponent(new URL(u).pathname.slice(1)) || null; } catch (e) { return null; }
}
const alvo = nomeDaBase(dsn);
const daSuite = nomeDaBase(process.env.OUTREACH_TEST_DATABASE_URL || '');
if (alvo && daSuite && alvo === daSuite) {
  console.error('Esta DSN aponta para a base da suite de testes (' + alvo + '). Recusado.');
  process.exit(1);
}

const ficheiros = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
if (!ficheiros.length) { console.error('Não há migrations em migrations/.'); process.exit(1); }

console.log('Migrations encontradas (por ordem):');
for (const f of ficheiros) {
  const linhas = readFileSync(join(DIR, f), 'utf8').split('\n').length;
  console.log('  · ' + f + '  (' + linhas + ' linhas)');
}

if (soVer) {
  console.log('\n--dry-run: nada foi executado.');
  process.exit(0);
}

const cli = await ligar(dsn);
console.log('\nLigado a PostgreSQL:', JSON.stringify(cli.descricaoSegura()));

const registo = [];
let falhou = false;

for (const f of ficheiros) {
  const sql = readFileSync(join(DIR, f), 'utf8');
  const t0 = Date.now();
  try {
    await cli.query(sql);
    const ms = Date.now() - t0;
    registo.push({ migration: f, resultado: 'OK', ms });
    console.log('  ✓ ' + f + '  (' + ms + ' ms)');
  } catch (err) {
    /* mensagem sanitizada: o erro do PostgreSQL pode citar valores */
    const codigo = (err && err.code) || 'ERRO';
    registo.push({ migration: f, resultado: 'FALHOU', codigo });
    console.error('  ✗ ' + f + '  → ' + codigo);
    console.error('    (mensagem completa omitida de propósito; ver o log do servidor)');
    falhou = true;
    break;                                        /* não continuar sobre um esquema partido */
  }
}

await cli.fim();

console.log('\nRegisto:');
console.log(JSON.stringify({ timestamp: new Date().toISOString(), registo }, null, 2));

if (falhou) process.exit(2);

console.log('\nMigrations aplicadas. Verifique o esquema com tools/check-schema.mjs.');

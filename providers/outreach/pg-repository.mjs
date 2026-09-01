/**
 * LeadMap Pro — PgOutreachRepository (protocolo nativo)
 * =====================================================
 * Implementação de `OutreachRepository` sobre uma ligação PostgreSQL
 * nativa (`pg-client.mjs`), sem dependências npm.
 *
 * PORQUÊ ESTA CLASSE EXISTE, A PAR DE postgres.mjs
 * ------------------------------------------------
 * A auditoria desta fase mostrou que o adapter HTTP (PostgREST) tem dois
 * limites reais:
 *   · não executa DDL — não consegue aplicar as migrations;
 *   · cada pedido é a sua própria transação — não permite abrir uma
 *     transação que atravesse vários passos, nem manter linhas
 *     bloqueadas enquanto outra sessão tenta reclamá-las.
 *
 * Para o RUNTIME, o adapter HTTP chega: todas as operações compostas já
 * estavam empacotadas em funções SQL, e cada RPC é uma transação. Mas
 * para MIGRATIONS e para provar o `SKIP LOCKED` era preciso falar o
 * protocolo. Esta classe cobre isso e serve igualmente como adapter de
 * produção quando existe acesso direto ao PostgreSQL.
 *
 * Todas as queries são parametrizadas ($1, $2…): os valores viajam
 * separados do texto, pelo protocolo estendido.
 */

import { OutreachRepository, RepositoryError } from './repository.mjs';
import { redigir } from './domain.mjs';
import { ligar } from './pg-client.mjs';

const camel = r => {
  if (!r) return r;
  const o = {};
  for (const [k, v] of Object.entries(r)) {
    o[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  /* inteiros vêm como texto no protocolo; converter os que o domínio usa */
  for (const campo of ['attemptCount', 'maxAttempts', 'priority', 'messageVersion']) {
    if (o[campo] != null) o[campo] = Number(o[campo]);
  }
  if (typeof o.capabilities === 'string') { try { o.capabilities = JSON.parse(o.capabilities); } catch (e) { o.capabilities = {}; } }
  return o;
};

export class PgOutreachRepository extends OutreachRepository {
  /** @param {PgClient|string|object} ligacao cliente já aberto, DSN ou config */
  constructor(ligacao) {
    super();
    this.cliente = (ligacao && typeof ligacao.query === 'function') ? ligacao : null;
    this.config = this.cliente ? null : ligacao;
  }

  async cli() {
    if (!this.cliente) {
      if (!this.config) throw new RepositoryError('NOT_CONFIGURED', 'Sem ligação PostgreSQL configurada.');
      this.cliente = await ligar(this.config);
    }
    return this.cliente;
  }

  async q(sql, params) {
    const c = await this.cli();
    try { return await c.query(sql, params); }
    catch (err) {
      const m = String(err && err.message);
      if (/MAX_ACCOUNTS/.test(m)) throw new RepositoryError('MAX_ACCOUNTS', 'Limite máximo de 5 contas conectadas.');
      if (/CAMPAIGN_TERMINAL/.test(m)) throw new RepositoryError('CAMPAIGN_TERMINAL', m);
      if (err && err.code === '23505') throw new RepositoryError('DUPLICATE', m);
      if (err && err.code === '23503') throw new RepositoryError('NOT_FOUND', m);
      throw new RepositoryError('DB_ERROR', m);
    }
  }

  async disponivel() {
    try { await this.q('SELECT 1'); return true; } catch (e) { return false; }
  }

  /** Aplica as migrations por ordem. Só possível com protocolo nativo. */
  async aplicarMigrations(sqls) {
    for (const sql of sqls) await this.q(sql);
    return true;
  }

  /* ---------- contas ---------- */

  async criarConta({ displayName, username, provider = 'mock', providerAccountId = null, capabilities = {} }) {
    const id = 'acc:' + provider + ':' + username;
    const r = await this.q(
      `INSERT INTO outreach.instagram_account (id,display_name,username,provider,provider_account_id,capabilities)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [id, displayName || username, username, provider, providerAccountId, JSON.stringify(capabilities)]);
    return camel(r.rows[0]);
  }

  async listarContas() {
    const r = await this.q(`SELECT * FROM outreach.instagram_account WHERE disabled_at IS NULL ORDER BY created_at`);
    return r.rows.map(camel);
  }

  /* ---------- contactos ---------- */

  async upsertContacto(d) {
    const chave = d.normalizedInstagram ? 'ig:' + d.normalizedInstagram : 'lead:' + d.leadId;
    const r = await this.q(
      `INSERT INTO outreach.contact (id,lead_id,normalized_instagram,name,company,city,district,activity,source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (normalized_instagram) WHERE normalized_instagram IS NOT NULL
       DO UPDATE SET
         company  = COALESCE(outreach.contact.company,  EXCLUDED.company),
         city     = COALESCE(outreach.contact.city,     EXCLUDED.city),
         district = COALESCE(outreach.contact.district, EXCLUDED.district),
         activity = COALESCE(outreach.contact.activity, EXCLUDED.activity)
       RETURNING *, (xmax = 0) AS criado`,
      ['con:' + chave, d.leadId || null, d.normalizedInstagram || null, d.name || 'Sem nome',
       d.company || null, d.city || null, d.district || null, d.activity || null, d.source || null]);
    const linha = r.rows[0];
    return { contacto: camel(linha), criado: linha.criado === 't' || linha.criado === true };
  }

  async listarContactos({ limit = 50, offset = 0, status = null } = {}) {
    const r = status
      ? await this.q(`SELECT * FROM outreach.contact WHERE status=$3 ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset, status])
      : await this.q(`SELECT * FROM outreach.contact ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
    const t = status
      ? await this.q(`SELECT count(*)::int AS n FROM outreach.contact WHERE status=$1`, [status])
      : await this.q(`SELECT count(*)::int AS n FROM outreach.contact`);
    return { total: Number(t.rows[0].n), items: r.rows.map(camel) };
  }

  async definirOptOut(contactId, optOut = true) {
    const r = await this.q(
      `UPDATE outreach.contact SET status=$2, opted_out_at=$3 WHERE id=$1 RETURNING *`,
      [contactId, optOut ? 'OPTED_OUT' : 'UNKNOWN', optOut ? new Date().toISOString() : null]);
    if (!r.rows.length) throw new RepositoryError('NOT_FOUND', 'Contacto não encontrado.');
    return camel(r.rows[0]);
  }

  /* ---------- templates ---------- */

  async criarTemplate({ name, body }) {
    const id = 'tpl:' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 8);
    const r = await this.q(`INSERT INTO outreach.template (id,name,body) VALUES ($1,$2,$3) RETURNING *`, [id, name, body]);
    return camel(r.rows[0]);
  }
  async listarTemplates({ limit = 50, offset = 0 } = {}) {
    const r = await this.q(`SELECT * FROM outreach.template WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
    const t = await this.q(`SELECT count(*)::int AS n FROM outreach.template WHERE deleted_at IS NULL`);
    return { total: Number(t.rows[0].n), items: r.rows.map(camel) };
  }
  async atualizarTemplate(id, campos) {
    const r = await this.q(
      `UPDATE outreach.template SET name = COALESCE($2,name), body = COALESCE($3,body)
       WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
      [id, campos.name ?? null, campos.body ?? null]);
    if (!r.rows.length) throw new RepositoryError('NOT_FOUND', 'Template não encontrado.');
    return camel(r.rows[0]);
  }
  async apagarTemplate(id) {
    await this.q(`UPDATE outreach.template SET deleted_at = now() WHERE id=$1`, [id]);
    return true;
  }

  /* ---------- campanhas ---------- */

  async criarCampanha({ name, accountId, templateId = null, body }) {
    const id = 'cmp:' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 8);
    const r = await this.q(
      `INSERT INTO outreach.campaign (id,name,account_id,template_id,body) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, name, accountId, templateId, body]);
    return camel(r.rows[0]);
  }
  async lerCampanha(id) {
    const r = await this.q(`SELECT * FROM outreach.campaign WHERE id=$1`, [id]);
    return r.rows.length ? camel(r.rows[0]) : null;
  }
  async listarCampanhas({ limit = 50, offset = 0 } = {}) {
    const r = await this.q(`SELECT * FROM outreach.campaign ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
    const t = await this.q(`SELECT count(*)::int AS n FROM outreach.campaign`);
    return { total: Number(t.rows[0].n), items: r.rows.map(camel) };
  }

  async iniciarCampanha(campaignId, contactIds) {
    const r = await this.q(`SELECT * FROM outreach.start_campaign($1, $2::text[])`,
      [campaignId, '{' + contactIds.map(x => '"' + String(x).replace(/"/g, '\\"') + '"').join(',') + '}']);
    const l = r.rows[0] || {};
    return {
      incluidos: Number(l.incluidos) || 0, excluidos: Number(l.excluidos) || 0,
      criados: Number(l.criados) || 0, jaExistiam: Number(l.ja_existiam) || 0
    };
  }
  async pausarCampanha(id) { return Number((await this.q(`SELECT outreach.pause_campaign($1) AS n`, [id])).rows[0].n) || 0; }
  async retomarCampanha(id) { return Number((await this.q(`SELECT outreach.resume_campaign($1) AS n`, [id])).rows[0].n) || 0; }
  async cancelarCampanha(id) { return Number((await this.q(`SELECT outreach.cancel_campaign($1) AS n`, [id])).rows[0].n) || 0; }

  /* ---------- fila ---------- */

  async reclamarItens({ workerId, limit = 1, lockTimeoutSeg = 300 } = {}) {
    const r = await this.q(`SELECT * FROM outreach.claim_queue_items($1,$2,$3)`, [workerId, limit, lockTimeoutSeg]);
    return r.rows.map(camel);
  }

  async concluirItem({ itemId, outcome, providerMessageId = null, errorCode = null, errorMessage = null, availableAt = null }) {
    const r = await this.q(
      `SELECT * FROM outreach.complete_queue_item($1,$2,$3,$4,$5,$6,$7::timestamptz)`,
      [itemId, null, outcome, providerMessageId, errorCode, errorMessage, availableAt]);
    return camel(r.rows[0]);
  }

  async listarFila({ campaignId = null, status = null, limit = 50, offset = 0 } = {}) {
    const r = await this.q(
      `SELECT * FROM outreach.queue_item
        WHERE ($3::text IS NULL OR campaign_id=$3) AND ($4::text IS NULL OR status=$4)
        ORDER BY created_at LIMIT $1 OFFSET $2`, [limit, offset, campaignId, status]);
    const t = await this.q(
      `SELECT count(*)::int AS n FROM outreach.queue_item
        WHERE ($1::text IS NULL OR campaign_id=$1) AND ($2::text IS NULL OR status=$2)`, [campaignId, status]);
    return { total: Number(t.rows[0].n), items: r.rows.map(camel) };
  }

  async lerMensagem(id) {
    const r = await this.q(`SELECT * FROM outreach.message WHERE id=$1`, [id]);
    return r.rows.length ? camel(r.rows[0]) : null;
  }
  async lerItem(id) {
    const r = await this.q(`SELECT * FROM outreach.queue_item WHERE id=$1`, [id]);
    return r.rows.length ? camel(r.rows[0]) : null;
  }
  async lerContacto(id) {
    const r = await this.q(`SELECT * FROM outreach.contact WHERE id=$1`, [id]);
    return r.rows.length ? camel(r.rows[0]) : null;
  }

  /* ---------- auditoria e webhooks ---------- */

  async registarAuditoria({ actor, action, entityType = null, entityId = null, metadata = {} }) {
    /* redigido ANTES de tocar no banco */
    await this.q(
      `INSERT INTO outreach.audit_event (actor,action,entity_type,entity_id,metadata)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [actor, action, entityType, entityId, JSON.stringify(redigir(metadata))]);
    return true;
  }

  async listarAuditoria({ limit = 50, offset = 0, entityId = null, action = null } = {}) {
    const r = await this.q(
      `SELECT * FROM outreach.audit_event
        WHERE ($3::text IS NULL OR entity_id=$3) AND ($4::text IS NULL OR action=$4)
        ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset, entityId, action]);
    return { total: r.rows.length, items: r.rows.map(camel) };
  }

  async registarWebhook({ provider, providerEventId, eventType, payload = {} }) {
    try {
      const r = await this.q(
        `INSERT INTO outreach.webhook_event (id,provider,provider_event_id,event_type,payload_redacted)
         VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
        ['wh:' + provider + ':' + providerEventId, provider, providerEventId, eventType,
         JSON.stringify(redigir(payload))]);
      return { evento: camel(r.rows[0]), duplicado: false };
    } catch (err) {
      if (err instanceof RepositoryError && err.errorCode === 'DUPLICATE') return { evento: null, duplicado: true };
      throw err;
    }
  }
}

/**
 * LeadMap Pro — PostgresOutreachRepository
 * ========================================
 * Implementação de `OutreachRepository` sobre PostgreSQL.
 *
 * PORQUÊ HTTP E NÃO UM DRIVER npm
 * -------------------------------
 * Neste repositório o `package.json` está no .gitignore por decisão
 * anterior do projeto: nenhuma dependência npm é versionada, portanto um
 * driver como `pg` não chega ao deployment. Em vez de mudar essa decisão
 * às escondidas, esta implementação fala com o PostgreSQL por HTTP,
 * usando apenas `fetch` — disponível nativamente no runtime da Vercel.
 *
 * Toda a atomicidade vive em funções SQL (migrations/003), invocadas por
 * RPC. É lá que está o `FOR UPDATE SKIP LOCKED`: o claim continua a ser
 * garantido pelo PostgreSQL, não por código JavaScript.
 *
 * Trocar para um driver nativo é implementar esta mesma classe outra vez
 * — o domínio, a API e os testes não mudam.
 *
 * SEGURANÇA
 *  · a chave de serviço vive só no backend, nunca no browser;
 *  · nenhuma query é construída por concatenação: os filtros vão em
 *    parâmetros de query codificados, e as operações compostas passam
 *    por funções SQL com argumentos tipados (§67).
 */

import { OutreachRepository, RepositoryError } from './repository.mjs';
import { redigir } from './domain.mjs';

const TIMEOUT_MS = 12000;

export function lerConfigBanco(env = process.env) {
  return {
    baseUrl: env.OUTREACH_DB_URL || env.SUPABASE_URL || null,
    serviceKey: env.OUTREACH_DB_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || null,
    schema: env.OUTREACH_DB_SCHEMA || 'outreach'
  };
}

export function bancoConfigurado(env = process.env) {
  const c = lerConfigBanco(env);
  return Boolean(c.baseUrl && c.serviceKey);
}

export class PostgresOutreachRepository extends OutreachRepository {
  constructor(config = {}, deps = {}) {
    super();
    const c = { ...lerConfigBanco(deps.env || (typeof process !== 'undefined' ? process.env : {})), ...config };
    this.baseUrl = c.baseUrl ? String(c.baseUrl).replace(/\/+$/, '') : null;
    this.serviceKey = c.serviceKey || null;
    this.schema = c.schema || 'outreach';
    this.fetchImpl = deps.fetch || null;
  }

  async disponivel() { return Boolean(this.baseUrl && this.serviceKey); }

  exigirConfig() {
    if (!this.baseUrl || !this.serviceKey) {
      throw new RepositoryError('NOT_CONFIGURED',
        'Base de dados do Outreach não configurada (OUTREACH_DB_URL / OUTREACH_DB_SERVICE_KEY).');
    }
  }

  cabecalhos(extra = {}) {
    const headers = {
      apikey: this.serviceKey,
      'Content-Type': 'application/json',
      'Accept-Profile': this.schema,
      'Content-Profile': this.schema,
    };

    if (!String(this.serviceKey).startsWith('sb_secret_')) {
      headers.Authorization = 'Bearer ' + this.serviceKey;
    }

    return {
      ...headers,
      ...extra
    };
  }

  async pedir(caminho, { metodo = 'GET', corpo = null, prefer = null } = {}) {
    this.exigirConfig();
    const f = this.fetchImpl || globalThis.fetch;
    if (typeof f !== 'function') throw new RepositoryError('NOT_CONFIGURED', 'fetch indisponível.');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let resp;
    try {
      resp = await f(this.baseUrl + caminho, {
        method: metodo,
        headers: this.cabecalhos(prefer ? { Prefer: prefer } : {}),
        body: corpo ? JSON.stringify(corpo) : undefined,
        signal: ctrl.signal
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw new RepositoryError('TIMEOUT', 'A base de dados não respondeu.');
      throw new RepositoryError('NETWORK', (err && err.message) || 'Falha de rede.');
    } finally { clearTimeout(t); }

    let json = null;
    try { json = await resp.json(); } catch (e) { json = null; }

    if (!resp.ok) {
      const msg = (json && (json.message || json.hint || json.details)) || ('HTTP ' + resp.status);
      /* traduzir as constraints do banco para o vocabulário do domínio */
      if (resp.status === 409 || /duplicate key|unique/i.test(String(msg))) {
        throw new RepositoryError('DUPLICATE', String(msg));
      }
      if (/MAX_ACCOUNTS/.test(String(msg))) {
        throw new RepositoryError('MAX_ACCOUNTS', 'Limite máximo de 5 contas registadas.');
      }
      if (/CAMPAIGN_TERMINAL/.test(String(msg))) throw new RepositoryError('CAMPAIGN_TERMINAL', String(msg));
      if (/NOT_FOUND|no_data_found/i.test(String(msg))) throw new RepositoryError('NOT_FOUND', String(msg));
      if (resp.status === 401 || resp.status === 403) throw new RepositoryError('DB_UNAUTHORIZED', 'Credenciais da base de dados recusadas.');
      throw new RepositoryError('DB_ERROR', String(msg));
    }
    return json;
  }

  /** Chamada a uma função SQL — é aqui que vive a atomicidade. */
  rpc(nome, args) { return this.pedir('/rest/v1/rpc/' + encodeURIComponent(nome), { metodo: 'POST', corpo: args }); }

  /** Filtros sempre codificados; nunca interpolação de SQL. */
  q(params) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) p.set(k, String(v));
    const s = p.toString();
    return s ? '?' + s : '';
  }

  /* ---------- contas ---------- */

  async criarConta({ displayName, username, provider = 'mock', providerAccountId = null, capabilities = {} }) {
    const id = 'acc:' + provider + ':' + username;
    const linhas = await this.pedir('/rest/v1/instagram_account', {
      metodo: 'POST', prefer: 'return=representation',
      corpo: [{
        id, display_name: displayName || username, username, provider,
        provider_account_id: providerAccountId, status: 'CONNECTED', capabilities
      }]
    });
    return mapConta(linhas && linhas[0]);
  }

  async listarContas() {
    const linhas = await this.pedir('/rest/v1/instagram_account' + this.q({
      select: '*', disabled_at: 'is.null', order: 'created_at.asc'
    }));
    return (linhas || []).map(mapConta);
  }

  /* ---------- contactos ---------- */

  async upsertContacto(dados) {
    const chave = dados.normalizedInstagram ? 'ig:' + dados.normalizedInstagram : 'lead:' + dados.leadId;
    const linhas = await this.pedir('/rest/v1/contact', {
      metodo: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      corpo: [{
        id: 'con:' + chave,
        lead_id: dados.leadId || null,
        normalized_instagram: dados.normalizedInstagram || null,
        name: dados.name || 'Sem nome',
        company: dados.company || null, city: dados.city || null,
        district: dados.district || null, activity: dados.activity || null,
        source: dados.source || null
      }]
    });
    return { contacto: mapContacto(linhas && linhas[0]), criado: true };
  }

  async listarContactos({ limit = 50, offset = 0, status = null } = {}) {
    const filtros = { select: '*', order: 'created_at.desc', limit, offset };
    if (status) filtros.status = 'eq.' + status;
    const linhas = await this.pedir('/rest/v1/contact' + this.q(filtros));
    return { total: (linhas || []).length, items: (linhas || []).map(mapContacto) };
  }

  async definirOptOut(contactId, optOut = true) {
    const linhas = await this.pedir('/rest/v1/contact' + this.q({ id: 'eq.' + contactId }), {
      metodo: 'PATCH', prefer: 'return=representation',
      corpo: { status: optOut ? 'OPTED_OUT' : 'UNKNOWN', opted_out_at: optOut ? new Date().toISOString() : null }
    });
    if (!linhas || !linhas.length) throw new RepositoryError('NOT_FOUND', 'Contacto não encontrado.');
    return mapContacto(linhas[0]);
  }

  /* ---------- templates ---------- */

  async criarTemplate({ name, body }) {
    const linhas = await this.pedir('/rest/v1/template', {
      metodo: 'POST', prefer: 'return=representation',
      corpo: [{ id: 'tpl:' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 8), name, body }]
    });
    return mapTemplate(linhas && linhas[0]);
  }
  async listarTemplates({ limit = 50, offset = 0 } = {}) {
    const linhas = await this.pedir('/rest/v1/template' + this.q({
      select: '*', deleted_at: 'is.null', order: 'created_at.desc', limit, offset
    }));
    return { total: (linhas || []).length, items: (linhas || []).map(mapTemplate) };
  }
  async atualizarTemplate(id, campos) {
    const corpo = {};
    if (campos.name !== undefined) corpo.name = campos.name;
    if (campos.body !== undefined) corpo.body = campos.body;
    const linhas = await this.pedir('/rest/v1/template' + this.q({ id: 'eq.' + id }), {
      metodo: 'PATCH', prefer: 'return=representation', corpo
    });
    if (!linhas || !linhas.length) throw new RepositoryError('NOT_FOUND', 'Template não encontrado.');
    return mapTemplate(linhas[0]);
  }
  async apagarTemplate(id) {
    await this.pedir('/rest/v1/template' + this.q({ id: 'eq.' + id }), {
      metodo: 'PATCH', corpo: { deleted_at: new Date().toISOString() }
    });
    return true;
  }

  /* ---------- campanhas ---------- */

  async criarCampanha({ name, accountId, templateId = null, body }) {
    const id = 'cmp:' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 8);
    const linhas = await this.pedir('/rest/v1/campaign', {
      metodo: 'POST', prefer: 'return=representation',
      corpo: [{ id, name, account_id: accountId, template_id: templateId, body, status: 'DRAFT' }]
    });
    return mapCampanha(linhas && linhas[0]);
  }

  async lerCampanha(id) {
    const linhas = await this.pedir('/rest/v1/campaign' + this.q({ select: '*', id: 'eq.' + id, limit: 1 }));
    return (linhas && linhas[0]) ? mapCampanha(linhas[0]) : null;
  }

  async listarCampanhas({ limit = 50, offset = 0 } = {}) {
    const linhas = await this.pedir('/rest/v1/campaign' + this.q({
      select: '*', order: 'created_at.desc', limit, offset
    }));
    return { total: (linhas || []).length, items: (linhas || []).map(mapCampanha) };
  }

  /* Operações compostas → funções SQL, numa só transação */
  async iniciarCampanha(campaignId, contactIds) {
    const r = await this.rpc('start_campaign', { p_campaign_id: campaignId, p_contact_ids: contactIds });
    const linha = Array.isArray(r) ? r[0] : r;
    return {
      incluidos: Number(linha.incluidos) || 0, excluidos: Number(linha.excluidos) || 0,
      criados: Number(linha.criados) || 0, jaExistiam: Number(linha.ja_existiam) || 0
    };
  }
  async pausarCampanha(campaignId) { return Number(await this.rpc('pause_campaign', { p_campaign_id: campaignId })) || 0; }
  async retomarCampanha(campaignId) { return Number(await this.rpc('resume_campaign', { p_campaign_id: campaignId })) || 0; }
  async cancelarCampanha(campaignId) { return Number(await this.rpc('cancel_campaign', { p_campaign_id: campaignId })) || 0; }

  /* ---------- fila ---------- */

  async reclamarItens({ workerId, limit = 1, lockTimeoutSeg = 300 } = {}) {
    const linhas = await this.rpc('claim_queue_items', {
      p_worker_id: workerId, p_limit: limit, p_lock_timeout_seconds: lockTimeoutSeg
    });
    return (linhas || []).map(mapItem);
  }

  async concluirItem({ itemId, outcome, providerMessageId = null, errorCode = null, errorMessage = null, availableAt = null }) {
    const linha = await this.rpc('complete_queue_item', {
      p_item_id: itemId, p_worker_id: null, p_outcome: outcome,
      p_provider_message_id: providerMessageId, p_error_code: errorCode,
      p_error_message: errorMessage, p_available_at: availableAt
    });
    return mapItem(Array.isArray(linha) ? linha[0] : linha);
  }

  async listarFila({ campaignId = null, status = null, limit = 50, offset = 0 } = {}) {
    const filtros = { select: '*', order: 'created_at.asc', limit, offset };
    if (campaignId) filtros.campaign_id = 'eq.' + campaignId;
    if (status) filtros.status = 'eq.' + status;
    const linhas = await this.pedir('/rest/v1/queue_item' + this.q(filtros));
    return { total: (linhas || []).length, items: (linhas || []).map(mapItem) };
  }

  async lerMensagem(id) {
    const linhas = await this.pedir('/rest/v1/message' + this.q({ select: '*', id: 'eq.' + id, limit: 1 }));
    return (linhas && linhas[0]) ? mapMensagem(linhas[0]) : null;
  }

  /* O worker chama isto por cada item reclamado, para reavaliar o
     opt-out no momento do envio. Sem este método o worker rebenta
     contra este adapter — que é o único que corre na Vercel. */
  async listarWebhooks({ provider = null, limit = 50 } = {}) {
    const filtros = { select: '*', order: 'received_at.desc', limit };
    if (provider) filtros.provider = 'eq.' + provider;
    const linhas = await this.pedir('/rest/v1/webhook_event' + this.q(filtros));
    return { total: (linhas || []).length, items: (linhas || []).map(r => ({
      id: r.id, provider: r.provider, providerEventId: r.provider_event_id,
      eventType: r.event_type, payloadRedacted: r.payload_redacted || {},
      receivedAt: r.received_at, processedAt: r.processed_at, status: r.status
    })) };
  }

  /** Procura exata por (fornecedor, identificador). */
  async contactoPorRecipient(provider, recipientId) {
    if (!provider || !recipientId) return null;
    const linhas = await this.pedir('/rest/v1/contact' + this.q({
      select: '*', ig_user_id_provider: 'eq.' + provider, ig_user_id: 'eq.' + recipientId, limit: 2
    }));
    if (!linhas || !linhas.length) return null;
    return mapContacto(linhas[0]);
  }

  async associarRecipient({ contactId, provider, recipientId, verificado = false }) {
    const dono = await this.contactoPorRecipient(provider, recipientId);
    if (dono && dono.id !== contactId) {
      throw new RepositoryError('RECIPIENT_ALREADY_LINKED', 'Este destinatário já está associado a outro contacto.');
    }
    const atual = await this.lerContacto(contactId);
    if (!atual) throw new RepositoryError('NOT_FOUND', 'Contacto não encontrado.');
    const jaIgual = atual.igUserId === String(recipientId) && atual.igUserIdProvider === provider;
    if (atual.igUserId && !jaIgual) {
      throw new RepositoryError('RECIPIENT_ALREADY_LINKED', 'O contacto já tem outro destinatário associado.');
    }
    const campos = { ig_user_id: String(recipientId), ig_user_id_provider: provider };
    if (verificado && !atual.igUserIdVerifiedAt) campos.ig_user_id_verified_at = new Date().toISOString();
    const linhas = await this.pedir('/rest/v1/contact' + this.q({ id: 'eq.' + contactId }), {
      metodo: 'PATCH', prefer: 'return=representation', corpo: campos
    });
    return { contacto: mapContacto(linhas && linhas[0]), jaExistia: jaIgual };
  }

  /** Última mensagem recebida deste destinatário, pelos eventos de webhook. */
  async ultimoInboundDe(provider, recipientId) {
    const linhas = await this.pedir('/rest/v1/webhook_event' + this.q({
      select: 'received_at,payload_redacted', provider: 'eq.' + provider,
      'payload_redacted->>senderIgsid': 'eq.' + recipientId,
      order: 'received_at.desc', limit: 1
    }));
    if (!linhas || !linhas.length) return null;
    const l = linhas[0];
    return (l.payload_redacted && l.payload_redacted.at) || l.received_at || null;
  }

  async lerContacto(id) {
    const linhas = await this.pedir('/rest/v1/contact' + this.q({ select: '*', id: 'eq.' + id, limit: 1 }));
    return (linhas && linhas[0]) ? mapContacto(linhas[0]) : null;
  }

  async lerItem(id) {
    const linhas = await this.pedir('/rest/v1/queue_item' + this.q({ select: '*', id: 'eq.' + id, limit: 1 }));
    return (linhas && linhas[0]) ? mapItem(linhas[0]) : null;
  }

  /* ---------- auditoria e webhooks ---------- */

  async registarAuditoria({ actor, action, entityType = null, entityId = null, metadata = {} }) {
    /* redigido ANTES de sair daqui: a base de dados nunca vê um segredo */
    await this.pedir('/rest/v1/audit_event', {
      metodo: 'POST',
      corpo: [{ actor, action, entity_type: entityType, entity_id: entityId, metadata: redigir(metadata) }]
    });
    return true;
  }

  async listarAuditoria({ limit = 50, offset = 0, entityId = null, action = null } = {}) {
    const filtros = { select: '*', order: 'created_at.desc', limit, offset };
    if (entityId) filtros.entity_id = 'eq.' + entityId;
    if (action) filtros.action = 'eq.' + action;
    const linhas = await this.pedir('/rest/v1/audit_event' + this.q(filtros));
    return { total: (linhas || []).length, items: linhas || [] };
  }

  async registarWebhook({ provider, providerEventId, eventType, payload = {} }) {
    try {
      const linhas = await this.pedir('/rest/v1/webhook_event', {
        metodo: 'POST', prefer: 'return=representation',
        corpo: [{
          id: 'wh:' + provider + ':' + providerEventId,
          provider, provider_event_id: providerEventId, event_type: eventType,
          payload_redacted: redigir(payload), status: 'RECEIVED'
        }]
      });
      return { evento: linhas && linhas[0], duplicado: false };
    } catch (err) {
      if (err instanceof RepositoryError && err.errorCode === 'DUPLICATE') {
        return { evento: null, duplicado: true };   /* idempotência de webhook (§35) */
      }
      throw err;
    }
  }
}

/* ---------------------------------------------------------------- *
 * Mapeamento snake_case → camelCase                                 *
 * ---------------------------------------------------------------- */

const mapConta = r => r && ({
  id: r.id, displayName: r.display_name, username: r.username, provider: r.provider,
  providerAccountId: r.provider_account_id, status: r.status, capabilities: r.capabilities || {},
  createdAt: r.created_at, updatedAt: r.updated_at, disabledAt: r.disabled_at
});

const mapContacto = r => r && ({
  id: r.id, leadId: r.lead_id, normalizedInstagram: r.normalized_instagram,
  name: r.name, company: r.company, city: r.city, district: r.district,
  activity: r.activity, source: r.source, status: r.status, optedOutAt: r.opted_out_at,
  email: r.email || null, phone: r.phone || null,
  igUserId: r.ig_user_id || null,
  igUserIdProvider: r.ig_user_id_provider || null,
  igUserIdVerifiedAt: r.ig_user_id_verified_at || null,
  createdAt: r.created_at, updatedAt: r.updated_at
});

const mapTemplate = r => r && ({
  id: r.id, name: r.name, body: r.body,
  createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at
});

const mapCampanha = r => r && ({
  id: r.id, name: r.name, accountId: r.account_id, templateId: r.template_id,
  body: r.body, messageVersion: r.message_version, status: r.status,
  createdAt: r.created_at, updatedAt: r.updated_at, startedAt: r.started_at,
  pausedAt: r.paused_at, cancelledAt: r.cancelled_at, completedAt: r.completed_at
});

const mapItem = r => r && ({
  id: r.id, messageId: r.message_id, campaignId: r.campaign_id, contactId: r.contact_id,
  accountId: r.account_id, provider: r.provider, status: r.status, priority: r.priority,
  availableAt: r.available_at, attemptCount: r.attempt_count, maxAttempts: r.max_attempts,
  lockedAt: r.locked_at, lockedBy: r.locked_by,
  lastErrorCode: r.last_error_code, lastErrorMessage: r.last_error_message,
  createdAt: r.created_at, updatedAt: r.updated_at
});

const mapMensagem = r => r && ({
  id: r.id, campaignId: r.campaign_id, contactId: r.contact_id, accountId: r.account_id,
  provider: r.provider, providerMessageId: r.provider_message_id,
  idempotencyKey: r.idempotency_key, body: r.body, status: r.status,
  attemptCount: r.attempt_count, lastAttemptAt: r.last_attempt_at, sentAt: r.sent_at,
  deliveredAt: r.delivered_at, repliedAt: r.replied_at,
  lastErrorCode: r.last_error_code, lastErrorMessage: r.last_error_message,
  createdAt: r.created_at, updatedAt: r.updated_at
});

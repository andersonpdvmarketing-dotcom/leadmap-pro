/**
 * LeadMap Pro — OutreachRepository
 * ================================
 * Fronteira entre o domínio e a base de dados. O domínio e a API falam
 * com esta interface; nunca com um SDK de fornecedor nem com SQL solto.
 *
 * Duas implementações:
 *   · InMemoryOutreachRepository — testes e desenvolvimento. Reproduz as
 *     constraints reais (UNIQUE, teto de contas, claim atómico) para que
 *     o comportamento testado seja o mesmo que o PostgreSQL impõe.
 *   · PostgresOutreachRepository (postgres.mjs) — produção.
 *
 * A UI NUNCA fala com o banco. Só com /api/outreach/*, autenticada.
 */

import {
  CAMPAIGN_STATUS, QUEUE_STATUS, MESSAGE_STATUS, CONTACT_STATUS,
  MAX_ACCOUNTS, idempotencyKey, motivoDeExclusao, lockExpirado,
  MAX_ATTEMPTS_PADRAO, LOCK_TIMEOUT_SEG, redigir
} from './domain.mjs';

export class RepositoryError extends Error {
  constructor(errorCode, mensagem) {
    super(mensagem || errorCode);
    this.name = 'RepositoryError';
    this.errorCode = errorCode;
  }
}

/* ---------------------------------------------------------------- *
 * Contrato                                                          *
 * ---------------------------------------------------------------- */

export class OutreachRepository {
  async disponivel() { return false; }
  async criarConta() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async listarContas() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async upsertContacto() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async listarContactos() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async definirOptOut() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async criarTemplate() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async listarTemplates() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async atualizarTemplate() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async apagarTemplate() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async criarCampanha() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async lerCampanha() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async listarCampanhas() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async iniciarCampanha() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async pausarCampanha() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async retomarCampanha() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async cancelarCampanha() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async reclamarItens() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async concluirItem() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async listarFila() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async lerMensagem() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async lerContacto() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async lerItem() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async registarAuditoria() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async listarAuditoria() { throw new RepositoryError('NOT_IMPLEMENTED'); }
  async registarWebhook() { throw new RepositoryError('NOT_IMPLEMENTED'); }
}

/* ---------------------------------------------------------------- *
 * Implementação em memória                                          *
 * ---------------------------------------------------------------- */

export class InMemoryOutreachRepository extends OutreachRepository {
  constructor({ agora = () => new Date() } = {}) {
    super();
    this.agora = agora;
    this.contas = new Map();
    this.contactos = new Map();
    this.templates = new Map();
    this.campanhas = new Map();
    this.campaignContacts = new Map();   /* campaignId:contactId → linha */
    this.mensagens = new Map();
    this.porIdempotencia = new Map();
    this.fila = new Map();
    this.porMensagem = new Map();
    this.auditoria = [];
    this.webhooks = new Map();
    this._seq = 0;
  }

  proximoId(p) { this._seq += 1; return p + '-' + this._seq; }
  iso() { return this.agora().toISOString(); }
  async disponivel() { return true; }

  /* ---------- contas ---------- */

  async criarConta({ displayName, username, provider = 'mock', providerAccountId = null, capabilities = {} }) {
    const chave = provider + '|' + username;
    for (const c of this.contas.values()) {
      if (c.provider === provider && c.username === username && !c.disabledAt) {
        throw new RepositoryError('DUPLICATE', 'Essa conta já está ligada.');
      }
    }
    const ativas = [...this.contas.values()].filter(c => !c.disabledAt && c.status !== 'DISCONNECTED');
    if (ativas.length >= MAX_ACCOUNTS) {
      throw new RepositoryError('MAX_ACCOUNTS', 'Limite máximo de ' + MAX_ACCOUNTS + ' contas conectadas.');
    }
    const agora = this.iso();
    const conta = {
      id: this.proximoId('acc'), displayName: displayName || username, username, provider,
      providerAccountId, status: 'CONNECTED', capabilities,
      createdAt: agora, updatedAt: agora, disabledAt: null, _chave: chave
    };
    this.contas.set(conta.id, conta);
    return conta;
  }

  async listarContas() { return [...this.contas.values()].filter(c => !c.disabledAt); }

  /* ---------- contactos ---------- */

  chaveContacto(c) {
    return c.normalizedInstagram ? 'ig:' + c.normalizedInstagram : (c.leadId ? 'lead:' + c.leadId : null);
  }

  async upsertContacto(dados) {
    const chave = this.chaveContacto(dados);
    if (!chave) throw new RepositoryError('INVALID_REQUEST', 'Contacto sem Instagram nem leadId.');
    for (const c of this.contactos.values()) {
      if (this.chaveContacto(c) === chave) {
        /* atualiza lacunas; nunca duplica e nunca reverte o opt-out */
        for (const campo of ['name', 'company', 'city', 'district', 'activity', 'source', 'normalizedInstagram', 'leadId']) {
          if (!c[campo] && dados[campo]) c[campo] = dados[campo];
        }
        c.updatedAt = this.iso();
        return { contacto: c, criado: false };
      }
    }
    const agora = this.iso();
    const contacto = {
      id: this.proximoId('con'),
      leadId: dados.leadId || null,
      normalizedInstagram: dados.normalizedInstagram || null,
      name: dados.name || 'Sem nome',
      company: dados.company || null, city: dados.city || null, district: dados.district || null,
      activity: dados.activity || null, source: dados.source || null,
      status: CONTACT_STATUS.UNKNOWN, optedOutAt: null,
      createdAt: agora, updatedAt: agora
    };
    this.contactos.set(contacto.id, contacto);
    return { contacto, criado: true };
  }

  async listarContactos({ limit = 50, offset = 0, status = null } = {}) {
    let lista = [...this.contactos.values()];
    if (status) lista = lista.filter(c => c.status === status);
    lista.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { total: lista.length, items: lista.slice(offset, offset + limit) };
  }

  async definirOptOut(contactId, optOut = true) {
    const c = this.contactos.get(contactId);
    if (!c) throw new RepositoryError('NOT_FOUND', 'Contacto não encontrado.');
    c.status = optOut ? CONTACT_STATUS.OPTED_OUT : CONTACT_STATUS.UNKNOWN;
    c.optedOutAt = optOut ? this.iso() : null;
    c.updatedAt = this.iso();
    return c;
  }

  /* ---------- templates ---------- */

  async criarTemplate({ name, body }) {
    const agora = this.iso();
    const t = { id: this.proximoId('tpl'), name, body, createdAt: agora, updatedAt: agora, deletedAt: null };
    this.templates.set(t.id, t);
    return t;
  }
  async listarTemplates({ limit = 50, offset = 0 } = {}) {
    const lista = [...this.templates.values()].filter(t => !t.deletedAt);
    return { total: lista.length, items: lista.slice(offset, offset + limit) };
  }
  async atualizarTemplate(id, campos) {
    const t = this.templates.get(id);
    if (!t || t.deletedAt) throw new RepositoryError('NOT_FOUND', 'Template não encontrado.');
    if (campos.name !== undefined) t.name = campos.name;
    if (campos.body !== undefined) t.body = campos.body;
    t.updatedAt = this.iso();
    return t;
  }
  async apagarTemplate(id) {
    const t = this.templates.get(id);
    if (!t) return false;
    t.deletedAt = this.iso();
    return true;
  }

  /* ---------- campanhas ---------- */

  async criarCampanha({ name, accountId, templateId = null, body }) {
    const conta = this.contas.get(accountId);
    if (!conta) throw new RepositoryError('NOT_FOUND', 'Conta não encontrada.');
    const agora = this.iso();
    const k = {
      id: this.proximoId('cmp'), name, accountId, templateId, body,
      messageVersion: 1, status: CAMPAIGN_STATUS.DRAFT,
      createdAt: agora, updatedAt: agora,
      startedAt: null, pausedAt: null, cancelledAt: null, completedAt: null
    };
    this.campanhas.set(k.id, k);
    return k;
  }

  async lerCampanha(id) { return this.campanhas.get(id) || null; }

  async listarCampanhas({ limit = 50, offset = 0 } = {}) {
    const lista = [...this.campanhas.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { total: lista.length, items: lista.slice(offset, offset + limit) };
  }

  /**
   * Arranque idempotente. Reproduz exatamente o que a função SQL faz:
   * chave determinística + inserção que não duplica.
   */
  async iniciarCampanha(campaignId, contactIds) {
    const k = this.campanhas.get(campaignId);
    if (!k) throw new RepositoryError('NOT_FOUND', 'Campanha não encontrada.');
    if (k.status === CAMPAIGN_STATUS.CANCELLED || k.status === CAMPAIGN_STATUS.COMPLETED) {
      throw new RepositoryError('CAMPAIGN_TERMINAL', 'Campanha em estado terminal: ' + k.status + '.');
    }
    const conta = this.contas.get(k.accountId);
    const resumo = { incluidos: 0, excluidos: 0, criados: 0, jaExistiam: 0, motivos: {} };
    const agora = this.iso();

    for (const cid of (contactIds || [])) {
      const c = this.contactos.get(cid);
      if (!c) continue;
      const motivo = motivoDeExclusao(c);
      const ccChave = campaignId + ':' + cid;
      if (motivo) {
        resumo.excluidos += 1;
        resumo.motivos[motivo] = (resumo.motivos[motivo] || 0) + 1;
        if (!this.campaignContacts.has(ccChave)) {
          this.campaignContacts.set(ccChave, { id: ccChave, campaignId, contactId: cid, status: 'SKIPPED', skipReason: motivo, createdAt: agora, updatedAt: agora });
        }
        continue;
      }
      resumo.incluidos += 1;
      if (!this.campaignContacts.has(ccChave)) {
        this.campaignContacts.set(ccChave, { id: ccChave, campaignId, contactId: cid, status: 'PENDING', skipReason: null, createdAt: agora, updatedAt: agora });
      }

      const idem = idempotencyKey({ campaignId, contactId: cid, accountId: k.accountId, messageVersion: k.messageVersion });
      if (this.porIdempotencia.has(idem)) { resumo.jaExistiam += 1; continue; }

      const msg = {
        id: 'm:' + idem, campaignId, contactId: cid, accountId: k.accountId,
        provider: conta.provider, providerMessageId: null, idempotencyKey: idem,
        body: k.body, status: MESSAGE_STATUS.QUEUED, attemptCount: 0,
        lastAttemptAt: null, sentAt: null, deliveredAt: null, repliedAt: null,
        lastErrorCode: null, lastErrorMessage: null, createdAt: agora, updatedAt: agora
      };
      this.mensagens.set(msg.id, msg);
      this.porIdempotencia.set(idem, msg.id);

      const item = {
        id: 'q:' + idem, messageId: msg.id, campaignId, contactId: cid, accountId: k.accountId,
        provider: conta.provider, status: QUEUE_STATUS.PENDING, priority: 0,
        availableAt: agora, attemptCount: 0, maxAttempts: MAX_ATTEMPTS_PADRAO,
        lockedAt: null, lockedBy: null, lastErrorCode: null, lastErrorMessage: null,
        createdAt: agora, updatedAt: agora
      };
      this.fila.set(item.id, item);
      this.porMensagem.set(msg.id, item.id);
      resumo.criados += 1;
    }

    k.status = CAMPAIGN_STATUS.RUNNING;
    k.startedAt = k.startedAt || agora;
    k.updatedAt = agora;
    return resumo;
  }

  async pausarCampanha(campaignId) {
    const k = this.campanhas.get(campaignId);
    if (!k) throw new RepositoryError('NOT_FOUND', 'Campanha não encontrada.');
    if (k.status === CAMPAIGN_STATUS.RUNNING || k.status === CAMPAIGN_STATUS.READY) {
      k.status = CAMPAIGN_STATUS.PAUSED; k.pausedAt = this.iso();
    }
    let n = 0;
    for (const i of this.fila.values()) {
      if (i.campaignId === campaignId && i.status === QUEUE_STATUS.PENDING) { i.status = QUEUE_STATUS.PAUSED; n++; }
    }
    return n;
  }

  async retomarCampanha(campaignId) {
    const k = this.campanhas.get(campaignId);
    if (!k) throw new RepositoryError('NOT_FOUND', 'Campanha não encontrada.');
    if (k.status === CAMPAIGN_STATUS.PAUSED) { k.status = CAMPAIGN_STATUS.RUNNING; k.pausedAt = null; }
    let n = 0;
    for (const i of this.fila.values()) {
      if (i.campaignId === campaignId && i.status === QUEUE_STATUS.PAUSED) { i.status = QUEUE_STATUS.PENDING; n++; }
    }
    return n;
  }

  async cancelarCampanha(campaignId) {
    const k = this.campanhas.get(campaignId);
    if (!k) throw new RepositoryError('NOT_FOUND', 'Campanha não encontrada.');
    if (k.status !== CAMPAIGN_STATUS.CANCELLED && k.status !== CAMPAIGN_STATUS.COMPLETED) {
      k.status = CAMPAIGN_STATUS.CANCELLED; k.cancelledAt = this.iso();
    }
    let n = 0;
    for (const i of this.fila.values()) {
      if (i.campaignId === campaignId && (i.status === QUEUE_STATUS.PENDING || i.status === QUEUE_STATUS.PAUSED)) {
        i.status = QUEUE_STATUS.CANCELLED; i.lastErrorCode = 'CAMPAIGN_CANCELLED'; n++;
      }
    }
    return n;
  }

  /* ---------- fila ---------- */

  /**
   * Claim atómico. Em JavaScript de thread única, a atomicidade é dada
   * por não haver `await` entre a seleção e a marcação: nenhuma outra
   * tarefa corre no meio. É a mesma garantia que o SKIP LOCKED dá no
   * PostgreSQL, e por isso os testes de concorrência valem para ambos.
   */
  async reclamarItens({ workerId, limit = 1, lockTimeoutSeg = LOCK_TIMEOUT_SEG } = {}) {
    if (!workerId) throw new RepositoryError('INVALID_REQUEST', 'Worker sem identificador.');
    const agoraMs = this.agora().getTime();
    const elegiveis = [];
    for (const i of this.fila.values()) {
      const k = this.campanhas.get(i.campaignId);
      if (!k || k.status !== CAMPAIGN_STATUS.RUNNING) continue;
      const pendente = i.status === QUEUE_STATUS.PENDING && Date.parse(i.availableAt) <= agoraMs;
      const abandonado = lockExpirado(i, { agora: agoraMs, timeoutSeg: lockTimeoutSeg });
      if (pendente || abandonado) elegiveis.push(i);
    }
    elegiveis.sort((a, b) =>
      (b.priority - a.priority) ||
      String(a.availableAt).localeCompare(String(b.availableAt)) ||
      String(a.id).localeCompare(String(b.id)));

    const levados = elegiveis.slice(0, limit);
    const agora = this.iso();
    for (const i of levados) {
      i.status = QUEUE_STATUS.PROCESSING;
      i.lockedAt = agora;
      i.lockedBy = workerId;
      i.attemptCount += 1;
      i.updatedAt = agora;
    }
    return levados.map(i => ({ ...i }));
  }

  async concluirItem({ itemId, outcome, providerMessageId = null, errorCode = null, errorMessage = null, availableAt = null }) {
    const i = this.fila.get(itemId);
    if (!i) throw new RepositoryError('NOT_FOUND', 'Item não encontrado.');
    /* estados terminais nunca reabrem (§60) */
    if ([QUEUE_STATUS.SENT, QUEUE_STATUS.CANCELLED, QUEUE_STATUS.SKIPPED, QUEUE_STATUS.FAILED].includes(i.status)) {
      return { ...i, jaTerminal: true };
    }
    const msg = this.mensagens.get(i.messageId);
    const agora = this.iso();

    if (outcome === 'SENT') {
      i.status = QUEUE_STATUS.SENT; i.lockedAt = null; i.lockedBy = null;
      i.lastErrorCode = null; i.lastErrorMessage = null;
      if (msg) {
        msg.status = MESSAGE_STATUS.SENT; msg.providerMessageId = providerMessageId;
        msg.sentAt = agora; msg.lastAttemptAt = agora; msg.attemptCount += 1;
        msg.lastErrorCode = null; msg.lastErrorMessage = null;
      }
      const c = this.contactos.get(i.contactId);
      if (c && c.status !== CONTACT_STATUS.OPTED_OUT && c.status !== CONTACT_STATUS.REPLIED) c.status = CONTACT_STATUS.SENT;
    } else if (outcome === 'RETRY') {
      i.status = QUEUE_STATUS.PENDING; i.lockedAt = null; i.lockedBy = null;
      i.availableAt = availableAt || agora;
      i.lastErrorCode = errorCode; i.lastErrorMessage = errorMessage;
      if (msg) { msg.status = MESSAGE_STATUS.QUEUED; msg.lastAttemptAt = agora; msg.attemptCount += 1; msg.lastErrorCode = errorCode; msg.lastErrorMessage = errorMessage; }
    } else if (outcome === 'SKIPPED') {
      i.status = QUEUE_STATUS.SKIPPED; i.lockedAt = null; i.lockedBy = null;
      i.lastErrorCode = errorCode; i.lastErrorMessage = errorMessage;
      if (msg) { msg.status = MESSAGE_STATUS.SKIPPED; msg.lastErrorCode = errorCode; msg.lastErrorMessage = errorMessage; }
    } else {
      i.status = QUEUE_STATUS.FAILED; i.lockedAt = null; i.lockedBy = null;
      i.lastErrorCode = errorCode; i.lastErrorMessage = errorMessage;
      if (msg) { msg.status = MESSAGE_STATUS.FAILED; msg.lastAttemptAt = agora; msg.attemptCount += 1; msg.lastErrorCode = errorCode; msg.lastErrorMessage = errorMessage; }
    }
    i.updatedAt = agora;

    const k = this.campanhas.get(i.campaignId);
    if (k && k.status === CAMPAIGN_STATUS.RUNNING) {
      const restam = [...this.fila.values()].some(x => x.campaignId === k.id &&
        [QUEUE_STATUS.PENDING, QUEUE_STATUS.PROCESSING, QUEUE_STATUS.PAUSED].includes(x.status));
      if (!restam) { k.status = CAMPAIGN_STATUS.COMPLETED; k.completedAt = agora; }
    }
    return { ...i };
  }

  async listarFila({ campaignId = null, status = null, limit = 50, offset = 0 } = {}) {
    let lista = [...this.fila.values()];
    if (campaignId) lista = lista.filter(i => i.campaignId === campaignId);
    if (status) lista = lista.filter(i => i.status === status);
    lista.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return { total: lista.length, items: lista.slice(offset, offset + limit) };
  }

  async lerMensagem(id) { return this.mensagens.get(id) || null; }
  async lerContacto(id) { return this.contactos.get(id) || null; }
  async lerItem(id) { return this.fila.get(id) || null; }

  /* ---------- auditoria e webhooks ---------- */

  async registarAuditoria({ actor, action, entityType = null, entityId = null, metadata = {} }) {
    const linha = {
      id: this.auditoria.length + 1, actor, action, entityType, entityId,
      metadata: redigir(metadata), createdAt: this.iso()
    };
    this.auditoria.push(linha);
    return linha;
  }

  async listarAuditoria({ limit = 50, offset = 0, entityId = null, action = null } = {}) {
    let lista = [...this.auditoria].reverse();
    if (entityId) lista = lista.filter(a => a.entityId === entityId);
    if (action) lista = lista.filter(a => a.action === action);
    return { total: lista.length, items: lista.slice(offset, offset + limit) };
  }

  async registarWebhook({ provider, providerEventId, eventType, payload = {} }) {
    const chave = provider + '|' + providerEventId;
    if (this.webhooks.has(chave)) return { evento: this.webhooks.get(chave), duplicado: true };
    const evento = {
      id: this.proximoId('wh'), provider, providerEventId, eventType,
      payloadRedacted: redigir(payload), receivedAt: this.iso(), processedAt: null, status: 'RECEIVED'
    };
    this.webhooks.set(chave, evento);
    return { evento, duplicado: false };
  }
}

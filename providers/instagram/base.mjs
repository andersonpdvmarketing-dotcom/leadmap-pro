/**
 * LeadMap Pro — BaseInstagramProvider
 * ===================================
 * Interface comum a todos os fornecedores de Instagram. Uma subclasse
 * declara as suas capacidades e implementa apenas os métodos `_*` que
 * correspondem às capacidades que declarou; tudo o resto responde
 * NOT_SUPPORTED de forma previsível, para que o UI nunca finja suporte.
 *
 * Métodos públicos (o resto do LeadMap só conhece estes):
 *   connect(params)              → { account, ... }
 *   disconnect(account)          → { account }
 *   sendMessage(pedido)          → resposta normalizada (nunca lança)
 *   checkEligibility(account, r) → { status, reason }
 *   fetchProfile(account, user)  → { username, displayName, ... } | null
 *   getDeliveryStatus(acc, id)   → { status, providerMessageId, updatedAt }
 *   listConversations(account)   → [ ... ]
 *   parseWebhook(corpo, headers) → [ eventos normalizados ]
 */

import {
  ProviderError, MESSAGE_STATUS, ELIGIBILITY, ACCOUNT_STATUS,
  normalizarCapacidades, respostaEnvio, respostaDeErro, normalizarConta
} from './contract.mjs';

/** Tipos de evento normalizados que um webhook pode produzir. */
export const WEBHOOK_EVENTS = Object.freeze({
  MESSAGE_DELIVERED: 'MESSAGE_DELIVERED',
  MESSAGE_READ: 'MESSAGE_READ',
  MESSAGE_FAILED: 'MESSAGE_FAILED',
  REPLY_RECEIVED: 'REPLY_RECEIVED',
  ACCOUNT_STATUS_CHANGED: 'ACCOUNT_STATUS_CHANGED'
});

export class BaseInstagramProvider {
  /**
   * @param {object} opts
   * @param {string} opts.id            identificador estável ('meta', 'external:acme', 'mock')
   * @param {string} opts.displayName   nome mostrado no UI ("Meta", "External — Acme")
   * @param {object} opts.capabilities  mapa parcial; o que não for declarado fica false
   */
  constructor({ id, displayName, capabilities } = {}) {
    if (!id) throw new ProviderError('INVALID_REQUEST', 'Provider sem id.');
    this.id = id;
    this.displayName = displayName || id;
    this.capabilities = normalizarCapacidades(capabilities);
  }

  /** true se o fornecedor declarou esta capacidade. */
  supports(cap) { return this.capabilities[cap] === true; }

  /** Lança NOT_SUPPORTED se a capacidade não foi declarada. */
  assertCapability(cap) {
    if (!this.supports(cap)) {
      throw new ProviderError(
        'NOT_SUPPORTED',
        'O fornecedor "' + this.displayName + '" não suporta ' + cap + '.'
      );
    }
  }

  /** Descrição pública do fornecedor — segura para o frontend. */
  describe() {
    return {
      id: this.id,
      displayName: this.displayName,
      capabilities: { ...this.capabilities },
      configured: this.isConfigured()
    };
  }

  /**
   * Serializar um provider por engano — `res.json(provider)`, um logger,
   * um spread para dentro de uma resposta — expunha `apiKey`/`baseUrl`.
   * Com `toJSON`, qualquer serialização devolve a mesma vista pública
   * de `describe()`. A credencial deixa de ter caminho para fora.
   */
  toJSON() { return this.describe(); }

  /** Sobrescrever quando o fornecedor precisar de configuração de backend. */
  isConfigured() { return true; }

  /* ------------------------------------------------------------ *
   * Ligação de conta                                              *
   * ------------------------------------------------------------ */

  /**
   * Liga uma conta. O fluxo de autenticação é do fornecedor (OAuth, token
   * ou API key); o LeadMap nunca recebe nem guarda a password do Instagram.
   */
  async connect(params = {}) {
    if (params && (params.password || params.igPassword || params.passwd)) {
      throw new ProviderError(
        'INVALID_REQUEST',
        'O LeadMap não aceita a password do Instagram. Use OAuth, token ou API key do fornecedor.'
      );
    }
    const bruta = await this._connect(params);
    const account = normalizarConta({
      ...bruta,
      provider: this.id,
      status: bruta.status || ACCOUNT_STATUS.CONNECTED,
      connectedAt: bruta.connectedAt || new Date().toISOString()
    });
    return { account };
  }

  async disconnect(account) {
    await this._disconnect(account);
    return {
      account: normalizarConta({
        ...account,
        provider: this.id,
        status: ACCOUNT_STATUS.DISCONNECTED
      })
    };
  }

  /* ------------------------------------------------------------ *
   * Envio                                                         *
   * ------------------------------------------------------------ */

  /**
   * Envia uma mensagem. NUNCA lança: qualquer falha volta como resposta
   * normalizada, para que a fila possa decidir o que fazer sem try/catch
   * espalhado. `pedido`: { account, recipient, message, campaignId }
   */
  async sendMessage(pedido = {}) {
    try {
      this.assertCapability('canSendMessage');
      const erroValidacao = validarPedido(pedido);
      if (erroValidacao) throw erroValidacao;
      const bruta = await this._sendMessage(pedido);
      if (bruta && bruta.success === false) return respostaDeErro(bruta.error || bruta);
      return respostaEnvio({
        success: true,
        providerMessageId: bruta && bruta.providerMessageId,
        status: (bruta && bruta.status) || MESSAGE_STATUS.SENT
      });
    } catch (err) {
      return respostaDeErro(err);
    }
  }

  /* ------------------------------------------------------------ *
   * Elegibilidade, perfil, estado de entrega, conversas           *
   * ------------------------------------------------------------ */

  /**
   * Sem capacidade de elegibilidade o resultado é UNKNOWN — nunca se
   * assume que um destinatário pode receber DM.
   */
  async checkEligibility(account, recipient) {
    if (!this.supports('canCheckEligibility')) {
      return { status: ELIGIBILITY.UNKNOWN, reason: 'Fornecedor sem endpoint de elegibilidade.' };
    }
    try {
      const r = await this._checkEligibility(account, recipient);
      const status = ELIGIBILITY[r && r.status] || ELIGIBILITY.UNKNOWN;
      return { status, reason: (r && r.reason) || null };
    } catch (err) {
      return { status: ELIGIBILITY.UNKNOWN, reason: (err && err.message) || 'Falha na verificação.' };
    }
  }

  async fetchProfile(account, username) {
    this.assertCapability('canFetchProfile');
    return this._fetchProfile(account, username);
  }

  async getDeliveryStatus(account, providerMessageId) {
    if (!this.supports('canFetchDeliveryStatus')) {
      return { providerMessageId, status: MESSAGE_STATUS.UNKNOWN, updatedAt: null };
    }
    const r = await this._getDeliveryStatus(account, providerMessageId);
    return {
      providerMessageId,
      status: MESSAGE_STATUS[r && r.status] || MESSAGE_STATUS.UNKNOWN,
      updatedAt: (r && r.updatedAt) || null
    };
  }

  async listConversations(account, opts = {}) {
    this.assertCapability('canReadConversations');
    return this._listConversations(account, opts);
  }

  /** Traduz o corpo de um webhook do fornecedor em eventos normalizados. */
  parseWebhook(corpo, headers = {}) {
    if (!this.supports('canReceiveWebhooks')) return [];
    try {
      const eventos = this._parseWebhook(corpo, headers) || [];
      return eventos.filter(e => e && WEBHOOK_EVENTS[e.type]);
    } catch (err) {
      return [];
    }
  }

  /* ------------------------------------------------------------ *
   * Pontos de extensão — implementar na subclasse                 *
   * ------------------------------------------------------------ */

  async _connect() { throw new ProviderError('NOT_SUPPORTED', 'connect não implementado.'); }
  async _disconnect() { /* por omissão, desligar é local */ }
  async _sendMessage() { throw new ProviderError('NOT_SUPPORTED', 'sendMessage não implementado.'); }
  async _checkEligibility() { throw new ProviderError('NOT_SUPPORTED', 'checkEligibility não implementado.'); }
  async _fetchProfile() { throw new ProviderError('NOT_SUPPORTED', 'fetchProfile não implementado.'); }
  async _getDeliveryStatus() { throw new ProviderError('NOT_SUPPORTED', 'getDeliveryStatus não implementado.'); }
  async _listConversations() { throw new ProviderError('NOT_SUPPORTED', 'listConversations não implementado.'); }
  _parseWebhook() { return []; }
}

/* ---------------------------------------------------------------- *
 * Utilitários partilhados pelos adapters                            *
 * ---------------------------------------------------------------- */

const MAX_MENSAGEM = 1000;

function validarPedido(pedido) {
  const { account, recipient, message, flowNs } = pedido || {};
  if (!account || !account.providerAccountId) {
    return new ProviderError('INVALID_REQUEST', 'Pedido sem conta de origem.');
  }
  if (!recipient || !(recipient.username || recipient.providerUserId)) {
    return new ProviderError('INVALID_REQUEST', 'Pedido sem destinatário.');
  }

  /* Há duas formas legítimas de enviar, e o contrato tem de conhecer as
     duas: texto composto aqui, ou uma automação já desenhada no
     fornecedor (a ManyChat dispara flows, e o conteúdo vive lá). O que
     não se aceita é um pedido sem nenhuma das duas — isso é mandar
     nada a alguém. */
  const temFlow = typeof flowNs === 'string' && flowNs.trim().length > 0;
  const temTexto = typeof message === 'string' && message.trim().length > 0;
  if (!temFlow && !temTexto) {
    return new ProviderError('INVALID_REQUEST', 'Pedido sem mensagem nem automação.');
  }
  if (temTexto && message.length > MAX_MENSAGEM) {
    return new ProviderError('INVALID_REQUEST', 'Mensagem acima de ' + MAX_MENSAGEM + ' caracteres.');
  }
  return null;
}

/** fetch com timeout, sem retries próprios — a política de retry é da fila. */
export async function pedidoHttp(url, opts = {}, timeoutMs = 10000, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') {
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'fetch indisponível neste ambiente.');
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await f(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new ProviderError('TIMEOUT', 'O fornecedor não respondeu em ' + timeoutMs + ' ms.');
    }
    throw new ProviderError('NETWORK', (err && err.message) || 'Falha de rede.');
  } finally {
    clearTimeout(t);
  }
}

/**
 * Lê o tempo de espera pedido pelo fornecedor. Respeitar isto é o
 * oposto de contornar o limite: a fila fica quieta o tempo indicado.
 */
export function lerRetryAfter(headers) {
  if (!headers) return null;
  const get = k => (typeof headers.get === 'function' ? headers.get(k) : headers[k]);
  const bruto = get('retry-after') || get('Retry-After') ||
    get('x-ratelimit-reset') || get('X-RateLimit-Reset');
  if (bruto == null) return null;
  const n = Number(bruto);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 24 * 3600);
  const data = Date.parse(bruto);
  if (Number.isFinite(data)) {
    return Math.max(0, Math.min(24 * 3600, Math.round((data - Date.now()) / 1000)));
  }
  return null;
}

/** Traduz um código HTTP num ProviderError do vocabulário comum. */
export function erroDeHttp(status, corpo, headers) {
  const msg = (corpo && (corpo.message || corpo.error || corpo.error_message)) || ('HTTP ' + status);
  if (status === 429) {
    return new ProviderError('RATE_LIMITED', String(msg), {
      providerStatus: status, retryAfterSec: lerRetryAfter(headers)
    });
  }
  if (status === 401 || status === 403) {
    return new ProviderError('INVALID_TOKEN', String(msg), { providerStatus: status });
  }
  if (status === 404 || status === 410) {
    return new ProviderError('RECIPIENT_UNAVAILABLE', String(msg), { providerStatus: status });
  }
  if (status === 408 || status === 504) {
    return new ProviderError('TIMEOUT', String(msg), { providerStatus: status });
  }
  if (status >= 500) {
    return new ProviderError('PROVIDER_UNAVAILABLE', String(msg), { providerStatus: status });
  }
  if (status >= 400) {
    return new ProviderError('MESSAGE_REJECTED', String(msg), { providerStatus: status });
  }
  return new ProviderError('UNKNOWN', String(msg), { providerStatus: status });
}

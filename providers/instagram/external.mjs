/**
 * LeadMap Pro — ExternalInstagramProvider
 * =======================================
 * Adapter genérico para um fornecedor terceiro que exponha uma API
 * HTTP+JSON própria. Nenhum endpoint específico de fornecedor está
 * escrito aqui nem em qualquer outro lado do LeadMap: os caminhos vêm
 * da configuração de backend, e é este ficheiro — e só este — que
 * conhece a forma da API externa.
 *
 * NENHUM fornecedor real está escolhido nesta fase (§19). O adapter
 * existe para que a escolha, quando acontecer, seja configuração e não
 * uma reescrita.
 *
 * CONDIÇÕES DE INTEGRAÇÃO (verificadas em código, não só documentadas)
 * -------------------------------------------------------------------
 * O construtor recusa qualquer configuração que exija cookies de sessão,
 * user-agent forjado, ID de dispositivo, proxy de evasão, controlo de
 * browser (Puppeteer/Playwright/Selenium) ou a password do Instagram —
 * ver `rejeitarConfigNaoConforme()` em contract.mjs. Um fornecedor que
 * precise disso não é integrável e o adapter falha a arrancar.
 *
 * Variáveis de backend (nomes conceptuais; sem valores reais nesta fase):
 *   INSTAGRAM_EXTERNAL_PROVIDER    nome do fornecedor, para o UI
 *   INSTAGRAM_EXTERNAL_BASE_URL    origem HTTPS da API
 *   INSTAGRAM_EXTERNAL_API_KEY     credencial, só no backend
 *   INSTAGRAM_EXTERNAL_ACCOUNT_ID  conta por omissão, quando aplicável
 *   INSTAGRAM_EXTERNAL_CAPABILITIES  lista separada por vírgulas
 *   INSTAGRAM_EXTERNAL_PATHS       JSON opcional a redefinir os caminhos
 */

import { BaseInstagramProvider, WEBHOOK_EVENTS, pedidoHttp, erroDeHttp, lerRetryAfter } from './base.mjs';
import { ProviderError, MESSAGE_STATUS, ELIGIBILITY, ACCOUNT_STATUS, rejeitarConfigNaoConforme } from './contract.mjs';

/** Caminhos por omissão; qualquer um pode ser redefinido na configuração. */
const CAMINHOS_PADRAO = Object.freeze({
  connect: '/accounts/connect',
  disconnect: '/accounts/disconnect',
  send: '/messages',
  eligibility: '/recipients/eligibility',
  profile: '/profiles',
  deliveryStatus: '/messages/status',
  conversations: '/conversations'
});

export class ExternalInstagramProvider extends BaseInstagramProvider {
  constructor(config = {}, deps = {}) {
    /* A recusa acontece antes de existir objeto: nada é construído com
       uma configuração que dependa de evasão. */
    rejeitarConfigNaoConforme(config, 'ExternalInstagramProvider');

    const nome = config.providerName || 'External';
    super({
      id: config.id || ('external:' + slug(nome)),
      displayName: 'External — ' + nome,
      /* Nada é assumido: o fornecedor declara o que sabe fazer. */
      capabilities: config.capabilities || {}
    });

    this.providerName = nome;
    this.baseUrl = normalizarBaseUrl(config.baseUrl);
    this.apiKey = config.apiKey || null;
    this.accountId = config.accountId || null;
    this.authHeader = config.authHeader || 'Authorization';
    this.authScheme = config.authScheme != null ? config.authScheme : 'Bearer';
    this.timeoutMs = config.timeoutMs || 10000;
    this.caminhos = { ...CAMINHOS_PADRAO, ...(config.paths || {}) };
    this.fetchImpl = deps.fetch || null;
  }

  isConfigured() { return Boolean(this.baseUrl && this.apiKey); }

  exigirConfig() {
    if (!this.baseUrl) {
      throw new ProviderError('NOT_CONFIGURED', this.displayName + ': INSTAGRAM_EXTERNAL_BASE_URL em falta.');
    }
    if (!this.apiKey) {
      throw new ProviderError('NOT_CONFIGURED', this.displayName + ': INSTAGRAM_EXTERNAL_API_KEY em falta.');
    }
  }

  url(chave, sufixo = '') {
    const c = this.caminhos[chave];
    if (!c) throw new ProviderError('NOT_SUPPORTED', this.displayName + ': sem caminho para ' + chave + '.');
    return this.baseUrl + c + sufixo;
  }

  async pedir(chave, { metodo = 'GET', corpo = null, sufixo = '' } = {}) {
    this.exigirConfig();
    const cabecalhos = { Accept: 'application/json' };
    cabecalhos[this.authHeader] = this.authScheme ? this.authScheme + ' ' + this.apiKey : this.apiKey;
    if (corpo) cabecalhos['Content-Type'] = 'application/json';

    const resp = await pedidoHttp(this.url(chave, sufixo), {
      method: metodo,
      headers: cabecalhos,
      body: corpo ? JSON.stringify(corpo) : undefined
    }, this.timeoutMs, this.fetchImpl);

    let json = null;
    try { json = await resp.json(); } catch (e) { json = null; }

    if (!resp.ok) throw erroDeHttp(resp.status, json, resp.headers);

    /* Alguns fornecedores devolvem 200 com { success:false, error:{...} } */
    if (json && json.success === false) {
      const e = json.error || {};
      throw new ProviderError(traduzirCodigo(e.code), e.message || 'Falha do fornecedor.', {
        providerStatus: 200,
        retryAfterSec: Number.isFinite(e.retryAfter) ? e.retryAfter : lerRetryAfter(resp.headers)
      });
    }
    return json || {};
  }

  /* ------------------------------------------------------------ *
   * Conta                                                         *
   * ------------------------------------------------------------ */

  /**
   * Usa o fluxo de autenticação do próprio fornecedor (OAuth, token ou
   * API key). `params` nunca inclui password — a base rejeita-a antes
   * de chegar aqui.
   */
  async _connect(params = {}) {
    const json = await this.pedir('connect', {
      metodo: 'POST',
      corpo: {
        accountId: params.providerAccountId || params.accountId || this.accountId || null,
        username: params.username || null,
        /* token/código emitido pelo fluxo do fornecedor, não do Instagram */
        authorizationCode: params.authorizationCode || null,
        sessionToken: params.providerSessionToken || null
      }
    });
    const conta = json.account || json;
    const providerAccountId = conta.id || conta.accountId || conta.providerAccountId;
    if (!providerAccountId) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', this.displayName + ': resposta de ligação sem ID de conta.');
    }
    return {
      providerAccountId: String(providerAccountId),
      username: conta.username || params.username || String(providerAccountId),
      displayName: conta.displayName || conta.name || conta.username || String(providerAccountId),
      status: ACCOUNT_STATUS[conta.status] || ACCOUNT_STATUS.CONNECTED
    };
  }

  async _disconnect(account) {
    if (!account || !account.providerAccountId) return;
    try {
      await this.pedir('disconnect', {
        metodo: 'POST',
        corpo: { accountId: account.providerAccountId }
      });
    } catch (err) {
      /* Desligar localmente tem de funcionar mesmo com o fornecedor em baixo. */
      if (err instanceof ProviderError && err.errorCode === 'NOT_CONFIGURED') return;
      if (err instanceof ProviderError && err.retryable) return;
      throw err;
    }
  }

  /* ------------------------------------------------------------ *
   * Envio                                                         *
   * ------------------------------------------------------------ */

  async _sendMessage({ account, recipient, message, campaignId }) {
    const json = await this.pedir('send', {
      metodo: 'POST',
      corpo: {
        accountId: account.providerAccountId,
        recipient: recipient.providerUserId
          ? { id: recipient.providerUserId }
          : { username: recipient.username },
        message: { text: message },
        /* referência do lado do LeadMap, útil para reconciliação */
        clientReference: campaignId || null
      }
    });
    const id = json.messageId || json.id || (json.data && json.data.messageId) || null;
    return {
      providerMessageId: id ? String(id) : null,
      status: MESSAGE_STATUS[json.status] || MESSAGE_STATUS.SENT
    };
  }

  async _checkEligibility(account, recipient) {
    const json = await this.pedir('eligibility', {
      metodo: 'POST',
      corpo: {
        accountId: account.providerAccountId,
        recipient: recipient.providerUserId
          ? { id: recipient.providerUserId }
          : { username: recipient.username }
      }
    });
    const bruto = String(json.eligibility || json.status || '').toUpperCase();
    if (bruto === 'ELIGIBLE' || json.eligible === true) {
      return { status: ELIGIBILITY.ELIGIBLE, reason: json.reason || null };
    }
    if (bruto === 'INELIGIBLE' || json.eligible === false) {
      return { status: ELIGIBILITY.INELIGIBLE, reason: json.reason || null };
    }
    return { status: ELIGIBILITY.UNKNOWN, reason: json.reason || null };
  }

  async _fetchProfile(account, username) {
    const json = await this.pedir('profile', {
      sufixo: '/' + encodeURIComponent(username)
    });
    const p = json.profile || json;
    if (!p || (!p.username && !p.id)) return null;
    return {
      username: p.username || username,
      displayName: p.displayName || p.name || p.username || username,
      followers: Number.isFinite(p.followers) ? p.followers
        : (Number.isFinite(p.followersCount) ? p.followersCount : null)
    };
  }

  async _getDeliveryStatus(account, providerMessageId) {
    const json = await this.pedir('deliveryStatus', {
      sufixo: '/' + encodeURIComponent(providerMessageId)
    });
    return {
      status: MESSAGE_STATUS[String(json.status || '').toUpperCase()] || MESSAGE_STATUS.UNKNOWN,
      updatedAt: json.updatedAt || null
    };
  }

  async _listConversations(account, opts = {}) {
    const json = await this.pedir('conversations', {
      sufixo: '?accountId=' + encodeURIComponent(account.providerAccountId) +
        (opts.after ? '&after=' + encodeURIComponent(opts.after) : '')
    });
    return Array.isArray(json.conversations) ? json.conversations
      : (Array.isArray(json.data) ? json.data : []);
  }

  /* ------------------------------------------------------------ *
   * Webhooks                                                      *
   * ------------------------------------------------------------ */

  _parseWebhook(corpo) {
    const lista = Array.isArray(corpo && corpo.events) ? corpo.events
      : (corpo && corpo.event ? [corpo.event] : []);
    return lista.map(e => {
      const tipo = String(e.type || e.kind || '').toLowerCase();
      const at = e.at || e.timestamp || new Date().toISOString();
      if (tipo.includes('deliver')) {
        return { type: WEBHOOK_EVENTS.MESSAGE_DELIVERED, providerMessageId: idDe(e), at };
      }
      if (tipo.includes('read') || tipo.includes('seen')) {
        return { type: WEBHOOK_EVENTS.MESSAGE_READ, providerMessageId: idDe(e), at };
      }
      if (tipo.includes('fail') || tipo.includes('error') || tipo.includes('bounce')) {
        return {
          type: WEBHOOK_EVENTS.MESSAGE_FAILED,
          providerMessageId: idDe(e),
          errorCode: traduzirCodigo(e.errorCode || e.code),
          at
        };
      }
      if (tipo.includes('reply') || tipo.includes('message.received') || tipo.includes('inbound')) {
        return {
          type: WEBHOOK_EVENTS.REPLY_RECEIVED,
          providerAccountId: e.accountId ? String(e.accountId) : null,
          from: e.from || (e.sender && (e.sender.username || e.sender.id)) || null,
          text: e.text || (e.message && e.message.text) || null,
          at
        };
      }
      if (tipo.includes('account')) {
        return {
          type: WEBHOOK_EVENTS.ACCOUNT_STATUS_CHANGED,
          providerAccountId: e.accountId ? String(e.accountId) : null,
          status: ACCOUNT_STATUS[String(e.status || '').toUpperCase()] || ACCOUNT_STATUS.ERROR,
          at
        };
      }
      return null;
    }).filter(Boolean);
  }
}

/* ---------------------------------------------------------------- *
 * Auxiliares                                                        *
 * ---------------------------------------------------------------- */

function idDe(e) {
  const v = e.messageId || e.id || e.providerMessageId || null;
  return v == null ? null : String(v);
}

function slug(s) {
  return String(s).toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider';
}

/**
 * Alvos internos que um baseUrl nunca pode apontar. Mesma proteção SSRF
 * dos endpoints de enriquecimento (api/enrich/*): HTTPS obrigatório não
 * chega — uma configuração errada ou maliciosa apontada a 169.254.169.254
 * faria a função servidora ir buscar credenciais de instância e enviar a
 * API key para lá no cabeçalho Authorization.
 */
function hostInterno(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  if (h === 'metadata.google.internal') return true;
  /* IPv4 */
  if (/^127\./.test(h) || /^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^0\./.test(h) || h === '0.0.0.0') return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;   /* CGNAT */
  /* IPv6: loopback, link-local, unique-local e IPv4 mapeado */
  if (h === '::' || h === '::1') return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;      /* fe80::/10 link-local */
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;      /* fc00::/7 unique-local */
  if (/^::ffff:/.test(h)) return true;                /* IPv4 mapeado em IPv6 */
  return false;
}

function normalizarBaseUrl(bruto) {
  if (!bruto || typeof bruto !== 'string') return null;
  let u;
  try { u = new URL(bruto.trim()); } catch (e) { return null; }
  /* Só HTTPS: a credencial do fornecedor nunca viaja em claro. */
  if (u.protocol !== 'https:') {
    throw new ProviderError('INVALID_REQUEST', 'INSTAGRAM_EXTERNAL_BASE_URL tem de ser HTTPS.');
  }
  if (u.username || u.password) {
    throw new ProviderError('INVALID_REQUEST', 'INSTAGRAM_EXTERNAL_BASE_URL não pode conter credenciais no URL.');
  }
  if (hostInterno(u.hostname)) {
    throw new ProviderError(
      'INVALID_REQUEST',
      'INSTAGRAM_EXTERNAL_BASE_URL aponta para um endereço interno (' + u.hostname + '). ' +
      'O fornecedor tem de ser um serviço público: um alvo interno exporia a rede e as ' +
      'credenciais de instância do servidor.'
    );
  }
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/** Traduz o código do fornecedor para o vocabulário comum. */
function traduzirCodigo(bruto) {
  const c = String(bruto || '').toUpperCase().replace(/[\s-]/g, '_');
  const conhecidos = [
    'RATE_LIMITED', 'TIMEOUT', 'NETWORK', 'PROVIDER_UNAVAILABLE', 'INVALID_TOKEN',
    'ACCOUNT_RESTRICTED', 'RECIPIENT_UNAVAILABLE', 'RECIPIENT_INELIGIBLE',
    'MESSAGE_REJECTED', 'NOT_SUPPORTED', 'NOT_CONFIGURED', 'INVALID_REQUEST'
  ];
  if (conhecidos.includes(c)) return c;
  if (c.includes('RATE') || c.includes('THROTTL') || c.includes('TOO_MANY')) return 'RATE_LIMITED';
  if (c.includes('TIMEOUT')) return 'TIMEOUT';
  if (c.includes('TOKEN') || c.includes('AUTH') || c.includes('UNAUTHORIZED')) return 'INVALID_TOKEN';
  if (c.includes('RESTRICT') || c.includes('BLOCK') || c.includes('SUSPEND')) return 'ACCOUNT_RESTRICTED';
  if (c.includes('RECIPIENT') || c.includes('NOT_FOUND')) return 'RECIPIENT_UNAVAILABLE';
  return 'UNKNOWN';
}

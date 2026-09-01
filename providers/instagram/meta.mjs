/**
 * LeadMap Pro — MetaInstagramProvider
 * ===================================
 * Adapter para a API oficial da Meta (Instagram Messaging, via Graph API).
 * Fala apenas HTTP+JSON com graph.facebook.com, com um token de acesso
 * que vive exclusivamente no backend.
 *
 * META PROVIDER STATUS: ARCHITECTURE ONLY / NOT VALIDATED FOR PRODUCTION
 * ---------------------------------------------------------------------
 * A estrutura, a tradução de erros e as capacidades estão feitas e
 * testadas contra um `fetch` injetado. Os endpoints, a versão da Graph
 * API, os payloads, as permissões, a elegibilidade, os webhooks e as
 * regras de janela de messaging foram escritos por presunção e AINDA NÃO
 * FORAM VALIDADOS contra a documentação oficial da Meta.
 *
 * Por isso este adapter está BLOQUEADO para pedidos reais: com
 * `enabledForRealRequests` a false (o valor por omissão) nenhum `fetch`
 * chega a sair, e qualquer tentativa devolve
 * `META_PROVIDER_NOT_VALIDATED`. Os testes ativam a flag explicitamente
 * com um `fetch` injetado — modo de teste, nunca rede real.
 *
 * Para levantar o bloqueio é preciso, por esta ordem: validar tudo o que
 * está acima na documentação oficial, corrigir o que estiver errado, e
 * só então definir INSTAGRAM_META_ENABLED_FOR_REAL_REQUESTS=1.
 *
 * Variáveis de backend (nunca no frontend):
 *   INSTAGRAM_META_ACCESS_TOKEN
 *   INSTAGRAM_META_APP_SECRET      (validação de assinatura de webhook)
 *   INSTAGRAM_META_VERIFY_TOKEN    (handshake de subscrição de webhook)
 *   INSTAGRAM_META_GRAPH_VERSION   (opcional, por omissão v21.0)
 *   INSTAGRAM_META_ENABLED_FOR_REAL_REQUESTS  "1" para levantar o bloqueio
 *                                  APENAS depois da validação oficial
 */

import { BaseInstagramProvider, WEBHOOK_EVENTS, pedidoHttp, erroDeHttp } from './base.mjs';
import { ProviderError, MESSAGE_STATUS, ACCOUNT_STATUS } from './contract.mjs';

const GRAPH_HOST = 'https://graph.facebook.com';
const VERSAO_PADRAO = 'v21.0';

export class MetaInstagramProvider extends BaseInstagramProvider {
  constructor(config = {}, deps = {}) {
    super({
      id: 'meta',
      displayName: 'Meta',
      capabilities: {
        canSendMessage: true,
        canReadConversations: true,
        canReceiveWebhooks: true,
        /* A Meta não expõe um "pode receber DM?" antes do envio: a
           elegibilidade real só se conhece na resposta ao envio. Declarar
           false é mais honesto do que devolver um palpite. */
        canCheckEligibility: false,
        canFetchProfile: true,
        canFetchDeliveryStatus: false
      }
    });
    this.accessToken = config.accessToken || null;
    this.appSecret = config.appSecret || null;
    this.verifyToken = config.verifyToken || null;
    this.graphVersion = config.graphVersion || VERSAO_PADRAO;
    this.timeoutMs = config.timeoutMs || 10000;
    this.fetchImpl = deps.fetch || null;
    /* Bloqueio por omissão: só um opt-in deliberado permite pedidos reais. */
    this.enabledForRealRequests = config.enabledForRealRequests === true;
  }

  /* Ter token não chega: enquanto os endpoints não estiverem validados,
     o fornecedor não conta como configurado para o UI. */
  isConfigured() { return Boolean(this.accessToken) && this.enabledForRealRequests; }

  /** true quando há token mas o adapter continua bloqueado por validar. */
  isBlockedPendingValidation() { return !this.enabledForRealRequests; }

  /** Lança se o adapter estiver bloqueado. Chamado antes de tudo o resto. */
  exigirDesbloqueio() {
    if (!this.enabledForRealRequests) {
      throw new ProviderError(
        'META_PROVIDER_NOT_VALIDATED',
        'MetaInstagramProvider está bloqueado para pedidos reais: os endpoints da Graph API ' +
        'ainda não foram validados contra a documentação oficial. Ver INSTAGRAM_PROVIDERS.md.',
        { status: MESSAGE_STATUS.NOT_CONFIGURED }
      );
    }
  }

  base(caminho) {
    return GRAPH_HOST + '/' + this.graphVersion + caminho;
  }

  exigirConfig() {
    if (!this.accessToken) {
      throw new ProviderError(
        'NOT_CONFIGURED',
        'Meta Instagram sem INSTAGRAM_META_ACCESS_TOKEN configurado no backend.'
      );
    }
  }

  async pedir(url, opts = {}) {
    /* Ponto único de saída para a rede: o bloqueio fica aqui, antes de
       qualquer fetch, para cobrir envio, ligação, perfil e conversas. */
    this.exigirDesbloqueio();
    this.exigirConfig();
    const resp = await pedidoHttp(url, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + this.accessToken,
        ...(opts.headers || {})
      }
    }, this.timeoutMs, this.fetchImpl);

    let corpo = null;
    try { corpo = await resp.json(); } catch (e) { corpo = null; }

    if (!resp.ok) {
      const erroMeta = corpo && corpo.error ? corpo.error : null;
      /* 613 = calls to this api have exceeded the rate limit */
      if (erroMeta && (erroMeta.code === 4 || erroMeta.code === 17 || erroMeta.code === 613)) {
        throw new ProviderError('RATE_LIMITED', erroMeta.message || 'Limite da Meta atingido.', {
          providerStatus: resp.status, retryAfterSec: null
        });
      }
      if (erroMeta && (erroMeta.code === 190 || erroMeta.type === 'OAuthException')) {
        throw new ProviderError('INVALID_TOKEN', erroMeta.message || 'Token da Meta inválido.', {
          providerStatus: resp.status
        });
      }
      if (erroMeta && erroMeta.code === 10) {
        throw new ProviderError('ACCOUNT_RESTRICTED', erroMeta.message || 'Permissão recusada pela Meta.', {
          providerStatus: resp.status
        });
      }
      throw erroDeHttp(resp.status, erroMeta || corpo, resp.headers);
    }
    return corpo || {};
  }

  /* ------------------------------------------------------------ *
   * Conta                                                         *
   * ------------------------------------------------------------ */

  /**
   * A ligação usa um token já emitido pelo fluxo OAuth da Meta — o
   * LeadMap não vê a password do utilizador em momento algum.
   */
  async _connect(params = {}) {
    this.exigirDesbloqueio();
    this.exigirConfig();
    const id = params.providerAccountId || params.igUserId;
    if (!id) {
      throw new ProviderError('INVALID_REQUEST', 'Meta: falta o ID da conta profissional (igUserId).');
    }
    const perfil = await this.pedir(
      this.base('/' + encodeURIComponent(id) + '?fields=id,username,name')
    );
    return {
      providerAccountId: String(perfil.id || id),
      username: perfil.username || params.username || String(id),
      displayName: perfil.name || perfil.username || String(id),
      status: ACCOUNT_STATUS.CONNECTED
    };
  }

  /* ------------------------------------------------------------ *
   * Envio                                                         *
   * ------------------------------------------------------------ */

  async _sendMessage({ account, recipient, message }) {
    this.exigirDesbloqueio();
    const destino = recipient.providerUserId;
    if (!destino) {
      /* A API oficial endereça por IGSID, não por @username. Sem IGSID o
         envio não é possível — e não se inventa nenhum. */
      throw new ProviderError(
        'INVALID_REQUEST',
        'Meta: o envio exige o IGSID do destinatário (obtido de uma conversa existente ou de um webhook).'
      );
    }
    const corpo = await this.pedir(
      this.base('/' + encodeURIComponent(account.providerAccountId) + '/messages'),
      {
        method: 'POST',
        body: JSON.stringify({
          recipient: { id: destino },
          message: { text: message }
        })
      }
    );
    return {
      providerMessageId: corpo.message_id || corpo.mid || null,
      status: MESSAGE_STATUS.SENT
    };
  }

  async _fetchProfile(account, username) {
    const corpo = await this.pedir(
      this.base('/' + encodeURIComponent(account.providerAccountId) +
        '?fields=business_discovery.username(' + encodeURIComponent(username) + '){username,name,followers_count}')
    );
    const bd = corpo.business_discovery;
    if (!bd) return null;
    return {
      username: bd.username || username,
      displayName: bd.name || bd.username || username,
      followers: Number.isFinite(bd.followers_count) ? bd.followers_count : null
    };
  }

  async _listConversations(account, opts = {}) {
    const corpo = await this.pedir(
      this.base('/' + encodeURIComponent(account.providerAccountId) +
        '/conversations?platform=instagram' + (opts.after ? '&after=' + encodeURIComponent(opts.after) : ''))
    );
    return Array.isArray(corpo.data) ? corpo.data : [];
  }

  /* ------------------------------------------------------------ *
   * Webhooks                                                      *
   * ------------------------------------------------------------ */

  _parseWebhook(corpo) {
    if (!corpo || corpo.object !== 'instagram' || !Array.isArray(corpo.entry)) return [];
    const eventos = [];
    for (const entrada of corpo.entry) {
      for (const m of (entrada.messaging || [])) {
        if (m.message && m.message.text && !m.message.is_echo) {
          eventos.push({
            type: WEBHOOK_EVENTS.REPLY_RECEIVED,
            providerAccountId: entrada.id ? String(entrada.id) : null,
            from: m.sender && m.sender.id ? String(m.sender.id) : null,
            text: m.message.text,
            at: m.timestamp ? new Date(Number(m.timestamp)).toISOString() : new Date().toISOString()
          });
        }
        if (m.delivery) {
          for (const mid of (m.delivery.mids || [])) {
            eventos.push({
              type: WEBHOOK_EVENTS.MESSAGE_DELIVERED,
              providerMessageId: mid,
              at: new Date().toISOString()
            });
          }
        }
        if (m.read) {
          eventos.push({
            type: WEBHOOK_EVENTS.MESSAGE_READ,
            providerAccountId: entrada.id ? String(entrada.id) : null,
            at: new Date().toISOString()
          });
        }
      }
    }
    return eventos;
  }
}

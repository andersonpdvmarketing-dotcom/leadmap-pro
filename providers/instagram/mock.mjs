/**
 * LeadMap Pro — MockInstagramProvider
 * ===================================
 * Fornecedor de desenvolvimento e testes. Não faz rede. O comportamento
 * é guionável (`script`) para reproduzir de forma determinística cada
 * cenário de falha exigido: 429, timeout, token inválido, destinatário
 * indisponível, webhook, resposta e estado de entrega.
 */

import { BaseInstagramProvider, WEBHOOK_EVENTS } from './base.mjs';
import { ProviderError, MESSAGE_STATUS, ELIGIBILITY, ACCOUNT_STATUS } from './contract.mjs';

export class MockInstagramProvider extends BaseInstagramProvider {
  /**
   * @param {object} opts
   * @param {object} opts.script   comportamento por destinatário/global
   * @param {object} opts.capabilities  para simular fornecedores limitados
   */
  constructor(opts = {}) {
    super({
      id: opts.id || 'mock',
      displayName: opts.displayName || 'Mock',
      capabilities: opts.capabilities || {
        canSendMessage: true,
        canReadConversations: true,
        canReceiveWebhooks: true,
        canCheckEligibility: true,
        canFetchProfile: true,
        canFetchDeliveryStatus: true
      }
    });
    /* script.falharCom: código de erro a devolver no próximo envio
       script.porDestinatario: { username: 'CODIGO' | 'ok' }
       script.inelegiveis: [username]  ·  script.perfis: { username: {...} } */
    this.script = opts.script || {};
    this.enviadas = [];
    this.contasLigadas = new Map();
    this.entregas = new Map();
    this._seq = 0;
  }

  proximoId() { this._seq += 1; return this.id + '-msg-' + this._seq; }

  async _connect(params = {}) {
    if (params.falhar) throw new ProviderError('INVALID_TOKEN', 'Credencial de teste recusada.');
    const username = params.username || 'conta_teste';
    const conta = {
      providerAccountId: params.providerAccountId || (this.id + '-acct-' + username),
      username,
      displayName: params.displayName || username,
      status: ACCOUNT_STATUS.CONNECTED
    };
    this.contasLigadas.set(conta.providerAccountId, conta);
    return conta;
  }

  async _disconnect(account) {
    if (account && account.providerAccountId) this.contasLigadas.delete(account.providerAccountId);
  }

  async _sendMessage({ account, recipient, message, campaignId }) {
    const alvo = recipient.username || recipient.providerUserId;
    const guiao = (this.script.porDestinatario && this.script.porDestinatario[alvo]) ||
      this.script.falharCom || null;

    if (guiao && guiao !== 'ok') {
      if (guiao === 'RATE_LIMITED') {
        throw new ProviderError('RATE_LIMITED', 'Limite do fornecedor atingido.', {
          retryAfterSec: this.script.retryAfterSec != null ? this.script.retryAfterSec : 60,
          providerStatus: 429
        });
      }
      if (guiao === 'TIMEOUT') throw new ProviderError('TIMEOUT', 'Sem resposta do fornecedor.');
      if (guiao === 'INVALID_TOKEN') throw new ProviderError('INVALID_TOKEN', 'Token inválido ou expirado.');
      if (guiao === 'RECIPIENT_UNAVAILABLE') {
        throw new ProviderError('RECIPIENT_UNAVAILABLE', 'Destinatário indisponível.');
      }
      throw new ProviderError(guiao, 'Falha simulada: ' + guiao);
    }

    const providerMessageId = this.proximoId();
    this.enviadas.push({
      providerMessageId,
      accountId: account.providerAccountId,
      recipient: alvo,
      message,
      campaignId: campaignId || null,
      at: new Date().toISOString()
    });
    this.entregas.set(providerMessageId, MESSAGE_STATUS.SENT);
    return { providerMessageId, status: MESSAGE_STATUS.SENT };
  }

  async _checkEligibility(account, recipient) {
    const alvo = recipient.username || recipient.providerUserId;
    const inelegiveis = this.script.inelegiveis || [];
    return inelegiveis.includes(alvo)
      ? { status: ELIGIBILITY.INELIGIBLE, reason: 'Conta não aceita mensagens.' }
      : { status: ELIGIBILITY.ELIGIBLE, reason: null };
  }

  async _fetchProfile(account, username) {
    const perfis = this.script.perfis || {};
    return perfis[username] || { username, displayName: username, followers: null };
  }

  async _getDeliveryStatus(account, providerMessageId) {
    const estado = this.entregas.get(providerMessageId);
    return { status: estado || MESSAGE_STATUS.UNKNOWN, updatedAt: new Date().toISOString() };
  }

  async _listConversations() {
    return this.script.conversas || [];
  }

  /** Marca uma entrega — usado nos testes para simular o webhook do fornecedor. */
  marcarEntrega(providerMessageId, status) {
    this.entregas.set(providerMessageId, status);
  }

  _parseWebhook(corpo) {
    if (!corpo || !Array.isArray(corpo.events)) return [];
    return corpo.events.map(e => {
      if (e.kind === 'delivered') {
        this.entregas.set(e.messageId, MESSAGE_STATUS.DELIVERED);
        return {
          type: WEBHOOK_EVENTS.MESSAGE_DELIVERED,
          providerMessageId: e.messageId,
          at: e.at || new Date().toISOString()
        };
      }
      if (e.kind === 'read') {
        this.entregas.set(e.messageId, MESSAGE_STATUS.READ);
        return {
          type: WEBHOOK_EVENTS.MESSAGE_READ,
          providerMessageId: e.messageId,
          at: e.at || new Date().toISOString()
        };
      }
      if (e.kind === 'failed') {
        this.entregas.set(e.messageId, MESSAGE_STATUS.FAILED);
        return {
          type: WEBHOOK_EVENTS.MESSAGE_FAILED,
          providerMessageId: e.messageId,
          errorCode: e.errorCode || 'UNKNOWN',
          at: e.at || new Date().toISOString()
        };
      }
      if (e.kind === 'reply') {
        return {
          type: WEBHOOK_EVENTS.REPLY_RECEIVED,
          providerAccountId: e.accountId || null,
          from: e.from,
          text: e.text,
          at: e.at || new Date().toISOString()
        };
      }
      if (e.kind === 'account_status') {
        return {
          type: WEBHOOK_EVENTS.ACCOUNT_STATUS_CHANGED,
          providerAccountId: e.accountId || null,
          status: ACCOUNT_STATUS[e.status] || ACCOUNT_STATUS.ERROR,
          at: e.at || new Date().toISOString()
        };
      }
      return null;
    }).filter(Boolean);
  }
}

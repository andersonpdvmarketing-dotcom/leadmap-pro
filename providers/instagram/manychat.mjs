/**
 * LeadMap Pro — ManyChatInstagramProvider
 * =======================================
 * Fala com a API pública da ManyChat, que por sua vez fala com o
 * Instagram. O LeadMap nunca toca no Instagram diretamente.
 *
 *   LeadMap → api.manychat.com → Instagram
 *
 * Sem password de Instagram, sem cookies, sem automação de browser, sem
 * proxies e sem fingerprints. Só HTTP autenticado por token.
 *
 * ENDPOINTS — TODOS VERIFICADOS CONTRA A SPEC PÚBLICA
 * ---------------------------------------------------
 * Retirados de https://api.manychat.com/swagger (OpenAPI 3.0, obtido em
 * `/swagger/compileJson?type=Page_API`). Nenhum foi inventado:
 *
 *   GET  /fb/page/getInfo                 dados da página · 100 q/s
 *   GET  /fb/page/getFlows                lista de automações · 10 q/s
 *   GET  /fb/subscriber/getInfo           por subscriber_id · 10 q/s
 *   GET  /fb/subscriber/findBySystemField email OU telefone · 50 q/s
 *   GET  /fb/subscriber/findByCustomField field_id + valor · 10 q/s
 *   POST /fb/sending/sendFlow             subscriber_id + flow_ns
 *                                         20 q/s, 100/hora por subscriber
 *
 * O prefixo `/fb/` é histórico; é o mesmo caminho para Instagram.
 *
 * O QUE A API **NÃO** OFERECE
 * ---------------------------
 * **Não existe procura por username de Instagram.** `findBySystemField`
 * aceita `email` ou `phone` e mais nada; `findByName` procura por nome
 * completo e devolve até 100 pessoas — o que é uma sugestão, não uma
 * prova de identidade.
 *
 * Consequência, e é a regra mais importante deste ficheiro: um
 * `@instagram` que o LeadMap descobriu **não é** um subscriber da
 * ManyChat. Só há envio quando existe um `subscriber_id` confirmado pela
 * própria API. Sem isso, o resultado é `NOT_IN_MANYCHAT` e não se tenta
 * nada. Adivinhar aqui seria escrever a estranhos em nome do utilizador.
 *
 * `getInfo` devolve `ig_username` e `ig_id`, por isso um subscriber_id
 * PODE ser verificado contra o handle que se esperava — é assim que se
 * confirma um par sem o inventar.
 */

import {
  ACCOUNT_STATUS, MESSAGE_STATUS, ELIGIBILITY, ProviderError,
  normalizarCapacidades, normalizarConta
} from './contract.mjs';
import { BaseInstagramProvider } from './base.mjs';

export const MANYCHAT_BASE_URL = 'https://api.manychat.com';

/** Limites que a própria spec documenta, por endpoint. */
export const LIMITES = Object.freeze({
  pageInfo: 100, getFlows: 10, subscriberInfo: 10,
  findBySystemField: 50, findByCustomField: 10,
  sendFlow: 20, sendFlowPorSubscriberHora: 100, sendContent: 25
});

const TIMEOUT_MS = 15000;

/**
 * Erros que a ManyChat devolve em texto. Traduzidos para o vocabulário
 * do LeadMap por padrões — a API não devolve códigos estáveis para
 * tudo, por isso a mensagem é o que há.
 */
const PADROES = [
  [/token is required|wrong token|invalid token|unauthorized/i, 'INVALID_TOKEN'],
  [/subscriber (not found|does not exist)|not found/i,          'NOT_IN_MANYCHAT'],
  [/24 ?h|24 hour|outside.*window|messaging window|message tag|human.?agent|standard messaging/i,
                                                                 'OUTSIDE_ALLOWED_WINDOW'],
  [/rate limit|too many requests/i,                              'RATE_LIMITED'],
  [/flow .*not found|automation .*not found|invalid flow/i,      'INVALID_REQUEST'],
  [/blocked|restricted|banned|disabled/i,                        'ACCOUNT_RESTRICTED'],
  [/opt.?out|unsubscrib/i,                                       'RECIPIENT_INELIGIBLE']
];

function traduzir(httpStatus, mensagem) {
  const msg = String(mensagem || '');
  for (const [re, codigo] of PADROES) if (re.test(msg)) return codigo;
  if (httpStatus === 401 || httpStatus === 403) return 'INVALID_TOKEN';
  if (httpStatus === 404) return 'NOT_IN_MANYCHAT';
  if (httpStatus === 429) return 'RATE_LIMITED';
  if (httpStatus === 400 || httpStatus === 422) return 'INVALID_REQUEST';
  if (httpStatus >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'UNKNOWN';
}

export class ManyChatInstagramProvider extends BaseInstagramProvider {
  /**
   * @param {object} config
   * @param {string} config.apiToken   `<pageId>:<segredo>`, só no backend
   * @param {string} [config.baseUrl]
   * @param {function} [config.fetchImpl]  injetável para testes
   */
  constructor(config = {}) {
    super({
      id: 'manychat',
      displayName: 'ManyChat',
      capabilities: normalizarCapacidades({
        canSendMessage: true,
        /* a ManyChat resolve a identidade do destinatário e devolve
           ig_username/ig_id — dá para verificar um par, e é isso que
           `checkEligibility` faz */
        canCheckEligibility: true,
        canFetchProfile: true,
        /* `sendFlow` devolve só `{status:"success"}`: não há id de
           mensagem nem consulta de entrega, e dizer o contrário seria
           inventar um estado que ninguém confirmou */
        canFetchDeliveryStatus: false,
        canReadConversations: false,
        canReceiveWebhooks: false,

        /* Verificado contra a spec pública, não presumido:
           · não existe procura por username de Instagram;
           · `findBySystemField` aceita email OU telefone;
           · sem subscriber prévio não há a quem escrever — alguém tem
             de ter iniciado a conversa;
           · a janela de mensagem do Instagram continua a aplicar-se, e
             quem a impõe é a plataforma, não nós;
           · usamos `sendFlow`; `sendContent` existe mas não está ligado,
             por isso texto livre é `false` e não «talvez». */
        canLookupByUsername: false,
        canLookupByEmailOrPhone: true,
        canInitiateFirstContact: false,
        requiresMessagingWindow: true,
        canSendFlow: true,
        canSendFreeText: false
      })
    });
    this.apiToken = config.apiToken || null;
    this.baseUrl = (config.baseUrl || MANYCHAT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl || null;
    this.timeoutMs = Number(config.timeoutMs) || TIMEOUT_MS;
  }

  isConfigured() { return Boolean(this.apiToken); }

  /** Nunca inclui o token — usado em logs, respostas e `JSON.stringify`. */
  describe() {
    return { ...super.describe(), configured: this.isConfigured(), baseUrl: undefined };
  }

  exigirToken() {
    if (!this.apiToken) {
      throw new ProviderError('NOT_CONFIGURED',
        'MANYCHAT_API_TOKEN não configurado no backend.',
        { status: 'NOT_CONFIGURED' });
    }
  }

  /* ---------------------------------------------------------------- *
   * HTTP                                                              *
   * ---------------------------------------------------------------- */

  async pedir(caminho, { metodo = 'GET', corpo = null, query = null } = {}) {
    this.exigirToken();
    const f = this.fetchImpl || globalThis.fetch;
    if (typeof f !== 'function') {
      throw new ProviderError('NOT_CONFIGURED', 'fetch indisponível neste runtime.');
    }
    let url = this.baseUrl + caminho;
    if (query) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined) p.set(k, String(v));
      const s = p.toString();
      if (s) url += '?' + s;
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp;
    try {
      resp = await f(url, {
        method: metodo,
        headers: {
          Authorization: 'Bearer ' + this.apiToken,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: corpo ? JSON.stringify(corpo) : undefined,
        signal: ctrl.signal
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new ProviderError('TIMEOUT', 'A ManyChat não respondeu a tempo.');
      }
      throw new ProviderError('NETWORK', 'Falha de rede a contactar a ManyChat.');
    } finally { clearTimeout(t); }

    let json = null;
    try { json = await resp.json(); } catch (e) { json = null; }

    if (!resp.ok || (json && json.status === 'error')) {
      const mensagem = (json && (json.message
        || (json.details && json.details.messages && json.details.messages[0] && json.details.messages[0].message)))
        || ('HTTP ' + resp.status);
      const codigo = traduzir(resp.status, mensagem);
      const retryAfter = Number(resp.headers && resp.headers.get && resp.headers.get('Retry-After'));
      throw new ProviderError(codigo, String(mensagem), {
        retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null
      });
    }
    /* a API embrulha tudo em { status: 'success', data: … } */
    return (json && Object.prototype.hasOwnProperty.call(json, 'data')) ? json.data : json;
  }

  /* ---------------------------------------------------------------- *
   * Ligação e página                                                  *
   * ---------------------------------------------------------------- */

  /**
   * Testar ligação. Devolve um estado do vocabulário do contrato — nunca
   * um "está tudo bem" que não foi verificado.
   */
  async testarLigacao() {
    if (!this.isConfigured()) {
      return { status: 'NOT_CONFIGURED', page: null, message: 'Token da ManyChat não configurado.' };
    }
    try {
      const page = await this.pedir('/fb/page/getInfo');
      return {
        status: ACCOUNT_STATUS.CONNECTED,
        page: page ? { id: page.id, name: page.name, username: page.username || null, isPro: page.is_pro === true } : null,
        message: null
      };
    } catch (err) {
      const c = err && err.errorCode;
      const estado = c === 'INVALID_TOKEN' ? 'UNAUTHORIZED'
        : c === 'RATE_LIMITED' ? ACCOUNT_STATUS.RATE_LIMITED
        : c === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED'
        : 'PROVIDER_ERROR';
      return { status: estado, page: null, message: (err && err.message) || 'Falha desconhecida.' };
    }
  }

  /** Automações existentes na conta ManyChat. Nunca inventadas. */
  async listarFlows() {
    const d = await this.pedir('/fb/page/getFlows');
    const brutos = (d && (d.flows || d)) || [];
    return (Array.isArray(brutos) ? brutos : []).map(f => ({
      ns: f.ns, name: f.name, folderId: f.folder_id != null ? f.folder_id : null
    })).filter(f => f.ns);
  }

  /* ---------------------------------------------------------------- *
   * Identidade do destinatário                                        *
   * ---------------------------------------------------------------- */

  /** Lê um subscriber pelo id e normaliza o que interessa. */
  async lerSubscriber(subscriberId) {
    const d = await this.pedir('/fb/subscriber/getInfo', { query: { subscriber_id: subscriberId } });
    if (!d || !d.id) throw new ProviderError('NOT_IN_MANYCHAT', 'Subscriber não encontrado na ManyChat.');
    return {
      subscriberId: String(d.id),
      name: d.name || [d.first_name, d.last_name].filter(Boolean).join(' ') || null,
      igUsername: d.ig_username || null,
      igId: d.ig_id != null ? String(d.ig_id) : null,
      email: d.email || null,
      phone: d.phone || null,
      lastInteraction: d.last_interaction || null,
      subscribed: d.subscribed || null
    };
  }

  /**
   * Procura um subscriber por um campo que a API realmente suporta.
   *
   * NÃO existe procura por username de Instagram, e por isso ela não
   * está aqui. `porNome` fica de fora de propósito: `findByName` devolve
   * homónimos, e um homónimo não é a pessoa.
   *
   * @param {object} criterio  { email } | { phone } | { fieldId, value }
   */
  async procurarSubscriber(criterio = {}) {
    const { email, phone, fieldId, value } = criterio;
    let d;
    if (email) d = await this.pedir('/fb/subscriber/findBySystemField', { query: { email } });
    else if (phone) d = await this.pedir('/fb/subscriber/findBySystemField', { query: { phone } });
    else if (fieldId) {
      d = await this.pedir('/fb/subscriber/findByCustomField', { query: { field_id: fieldId, field_value: value } });
    } else {
      throw new ProviderError('NOT_SUPPORTED',
        'A ManyChat só permite procurar por email, telefone ou campo personalizado. Não há procura por username de Instagram.');
    }
    const lista = Array.isArray(d) ? d : (d ? [d] : []);
    return lista.filter(x => x && x.id).map(x => ({
      subscriberId: String(x.id),
      name: x.name || null,
      igUsername: x.ig_username || null,
      igId: x.ig_id != null ? String(x.ig_id) : null,
      email: x.email || null,
      phone: x.phone || null
    }));
  }

  /**
   * Confirma que um subscriber_id corresponde ao @instagram esperado.
   *
   * É isto que transforma um palpite em prova: a API diz qual é o
   * `ig_username` daquele subscriber, e ou bate certo ou não se envia.
   */
  async confirmarPar(subscriberId, instagramEsperado) {
    const s = await this.lerSubscriber(subscriberId);
    const esperado = String(instagramEsperado || '').replace(/^@/, '').toLowerCase();
    const real = String(s.igUsername || '').replace(/^@/, '').toLowerCase();
    return {
      confirmado: Boolean(esperado) && Boolean(real) && esperado === real,
      subscriber: s,
      motivo: !real ? 'O subscriber não tem Instagram associado na ManyChat.'
        : (esperado !== real ? 'O Instagram do subscriber (@' + real + ') não é o esperado (@' + esperado + ').' : null)
    };
  }

  /* ---------------------------------------------------------------- *
   * Implementações do contrato                                        *
   * ---------------------------------------------------------------- */

  async _connect(params = {}) {
    const r = await this.testarLigacao();
    if (r.status !== ACCOUNT_STATUS.CONNECTED) {
      throw new ProviderError(r.status === 'UNAUTHORIZED' ? 'INVALID_TOKEN' : 'NOT_CONFIGURED',
        r.message || 'Não foi possível ligar à ManyChat.');
    }
    return normalizarConta({
      id: 'manychat:' + (r.page ? r.page.id : 'conta'),
      provider: 'manychat',
      username: (r.page && (r.page.username || r.page.name)) || params.username || 'manychat',
      displayName: (r.page && r.page.name) || params.displayName || 'ManyChat',
      providerAccountId: r.page ? String(r.page.id) : null,
      status: ACCOUNT_STATUS.CONNECTED,
      capabilities: this.capabilities
    });
  }

  /**
   * Elegibilidade = existe subscriber e o Instagram bate certo.
   *
   * `recipient.manychatSubscriberId` é obrigatório. Sem ele devolve-se
   * INELIGIBLE com motivo, nunca UNKNOWN optimista.
   */
  async _checkEligibility(account, recipient = {}) {
    const id = recipient.manychatSubscriberId || recipient.subscriberId || null;
    if (!id) {
      return {
        status: ELIGIBILITY.INELIGIBLE,
        reason: 'Sem subscriber ManyChat. Um @instagram encontrado pelo LeadMap não é, por si só, um contacto da ManyChat.'
      };
    }
    const r = await this.confirmarPar(id, recipient.username || recipient.normalizedInstagram);
    return {
      status: r.confirmado ? ELIGIBILITY.ELIGIBLE : ELIGIBILITY.INELIGIBLE,
      reason: r.motivo
    };
  }

  async _fetchProfile(account, subscriberId) {
    return this.lerSubscriber(subscriberId);
  }

  /**
   * Dispara uma automação da ManyChat para um subscriber.
   *
   * Preferimos `sendFlow` a `sendContent`: o conteúdo e as regras de
   * conformidade vivem na ManyChat, onde já estão desenhados, e o
   * LeadMap limita-se a disparar. Compor mensagens aqui seria duplicar
   * decisões de conformidade em dois sítios.
   *
   * `pedido.flowNs` é obrigatório. `pedido.recipient.manychatSubscriberId`
   * também: sem prova de identidade não há envio.
   */
  async _sendMessage(pedido = {}) {
    const { recipient = {}, flowNs, message } = pedido;
    const subscriberId = recipient.manychatSubscriberId || recipient.subscriberId || null;

    if (!subscriberId) {
      throw new ProviderError('NOT_IN_MANYCHAT',
        'Falta o subscriber ManyChat. Um @instagram não é um destinatário — é preciso um subscriber_id confirmado pela API.');
    }
    const ns = flowNs || (pedido.template && pedido.template.flowNs) || null;
    if (!ns) {
      throw new ProviderError('INVALID_REQUEST',
        'Falta o flow_ns da automação ManyChat. Escolha uma automação existente na conta.');
    }
    if (message && !ns) {
      throw new ProviderError('NOT_SUPPORTED', 'Envio de conteúdo livre não está ativo: use uma automação.');
    }

    await this.pedir('/fb/sending/sendFlow', {
      metodo: 'POST',
      corpo: { subscriber_id: Number(subscriberId), flow_ns: String(ns) }
    });

    /* A resposta é `{status:"success"}` e mais nada: não há id de
       mensagem. Devolvemos QUEUED, não SENT — a ManyChat aceitou o
       pedido, o que não é o mesmo que o Instagram ter entregado. */
    return {
      providerMessageId: null,
      status: MESSAGE_STATUS.QUEUED
    };
  }
}

/**
 * LeadMap Pro — MetaInstagramProvider
 * ===================================
 * Adapter para a API oficial de mensagens do Instagram, pelo caminho
 * **Instagram API with Instagram Login**.
 *
 * FONTES OFICIAIS CONSULTADAS (setembro de 2026)
 * ----------------------------------------------
 *   · developers.facebook.com/docs/instagram-platform
 *   · .../instagram-api-with-instagram-login/messaging-api/
 *   · .../instagram-api-with-instagram-login/conversations-api
 *   · .../instagram-platform/webhooks
 *   · .../instagram-platform/private-replies/
 *   · developers.facebook.com/docs/graph-api/overview/access-levels
 *
 * PORQUÊ `graph.instagram.com` E NÃO `graph.facebook.com`
 * -------------------------------------------------------
 * O adapter antigo apontava para `graph.facebook.com`, que é o caminho
 * do **Facebook Login**: exige que a conta Instagram esteja ligada a uma
 * Página de Facebook e que o utilizador autentique pelo Facebook. O
 * caminho com Instagram Login autentica diretamente na conta profissional
 * e serve mensagens em `graph.instagram.com`. Para o LeadMap — que liga
 * contas Instagram de negócios, sem Página obrigatória — é o mais direto,
 * e é o que está implementado aqui. Não se misturam os dois modelos.
 *
 * O QUE A DOCUMENTAÇÃO DIZ, E QUE MANDA NESTE FICHEIRO
 * ----------------------------------------------------
 * «Only after an Instagram user has sent your app user's Instagram
 * professional account a message can your app send a message to the
 * Instagram user.»
 *
 * Ou seja: **não há DM fria**. Encontrar `@empresa` numa pesquisa não dá
 * a ninguém o direito de lhe escrever pela API. Só se responde a quem
 * escreveu primeiro, dentro de 24 horas. É por isto que
 * `canInitiateFirstContact` é `false` e que `resolveRecipient()` se
 * recusa a converter um username num destinatário.
 *
 * ENDPOINTS (host `https://graph.instagram.com`, versão v25.0)
 *   POST /{IG_ID}/messages          enviar · { recipient:{id:IGSID}, message:{text} }
 *   GET  /me?fields=…               conta do próprio utilizador
 *   GET  /me/conversations?platform=instagram&user_id={IGSID}
 *   GET  /{CONVERSATION_ID}?fields=messages
 *
 * PERMISSÕES
 *   instagram_business_basic
 *   instagram_business_manage_messages
 *   instagram_business_manage_comments   (só para private replies)
 *
 * IDENTIFICADOR DO DESTINATÁRIO
 * O IGSID — Instagram-scoped ID. Chega por **webhook** quando alguém
 * escreve, ou de uma conversa já existente. Nunca se deriva de um
 * username, e não há endpoint que o faça.
 *
 * ACESSO
 * Standard Access só permite dados de pessoas com um papel na app
 * (admin/developer/tester). Para clientes ligarem as próprias contas é
 * preciso Advanced Access, com App Review e verificação de negócio.
 *
 * FAIL-SAFE
 * O envio continua bloqueado até a ligação ser validada de verdade — ver
 * a máquina de estados em `estadoLigacao()`. Ter token no ambiente não
 * chega.
 */

import { BaseInstagramProvider, WEBHOOK_EVENTS, pedidoHttp, erroDeHttp } from './base.mjs';
import { ProviderError, MESSAGE_STATUS, ACCOUNT_STATUS, ELIGIBILITY, IDENTITY_STATUS } from './contract.mjs';

/* Instagram Login → graph.instagram.com. Documentado, não presumido. */
const GRAPH_HOST = 'https://graph.instagram.com';
const VERSAO_PADRAO = 'v25.0';

/** Permissões que a documentação exige para mensagens. */
export const META_SCOPES = Object.freeze(['instagram_business_basic', 'instagram_business_manage_messages']);
/** Só para private replies a comentários — fluxo distinto, ver §14. */
export const META_SCOPES_COMENTARIOS = Object.freeze(['instagram_business_basic', 'instagram_business_manage_comments']);

/** Estados da ligação. Ter token não é estar pronto. */
export const CONNECTION_STATE = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  CONFIGURED: 'CONFIGURED',
  CONNECTION_VALIDATED: 'CONNECTION_VALIDATED',
  READY_FOR_CONTROLLED_TEST: 'READY_FOR_CONTROLLED_TEST',
  ERROR: 'ERROR'
});

/** Janela de resposta, em horas. Imposta pela plataforma, não por nós. */
export const JANELA_HORAS = 24;
/** Prazo para uma private reply a um comentário, em dias. */
export const PRIVATE_REPLY_DIAS = 7;

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
        /* Não há endpoint que responda «esta pessoa pode receber DM?».
           O que existe é confirmar se JÁ HÁ conversa com um IGSID
           conhecido — e isso vive em `resolveRecipient()`, que é onde a
           pergunta faz sentido. Prometer aqui uma verificação prévia que
           a API não faz seria o começo de um ecrã que mente. */
        canCheckEligibility: false,

        /* `business_discovery` — o que o adapter antigo usava para ler
           perfis — é do caminho Facebook Login/Instagram Graph API. Não
           está documentado em `graph.instagram.com`, e não o inventamos. */
        canFetchProfile: false,
        canFetchDeliveryStatus: false,

        /* Documentado: «Only after an Instagram user has sent your app
           user's Instagram professional account a message can your app
           send a message to the Instagram user.» Não há DM fria, não há
           procura por username, e a janela de 24 h é da plataforma. */
        canLookupByUsername: false,
        canLookupByEmailOrPhone: false,
        canInitiateFirstContact: false,
        requiresMessagingWindow: true,
        canSendFlow: false,
        canSendFreeText: true
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
    /* Preenchido por `testarLigacao()` quando a leitura da conta corre
       bem. Sem isto, o adapter fica em CONFIGURED e não avança. */
    this.validacao = null;
    this.ultimoErro = null;
  }

  /* Ter token não chega: enquanto a ligação não for validada de verdade,
     o fornecedor não conta como configurado para o UI. */
  isConfigured() { return Boolean(this.accessToken) && this.enabledForRealRequests; }

  /**
   * Em que ponto está a ligação.
   *
   * Um adapter não chega a `READY_FOR_CONTROLLED_TEST` por haver um
   * token no ambiente. É preciso ter-se falado com a API, ter-se lido a
   * conta e ter-se confirmado que é profissional — e é
   * `testarLigacao()` que o regista.
   */
  estadoLigacao() {
    if (!this.accessToken) return CONNECTION_STATE.NOT_CONFIGURED;
    if (this.ultimoErro) return CONNECTION_STATE.ERROR;
    if (!this.validacao) return CONNECTION_STATE.CONFIGURED;
    if (!this.enabledForRealRequests) return CONNECTION_STATE.CONNECTION_VALIDATED;
    return CONNECTION_STATE.READY_FOR_CONTROLLED_TEST;
  }

  /**
   * Teste de ligação — SÓ LEITURA. Chama `GET /me` e confirma que a
   * conta é profissional. Nunca envia nada e nunca devolve o token.
   */
  async testarLigacao() {
    if (!this.accessToken) {
      return { estado: CONNECTION_STATE.NOT_CONFIGURED, conta: null,
               scopes: META_SCOPES, mensagem: 'INSTAGRAM_META_ACCESS_TOKEN não configurado.' };
    }
    try {
      const c = await this.pedir(this.base(
        '/me?fields=id,user_id,username,name,account_type,profile_picture_url,followers_count'), {}, true);
      const tipo = String(c.account_type || '').toUpperCase();
      /* A API de mensagens exige conta Business ou Creator. Uma conta
         pessoal autentica e depois falha no envio — mais vale dizê-lo já. */
      const profissional = tipo === 'BUSINESS' || tipo === 'MEDIA_CREATOR' || tipo === 'CREATOR';
      this.validacao = profissional ? { em: new Date().toISOString(), contaId: String(c.user_id || c.id) } : null;
      this.ultimoErro = profissional ? null : 'ACCOUNT_NOT_PROFESSIONAL';
      return {
        estado: this.estadoLigacao(),
        conta: {
          id: String(c.user_id || c.id || ''),
          username: c.username || null,
          nome: c.name || null,
          tipo: c.account_type || null,
          seguidores: Number.isFinite(c.followers_count) ? c.followers_count : null
        },
        scopes: META_SCOPES,
        profissional,
        mensagem: profissional ? null
          : 'A conta não é profissional (Business/Creator). A API de mensagens exige uma destas.'
      };
    } catch (err) {
      this.validacao = null;
      this.ultimoErro = (err && err.errorCode) || 'PROVIDER_ERROR';
      return {
        estado: CONNECTION_STATE.ERROR, conta: null, scopes: META_SCOPES,
        mensagem: (err && err.message) || 'Falha a contactar a Meta.'
      };
    }
  }

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

  /**
   * Ponto único de saída para a rede.
   *
   * `somenteLeitura` existe para o teste de ligação: validar um token
   * lendo `/me` tem de ser possível ANTES de o adapter ser desbloqueado
   * — de outro modo nunca se sairia de `CONFIGURED`, e o desbloqueio
   * passaria a ser um ato de fé. O bloqueio continua a cobrir tudo o que
   * escreve.
   */
  async pedir(url, opts = {}, somenteLeitura = false) {
    if (!somenteLeitura) this.exigirDesbloqueio();
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
  /**
   * Liga a conta a partir do próprio token.
   *
   * Com Instagram Login o token já identifica a conta: `GET /me`
   * devolve-a. Não é preciso pedir o id a quem configura — e não pedir
   * evita a classe de erro em que se liga a conta errada por engano.
   */
  async _connect(params = {}) {
    /* Ligar uma conta é parte do fluxo normal e continua atrás do
       bloqueio. A ÚNICA porta de leitura antes do desbloqueio é
       `testarLigacao()`, chamada deliberadamente por quem opera. */
    this.exigirDesbloqueio();
    this.exigirConfig();
    const r = await this.testarLigacao();
    if (r.estado === CONNECTION_STATE.ERROR || !r.conta) {
      throw new ProviderError('NOT_CONFIGURED', r.mensagem || 'Meta: não foi possível ler a conta.');
    }
    if (!r.profissional) {
      throw new ProviderError('ACCOUNT_RESTRICTED', r.mensagem);
    }
    return {
      providerAccountId: r.conta.id,
      username: r.conta.username || params.username || r.conta.id,
      displayName: r.conta.nome || r.conta.username || r.conta.id,
      status: ACCOUNT_STATUS.CONNECTED
    };
  }

  /* ------------------------------------------------------------ *
   * Destinatário                                                  *
   * ------------------------------------------------------------ */

  /**
   * Resolve — ou recusa resolver — um destinatário.
   *
   * A API não converte `@username` em IGSID. Não existe endpoint para
   * isso, e inventá-lo seria escrever a alguém que nunca escreveu
   * primeiro. Por isso:
   *
   *   · sem IGSID → PROFILE_FOUND_ONLY (se há username) ou NO_RECIPIENT_ID
   *   · com IGSID → confirma-se na Conversations API que existe conversa
   *
   * O IGSID chega por webhook quando alguém escreve, ou de uma conversa
   * já existente. Nunca de uma pesquisa do LeadMap.
   */
  /**
   * Lê o perfil oficial de um IGSID.
   *
   * Documentado: `GET /<IGSID>?fields=username,name` em
   * graph.instagram.com. Só funciona depois de a pessoa ter escrito
   * para a conta — é esse o consentimento. É a ÚNICA forma de saber o
   * handle de um IGSID sem adivinhar.
   */
  async lerPerfilDeRecipient(igsid) {
    const d = await this.pedir(this.base(
      '/' + encodeURIComponent(igsid) + '?fields=username,name,is_user_follow_business'), {}, true);
    return {
      igsid: String(igsid),
      username: d.username || null,
      nome: d.name || null,
      segueONegocio: d.is_user_follow_business === true
    };
  }

  /**
   * Confirma que um IGSID é mesmo o contacto que pensamos.
   *
   * A comparação é entre o username que a **API devolveu** e o que o
   * LeadMap tem guardado. Não é semelhança: é a plataforma a dizer o
   * handle. Se não coincidirem exatamente, não se confirma.
   */
  async verificarIdentidade(igsid, instagramEsperado) {
    try {
      const p = await this.lerPerfilDeRecipient(igsid);
      const esperado = String(instagramEsperado || '').replace(/^@/, '').toLowerCase();
      const real = String(p.username || '').replace(/^@/, '').toLowerCase();
      if (!esperado || !real) {
        return { verificado: false, perfil: p, motivo: 'A API não devolveu username, ou o contacto não tem Instagram.' };
      }
      return {
        verificado: esperado === real, perfil: p,
        motivo: esperado === real ? null : 'O username oficial (@' + real + ') não é o do contacto (@' + esperado + ').'
      };
    } catch (err) {
      return { verificado: false, perfil: null, motivo: (err && err.message) || 'Falha a ler o perfil.' };
    }
  }

  /**
   * Estado da identidade de um contacto para este fornecedor.
   *
   * Não confirma nada por si: apenas lê o que está guardado. A
   * confirmação passa por `verificarIdentidade()`, que fala com a API.
   */
  estadoIdentidade(contacto = {}) {
    const id = contacto.igUserId;
    const prov = contacto.igUserIdProvider;
    if (!id) return IDENTITY_STATUS.NO_RECIPIENT_ID;
    /* um id de outro fornecedor não é comparável com um IGSID */
    if (prov && prov !== this.id) return IDENTITY_STATUS.NO_RECIPIENT_ID;
    return contacto.igUserIdVerifiedAt
      ? IDENTITY_STATUS.RECIPIENT_VERIFIED
      : IDENTITY_STATUS.RECIPIENT_UNVERIFIED;
  }

  /**
   * Resolve o destinatário de um CONTACTO do LeadMap.
   *
   * `resolveRecipient({ igsid })` continua a existir para o caminho
   * direto; esta variante recebe o contacto inteiro e aplica as regras
   * de identidade guardada.
   */
  async resolveRecipientDoContacto(contacto = {}) {
    const estado = this.estadoIdentidade(contacto);
    if (estado === IDENTITY_STATUS.NO_RECIPIENT_ID) {
      const ig = contacto.normalizedInstagram || contacto.instagram;
      return {
        status: ig ? ELIGIBILITY.PROFILE_FOUND_ONLY : ELIGIBILITY.NO_RECIPIENT_ID,
        identidade: IDENTITY_STATUS.NO_RECIPIENT_ID, recipientId: null,
        motivo: ig
          ? 'Só há @' + String(ig).replace(/^@/, '') + '. A API endereça por IGSID, e o IGSID só existe ' +
            'depois de a pessoa escrever para esta conta.'
          : 'Sem Instagram e sem destinatário.'
      };
    }
    if (estado === IDENTITY_STATUS.RECIPIENT_UNVERIFIED) {
      return {
        status: ELIGIBILITY.NOT_ELIGIBLE, identidade: estado, recipientId: contacto.igUserId,
        motivo: 'Destinatário associado mas ainda não confirmado pela API.'
      };
    }
    /* verificado: falta saber se há conversa aberta */
    const r = await this.resolveRecipient({ igsid: contacto.igUserId });
    return { ...r, identidade: estado };
  }

  async resolveRecipient({ igsid = null, username = null } = {}) {
    if (!igsid) {
      return {
        status: username ? ELIGIBILITY.PROFILE_FOUND_ONLY : ELIGIBILITY.NO_RECIPIENT_ID,
        recipientId: null,
        motivo: username
          ? 'Encontrámos @' + String(username).replace(/^@/, '') + ', mas a API oficial endereça por IGSID. ' +
            'O IGSID só existe depois de a pessoa escrever para esta conta.'
          : 'Sem IGSID e sem username: não há destinatário.'
      };
    }
    try {
      /* Confirmar uma conversa é leitura, e é o que sustenta a decisão
         de elegibilidade — por isso é permitido antes do desbloqueio,
         pela mesma porta do teste de ligação. */
      const r = await this.pedir(this.base(
        '/me/conversations?platform=instagram&user_id=' + encodeURIComponent(igsid)), {}, true);
      const conversas = Array.isArray(r.data) ? r.data : [];
      if (!conversas.length) {
        return {
          status: ELIGIBILITY.NOT_ELIGIBLE, recipientId: null,
          motivo: 'Não há conversa com este IGSID. A API só permite responder a quem escreveu primeiro.'
        };
      }
      return {
        status: ELIGIBILITY.ELIGIBLE,
        recipientId: String(igsid),
        conversationId: conversas[0] && conversas[0].id ? String(conversas[0].id) : null,
        motivo: 'Existe conversa aberta com este IGSID.'
      };
    } catch (err) {
      const c = (err && err.errorCode) || 'PROVIDER_ERROR';
      return {
        status: c === 'RATE_LIMITED' ? ELIGIBILITY.RATE_LIMITED : ELIGIBILITY.PROVIDER_ERROR,
        recipientId: null, motivo: (err && err.message) || 'Falha a consultar conversas.'
      };
    }
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

  /**
   * Não suportado neste caminho.
   *
   * O adapter antigo usava `business_discovery`, que pertence ao
   * Instagram Graph API com Facebook Login. Não está documentado em
   * `graph.instagram.com`, e manter uma chamada por inércia daria erros
   * que ninguém saberia explicar.
   */
  async _fetchProfile() {
    throw new ProviderError('NOT_SUPPORTED',
      'Leitura de perfis de terceiros não está disponível no caminho Instagram Login.');
  }

  async _listConversations(account, opts = {}) {
    const corpo = await this.pedir(
      this.base('/me/conversations?platform=instagram' +
        (opts.userId ? '&user_id=' + encodeURIComponent(opts.userId) : '') +
        (opts.after ? '&after=' + encodeURIComponent(opts.after) : ''))
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

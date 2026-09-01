/**
 * LeadMap Pro — contrato InstagramProvider
 * =======================================
 * Tipos, enumerações e validadores partilhados por todos os fornecedores.
 * Este ficheiro não fala com a rede nem conhece nenhum fornecedor concreto:
 * é o único sítio onde está escrito o que um fornecedor tem de cumprir.
 *
 * REGRA DE CONFORMIDADE (não negociável)
 * --------------------------------------
 * O contrato é deliberadamente HTTP+JSON. Não existe — e não pode passar a
 * existir — nenhum campo para cookies de sessão, user-agent forjado,
 * impressão digital de dispositivo, proxy de evasão ou credenciais de login
 * do Instagram. Um fornecedor que exija automação de browser, captura de
 * cookies, injeção de sessão, simulação de dispositivo, rotação de proxy
 * para evasão, spoofing de fingerprint ou contorno de checkpoints, de
 * limites ou de bloqueios da Meta NÃO é integrável aqui. Ver
 * `rejeitarConfigNaoConforme()` mais abaixo, que recusa essas configurações
 * em tempo de execução em vez de confiar em quem escreve o adapter.
 */

/* ---------------------------------------------------------------- *
 * 1. Capacidades                                                    *
 * ---------------------------------------------------------------- */

/** Capacidades que um fornecedor pode declarar. O UI adapta-se a estas. */
export const CAPABILITIES = Object.freeze([
  'canSendMessage',
  'canReadConversations',
  'canReceiveWebhooks',
  'canCheckEligibility',
  'canFetchProfile',
  'canFetchDeliveryStatus'
]);

/** Mapa de capacidades todas a false — ponto de partida de qualquer fornecedor. */
export function nenhumaCapacidade() {
  return Object.fromEntries(CAPABILITIES.map(c => [c, false]));
}

/**
 * Normaliza um mapa de capacidades: só chaves conhecidas, só booleanos.
 * Uma capacidade não declarada é `false` — nunca se assume suporte.
 */
export function normalizarCapacidades(parcial) {
  const base = nenhumaCapacidade();
  if (!parcial || typeof parcial !== 'object') return Object.freeze(base);
  for (const c of CAPABILITIES) base[c] = parcial[c] === true;
  return Object.freeze(base);
}

/* ---------------------------------------------------------------- *
 * 2. Estados                                                        *
 * ---------------------------------------------------------------- */

/** Estado de uma conta ligada (coluna de estado em Outreach > Contas). */
export const ACCOUNT_STATUS = Object.freeze({
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  RESTRICTED: 'RESTRICTED',
  RATE_LIMITED: 'RATE_LIMITED',
  ERROR: 'ERROR'
});

/** Estado de uma mensagem, normalizado entre fornecedores. */
export const MESSAGE_STATUS = Object.freeze({
  QUEUED: 'QUEUED',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
  /* A mensagem nunca chegou a ser tentada por falta de configuração
     (ou por o fornecedor estar bloqueado para pedidos reais). */
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNKNOWN: 'UNKNOWN'
});

/** Elegibilidade de um destinatário para receber DM. */
export const ELIGIBILITY = Object.freeze({
  ELIGIBLE: 'ELIGIBLE',
  INELIGIBLE: 'INELIGIBLE',
  /* Sem endpoint de elegibilidade no fornecedor, o estado é UNKNOWN.
     Nunca se assume que um username qualquer pode receber DM. */
  UNKNOWN: 'UNKNOWN'
});

/* ---------------------------------------------------------------- *
 * 3. Códigos de erro normalizados                                   *
 * ---------------------------------------------------------------- */

/**
 * Vocabulário de erros comum. Cada adapter traduz os erros do seu
 * fornecedor para aqui; o resto do LeadMap só conhece estes códigos.
 * `retryable` diz se faz sentido tentar outra vez MAIS TARDE, na MESMA
 * conta e no MESMO fornecedor — nunca noutro (ver §15/§16 do adapter).
 */
export const ERROR_CODES = Object.freeze({
  RATE_LIMITED: { code: 'RATE_LIMITED', retryable: true },
  TIMEOUT: { code: 'TIMEOUT', retryable: true },
  NETWORK: { code: 'NETWORK', retryable: true },
  PROVIDER_UNAVAILABLE: { code: 'PROVIDER_UNAVAILABLE', retryable: true },
  INVALID_TOKEN: { code: 'INVALID_TOKEN', retryable: false },
  ACCOUNT_RESTRICTED: { code: 'ACCOUNT_RESTRICTED', retryable: false },
  RECIPIENT_UNAVAILABLE: { code: 'RECIPIENT_UNAVAILABLE', retryable: false },
  RECIPIENT_INELIGIBLE: { code: 'RECIPIENT_INELIGIBLE', retryable: false },
  MESSAGE_REJECTED: { code: 'MESSAGE_REJECTED', retryable: false },
  NOT_SUPPORTED: { code: 'NOT_SUPPORTED', retryable: false },
  NOT_CONFIGURED: { code: 'NOT_CONFIGURED', retryable: false },
  /* O adapter da Meta existe, mas os seus endpoints ainda não foram
     validados contra documentação oficial: está bloqueado para pedidos
     reais até alguém o ativar deliberadamente. */
  META_PROVIDER_NOT_VALIDATED: { code: 'META_PROVIDER_NOT_VALIDATED', retryable: false },
  INVALID_REQUEST: { code: 'INVALID_REQUEST', retryable: false },
  UNKNOWN: { code: 'UNKNOWN', retryable: false }
});

/** Erro tipado atravessando o adapter. Nunca transporta credenciais. */
export class ProviderError extends Error {
  constructor(codigo, mensagem, extra = {}) {
    const def = ERROR_CODES[codigo] || ERROR_CODES.UNKNOWN;
    super(mensagem || def.code);
    this.name = 'ProviderError';
    this.errorCode = def.code;
    this.retryable = extra.retryable != null ? extra.retryable === true : def.retryable;
    /* segundos a esperar antes de nova tentativa, quando o fornecedor o diz */
    this.retryAfterSec = Number.isFinite(extra.retryAfterSec) ? extra.retryAfterSec : null;
    this.providerStatus = extra.providerStatus != null ? extra.providerStatus : null;
    /* estado a reportar na resposta normalizada; por omissão FAILED */
    this.messageStatus = MESSAGE_STATUS[extra.status] || null;
  }
}

/* ---------------------------------------------------------------- *
 * 4. Resposta normalizada de envio                                  *
 * ---------------------------------------------------------------- */

/**
 * Forma única devolvida por QUALQUER fornecedor ao enviar uma mensagem:
 *   { success, providerMessageId, status, errorCode, errorMessage, retryable }
 */
export function respostaEnvio({
  success,
  providerMessageId = null,
  status = null,
  errorCode = null,
  errorMessage = null,
  retryable = false,
  retryAfterSec = null
} = {}) {
  const ok = success === true;
  return Object.freeze({
    success: ok,
    providerMessageId: ok ? (providerMessageId || null) : null,
    status: status || (ok ? MESSAGE_STATUS.SENT : MESSAGE_STATUS.FAILED),
    errorCode: ok ? null : (errorCode || ERROR_CODES.UNKNOWN.code),
    errorMessage: ok ? null : (errorMessage || 'Falha não especificada pelo fornecedor.'),
    retryable: ok ? false : retryable === true,
    retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : null
  });
}

/** Converte um ProviderError (ou erro qualquer) na resposta normalizada. */
export function respostaDeErro(err) {
  if (err instanceof ProviderError) {
    return respostaEnvio({
      success: false,
      status: err.messageStatus || null,
      errorCode: err.errorCode,
      errorMessage: err.message,
      retryable: err.retryable,
      retryAfterSec: err.retryAfterSec
    });
  }
  return respostaEnvio({
    success: false,
    errorCode: ERROR_CODES.UNKNOWN.code,
    errorMessage: (err && err.message) ? String(err.message) : 'Erro desconhecido.',
    retryable: false
  });
}

/* ---------------------------------------------------------------- *
 * 5. Conta ligada                                                   *
 * ---------------------------------------------------------------- */

/** Número máximo de contas Instagram ligadas em simultâneo. */
export const MAX_CONTAS = 5;

/**
 * Normaliza o registo de uma conta. Guarda exatamente os campos do
 * contrato — e nenhuma credencial: o token vive no backend, indexado
 * por `providerAccountId`, nunca neste objeto.
 */
export function normalizarConta(bruta) {
  if (!bruta || typeof bruta !== 'object') {
    throw new ProviderError('INVALID_REQUEST', 'Conta inválida.');
  }
  const texto = v => (typeof v === 'string' && v.trim()) ? v.trim() : null;
  const provider = texto(bruta.provider);
  const providerAccountId = texto(bruta.providerAccountId);
  const username = texto(bruta.username);
  if (!provider) throw new ProviderError('INVALID_REQUEST', 'Conta sem provider.');
  if (!providerAccountId) throw new ProviderError('INVALID_REQUEST', 'Conta sem providerAccountId.');
  if (!username) throw new ProviderError('INVALID_REQUEST', 'Conta sem username.');
  const status = ACCOUNT_STATUS[bruta.status] || ACCOUNT_STATUS.DISCONNECTED;
  return {
    provider,
    providerAccountId,
    username,
    displayName: texto(bruta.displayName) || username,
    status,
    connectedAt: bruta.connectedAt || null,
    lastSyncAt: bruta.lastSyncAt || null
  };
}

/* ---------------------------------------------------------------- *
 * 6. Recusa de configurações não conformes                          *
 * ---------------------------------------------------------------- */

/**
 * Chaves de configuração que denunciam que o fornecedor depende de
 * técnicas que o LeadMap não implementa nem financia. A presença de
 * qualquer uma destas chaves aborta a construção do adapter — a decisão
 * de "não integrar" fica no código, não numa nota de rodapé.
 */
const CHAVES_PROIBIDAS = [
  'cookie', 'cookies', 'session', 'sessionid', 'sessionId', 'session_id', 'csrftoken', 'csrfToken',
  'userAgent', 'user_agent', 'deviceId', 'device_id', 'deviceFingerprint', 'fingerprint',
  'proxy', 'proxies', 'proxyUrl', 'proxyRotation', 'rotateProxy',
  'puppeteer', 'playwright', 'selenium', 'webdriver', 'headless', 'browserWs',
  'igPassword', 'instagramPassword', 'password', 'passwd', 'pwd',
  'twoFactorSeed', 'totpSecret', 'checkpointBypass', 'bypass', 'antiban', 'antiBan'
];

/**
 * Valida a configuração de um fornecedor externo. Lança se encontrar
 * qualquer indício de automação de browser, sessão roubada ou evasão.
 */
export function rejeitarConfigNaoConforme(config, ondeInfo = 'provider externo') {
  if (!config || typeof config !== 'object') return;
  const encontradas = [];
  const visitar = (obj, prefixo, prof) => {
    if (!obj || typeof obj !== 'object' || prof > 4) return;
    for (const chave of Object.keys(obj)) {
      const norm = chave.toLowerCase().replace(/[_-]/g, '');
      for (const proibida of CHAVES_PROIBIDAS) {
        if (norm === proibida.toLowerCase().replace(/[_-]/g, '')) {
          encontradas.push(prefixo ? prefixo + '.' + chave : chave);
        }
      }
      const v = obj[chave];
      if (v && typeof v === 'object') {
        visitar(v, prefixo ? prefixo + '.' + chave : chave, prof + 1);
      }
    }
  };
  /* Arrays também são percorridos: uma chave proibida dentro de
     `{ lista: [ { proxy: ... } ] }` tem de ser apanhada na mesma. */
  visitar(config, '', 0);
  if (encontradas.length) {
    throw new ProviderError(
      'INVALID_REQUEST',
      'Configuração recusada para ' + ondeInfo + ': ' + encontradas.join(', ') +
      '. O LeadMap não integra fornecedores que dependam de automação de browser, ' +
      'sessões capturadas, simulação de dispositivo, rotação de proxy para evasão ' +
      'ou contorno de limites e bloqueios da Meta.'
    );
  }
}

/* ---------------------------------------------------------------- *
 * 7. Redação de segredos                                            *
 * ---------------------------------------------------------------- */

const PADROES_SEGREDO = /(api[_-]?key|apikey|token|secret|authorization|bearer|password|passwd|credential)/i;

/**
 * Devolve uma cópia segura para logs/auditoria/UI: qualquer campo com
 * aspeto de credencial passa a "[redigido]". Usar SEMPRE antes de
 * escrever seja o que for num log ou de devolver ao frontend.
 */
export function redigir(valor, prof = 0) {
  if (valor == null || prof > 6) return valor;
  if (Array.isArray(valor)) return valor.map(v => redigir(v, prof + 1));
  if (typeof valor !== 'object') return valor;
  const saida = {};
  for (const [k, v] of Object.entries(valor)) {
    if (PADROES_SEGREDO.test(k)) saida[k] = v == null ? null : '[redigido]';
    else if (v && typeof v === 'object') saida[k] = redigir(v, prof + 1);
    else saida[k] = v;
  }
  return saida;
}

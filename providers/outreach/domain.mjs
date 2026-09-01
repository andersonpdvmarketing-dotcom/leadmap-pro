/**
 * LeadMap Pro — domínio de produção do Outreach (Fase C)
 * ======================================================
 * Regras puras, sem base de dados, sem DOM e sem rede. É aqui que vive
 * a decisão sobre chaves de idempotência, backoff, transições de estado
 * e elegibilidade — de modo a que o mesmo comportamento possa ser
 * testado em memória e executado contra PostgreSQL sem divergir.
 *
 * Nada neste ficheiro envia mensagens.
 */

/* ---------------------------------------------------------------- *
 * Estados                                                           *
 * ---------------------------------------------------------------- */

export const CAMPAIGN_STATUS = Object.freeze({
  DRAFT: 'DRAFT', READY: 'READY', RUNNING: 'RUNNING', PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED', FAILED: 'FAILED'
});

export const QUEUE_STATUS = Object.freeze({
  PENDING: 'PENDING', PROCESSING: 'PROCESSING', SENT: 'SENT',
  FAILED: 'FAILED', SKIPPED: 'SKIPPED', PAUSED: 'PAUSED', CANCELLED: 'CANCELLED'
});

/** Estados terminais: nunca voltam a ser processados (§60). */
export const QUEUE_TERMINAL = Object.freeze([
  QUEUE_STATUS.SENT, QUEUE_STATUS.CANCELLED, QUEUE_STATUS.SKIPPED, QUEUE_STATUS.FAILED
]);

export const MESSAGE_STATUS = Object.freeze({
  QUEUED: 'QUEUED', SENDING: 'SENDING', SENT: 'SENT', DELIVERED: 'DELIVERED',
  READ: 'READ', REPLIED: 'REPLIED', FAILED: 'FAILED', SKIPPED: 'SKIPPED'
});

export const CONTACT_STATUS = Object.freeze({
  UNKNOWN: 'UNKNOWN', ELIGIBLE: 'ELIGIBLE', NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  OPTED_OUT: 'OPTED_OUT', SENT: 'SENT', REPLIED: 'REPLIED'
});

export const SKIP_REASON = Object.freeze({
  NO_INSTAGRAM: 'NO_INSTAGRAM',
  OPTED_OUT: 'OPTED_OUT',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  CAMPAIGN_CANCELLED: 'CAMPAIGN_CANCELLED'
});

export const AUDIT_ACTION = Object.freeze({
  ACCOUNT_CREATED: 'ACCOUNT_CREATED',
  CONTACT_CREATED: 'CONTACT_CREATED',
  CONTACT_UPDATED: 'CONTACT_UPDATED',
  CONTACT_OPTED_OUT: 'CONTACT_OPTED_OUT',
  CAMPAIGN_CREATED: 'CAMPAIGN_CREATED',
  CAMPAIGN_STARTED: 'CAMPAIGN_STARTED',
  CAMPAIGN_PAUSED: 'CAMPAIGN_PAUSED',
  CAMPAIGN_RESUMED: 'CAMPAIGN_RESUMED',
  CAMPAIGN_CANCELLED: 'CAMPAIGN_CANCELLED',
  QUEUE_ITEM_CREATED: 'QUEUE_ITEM_CREATED',
  QUEUE_ITEM_CLAIMED: 'QUEUE_ITEM_CLAIMED',
  MESSAGE_ATTEMPTED: 'MESSAGE_ATTEMPTED',
  MESSAGE_SENT: 'MESSAGE_SENT',
  MESSAGE_FAILED: 'MESSAGE_FAILED',
  RETRY_SCHEDULED: 'RETRY_SCHEDULED',
  WEBHOOK_RECEIVED: 'WEBHOOK_RECEIVED',
  WEBHOOK_IGNORED: 'WEBHOOK_IGNORED'
});

/** Máximo de contas ligadas — aplicado no frontend, no backend E no banco. */
export const MAX_ACCOUNTS = 5;

/* ---------------------------------------------------------------- *
 * Idempotência                                                      *
 * ---------------------------------------------------------------- */

/**
 * Chave de idempotência de uma mensagem: determinística e única.
 * Nunca usa aleatoriedade — o mesmo par (campanha, contacto, conta,
 * versão da mensagem) produz sempre a mesma chave, para que dois
 * pedidos concorrentes de "start" colidam na constraint UNIQUE em vez
 * de criarem dois envios.
 */
export function idempotencyKey({ campaignId, contactId, accountId, messageVersion = 1 }) {
  if (!campaignId || !contactId || !accountId) {
    throw new Error('idempotencyKey exige campaignId, contactId e accountId.');
  }
  return [campaignId, contactId, accountId, 'v' + messageVersion].join(':');
}

/** Hash estável (FNV-1a) — usado onde é preciso um id curto e reproduzível. */
export function hashEstavel(s) {
  let h = 2166136261;
  const t = String(s);
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/* ---------------------------------------------------------------- *
 * Retry e backoff                                                   *
 * ---------------------------------------------------------------- */

/**
 * Backoff determinístico, documentado (§24):
 *   1.ª repetição →  30 s
 *   2.ª           →   2 min
 *   3.ª           →  10 min
 *   seguintes     →  30 min (teto)
 * Não há retry infinito: `maxAttempts` fecha o assunto.
 */
export const BACKOFF_SEGUNDOS = Object.freeze([30, 120, 600, 1800]);
export const MAX_ATTEMPTS_PADRAO = 3;
/** Teto de segurança para o `retryAfter` que um fornecedor peça. */
export const RETRY_AFTER_MAX_SEG = 6 * 3600;

export function backoffSegundos(attemptCount) {
  const i = Math.max(1, Number(attemptCount) || 1) - 1;
  return BACKOFF_SEGUNDOS[Math.min(i, BACKOFF_SEGUNDOS.length - 1)];
}

/**
 * Decide o que fazer com uma tentativa falhada.
 * Respeita o `retryAfterSec` do fornecedor quando existe (§26), limitado
 * a um teto — respeitar não é obedecer cegamente a um valor absurdo.
 */
export function planoDeRetry({ resposta, attemptCount, maxAttempts = MAX_ATTEMPTS_PADRAO, agora = Date.now() }) {
  if (resposta && resposta.success) return { acao: 'SENT' };
  const retryable = Boolean(resposta && resposta.retryable);
  if (!retryable || attemptCount >= maxAttempts) {
    return { acao: 'FAILED', motivo: !retryable ? 'NAO_RECUPERAVEL' : 'MAX_ATTEMPTS' };
  }
  const pedido = Number(resposta && resposta.retryAfterSec);
  const segundos = Number.isFinite(pedido) && pedido > 0
    ? Math.min(pedido, RETRY_AFTER_MAX_SEG)
    : backoffSegundos(attemptCount);
  return { acao: 'RETRY', segundos, availableAt: new Date(agora + segundos * 1000).toISOString() };
}

/* ---------------------------------------------------------------- *
 * Locks                                                             *
 * ---------------------------------------------------------------- */

/** Um item PROCESSING cujo lock expirou pode ser reclamado (§22). */
export const LOCK_TIMEOUT_SEG = 300;

export function lockExpirado(item, { agora = Date.now(), timeoutSeg = LOCK_TIMEOUT_SEG } = {}) {
  if (!item || item.status !== QUEUE_STATUS.PROCESSING || !item.lockedAt) return false;
  return (agora - Date.parse(item.lockedAt)) > timeoutSeg * 1000;
}

/* ---------------------------------------------------------------- *
 * Elegibilidade                                                     *
 * ---------------------------------------------------------------- */

/**
 * Um contacto pode entrar/prosseguir numa campanha? Validado no backend,
 * nunca só na UI (§30). É reavaliado imediatamente antes do envio, porque
 * o opt-out pode acontecer depois de o item entrar na fila.
 */
export function motivoDeExclusao(contacto) {
  if (!contacto) return SKIP_REASON.NOT_ELIGIBLE;
  if (!contacto.normalizedInstagram) return SKIP_REASON.NO_INSTAGRAM;
  if (contacto.status === CONTACT_STATUS.OPTED_OUT || contacto.optedOutAt) return SKIP_REASON.OPTED_OUT;
  if (contacto.status === CONTACT_STATUS.NOT_ELIGIBLE) return SKIP_REASON.NOT_ELIGIBLE;
  return null;
}

export function separarElegiveis(contactos) {
  const incluidos = [], excluidos = [];
  for (const c of (contactos || [])) {
    const motivo = motivoDeExclusao(c);
    if (motivo) excluidos.push({ contacto: c, motivo });
    else incluidos.push(c);
  }
  return { incluidos, excluidos };
}

/* ---------------------------------------------------------------- *
 * Transições de campanha                                            *
 * ---------------------------------------------------------------- */

const TRANSICOES = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['RUNNING', 'PAUSED', 'CANCELLED'],
  RUNNING: ['PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED'],
  PAUSED: ['RUNNING', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: ['CANCELLED']
};

export function transicaoValida(de, para) {
  return Boolean(TRANSICOES[de] && TRANSICOES[de].includes(para));
}

export function exigirTransicao(de, para) {
  if (!transicaoValida(de, para)) {
    const e = new Error('Transição inválida: ' + de + ' → ' + para + '.');
    e.errorCode = 'INVALID_TRANSITION';
    throw e;
  }
}

/* ---------------------------------------------------------------- *
 * Resolução de template                                             *
 * ---------------------------------------------------------------- */

export const VARIAVEIS = Object.freeze(['nome', 'empresa', 'cidade', 'atividade']);

/**
 * Resolve o corpo de uma mensagem. Nunca inventa valores: uma variável
 * sem dado fica assinalada. O resultado é TEXTO — não há HTML aqui, e o
 * caller não deve injetá-lo como markup (§31/§66).
 */
export function resolverTemplate(corpo, contacto) {
  const faltam = [], desconhecidas = [];
  const mapa = {
    nome: contacto && (contacto.name || contacto.nome),
    empresa: contacto && (contacto.company || contacto.empresa),
    cidade: contacto && (contacto.city || contacto.cidade),
    atividade: contacto && (contacto.activity || contacto.atividade)
  };
  const texto = String(corpo || '').replace(/\{\{\s*([a-z]+)\s*\}\}/gi, (todo, bruta) => {
    const v = bruta.toLowerCase();
    if (!VARIAVEIS.includes(v)) { if (!desconhecidas.includes(v)) desconhecidas.push(v); return todo; }
    const valor = mapa[v];
    if (valor == null || String(valor).trim() === '' || String(valor) === 'N/D') {
      if (!faltam.includes(v)) faltam.push(v);
      return todo;
    }
    return String(valor);
  });
  return { texto, faltam, desconhecidas, completo: !faltam.length && !desconhecidas.length };
}

/* ---------------------------------------------------------------- *
 * Redação de segredos                                               *
 * ---------------------------------------------------------------- */

const PADRAO_SEGREDO = /(pass(word|wd)?|token|secret|api[_-]?key|apikey|authorization|bearer|cookie|session|credential|service[_-]?role|database[_-]?url|dsn|connection[_-]?string)/i;

/**
 * Cópia segura para auditoria, logs e respostas de API. Percorre objetos
 * E arrays; um segredo escondido dentro de uma lista é apanhado na mesma.
 */
export function redigir(valor, prof = 0) {
  if (valor == null || prof > 8) return valor;
  if (Array.isArray(valor)) return valor.map(v => redigir(v, prof + 1));
  if (typeof valor !== 'object') return valor;
  const saida = {};
  for (const [k, v] of Object.entries(valor)) {
    if (PADRAO_SEGREDO.test(k)) saida[k] = v == null ? null : '[redigido]';
    else if (v && typeof v === 'object') saida[k] = redigir(v, prof + 1);
    else saida[k] = v;
  }
  return saida;
}

export function contemSegredos(valor, prefixo = '', prof = 0, achados = []) {
  if (valor == null || typeof valor !== 'object' || prof > 8) return achados;
  if (Array.isArray(valor)) {
    valor.forEach((v, i) => contemSegredos(v, prefixo + '[' + i + ']', prof + 1, achados));
    return achados;
  }
  for (const [k, v] of Object.entries(valor)) {
    const caminho = prefixo ? prefixo + '.' + k : k;
    if (PADRAO_SEGREDO.test(k) && v !== '[redigido]' && v != null) achados.push(caminho);
    else if (v && typeof v === 'object') contemSegredos(v, caminho, prof + 1, achados);
  }
  return achados;
}

/* ---------------------------------------------------------------- *
 * Validação de entrada (§68/§69)                                    *
 * ---------------------------------------------------------------- */

export const LIMITE_PAGINA_PADRAO = 50;
export const LIMITE_PAGINA_MAX = 200;
export const MAX_TEMPLATE_BODY = 2000;
export const MAX_NOME = 120;

export class ValidationError extends Error {
  constructor(mensagem, campo) {
    super(mensagem);
    this.name = 'ValidationError';
    this.errorCode = 'INVALID_REQUEST';
    this.campo = campo || null;
  }
}

/**
 * Só os campos declarados atravessam — o corpo do pedido nunca é
 * inserido tal e qual (§68). Campos desconhecidos são descartados.
 */
export function extrair(corpo, esquema) {
  const saida = {};
  const dados = (corpo && typeof corpo === 'object' && !Array.isArray(corpo)) ? corpo : {};
  for (const [campo, regra] of Object.entries(esquema)) {
    const bruto = dados[campo];
    if (bruto === undefined || bruto === null || bruto === '') {
      if (regra.obrigatorio) throw new ValidationError('Campo obrigatório: ' + campo + '.', campo);
      if ('omissao' in regra) saida[campo] = regra.omissao;
      continue;
    }
    saida[campo] = validarCampo(campo, bruto, regra);
  }
  return saida;
}

function validarCampo(campo, bruto, regra) {
  switch (regra.tipo) {
    case 'texto': {
      const s = String(bruto).trim();
      if (regra.min && s.length < regra.min) throw new ValidationError(campo + ': mínimo ' + regra.min + ' caracteres.', campo);
      if (s.length > (regra.max || MAX_NOME)) throw new ValidationError(campo + ': máximo ' + (regra.max || MAX_NOME) + ' caracteres.', campo);
      if (regra.padrao && !regra.padrao.test(s)) throw new ValidationError(campo + ': formato inválido.', campo);
      return s;
    }
    case 'id': {
      const s = String(bruto).trim();
      if (!/^[A-Za-z0-9_:.-]{1,80}$/.test(s)) throw new ValidationError(campo + ': identificador inválido.', campo);
      return s;
    }
    case 'enum': {
      const s = String(bruto);
      if (!regra.valores.includes(s)) throw new ValidationError(campo + ': valor não permitido.', campo);
      return s;
    }
    case 'inteiro': {
      const n = Number(bruto);
      if (!Number.isInteger(n)) throw new ValidationError(campo + ': tem de ser inteiro.', campo);
      if (regra.min != null && n < regra.min) throw new ValidationError(campo + ': mínimo ' + regra.min + '.', campo);
      if (regra.max != null && n > regra.max) throw new ValidationError(campo + ': máximo ' + regra.max + '.', campo);
      return n;
    }
    case 'booleano': return bruto === true || bruto === 'true';
    case 'lista': {
      if (!Array.isArray(bruto)) throw new ValidationError(campo + ': tem de ser uma lista.', campo);
      if (bruto.length > (regra.max || 5000)) throw new ValidationError(campo + ': lista demasiado longa.', campo);
      return bruto.map(v => validarCampo(campo, v, regra.item));
    }
    default: throw new ValidationError(campo + ': tipo desconhecido.', campo);
  }
}

/** Paginação normalizada, sempre com teto (§70/§71). */
export function paginacao(query = {}) {
  const bruto = Number(query.limit);
  const limit = Number.isFinite(bruto) && bruto > 0 ? Math.min(Math.floor(bruto), LIMITE_PAGINA_MAX) : LIMITE_PAGINA_PADRAO;
  const off = Number(query.offset);
  const offset = Number.isFinite(off) && off > 0 ? Math.floor(off) : 0;
  return { limit, offset };
}

/* ---------------------------------------------------------------- *
 * Ambiente (§48)                                                    *
 * ---------------------------------------------------------------- */

export const AMBIENTES = Object.freeze(['development', 'test', 'production']);

export function ambienteDe(env = {}) {
  const bruto = String(env.OUTREACH_ENV || env.NODE_ENV || 'development').toLowerCase();
  if (bruto.startsWith('prod')) return 'production';
  if (bruto.startsWith('test')) return 'test';
  return 'development';
}

/**
 * O fornecedor de teste só é aceitável fora de produção. Em produção,
 * sem fornecedor real configurado, o sistema diz que não está pronto em
 * vez de simular envios em silêncio (§48).
 */
export function mockPermitido(env = {}) {
  return ambienteDe(env) !== 'production';
}

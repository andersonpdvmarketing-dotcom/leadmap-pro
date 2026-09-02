/**
 * LeadMap Pro — autenticação e autorização do Outreach (Fase C)
 * =============================================================
 * O LeadMap não tinha autenticação nenhuma. Esta camada é o mínimo
 * seguro para que a área de Outreach deixe de estar aberta: sessão
 * assinada, cookie HTTP-only, e verificação em TODAS as rotas — porque
 * esconder o botão no frontend não protege coisa nenhuma (§8).
 *
 * Decisões:
 *  · a sessão é um token assinado com HMAC-SHA256 usando
 *    OUTREACH_AUTH_SECRET, que vive só no backend;
 *  · viaja em cookie HttpOnly + Secure + SameSite=Strict, nunca em
 *    localStorage (§7);
 *  · a password do operador é guardada como hash scrypt em
 *    OUTREACH_OPERATOR_PASSWORD_HASH — nunca em claro, nunca no código;
 *  · sem segredo configurado, o backend responde NOT_CONFIGURED e recusa
 *    tudo. Nunca há modo "aberto por omissão".
 *
 * Não há password de Instagram em lado nenhum: isto autentica o
 * OPERADOR do LeadMap, não uma conta de rede social.
 */

import { createHmac, timingSafeEqual, scryptSync, randomBytes } from 'node:crypto';

export const COOKIE_SESSAO = 'leadmap_outreach_session';
export const DURACAO_SESSAO_SEG = 12 * 3600;

export class AuthError extends Error {
  constructor(status, errorCode, mensagem) {
    super(mensagem || errorCode);
    this.name = 'AuthError';
    this.status = status;
    this.errorCode = errorCode;
  }
}

/* ---------------------------------------------------------------- *
 * Configuração                                                      *
 * ---------------------------------------------------------------- */

export function lerConfigAuth(env = process.env) {
  return {
    secret: env.OUTREACH_AUTH_SECRET || null,
    operador: env.OUTREACH_OPERATOR_EMAIL || null,
    hash: env.OUTREACH_OPERATOR_PASSWORD_HASH || null,
    /* segredo separado, só para o endpoint do worker (§37) */
    workerSecret: env.OUTREACH_WORKER_SECRET || null
  };
}

export function authConfigurada(env = process.env) {
  const c = lerConfigAuth(env);
  return Boolean(c.secret && c.operador && c.hash);
}

/* ---------------------------------------------------------------- *
 * Password                                                          *
 * ---------------------------------------------------------------- */

/**
 * Formato do hash: scrypt$<salt-hex>$<derivado-hex>.
 * Gerar com `node scripts/hash-password.mjs` (não incluído no repo por
 * não ser necessário em runtime) ou com o utilitário abaixo.
 */
export function criarHashPassword(password, salt = randomBytes(16)) {
  const derivado = scryptSync(String(password), salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + derivado.toString('hex');
}

export function verificarPassword(password, hashGuardado) {
  if (!hashGuardado || typeof hashGuardado !== 'string') return false;
  const partes = hashGuardado.split('$');
  if (partes.length !== 3 || partes[0] !== 'scrypt') return false;
  let esperado, obtido;
  try {
    const salt = Buffer.from(partes[1], 'hex');
    esperado = Buffer.from(partes[2], 'hex');
    obtido = scryptSync(String(password), salt, esperado.length);
  } catch (e) { return false; }
  if (esperado.length !== obtido.length) return false;
  return timingSafeEqual(esperado, obtido);   /* comparação em tempo constante */
}

/* ---------------------------------------------------------------- *
 * Sessão assinada                                                   *
 * ---------------------------------------------------------------- */

const b64url = b => Buffer.from(b).toString('base64url');

function assinar(payloadB64, secret) {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export function criarSessao({ subject, roles = ['outreach:operator'] }, env = process.env, agora = Date.now()) {
  const { secret } = lerConfigAuth(env);
  if (!secret) throw new AuthError(503, 'NOT_CONFIGURED', 'OUTREACH_AUTH_SECRET não configurado.');
  const payload = { sub: subject, roles, iat: Math.floor(agora / 1000), exp: Math.floor(agora / 1000) + DURACAO_SESSAO_SEG };
  const corpo = b64url(JSON.stringify(payload));
  return corpo + '.' + assinar(corpo, secret);
}

export function verificarSessao(token, env = process.env, agora = Date.now()) {
  const { secret } = lerConfigAuth(env);
  if (!secret) throw new AuthError(503, 'NOT_CONFIGURED', 'Autenticação não configurada.');
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    throw new AuthError(401, 'UNAUTHENTICATED', 'Sessão em falta.');
  }
  const [corpo, assinatura] = token.split('.');
  const esperada = assinar(corpo, secret);
  const a = Buffer.from(assinatura || '', 'utf8');
  const b = Buffer.from(esperada, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError(401, 'UNAUTHENTICATED', 'Sessão inválida.');
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')); }
  catch (e) { throw new AuthError(401, 'UNAUTHENTICATED', 'Sessão ilegível.'); }
  if (!payload || !payload.exp || payload.exp * 1000 < agora) {
    throw new AuthError(401, 'UNAUTHENTICATED', 'Sessão expirada.');
  }
  return payload;
}

/* ---------------------------------------------------------------- *
 * Cookies                                                           *
 * ---------------------------------------------------------------- */

export function lerCookie(req, nome) {
  const bruto = (req && req.headers && (req.headers.cookie || req.headers.Cookie)) || '';
  for (const parte of String(bruto).split(';')) {
    const [k, ...resto] = parte.trim().split('=');
    if (k === nome) return decodeURIComponent(resto.join('='));
  }
  return null;
}

/** HttpOnly + Secure + SameSite=Strict: o browser não lê nem reenvia para fora. */
export function cookieDeSessao(token, { maxAge = DURACAO_SESSAO_SEG, seguro = true } = {}) {
  return [
    COOKIE_SESSAO + '=' + encodeURIComponent(token),
    'Path=/', 'HttpOnly', 'SameSite=Strict',
    seguro ? 'Secure' : null,
    'Max-Age=' + maxAge
  ].filter(Boolean).join('; ');
}

export function cookieDeLogout({ seguro = true } = {}) {
  return [COOKIE_SESSAO + '=', 'Path=/', 'HttpOnly', 'SameSite=Strict', seguro ? 'Secure' : null, 'Max-Age=0']
    .filter(Boolean).join('; ');
}

/* ---------------------------------------------------------------- *
 * Guardas                                                           *
 * ---------------------------------------------------------------- */

/** 401 se não autenticado. Devolve o payload da sessão. */
export function exigirSessao(req, env = process.env, agora = Date.now()) {
  return verificarSessao(lerCookie(req, COOKIE_SESSAO), env, agora);
}

/** 403 se autenticado mas sem o papel necessário (§8). */
export function exigirPapel(sessao, papel) {
  const papeis = (sessao && sessao.roles) || [];
  if (!papeis.includes(papel)) {
    throw new AuthError(403, 'FORBIDDEN', 'Sem permissão para esta operação.');
  }
  return true;
}

/**
 * O endpoint do worker não é para browsers (§37): exige um segredo
 * próprio, num cabeçalho, comparado em tempo constante.
 */
export function exigirSegredoDoWorker(req, env = process.env) {
  const { workerSecret } = lerConfigAuth(env);
  if (!workerSecret) throw new AuthError(503, 'NOT_CONFIGURED', 'OUTREACH_WORKER_SECRET não configurado.');
  const dado = (req && req.headers && (req.headers['x-outreach-worker-secret'] || req.headers['X-Outreach-Worker-Secret'])) || '';
  const a = Buffer.from(String(dado), 'utf8');
  const b = Buffer.from(workerSecret, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError(401, 'UNAUTHENTICATED', 'Segredo de worker inválido.');
  }
  return true;
}

/* ---------------------------------------------------------------- *
 * Origem (§50 CSRF)                                                 *
 * ---------------------------------------------------------------- */

const METODOS_MUTANTES = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Recusa mutações vindas de outra origem.
 *
 * `SameSite=Strict` já impede o browser de enviar o cookie a partir de
 * outro site, e é essa a defesa principal. Isto é a segunda camada, para
 * o caso de um cliente que não a respeite: um pedido que muda estado tem
 * de trazer `Origin` (ou `Referer`) do próprio site. Pedidos sem nenhum
 * dos dois — curl, um worker, um teste — passam, porque aí não há cookie
 * de browser a ser reutilizado à socapa.
 */
export function exigirMesmaOrigem(req) {
  if (!req || !METODOS_MUTANTES.includes(req.method)) return true;
  const h = req.headers || {};
  const origem = h.origin || h.Origin || null;
  const referer = h.referer || h.Referer || null;
  if (!origem && !referer) return true;            /* não é um browser */

  const host = h['x-forwarded-host'] || h.host || null;
  if (!host) return true;

  let vinda;
  try { vinda = new URL(origem || referer).host; } catch (e) { vinda = null; }
  if (!vinda || vinda !== String(host)) {
    throw new AuthError(403, 'FORBIDDEN', 'Origem do pedido não autorizada.');
  }
  return true;
}

/* ---------------------------------------------------------------- *
 * Limitação de tentativas de login (§49)                            *
 * ---------------------------------------------------------------- */

export const LOGIN_MAX_TENTATIVAS = 8;
export const LOGIN_JANELA_SEG = 300;

/**
 * Janela deslizante em memória.
 *
 * LIMITAÇÃO HONESTA: cada instância serverless tem a sua própria
 * memória, por isso isto atrasa um atacante, não o bloqueia em
 * definitivo. É o "limitador simples" pedido — não um serviço
 * distribuído. Não guarda password nem hash: só um contador por
 * identificador de origem.
 */
const tentativas = new Map();

/** Identificador da origem do pedido. Nunca uma credencial. */
export function origemDoPedido(req) {
  const h = (req && req.headers) || {};
  const xff = h['x-forwarded-for'] || h['X-Forwarded-For'] || '';
  const ip = String(xff).split(',')[0].trim()
    || h['x-real-ip'] || (req && req.socket && req.socket.remoteAddress) || 'desconhecida';
  return String(ip);
}

export function limparTentativas(chave = null) {
  if (chave === null) tentativas.clear(); else tentativas.delete(chave);
}

/** Lança 429 quando a janela já está cheia. */
export function exigirTentativaDisponivel(chave, agora = Date.now()) {
  const janela = agora - LOGIN_JANELA_SEG * 1000;
  const lista = (tentativas.get(chave) || []).filter(t => t > janela);
  if (lista.length >= LOGIN_MAX_TENTATIVAS) {
    const err = new AuthError(429, 'TOO_MANY_ATTEMPTS',
      'Demasiadas tentativas de entrada. Tente novamente dentro de alguns minutos.');
    err.retryAfterSeg = LOGIN_JANELA_SEG;
    throw err;
  }
  tentativas.set(chave, lista);
  return LOGIN_MAX_TENTATIVAS - lista.length;
}

/** Regista uma tentativa falhada. O sucesso limpa o contador. */
export function registarFalha(chave, agora = Date.now()) {
  const janela = agora - LOGIN_JANELA_SEG * 1000;
  const lista = (tentativas.get(chave) || []).filter(t => t > janela);
  lista.push(agora);
  tentativas.set(chave, lista);
  return lista.length;
}

/* ---------------------------------------------------------------- *
 * Login                                                             *
 * ---------------------------------------------------------------- */

export function autenticarOperador({ email, password }, env = process.env, agora = Date.now()) {
  const c = lerConfigAuth(env);
  if (!authConfigurada(env)) throw new AuthError(503, 'NOT_CONFIGURED', 'Autenticação do Outreach não configurada.');
  const emailOk = String(email || '').trim().toLowerCase() === String(c.operador).trim().toLowerCase();
  const passOk = verificarPassword(password, c.hash);
  /* as duas verificações correm sempre, para não revelar qual falhou */
  if (!emailOk || !passOk) throw new AuthError(401, 'UNAUTHENTICATED', 'Credenciais inválidas.');
  return criarSessao({ subject: c.operador, roles: ['outreach:operator', 'outreach:admin'] }, env, agora);
}

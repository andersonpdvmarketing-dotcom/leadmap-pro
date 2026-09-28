/**
 * LeadMap Pro — leitura HTTP para o Company Intelligence
 * ======================================================
 * Uma única porta de saída para a rede, com as mesmas guardas que
 * `api/enrich/email.mjs` já provou em produção. Existe para que nenhum
 * provider tenha de reimplementar SSRF, timeout ou teto de tamanho — e
 * para que apertá-las seja uma alteração num sítio só.
 *
 * O HTML QUE VOLTA É DADO, NUNCA CÓDIGO
 * -------------------------------------
 * Nada do que estas funções devolvem é executado, interpretado como
 * instrução ou seguido automaticamente. Um site pode escrever o que
 * quiser na sua página; aqui é texto a analisar com expressões regulares
 * e mais nada.
 */

const TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_URL_LEN = 2048;

/** Identifica-se, para quem opera a fonte poder reconhecer o tráfego. */
export const USER_AGENT =
  'LeadMapPro/1.0 (+https://leadmap-pro-nine.vercel.app; consulta pontual por NIPC)';

/** Tipos que vale a pena ler. Um PDF ou um ZIP não é analisado. */
const TIPOS_OK = /^(text\/html|text\/plain|application\/xhtml\+xml)/i;

/**
 * Recusa alvos internos. É a mesma lista de `api/enrich/*`, mantida aqui
 * porque um provider empresarial pode receber um domínio vindo de dados
 * de terceiros — e um pedido a 169.254.169.254 dentro de uma função
 * serverless é uma fuga de credenciais da plataforma.
 */
export function hostSeguro(host) {
  const h = String(host || '').toLowerCase();
  if (!h || !/^[a-z0-9.-]+$/.test(h)) return false;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return false;
  if (/^(10|127)\./.test(h)) return false;
  if (/^192\.168\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (/^169\.254\./.test(h)) return false;          /* metadados de nuvem */
  if (/^0\./.test(h) || h === '0.0.0.0') return false;
  if (h.startsWith('[') || h.includes(':')) return false;   /* IPv6 literal */
  return true;
}

/** Normaliza e valida um URL de entrada. Devolve null se não servir. */
export function urlSeguro(bruto, { permitirHttp = false } = {}) {
  if (typeof bruto !== 'string') return null;
  const s = bruto.trim();
  if (!s || s.length > MAX_URL_LEN || s === 'N/D') return null;
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s); }
  catch (e) { return null; }
  if (u.protocol !== 'https:' && !(permitirHttp && u.protocol === 'http:')) return null;
  if (!hostSeguro(u.hostname)) return null;
  if (!u.hostname.includes('.')) return null;
  return u;
}

/**
 * Lê uma página e devolve o texto, ou null.
 *
 * `permitirHttp` existe por uma razão concreta e indesejável: o SICAE
 * não serve HTTPS. O conteúdo viaja em claro e pode ser alterado em
 * trânsito, o que é a razão de essa evidência não poder valer o mesmo
 * que uma fonte com canal autenticado. Quem chama tem de o pedir
 * explicitamente.
 */
export async function lerPagina(alvo, { metodo = 'GET', corpo = null, cabecalhos = {}, permitirHttp = false, cookies = null } = {}) {
  const u = typeof alvo === 'string' ? urlSeguro(alvo, { permitirHttp }) : alvo;
  if (!u) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(u.toString(), {
      method: metodo,
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-PT,pt;q=0.9',
        ...(cookies ? { Cookie: cookies } : {}),
        ...cabecalhos
      },
      body: corpo
    });
    if (!resp.ok) return null;

    const tipo = resp.headers.get('content-type') || '';
    if (tipo && !TIPOS_OK.test(tipo)) return null;
    const tamanho = Number(resp.headers.get('content-length') || 0);
    if (tamanho && tamanho > MAX_BYTES) return null;

    const texto = await resp.text();
    if (texto.length > MAX_BYTES) return null;
    return { texto, url: resp.url || u.toString(), cookies: resp.headers.get('set-cookie') || null };
  } catch (e) {
    return null;                       /* timeout, DNS, TLS: nenhum é fatal */
  } finally {
    clearTimeout(timer);
  }
}

/** HTML → texto, preservando fronteiras entre elementos. */
export function texto(html) {
  if (typeof html !== 'string') return '';
  return html
    .slice(0, MAX_BYTES)
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&euro;/gi, '€')
    .replace(/\s+/g, ' ')
    .trim();
}

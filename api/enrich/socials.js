/**
 * LeadMap Pro — descoberta de presença nas redes sociais (V1)
 * ===========================================================
 * POST /api/enrich/socials
 *   body: { lead: { id, nome, website, morada, localidade } }
 *
 * Lê APENAS a página inicial do website do lead e extrai links explícitos
 * para Instagram, Facebook, TikTok, YouTube e LinkedIn.
 *
 * Regras: nunca inventa URLs; sem browser automation; sem JavaScript do
 * site externo; timeout de 5 s; resposta limitada em tamanho; nunca
 * devolve o HTML do website nem variáveis de ambiente.
 */

const TIMEOUT_MS = 5000;
const MAX_URL_LEN = 2048;
const MAX_HTML_BYTES = 4 * 1024 * 1024;  // teto de tamanho da página lida
const REDES = ['instagram', 'facebook', 'tiktok', 'youtube', 'linkedin'];

/* Resultado vazio (usado sempre que não há website ou a leitura falha) */
function vazio() {
  const out = {};
  for (const r of REDES) out[r] = { url: null, found: false, source: null };
  return out;
}

/* ---------- validação do URL de entrada ---------- */
function websiteSeguro(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > MAX_URL_LEN || s === 'N/D') return null;
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s); }
  catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return null;
  /* bloqueia alvos internos (SSRF): loopback, redes privadas, link-local, .local */
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^(10|127)\./.test(host)) return null;
  if (/^192\.168\./.test(host)) return null;
  if (/^169\.254\./.test(host)) return null;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
  if (host === '0.0.0.0' || host === '[::1]') return null;
  return u.href;
}

/* ---------- normalização ---------- */
const PARAMS_LIXO = /^(utm_|fbclid|gclid|igshid|igsh|mc_|ref|ref_src|ref_url|source|si|feature|__)/i;

function normalizarUrl(bruto) {
  let s = String(bruto || '').trim()
    .replace(/\\\//g, '/')                     // JSON escapado: \/ → /
    .replace(/&amp;/gi, '&')
    .replace(/[)"'<>\]]+$/, '');               // lixo colado no fim
  if (!s) return null;
  if (s.startsWith('//')) s = 'https:' + s;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^(www|m|mobile|[a-z]{2}-[a-z]{2})\./, '');
  u.hash = '';
  for (const k of Array.from(u.searchParams.keys())) {
    if (PARAMS_LIXO.test(k)) u.searchParams.delete(k);
  }
  u.pathname = u.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  return u;
}

/* ---------- validação por rede (só perfis reais) ---------- */
const IG_BLOQUEADOS = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'about', 'developer', 'legal', 'directory', 'tv', 'share', 'sharer', 'privacy', 'terms', 'emails']);
const FB_BLOQUEADOS = new Set(['sharer', 'sharer.php', 'share.php', 'share', 'dialog', 'plugins', 'tr', 'tr.php', 'login', 'login.php', 'signup', 'policies', 'policy.php', 'help', 'privacy', 'terms', 'events', 'watch', 'ads', 'business', 'groups']);
const YT_SECOES = new Set(['watch', 'results', 'embed', 'playlist', 'shorts', 'feed', 'account', 'signin', 'redirect']);
const LI_BLOQUEADOS = new Set(['shareArticle', 'sharing', 'share', 'login', 'signup', 'uas', 'pub', 'feed', 'jobs', 'learning']);

function validarRede(rede, u) {
  const host = u.hostname;
  const partes = u.pathname.split('/').filter(Boolean);
  const p0 = partes[0];

  if (rede === 'instagram') {
    if (host !== 'instagram.com' && !host.endsWith('.instagram.com')) return null;
    if (!p0 || IG_BLOQUEADOS.has(p0.toLowerCase())) return null;
    if (!/^[A-Za-z0-9._]{1,30}$/.test(p0)) return null;
    return 'https://instagram.com/' + p0;
  }
  if (rede === 'facebook') {
    if (host !== 'facebook.com' && !host.endsWith('.facebook.com') && host !== 'fb.com') return null;
    if (!p0 || FB_BLOQUEADOS.has(p0.toLowerCase())) return null;
    if (p0.toLowerCase() === 'profile.php') {
      const id = u.searchParams.get('id');
      return /^\d+$/.test(id || '') ? 'https://facebook.com/profile.php?id=' + id : null;
    }
    if (p0.toLowerCase() === 'pages' && partes.length >= 2) return 'https://facebook.com/' + partes.slice(0, 3).join('/');
    if (!/^[A-Za-z0-9.\-]{2,60}$/.test(p0)) return null;
    return 'https://facebook.com/' + p0;
  }
  if (rede === 'tiktok') {
    if (host !== 'tiktok.com' && !host.endsWith('.tiktok.com')) return null;
    if (!p0 || !p0.startsWith('@')) return null;                 // só perfis /@utilizador
    if (!/^@[A-Za-z0-9._]{1,30}$/.test(p0)) return null;
    return 'https://tiktok.com/' + p0;
  }
  if (rede === 'youtube') {
    if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return null;
    if (!p0 || YT_SECOES.has(p0.toLowerCase())) return null;
    if (p0.startsWith('@')) return /^@[A-Za-z0-9._-]{1,40}$/.test(p0) ? 'https://youtube.com/' + p0 : null;
    if (['channel', 'c', 'user'].includes(p0.toLowerCase()) && partes[1]) {
      if (!/^[A-Za-z0-9._-]{1,60}$/.test(partes[1])) return null;
      return 'https://youtube.com/' + p0.toLowerCase() + '/' + partes[1];
    }
    return null;
  }
  if (rede === 'linkedin') {
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
    if (!p0 || LI_BLOQUEADOS.has(p0)) return null;
    const tipo = p0.toLowerCase();
    if ((tipo === 'company' || tipo === 'in' || tipo === 'school') && partes[1]) {
      if (!/^[A-Za-z0-9._%-]{2,80}$/.test(partes[1])) return null;
      return 'https://linkedin.com/' + (tipo === 'school' ? 'company' : tipo) + '/' + partes[1];
    }
    return null;
  }
  return null;
}

/* ---------- extração a partir do HTML ---------- */
/* aceita https://…, o mesmo escapado em JSON (https:\/\/…) e protocol-relative (//…) */
const PADRAO = /(?:https?:\\?\/\\?\/|\/\/)[^\s"'<>()\\]{0,300}(?:instagram\.com|facebook\.com|fb\.com|tiktok\.com|youtube\.com|linkedin\.com)[^\s"'<>()]{0,300}/gi;

/* Varre um pedaço de HTML e preenche as redes ainda em falta.
   Devolve o número de redes já encontradas no acumulador. */
function extrairPara(html, socials) {
  const candidatos = html.match(PADRAO) || [];
  for (const bruto of candidatos) {
    const u = normalizarUrl(bruto);
    if (!u) continue;
    const host = u.hostname;
    let rede = null;
    if (host.includes('instagram.com')) rede = 'instagram';
    else if (host.includes('facebook.com') || host === 'fb.com') rede = 'facebook';
    else if (host.includes('tiktok.com')) rede = 'tiktok';
    else if (host.includes('youtube.com')) rede = 'youtube';
    else if (host.includes('linkedin.com')) rede = 'linkedin';
    if (!rede || socials[rede].found) continue;    // primeiro válido de cada rede
    const url = validarRede(rede, u);
    if (!url) continue;
    socials[rede] = { url, found: true, source: 'website' };
  }
  return REDES.filter(r => socials[r].found).length;
}

/* ---------- leitura da página inicial + extração ----------
   Devolve o objeto de redes, ou null se a página não pôde ser lida.
   Nota: a leitura manual de res.body não garante a descompressão de
   gzip/brotli (páginas em `content-encoding: br` chegam truncadas), por
   isso usa-se res.text(); o teto de tamanho e o timeout continuam ativos. */
async function lerEExtrair(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'LeadMapPro/1.0 (+descoberta de perfis públicos)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-PT,pt;q=0.9'
      }
    });
    if (!res.ok) return null;
    const tipo = res.headers.get('content-type') || '';
    if (tipo && !/text\/html|application\/xhtml|text\/plain/i.test(tipo)) return null;

    /* Recusa páginas absurdamente grandes antes de as ler */
    const tamanho = Number(res.headers.get('content-length') || 0);
    if (tamanho && tamanho > MAX_HTML_BYTES) return null;

    /* res.text() trata a descompressão (gzip/br) que a leitura manual do
       stream não garante; o AbortController mantém o teto de 5 s. */
    const html = await res.text();
    const socials = vazio();
    extrairPara(html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html, socials);
    return socials;
  } catch (e) {
    return null;   // timeout, DNS, TLS, rede — tratado como "não encontrado"
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== 'object' || !body.lead || typeof body.lead !== 'object') {
    return res.status(400).json({ success: false, error: 'Body inválido: esperado { lead: { … } }.' });
  }

  const lead = body.lead;
  const leadId = typeof lead.id === 'string' ? lead.id.slice(0, 200) : null;
  if (!leadId) {
    return res.status(400).json({ success: false, error: 'lead.id é obrigatório.' });
  }

  const website = websiteSeguro(lead.website);
  if (!website) {
    /* sem website utilizável — resposta válida e vazia, nunca um erro */
    return res.status(200).json({ success: true, leadId, socials: vazio() });
  }

  let socials = null;
  try { socials = await lerEExtrair(website); } catch (e) { socials = null; }
  return res.status(200).json({ success: true, leadId, socials: socials || vazio() });
}

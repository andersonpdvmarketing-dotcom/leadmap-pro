/**
 * LeadMap Pro — descoberta de emails públicos (V1)
 * ================================================
 * POST /api/enrich/email
 *   body: { lead: { id, website } }
 *
 * Mesma arquitetura de api/enrich/socials.js: um único pedido à página
 * inicial, timeout de 5 s, teto de tamanho, só HTML, mesmas proteções
 * SSRF. Nunca devolve o HTML bruto nem variáveis de ambiente, e nunca
 * inventa nem adivinha endereços — só devolve o que está publicado.
 */

const TIMEOUT_MS = 5000;
const MAX_URL_LEN = 2048;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_EMAILS = 5;

/* ---------- validação do URL de entrada (igual à V1 social) ---------- */
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

/* ---------- filtros de emails que não servem como contacto ---------- */
const DOMINIOS_FALSOS = new Set([
  'example.com', 'example.org', 'example.net', 'example.pt', 'exemplo.pt', 'exemplo.com',
  'test.com', 'teste.pt', 'domain.com', 'yourdomain.com', 'seudominio.pt', 'seudominio.com',
  'mysite.com', 'site.com', 'email.com', 'mail.com', 'company.com', 'empresa.com',
  'placeholder.com', 'dominio.pt', 'dominio.com',
  /* infraestrutura, tracking, CDN e plataformas — nunca são contactos do lead
     (a verificação abaixo cobre também subdomínios, ex.: o12345.ingest.sentry.io) */
  'sentry.io', 'wixpress.com', 'wix.com', 'godaddy.com', 'wordpress.com', 'wordpress.org',
  'cloudflare.com', 'cloudflareinsights.com', 'akamai.com', 'fastly.com',
  'google-analytics.com', 'googletagmanager.com', 'googleadservices.com', 'doubleclick.net',
  'googleapis.com', 'gstatic.com', 'facebook.net', 'hotjar.com', 'mixpanel.com',
  'segment.com', 'segment.io', 'matomo.org', 'clarity.ms', 'hubspot.com',
  'jsdelivr.net', 'unpkg.com', 'cdnjs.com', 'bootstrapcdn.com', 'fontawesome.com', 'jquery.com',
  'squarespace.com', 'weebly.com', 'elementor.com', 'wpengine.com', 'shopify.com',
  'w3.org', 'schema.org', 'purl.org', 'xmlns.com', 'adobe.com', 'sentry-cdn.com'
]);
const LOCAIS_FALSOS = new Set([
  'test', 'teste', 'example', 'exemplo', 'your', 'youremail', 'seuemail', 'seu-email',
  'email', 'e-mail', 'mail', 'nome', 'name', 'username', 'user', 'foo', 'bar',
  'placeholder', 'endereco', 'address', 'sentry', 'no-reply-test'
]);
/* extensões de ficheiro que aparecem em falsos positivos (logo@2x.png, etc.) */
const EXT_FICHEIRO = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|json|xml|pdf|zip|mp4|webm|woff2?|ttf|eot)$/i;

/* Prioridade pedida: comercial > vendas > contacto > contato > info > geral > administrativo > restante */
const PRIORIDADE = ['comercial', 'vendas', 'contacto', 'contato', 'info', 'geral', 'administrativo'];
/* endereços tecnicamente válidos mas inúteis para prospeção — ficam no fim */
const DESPRIORIZADOS = /^(no-?reply|nao-?responder|postmaster|abuse|webmaster|hostmaster|mailer-daemon|privacy|dpo|rgpd|noreply)/i;

function pontuar(email) {
  const local = email.split('@')[0].toLowerCase();
  if (DESPRIORIZADOS.test(local)) return 100;
  const i = PRIORIDADE.findIndex(p => local === p || local.startsWith(p + '.') || local.startsWith(p + '-'));
  return i === -1 ? 50 : i;
}

/* ---------- normalização e validação de um email ---------- */
function normalizarEmail(bruto) {
  if (!bruto) return null;
  let s = String(bruto).trim()
    .replace(/^mailto:/i, '')
    .split('?')[0]                      // remove ?subject=…&body=…
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, '')
    .replace(/[.,;:)"'<>\]]+$/, '');
  if (!s || s.length > 254) return null;
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}$/.test(s)) return null;
  s = s.toLowerCase();
  const [local, dominio] = s.split('@');
  if (!local || !dominio) return null;
  if (EXT_FICHEIRO.test(dominio)) return null;             // logo@2x.png e afins
  if (/^\d+x$/.test(local)) return null;                   // @2x, @3x
  /* domínio falso, incluindo subdomínios (ex.: sentry.wixpress.com) */
  if (DOMINIOS_FALSOS.has(dominio)) return null;
  for (const d of DOMINIOS_FALSOS) { if (dominio.endsWith('.' + d)) return null; }
  if (LOCAIS_FALSOS.has(local)) return null;
  /* chaves técnicas com forma de email (DSN do Sentry, tokens hexadecimais) */
  if (/^[0-9a-f]{16,}$/.test(local)) return null;
  if (local.length > 64) return null;
  if (local === 'test' || dominio.startsWith('test.')) return null;
  if (dominio.split('.').some(p => !p)) return null;
  return s;
}

/* ---------- extração ---------- */
/* mailto: (href, JSON-LD, meta) + emails em texto simples no HTML */
const PADRAO_MAILTO = /mailto:([^\s"'<>()]{3,320})/gi;
const PADRAO_TEXTO = /[A-Za-z0-9._%+-]+(?:@|&#64;|&#x40;)[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;

function extrairEmails(html) {
  const vistos = new Set();
  const ordenados = [];
  const juntar = bruto => {
    const e = normalizarEmail(String(bruto).replace(/&#64;|&#x40;/gi, '@'));
    if (!e || vistos.has(e)) return;      // duplicados eliminados
    vistos.add(e);
    ordenados.push(e);
  };
  let m;
  PADRAO_MAILTO.lastIndex = 0;
  while ((m = PADRAO_MAILTO.exec(html)) !== null) juntar(m[1]);   // mailto: primeiro
  const texto = html.match(PADRAO_TEXTO) || [];
  for (const t of texto) juntar(t);
  /* ordena por prioridade pedida, mantendo a ordem de descoberta como desempate */
  return ordenados
    .map((email, i) => ({ email, p: pontuar(email), i }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .slice(0, MAX_EMAILS)
    .map(x => ({ email: x.email, source: 'website' }));
}

/* ---------- leitura da página inicial ---------- */
async function lerPagina(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'LeadMapPro/1.0 (+descoberta de contactos públicos)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-PT,pt;q=0.9'
      }
    });
    if (!res.ok) return null;
    const tipo = res.headers.get('content-type') || '';
    if (tipo && !/text\/html|application\/xhtml|text\/plain/i.test(tipo)) return null;
    const tamanho = Number(res.headers.get('content-length') || 0);
    if (tamanho && tamanho > MAX_HTML_BYTES) return null;
    const html = await res.text();   // res.text() trata gzip/brotli
    return html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
  } catch (e) {
    return null;   // timeout, DNS, TLS, rede
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
    return res.status(200).json({ success: true, leadId, found: false, emails: [] });
  }

  const html = await lerPagina(website);
  if (!html) {
    return res.status(200).json({ success: true, leadId, found: false, emails: [] });
  }

  let emails = [];
  try { emails = extrairEmails(html); } catch (e) { emails = []; }
  return res.status(200).json({ success: true, leadId, found: emails.length > 0, emails });
}

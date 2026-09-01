/**
 * LeadMap Pro — identidade de uma lead
 * ====================================
 * Função central para decidir se duas leads são o MESMO negócio. Usada
 * pelo registo histórico de capturas; é o único sítio onde essa decisão
 * é tomada.
 *
 * DIFERENÇA IMPORTANTE face à deduplicação da pesquisa
 * ----------------------------------------------------
 * `DataCleaner.dedupe()` funde resultados DENTRO de uma execução e pode
 * usar semelhança de nomes (Levenshtein) porque tem a distância e o
 * código postal como contexto imediato.
 *
 * Aqui NÃO se usa semelhança nenhuma. Marcar uma lead como "já
 * capturada" por engano é pior do que deixar passar uma repetição: o
 * utilizador perde uma lead legítima. Por isso só contam identificadores
 * exatos, e o nome sozinho nunca chega — duas empresas com nomes
 * parecidos jamais são fundidas.
 *
 * Ordem de confiança das chaves:
 *   1. place:  ID da Google Places
 *   2. osm:    ID do elemento OpenStreetMap
 *   3. site:   domínio do website, normalizado
 *   4. tel:    telefone, só dígitos
 *   5. ig:     handle de Instagram, normalizado
 *   6. nomecp: nome exato + código postal exato   (só na falta das acima)
 */

const ND = 'N/D';

/* Domínios partilhados: o mesmo host não identifica o mesmo negócio. */
const HOSTS_PARTILHADOS = new Set([
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
  'youtube.com', 'wa.me', 'whatsapp.com', 'google.com', 'business.site',
  'wixsite.com', 'wordpress.com', 'blogspot.com', 'sites.google.com',
  'linktr.ee', 'bit.ly', 'pai.pt', 'paginasamarelas.pt', 'infoempresas.com.pt',
  'yelp.com', 'tripadvisor.com', 'booking.com', 'zomato.com', 'thefork.pt'
]);

function texto(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return (!s || s === ND) ? null : s;
}

export function normalizarTexto(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Domínio do website, sem www nem caminho. Devolve null se for partilhado. */
export function normalizarSite(bruto) {
  const s = texto(bruto);
  if (!s) return null;
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s); }
  catch (e) { return null; }
  let host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!host.includes('.')) return null;
  if (HOSTS_PARTILHADOS.has(host)) return null;
  /* subdomínio de plataforma partilhada continua a identificar o negócio */
  const raiz = host.split('.').slice(-2).join('.');
  if (HOSTS_PARTILHADOS.has(raiz) && host === raiz) return null;
  return host;
}

/** Telefone só com dígitos, com o indicativo de Portugal normalizado. */
export function normalizarTelefone(bruto) {
  const s = texto(bruto);
  if (!s) return null;
  let d = s.replace(/\D/g, '');
  if (d.startsWith('00351')) d = d.slice(5);
  else if (d.startsWith('351') && d.length > 9) d = d.slice(3);
  if (d.length < 9) return null;
  return d.slice(-9);
}

/** Handle de Instagram a partir de URL ou @nome. */
export function normalizarInstagram(bruto) {
  const s0 = texto(bruto);
  if (!s0) return null;
  let s = s0.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
    .replace(/^m?\.?instagram\.com\//i, '').split(/[?#]/)[0]
    .replace(/\/+$/, '').replace(/^@/, '');
  if (!s || s.includes('/')) return null;
  if (/^(p|reel|reels|stories|explore|accounts|direct|tv)$/i.test(s)) return null;
  if (!/^[a-z0-9._]{1,30}$/i.test(s)) return null;
  return s.toLowerCase();
}

function normalizarCP(bruto) {
  const s = texto(bruto);
  if (!s) return null;
  const m = s.match(/(\d{4})\s*-\s*(\d{3})/);
  return m ? m[1] + '-' + m[2] : null;
}

/**
 * Todas as chaves de identidade de uma lead, da mais forte para a mais
 * fraca. Uma lead sem nenhuma chave devolve lista vazia — e nesse caso
 * é sempre tratada como nova, porque não há como afirmar o contrário.
 */
export function chavesDeIdentidade(lead) {
  if (!lead || typeof lead !== 'object') return [];
  const chaves = [];

  const place = texto(lead.placeId) || texto(lead.place_id) ||
    (typeof lead.id === 'string' && /^ChIJ|^places\//.test(lead.id) ? lead.id : null);
  if (place) chaves.push('place:' + place.replace(/^places\//, ''));

  const osm = texto(lead.osmId) || texto(lead.osm_id) ||
    (typeof lead.id === 'string' && /^(node|way|relation)[\/:]\d+$/i.test(lead.id) ? lead.id : null);
  if (osm) chaves.push('osm:' + osm.toLowerCase().replace(':', '/'));

  const site = normalizarSite(lead.website);
  if (site) chaves.push('site:' + site);

  for (const t of [lead.telefone, lead.telemovel]) {
    const tel = normalizarTelefone(t);
    if (tel && !chaves.includes('tel:' + tel)) chaves.push('tel:' + tel);
  }

  const ig = normalizarInstagram(lead.instagram);
  if (ig) chaves.push('ig:' + ig);

  /* Última hipótese: nome EXATO + código postal EXATO. Nunca só o nome,
     e nunca por semelhança — duas empresas de nome parecido ficam
     separadas de propósito. */
  const nome = normalizarTexto(lead.nome);
  const cp = normalizarCP(lead.codigoPostal);
  if (nome && nome.length >= 3 && cp) chaves.push('nomecp:' + nome + '|' + cp);

  return chaves;
}

/** Chave preferencial (a mais forte) — útil para apresentação e depuração. */
export function chavePrincipal(lead) {
  const c = chavesDeIdentidade(lead);
  return c.length ? c[0] : null;
}

/** true se duas leads partilham pelo menos uma chave de identidade. */
export function mesmaLead(a, b) {
  const ca = new Set(chavesDeIdentidade(a));
  return chavesDeIdentidade(b).some(k => ca.has(k));
}

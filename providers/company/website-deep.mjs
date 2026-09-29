/**
 * LeadMap Pro — leitura do website oficial
 * ========================================
 * Lê um punhado de páginas do MESMO domínio onde as empresas declaram os
 * dados que a lei as obriga a publicar — capital social, NIPC, CAE — e
 * onde falam da sua própria dimensão.
 *
 * PORQUE É QUE ISTO DEIXOU DE ADIVINHAR ENDEREÇOS
 * ----------------------------------------------
 * A versão anterior tentava catorze caminhos fixos. Medido em trinta
 * empresas reais: **7,5 pedidos por empresa para ler 2,0 páginas** —
 * três em cada quatro pedidos eram 404. E o que existia ficava de fora,
 * porque uma página institucional em `/empresa.html` não está em lista
 * nenhuma que se consiga escrever à mão.
 *
 * Agora lê-se a homepage, tiram-se os links que lá estão mesmo, e
 * visitam-se os poucos que parecem institucionais. Não é um crawler a
 * mais: é o mesmo orçamento gasto em páginas que existem. Sem
 * profundidade — os links vêm só da homepage, não se segue o que se
 * encontra dentro deles. Sem sair do domínio. Sem fila.
 *
 * O QUE IMPEDE ISTO DE CRESCER
 * ----------------------------
 * Um teto duro de MAX_PAGINAS páginas úteis e MAX_TENTATIVAS pedidos por
 * empresa, contados juntos. Quando acaba, acaba — mesmo que falte um
 * campo. Um campo raro não justifica gastar a paciência de um servidor
 * alheio.
 */

import { lerPagina, texto, urlSeguro } from './http.mjs';
import { extrairTudo } from './extracao.mjs';
import { extrairNif } from './nif.mjs';

/**
 * Domínio comparável, sem `www.`.
 *
 * `www.exemplo.pt` e `exemplo.pt` são o mesmo negócio, e o
 * redirecionamento entre os dois é o mais banal da web. Uma comparação
 * literal de hostname descartava a página logo a seguir a lê-la —
 * custou-me todas as leituras do primeiro teste real.
 */
function dominioBase(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '');
}

/* ---------------------------------------------------------------- *
 * Orçamento                                                         *
 * ---------------------------------------------------------------- */

/** Páginas úteis por empresa: a homepage e mais três. */
export const MAX_PAGINAS = 4;

/** Páginas internas descobertas que se seguem, no máximo. */
export const MAX_INTERNOS = 3;

/**
 * Teto de PEDIDOS, que é o número que o servidor do outro lado sente.
 * Menor do que era (8): com links reais falha-se muito menos.
 */
export const MAX_TENTATIVAS = 6;

/**
 * Caminhos de recurso, para quando a homepage não dá links — sites de
 * uma página só, menus construídos por JavaScript, homepages que são um
 * ecrã de entrada. Cinco, escolhidos por rendimento, em vez dos catorze
 * às cegas de antes.
 */
export const CAMINHOS_FALLBACK = Object.freeze([
  '/sobre', '/sobre-nos', '/empresa', '/contactos', '/termos', '/termos-e-condicoes'
]);

/* Mantido com o nome antigo para quem já o importava. */
export const CAMINHOS = CAMINHOS_FALLBACK;

/* ---------------------------------------------------------------- *
 * Pontuação de links                                                *
 * ---------------------------------------------------------------- */

/**
 * O que costuma estar do outro lado de um link que interessa.
 *
 * Pesa-se pelo que a palavra promete: uma página "quem somos" fala da
 * empresa, uma página "termos" tem a identificação legal por obrigação.
 * "contactos" vale menos porque muitas vezes é só um formulário — mas
 * em Portugal é também onde aparece o NIPC.
 */
const RELEVANTES = Object.freeze([
  [/(^|[/_-])(sobre-?nos|quem-?somos|a-?empresa|institucional)([/_.-]|$)/i, 6],
  [/(^|[/_-])(empresa|corporativo|corporate|company|about-?us|about)([/_.-]|$)/i, 5],
  [/(^|[/_-])(historia|hist[oó]ria|grupo|group|sobre)([/_.-]|$)/i, 4],
  [/(^|[/_-])(termos|termos-?e-?condicoes|legal|ficha-?tecnica|privacidade|privacy|terms)([/_.-]|$)/i, 4],
  [/(^|[/_-])(relatorio|relat[oó]rio|contas|financeiro|financial|financials|investidores|investors|annual-?report|reports)([/_.-]|$)/i, 4],
  [/(^|[/_-])(equipa|equipe|team|pessoas|people|colaboradores)([/_.-]|$)/i, 3],
  [/(^|[/_-])(numeros|n[uú]meros|factos|facts|figures|dados|transparencia|transpar[eê]ncia|governance|sustentabilidade|sustainability)([/_.-]|$)/i, 3],
  [/(^|[/_-])(contactos?|contacts?|contact)([/_.-]|$)/i, 2]
]);

/**
 * O que não vale o orçamento. Um blog com trezentos artigos é o caminho
 * mais rápido para transformar isto num crawler sem ninguém decidir.
 */
const IRRELEVANTES = /(^|[/_-])(blog|noticias?|not[ií]cias?|news|artigos?|produtos?|produto|shop|loja|store|cart|carrinho|checkout|login|signin|sign-?in|signup|registar|conta|agenda|booking|marcacoes?|galeria|gallery|portfolio|portefolio|categoria|category|tag|author|autor|feed|rss|wp-admin|wp-login|wp-content|wp-json|search|pesquisa|carreiras|recrutamento|faq|ajuda|suporte)([/_.-]|$)/i;

/** Protocolos e âncoras que nem sequer são páginas. */
const NAO_E_PAGINA = /^(mailto:|tel:|javascript:|data:|file:|ftp:|sms:|whatsapp:|#)/i;

/** Extensões que não são HTML. O PDF fica de fora por decisão da Fase 4. */
const NAO_HTML = /\.(pdf|zip|rar|docx?|xlsx?|pptx?|jpe?g|png|gif|svg|webp|mp4|mp3|avi|csv|xml|json)($|\?)/i;

/**
 * Quanto vale este link.
 *
 * Olha para o caminho E para o texto da âncora, porque um site pode ter
 * `/pagina-2` com o texto "Quem Somos" — e ao contrário, `/empresa.html`
 * com um ícone sem texto. Zero ou menos quer dizer não visitar.
 */
export function pontuarLink(caminho, textoAncora = '') {
  const alvo = String(caminho || '').toLowerCase();
  const rot = String(textoAncora || '').toLowerCase().replace(/\s+/g, '-');
  if (IRRELEVANTES.test(alvo)) return -1;
  let pontos = 0;
  for (const [re, peso] of RELEVANTES) {
    if (re.test(alvo)) pontos += peso;
    else if (rot && re.test(rot)) pontos += Math.max(1, peso - 1);
  }
  /* uma página à raiz vale mais do que a mesma enterrada em três níveis */
  const profundidade = alvo.split('/').filter(Boolean).length;
  if (pontos > 0 && profundidade > 3) pontos -= 1;
  return pontos;
}

/**
 * Os links internos da página, já limpos, deduplicados e ordenados.
 *
 * Deduplicação por caminho e não por URL completo: `/sobre?utm=a` e
 * `/sobre?utm=b` são a mesma página, e gastar dois pedidos nelas seria
 * gastar metade do orçamento no mesmo texto.
 */
export function extrairLinks(html, urlBase) {
  let base;
  try { base = new URL(urlBase); } catch (e) { return []; }
  const dominio = dominioBase(base.hostname);
  const porCaminho = new Map();

  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,160}?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const bruto = m[1].trim();
    if (!bruto || NAO_E_PAGINA.test(bruto)) continue;
    let u;
    try { u = new URL(bruto, base); } catch (e) { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    /* §5: nunca sair do domínio */
    if (dominioBase(u.hostname) !== dominio) continue;
    if (NAO_HTML.test(u.pathname)) continue;
    u.hash = '';                                   /* o fragmento é a mesma página */
    if (u.pathname === base.pathname && !u.search) continue;   /* é a própria */

    const ancora = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const pontos = pontuarLink(u.pathname, ancora);
    if (pontos <= 0) continue;

    const chave = u.pathname.replace(/\/+$/, '') || '/';
    const anterior = porCaminho.get(chave);
    if (!anterior || anterior.pontos < pontos) {
      porCaminho.set(chave, { url: u.toString(), pontos, ancora: ancora.slice(0, 60) });
    }
  }
  return [...porCaminho.values()].sort((a, b) => b.pontos - a.pontos);
}

/* ---------------------------------------------------------------- *
 * Leitura                                                           *
 * ---------------------------------------------------------------- */

/** Máximo de texto acumulado. Chega para as páginas legais, que é onde a firma aparece. */
const MAX_CORPUS = 200 * 1024;

/** Janela curta em volta de um achado — para auditar, não para arquivar. */
export function trechoEmVolta(t, alvo, largura = 260) {
  const s = String(t || '');
  const i = s.indexOf(String(alvo));
  if (i < 0) return null;
  const de = Math.max(0, i - Math.floor(largura / 2));
  return (de > 0 ? '…' : '') + s.slice(de, de + largura).replace(/\s+/g, ' ').trim() + '…';
}

/**
 * Lê o website e devolve o que encontrou.
 *
 * @returns {{paginasLidas, tentativas, naoAbriram, achados, nif, urls, corpus, descobertos}}
 */
export async function investigarWebsite(website, {
  max = MAX_PAGINAS, maxTentativas = MAX_TENTATIVAS, maxInternos = MAX_INTERNOS,
  fetchPagina = lerPagina
} = {}) {
  /* HTTP é aceite para sites de empresas: é uma leitura de página
     pública, sem credenciais nem sessão. Muitas PME portuguesas ainda
     não têm TLS, e recusá-las apagaria metade da cobertura. As guardas
     de SSRF, timeout e tamanho aplicam-se na mesma. */
  const base = urlSeguro(website, { permitirHttp: true });
  const vazio = { paginasLidas: 0, tentativas: 0, naoAbriram: 0, achados: [],
                  nif: null, urls: [], corpus: '', descobertos: 0 };
  if (!base) return vazio;
  const dominio = dominioBase(base.hostname);

  const achados = [];
  const urls = [];
  const vistos = new Set();
  let nif = null;
  let lidas = 0;
  let tentativas = 0;
  let naoAbriram = 0;
  let corpus = '';

  const temTudo = () => Boolean(nif)
    && ['capitalSocial', 'funcionarios', 'faturacaoAnual'].every(c => achados.some(a => a.campo === c));
  const orcamento = () => lidas < max && tentativas < maxTentativas;

  /** Lê uma página e absorve o que lá estiver. Devolve o HTML, ou null. */
  async function visitar(alvo) {
    const chave = String(alvo).replace(/#.*$/, '').replace(/\/+$/, '');
    if (vistos.has(chave)) return null;
    vistos.add(chave);
    /* §15: uma URL vinda do HTML não é de confiança por ter vindo do HTML */
    const seguro = urlSeguro(alvo, { permitirHttp: true });
    if (!seguro) return null;
    if (dominioBase(seguro.hostname) !== dominio) return null;

    tentativas += 1;
    const r = await fetchPagina(seguro.toString(), { permitirHttp: true });
    if (!r) { naoAbriram += 1; return null; }
    /* um redirecionamento para fora do domínio descarta-se: o conteúdo
       deixou de ser declaração desta empresa. www conta como o mesmo. */
    try { if (dominioBase(new URL(r.url).hostname) !== dominio) return null; } catch (e) { return null; }

    lidas += 1;
    urls.push(r.url);
    const t = texto(r.texto);
    if (corpus.length < MAX_CORPUS) corpus += ' ' + t;

    if (!nif) {
      const n = extrairNif(r.texto);
      if (n.encontrado) {
        nif = {
          valor: n.nif, confianca: n.confianca, rotulo: n.rotulo, url: r.url,
          /* o que estava em volta do número, para se poder auditar de
             quem ele é sem voltar a ir buscar a página */
          trecho: trechoEmVolta(t, n.nif),
          candidatos: n.candidatos
        };
      } else if (n.candidatos && n.candidatos.length > 1) {
        /* vários NIFs e nenhum se destaca: não se escolhe, mas registam-se
           os candidatos para a identidade poder dizer porque não sabe */
        nif = { valor: null, confianca: null, rotulo: null, url: r.url,
                trecho: null, candidatos: n.candidatos };
      }
    }
    for (const a of extrairTudo(t)) achados.push({ ...a, url: r.url });
    return r;
  }

  /* ---- 1. a homepage, sempre ---- */
  const home = await visitar(base.toString());

  /* ---- 2. os links que lá estão mesmo ---- */
  let descobertos = 0;
  if (home) {
    const links = extrairLinks(home.texto, home.url);
    descobertos = links.length;
    for (const l of links.slice(0, maxInternos)) {
      if (!orcamento() || temTudo()) break;
      await visitar(l.url);
    }
  }

  /* ---- 3. recurso: só quando a descoberta não deu páginas ----
     Um site de uma página, um menu feito em JavaScript, uma homepage que
     é um ecrã de entrada. Aqui voltam os caminhos conhecidos — cinco, e
     dentro do mesmo orçamento que já estava a contar. */
  if (lidas < 2) {
    for (const caminho of CAMINHOS_FALLBACK) {
      if (!orcamento() || temTudo()) break;
      let alvo;
      try { alvo = new URL(caminho, base.origin); } catch (e) { continue; }
      await visitar(alvo.toString());
    }
  }

  return { paginasLidas: lidas, tentativas, naoAbriram, achados, nif,
           urls, corpus: corpus.trim(), descobertos };
}

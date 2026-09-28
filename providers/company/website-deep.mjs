/**
 * LeadMap Pro — leitura profunda do website oficial
 * =================================================
 * A Fase 1 lia a homepage à boleia do enriquecimento de emails e tirava
 * de lá o NIF. Aqui lê-se um punhado de páginas do MESMO domínio onde as
 * empresas costumam declarar os dados que a lei as obriga a publicar —
 * capital social, NIPC, CAE — e onde falam da sua própria dimensão.
 *
 * O QUE IMPEDE ISTO DE SER UM CRAWLER
 * -----------------------------------
 * A lista de caminhos é fixa e curta. Não se seguem links: tentam-se
 * endereços conhecidos e o que não existir devolve 404 e acaba ali. Não
 * se sai do domínio, não há profundidade, não há fila de descoberta.
 * O teto é MAX_PAGINAS páginas por empresa, e isso é o fim.
 *
 * O rodapé e a página de termos são, na prática, onde está quase tudo:
 * em Portugal o capital social e o NIPC aparecem lá por obrigação legal.
 */

import { lerPagina, texto, urlSeguro } from './http.mjs';

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
import { extrairTudo } from './extracao.mjs';
import { extrairNif } from './nif.mjs';

/** Caminhos tentados, por ordem de probabilidade de conterem algo. */
export const CAMINHOS = Object.freeze([
  /* Ordenados por rendimento, não por alfabeto. Em Portugal o capital
     social e o NIPC aparecem no rodapé e nas páginas legais por
     obrigação — por isso /termos e /legal vêm cedo, dentro do teto de
     tentativas. As variantes inglesas ficam para o fim: um site que as
     use costuma ter também a versão portuguesa. */
  '/', '/contactos', '/sobre', '/termos', '/empresa', '/quem-somos', '/legal',
  '/privacidade', '/sobre-nos', '/contacts', '/about', '/company', '/terms', '/privacy'
]);

/** Teto de páginas efetivamente lidas por empresa. */
export const MAX_PAGINAS = 4;

/**
 * Teto de TENTATIVAS, que é o número que importa para o servidor do
 * outro lado. Sem ele, um site com poucas páginas levava com as catorze
 * tentativas todas para devolver três leituras — catorze pedidos por
 * empresa, a maioria 404. Oito é o suficiente para apanhar homepage,
 * contactos, sobre e termos.
 */
export const MAX_TENTATIVAS = 8;

/**
 * Lê o website e devolve o que encontrou.
 *
 * Para assim que tiver capital social E NIF — os dois dados que valem a
 * pena, e os que aparecem cedo. Continuar a bater em páginas depois
 * disso seria gastar pedidos alheios sem retorno.
 */
export async function investigarWebsite(website, { max = MAX_PAGINAS, maxTentativas = MAX_TENTATIVAS, fetchPagina = lerPagina } = {}) {
  /* HTTP é aceite para sites de empresas: é uma leitura de página
     pública, sem credenciais nem sessão. Muitas PME portuguesas ainda
     não têm TLS, e recusá-las apagaria metade da cobertura. As guardas
     de SSRF, timeout e tamanho aplicam-se na mesma. */
  const base = urlSeguro(website, { permitirHttp: true });
  if (!base) return { paginasLidas: 0, tentativas: 0, achados: [], nif: null, urls: [] };
  const dominio = dominioBase(base.hostname);

  const achados = [];
  const urls = [];
  let nif = null;
  let lidas = 0;
  let tentativas = 0;

  for (const caminho of CAMINHOS) {
    if (lidas >= max || tentativas >= maxTentativas) break;
    let alvo;
    try { alvo = new URL(caminho, base.origin); } catch (e) { continue; }
    /* nunca sair do domínio, nem por redirecionamento na construção */
    if (dominioBase(alvo.hostname) !== dominio) continue;

    tentativas += 1;
    const r = await fetchPagina(alvo.toString(), { permitirHttp: true });
    if (!r) continue;
    /* um redirecionamento para fora do domínio descarta-se: o conteúdo
       deixou de ser declaração desta empresa. www conta como o mesmo. */
    try { if (dominioBase(new URL(r.url).hostname) !== dominio) continue; } catch (e) { continue; }

    lidas += 1;
    urls.push(r.url);
    const t = texto(r.texto);

    if (!nif) {
      const n = extrairNif(r.texto);
      if (n.encontrado) nif = { valor: n.nif, confianca: n.confianca, rotulo: n.rotulo, url: r.url };
    }
    for (const a of extrairTudo(t)) achados.push({ ...a, url: r.url });

    const temCapital = achados.some(a => a.campo === 'capitalSocial');
    if (nif && temCapital) break;
  }

  return { paginasLidas: lidas, tentativas, achados, nif, urls };
}

/**
 * LeadMap Pro — descoberta controlada de links internos
 * =====================================================
 *   node --test tests/website-descoberta.test.mjs
 *
 * PORQUE É QUE ISTO SUBSTITUIU A ADIVINHAÇÃO
 * ------------------------------------------
 * A versão anterior tentava catorze endereços fixos. Medido em trinta
 * empresas reais: 7,5 pedidos por empresa para ler 2,0 páginas — três em
 * cada quatro pedidos eram 404. E o que existia continuava a escapar,
 * porque `/empresa.html` não está em lista nenhuma que alguém escreva à
 * mão. Era nessa página que estava a única declaração de efetivos que
 * faltava apanhar.
 *
 * O QUE ESTES TESTES DEFENDEM
 * ---------------------------
 * Que isto continue a ser uma substituição e não uma expansão. A
 * diferença cabe num número: o orçamento. Sem teto, "seguir os links da
 * homepage" transforma-se em crawler na primeira vez que alguém quiser
 * mais cobertura — e nenhuma linha de código avisa.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  investigarWebsite, extrairLinks, pontuarLink,
  CAMINHOS_FALLBACK, MAX_PAGINAS, MAX_INTERNOS, MAX_TENTATIVAS
} from '../providers/company/website-deep.mjs';

/** Servidor de mentira: devolve o que estiver no mapa, conta os pedidos. */
function site(paginas) {
  let pedidos = 0;
  const pedidas = [];
  const fn = async (u) => {
    pedidos += 1; pedidas.push(String(u));
    const html = paginas[String(u)] ?? paginas[String(u).replace(/\/$/, '')];
    return html == null ? null : { texto: html, url: String(u) };
  };
  fn.pedidos = () => pedidos;
  fn.pedidas = () => pedidas;
  return fn;
}

const link = (href, texto = '') => '<a href="' + href + '">' + texto + '</a>';

/* ================================================================ *
 * 1, 2, 13, 14 — links que devem ser seguidos                       *
 * ================================================================ */

test('1: /empresa.html é descoberto — foi o caso real que faltava', async () => {
  const fn = site({
    'https://x.pt/': link('/empresa.html', 'A Empresa'),
    'https://x.pt/empresa.html': '<p>Nº total de trabalhadores: 21</p>'
  });
  const r = await investigarWebsite('https://x.pt', { fetchPagina: fn });
  assert.ok(r.urls.includes('https://x.pt/empresa.html'), JSON.stringify(r.urls));
  assert.ok(r.achados.some(a => a.campo === 'funcionarios' && a.valor === 21));
});

test('2: /sobre-nos é descoberto', async () => {
  const fn = site({
    'https://x.pt/': link('/sobre-nos/', 'Quem somos'),
    'https://x.pt/sobre-nos/': '<p>Capital Social: €50.000</p>'
  });
  const r = await investigarWebsite('https://x.pt', { fetchPagina: fn });
  assert.ok(r.achados.some(a => a.campo === 'capitalSocial' && a.valor === 50000));
});

test('13/14: URL relativa e absoluta do mesmo domínio são ambas seguidas', async () => {
  const links = extrairLinks(
    link('/sobre', 'Sobre') + link('https://x.pt/empresa', 'Empresa') +
    link('empresa/historia', 'História'), 'https://x.pt/');
  const caminhos = links.map(l => new URL(l.url).pathname);
  assert.ok(caminhos.includes('/sobre'), JSON.stringify(caminhos));
  assert.ok(caminhos.includes('/empresa'));
  assert.ok(caminhos.includes('/empresa/historia'));
});

/* ================================================================ *
 * 3 a 7 — o que nem sequer é uma página interna                     *
 * ================================================================ */

test('3: link externo é recusado', () => {
  const links = extrairLinks(
    link('https://outro-dominio.pt/sobre', 'Sobre') +
    link('https://facebook.com/empresa', 'Empresa'), 'https://x.pt/');
  assert.deepEqual(links, []);
});

test('4/5/6/7: mailto, tel, javascript e âncora são recusados', () => {
  const links = extrairLinks(
    link('mailto:geral@x.pt', 'Sobre nós') + link('tel:+351210000000', 'Empresa') +
    link('javascript:void(0)', 'Quem somos') + link('#sobre', 'Sobre') +
    link('data:text/html,<b>x', 'Empresa') + link('file:///etc/passwd', 'Sobre'),
    'https://x.pt/');
  assert.deepEqual(links, [], JSON.stringify(links));
});

/* ================================================================ *
 * 8, 9, 10, 24 — pontuação                                          *
 * ================================================================ */

test('8/9/10: blog, produtos e login são penalizados', () => {
  for (const c of ['/blog', '/blog/artigo-1', '/noticias', '/produtos', '/produto/x',
                   '/loja', '/checkout', '/login', '/wp-login.php', '/carrinho',
                   '/galeria', '/portfolio', '/tag/obras', '/author/joao']) {
    assert.ok(pontuarLink(c) < 0, c + ' devia ser penalizado');
  }
});

test('24: o ranking escolhe a empresa antes do blog', () => {
  const links = extrairLinks(
    link('/blog', 'Blog') + link('/produtos', 'Produtos') +
    link('/contactos', 'Contactos') + link('/quem-somos', 'Quem Somos') +
    link('/noticias', 'Notícias'), 'https://x.pt/');
  assert.equal(new URL(links[0].url).pathname, '/quem-somos', JSON.stringify(links));
  assert.equal(links.some(l => /blog|produtos|noticias/.test(l.url)), false);
});

test('24: um link sem palavras no caminho ganha pelo texto da âncora', () => {
  /* `/pagina-2` com o texto "Quem Somos" é um site mal feito, não um
     site sem página institucional */
  const links = extrairLinks(link('/pagina-2', 'Quem Somos'), 'https://x.pt/');
  assert.equal(links.length, 1);
  assert.ok(links[0].pontos > 0);
});

test('um link sem relevância nenhuma não é visitado', () => {
  assert.equal(pontuarLink('/uma-pagina-qualquer'), 0);
  assert.deepEqual(extrairLinks(link('/uma-pagina-qualquer', 'Clique'), 'https://x.pt/'), []);
});

/* ================================================================ *
 * 11, 12, 15, 16 — normalização                                     *
 * ================================================================ */

test('11: links duplicados contam uma vez', () => {
  const links = extrairLinks(
    link('/sobre', 'Sobre') + link('/sobre', 'Sobre nós') + link('/sobre/', 'A empresa'),
    'https://x.pt/');
  assert.equal(links.length, 1, JSON.stringify(links));
});

test('15: a mesma página com querystrings diferentes conta uma vez', () => {
  const links = extrairLinks(
    link('/sobre?utm_source=a', 'Sobre') + link('/sobre?utm_source=b', 'Sobre'),
    'https://x.pt/');
  assert.equal(links.length, 1, 'gastava metade do orçamento no mesmo texto');
});

test('16: o fragmento é removido — é a mesma página', () => {
  const links = extrairLinks(link('/sobre#equipa', 'Sobre'), 'https://x.pt/');
  assert.equal(links.length, 1);
  assert.equal(links[0].url.includes('#'), false, JSON.stringify(links[0]));
});

test('12: www e domínio base são o mesmo sítio', () => {
  const links = extrairLinks(link('https://www.x.pt/sobre', 'Sobre'), 'https://x.pt/');
  assert.equal(links.length, 1, 'www.x.pt e x.pt são o mesmo negócio');
  const inverso = extrairLinks(link('https://x.pt/sobre', 'Sobre'), 'https://www.x.pt/');
  assert.equal(inverso.length, 1);
});

test('a própria homepage não entra na lista de links a visitar', () => {
  const links = extrairLinks(link('/', 'Início') + link('https://x.pt/', 'Home'), 'https://x.pt/');
  assert.deepEqual(links, []);
});

test('ficheiros que não são HTML ficam de fora — incluindo PDF', () => {
  const links = extrairLinks(
    link('/relatorio-contas.pdf', 'Relatório e Contas') +
    link('/empresa.jpg', 'Empresa') + link('/sobre.docx', 'Sobre'), 'https://x.pt/');
  assert.deepEqual(links, [], 'o PDF ficou de fora por decisão da Fase 4');
});

/* ================================================================ *
 * 17, 25 — orçamento                                                *
 * ================================================================ */

test('17/25: nunca mais do que MAX_PAGINAS páginas nem MAX_TENTATIVAS pedidos', async () => {
  const paginas = { 'https://x.pt/': Array.from({ length: 50 }, (_, i) =>
    link('/sobre-' + i, 'Sobre nós ' + i)).join('') };
  for (let i = 0; i < 50; i++) paginas['https://x.pt/sobre-' + i] = '<p>nada</p>';
  const fn = site(paginas);
  const r = await investigarWebsite('https://x.pt', { fetchPagina: fn });
  assert.ok(r.paginasLidas <= MAX_PAGINAS, 'leu ' + r.paginasLidas);
  assert.ok(fn.pedidos() <= MAX_TENTATIVAS, 'pediu ' + fn.pedidos());
  assert.ok(r.paginasLidas <= 1 + MAX_INTERNOS);
});

test('23: uma homepage com cinquenta links só rende os melhores', async () => {
  const paginas = { 'https://x.pt/':
    Array.from({ length: 40 }, (_, i) => link('/blog/post-' + i, 'Artigo ' + i)).join('') +
    link('/quem-somos', 'Quem Somos') + link('/empresa', 'A Empresa') +
    link('/termos', 'Termos') + link('/contactos', 'Contactos') };
  for (const p of ['/quem-somos', '/empresa', '/termos', '/contactos']) paginas['https://x.pt' + p] = '<p>x</p>';
  const fn = site(paginas);
  await investigarWebsite('https://x.pt', { fetchPagina: fn });
  const visitadas = fn.pedidas().filter(u => u !== 'https://x.pt/');
  assert.equal(visitadas.some(u => u.includes('/blog/')), false, 'entrou no blog');
  assert.ok(visitadas.length <= MAX_INTERNOS);
});

test('o orçamento é partilhado: o recurso não o duplica', async () => {
  /* homepage sem links úteis → recurso entra, mas dentro do mesmo teto */
  const fn = site({ 'https://x.pt/': '<p>uma página só</p>' });
  const r = await investigarWebsite('https://x.pt', { fetchPagina: fn });
  assert.ok(fn.pedidos() <= MAX_TENTATIVAS, 'pediu ' + fn.pedidos());
  assert.equal(r.paginasLidas, 1);
});

/* ================================================================ *
 * 18, 22 — recurso                                                  *
 * ================================================================ */

test('18/22: sem links na homepage, entram os caminhos conhecidos', async () => {
  const fn = site({
    'https://x.pt/': '<p>Bem-vindos</p>',              /* nenhum link */
    'https://x.pt/sobre': '<p>Capital Social: €75.000</p>'
  });
  const r = await investigarWebsite('https://x.pt', { fetchPagina: fn });
  assert.ok(r.achados.some(a => a.campo === 'capitalSocial' && a.valor === 75000),
    'o recurso não salvou um site de uma página só');
});

test('18: com links bons, o recurso não é usado', async () => {
  const fn = site({
    'https://x.pt/': link('/quem-somos', 'Quem somos') + link('/empresa', 'A empresa'),
    'https://x.pt/quem-somos': '<p>Temos 40 colaboradores</p>',
    'https://x.pt/empresa': '<p>Capital Social: €10.000</p>'
  });
  await investigarWebsite('https://x.pt', { fetchPagina: fn });
  const pedidas = fn.pedidas();
  assert.equal(pedidas.some(u => u.endsWith('/sobre-nos') || u.endsWith('/termos-e-condicoes')), false,
    'foi ao recurso quando tinha links a sério: ' + JSON.stringify(pedidas));
});

test('a lista de recurso é curta', () => {
  assert.ok(CAMINHOS_FALLBACK.length <= 6, 'voltou a crescer para uma lista cega');
});

/* ================================================================ *
 * 19, 20, 21 — cache, SSRF, redirects                               *
 * ================================================================ */

test('19: a mesma página não é pedida duas vezes', async () => {
  const fn = site({
    'https://x.pt/': link('/sobre', 'Sobre') + link('/sobre/', 'Sobre nós') + link('/sobre#x', 'Empresa'),
    'https://x.pt/sobre': '<p>x</p>'
  });
  await investigarWebsite('https://x.pt', { fetchPagina: fn });
  const sobre = fn.pedidas().filter(u => u.replace(/[/#].*$/, '').endsWith('sobre') || /\/sobre/.test(u));
  assert.ok(sobre.length <= 1, 'pediu a mesma página ' + sobre.length + ' vezes');
});

test('20: uma URL interna que aponte para um alvo proibido é recusada', async () => {
  /* o HTML não é de confiança por ser HTML: passa pelo urlSeguro na mesma */
  const fn = site({ 'https://x.pt/':
    link('http://localhost/sobre', 'Sobre') + link('http://127.0.0.1/empresa', 'Empresa') +
    link('http://169.254.169.254/quem-somos', 'Quem somos') +
    link('http://10.0.0.1/institucional', 'Institucional') });
  const r = await investigarWebsite('https://x.pt', { fetchPagina: fn });
  for (const u of fn.pedidas()) {
    assert.equal(/localhost|127\.0\.0\.1|169\.254|10\.0\.0\.1/.test(u), false, 'pediu ' + u);
  }
  assert.equal(r.paginasLidas, 1);
});

test('21: um redirecionamento para fora do domínio descarta a página', async () => {
  let pedidos = 0;
  const fn = async (u) => {
    pedidos += 1;
    if (String(u) === 'https://x.pt/') return { texto: link('/sobre', 'Sobre'), url: 'https://x.pt/' };
    /* a página responde, mas já noutro domínio */
    return { texto: '<p>Capital Social: €99.000</p>', url: 'https://outro.pt/sobre' };
  };
  const r = await investigarWebsite('https://x.pt', { fetchPagina: fn });
  assert.equal(r.achados.some(a => a.campo === 'capitalSocial'), false,
    'aceitou conteúdo de outro domínio como declaração desta empresa');
});

test('21: o redirecionamento www→raiz continua a contar como o mesmo sítio', async () => {
  const fn = async (u) => String(u).includes('www.x.pt')
    ? { texto: '<p>Capital Social: €20.000</p>', url: 'https://x.pt/' } : null;
  const r = await investigarWebsite('https://www.x.pt', { fetchPagina: fn });
  assert.ok(r.paginasLidas > 0);
  assert.ok(r.achados.some(a => a.campo === 'capitalSocial'));
});

/* ================================================================ *
 * Invariantes                                                       *
 * ================================================================ */

test('nunca lança, seja qual for o HTML', async () => {
  for (const html of ['', '<a href=', '<a href="">', '<a href="//">x</a>',
                      '<a href="' + 'x'.repeat(5000) + '">y</a>', null, undefined]) {
    assert.doesNotThrow(() => extrairLinks(html, 'https://x.pt/'));
  }
  for (const w of ['N/D', '', null, 'não é url', 'http://localhost/']) {
    const r = await investigarWebsite(w, { fetchPagina: site({}) });
    assert.equal(r.paginasLidas, 0);
  }
});

test('o resultado continua a trazer tudo o que o pipeline espera', async () => {
  const fn = site({ 'https://x.pt/': '<p>NIPC: 508459451</p>' });
  const r = await investigarWebsite('https://x.pt', { fetchPagina: fn });
  for (const k of ['paginasLidas', 'tentativas', 'achados', 'nif', 'urls', 'corpus']) {
    assert.ok(k in r, 'falta ' + k);
  }
  assert.equal(r.nif.valor, '508459451');
  assert.ok(typeof r.corpus === 'string');
  /* instrumentação nova, para se poder medir o desperdício */
  assert.equal(typeof r.naoAbriram, 'number');
  assert.equal(typeof r.descobertos, 'number');
});

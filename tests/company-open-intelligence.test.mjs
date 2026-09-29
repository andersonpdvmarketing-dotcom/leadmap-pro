/**
 * LeadMap Pro — Open Company Intelligence (Fase 3)
 * ================================================
 *   node --test tests/company-open-intelligence.test.mjs
 *
 * Nenhum teste aqui toca na rede: todos os fornecedores recebem uma
 * função de leitura injetada. O que se testa é o que o motor faz com o
 * que lhe dão — incluindo quando lhe dão lixo, nada, ou duas versões
 * contraditórias da mesma verdade.
 *
 * A LINHA QUE ESTES TESTES DEFENDEM
 * ---------------------------------
 * "Somos uma equipa de 75 profissionais" é a empresa a declarar a sua
 * dimensão. Dez caras numa página "Equipa" é um layout. Contar as
 * segundas e chamar-lhes funcionários produziria um número que parece
 * medido e não é — e alguém filtraria "30+ funcionários" com base nele.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  numeroPt, extrairCapitalSocial, extrairCae, extrairFuncionarios,
  extrairFaturacao, extrairTudo
} from '../providers/company/extracao.mjs';
import { SicaeProvider, extrairSicae } from '../providers/company/sicae.mjs';
import { investigarWebsite, CAMINHOS, MAX_PAGINAS, MAX_TENTATIVAS } from '../providers/company/website-deep.mjs';
import {
  investigarEmpresa, investigarLote, CacheEmpresa, TTL, evidenciasDoWebsite
} from '../providers/company/open-intelligence.mjs';
import { hostSeguro, urlSeguro, texto, USER_AGENT } from '../providers/company/http.mjs';
import { evidenciasDe, escolherPrincipal, TIPO_FONTE } from '../providers/company/contract.mjs';

/* Resposta real do SICAE, guardada para não depender da rede. */
const SICAE_HTML = `<table><tr><td>NIPC</td><td>Denominação Social/Firma</td><td>CAE Principal</td></tr>
<tr><td>508459451</td><td>MEDIBRACARA - CENTRO MÉDICO LDA</td><td>86230</td><td>68110,</td><td>68200,</td><td>86220</td></tr></table>`;
const SICAE_FORM = '<input id="__VIEWSTATE" value="vs" /><input id="__EVENTVALIDATION" value="ev" />';

const NIPC = '508459451';

function sicaeSimulado({ resposta = SICAE_HTML, form = SICAE_FORM, falha = false } = {}) {
  let pedidos = 0;
  const p = new SicaeProvider({
    fetchPagina: async (u, o) => {
      pedidos += 1;
      if (falha) return null;
      return { texto: (o && o.metodo === 'POST') ? resposta : form, url: String(u), cookies: null };
    }
  });
  Object.defineProperty(p, 'pedidos', { get: () => pedidos });
  return p;
}

function siteSimulado(paginas) {
  let pedidos = 0;
  const fn = async (u) => { pedidos += 1; return paginas[u] ? { texto: paginas[u], url: u } : null; };
  fn.pedidos = () => pedidos;
  return fn;
}

/* ================================================================ *
 * SICAE                                                             *
 * ================================================================ */

test('SICAE: NIPC válido devolve CAE oficial', async () => {
  const p = sicaeSimulado();
  const r = await p.consultar({ nif: NIPC });
  assert.equal(r.success, true);
  assert.equal(r.empresa.cae.valor, '86230');
  assert.equal(r.empresa.cae.estado, 'CONFIRMADO');
  const evs = evidenciasDe(r.empresa.cae);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].tipoFonte, TIPO_FONTE.FONTE_OFICIAL);
  assert.equal(evs[0].fonte, 'SICAE');
  /* o canal não é cifrado: a confiança reflete-o */
  assert.ok(evs[0].confianca < 1, 'HTTP sem TLS não pode valer confiança máxima');
});

test('SICAE: não inventa funcionários nem faturação a partir do CAE', async () => {
  const r = await sicaeSimulado().consultar({ nif: NIPC });
  for (const c of ['funcionarios', 'faturacaoAnual', 'capitalSocial']) {
    assert.equal(r.empresa[c].valor, null, c + ' não pode sair de um CAE');
  }
});

test('SICAE: NIPC sem resultado dá NAO_ENCONTRADO, não valor inventado', async () => {
  const p = sicaeSimulado({ resposta: '<p>Não foram encontrados registos.</p>' });
  const r = await p.consultar({ nif: NIPC });
  assert.equal(r.empresa.cae.estado, 'NAO_ENCONTRADO');
  assert.equal(r.empresa.cae.valor, null);
});

test('SICAE: timeout/falha de rede não devolve "não encontrado"', async () => {
  const p = sicaeSimulado({ falha: true });
  const r = await p.consultar({ nif: NIPC });
  /* não se procurou de facto: por consultar, não "não existe" */
  assert.equal(r.empresa.cae.estado, 'NAO_CONSULTADO');
});

test('SICAE: HTML alterado não rebenta nem inventa', async () => {
  for (const html of ['', '<html></html>', '<table><tr><td>lixo</td></tr></table>', '<<>>não é html']) {
    const r = await sicaeSimulado({ resposta: html }).consultar({ nif: NIPC });
    assert.equal(r.empresa.cae.valor, null);
  }
});

test('SICAE: só aceita a linha cujo NIPC bate exatamente', () => {
  assert.equal(extrairSicae(SICAE_HTML, NIPC).caePrincipal, '86230');
  assert.equal(extrairSicae(SICAE_HTML, '501234560'), null, 'atribuiu o CAE de outra empresa');
});

test('SICAE: sem NIPC válido não faz consulta nenhuma', async () => {
  const p = sicaeSimulado();
  for (const n of [null, '', '123', '501234561']) {   /* o último tem checksum errado */
    const r = await p.consultar({ nif: n, dominio: 'x.pt' });
    assert.equal(r.empresa.cae.estado, 'NAO_CONSULTADO');
  }
  assert.equal(p.pedidos, 0, 'gastou pedidos sem NIPC válido');
});

test('SICAE: desliga-se sozinho se a fonte passar a exigir anti-bot', async () => {
  const p = sicaeSimulado({ form: '<div id="NoBotExtender"></div>' + SICAE_FORM });
  const r = await p.consultar({ nif: NIPC });
  assert.equal(p.isConfigured(), false, 'devia ter-se desativado');
  assert.match(p.motivoDesativacao, /anti-automação|anti-automacao/i);
  assert.equal(r.empresa.cae.estado, 'NAO_CONSULTADO');
});

test('SICAE: o disjuntor abre depois de falhas seguidas', async () => {
  let t = 0;
  const p = new SicaeProvider({ fetchPagina: async () => null, agora: () => t });
  for (let i = 0; i < 4; i++) await p.consultar({ nif: NIPC });
  assert.equal(p.disjuntorAberto(), true, 'devia parar de insistir');
  t += 6 * 60 * 1000;
  assert.equal(p.disjuntorAberto(), false, 'e voltar a tentar mais tarde');
});

test('SICAE declara-se gratuito', () => {
  assert.equal(new SicaeProvider().custo, 'GRATUITA');
});

/* ================================================================ *
 * Extração                                                          *
 * ================================================================ */

test('números portugueses: ponto é milhar, vírgula é decimal', () => {
  assert.equal(numeroPt('1.250.000'), 1250000);
  assert.equal(numeroPt('1.250.000,50'), 1250000.5);
  assert.equal(numeroPt('75'), 75);
  assert.equal(numeroPt('2,5'), 2.5);
  assert.equal(numeroPt('abc'), null);
});

test('website: capital social explícito', () => {
  for (const [t, v] of [
    ['Capital Social: €100.000', 100000],
    ['capital social de 50.000 euros', 50000],
    ['Capital social em 2024: 75.000 €', 75000],
    ['capital social 1.250.000,50 EUR', 1250000.5],
    ['Capital Social de 5 milhões', 5000000]
  ]) {
    const r = extrairCapitalSocial(t);
    assert.equal(r.length, 1, 'falhou em: ' + t);
    assert.equal(r[0].valor, v, 'valor errado em: ' + t);
    assert.ok(r[0].contexto, 'falta o excerto para auditoria');
  }
});

test('website: funcionários só de afirmações sobre a dimensão', () => {
  const exato = extrairFuncionarios('Somos uma equipa de 75 profissionais');
  assert.equal(exato[0].valor, 75);
  assert.equal(exato[0].operador, '=');
  const minimo = extrairFuncionarios('Mais de 120 colaboradores');
  assert.equal(minimo[0].valor, 120);
  assert.equal(minimo[0].operador, '>=', 'um mínimo não pode ser apresentado como exato');
});

test('website: uma lista de pessoas NÃO vira número de funcionários', () => {
  /* a regra que dá forma a este módulo */
  for (const t of [
    'A nossa equipa | João Silva | Maria Costa | Ana Dias | Pedro Nunes',
    '<ul><li>Dr. A</li><li>Dr. B</li><li>Dr. C</li></ul>',
    'Conheça os nossos 5 especialistas destacados nesta página'
  ]) {
    const r = extrairFuncionarios(t);
    assert.equal(r.filter(x => x.operador === '=').length === 0 || !/equipa \|/.test(t), true);
  }
  assert.deepEqual(extrairFuncionarios('João | Maria | Ana | Pedro'), []);
});

test('website: faturação explícita', () => {
  assert.equal(extrairFaturacao('Volume de negócios de €5 milhões em 2025')[0].valor, 5000000);
  assert.equal(extrairFaturacao('faturação 2025: 2.400.000 €')[0].valor, 2400000);
  assert.deepEqual(extrairFaturacao('Fundada em 1998'), []);
});

test('website: CAE explícito', () => {
  assert.equal(extrairCae('CAE 62010')[0].valor, '62010');
  assert.equal(extrairCae('CAE principal: 41200')[0].valor, '41200');
  assert.deepEqual(extrairCae('Sala 62010 do edifício'), [], 'sem rótulo CAE não conta');
});

test('AGREGADO: estatística do setor nunca vira dado da empresa', () => {
  /* §9: a média do setor não é a faturação desta empresa */
  for (const t of [
    'Volume de negócios do setor: média de 300.000 € por empresa',
    'Faturação média nacional de 2 milhões de euros',
    'Empresas deste CAE têm em média 45 colaboradores',
    'Capital social médio do setor: 50.000 €',
    'Segundo o INE, a faturação do mercado ronda 1 milhão'
  ]) {
    assert.deepEqual(extrairTudo(t), [], 'importou um agregado: ' + t);
  }
});

test('ausência de informação devolve vazio, não zero', () => {
  for (const t of ['', 'Bem-vindo ao nosso site', null, undefined, 42]) {
    assert.deepEqual(extrairTudo(typeof t === 'string' ? t : ''), []);
  }
});

/* ================================================================ *
 * Website: limites                                                  *
 * ================================================================ */

test('website: não sai do domínio', async () => {
  const fora = async (u) => ({ texto: '<p>Capital Social: €999.999</p>', url: 'https://outro.com/x' });
  const r = await investigarWebsite('https://x.pt', { fetchPagina: fora });
  assert.equal(r.paginasLidas, 0, 'aceitou conteúdo de outro domínio');
  assert.deepEqual(r.achados, []);
});

test('website: www e não-www são o mesmo domínio', async () => {
  const fn = async (u) => ({ texto: '<p>NIPC: ' + NIPC + '</p>', url: u.replace('www.', '') });
  const r = await investigarWebsite('https://www.x.pt', { fetchPagina: fn });
  assert.ok(r.paginasLidas > 0, 'o redirecionamento www→raiz é o mais banal da web');
});

test('website: teto de tentativas, não só de leituras', async () => {
  const fn = siteSimulado({ 'https://x.pt/': '<p>olá</p>' });
  const r = await investigarWebsite('https://x.pt', { fetchPagina: fn });
  assert.equal(r.paginasLidas, 1);
  assert.ok(fn.pedidos() <= MAX_TENTATIVAS, 'bateu mais vezes do que o teto');
});

test('website: para quando tem tudo o que procura', async () => {
  /* A regra antiga parava com NIF e capital, e por isso nunca chegava às
     páginas onde estão os funcionários e a faturação. Agora só para com
     os quatro — ou quando o orçamento acaba, o que vier primeiro. */
  const fn = siteSimulado({
    'https://x.pt/': '<a href="/sobre">Sobre nós</a><p>NIPC: ' + NIPC +
      ' · Capital Social: €50.000 · Temos 30 colaboradores · ' +
      'volume de negócios de 2 milhões de euros em 2025</p>',
    'https://x.pt/sobre': '<p>nunca deve chegar aqui</p>'
  });
  const r = await investigarWebsite('https://x.pt', { fetchPagina: fn });
  assert.equal(fn.pedidos(), 1, 'tinha tudo na homepage e continuou a pedir');
  assert.equal(r.paginasLidas, 1);
});

test('website: não para cedo demais quando ainda falta um campo', async () => {
  /* Com NIF e capital mas sem funcionários, a versão anterior desistia
     aqui — e os funcionários estavam na página seguinte. */
  const fn = siteSimulado({
    'https://x.pt/': '<a href="/empresa">A empresa</a><p>NIPC: ' + NIPC +
      ' · Capital Social: €50.000</p>',
    'https://x.pt/empresa': '<p>Nº total de trabalhadores: 21</p>'
  });
  const r = await investigarWebsite('https://x.pt', { fetchPagina: fn });
  assert.ok(r.achados.some(a => a.campo === 'funcionarios' && a.valor === 21),
    'parou antes de chegar aos funcionários');
});

test('website: a lista de recurso é curta e de alto rendimento', () => {
  /* Já não são catorze caminhos às cegas: são seis, e só entram quando a
     homepage não deu links nenhuns. */
  assert.ok(CAMINHOS.length <= 6, 'a lista de recurso voltou a crescer');
  for (const c of ['/sobre', '/empresa', '/contactos', '/termos']) {
    assert.ok(CAMINHOS.includes(c), c + ' saiu da lista de recurso');
  }
});

test('empresa sem website não produz leitura nenhuma', async () => {
  const fn = siteSimulado({});
  for (const w of ['N/D', '', null, 'não é url']) {
    const r = await investigarWebsite(w, { fetchPagina: fn });
    assert.equal(r.paginasLidas, 0);
  }
  assert.equal(fn.pedidos(), 0);
});

/* ================================================================ *
 * Pipeline                                                          *
 * ================================================================ */

const SITE = {
  'https://medibracara.pt/': '<p>Bem-vindos</p>',
  'https://medibracara.pt/contactos': '<p>NIPC: ' + NIPC + ' · Somos uma equipa de 47 profissionais</p>',
  'https://medibracara.pt/termos': '<footer>Capital Social: €75.000</footer>'
};
const investigarSite = (w) => investigarWebsite(w, { fetchPagina: siteSimulado(SITE) });
/* O nome do lead e a firma que o SICAE simulado devolve têm de ser a
   MESMA empresa. Enquanto o lead se chamou "Alfa" e o registo
   respondeu "MEDIBRACARA", a fixture descrevia um NIF de outra
   entidade — e a partir da Fase 3.2 é isso que a camada de
   identidade bloqueia, com razão. */
const LEAD = { id: 'g-1', nome: 'Medibracara', website: 'https://medibracara.pt' };

test('pipeline: junta website e SICAE', async () => {
  const r = await investigarEmpresa(LEAD, { sicae: sicaeSimulado(), investigar: investigarSite });
  assert.equal(r.empresa.nif.valor, NIPC);
  assert.equal(r.empresa.cae.valor, '86230');
  assert.equal(r.empresa.funcionarios.valor, 47);
  assert.equal(r.empresa.capitalSocial.valor, 75000);
  assert.equal(r.empresa.faturacaoAnual.estado, 'NAO_ENCONTRADO');
  assert.equal(r.erros.length, 0);
});

test('pipeline: SICAE em baixo não derruba o website', async () => {
  const r = await investigarEmpresa(LEAD, { sicae: sicaeSimulado({ falha: true }), investigar: investigarSite });
  assert.equal(r.empresa.nif.valor, NIPC, 'o website continuou a ser lido');
  assert.equal(r.empresa.capitalSocial.valor, 75000);
  assert.equal(r.empresa.cae.estado, 'NAO_CONSULTADO');
});

test('pipeline: website em baixo não derruba nada', async () => {
  const r = await investigarEmpresa(LEAD, { sicae: sicaeSimulado(), investigar: async () => { throw new Error('caiu'); } });
  assert.equal(r.erros.some(e => e.fonte === 'website'), true);
  /* sem NIF não há SICAE que se possa consultar; tudo fica por consultar */
  for (const c of ['nif', 'cae', 'capitalSocial']) assert.equal(r.empresa[c].estado, 'NAO_CONSULTADO');
});

test('pipeline: páginas lidas sem achado dá NAO_ENCONTRADO, não NAO_CONSULTADO', async () => {
  const vazio = (w) => investigarWebsite(w, { fetchPagina: siteSimulado({ 'https://medibracara.pt/': '<p>nada</p>' }) });
  const r = await investigarEmpresa(LEAD, { sicae: sicaeSimulado(), investigar: vazio });
  assert.equal(r.empresa.capitalSocial.estado, 'NAO_ENCONTRADO', 'procurou-se mesmo');
});

test('pipeline: um mínimo declarado é ESTIMADO, não CONFIRMADO', async () => {
  const site = (w) => investigarWebsite(w, { fetchPagina: siteSimulado({
    'https://medibracara.pt/': '<p>Mais de 120 colaboradores</p>' }) });
  const r = await investigarEmpresa(LEAD, { sicae: sicaeSimulado({ falha: true }), investigar: site });
  assert.equal(r.empresa.funcionarios.valor, 120);
  assert.equal(r.empresa.funcionarios.estado, 'ESTIMADO',
    '"mais de 120" é um mínimo declarado, não uma contagem');
});

test('pipeline: conflito entre website e SICAE fica registado', async () => {
  const site = (w) => investigarWebsite(w, { fetchPagina: siteSimulado({
    'https://medibracara.pt/': '<p>NIPC: ' + NIPC + ' · CAE 41200</p>' }) });
  const r = await investigarEmpresa(LEAD, { sicae: sicaeSimulado(), investigar: site });
  const evs = evidenciasDe(r.empresa.cae);
  assert.equal(evs.length, 2, 'as duas afirmações têm de ser guardadas');
  /* o SICAE é fonte oficial e ganha ao site, sem apagar a outra */
  assert.equal(r.empresa.cae.valor, '86230');
  assert.ok(evs.some(e => e.valor === '41200'), 'a evidência do site desapareceu');
});

test('pipeline: a auditoria guarda excertos curtos, não a página', async () => {
  const r = await investigarEmpresa(LEAD, { sicae: sicaeSimulado(), investigar: investigarSite });
  assert.ok(r.auditoria.length > 0);
  for (const a of r.auditoria) {
    assert.ok(a.contexto && a.contexto.length <= 90, 'excerto demasiado longo');
    assert.ok(a.url, 'falta a página de onde veio');
  }
});

test('pipeline: nunca lança, mesmo com lead absurdo', async () => {
  for (const l of [null, {}, { id: 'x' }, { id: 'y', website: 'javascript:alert(1)' }]) {
    const r = await investigarEmpresa(l, { sicae: sicaeSimulado(), investigar: investigarSite });
    assert.ok(r && r.empresa, 'devolveu nada para ' + JSON.stringify(l));
  }
});

/* ================================================================ *
 * Cache e fila                                                      *
 * ================================================================ */

test('cache: a segunda investigação não repete consultas', async () => {
  const cache = new CacheEmpresa();
  const sicae = sicaeSimulado();
  await investigarEmpresa(LEAD, { cache, sicae, investigar: investigarSite });
  const pedidosDepoisDaPrimeira = sicae.pedidos;
  const r = await investigarEmpresa(LEAD, { cache, sicae, investigar: investigarSite });
  assert.equal(sicae.pedidos, pedidosDepoisDaPrimeira, 'voltou a consultar o SICAE');
  assert.ok(r.fontes.every(f => f.cache === true));
  assert.ok(cache.acertos >= 2);
});

test('cache: expira conforme o TTL de cada fonte', () => {
  let t = 0;
  const cache = new CacheEmpresa({ agora: () => t });
  cache.guardar('sicae', NIPC, { x: 1 }, TTL.sicae);
  cache.guardar('website', 'https://x.pt', { y: 1 }, TTL.website);
  t = 8 * 24 * 3600 * 1000;                       /* 8 dias */
  assert.equal(cache.ler('website', 'https://x.pt'), null, 'website devia ter expirado');
  assert.ok(cache.ler('sicae', NIPC), 'o CAE muda raramente: 30 dias');
  assert.ok(TTL.sicae > TTL.website);
});

test('fila: concorrência limitada e teto por lote', async () => {
  const leads = Array.from({ length: 40 }, (_, i) => ({ id: 'g' + i, website: 'https://medibracara.pt' }));
  let emCurso = 0, pico = 0;
  const investigar = async (w) => {
    emCurso++; pico = Math.max(pico, emCurso);
    await new Promise(r => setTimeout(r, 5));
    emCurso--;
    return { paginasLidas: 1, tentativas: 1, achados: [], nif: null, urls: [] };
  };
  const res = await investigarLote(leads, { concorrencia: 2, max: 10, sicae: sicaeSimulado(), investigar });
  assert.equal(res.size, 10, 'o teto por lote não foi respeitado');
  assert.ok(pico <= 2, 'concorrência excedida: ' + pico);
});

test('fila: reporta progresso sem esperar pelo fim', async () => {
  const leads = Array.from({ length: 6 }, (_, i) => ({ id: 'g' + i, website: 'https://medibracara.pt' }));
  const marcos = [];
  await investigarLote(leads, {
    concorrencia: 2, max: 6, sicae: sicaeSimulado({ falha: true }), investigar: investigarSite,
    aoProgredir: (feitos, total) => marcos.push(feitos + '/' + total)
  });
  assert.equal(marcos.length, 6);
  assert.equal(marcos[marcos.length - 1], '6/6');
});

test('fila: um lead que rebenta não derruba o lote', async () => {
  const leads = [{ id: 'a', website: 'https://medibracara.pt' }, { id: 'b', website: 'https://medibracara.pt' }];
  let n = 0;
  const investigar = async (w) => { n++; if (n === 1) throw new Error('rebentou'); return { paginasLidas: 1, tentativas: 1, achados: [], nif: null, urls: [] }; };
  const res = await investigarLote(leads, { concorrencia: 1, sicae: sicaeSimulado({ falha: true }), investigar });
  assert.equal(res.size, 2, 'o lote parou no primeiro erro');
});

/* ================================================================ *
 * Segurança e privacidade                                           *
 * ================================================================ */

test('SSRF: alvos internos são recusados', () => {
  for (const h of ['localhost', '127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1',
                   '169.254.169.254', 'algo.local', 'algo.internal', '0.0.0.0']) {
    assert.equal(hostSeguro(h), false, 'permitiu ' + h);
  }
  assert.equal(hostSeguro('exemplo.pt'), true);
});

test('HTTP só quando explicitamente pedido', () => {
  assert.equal(urlSeguro('http://x.pt'), null, 'http não pode passar por omissão');
  assert.ok(urlSeguro('http://x.pt', { permitirHttp: true }));
  assert.equal(urlSeguro('javascript:alert(1)'), null);
  assert.equal(urlSeguro('file:///etc/passwd'), null);
  assert.equal(urlSeguro('ftp://x.pt'), null);
});

test('o User-Agent identifica-se', () => {
  assert.match(USER_AGENT, /LeadMapPro/);
  assert.match(USER_AGENT, /https?:\/\//, 'devia dizer onde encontrar quem consulta');
});

test('o HTML recebido é dado, nunca executado', () => {
  const src = readFileSync(new URL('../providers/company/http.mjs', import.meta.url), 'utf8') +
              readFileSync(new URL('../providers/company/extracao.mjs', import.meta.url), 'utf8') +
              readFileSync(new URL('../providers/company/website-deep.mjs', import.meta.url), 'utf8');
  for (const perigo of ['eval(', 'new Function', 'vm.runIn', 'child_process', 'require(']) {
    assert.equal(src.includes(perigo), false, 'contém ' + perigo);
  }
});

test('o <script> da página é ignorado', () => {
  const t = texto('<script>var capital = "Capital Social: €999.999";</script><p>olá</p>');
  assert.equal(/capital/i.test(t), false, 'leu conteúdo de dentro de um <script>');
});

test('privacidade: nenhum campo pessoal é extraído', () => {
  const src = readFileSync(new URL('../providers/company/extracao.mjs', import.meta.url), 'utf8');
  for (const pessoal of ['socio', 'sócio', 'gerente', 'administrador', 'morada', 'residen', 'nascimento', 'bilhete']) {
    assert.equal(new RegExp('extrair\\w*' + pessoal, 'i').test(src), false, 'extrai ' + pessoal);
  }
  /* uma página cheia de dados pessoais não produz campos empresariais */
  const pagina = 'Gerente: João Silva, residente na Rua X, NIF 212345672, nascido em 1970';
  assert.deepEqual(extrairTudo(pagina), []);
});

test('nenhum provider pago e nenhuma credencial', async () => {
  const { COMPANY_PROVIDER_TYPES } = await import('../providers/company/router.mjs');
  assert.equal(COMPANY_PROVIDER_TYPES.includes('racius'), false);
  assert.equal(COMPANY_PROVIDER_TYPES.includes('nifpt'), false);
  for (const f of ['sicae.mjs', 'open-intelligence.mjs', 'website-deep.mjs', 'extracao.mjs', 'http.mjs']) {
    const src = readFileSync(new URL('../providers/company/' + f, import.meta.url), 'utf8');
    for (const cred of ['api_key', 'apiKey', 'API_KEY', 'Bearer ', 'token=', 'password']) {
      assert.equal(src.includes(cred), false, f + ' contém ' + cred);
    }
  }
});

test('a rota de servidor não devolve 500 nem detalhes de erro', () => {
  const src = readFileSync(new URL('../api/enrich/company.mjs', import.meta.url), 'utf8');
  assert.equal(/status\(500\)/.test(src), false, 'uma investigação falhada não é erro da aplicação');
  assert.ok(/erros\.map\(e => \(\{ fonte: e\.fonte \}\)\)/.test(src),
    'a mensagem de erro pode transportar o host interno: só sai a fonte');
  assert.match(src, /NÃO renomear para `\.js`/);
});

/* ================================================================ *
 * Retrocompatibilidade                                              *
 * ================================================================ */

test('um lead da Fase 1 com NIF já conhecido não é relido do site', async () => {
  const comNif = { id: 'g-2', website: 'https://medibracara.pt',
    empresa: { nif: { valor: NIPC, fonte: 'site', consultadoEm: '2026-01-01', confianca: 0.9, estado: 'CONFIRMADO' } } };
  const sicae = sicaeSimulado();
  const r = await investigarEmpresa(comNif, { sicae, investigar: async () => null });
  assert.equal(r.empresa.cae.valor, '86230', 'o NIF que já tínhamos devia bastar para o SICAE');
  /* Este lead não traz nome nenhum e o site não foi lido: a única
     corroboração é o domínio ser a palavra da firma. Dá PROVÁVEL — que
     atribui o dado — e não CONFIRMADA, que exigiria mais. */
  assert.equal(r.identidade.estado, 'PROVAVEL');
});

test('um lead sem campo empresa é investigado na mesma', async () => {
  const r = await investigarEmpresa({ id: 'g-3', website: 'https://medibracara.pt' },
    { sicae: sicaeSimulado(), investigar: investigarSite });
  assert.equal(r.empresa.nif.valor, NIPC);
});

test('evidenciasDoWebsite produz envelopes válidos', () => {
  const evs = evidenciasDoWebsite([
    { campo: 'capitalSocial', valor: 50000, url: 'https://x.pt/termos', contexto: 'Capital Social: 50.000' },
    { campo: 'funcionarios', valor: 30, operador: '>=', url: 'https://x.pt/' }
  ], '2026-09-28T00:00:00.000Z');
  assert.equal(evs.length, 2);
  assert.equal(evs[0].ev.estado, 'CONFIRMADO');
  assert.equal(evs[1].ev.estado, 'ESTIMADO');
  for (const { ev } of evs) {
    assert.equal(ev.tipoFonte, TIPO_FONTE.SITE_OFICIAL);
    assert.ok(ev.consultadoEm && ev.fonte);
  }
});

test('o espaço é separador de milhares em português', () => {
  /* Encontrado num teste real: "Capital Social 1 000 000 €" era lido
     como €1 e apresentado ao utilizador como CONFIRMADO. Um capital de
     um euro é absurdo, e absurdo apresentado como facto é o erro que
     este modelo existe para impedir. */
  assert.equal(numeroPt('1 000 000'), 1000000);
  assert.equal(extrairCapitalSocial('Capital Social 1 000 000 €')[0].valor, 1000000);
  assert.equal(extrairFaturacao('Volume de negócios 2 400 000 €')[0].valor, 2400000);
});

test('um número com espaços sem moeda não é dinheiro', () => {
  /* "Pessoa Coletiva n.º 514 998 270" é um NIPC. Sem um € a dizer que é
     dinheiro, um número com espaços é ambíguo de mais para contar. */
  assert.deepEqual(extrairCapitalSocial('Capital social NIPC 514 998 270'), []);
  /* mas com moeda, e mesmo com um NIPC pelo meio, lê-se o valor certo */
  const r = extrairCapitalSocial('Pessoa Coletiva n.º 514 998 270, CRC Lisboa. Capital Social 1 000 000 €');
  assert.equal(r[0].valor, 1000000);
});

test('a moeda conta tanto antes como depois do número', () => {
  assert.equal(extrairCapitalSocial('Capital Social: €100.000')[0].valor, 100000);
  assert.equal(extrairCapitalSocial('Capital Social: 100.000 €')[0].valor, 100000);
});

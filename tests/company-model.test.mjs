/**
 * LeadMap Pro — modelo empresarial e extração de NIF (Fase 1)
 * ===========================================================
 *   node --test tests/company-model.test.mjs
 *
 * Esta fase não integra fornecedor nenhum: valida a fundação. O que se
 * testa aqui é sobretudo o que o sistema se RECUSA a afirmar.
 *
 * O caso que dá forma a tudo: 912345675 passa no dígito de controlo do
 * NIF e é exatamente a forma de um telemóvel português. Um extrator que
 * só validasse o checksum recolheria telefones como se fossem NIFs. Por
 * isso a regra é contexto primeiro, aritmética depois.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CAMPOS, ESTADO_DADO, ESTADOS_VALIDOS, envelope, envelopeVazio, confirmado,
  naoEncontrado, semDadosEmpresa, lerEmpresa, lerCampo, temValor, ehEstimativa,
  respostaConsulta, CompanyProviderError
} from '../providers/company/contract.mjs';
import { nifValido, normalizarNif, ehNipc, extrairNif, htmlParaTexto } from '../providers/company/nif.mjs';
import { CompanyEnrichmentProvider } from '../providers/company/base.mjs';
import { CompanyProviderRouter, COMPANY_PROVIDER_TYPES } from '../providers/company/router.mjs';
import { MockCompanyProvider } from '../providers/company/mock.mjs';
import { WebsiteCompanyProvider } from '../providers/company/website.mjs';
import { construirRouterEmpresarial } from '../providers/company/registry.mjs';

/* NIFs reais, calculados pelo algoritmo — não inventados à mão. */
const NIPC = '501234560';        /* pessoa coletiva */
const NIPC2 = '509876544';
const NIF_PESSOA = '212345672';
const TELEMOVEL = '912345675';   /* checksum válido E forma de telemóvel */
const INVALIDO = '501234561';    /* dígito de controlo errado */

/* ================================================================ *
 * 1 e 2 — validação formal                                          *
 * ================================================================ */

test('1: NIF português válido é aceite', () => {
  assert.equal(nifValido(NIPC), true);
  assert.equal(nifValido(NIPC2), true);
  assert.equal(nifValido(NIF_PESSOA), true);
  assert.equal(nifValido('PT ' + NIPC), true, 'prefixo PT não deve estorvar');
  assert.equal(nifValido('501 234 560'), true, 'espaços de formatação');
  assert.equal(nifValido('501.234.560'), true, 'pontos de formatação');
});

test('2: NIF inválido é recusado', () => {
  assert.equal(nifValido(INVALIDO), false, 'dígito de controlo errado');
  assert.equal(nifValido('412345676'), false, 'prefixo 4 não é atribuível sozinho');
  assert.equal(nifValido('012345679'), false, 'prefixo 0 não existe');
  assert.equal(nifValido('50123456'), false, 'oito dígitos');
  assert.equal(nifValido('5012345600'), false, 'dez dígitos');
  assert.equal(nifValido(''), false);
  assert.equal(nifValido(null), false);
  assert.equal(nifValido(undefined), false);
  assert.equal(nifValido({}), false);
  assert.equal(nifValido('abcdefghi'), false);
});

test('2: prefixos de dois dígitos atribuíveis são aceites', () => {
  assert.equal(nifValido('712345671'), true, '71 é atribuível');
  assert.equal(ehNipc(NIPC), true);
  assert.equal(ehNipc(NIF_PESSOA), false, 'um NIF de pessoa singular não é NIPC');
});

test('normalizarNif devolve só dígitos, ou null', () => {
  assert.equal(normalizarNif('PT501234560'), '501234560');
  assert.equal(normalizarNif('  501-234-560 '), '501234560');
  assert.equal(normalizarNif('50123'), null);
  assert.equal(normalizarNif(null), null);
});

/* ================================================================ *
 * 3 e 4 — o que NÃO pode ser confundido com um NIF                  *
 * ================================================================ */

test('3: telefone de 9 dígitos não é recolhido como NIF', () => {
  /* o número passa no checksum: só o contexto o salva */
  assert.equal(nifValido(TELEMOVEL), true, 'pré-condição: este número passa mesmo no checksum');
  const html = '<p>Telefone: ' + TELEMOVEL + '</p><p>Telemóvel: 961111111</p>';
  const r = extrairNif(html);
  assert.equal(r.encontrado, false, 'recolheu um telefone como NIF');
  assert.equal(r.nif, null);
});

test('3: um telefone rotulado como telefone nunca vira NIF, mesmo ao lado de um NIF', () => {
  const html = '<p>Telefone: ' + TELEMOVEL + '</p><p>NIPC: ' + NIPC + '</p>';
  const r = extrairNif(html);
  assert.equal(r.nif, NIPC, 'escolheu o número errado');
});

test('4: código postal não é confundido com NIF', () => {
  const html = '<address>Rua X, 4700-123 Braga</address><p>1000-001 Lisboa</p>';
  assert.equal(extrairNif(html).encontrado, false);
  /* e não pode colar-se a outro número para formar nove dígitos */
  const colado = '<p>4700-123</p><p>456</p>';
  assert.equal(extrairNif(colado).encontrado, false);
});

test('4: sequências de 9 dígitos sem rótulo nenhum são ignoradas', () => {
  const html = '<p>' + NIPC + '</p><p>Referência 501234560</p>';
  const r = extrairNif(html);
  assert.equal(r.encontrado, false, 'aceitou um número sem rótulo que diga o que é');
});

/* ================================================================ *
 * 5 e 6 — rótulos reconhecidos                                      *
 * ================================================================ */

test('5: NIF com rótulo "NIF" é reconhecido', () => {
  for (const html of [
    '<p>NIF ' + NIPC + '</p>',
    '<p>NIF: ' + NIPC + '</p>',
    '<p>NIF - ' + NIPC + '</p>',
    '<footer>nif: ' + NIPC + '</footer>',
    '<td>NIF</td><td>' + NIPC + '</td>'
  ]) {
    const r = extrairNif(html);
    assert.equal(r.encontrado, true, 'falhou em: ' + html);
    assert.equal(r.nif, NIPC);
  }
});

test('6: NIPC com rótulo "NIPC" é reconhecido', () => {
  const r = extrairNif('<p>NIPC: ' + NIPC + '</p>');
  assert.equal(r.encontrado, true);
  assert.equal(r.nif, NIPC);
  assert.equal(r.rotulo, 'NIPC');
  assert.ok(r.confianca >= 0.9);
});

test('5/6: os restantes rótulos pedidos', () => {
  const casos = [
    ['<p>N.º Contribuinte: ' + NIPC + '</p>', 'N.º Contribuinte'],
    ['<p>Número de Contribuinte ' + NIPC + '</p>', 'Número de Contribuinte'],
    ['<p>Contribuinte n.º ' + NIPC + '</p>', null],
    ['<p>VAT: ' + NIPC + '</p>', null],
    ['<p>VAT Number ' + NIPC + '</p>', null],
    ['<p>VAT PT' + NIPC + '</p>', null],
    ['<p>PT' + NIPC + '</p>', 'VAT PT']
  ];
  for (const [html, rotulo] of casos) {
    const r = extrairNif(html);
    assert.equal(r.encontrado, true, 'não reconheceu: ' + html);
    assert.equal(r.nif, NIPC, 'número errado em: ' + html);
    if (rotulo) assert.equal(r.rotulo, rotulo);
  }
});

test('um NIF com rótulo mas formalmente inválido não é aceite', () => {
  const r = extrairNif('<p>NIPC: ' + INVALIDO + '</p>');
  assert.equal(r.encontrado, false, 'o rótulo não substitui a validação');
});

test('vários NIFs diferentes: em empate não se escolhe nenhum', () => {
  /* mesmo rótulo, mesma contagem: não há como decidir */
  const html = '<p>NIPC: ' + NIPC + '</p><p>NIPC: ' + NIPC2 + '</p>';
  const r = extrairNif(html);
  assert.equal(r.encontrado, false, 'escolheu à sorte entre dois NIFs');
  assert.equal(r.candidatos.length, 2, 'devia reportar os dois candidatos');
});

test('vários NIFs: o mais bem rotulado ganha, mas com menos confiança', () => {
  const html = '<p>NIPC: ' + NIPC + '</p><p>VAT: ' + NIPC2 + '</p>';
  const r = extrairNif(html);
  assert.equal(r.encontrado, true);
  assert.equal(r.nif, NIPC);
  assert.ok(r.confianca < 0.95, 'ter dois NIFs na página tem de baixar a confiança');
});

/* ================================================================ *
 * 7 e 8 — páginas difíceis                                          *
 * ================================================================ */

test('7: página sem NIF nenhum', () => {
  const r = extrairNif('<html><body><h1>Padaria</h1><p>Pão fresco todos os dias.</p></body></html>');
  assert.equal(r.encontrado, false);
  assert.equal(r.nif, null);
  assert.deepEqual(r.candidatos, []);
});

test('8: HTML malformado não rebenta e continua a encontrar', () => {
  for (const html of [
    '<div><p>NIPC: ' + NIPC,                       /* tags por fechar */
    '<<>><p NIF: ' + NIPC + ' </p</div',           /* lixo */
    '<p>NIF:&nbsp;' + NIPC + '</p>',               /* entidade */
    '<script>var x="NIF: 999999999";</script><p>NIPC: ' + NIPC + '</p>'
  ]) {
    const r = extrairNif(html);
    assert.equal(r.nif, NIPC, 'falhou em: ' + html.slice(0, 40));
  }
});

test('8: o conteúdo de <script> é ignorado', () => {
  const r = extrairNif('<script>const nif = "NIPC: ' + NIPC2 + '";</script><p>sem mais nada</p>');
  assert.equal(r.encontrado, false, 'leu um NIF de dentro de um <script>');
});

test('8: entradas que não são texto não rebentam', () => {
  for (const v of [null, undefined, 123, {}, [], '']) {
    const r = extrairNif(v);
    assert.equal(r.encontrado, false);
  }
  assert.equal(htmlParaTexto(null), '');
});

/* ================================================================ *
 * Envelope — ausência nunca é zero                                  *
 * ================================================================ */

test('envelope vazio é NAO_CONSULTADO e não tem valor', () => {
  const e = envelopeVazio();
  assert.equal(e.estado, 'NAO_CONSULTADO');
  assert.equal(e.valor, null);
  assert.equal(temValor(e), false);
});

test('ausência de dados nunca vira zero', () => {
  const emp = semDadosEmpresa();
  for (const c of CAMPOS) {
    assert.equal(emp[c].valor, null, c + ' devia ser null, nunca 0');
    assert.notEqual(emp[c].valor, 0);
    assert.equal(emp[c].estado, 'NAO_CONSULTADO');
  }
});

test('NAO_ENCONTRADO e NAO_CONSULTADO são estados distintos', () => {
  assert.notEqual(naoEncontrado().estado, envelopeVazio().estado);
  assert.equal(naoEncontrado().estado, 'NAO_ENCONTRADO');
  assert.equal(temValor(naoEncontrado()), false);
});

test('um valor sem proveniência é recusado', () => {
  assert.throws(() => envelope({ valor: 30, estado: 'CONFIRMADO' }), /fonte/);
  assert.throws(() => envelope({ valor: 30, fonte: 'x', estado: 'CONFIRMADO' }), /data/);
  assert.throws(() => envelope({ valor: null, fonte: 'x', consultadoEm: 'y', estado: 'CONFIRMADO' }), /exige um valor/);
  assert.throws(() => envelope({ valor: 30, fonte: 'x', consultadoEm: 'y', estado: 'NAO_ENCONTRADO' }), /não pode transportar valor/);
  assert.throws(() => envelope({ estado: 'INVENTADO' }), /Estado inválido/);
  assert.throws(() => envelope({ valor: 1, fonte: 'x', consultadoEm: 'y', confianca: 2, estado: 'CONFIRMADO' }), /entre 0 e 1/);
});

test('estimativa é distinguível de facto', () => {
  const est = envelope({ valor: 1000000, fonte: 'p', consultadoEm: 'd', confianca: 0.5, estado: ESTADO_DADO.ESTIMADO });
  const conf = confirmado({ valor: 50000, fonte: 'p', consultadoEm: 'd' });
  assert.equal(ehEstimativa(est), true);
  assert.equal(ehEstimativa(conf), false);
  assert.equal(temValor(est), true, 'uma estimativa tem valor — só não é facto');
});

/* ================================================================ *
 * 10 — snapshots antigos                                            *
 * ================================================================ */

test('10: lead sem campo empresa lê-se como "por consultar"', () => {
  const antigo = { id: 'google-x', nome: 'Padaria Antiga' };
  const e = lerEmpresa(antigo);
  for (const c of CAMPOS) {
    assert.equal(e[c].estado, 'NAO_CONSULTADO');
    assert.equal(e[c].valor, null);
  }
});

test('10: empresa com forma estranha degrada em vez de rebentar', () => {
  for (const v of [null, undefined, 'texto', 42, []]) {
    const e = lerEmpresa({ id: 'x', empresa: v });
    assert.equal(e.nif.estado, 'NAO_CONSULTADO');
  }
});

test('10: envelope incoerente é tratado como ausente, não mostrado', () => {
  const l = { empresa: { nif: { valor: null, estado: 'CONFIRMADO' } } };
  assert.equal(lerEmpresa(l).nif.estado, 'NAO_CONSULTADO', 'um CONFIRMADO sem valor não pode passar');
  const l2 = { empresa: { nif: { valor: '1', estado: 'ESTADO_QUE_NAO_EXISTE' } } };
  assert.equal(lerEmpresa(l2).nif.estado, 'NAO_CONSULTADO');
});

test('10: um envelope válido sobrevive à leitura', () => {
  const l = { empresa: { nif: confirmado({ valor: NIPC, fonte: 'https://x.pt', consultadoEm: '2026-09-28T00:00:00.000Z', confianca: 0.9 }) } };
  const e = lerEmpresa(l);
  assert.equal(e.nif.valor, NIPC);
  assert.equal(e.nif.fonte, 'https://x.pt');
  assert.equal(e.nif.estado, 'CONFIRMADO');
  assert.equal(e.cae.estado, 'NAO_CONSULTADO', 'os outros campos não são inventados');
});

test('lerCampo recusa um campo que não existe', () => {
  assert.throws(() => lerCampo({}, 'lucro'), /Campo empresarial desconhecido/);
});

/* ================================================================ *
 * 9 e 11 — fornecedores                                             *
 * ================================================================ */

test('9: empresa sem website fica POR CONSULTAR, não "não encontrado"', async () => {
  const p = new WebsiteCompanyProvider();
  const r = await p.consultar({ dominio: 'exemplo.pt', html: null });
  assert.equal(r.success, true);
  assert.equal(r.empresa.nif.estado, 'NAO_CONSULTADO', 'sem página lida ninguém procurou');
});

test('9: página lida sem NIF dá NAO_ENCONTRADO', async () => {
  const p = new WebsiteCompanyProvider();
  const r = await p.consultar({ dominio: 'x.pt', html: '<p>Sem nada</p>', url: 'https://x.pt' });
  assert.equal(r.empresa.nif.estado, 'NAO_ENCONTRADO');
  assert.equal(r.empresa.nif.valor, null);
});

test('9: página com NIF dá CONFIRMADO com fonte e data', async () => {
  const p = new WebsiteCompanyProvider();
  const r = await p.consultar({ dominio: 'x.pt', html: '<p>NIPC: ' + NIPC + '</p>', url: 'https://x.pt' });
  const e = r.empresa.nif;
  assert.equal(e.estado, 'CONFIRMADO');
  assert.equal(e.valor, NIPC);
  assert.equal(e.fonte, 'https://x.pt');
  assert.ok(e.consultadoEm, 'tem de trazer data');
  assert.ok(e.confianca > 0 && e.confianca <= 1);
  /* os campos que este fornecedor não sabe responder ficam por consultar */
  assert.equal(r.empresa.faturacaoAnual.estado, 'NAO_CONSULTADO');
  assert.equal(r.empresa.capitalSocial.estado, 'NAO_CONSULTADO');
});

test('11: MockCompanyProvider devolve o que lhe deram, em envelopes válidos', async () => {
  const mock = new MockCompanyProvider({
    dados: { [NIPC]: { funcionarios: { valor: 42 }, capitalSocial: { valor: 50000, estado: 'ESTIMADO', confianca: 0.4 } } }
  });
  const r = await mock.consultar({ nif: NIPC });
  assert.equal(r.success, true);
  assert.equal(r.provider, 'mock');
  assert.equal(r.empresa.funcionarios.valor, 42);
  assert.equal(r.empresa.funcionarios.estado, 'CONFIRMADO');
  assert.equal(r.empresa.capitalSocial.estado, 'ESTIMADO');
  assert.equal(ehEstimativa(r.empresa.capitalSocial), true);
  assert.equal(mock.chamadas.length, 1);
});

test('11: mock sem correspondência não inventa dados', async () => {
  const mock = new MockCompanyProvider({ dados: {} });
  const r = await mock.consultar({ nif: NIPC });
  for (const c of CAMPOS) assert.equal(r.empresa[c].valor, null);
});

test('11: mock não configurado recusa antes de consultar', async () => {
  const mock = new MockCompanyProvider({ configurado: false });
  await assert.rejects(() => mock.consultar({ nif: NIPC }), /não está configurado/);
  assert.equal(mock.chamadas.length, 0, 'não podia ter chegado a consultar');
});

test('consultar sem chave nenhuma falha explicitamente', async () => {
  const mock = new MockCompanyProvider({});
  await assert.rejects(() => mock.consultar({}), e => e.errorCode === 'NO_LOOKUP_KEY');
});

test('um adapter que devolva um número solto é recusado pelo contrato', () => {
  assert.throws(
    () => respostaConsulta({ success: true, empresa: { funcionarios: { valor: 30, estado: 'CONFIRMADO' } } }),
    /fonte/);
});

test('um adapter que devolva texto num campo numérico é recusado', () => {
  assert.throws(
    () => respostaConsulta({ success: true, empresa: {
      funcionarios: { valor: 'muitos', fonte: 'x', consultadoEm: 'd', estado: 'CONFIRMADO' } } }),
    /numérico/);
});

test('a classe base recusa campos que não existem', () => {
  assert.throws(() => new CompanyEnrichmentProvider({ id: 'x', campos: ['lucro'] }), /Campos desconhecidos/);
  assert.throws(() => new CompanyEnrichmentProvider({}), /tem de ter id/);
});

/* ================================================================ *
 * 12 e 13 — router                                                  *
 * ================================================================ */

test('12: provider desconhecido falha explicitamente', () => {
  const r = new CompanyProviderRouter({ providers: { website: new WebsiteCompanyProvider() } });
  assert.throws(() => r.porId('informa'), e => e.errorCode === 'INVALID_REQUEST' && /desconhecido/.test(e.message));
  assert.throws(() => r.porId(''), /Falta o fornecedor/);
  assert.throws(() => r.porId(null), /Falta o fornecedor/);
});

test('12: registar um id fora da lista fechada é recusado na construção', () => {
  assert.throws(
    () => new CompanyProviderRouter({ providers: { informa: new MockCompanyProvider({}) } }),
    /desconhecido no registo/);
});

test('12: provider conhecido mas não registado dá PROVIDER_NOT_CONFIGURED', () => {
  const r = new CompanyProviderRouter({ providers: { website: new WebsiteCompanyProvider() } });
  assert.throws(() => r.porId('mock'), e => e.errorCode === 'PROVIDER_NOT_CONFIGURED');
});

test('13: nenhum fallback silencioso entre fornecedores', async () => {
  class Rebenta extends MockCompanyProvider {
    async _consultar() { throw new CompanyProviderError('PROVIDER_UNAVAILABLE', 'caiu'); }
  }
  const website = new WebsiteCompanyProvider();
  const r = new CompanyProviderRouter({ providers: { mock: new Rebenta({}), website } });
  await assert.rejects(() => r.consultar('mock', { nif: NIPC }), e => e.errorCode === 'PROVIDER_UNAVAILABLE');
  /* o router NÃO tentou o website por conta própria */
  assert.equal(r.listar().length, 2, 'o website continua registado, apenas não foi usado sozinho');
});

test('13: o router não escolhe fornecedor por omissão', () => {
  const codigo = readFileSync(new URL('../providers/company/router.mjs', import.meta.url), 'utf8');
  assert.equal(/catch[\s\S]{0,200}consultar\(/.test(codigo), false, 'há um retry escondido no router');
  assert.ok(/COMPANY_PROVIDER_TYPES\.includes/.test(codigo), 'a lista fechada tem de ser verificada');
});

test('paraCampo só devolve quem sabe responder e está configurado', () => {
  const r = new CompanyProviderRouter({
    providers: { website: new WebsiteCompanyProvider(), mock: new MockCompanyProvider({ configurado: false }) }
  });
  assert.deepEqual(r.paraCampo('nif').map(p => p.id), ['website']);
  assert.deepEqual(r.paraCampo('faturacaoAnual').map(p => p.id), [], 'ninguém responde faturação nesta fase');
});

/* ================================================================ *
 * Registry                                                          *
 * ================================================================ */

test('o registry traz o website e, fora de produção, aceita o mock', () => {
  const dev = construirRouterEmpresarial({ OUTREACH_ENV: 'development' }, { comMock: true });
  assert.ok(dev.tem('website'));
  assert.ok(dev.tem('mock'));
});

test('em produção o mock NUNCA é registado', () => {
  const prod = construirRouterEmpresarial({ OUTREACH_ENV: 'production' }, { comMock: true });
  assert.equal(prod.tem('mock'), false, 'dados inventados não podem chegar a produção');
  assert.equal(prod.tem('website'), true);
});

test('nenhum fornecedor comercial está ligado nesta fase', () => {
  assert.deepEqual([...COMPANY_PROVIDER_TYPES], ['website', 'mock']);
});

/* ================================================================ *
 * O modelo do ecrã não pode divergir do contrato                    *
 * ================================================================ */

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('o modelo do index.html não diverge do contrato', () => {
  /* a forma vazia está duplicada de propósito — o bloco clássico não faz
     import — por isso um teste segura as duas juntas */
  const m = HTML.match(/const CAMPOS_EMPRESA = \[([^\]]+)\]/);
  assert.ok(m, 'CAMPOS_EMPRESA não encontrado no index.html');
  const doEcra = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(doEcra, [...CAMPOS], 'os campos do ecrã divergiram do contrato');

  const e = HTML.match(/const ESTADOS_EMPRESA = \[([^\]]+)\]/);
  assert.ok(e, 'ESTADOS_EMPRESA não encontrado');
  const estados = e[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(estados.sort(), [...ESTADOS_VALIDOS].sort(), 'os estados do ecrã divergiram');
});

test('cleanLead cria o campo empresa por consultar', () => {
  assert.ok(/empresa: semDadosEmpresa\(\)/.test(HTML), 'cleanLead não cria o campo empresa');
  const corpo = HTML.slice(HTML.indexOf('function semDadosEmpresa'), HTML.indexOf('function getEmpresa'));
  assert.ok(/NAO_CONSULTADO/.test(HTML.slice(HTML.indexOf('function envelopeEmpresaVazio'), HTML.indexOf('function semDadosEmpresa'))),
    'o envelope vazio do ecrã tem de nascer NAO_CONSULTADO');
  assert.ok(/for \(const c of CAMPOS_EMPRESA\)/.test(corpo));
});

test('o ecrã nunca diz "Não encontrado" sobre algo por consultar', () => {
  const corpo = HTML.slice(HTML.indexOf('function rotuloEmpresa'), HTML.indexOf('function rotuloEmpresa') + 500);
  assert.ok(/NAO_CONSULTADO'\) return 'Por consultar'/.test(corpo), 'NAO_CONSULTADO tem de ler "Por consultar"');
  assert.ok(/NAO_ENCONTRADO'\) return 'Não encontrado'/.test(corpo));
  assert.ok(/ESTIMADO'\) return 'Estimativa'/.test(corpo), 'uma estimativa tem de se anunciar como tal');
});

test('aplicarNifDaPagina distingue os três desfechos', () => {
  const i = HTML.indexOf('function aplicarNifDaPagina');
  assert.ok(i > 0, 'aplicarNifDaPagina não encontrado');
  const corpo = HTML.slice(i, HTML.indexOf('function applyEmails', i));
  assert.ok(/paginaLida === true/.test(corpo), 'sem paginaLida não se pode afirmar "não encontrado"');
  assert.ok(/NAO_ENCONTRADO/.test(corpo));
  assert.ok(/envelopeEmpresaVazio\(\)/.test(corpo), 'o caso "não consultado" tem de existir');
  assert.ok(/CONFIRMADO/.test(corpo));
});

/* ================================================================ *
 * O enriquecimento não faz pedidos a mais                           *
 * ================================================================ */

test('o NIF vem do mesmo pedido dos emails — zero pedidos adicionais', () => {
  const corpo = HTML.slice(HTML.indexOf('async function enrichLeadEmail'), HTML.indexOf('function pumpEmailQueue'));
  const pedidos = (corpo.match(/fetchWithTimeout\(/g) || []).length;
  assert.equal(pedidos, 1, 'o enriquecimento passou a fazer mais do que um pedido por lead');
  assert.ok(/json\.nif/.test(corpo), 'o NIF devia vir na mesma resposta');
});

test('a função de servidor lê o NIF do HTML que já tinha, sem novo fetch', () => {
  const src = readFileSync(new URL('../api/enrich/email.mjs', import.meta.url), 'utf8');
  const handler = src.slice(src.indexOf('export default async function handler'));
  assert.equal((handler.match(/lerPagina\(/g) || []).length, 1, 'passou a descarregar mais do que uma vez');
  assert.ok(/extrairNif\(html\)/.test(handler), 'devia analisar o HTML já obtido');
  /* as guardas existentes continuam lá */
  assert.ok(/websiteSeguro\(/.test(handler));
});

test('4 (segurança): as proteções existentes continuam todas no sítio', () => {
  const src = readFileSync(new URL('../api/enrich/email.mjs', import.meta.url), 'utf8');
  for (const guarda of ['TIMEOUT_MS', 'MAX_URL_LEN', 'MAX_HTML_BYTES', 'AbortController', 'websiteSeguro']) {
    assert.ok(src.includes(guarda), 'proteção removida: ' + guarda);
  }
  /* SSRF: redes privadas continuam bloqueadas */
  assert.ok(/127\.|localhost|192\.168/.test(src), 'a guarda de SSRF desapareceu');
});

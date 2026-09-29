/**
 * LeadMap Pro — identidade empresarial
 * ====================================
 *   node --test tests/company-identidade.test.mjs
 *
 * O CASO QUE ESTES TESTES EXISTEM PARA IMPEDIR
 * --------------------------------------------
 * Uma clínica dentária em Odivelas tem na página de termos "NIPC
 * 501135227, com sede na … Colinas do Cruzeiro". O número é válido, tem
 * prefixo de pessoa coletiva e rótulo legal. Só que é o NIPC da J. J.
 * LOURO PEREIRA, S.A., cujo CAE principal é 31004 — mobiliário. A página
 * foi feita a partir de um modelo e ficou com o NIPC de outra empresa.
 *
 * O registo respondeu bem. A pergunta estava errada. E o LeadMap
 * atribuiu o CAE de um fabricante de móveis a uma clínica.
 *
 * O que se testa aqui é a distinção que faltava:
 *
 *   NIF_VALIDO   ≠   NIF_PERTENCE_A_ESTA_EMPRESA
 *
 * E a regra que dela decorre: entre não saber e atribuir os dados da
 * empresa errada, preferimos não saber.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  IDENTIDADE, IDENTIDADES_VALIDAS, SINAL, IDENTIDADE_ROTULO,
  normalizarNome, tokensDistintivos, rotuloDominio, semAcentos,
  identidadeVazia, lerIdentidade, avaliarIdentidade, recortarTrecho,
  identidadeSuficiente, identidadeProvaEstrito, identidadeAlerta
} from '../providers/company/identidade.mjs';
import { avaliarEmpresa, MODO, STATUS_CRITERIO, dependeDeIdentidade,
         identidadeChegaPara } from '../providers/company/filters.mjs';
import { TIPO_FONTE, semDadosEmpresa, lerEmpresa,
         respostaConsulta } from '../providers/company/contract.mjs';
import { investigarEmpresa, investigarLote } from '../providers/company/open-intelligence.mjs';
import { investigarWebsite } from '../providers/company/website-deep.mjs';
import { SicaeProvider } from '../providers/company/sicae.mjs';

/* ---------------------------------------------------------------- *
 * Fábricas                                                          *
 * ---------------------------------------------------------------- */

const NIPC = '508459451';                 /* MEDIBRACARA - CENTRO MÉDICO LDA */
const NIPC_ERRADO = '501135227';          /* J. J. LOURO PEREIRA, S.A. */

const id = (over = {}) => avaliarIdentidade({ nif: NIPC, rotuloNif: 'NIPC', ...over });

const SICAE_FORM = '<input id="__VIEWSTATE" value="vs" /><input id="__EVENTVALIDATION" value="ev" />';
const sicaeHtml = (nipc, firma, cae, sec = '') =>
  `<table><tr><td>NIPC</td><td>Firma</td><td>CAE</td></tr>
   <tr><td>${nipc}</td><td>${firma}</td><td>${cae}</td><td>${sec}</td></tr></table>`;

function sicaeSimulado({ nipc = NIPC, firma = 'MEDIBRACARA - CENTRO MÉDICO LDA',
                         cae = '86230', sec = '', falha = false } = {}) {
  return new SicaeProvider({
    fetchPagina: async (u, o) => falha ? null
      : { texto: (o && o.metodo === 'POST') ? sicaeHtml(nipc, firma, cae, sec) : SICAE_FORM,
          url: String(u), cookies: null }
  });
}

const site = (paginas) => async (u) => paginas[u] ? { texto: paginas[u], url: u } : null;
const investigarCom = (paginas) => (w) => investigarWebsite(w, { fetchPagina: site(paginas) });

/* ================================================================ *
 * 1 a 5 — normalização de nomes                                     *
 * ================================================================ */

test('1: nome comercial praticamente igual à firma corresponde', () => {
  const r = id({ nomeLead: 'Medibracara Centro Médico',
                 firmaOficial: 'MEDIBRACARA - CENTRO MÉDICO LDA' });
  assert.equal(r.estado, IDENTIDADE.CONFIRMADA);
  assert.ok(r.sinais.some(s => s.sinal === SINAL.NOME_EXATO),
    'normalizadas, as duas são a mesma string');
});

test('2: o sufixo LDA não impede a correspondência', () => {
  assert.equal(normalizarNome('CLÍNICA DENTÁRIA CANIÇO, LDA'), 'clinica dentaria canico');
  assert.equal(normalizarNome('Clínica Dentária Caniço Lda.'), 'clinica dentaria canico');
  const r = id({ nomeLead: 'Clínica Dentária Caniço', firmaOficial: 'CLÍNICA DENTÁRIA CANIÇO, LDA' });
  assert.equal(r.estado, IDENTIDADE.CONFIRMADA);
});

test('3: UNIPESSOAL LDA e variantes também saem', () => {
  for (const f of ['XPTO UNIPESSOAL LDA', 'XPTO, Sociedade Unipessoal, Lda.',
                   'XPTO UNIPESSOAL POR QUOTAS', 'XPTO, S.A.', 'XPTO LIMITADA']) {
    assert.equal(normalizarNome(f), 'xpto', f + ' → ' + normalizarNome(f));
  }
});

test('4: acentos não separam o que é igual', () => {
  assert.equal(semAcentos('Açúcar Conceição Évora'), 'Acucar Conceicao Evora');
  assert.equal(normalizarNome('MEDIBRACARA'), normalizarNome('Medibrácara'));
});

test('5: hífens, pontos e & não separam o que é igual', () => {
  assert.equal(normalizarNome('A-B-C, Lda'), 'a b c');
  assert.equal(normalizarNome('J. J. LOURO PEREIRA, S.A.'), 'j j louro pereira');
  assert.equal(normalizarNome('Silva & Filhos'), 'silva e filhos');
});

/* ================================================================ *
 * 6 a 8 — tokens distintivos e genéricos                            *
 * ================================================================ */

test('6: nome comercial diferente mas com token distintivo igual corresponde', () => {
  /* "Forte CMD" vs "JOÃO FORTE - MEDICINA DENTÁRIA, LDA": só "forte" em
     comum, e é o suficiente para não descartar a empresa */
  const r = id({ nomeLead: 'Forte CMD', dominio: 'https://fortecmd.net',
                 firmaOficial: 'JOÃO FORTE - MEDICINA DENTÁRIA, LDA' });
  assert.ok(r.sinais.some(s => s.sinal === SINAL.TOKEN_DISTINTIVO));
  assert.ok([IDENTIDADE.CONFIRMADA, IDENTIDADE.PROVAVEL].includes(r.estado), r.estado);
});

test('7: palavras genéricas não bastam para corresponder', () => {
  /* Este é o falso positivo que não queremos: duas clínicas em Lisboa
     sem nada a ver uma com a outra partilham "clinica" e "lisboa". */
  assert.deepEqual(tokensDistintivos('Clínica Lisboa'), []);
  assert.deepEqual(tokensDistintivos('Centro Médico Portugal'), []);
  const r = id({ nomeLead: 'Clínica Lisboa', dominio: 'https://clinicalisboa.pt',
                 firmaOficial: 'CENTRO MÉDICO DE LISBOA, LDA' });
  assert.equal(r.sinais.some(s => s.sinal === SINAL.TOKEN_DISTINTIVO), false,
    '"clinica" e "lisboa" não identificam ninguém');
  assert.notEqual(r.estado, IDENTIDADE.CONFIRMADA);
});

test('7: "medibracara" distingue, "centro médico" não', () => {
  assert.deepEqual(tokensDistintivos('MEDIBRACARA - CENTRO MÉDICO LDA'), ['medibracara']);
});

test('8: NIF válido com firma incompatível não é a mesma empresa', () => {
  /* o caso real, com o site lido e sem a firma em sítio nenhum */
  const r = avaliarIdentidade({
    nomeLead: 'Clínica Onda de Sorrisos', dominio: 'https://ondadesorrisos.com',
    nif: NIPC_ERRADO, rotuloNif: 'NIPC', firmaOficial: 'J. J. LOURO PEREIRA, S.A.',
    trecho: 'NIPC 501135227, com sede na rua praça cidade Odivelas',
    corpusSite: 'Clínica Onda de Sorrisos implantes ortodontia marcações Odivelas'
  });
  assert.equal(r.estado, IDENTIDADE.CONFLITO);
  assert.ok(r.sinais.some(s => s.sinal === SINAL.NOME_INCOMPATIVEL));
  assert.ok(r.conflitos[0].includes('J. J. LOURO PEREIRA'), 'o conflito tem de nomear a firma');
  assert.equal(identidadeSuficiente(r), false);
});

test('8: a firma diferente da marca NÃO é, por si, incompatível', () => {
  /* Em Portugal a firma quase nunca é a marca. Se o próprio site nomeia a
     firma, é a mesma empresa — e é isto que separa "Oral Plus" de
     "Onda de Sorrisos", que ao nome são indistinguíveis. */
  const r = avaliarIdentidade({
    nomeLead: 'Oral Plus', dominio: 'https://oralplus.pt', nif: NIPC, rotuloNif: 'NIPC',
    firmaOficial: 'CLÍNICA DE ESTOMATOLOGIA DR. JÚLIO MENDES, LDA',
    corpusSite: 'Oral Plus é a marca da Clínica de Estomatologia Dr. Júlio Mendes, Lda'
  });
  assert.ok(r.sinais.some(s => s.sinal === SINAL.FIRMA_NO_SITE));
  assert.notEqual(r.estado, IDENTIDADE.CONFLITO);
  assert.equal(identidadeSuficiente(r), true);
});

test('8: firma só com palavras genéricas dá inconclusiva, não conflito', () => {
  const r = avaliarIdentidade({
    nomeLead: 'Oral Plus', nif: NIPC, rotuloNif: 'NIPC',
    firmaOficial: 'CLÍNICA DE MEDICINA DENTÁRIA, LDA',
    corpusSite: 'Oral Plus implantes'
  });
  assert.equal(r.estado, IDENTIDADE.INCONCLUSIVA,
    'ausência de sinal não é sinal negativo');
  assert.equal(r.sinais.some(s => s.sinal === SINAL.NOME_INCOMPATIVEL), false);
});

/* ================================================================ *
 * 9, 14 — terceiros                                                 *
 * ================================================================ */

test('9/14: NIF junto a marca de terceiro é rejeitado', () => {
  for (const t of ['Website desenvolvido por Agência XPTO, NIPC 508459451',
                   'Powered by Loja Online Lda — NIPC 508459451',
                   'Fornecedor de pagamentos: NIPC 508459451',
                   'Livro de reclamações — entidade gestora NIPC 508459451']) {
    const r = id({ nomeLead: 'Clínica Sorriso', trecho: t,
                   firmaOficial: 'AGÊNCIA XPTO, LDA' });
    assert.equal(r.estado, IDENTIDADE.REJEITADA, t);
    assert.ok(r.sinais.some(s => s.sinal === SINAL.TERCEIRO_EXPLICITO));
    assert.equal(identidadeSuficiente(r), false);
  }
});

test('9: rejeitada decide sozinha, mesmo com o nome a bater', () => {
  const r = id({ nomeLead: 'Medibracara', dominio: 'https://medibracara.pt',
                 firmaOficial: 'MEDIBRACARA - CENTRO MÉDICO LDA',
                 trecho: 'site desenvolvido por Medibracara Web, NIPC 508459451' });
  assert.equal(r.estado, IDENTIDADE.REJEITADA);
  assert.equal(r.confianca, 0);
});

/* ================================================================ *
 * 10 — múltiplos NIFs                                               *
 * ================================================================ */

test('10: vários NIFs na página baixam a confiança e ficam registados', () => {
  const r = id({ nomeLead: 'Medibracara', firmaOficial: 'MEDIBRACARA - CENTRO MÉDICO LDA',
                 candidatos: [{ nif: NIPC, rotulo: 'NIPC', ocorrencias: 2 },
                              { nif: '501135227', rotulo: 'NIF', ocorrencias: 1 },
                              { nif: '514998270', rotulo: 'NIF', ocorrencias: 1 }] });
  assert.ok(r.sinais.some(s => s.sinal === SINAL.MULTIPLOS_CANDIDATOS));
  assert.equal(r.candidatos.length, 3, 'os candidatos ficam guardados para auditoria');
  assert.ok(r.conflitos.some(c => c.includes('3 NIFs')));
});

test('10: empate entre NIFs não escolhe nenhum', async () => {
  /* dois NIFs com o mesmo rótulo e a mesma contagem: a extração devolve
     os candidatos e não escolhe — e sem NIF não há SICAE */
  const r = await investigarEmpresa(
    { id: 'x', nome: 'Alfa', website: 'https://alfa.pt' },
    { sicae: sicaeSimulado(),
      investigar: investigarCom({ 'https://alfa.pt/': '<p>NIF: 508459451 e NIF: 501135227</p>' }) });
  assert.equal(r.empresa.nif.valor, null, 'não se escolhe à sorte entre dois NIFs');
  assert.equal(r.identidade.estado, IDENTIDADE.NAO_VERIFICADA);
});

/* ================================================================ *
 * 11, 12, 13 — onde o NIF foi encontrado                            *
 * ================================================================ */

test('11/12/13: rodapé legal, termos e privacidade contam como contexto legal', () => {
  const casos = [
    ['rodapé com sede', 'Medibracara Lda, com sede em Braga, NIPC 508459451'],
    ['termos', 'Nos termos e condições: NIPC 508459451'],
    ['capital social', 'Capital social 50.000 € · NIPC 508459451']
  ];
  for (const [nome, trecho] of casos) {
    const r = id({ nomeLead: 'Medibracara', firmaOficial: 'MEDIBRACARA - CENTRO MÉDICO LDA', trecho });
    assert.ok(r.sinais.some(s => s.sinal === SINAL.CONTEXTO_LEGAL), nome);
  }
});

test('13: a URL da página legal também conta', () => {
  const r = id({ nomeLead: 'Medibracara', firmaOficial: 'MEDIBRACARA - CENTRO MÉDICO LDA',
                 urlNif: 'https://medibracara.pt/politica-de-privacidade' });
  assert.ok(r.sinais.some(s => s.sinal === SINAL.CONTEXTO_LEGAL));
});

test('11: um NIF sem rótulo legal não ganha o sinal contextual', () => {
  const r = avaliarIdentidade({ nomeLead: 'Medibracara', nif: NIPC, rotuloNif: 'VAT',
                                firmaOficial: 'MEDIBRACARA - CENTRO MÉDICO LDA' });
  assert.equal(r.sinais.some(s => s.sinal === SINAL.NIF_CONTEXTUAL), false);
});

test('o trecho guardado é curto — audita-se, não se arquiva a página', () => {
  const t = recortarTrecho('x'.repeat(4000) + NIPC + 'y'.repeat(4000), NIPC);
  assert.ok(t.length <= 240, 'trecho de ' + t.length + ' caracteres');
  assert.ok(t.includes(NIPC));
});

/* ================================================================ *
 * 15, 16 — fontes em baixo                                          *
 * ================================================================ */

test('15: SICAE indisponível não afirma identidade nenhuma', async () => {
  const r = await investigarEmpresa(
    { id: 'x', nome: 'Medibracara', website: 'https://medibracara.pt' },
    { sicae: sicaeSimulado({ falha: true }),
      investigar: investigarCom({ 'https://medibracara.pt/': '<p>NIPC: ' + NIPC + '</p>' }) });
  assert.equal(r.identidade.estado, IDENTIDADE.INCONCLUSIVA);
  assert.ok(r.identidade.sinais.some(s => s.sinal === SINAL.FIRMA_DESCONHECIDA));
  assert.equal(r.empresa.cae.estado, 'NAO_CONSULTADO', 'o SICAE não respondeu');
});

test('15: sem firma não se conclui que a identidade está certa', () => {
  const r = id({ nomeLead: 'Medibracara', dominio: 'https://medibracara.pt', firmaOficial: null });
  assert.equal(r.estado, IDENTIDADE.INCONCLUSIVA,
    'nada a contradizer não é o mesmo que confirmação');
  assert.equal(identidadeSuficiente(r), false);
});

test('16: website indisponível deixa tudo por verificar', async () => {
  const r = await investigarEmpresa(
    { id: 'x', nome: 'Medibracara', website: 'https://medibracara.pt' },
    { sicae: sicaeSimulado(), investigar: async () => { throw new Error('caiu'); } });
  assert.equal(r.identidade.estado, IDENTIDADE.NAO_VERIFICADA);
  assert.equal(r.empresa.cae.estado, 'NAO_CONSULTADO');
});

test('16: um lead sem website nunca ganha identidade', async () => {
  const r = await investigarEmpresa({ id: 'x', nome: 'Sem Site', website: 'N/D' },
    { sicae: sicaeSimulado(), investigar: investigarCom({}) });
  assert.equal(r.identidade.estado, IDENTIDADE.NAO_VERIFICADA);
});

/* ================================================================ *
 * 17, 18, 19 — o efeito nos dados derivados                         *
 * ================================================================ */

test('17: identidade confirmada → o CAE do registo é atribuído', async () => {
  const r = await investigarEmpresa(
    { id: 'x', nome: 'Medibracara', website: 'https://medibracara.pt' },
    { sicae: sicaeSimulado(),
      investigar: investigarCom({ 'https://medibracara.pt/': '<p>Medibracara — NIPC: ' + NIPC + '</p>' }) });
  assert.ok(identidadeSuficiente(r.identidade), r.identidade.estado);
  assert.equal(r.empresa.cae.valor, '86230');
  assert.equal(r.empresa.cae.estado, 'CONFIRMADO');
  assert.equal(r.empresa.cae.dependeDe.nif, NIPC, 'fica escrito de que NIF o CAE depende');
  assert.equal(r.identidade.derivadosNaoAtribuidos.length, 0);
});

test('19: identidade em conflito → o CAE não é atribuído, mas guarda-se', async () => {
  /* o caso real, ponta a ponta */
  const r = await investigarEmpresa(
    { id: 'x', nome: 'Clínica Onda de Sorrisos', website: 'https://ondadesorrisos.com' },
    { sicae: sicaeSimulado({ nipc: NIPC_ERRADO, firma: 'J. J. LOURO PEREIRA, S.A.', cae: '31004' }),
      investigar: investigarCom({ 'https://ondadesorrisos.com/':
        '<p>Clínica Onda de Sorrisos — implantes</p><footer>NIPC ' + NIPC_ERRADO + ', com sede em Odivelas</footer>' }) });
  assert.equal(r.identidade.estado, IDENTIDADE.CONFLITO);
  assert.equal(r.empresa.cae.valor, null, 'o CAE 31004 não pode virar o CAE da clínica');
  assert.equal(r.empresa.cae.estado, 'NAO_ENCONTRADO',
    'consultou-se: dizer NAO_CONSULTADO seria falso');
  const bloq = r.identidade.derivadosNaoAtribuidos;
  assert.equal(bloq.length, 1);
  assert.equal(bloq[0].campo, 'cae');
  assert.equal(bloq[0].valor, '31004', 'a resposta do registo preserva-se');
  assert.equal(bloq[0].motivo, IDENTIDADE.CONFLITO);
  assert.ok(bloq[0].url, 'com a URL, para se poder confirmar à mão');
  /* e o NIF encontrado não se apaga: é um facto sobre o site */
  assert.equal(r.empresa.nif.valor, NIPC_ERRADO);
});

test('18: inconclusiva não qualifica em ESTRITO e fica desconhecida em INTELIGENTE', () => {
  const emp = comCaeDoRegisto(IDENTIDADE.INCONCLUSIVA);
  const estrito = avaliarEmpresa(emp, { caeQuery: '86230', modoCorrespondencia: MODO.ESTRITO });
  assert.equal(estrito.status.cae, STATUS_CRITERIO.DESCONHECIDO);
  assert.equal(estrito.passa, false);
  const inteligente = avaliarEmpresa(emp, { caeQuery: '86230', modoCorrespondencia: MODO.INTELIGENTE });
  assert.equal(inteligente.status.cae, STATUS_CRITERIO.DESCONHECIDO);
  assert.equal(inteligente.passa, true, 'desconhecido não exclui em modo inteligente');
});

test('19: conflito não qualifica — nem a favor nem contra', () => {
  const emp = comCaeDoRegisto(IDENTIDADE.CONFLITO);
  /* procurar um CAE que o valor NÃO tem: nem isso se pode afirmar */
  const a = avaliarEmpresa(emp, { caeQuery: '41200', modoCorrespondencia: MODO.INTELIGENTE });
  assert.equal(a.status.cae, STATUS_CRITERIO.DESCONHECIDO,
    'um dado que não é desta empresa não prova nada sobre ela');
});

function comCaeDoRegisto(estado) {
  return {
    ...semDadosEmpresa(),
    cae: { valor: '86230', fonte: 'SICAE', consultadoEm: '2026-09-29T00:00:00.000Z',
           confianca: 0.9, estado: 'CONFIRMADO',
           evidencias: [{ valor: '86230', fonte: 'SICAE', tipoFonte: TIPO_FONTE.FONTE_OFICIAL,
                          confianca: 0.9, estado: 'CONFIRMADO' }],
           dependeDe: { nif: NIPC, identidade: estado } },
    identidade: { ...identidadeVazia(), estado, nif: NIPC }
  };
}

/* ================================================================ *
 * Os três modos (§20)                                               *
 * ================================================================ */

test('os três modos, para os seis estados de identidade', () => {
  const esperado = {
    CONFIRMADA:     ['CUMPRE', 'CUMPRE', 'CUMPRE'],
    PROVAVEL:       ['DESCONHECIDO', 'CUMPRE', 'CUMPRE'],
    INCONCLUSIVA:   ['DESCONHECIDO', 'DESCONHECIDO', 'CUMPRE'],
    CONFLITO:       ['DESCONHECIDO', 'DESCONHECIDO', 'CUMPRE'],
    REJEITADA:      ['DESCONHECIDO', 'DESCONHECIDO', 'CUMPRE'],
    NAO_VERIFICADA: ['DESCONHECIDO', 'DESCONHECIDO', 'CUMPRE']
  };
  for (const estado of IDENTIDADES_VALIDAS) {
    const emp = comCaeDoRegisto(estado);
    const obtido = [MODO.ESTRITO, MODO.INTELIGENTE, MODO.EXPLORATORIO].map(m =>
      avaliarEmpresa(emp, { caeQuery: '86230', modoCorrespondencia: m }).status.cae);
    assert.deepEqual(obtido, esperado[estado], estado);
  }
});

test('EXPLORATORIO nunca exclui ninguém por identidade', () => {
  for (const estado of IDENTIDADES_VALIDAS) {
    const a = avaliarEmpresa(comCaeDoRegisto(estado),
      { caeQuery: '86230', modoCorrespondencia: MODO.EXPLORATORIO });
    assert.equal(a.passa, true, estado);
  }
});

test('só o que vem do NIF é travado: o que o site declara não é', () => {
  /* capital social lido no site da própria empresa não depende de
     identidade nenhuma — a empresa está a falar de si */
  const emp = {
    ...semDadosEmpresa(),
    capitalSocial: { valor: 100000, fonte: 'Website oficial', consultadoEm: 'x', confianca: 0.75,
      estado: 'CONFIRMADO',
      evidencias: [{ valor: 100000, fonte: 'Website oficial', tipoFonte: TIPO_FONTE.SITE_OFICIAL,
                     confianca: 0.75, estado: 'CONFIRMADO' }] },
    identidade: { ...identidadeVazia(), estado: IDENTIDADE.CONFLITO, nif: NIPC }
  };
  assert.equal(dependeDeIdentidade(emp.capitalSocial), false);
  const a = avaliarEmpresa(emp, { minCapitalSocial: 50000, modoCorrespondencia: MODO.ESTRITO });
  assert.equal(a.status.capitalSocial, STATUS_CRITERIO.CUMPRE);
});

test('snapshots antigos com CAE do registo: FONTE_OFICIAL delata a dependência', () => {
  /* gravados antes de existir `dependeDe`, e continuam a ter de ser
     revalidados em vez de valerem por inércia */
  const antigo = { valor: '86230', fonte: 'SICAE', estado: 'CONFIRMADO', consultadoEm: 'x',
    confianca: 0.9, evidencias: [{ valor: '86230', fonte: 'SICAE',
      tipoFonte: TIPO_FONTE.FONTE_OFICIAL, confianca: 0.9, estado: 'CONFIRMADO' }] };
  assert.equal(dependeDeIdentidade(antigo), true, 'ao registo só se chega por NIF');
  assert.equal(identidadeChegaPara({ estado: IDENTIDADE.NAO_VERIFICADA }, MODO.ESTRITO), false);
});

/* ================================================================ *
 * 20, 21, 22 — snapshots e preservação                              *
 * ================================================================ */

test('20: snapshot antigo sem identidade lê-se como NAO_VERIFICADA', () => {
  const e = lerEmpresa({ empresa: { cae: { valor: '86230', fonte: 'SICAE', consultadoEm: 'x',
    confianca: 0.9, estado: 'CONFIRMADO' } } });
  assert.equal(e.identidade.estado, IDENTIDADE.NAO_VERIFICADA);
  assert.equal(e.cae.valor, '86230', 'o dado antigo não se apaga');
});

test('20: um estado de identidade inválido lê-se como NAO_VERIFICADA', () => {
  for (const mau of ['SIM', '', null, 42, 'CONFIRMADO']) {
    assert.equal(lerIdentidade({ estado: mau }).estado, IDENTIDADE.NAO_VERIFICADA);
  }
});

test('21: snapshot novo preserva identidade, sinais e conflitos', () => {
  const guardado = {
    estado: IDENTIDADE.CONFLITO, confianca: 0, nif: NIPC_ERRADO,
    firmaOficial: 'J. J. LOURO PEREIRA, S.A.', dominio: 'ondadesorrisos',
    sinais: [{ sinal: SINAL.NOME_INCOMPATIVEL, peso: -0.45, detalhe: 'J. J. LOURO PEREIRA, S.A.' }],
    conflitos: ['O registo diz outra coisa.'],
    derivadosNaoAtribuidos: [{ campo: 'cae', valor: '31004', fonte: 'SICAE', motivo: 'CONFLITO' }],
    validadoEm: '2026-09-29T00:00:00.000Z'
  };
  const e = lerEmpresa({ empresa: { identidade: guardado } });
  assert.equal(e.identidade.estado, IDENTIDADE.CONFLITO);
  assert.equal(e.identidade.firmaOficial, 'J. J. LOURO PEREIRA, S.A.');
  assert.equal(e.identidade.sinais.length, 1);
  assert.equal(e.identidade.conflitos.length, 1);
  assert.equal(e.identidade.derivadosNaoAtribuidos[0].valor, '31004');
});

test('21: um campo derivado guarda de que identidade dependeu', () => {
  const e = lerEmpresa({ empresa: { cae: { valor: '86230', fonte: 'SICAE', consultadoEm: 'x',
    confianca: 0.9, estado: 'CONFIRMADO', dependeDe: { nif: NIPC, identidade: 'CONFIRMADA' } } } });
  assert.deepEqual(e.cae.dependeDe, { nif: NIPC, identidade: 'CONFIRMADA' });
});

test('22: as evidências continuam a atravessar o contrato', () => {
  const r = respostaConsulta({ success: true, provider: 'sicae',
    denominacao: 'MEDIBRACARA - CENTRO MÉDICO LDA', caesSecundarios: ['68110', '86220'],
    empresa: { ...semDadosEmpresa(), cae: { valor: '86230', fonte: 'SICAE', consultadoEm: 'x',
      confianca: 0.9, estado: 'CONFIRMADO',
      evidencias: [{ valor: '86230', fonte: 'SICAE', tipoFonte: TIPO_FONTE.FONTE_OFICIAL,
                     confianca: 0.9, estado: 'CONFIRMADO' }] } } });
  assert.equal(r.empresa.cae.evidencias.length, 1);
  assert.equal(r.denominacao, 'MEDIBRACARA - CENTRO MÉDICO LDA',
    'a firma tem de sobreviver ao contrato — sem ela não há identidade');
  assert.deepEqual(r.caesSecundarios, ['68110', '86220']);
});

test('22: o SICAE entrega a firma ao pipeline', async () => {
  const p = sicaeSimulado();
  const r = await p.consultar({ nif: NIPC });
  assert.equal(r.denominacao, 'MEDIBRACARA - CENTRO MÉDICO LDA');
  assert.equal(r.empresa.cae.valor, '86230');
});

/* ================================================================ *
 * 25 — dados pessoais                                               *
 * ================================================================ */

test('25: um NIF de pessoa singular não se usa como identidade da empresa', () => {
  /* passa o mesmo dígito de controlo que um NIPC. Não é o número de uma
     empresa, e importá-lo como tal seria guardar o número fiscal de uma
     pessoa numa base de dados de empresas. */
  for (const pessoal of ['123456789', '219999998', '123456787']) {
    const r = avaliarIdentidade({ nomeLead: 'Ana Fotografia', nif: pessoal, rotuloNif: 'NIF',
                                  firmaOficial: 'ANA FOTOGRAFIA UNIPESSOAL LDA' });
    if (r.sinais.some(s => s.sinal === SINAL.NIF_NAO_EMPRESARIAL)) {
      assert.equal(identidadeSuficiente(r), false, pessoal);
      assert.equal(r.estado, IDENTIDADE.INCONCLUSIVA);
    }
  }
});

test('25: a identidade não guarda nada de pessoal', () => {
  const r = id({ nomeLead: 'Medibracara', firmaOficial: 'MEDIBRACARA - CENTRO MÉDICO LDA',
                 trecho: 'Gerente: Maria Silva, residente na Rua X 3, NIF pessoal 123456789. NIPC 508459451' });
  const txt = JSON.stringify(r);
  /* o trecho não é guardado no envelope da identidade — só os sinais e a
     firma. Nada de nomes de gerentes, moradas ou NIFs pessoais. */
  assert.equal(txt.includes('Maria Silva'), false, 'nome de pessoa guardado');
  assert.equal(txt.includes('residente'), false, 'morada residencial guardada');
  assert.equal(txt.includes('123456789'), false, 'NIF pessoal guardado');
});

test('25: as chaves do envelope são fechadas e conhecidas', () => {
  assert.deepEqual(Object.keys(identidadeVazia()).sort(), [
    'candidatos', 'confianca', 'conflitos', 'derivadosNaoAtribuidos', 'dominio',
    'estado', 'firmaFonte', 'firmaOficial', 'nif', 'nomeLead', 'sinais', 'validadoEm'
  ]);
});

/* ================================================================ *
 * Uso a jusante e invariantes                                       *
 * ================================================================ */

test('identidadeSuficiente: só CONFIRMADA e PROVAVEL', () => {
  assert.deepEqual(IDENTIDADES_VALIDAS.filter(e => identidadeSuficiente({ estado: e })),
                   ['CONFIRMADA', 'PROVAVEL']);
});

test('identidadeProvaEstrito: só CONFIRMADA', () => {
  assert.deepEqual(IDENTIDADES_VALIDAS.filter(e => identidadeProvaEstrito({ estado: e })),
                   ['CONFIRMADA']);
});

test('identidadeAlerta: os três que quem lê a tabela precisa de ver', () => {
  assert.deepEqual(IDENTIDADES_VALIDAS.filter(e => identidadeAlerta({ estado: e })),
                   ['INCONCLUSIVA', 'CONFLITO', 'REJEITADA']);
});

test('sem NIF não há identidade para afirmar', () => {
  const r = avaliarIdentidade({ nomeLead: 'Qualquer', firmaOficial: 'QUALQUER LDA' });
  assert.equal(r.estado, IDENTIDADE.NAO_VERIFICADA);
  assert.equal(r.confianca, null);
});

test('o CAE nunca entra na decisão de identidade', () => {
  /* raciocínio circular proibido: "é clínica, logo o CAE devia ser
     dentário, logo o NIF está errado". Um CAE inesperado tem causas
     legítimas, e a identidade decide-se por nome, firma, domínio e
     contexto — nunca por atividade. */
  const fonte = readFileSync(new URL('../providers/company/identidade.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.equal(/\bcae\b/i.test(fonte), false, 'a identidade está a olhar para o CAE');
});

test('avaliarIdentidade é determinística e nunca lança', () => {
  const entrada = { nomeLead: 'Medibracara', dominio: 'https://medibracara.pt', nif: NIPC,
                    rotuloNif: 'NIPC', firmaOficial: 'MEDIBRACARA - CENTRO MÉDICO LDA',
                    corpusSite: 'medibracara centro medico braga', agora: '2026-09-29T00:00:00.000Z' };
  assert.deepEqual(avaliarIdentidade(entrada), avaliarIdentidade(entrada));
  for (const absurdo of [undefined, {}, { nif: 'x' }, { nif: NIPC, nomeLead: null },
                         { nif: NIPC, firmaOficial: 42 }, { nif: NIPC, candidatos: null }]) {
    const r = avaliarIdentidade(absurdo);
    assert.ok(IDENTIDADES_VALIDAS.includes(r.estado), JSON.stringify(absurdo));
  }
});

test('a confiança fica sempre entre 0 e 1', () => {
  const casos = [
    id({ nomeLead: 'Medibracara', dominio: 'https://medibracara.pt',
         firmaOficial: 'MEDIBRACARA - CENTRO MÉDICO LDA', trecho: 'com sede, NIPC',
         corpusSite: 'medibracara' }),
    id({ nomeLead: 'X', firmaOficial: 'Y CONSTRUÇÕES DISTINTAS LDA', corpusSite: 'nada' }),
    id({ trecho: 'fornecedor' })
  ];
  for (const r of casos) {
    assert.ok(r.confianca === null || (r.confianca >= 0 && r.confianca <= 1), String(r.confianca));
  }
});

test('todos os estados têm rótulo legível', () => {
  for (const e of IDENTIDADES_VALIDAS) {
    assert.ok(IDENTIDADE_ROTULO[e] && IDENTIDADE_ROTULO[e].length > 2, e);
  }
});

/* ================================================================ *
 * 27 — sem regressão no lote                                        *
 * ================================================================ */

test('27: o lote investiga identidade sem perder concorrência nem teto', async () => {
  /* Toda a leitura é simulada: um teste que fosse à rede seria lento,
     dependente de terceiros, e uma falta de educação com fontes públicas. */
  const leads = Array.from({ length: 40 }, (_, i) =>
    ({ id: 'l' + i, nome: 'Medibracara ' + i, website: 'https://medibracara.pt' }));
  let emCurso = 0, pico = 0;
  const investigar = async () => {
    emCurso += 1; pico = Math.max(pico, emCurso);
    await new Promise(res => setTimeout(res, 2));
    emCurso -= 1;
    return { paginasLidas: 1, tentativas: 1, achados: [], urls: [], corpus: 'medibracara braga',
             nif: { valor: NIPC, confianca: 0.95, rotulo: 'NIPC', url: 'https://medibracara.pt/termos',
                    trecho: 'NIPC ' + NIPC + ', com sede em Braga', candidatos: [] } };
  };
  const res = await investigarLote(leads, { concorrencia: 2, max: 25, sicae: sicaeSimulado(), investigar });
  assert.equal(res.size, 25, 'o teto por lote tem de continuar a valer');
  assert.ok(pico <= 2, 'concorrência excedida: ' + pico);
  /* e cada resultado traz identidade resolvida */
  const um = [...res.values()][0];
  assert.equal(um.empresa.identidade.estado, IDENTIDADE.CONFIRMADA);
  assert.equal(um.empresa.cae.valor, '86230');
});

/* ================================================================ *
 * O ecrã não pode juntar duas afirmações numa só                    *
 * ================================================================ */

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('o popup separa "o número foi encontrado" de "o número é desta empresa"', () => {
  /* Com NIF CONFIRMADO e identidade CONFLITO, um popup que mostrasse só
     "NIF 501135227 [Confirmado]" levaria o utilizador a concluir que
     aquele é o NIF confirmado da empresa. São afirmações diferentes. */
  const bloco = HTML.slice(HTML.indexOf('function identidadeHtml'),
                           HTML.indexOf('function criteriosHtml'));
  assert.ok(bloco.includes('NIF encontrado'), 'falta "NIF encontrado"');
  assert.ok(bloco.includes('Estado da evidência'), 'falta o estado da evidência');
  assert.ok(bloco.includes('Vínculo com esta empresa'), 'falta o vínculo — é a linha que decide');
  assert.ok(bloco.includes('Firma associada'), 'falta a firma do registo');
  assert.ok(/Dados derivados deste NIF/.test(bloco), 'falta dizer o que acontece ao que dele deriva');
  assert.ok(/não atribuídos à empresa/.test(bloco), 'falta dizer que não foram atribuídos');
});

test('com o vínculo por confirmar, o NIF não aparece como "Confirmado" verde', () => {
  const bloco = HTML.slice(HTML.indexOf('function empresaHtml'),
                           HTML.indexOf('function evidenciasHtml'));
  assert.ok(bloco.includes('vinculoDuvidoso'), 'o popup não distingue os dois casos');
  assert.ok(bloco.includes('Vínculo por confirmar'), 'falta a marca de aviso no NIF');
  /* e a marca só troca para o NIF — os outros campos mantêm o que eram */
  assert.ok(/c === 'nif' && vinculoDuvidoso/.test(bloco));
});

test('a firma diz de que registo veio, em vez de o ecrã adivinhar', () => {
  const r = avaliarIdentidade({ nomeLead: 'Medibracara', nif: NIPC, rotuloNif: 'NIPC',
    firmaOficial: 'MEDIBRACARA - CENTRO MÉDICO LDA', firmaFonte: 'SICAE' });
  assert.equal(r.firmaFonte, 'SICAE');
  /* sem firma não há fonte de firma para afirmar */
  assert.equal(avaliarIdentidade({ nif: NIPC, firmaFonte: 'SICAE' }).firmaFonte, null);
});

test('o pipeline preenche a fonte da firma a partir de quem respondeu', async () => {
  const r = await investigarEmpresa(
    { id: 'x', nome: 'Medibracara', website: 'https://medibracara.pt' },
    { sicae: sicaeSimulado(),
      investigar: investigarCom({ 'https://medibracara.pt/': '<p>NIPC: ' + NIPC + '</p>' }) });
  assert.equal(r.identidade.firmaFonte, 'SICAE');
});

test('os três estados de alerta levam a marca no NIF; os outros não', () => {
  const comAlerta = IDENTIDADES_VALIDAS.filter(e =>
    ['CONFLITO', 'REJEITADA', 'INCONCLUSIVA'].includes(e));
  assert.deepEqual(comAlerta, ['INCONCLUSIVA', 'CONFLITO', 'REJEITADA'],
    'a lista da tabela e a do popup têm de ser a mesma');
});

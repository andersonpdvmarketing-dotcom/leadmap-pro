/**
 * LeadMap Pro — filtros de porte empresarial (Fase 2)
 * ===================================================
 *   node --test tests/company-filters.test.mjs
 *
 * A regra que estes testes existem para proteger: ausência de dado nunca
 * satisfaz um critério. Uma empresa cujos funcionários ninguém consultou
 * não tem zero funcionários — tem funcionários desconhecidos, e
 * desconhecido não é maior nem menor do que 30.
 *
 * Deixá-la passar seria entregar ao utilizador uma lista de empresas que
 * ele julga terem 30+ funcionários quando não se sabe nada sobre elas.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  QUALIDADE, QUALIDADE_VALIDA, cumpreMinimo, cumpreTexto, motivoExclusao,
  filtrosEmpresaVazios, temCriterioEmpresa, camposExigidos, avaliarEmpresa,
  scorePorte, estadosAceites
} from '../providers/company/filters.mjs';
import { semDadosEmpresa, lerEmpresa, CAMPOS, ESTADO_DADO } from '../providers/company/contract.mjs';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const conf = v => ({ valor: v, fonte: 'p', consultadoEm: '2026-09-28', confianca: 1, estado: 'CONFIRMADO' });
const est  = v => ({ valor: v, fonte: 'p', consultadoEm: '2026-09-28', confianca: 0.5, estado: 'ESTIMADO' });
const naoEnc = { valor: null, fonte: null, consultadoEm: null, confianca: null, estado: 'NAO_ENCONTRADO' };
const naoCon = { valor: null, fonte: null, consultadoEm: null, confianca: null, estado: 'NAO_CONSULTADO' };

const emp = (o = {}) => ({ ...semDadosEmpresa(), ...o });
const filtros = (o = {}) => ({ ...filtrosEmpresaVazios(), ...o });

/* ================================================================ *
 * 1 — sem filtro empresarial, comportamento antigo                  *
 * ================================================================ */

test('1: sem critério empresarial nada é filtrado', () => {
  const f = filtrosEmpresaVazios();
  assert.equal(temCriterioEmpresa(f), false);
  /* até uma empresa sem dado nenhum passa */
  assert.equal(avaliarEmpresa(emp(), f).passa, true);
  assert.equal(avaliarEmpresa(emp({ funcionarios: conf(1) }), f).passa, true);
});

test('1: qualidade e enriquecimento não são critérios por si', () => {
  assert.equal(temCriterioEmpresa(filtros({ qualidadeDados: 'CONFIRMADO' })), false);
  assert.equal(temCriterioEmpresa(filtros({ enriquecerEmpresa: true })), false);
  assert.equal(avaliarEmpresa(emp(), filtros({ enriquecerEmpresa: true })).passa, true,
    'ligar o enriquecimento não pode, por si, excluir ninguém');
});

/* ================================================================ *
 * 2 a 6 — critérios numéricos                                       *
 * ================================================================ */

test('2: 30+ funcionários', () => {
  assert.equal(cumpreMinimo(conf(47), 30), true);
  assert.equal(cumpreMinimo(conf(30), 30), true, 'o limite é inclusivo');
  assert.equal(cumpreMinimo(conf(12), 30), false);
  assert.equal(cumpreMinimo(conf(29), 30), false);
});

test('3: 50+ funcionários', () => {
  assert.equal(cumpreMinimo(conf(47), 50), false, '47 não chega a 50');
  assert.equal(cumpreMinimo(conf(50), 50), true);
  assert.equal(cumpreMinimo(conf(1200), 50), true);
});

test('4: €1M+ de faturação', () => {
  assert.equal(cumpreMinimo(conf(1800000), 1000000), true);
  assert.equal(cumpreMinimo(conf(999999), 1000000), false);
  assert.equal(cumpreMinimo(conf(1000000), 1000000), true);
});

test('5: €50k+ de capital social', () => {
  assert.equal(cumpreMinimo(conf(75000), 50000), true);
  assert.equal(cumpreMinimo(conf(5000), 50000), false);
});

test('6: combinação dos três critérios', () => {
  const f = filtros({ minFuncionarios: 30, minFaturacaoAnual: 1000000, minCapitalSocial: 50000 });
  const boa = emp({ funcionarios: conf(47), faturacaoAnual: conf(1800000), capitalSocial: conf(75000) });
  assert.equal(avaliarEmpresa(boa, f).passa, true);

  /* falhar UM critério chega para excluir */
  const quaseBoa = emp({ funcionarios: conf(47), faturacaoAnual: conf(1800000), capitalSocial: conf(5000) });
  const r = avaliarEmpresa(quaseBoa, f);
  assert.equal(r.passa, false, 'uma falha comprovada exclui, em qualquer modo exceto o exploratório');
  assert.equal(r.status.capitalSocial, 'NAO_CUMPRE');
  assert.equal(r.status.funcionarios, 'CUMPRE');
  assert.equal(r.match, 'NAO_CUMPRE');
});

test('6: dois de três, com o terceiro por investigar', () => {
  const f = filtros({ minFuncionarios: 30, minFaturacaoAnual: 1000000, minCapitalSocial: 50000 });
  const semCapital = emp({ funcionarios: conf(47), faturacaoAnual: conf(1800000) });
  const r = avaliarEmpresa(semCapital, f);
  /* no modo inteligente sobrevive: não há prova de que falhe */
  assert.equal(r.passa, true);
  assert.equal(r.status.capitalSocial, 'DESCONHECIDO');
  assert.equal(r.match, 'PARCIAL');
  /* no estrito não chega */
  assert.equal(avaliarEmpresa(semCapital, { ...f, modoCorrespondencia: 'ESTRITO' }).passa, false);
});

/* ================================================================ *
 * 7 a 11 — estados e qualidade                                      *
 * ================================================================ */

test('7: CONFIRMADO satisfaz em qualquer nível de qualidade', () => {
  for (const q of QUALIDADE_VALIDA) {
    assert.equal(cumpreMinimo(conf(47), 30, q), true, 'falhou em ' + q);
  }
});

test('8: ESTIMADO com "Somente confirmados" não satisfaz', () => {
  assert.equal(cumpreMinimo(est(47), 30, QUALIDADE.CONFIRMADO), false);
  assert.equal(motivoExclusao(est(47), 30, QUALIDADE.CONFIRMADO), 'QUALIDADE_INSUFICIENTE');
});

test('9: ESTIMADO com "Confirmados + estimados" satisfaz', () => {
  assert.equal(cumpreMinimo(est(47), 30, QUALIDADE.CONFIRMADO_ESTIMADO), true);
  assert.equal(cumpreMinimo(est(47), 30, QUALIDADE.TODOS), true);
  /* mas continua a ser estimativa: um valor abaixo falha na mesma */
  assert.equal(cumpreMinimo(est(12), 30, QUALIDADE.CONFIRMADO_ESTIMADO), false);
});

test('10: NAO_ENCONTRADO nunca satisfaz, em nenhum nível', () => {
  for (const q of QUALIDADE_VALIDA) {
    assert.equal(cumpreMinimo(naoEnc, 30, q), false, 'satisfez em ' + q);
    assert.equal(cumpreMinimo(naoEnc, 0, q), false, 'nem sequer com mínimo 0');
  }
  assert.equal(motivoExclusao(naoEnc, 30), 'SEM_DADOS');
});

test('11: NAO_CONSULTADO nunca satisfaz, em nenhum nível', () => {
  for (const q of QUALIDADE_VALIDA) {
    assert.equal(cumpreMinimo(naoCon, 30, q), false, 'satisfez em ' + q);
    assert.equal(cumpreMinimo(naoCon, 0, q), false);
  }
  assert.equal(motivoExclusao(naoCon, 30), 'SEM_DADOS');
});

test('"TODOS" não significa que a ausência passa a contar', () => {
  /* TODOS aceita também CONFLITO — um valor disputado continua a ser um
     valor. O que nunca entra é a ausência. */
  assert.deepEqual([...estadosAceites(QUALIDADE.TODOS)], ['CONFIRMADO', 'ESTIMADO', 'CONFLITO']);
  assert.equal(cumpreMinimo(naoCon, 1, QUALIDADE.TODOS), false);
  assert.equal(cumpreMinimo(naoEnc, 1, QUALIDADE.TODOS), false);
});

/* ================================================================ *
 * 12 — null nunca vira zero                                         *
 * ================================================================ */

test('12: valor null nunca é tratado como zero', () => {
  /* se null virasse 0, um mínimo de 0 deixaria passar tudo */
  assert.equal(cumpreMinimo(naoCon, 0), false);
  assert.equal(cumpreMinimo(naoEnc, 0), false);
  assert.equal(cumpreMinimo({ valor: null, estado: 'CONFIRMADO' }, 0), false);
  /* e um zero verdadeiro continua a ser um valor */
  assert.equal(cumpreMinimo(conf(0), 0), true);
  assert.equal(cumpreMinimo(conf(0), 1), false);
});

test('12: valores não numéricos ou corrompidos não passam por acidente', () => {
  assert.equal(cumpreMinimo(conf('muitos'), 30), false);
  assert.equal(cumpreMinimo(conf(NaN), 30), false);
  /* Infinity é matematicamente maior que 30, mas nenhuma empresa tem
     infinitos funcionários: é dado corrompido, e dado corrompido não
     satisfaz um critério comercial. */
  assert.equal(cumpreMinimo(conf(Infinity), 30), false);
  assert.equal(cumpreMinimo(conf(-Infinity), 30), false);
});

test('12: um mínimo inválido não filtra em vez de excluir toda a gente', () => {
  assert.equal(cumpreMinimo(conf(5), NaN), true);
  assert.equal(cumpreMinimo(conf(5), ''), true);
  assert.equal(cumpreMinimo(conf(5), null), true);
});

/* ================================================================ *
 * 13 — snapshots antigos                                            *
 * ================================================================ */

test('13: lead de snapshot antigo, sem campo empresa', () => {
  const antigo = { id: 'google-velho', nome: 'Padaria Antiga' };
  const e = lerEmpresa(antigo);
  for (const c of CAMPOS) assert.equal(e[c].estado, 'NAO_CONSULTADO');
  /* sem critérios passa; com critérios sobrevive no modo inteligente,
     porque não se sabe nada — e não saber não é falhar */
  assert.equal(avaliarEmpresa(e, filtrosEmpresaVazios()).passa, true);
  assert.equal(avaliarEmpresa(e, filtros({ minFuncionarios: 30 })).passa, true);
  assert.equal(avaliarEmpresa(e, filtros({ minFuncionarios: 30 })).status.funcionarios, 'DESCONHECIDO');
  assert.equal(avaliarEmpresa(e, filtros({ minFuncionarios: 30, modoCorrespondencia: 'ESTRITO' })).passa, false);
});

test('13: empresa undefined ou malformada não rebenta', () => {
  for (const v of [undefined, null, 'texto', 42, []]) {
    const r = avaliarEmpresa(v, filtros({ minFuncionarios: 30 }));
    assert.equal(r.status.funcionarios, 'DESCONHECIDO', 'dado ilegível é desconhecido, não falha');
    assert.equal(r.passa, true, 'no modo inteligente sobrevive');
    assert.equal(avaliarEmpresa(v, filtros({ minFuncionarios: 30, modoCorrespondencia: 'ESTRITO' })).passa, false);
    assert.equal(avaliarEmpresa(v, filtrosEmpresaVazios()).passa, true);
  }
});

/* ================================================================ *
 * 14 — CAE                                                          *
 * ================================================================ */

test('14: CAE compara código e descrição, sem acentos', () => {
  assert.equal(cumpreTexto(conf('41200'), '41200'), true);
  assert.equal(cumpreTexto(conf('41200'), '412'), true, 'prefixo conta');
  assert.equal(cumpreTexto(conf('Construção de edifícios'), 'construcao'), true);
  assert.equal(cumpreTexto(conf('Construção de edifícios'), 'CONSTRUÇÃO'), true);
  assert.equal(cumpreTexto(conf('41200'), '99999'), false);
});

test('14: CAE em falta não satisfaz', () => {
  assert.equal(cumpreTexto(naoCon, '41200'), false);
  assert.equal(cumpreTexto(naoEnc, '41200'), false);
  const r = avaliarEmpresa(emp(), filtros({ caeQuery: '41200' }));
  assert.equal(r.status.cae, 'DESCONHECIDO');
  assert.equal(r.passa, true, 'no modo inteligente um CAE por investigar não exclui');
  assert.equal(avaliarEmpresa(emp(), filtros({ caeQuery: '41200', modoCorrespondencia: 'ESTRITO' })).passa, false);
});

test('14: CAE vazio não é critério', () => {
  assert.equal(cumpreTexto(naoCon, ''), true);
  assert.equal(cumpreTexto(naoCon, '   '), true);
  assert.equal(temCriterioEmpresa(filtros({ caeQuery: '  ' })), false);
});

/* ================================================================ *
 * 15 — estado da empresa                                            *
 * ================================================================ */

test('15: estado da empresa não tem fonte — fica desconhecido, não inferido', () => {
  const r = avaliarEmpresa(emp({ funcionarios: conf(999) }), filtros({ estadoEmpresa: 'ATIVA' }));
  /* não há dado jurídico e não se inventa: DESCONHECIDO é a verdade */
  assert.equal(r.status.estadoEmpresa, 'DESCONHECIDO');
  assert.equal(r.passa, true, 'no modo inteligente não se elimina por não se saber');
  /* o único critério ativo é o estado; os funcionários não foram pedidos */
  assert.equal(r.total, 1);
  assert.equal(r.match, 'INCONCLUSIVO', 'o único critério pedido está por investigar');
  assert.equal(avaliarEmpresa(emp(), filtros({ estadoEmpresa: 'ATIVA', modoCorrespondencia: 'ESTRITO' })).passa, false);
});

test('15: o modelo não ganhou um campo de estado jurídico', () => {
  assert.equal(CAMPOS.includes('estadoEmpresa'), false,
    'inferir situação jurídica a partir do que temos seria inventar');
});

/* ================================================================ *
 * 16 — valores personalizados                                       *
 * ================================================================ */

test('16: um mínimo personalizado comporta-se como os pré-definidos', () => {
  assert.equal(cumpreMinimo(conf(35), 35), true);
  assert.equal(cumpreMinimo(conf(34), 35), false);
  assert.equal(cumpreMinimo(conf(750000), 750000), true);
});

test('16: a modal lê o campo personalizado e ignora-o quando vazio', () => {
  const corpo = HTML.slice(HTML.indexOf('function lerFiltrosEmpresa'), HTML.indexOf('function fmtEuroCurto'));
  assert.ok(/bruto !== ''/.test(corpo), 'um campo por preencher tem de valer "Qualquer"');
  assert.ok(/n >= 0/.test(corpo), 'só inteiros não negativos');
  assert.ok(/Math\.floor/.test(corpo));
});

/* ================================================================ *
 * 17 — estrutura da modal e mobile                                  *
 * ================================================================ */

test('17: a secção está entre as sugestões e a localização', () => {
  const iSug = HTML.indexOf('Sugestões rápidas');
  const iEmp = HTML.indexOf('<legend>Porte e dados empresariais</legend>');
  const iLoc = HTML.indexOf('<legend>Localização central</legend>');
  assert.ok(iSug > 0 && iEmp > 0 && iLoc > 0);
  assert.ok(iSug < iEmp, 'a secção tem de vir depois das sugestões');
  assert.ok(iEmp < iLoc, 'e antes da localização');
});

test('17: a modal original mantém-se intacta', () => {
  for (const marca of ['O que pretende pesquisar?', 'Sugestões rápidas', 'Localização central',
                       'id="fQuery"', 'id="fMorada"', 'id="fCP"', 'id="fCidade"', 'id="searchForm"']) {
    assert.ok(HTML.includes(marca), 'desapareceu da modal: ' + marca);
  }
});

test('17: a secção é colapsável e fechada por omissão', () => {
  const i = HTML.indexOf('<details class="emp-box" id="empBox">');
  assert.ok(i > 0, 'secção não é um <details>');
  const tag = HTML.slice(i, i + 60);
  assert.equal(/\bopen\b/.test(tag), false, 'não pode nascer aberta: seria uma parede de filtros');
});

test('17: mobile — há media query e o fieldset pode encolher', () => {
  assert.ok(/@media \(max-width: 560px\)[\s\S]{0,400}\.emp-ops button/.test(HTML),
    'falta o ajuste de alvo de toque no telemóvel');
  /* o quirk que fazia a modal transbordar: fieldset tem min-inline-size
     min-content por omissão */
  assert.ok(/\.fgroup \{[^}]*min-inline-size: 0/.test(HTML),
    'sem isto a modal cresce para fora do ecrã em telemóveis');
});

test('17: o resumo pode encolher em vez de empurrar a modal', () => {
  assert.ok(/\.emp-resumo \{[^}]*text-overflow: ellipsis/.test(HTML));
  assert.ok(/\.emp-resumo \{[^}]*min-width: 0/.test(HTML));
});

/* ================================================================ *
 * 18 e 19 — nada de providers pagos nem enriquecimento em massa      *
 * ================================================================ */

test('18: nenhum provider comercial foi ligado', async () => {
  const { COMPANY_PROVIDER_TYPES } = await import('../providers/company/router.mjs');
  assert.deepEqual([...COMPANY_PROVIDER_TYPES], ['website', 'mock']);
});

test('18: os filtros não fazem rede nem leem credenciais', () => {
  const src = readFileSync(new URL('../providers/company/filters.mjs', import.meta.url), 'utf8');
  for (const proibido of ['fetch(', 'XMLHttpRequest', 'process.env', 'api_key', 'Bearer']) {
    assert.equal(src.includes(proibido), false, 'filters.mjs contém ' + proibido);
  }
});

test('19: a caixa de enriquecimento não dispara consultas', () => {
  const i = HTML.indexOf('function lerFiltrosEmpresa');
  const corpo = HTML.slice(i, HTML.indexOf('function ligarSeccaoEmpresa'));
  /* guarda o valor, e mais nada */
  assert.ok(/enriquecerEmpresa = \$\('#fEnriquecer'\)\.checked/.test(corpo));
  assert.equal(/fetch\(/.test(corpo), false, 'a secção da modal não pode fazer pedidos');
});

test('19: nenhum enriquecimento empresarial em massa foi acrescentado', () => {
  /* as únicas filas de enriquecimento continuam a ser socials e email */
  const filas = (HTML.match(/function pump\w+Queue/g) || []).sort();
  assert.deepEqual(filas, ['function pumpEmailQueue', 'function pumpSocialQueue']);
});

test('19: a interface avisa quando um critério não tem fonte', () => {
  const i = HTML.indexOf('function actualizarSeccaoEmpresa');
  const corpo = HTML.slice(i, HTML.indexOf('function ligarSeccaoEmpresa'));
  assert.ok(/CAMPOS_EMPRESA_SEM_FONTE/.test(corpo));
  /* o aviso tem de dizer o que acontece em cada modo: no estrito a lista
     fica vazia; nos outros as empresas ficam marcadas como por investigar */
  /* o texto está partido por concatenação, por isso procura-se por peças */
  assert.ok(/modo estrito/.test(corpo), 'falta o aviso específico do modo estrito');
  assert.ok(/não vai devolver/.test(corpo), 'falta dizer que a lista fica vazia no estrito');
  assert.ok(/por investigar/.test(corpo), 'falta explicar o que acontece nos outros modos');
});

/* ================================================================ *
 * O ecrã não pode divergir do módulo                                *
 * ================================================================ */

test('os filtros do ecrã não divergem do módulo', () => {
  const m = HTML.match(/const ESTADOS_ACEITES_EMPRESA = \{([\s\S]*?)\};/);
  assert.ok(m, 'ESTADOS_ACEITES_EMPRESA não encontrado no index.html');
  for (const q of QUALIDADE_VALIDA) {
    const linha = new RegExp(q + ":\\s*\\[([^\\]]+)\\]").exec(m[1]);
    assert.ok(linha, 'falta o nível ' + q + ' no ecrã');
    const doEcra = linha[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
    assert.deepEqual(doEcra, [...estadosAceites(q)], 'o nível ' + q + ' divergiu');
  }
});

test('a lista de critérios do ecrã é a mesma do módulo', () => {
  const m = HTML.match(/function filtrosEmpresaVazios\(\) \{[\s\S]*?return \{([\s\S]*?)\};/);
  assert.ok(m);
  const chaves = [...m[1].matchAll(/(\w+):/g)].map(x => x[1]).sort();
  assert.deepEqual(chaves, Object.keys(filtrosEmpresaVazios()).sort());
});

/* ================================================================ *
 * computeFiltered                                                   *
 * ================================================================ */

test('computeFiltered só avalia porte quando há critérios', () => {
  const i = HTML.indexOf('function computeFiltered');
  const corpo = HTML.slice(i, HTML.indexOf('function socCell'));
  assert.ok(/if \(comCriterioEmpresa\)/.test(corpo),
    'sem critérios não pode sequer correr a avaliação: é o caminho quente');
  assert.ok(/excluidosPorte\+\+/.test(corpo), 'falta contar os excluídos por falta de dados');
});

test('computeFiltered aplica o porte depois dos filtros baratos', () => {
  const i = HTML.indexOf('function computeFiltered');
  const corpo = HTML.slice(i, HTML.indexOf('function socCell'));
  assert.ok(corpo.indexOf('f.niches.has') < corpo.indexOf('avaliarEmpresa'),
    'o critério mais caro tem de vir por último');
});

test('o estado vazio explica a exclusão por falta de dados', () => {
  assert.ok(/excluidosPorte > 0/.test(HTML));
  assert.ok(/excluídas por não haver dados empresariais/.test(HTML),
    'uma lista vazia por falta de dados não pode parecer uma avaria');
});

/* ================================================================ *
 * Campos exigidos e score                                           *
 * ================================================================ */

test('camposExigidos diz o que os critérios ativos precisam', () => {
  assert.deepEqual(camposExigidos(filtrosEmpresaVazios()), []);
  assert.deepEqual(camposExigidos(filtros({ minFuncionarios: 30 })), ['funcionarios']);
  assert.deepEqual(
    camposExigidos(filtros({ minFuncionarios: 30, minCapitalSocial: 5000, caeQuery: '41' })),
    ['funcionarios', 'capitalSocial', 'cae']);
});

test('scorePorte fica null enquanto não houver dados suficientes', () => {
  assert.equal(scorePorte(emp()), null);
  assert.equal(scorePorte(emp({ funcionarios: conf(47) })), null, 'um sinal isolado não é um porte');
  assert.equal(scorePorte(emp({ funcionarios: conf(47), faturacaoAnual: conf(2e6) })), null,
    'a fórmula ainda não existe — inventá-la seria falsa precisão');
});

test('o popup só mostra campos que têm mesmo valor', () => {
  const i = HTML.indexOf('function empresaHtml');
  const corpo = HTML.slice(i, HTML.indexOf('function popupHtml'));
  assert.ok(/if \(!v \|\| v\.valor == null\) continue/.test(corpo),
    'quatro linhas de "Por consultar" são ruído, não informação');
  assert.ok(/!linhas\.length && !criterios/.test(corpo), 'sem dados nem critérios, sem bloco');
  assert.ok(/ESTIMADO'[\s\S]{0,80}Estimativa/.test(corpo), 'uma estimativa tem de se anunciar');
});

/**
 * LeadMap Pro — extração de porte a partir de texto público
 * =========================================================
 *   node --test tests/extracao-cobertura.test.mjs
 *
 * O QUE UMA MEDIÇÃO REAL MOSTROU
 * ------------------------------
 * Trinta empresas de construção, consultoria e indústria, tiradas de
 * pesquisas verdadeiras. Resultado:
 *
 *   capital social   2 em 30 sites sequer mencionam o assunto
 *   funcionários    22 em 30 contêm palavras de pessoas — e só 2
 *                   declaram mesmo quantos são
 *   faturação        6 em 30 usam a palavra, nenhuma para dizer a sua
 *
 * As outras vinte falavam de "a nossa equipa está disponível", "+800
 * Clientes Satisfeitos", "Equipa com +20 anos de experiência" e "3
 * membros dedicados por cliente". As seis de faturação eram todas o nome
 * de um serviço prestado ou de um módulo de software.
 *
 * Por isso estes testes são sobretudo sobre o que NÃO se extrai. O ruído
 * é uma ordem de grandeza mais frequente do que o sinal: um extrator
 * ganancioso encheria a base de números errados e ninguém daria por
 * isso até alguém filtrar "30+ funcionários" e telefonar à empresa
 * errada.
 *
 * Cada caso marcado "real" veio mesmo de uma das trinta páginas.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  numeroPt, extrairCapitalSocial, extrairFuncionarios,
  extrairFaturacao, extrairTudo
} from '../providers/company/extracao.mjs';
import { evidencia, TIPO_FONTE, ESTADO_DADO } from '../providers/company/contract.mjs';
import { evidenciasDoWebsite } from '../providers/company/open-intelligence.mjs';

const valores = (achados) => achados.map(a => a.valor);
const primeiro = (achados) => achados[0] || null;

/* ================================================================ *
 * §14 — números nas duas convenções                                 *
 * ================================================================ */

test('§14: ponto e vírgula trocam de papel entre PT e EN', () => {
  assert.equal(numeroPt('1.250.000,50'), 1250000.5, 'português');
  assert.equal(numeroPt('1,250,000.50'), 1250000.5, 'inglês');
  assert.equal(numeroPt('2,000,000'), 2000000, 'milhares à inglesa');
  assert.equal(numeroPt('1.500'), 1500, 'milhares à portuguesa');
  assert.equal(numeroPt('1 500'), 1500, 'o espaço também separa milhares');
  assert.equal(numeroPt('2,5'), 2.5, 'decimal português');
  assert.equal(numeroPt('18.2'), 18.2, 'decimal inglês');
  assert.equal(numeroPt('75'), 75);
});

test('§14: a língua da escala desfaz o empate da vírgula', () => {
  /* "1,250 milhões" são 1,25 milhões em português e 1250 milhões em
     inglês — mil vezes de diferença. A palavra ao lado decide. */
  assert.equal(primeiro(extrairFaturacao('volume de negócios de 1,250 milhões de euros')).valor, 1250000);
  assert.equal(primeiro(extrairFaturacao('turnover of €1,250,000')).valor, 1250000);
});

test('§14: escalas em português e inglês', () => {
  const casos = [
    ['volume de negócios de 32,4 milhões de euros', 32400000],
    ['revenue of €18.2 million', 18200000],
    ['turnover of €1.5 billion', 1500000000],
    ['faturação de 800 mil euros', 800000]
  ];
  for (const [t, esperado] of casos) {
    assert.equal(primeiro(extrairFaturacao(t))?.valor, esperado, t);
  }
});

/* ================================================================ *
 * §8 / §28 — capital social                                         *
 * ================================================================ */

test('§8: capital social nas formas que aparecem mesmo', () => {
  const casos = [
    ['Capital Social 1 000 000 €', 1000000],
    ['Capital social: €500.000', 500000],
    ['capital social integralmente realizado de 250.000 euros', 250000],
    ['share capital €2,000,000', 2000000],
    ['O capital social é de € 250000,00', 250000]           /* real: Rota Certa */
  ];
  for (const [t, esperado] of casos) {
    assert.equal(primeiro(extrairCapitalSocial(t))?.valor, esperado, t);
  }
});

test('§28: o que NÃO é capital social', () => {
  for (const t of ['Capital próprio 3M', 'NIPC 514 998 270', 'Ativos de €4M',
                   'Património líquido 2.000.000 €', 'investimento de €1M',
                   'Telefone 218 000 000', 'Código Postal 1000-100']) {
    assert.deepEqual(extrairCapitalSocial(t), [], t);
  }
});

test('§8: um número com € ao lado não chega — exige-se o rótulo', () => {
  assert.deepEqual(extrairCapitalSocial('Preço desde 500.000 €'), []);
  assert.deepEqual(extrairCapitalSocial('Prémio de 1.000.000 €'), []);
});

/* ================================================================ *
 * §9 / §28 — funcionários                                           *
 * ================================================================ */

test('§9: declarações de efetivos, e o operador certo', () => {
  const casos = [
    ['Temos 137 colaboradores', 137, '='],
    ['A nossa equipa conta com 85 profissionais', 85, '='],
    ['Empregamos 240 pessoas', 240, '='],
    ['120 employees', 120, '='],
    ['workforce of 350', 350, '='],
    ['team of 40', 40, '='],
    ['Nº total de trabalhadores: 21', 21, '='],          /* real: Peçolopes */
    ['Colaboradores: 45', 45, '='],
    ['conta com uma equipa de 12 pessoas', 12, '=']      /* real: Bukip */
  ];
  for (const [t, valor, operador] of casos) {
    const a = primeiro(extrairFuncionarios(t));
    assert.equal(a?.valor, valor, t);
    assert.equal(a?.operador, operador, t);
  }
});

test('§9: "mais de 100" é um mínimo, e só um', () => {
  /* Antes saíam dois achados da mesma frase: o mínimo 100+ e, por cima,
     um exato 100 vindo do padrão solto. O exato apresentaria como
     contagem aquilo que é um limite inferior. */
  for (const t of ['mais de 100 colaboradores', 'over 500 employees',
                   'superior a 50 funcionários', 'acima de 30 trabalhadores']) {
    const r = extrairFuncionarios(t);
    assert.equal(r.length, 1, t + ' → ' + JSON.stringify(valores(r)));
    assert.equal(r[0].operador, '>=', t);
  }
});

test('§10: pessoas que não trabalham cá', () => {
  const naoSao = [
    'rede com 500 médicos',
    'rede com 500 profissionais',
    '500 clientes satisfeitos',
    '+ 800 Clientes Satisfeitos',                         /* real: URBISISTEMA */
    '50 parceiros',
    'formámos 800 profissionais',
    'apoiamos 200 trabalhadores',
    'recrutamos 150 profissionais',
    'ao serviço de 300 pessoas',
    '3 membros dedicados da nossa equipa',                /* real: Bukip */
    '200 alunos', '40 associados', '12 lojas', '25 unidades'
  ];
  for (const t of naoSao) assert.deepEqual(extrairFuncionarios(t), [], t);
});

test('§10: o ano não é um efetivo', () => {
  /* "integrou a equipa da Bukip em 2022" apareceu nove vezes numa só
     empresa. Um padrão que ligasse "equipa" ao número mais próximo
     devolveria 2022 funcionários. */
  for (const t of ['integrou a equipa da Bukip em 2022',
                   'entrou para a equipa em 1991',
                   'Equipa com +20 anos de experiência']) {
    const r = extrairFuncionarios(t);
    assert.equal(r.some(a => a.valor >= 1900), false, t + ' → ' + JSON.stringify(valores(r)));
  }
});

test('§10: uma frase verdadeira não é rejeitada por falar de clientes', () => {
  /* Caso real. Uma primeira versão da guarda varria o texto a seguir ao
     número e deitava isto fora porque a equipa é "focada no cliente". */
  const t = 'Actualmente a Bukip conta com uma equipa de 12 pessoas focadas no cliente e nos seus números';
  assert.equal(primeiro(extrairFuncionarios(t))?.valor, 12);
});

test('§15: o ano de referência é guardado, nunca inventado', () => {
  const a = primeiro(extrairFuncionarios('Em 2018 tínhamos 40 colaboradores'));
  assert.equal(a.valor, 40);
  assert.equal(a.anoReferencia, 2018, 'um dado de 2018 não é uma afirmação sobre hoje');
  assert.equal(primeiro(extrairFuncionarios('Temos 40 colaboradores')).anoReferencia, null,
    'sem ano na frase não se inventa nenhum');
});

/* ================================================================ *
 * §11 / §12 / §28 — faturação                                       *
 * ================================================================ */

test('§11: faturação com período e valor', () => {
  const a = primeiro(extrairFaturacao('Em 2025 o Grupo registou um volume de negócios de 32,4 milhões de euros.'));
  assert.equal(a.valor, 32400000);
  assert.equal(a.anoReferencia, 2025);

  const b = primeiro(extrairFaturacao('revenue of €18.2 million in 2024'));
  assert.equal(b.valor, 18200000);
  assert.equal(b.anoReferencia, 2024);

  for (const [t, v, ano] of [['faturação de €800.000 em 2024', 800000, 2024],
                             ['annual revenue €3.2 million in 2025', 3200000, 2025],
                             ['volume de negócios de 2,5 milhões de euros em 2025', 2500000, 2025]]) {
    const r = primeiro(extrairFaturacao(t));
    assert.equal(r?.valor, v, t);
    assert.equal(r?.anoReferencia, ano, t);
  }
});

test('§12: grandezas que não são faturação', () => {
  for (const t of ['EBITDA €2M', 'investimento de €4M', 'contrato de €6M',
                   'capital social €1M', 'lucro de €500.000',
                   'resultado líquido de €300.000', 'valor de adjudicação €2M',
                   'orçamento de €1,5 milhões', 'ativos de €10M']) {
    assert.deepEqual(extrairFaturacao(t), [], t);
  }
});

test('§12: "faturação" como serviço prestado não é a faturação da empresa', () => {
  /* Foi o que a medição encontrou em 100% dos casos deste setor: a
     palavra aparece a listar o que a empresa faz para os outros. */
  for (const t of ['Serviços: 1. Contabilidade 2. Tesouraria e Faturação 5. Reporting',
                   'Toconline (Contabilidade, Arquivo Digital, Facturação, Salários)',
                   'módulo de Faturação incluído por 50 € / mês',
                   'software de faturação a partir de 25€']) {
    assert.deepEqual(extrairFaturacao(t), [], t);
  }
});

test('§13: faturação sem período explícito não ganha um', () => {
  const a = primeiro(extrairFaturacao('volume de negócios de 5 milhões de euros'));
  assert.equal(a.valor, 5000000);
  assert.equal(a.anoReferencia, null);
});

/* ================================================================ *
 * §9 — estatísticas do setor continuam de fora                      *
 * ================================================================ */

test('um agregado do setor nunca é o número desta empresa', () => {
  for (const t of ['o volume de negócios médio do setor é de 300.000 €',
                   'as empresas do setor empregam em média 25 trabalhadores',
                   'capital social médio por empresa: 50.000 €']) {
    assert.deepEqual(extrairTudo(t).filter(a => a.campo !== 'cae'), [], t);
  }
});

/* ================================================================ *
 * §16 — proveniência                                                *
 * ================================================================ */

test('§16: a evidência transporta ano e texto original', () => {
  const ev = evidencia({
    valor: 21, fonte: 'Website oficial', url: 'https://x.pt/empresa',
    consultadoEm: '2026-09-29T00:00:00.000Z', confianca: 0.75,
    estado: ESTADO_DADO.CONFIRMADO, tipoFonte: TIPO_FONTE.SITE_OFICIAL,
    anoReferencia: 2024, textoOriginal: 'Nº total de trabalhadores: 21'
  });
  assert.equal(ev.anoReferencia, 2024);
  assert.equal(ev.textoOriginal, 'Nº total de trabalhadores: 21');
});

test('§16: o texto original é curto — audita-se, não se arquiva a página', () => {
  const ev = evidencia({ valor: 1, fonte: 'f', tipoFonte: TIPO_FONTE.SITE_OFICIAL,
    consultadoEm: '2026-09-29T00:00:00.000Z', textoOriginal: 'x'.repeat(5000) });
  assert.equal(ev.textoOriginal.length, 300);
});

test('§16: um ano absurdo não entra no envelope', () => {
  for (const ano of [1800, 3000, 'abc', null, NaN, 20.5]) {
    const ev = evidencia({ valor: 1, fonte: 'f', tipoFonte: TIPO_FONTE.SITE_OFICIAL,
      consultadoEm: '2026-09-29T00:00:00.000Z', anoReferencia: ano });
    assert.equal('anoReferencia' in ev, false, String(ano));
  }
});

test('§16: evidências antigas, sem estes campos, continuam válidas', () => {
  const ev = evidencia({ valor: 100, fonte: 'Website oficial',
    consultadoEm: '2026-09-29T00:00:00.000Z', tipoFonte: TIPO_FONTE.SITE_OFICIAL });
  assert.equal('anoReferencia' in ev, false);
  assert.equal('textoOriginal' in ev, false);
  assert.equal(ev.valor, 100);
});

test('§17: o que vem do site da empresa é SITE_OFICIAL, não fonte do Estado', () => {
  const achados = extrairTudo('Nº total de trabalhadores: 21. Capital social: 50.000 €')
    .map(a => ({ ...a, url: 'https://x.pt/empresa' }));
  const evs = evidenciasDoWebsite(achados, '2026-09-29T00:00:00.000Z');
  assert.ok(evs.length >= 2);
  for (const { ev } of evs) {
    assert.equal(ev.tipoFonte, TIPO_FONTE.SITE_OFICIAL,
      '"oficial" aqui é a própria empresa, não o registo');
  }
});

test('§20: um mínimo declarado continua ESTIMADO, não CONFIRMADO', () => {
  const achados = extrairFuncionarios('mais de 100 colaboradores').map(a => ({ ...a, url: 'https://x.pt' }));
  const { ev } = evidenciasDoWebsite(achados, '2026-09-29T00:00:00.000Z')[0];
  assert.equal(ev.estado, ESTADO_DADO.ESTIMADO,
    '"mais de 100" é boa evidência de >= 100 e nenhuma de = 100');
  assert.equal(ev.valor, 100);
});

test('§13/§15: um ano de fundação não é o ano do dado', () => {
  /* Caso real, apanhado a rever à mão o que a medição produziu: a página
     da Rota Certa diz "constituída em 12/06/2013 … O capital social é de
     € 250000,00". Marcar o capital como sendo de 2013 seria afirmar algo
     que a página não diz. */
  const a = primeiro(extrairCapitalSocial(
    'A empresa tem 10 anos, tendo sido constituída em 12/06/2013. A sua sede fica ' +
    'localizada em Odivelas. O capital social é de € 250000,00.'));
  assert.equal(a.valor, 250000);
  assert.equal(a.anoReferencia, null, 'o 2013 é da constituição, não do capital');

  const b = primeiro(extrairFuncionarios('Fundada em 1985, a empresa tem hoje 120 colaboradores'));
  assert.equal(b.valor, 120);
  assert.equal(b.anoReferencia, null);

  /* mas um ano que é mesmo do dado continua a ser lido */
  assert.equal(primeiro(extrairFaturacao('Relatório 2025: volume de negócios de 8 milhões')).anoReferencia, 2025);
});

test('§10: um número de telefone não é um efetivo', () => {
  /* Caso real, apanhado a rever o benchmark: a página da Begdonstroi diz
     "Dep. Comercial / Técnico: 912 528 106" e saíam 912 funcionários. Um
     rótulo de departamento vem no singular; uma contagem vem no plural.
     E um número seguido de mais grupos de dígitos é um contacto. */
  for (const t of ['Dep. Administrativo: 219 820 680 Dep. Comercial / Técnico: 912 528 106',
                   'Telefone: 219 820 680', 'Técnico: 912', 'Contacto pessoas: 912 528 106']) {
    assert.deepEqual(extrairFuncionarios(t), [], t);
  }
  /* e o plural com contagem continua a passar */
  assert.equal(primeiro(extrairFuncionarios('Técnicos: 12')).valor, 12);
  assert.equal(primeiro(extrairFuncionarios('Número de funcionários: 120')).valor, 120);
});

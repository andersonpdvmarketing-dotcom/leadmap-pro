/**
 * LeadMap Pro — motor de evidências e modos de correspondência
 * ============================================================
 *   node --test tests/company-evidence.test.mjs
 *
 * A mudança que estes testes protegem: a pergunta "esta empresa tem 30+
 * funcionários?" tem TRÊS respostas, não duas. Sim, não, e não se sabe.
 *
 * Um motor que só conheça as duas primeiras é obrigado a tratar a
 * ignorância como um "não", e apaga do ecrã as empresas que ainda valia
 * a pena investigar. Sem fornecedor configurado, apaga-as a todas — e o
 * utilizador conclui que a aplicação está avariada.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  STATUS_CRITERIO, MODO, MODOS_VALIDOS, MATCH, QUALIDADE,
  avaliarCriterioNumerico, avaliarCriterioTexto, classificarMatch,
  avaliarEmpresa, filtrosEmpresaVazios, ordenarPorEvidencia, estadosAceites
} from '../providers/company/filters.mjs';
import {
  ESTADO_DADO, TIPO_FONTE, CUSTO_FONTE, AUTORIDADE_FONTE, CAMPOS,
  envelope, envelopeVazio, semDadosEmpresa, lerEmpresa, evidencia, pesoEvidencia,
  escolherPrincipal, comEvidencia, evidenciasDe, mesmoValor, temValor,
  CompanyProviderError
} from '../providers/company/contract.mjs';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const AGORA = new Date().toISOString();
const conf = v => envelope({ valor: v, fonte: 'p', consultadoEm: AGORA, confianca: 1, estado: 'CONFIRMADO' });
const est  = v => envelope({ valor: v, fonte: 'p', consultadoEm: AGORA, confianca: 0.5, estado: 'ESTIMADO' });
const naoEnc = envelope({ estado: 'NAO_ENCONTRADO' });
const naoCon = envelopeVazio();

const emp = (o = {}) => ({ ...semDadosEmpresa(), ...o });
const filtros = (o = {}) => ({ ...filtrosEmpresaVazios(), ...o });
const TRES = { minFuncionarios: 30, minFaturacaoAnual: 1000000, minCapitalSocial: 50000 };

const ev = (valor, tipoFonte, estado = 'CONFIRMADO', confianca = 0.9, consultadoEm = AGORA) =>
  evidencia({ valor, fonte: 'f', url: 'https://exemplo.pt', consultadoEm, confianca, estado, tipoFonte });

/* ================================================================ *
 * desconhecido != não cumpre                                        *
 * ================================================================ */

test('desconhecido NÃO é a mesma coisa que não cumpre', () => {
  assert.equal(avaliarCriterioNumerico(naoCon, 30), STATUS_CRITERIO.DESCONHECIDO);
  assert.equal(avaliarCriterioNumerico(naoEnc, 30), STATUS_CRITERIO.DESCONHECIDO);
  assert.equal(avaliarCriterioNumerico(conf(5), 30), STATUS_CRITERIO.NAO_CUMPRE);
  assert.notEqual(STATUS_CRITERIO.DESCONHECIDO, STATUS_CRITERIO.NAO_CUMPRE);
});

test('confirmado acima do mínimo = CUMPRE', () => {
  assert.equal(avaliarCriterioNumerico(conf(47), 30), STATUS_CRITERIO.CUMPRE);
  assert.equal(avaliarCriterioNumerico(conf(30), 30), STATUS_CRITERIO.CUMPRE, 'o limite é inclusivo');
});

test('confirmado abaixo do mínimo = NAO_CUMPRE', () => {
  assert.equal(avaliarCriterioNumerico(conf(29), 30), STATUS_CRITERIO.NAO_CUMPRE);
  assert.equal(avaliarCriterioNumerico(conf(0), 30), STATUS_CRITERIO.NAO_CUMPRE);
});

test('um valor que não se percebe é desconhecido, não uma falha', () => {
  assert.equal(avaliarCriterioNumerico(conf('muitos'), 30), STATUS_CRITERIO.DESCONHECIDO);
  assert.equal(avaliarCriterioNumerico(conf(NaN), 30), STATUS_CRITERIO.DESCONHECIDO);
});

test('estimado conforme a qualidade escolhida', () => {
  assert.equal(avaliarCriterioNumerico(est(47), 30, QUALIDADE.CONFIRMADO_ESTIMADO), STATUS_CRITERIO.CUMPRE);
  assert.equal(avaliarCriterioNumerico(est(5), 30, QUALIDADE.CONFIRMADO_ESTIMADO), STATUS_CRITERIO.NAO_CUMPRE);
  /* em "só confirmados" a estimativa não é uma falha: é insuficiente */
  assert.equal(avaliarCriterioNumerico(est(47), 30, QUALIDADE.CONFIRMADO), STATUS_CRITERIO.DESCONHECIDO);
  assert.equal(avaliarCriterioNumerico(est(5), 30, QUALIDADE.CONFIRMADO), STATUS_CRITERIO.DESCONHECIDO,
    'sem crédito no dado não se pode afirmar que falha');
});

test('CAE segue a mesma semântica de três estados', () => {
  assert.equal(avaliarCriterioTexto(conf('41200'), '412'), STATUS_CRITERIO.CUMPRE);
  assert.equal(avaliarCriterioTexto(conf('41200'), '99999'), STATUS_CRITERIO.NAO_CUMPRE);
  assert.equal(avaliarCriterioTexto(naoCon, '41200'), STATUS_CRITERIO.DESCONHECIDO);
  assert.equal(avaliarCriterioTexto(conf('Construção de edifícios'), 'construcao'), STATUS_CRITERIO.CUMPRE);
});

/* ================================================================ *
 * Modos                                                             *
 * ================================================================ */

test('o modo por omissão é INTELIGENTE', () => {
  assert.equal(filtrosEmpresaVazios().modoCorrespondencia, MODO.INTELIGENTE);
  /* e um modo inválido cai no default em vez de rebentar */
  const r = avaliarEmpresa(emp(), filtros({ ...TRES, modoCorrespondencia: 'INVENTADO' }));
  assert.equal(r.modo, MODO.INTELIGENTE);
});

test('modo inteligente preserva desconhecidos', () => {
  const r = avaliarEmpresa(emp(), filtros({ ...TRES, modoCorrespondencia: MODO.INTELIGENTE }));
  assert.equal(r.passa, true, 'uma empresa por investigar não pode ser eliminada');
  assert.equal(r.match, MATCH.INCONCLUSIVO);
  assert.equal(r.desconhecidos, 3);
  assert.equal(r.naoCumpre, 0);
});

test('modo inteligente exclui quem comprovadamente falha', () => {
  const r = avaliarEmpresa(emp({ funcionarios: conf(5) }), filtros({ minFuncionarios: 30 }));
  assert.equal(r.passa, false);
  assert.equal(r.match, MATCH.NAO_CUMPRE);
});

test('modo estrito remove desconhecidos', () => {
  const f = filtros({ ...TRES, modoCorrespondencia: MODO.ESTRITO });
  assert.equal(avaliarEmpresa(emp(), f).passa, false);
  assert.equal(avaliarEmpresa(emp({ funcionarios: conf(47), capitalSocial: conf(75000) }), f).passa, false,
    'dois de três não chega no modo estrito');
  const tudo = emp({ funcionarios: conf(47), faturacaoAnual: conf(1800000), capitalSocial: conf(75000) });
  assert.equal(avaliarEmpresa(tudo, f).passa, true);
});

test('modo exploratório mantém todos', () => {
  const f = filtros({ ...TRES, modoCorrespondencia: MODO.EXPLORATORIO });
  for (const e of [emp(), emp({ funcionarios: conf(5) }), emp({ funcionarios: conf(47) })]) {
    assert.equal(avaliarEmpresa(e, f).passa, true);
  }
  /* mas continua a marcar honestamente o que se sabe */
  assert.equal(avaliarEmpresa(emp({ funcionarios: conf(5) }), f).match, MATCH.NAO_CUMPRE);
});

test('o exemplo do briefing: 2 cumpre, 0 não cumpre, 1 desconhecido', () => {
  const e = emp({ funcionarios: conf(47), capitalSocial: conf(75000) });   /* faturação por consultar */
  const r = avaliarEmpresa(e, filtros(TRES));
  assert.equal(r.confirmados, 2);
  assert.equal(r.naoCumpre, 0);
  assert.equal(r.desconhecidos, 1);
  assert.equal(r.match, MATCH.PARCIAL);
  assert.equal(r.passa, true, 'no modo inteligente esta empresa não é descartada');
  assert.deepEqual(r.status, {
    funcionarios: 'CUMPRE', faturacaoAnual: 'DESCONHECIDO', capitalSocial: 'CUMPRE'
  });
});

test('sem critérios nenhum modo altera nada', () => {
  for (const m of MODOS_VALIDOS) {
    const r = avaliarEmpresa(emp(), filtros({ modoCorrespondencia: m }));
    assert.equal(r.passa, true, 'modo ' + m + ' filtrou sem critérios');
    assert.equal(r.total, 0);
  }
});

/* ================================================================ *
 * Match                                                             *
 * ================================================================ */

test('classificação de match', () => {
  const C = STATUS_CRITERIO;
  assert.equal(classificarMatch({ a: C.CUMPRE, b: C.CUMPRE }), MATCH.FORTE);
  assert.equal(classificarMatch({ a: C.CUMPRE, b: C.DESCONHECIDO }), MATCH.PARCIAL);
  assert.equal(classificarMatch({ a: C.DESCONHECIDO, b: C.DESCONHECIDO }), MATCH.INCONCLUSIVO);
  /* uma falha comprovada domina, mesmo com outros critérios cumpridos */
  assert.equal(classificarMatch({ a: C.CUMPRE, b: C.NAO_CUMPRE }), MATCH.NAO_CUMPRE);
  assert.equal(classificarMatch({}), MATCH.FORTE);
});

test('ausência não gera pontuação negativa absoluta', () => {
  const soDesconhecido = avaliarEmpresa(emp(), filtros(TRES));
  const umaFalha = avaliarEmpresa(emp({ funcionarios: conf(5) }), filtros(TRES));
  assert.equal(soDesconhecido.match, MATCH.INCONCLUSIVO);
  assert.equal(umaFalha.match, MATCH.NAO_CUMPRE);
  assert.notEqual(soDesconhecido.match, umaFalha.match,
    'não saber não pode valer o mesmo que falhar');
});

test('ordenação por força de evidência', () => {
  const leads = [
    { id: 'nada', e: emp() },
    { id: 'tres', e: emp({ funcionarios: conf(47), faturacaoAnual: conf(2e6), capitalSocial: conf(75000) }) },
    { id: 'uma', e: emp({ funcionarios: conf(47) }) }
  ];
  const ordenados = ordenarPorEvidencia(leads, filtros(TRES), l => l.e);
  assert.deepEqual(ordenados.map(l => l.id), ['tres', 'uma', 'nada']);
});

test('sem critérios a ordenação não é tocada', () => {
  const leads = [{ id: 'a', e: emp() }, { id: 'b', e: emp() }];
  assert.deepEqual(ordenarPorEvidencia(leads, filtrosEmpresaVazios(), l => l.e).map(l => l.id), ['a', 'b']);
});

/* ================================================================ *
 * Evidências e conflito                                             *
 * ================================================================ */

test('uma evidência tem de declarar a origem', () => {
  const e = ev(42, TIPO_FONTE.SITE_OFICIAL);
  assert.equal(e.valor, 42);
  assert.equal(e.tipoFonte, 'SITE_OFICIAL');
  assert.equal(e.url, 'https://exemplo.pt');
  assert.throws(() => ev(42, 'INVENTADA'), /Tipo de fonte inválido/);
  assert.throws(() => evidencia({ valor: 42, fonte: 'f', consultadoEm: AGORA, estado: 'CONFLITO' }),
    /conclusão do motor/);
});

test('múltiplas evidências são preservadas, nenhuma é apagada', () => {
  let campo = envelopeVazio();
  campo = comEvidencia(campo, ev(42, TIPO_FONTE.DIRETORIO));
  campo = comEvidencia(campo, ev(51, TIPO_FONTE.API));
  campo = comEvidencia(campo, ev(47, TIPO_FONTE.PROVIDER_COMERCIAL));
  assert.equal(evidenciasDe(campo).length, 3, 'nenhuma evidência pode ser deitada fora');
  assert.deepEqual(evidenciasDe(campo).map(e => e.valor).sort(), [42, 47, 51]);
});

test('conflito entre fontes de crédito comparável', () => {
  const r = escolherPrincipal([ev(42, TIPO_FONTE.PROVIDER_COMERCIAL), ev(51, TIPO_FONTE.PROVIDER_COMERCIAL)]);
  assert.equal(r.conflito, true);
  assert.equal(r.envelope.estado, ESTADO_DADO.CONFLITO);
  assert.ok(r.envelope.valor != null, 'mesmo em conflito há um valor principal');
  assert.ok(r.envelope.confianca <= 0.5, 'um conflito por resolver baixa a confiança');
  assert.equal(r.evidencias.length, 2);
});

test('uma fonte claramente mais forte resolve, em vez de gerar conflito', () => {
  const r = escolherPrincipal([ev(42, TIPO_FONTE.DIRETORIO), ev(51, TIPO_FONTE.FONTE_OFICIAL)]);
  assert.equal(r.conflito, false);
  assert.equal(r.envelope.valor, 51, 'o registo oficial ganha ao diretório');
  assert.equal(r.envelope.estado, ESTADO_DADO.CONFIRMADO);
});

test('valores próximos não são desacordo', () => {
  assert.equal(mesmoValor(47, 50), true, '10% de diferença é ruído de medição');
  assert.equal(mesmoValor(42, 51), false);
  assert.equal(mesmoValor('41200', '41200'), true);
  const r = escolherPrincipal([ev(47, TIPO_FONTE.API), ev(50, TIPO_FONTE.API)]);
  assert.equal(r.conflito, false);
});

test('a autoridade da fonte ordena as evidências', () => {
  assert.ok(AUTORIDADE_FONTE.FONTE_OFICIAL > AUTORIDADE_FONTE.DIRETORIO);
  assert.ok(AUTORIDADE_FONTE.SITE_OFICIAL > AUTORIDADE_FONTE.PROVIDER_COMERCIAL);
  assert.ok(pesoEvidencia(ev(1, TIPO_FONTE.FONTE_OFICIAL)) > pesoEvidencia(ev(1, TIPO_FONTE.OUTRO)));
  /* declarado vale mais do que modelado, com tudo o resto igual */
  assert.ok(pesoEvidencia(ev(1, TIPO_FONTE.API, 'CONFIRMADO')) > pesoEvidencia(ev(1, TIPO_FONTE.API, 'ESTIMADO')));
});

test('um dado antigo pesa menos do que um recente', () => {
  const velho = new Date(Date.now() - 6 * 365.25 * 24 * 3600 * 1000).toISOString();
  assert.ok(pesoEvidencia(ev(1, TIPO_FONTE.API, 'CONFIRMADO', 0.9, AGORA)) >
            pesoEvidencia(ev(1, TIPO_FONTE.API, 'CONFIRMADO', 0.9, velho)));
});

test('CONFLITO tem valor mas não conta como confirmado', () => {
  const emConflito = envelope({ valor: 51, fonte: 'f', consultadoEm: AGORA, confianca: 0.5, estado: 'CONFLITO' });
  assert.equal(temValor(emConflito), true);
  assert.equal(avaliarCriterioNumerico(emConflito, 30, QUALIDADE.CONFIRMADO), STATUS_CRITERIO.DESCONHECIDO);
  assert.equal(avaliarCriterioNumerico(emConflito, 30, QUALIDADE.CONFIRMADO_ESTIMADO), STATUS_CRITERIO.DESCONHECIDO);
  assert.equal(avaliarCriterioNumerico(emConflito, 30, QUALIDADE.TODOS), STATUS_CRITERIO.CUMPRE);
  assert.ok(estadosAceites(QUALIDADE.TODOS).includes('CONFLITO'));
});

test('sem evidências o campo fica por consultar', () => {
  const r = escolherPrincipal([]);
  assert.equal(r.envelope.estado, 'NAO_CONSULTADO');
  assert.equal(r.conflito, false);
});

/* ================================================================ *
 * Retrocompatibilidade com a Fase 1                                 *
 * ================================================================ */

test('um envelope da Fase 1, sem evidencias[], continua a funcionar', () => {
  const fase1 = { valor: '501234560', fonte: 'https://x.pt', consultadoEm: AGORA, confianca: 0.9, estado: 'CONFIRMADO' };
  assert.deepEqual(evidenciasDe(fase1), [], 'sem evidências, mas sem rebentar');
  assert.equal(temValor(fase1), true);
  const lead = { empresa: { nif: fase1 } };
  assert.equal(lerEmpresa(lead).nif.valor, '501234560');
});

test('snapshot da Fase 1 sem campo empresa', () => {
  const e = lerEmpresa({ id: 'g-velho', nome: 'Antiga' });
  for (const c of CAMPOS) assert.equal(e[c].estado, 'NAO_CONSULTADO');
  /* e no modo inteligente sobrevive à filtragem */
  assert.equal(avaliarEmpresa(e, filtros(TRES)).passa, true);
});

test('acrescentar uma evidência a um envelope da Fase 1 não o destrói', () => {
  const fase1 = { valor: 40, fonte: 'site', consultadoEm: AGORA, confianca: 0.8, estado: 'CONFIRMADO' };
  const depois = comEvidencia(fase1, ev(42, TIPO_FONTE.API));
  assert.equal(evidenciasDe(depois).length, 1, 'a nova evidência entra');
  assert.ok(depois.valor != null);
  /* o envelope continua a ter a forma da Fase 1 */
  for (const k of ['valor', 'fonte', 'consultadoEm', 'confianca', 'estado']) {
    assert.ok(k in depois, 'perdeu o campo ' + k);
  }
});

/* ================================================================ *
 * Independência e custo dos providers                               *
 * ================================================================ */

test('a falha de um provider não derruba a investigação', async () => {
  const { CompanyProviderRouter } = await import('../providers/company/router.mjs');
  const { WebsiteCompanyProvider } = await import('../providers/company/website.mjs');
  const { MockCompanyProvider } = await import('../providers/company/mock.mjs');
  class Rebenta extends MockCompanyProvider {
    async _consultar() { throw new CompanyProviderError('PROVIDER_UNAVAILABLE', 'caiu'); }
  }
  const r = new CompanyProviderRouter({ providers: { mock: new Rebenta({}), website: new WebsiteCompanyProvider() } });
  await assert.rejects(() => r.consultar('mock', { nif: '501234560' }));
  /* o outro continua a responder */
  const ok = await r.consultar('website', { dominio: 'x.pt', html: '<p>NIPC: 501234560</p>', url: 'https://x.pt' });
  assert.equal(ok.success, true);
  assert.equal(ok.empresa.nif.valor, '501234560');
});

test('nenhuma fonte paga é chamada automaticamente', async () => {
  const { COMPANY_PROVIDER_TYPES } = await import('../providers/company/router.mjs');
  const { construirRouterEmpresarial } = await import('../providers/company/registry.mjs');
  /* nenhum provider comercial existe sequer */
  assert.deepEqual([...COMPANY_PROVIDER_TYPES], ['website', 'mock']);
  const prod = construirRouterEmpresarial({ OUTREACH_ENV: 'production' }, { comMock: true });
  assert.deepEqual(prod.listar(), ['website'], 'só a fonte gratuita fica em produção');
});

test('o vocabulário de custo existe para as fontes futuras', () => {
  assert.deepEqual(Object.keys(CUSTO_FONTE).sort(), ['FREEMIUM', 'GRATUITA', 'PAGA']);
});

test('sem provider nenhum o modo inteligente NÃO devolve zero resultados', () => {
  /* é o estado real de hoje: nenhum campo de porte tem fonte */
  const descobertas = [emp(), emp(), emp()];
  const f = filtros(TRES);
  const sobreviventes = descobertas.filter(e => avaliarEmpresa(e, f).passa);
  assert.equal(sobreviventes.length, 3,
    'a ausência de fornecedor não pode esvaziar a lista no modo inteligente');
});

/* ================================================================ *
 * O ecrã                                                            *
 * ================================================================ */

test('o ecrã não diverge do módulo nos estados de critério', () => {
  const m = HTML.match(/const STATUS_CRITERIO = \{([^}]+)\}/);
  assert.ok(m, 'STATUS_CRITERIO não encontrado no index.html');
  const chaves = [...m[1].matchAll(/(\w+):/g)].map(x => x[1]).sort();
  assert.deepEqual(chaves, Object.keys(STATUS_CRITERIO).sort());

  const mm = HTML.match(/const MODOS_EMPRESA = \[([^\]]+)\]/);
  assert.ok(mm, 'MODOS_EMPRESA não encontrado');
  const modos = mm[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).sort();
  assert.deepEqual(modos, [...MODOS_VALIDOS].sort());
});

test('o ecrã nunca afirma que cumpre o que não foi verificado', () => {
  const i = HTML.indexOf('function criteriosHtml');
  assert.ok(i > 0, 'criteriosHtml não encontrado');
  const corpo = HTML.slice(i, HTML.indexOf('function popupHtml', i));
  assert.ok(/informação não encontrada/.test(corpo),
    'um critério por investigar tem de o dizer, não desaparecer');
  assert.ok(/DESCONHECIDO/.test(corpo));
  assert.ok(/MATCH_ROTULO_EMPRESA/.test(corpo), 'falta o resumo do match');
});

test('o seletor de modo está na modal, com Inteligente por omissão', () => {
  const i = HTML.indexOf('id="opsModo"');
  assert.ok(i > 0, 'seletor de modo não encontrado');
  const bloco = HTML.slice(i, i + 420);
  assert.ok(/data-v="INTELIGENTE" aria-pressed="true"/.test(bloco), 'o default tem de ser Inteligente');
  for (const m of MODOS_VALIDOS) assert.ok(bloco.includes('data-v="' + m + '"'), 'falta o modo ' + m);
});

test('o aviso de falta de fonte distingue o modo estrito dos outros', () => {
  const i = HTML.indexOf('function actualizarSeccaoEmpresa');
  const corpo = HTML.slice(i, HTML.indexOf('function ligarSeccaoEmpresa'));
  assert.ok(/modoCorrespondencia === 'ESTRITO'/.test(corpo));
  assert.ok(/por investigar/.test(corpo),
    'nos modos não estritos as empresas ficam — o aviso tem de o dizer');
});

test('computeFiltered ordena por força de evidência fora do modo estrito', () => {
  const i = HTML.indexOf('function computeFiltered');
  const corpo = HTML.slice(i, HTML.indexOf('function socCell'));
  assert.ok(/forca/.test(corpo), 'falta a ordenação por evidência');
  assert.ok(/modoCorrespondencia !== 'ESTRITO'/.test(corpo));
  assert.ok(/state\.avaliacaoPorte\.set/.test(corpo), 'a avaliação tem de ficar disponível ao ecrã');
});

test('a leitura tolerante preserva as evidências', () => {
  /* sem isto o estado CONFLITO ficaria opaco: o ecrã diria "fontes
     divergem" e não teria como mostrar quais */
  const campo = comEvidencia(envelopeVazio(), ev(42, TIPO_FONTE.PROVIDER_COMERCIAL));
  const comDuas = comEvidencia(campo, ev(51, TIPO_FONTE.PROVIDER_COMERCIAL));
  const lido = lerEmpresa({ empresa: { funcionarios: comDuas } });
  assert.equal(evidenciasDe(lido.funcionarios).length, 2, 'lerEmpresa deitou fora as evidências');
  assert.equal(lido.funcionarios.estado, 'CONFLITO');
});

test('um campo sem evidências não ganha a chave por acidente', () => {
  const lido = lerEmpresa({ empresa: { nif: conf('501234560') } });
  assert.equal('evidencias' in lido.nif, false);
  assert.deepEqual(evidenciasDe(lido.nif), []);
});

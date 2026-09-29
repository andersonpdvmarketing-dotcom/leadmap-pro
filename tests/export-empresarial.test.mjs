/**
 * LeadMap Pro — exportação XLSX com inteligência empresarial
 * ==========================================================
 *   node --test tests/export-empresarial.test.mjs
 *
 * O código de exportação vive no bloco de script clássico do
 * `index.html`, que não é importável. É extraído daqui e avaliado — tal
 * como em `company-model.test.mjs` — para que o que se testa seja o
 * código que corre mesmo, e não uma cópia que pode divergir.
 *
 * O QUE ESTES TESTES DEFENDEM
 * ---------------------------
 * Um ficheiro de Excel é onde a informação do LeadMap vai parar quando
 * sai da aplicação. Se um capital social confirmado pelo registo e um
 * estimado por um agregador chegarem lá com o mesmo aspeto, quem decide
 * não tem como os distinguir — e decide mal. Daí as colunas de estado,
 * fonte e confiança ao lado de cada valor.
 *
 * E as 33 colunas originais têm de continuar no sítio: alguém pode ter
 * uma folha ou um import a depender da ordem delas.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CAMPOS, ESTADO_DADO, TIPO_FONTE } from '../providers/company/contract.mjs';
import { IDENTIDADE, SINAL } from '../providers/company/identidade.mjs';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* Guardas que leem código, não prosa: um comentário que explique porque
   é que NÃO se usa `!freeze` não pode fazer falhar o teste que
   verifica que `!freeze` não é usado. */
function semComentarios(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

function fatia(de, ate) {
  const i = HTML.indexOf(de);
  assert.ok(i > 0, 'não encontrei: ' + de);
  const j = HTML.indexOf(ate, i);
  assert.ok(j > i, 'não encontrei o fim: ' + ate);
  return HTML.slice(i, j);
}

/* ---------------------------------------------------------------- *
 * Extrair o código real, com o mínimo de encenação à volta           *
 * ---------------------------------------------------------------- */

const ND = 'N/D';
const SOCIAL_NETS = ['instagram', 'facebook', 'tiktok', 'youtube', 'linkedin'];

const FONTE = [
  'const ND = "N/D";',
  'const SOCIAL_NETS = ' + JSON.stringify(SOCIAL_NETS) + ';',
  'const CAMPOS_EMPRESA = ' + JSON.stringify(CAMPOS) + ';',
  'const ESTADOS_EMPRESA_COM_VALOR = ["CONFIRMADO","ESTIMADO","CONFLITO"];',
  'const ESTADOS_EMPRESA = ["CONFIRMADO","ESTIMADO","NAO_ENCONTRADO","NAO_CONSULTADO","CONFLITO"];',
  /* dependências que não são o objeto do teste */
  'function nichoLabel(l) { return (l.searchQueries && l.searchQueries[0]) || l.nicho || ""; }',
  'function fonteLabel(l) { return l.fonte; }',
  'function emptySocials() { const o = {}; for (const r of SOCIAL_NETS) o[r] = { url: null, found: false, source: null }; return o; }',
  'function getSocials(l) { const out = emptySocials(); if (!l) return out;',
  '  for (const r of SOCIAL_NETS) { const v = l.socials && l.socials[r];',
  '    if (v && v.found && v.url) out[r] = { url: v.url, found: true, source: v.source || null }; }',
  '  for (const r of ["instagram","facebook","linkedin"]) if (!out[r].found && l[r] && l[r] !== ND)',
  '    out[r] = { url: l[r], found: true, source: "fonte" }; return out; }',
  'function envelopeEmpresaVazio() { return { valor:null, fonte:null, consultadoEm:null, confianca:null, estado:"NAO_CONSULTADO" }; }',
  'function semDadosEmpresa() { const o = {}; for (const c of CAMPOS_EMPRESA) o[c] = envelopeEmpresaVazio();',
  '  o.identidade = identidadeEmpresaVazia(); return o; }',
  'function evidenciasDeEmpresa(campo) { return (campo && Array.isArray(campo.evidencias)) ? campo.evidencias : []; }',
  /* identidade empresarial (Fase 3.2) — o espelho define estes no bloco
     do modelo, fora da fatia que se extrai aqui */
  'const IDENTIDADES_EMPRESA = ' + JSON.stringify(Object.keys(IDENTIDADE)) + ';',
  'const SINAIS_POSITIVOS_EMPRESA = ["NOME_EXATO","NOME_NORMALIZADO","TOKEN_DISTINTIVO",',
  '  "FIRMA_NO_SITE","DOMINIO_COMPATIVEL","NIF_CONTEXTUAL","CONTEXTO_LEGAL"];',
  'function identidadeEmpresaVazia() { return { estado:"NAO_VERIFICADA", confianca:null, nif:null,',
  '  nomeLead:null, firmaOficial:null, dominio:null, sinais:[], conflitos:[], candidatos:[],',
  '  derivadosNaoAtribuidos:[], validadoEm:null }; }',
  'function getEmpresa(l) { const base = semDadosEmpresa(); const e = l && l.empresa;',
  '  if (!e || typeof e !== "object") return base;',
  '  const i = e.identidade;',
  '  if (i && typeof i === "object" && IDENTIDADES_EMPRESA.includes(i.estado))',
  '    base.identidade = Object.assign(identidadeEmpresaVazia(), i, { sinais: i.sinais || [],',
  '      conflitos: i.conflitos || [], candidatos: i.candidatos || [],',
  '      derivadosNaoAtribuidos: i.derivadosNaoAtribuidos || [] });',
  '  for (const c of CAMPOS_EMPRESA) { const v = e[c]; if (!v || typeof v !== "object") continue;',
  '    if (!ESTADOS_EMPRESA.includes(v.estado)) continue;',
  '    const cv = ESTADOS_EMPRESA_COM_VALOR.includes(v.estado); if (cv && v.valor == null) continue;',
  '    base[c] = { valor: cv ? v.valor : null, fonte: cv ? (v.fonte || null) : null,',
  '      consultadoEm: cv ? (v.consultadoEm || null) : null,',
  '      confianca: cv && typeof v.confianca === "number" ? v.confianca : null, estado: v.estado };',
  '    if (Array.isArray(v.evidencias) && v.evidencias.length) base[c].evidencias = v.evidencias; }',
  '  return base; }',
  /* o código real da exportação */
  fatia('/* O @ do Instagram, extraído do URL', 'function leadsToRows'),
  fatia('function larguraDaColuna(nome)', 'function buildWorkbook'),
  'return { leadToExportRow, seguroParaFolha, dataExport, numeroExport, evidenciasLegiveis,'
  + ' sinaisIdentidadeTexto, derivadosBloqueadosTexto,',
  '  evidenciasJson, criteriosAtivosTexto, larguraDaColuna, celula };'
].join('\n');

const X = new Function(FONTE)();

/* ---------------------------------------------------------------- *
 * Fábrica                                                           *
 * ---------------------------------------------------------------- */

const AGORA = '2026-09-28T23:57:00.000Z';
const vaziosSoc = () => ({ instagram:{url:null,found:false,source:null}, facebook:{url:null,found:false,source:null},
  tiktok:{url:null,found:false,source:null}, youtube:{url:null,found:false,source:null}, linkedin:{url:null,found:false,source:null} });
const semEmp = () => { const o = {}; for (const c of CAMPOS) o[c] = { valor:null, fonte:null, consultadoEm:null, confianca:null, estado:'NAO_CONSULTADO' }; return o; };
const comIdent = (ident) => ({ ...semEmp(), identidade: ident });

const ev = (valor, fonte, tipoFonte, url, estado = 'CONFIRMADO', confianca = 0.9) =>
  ({ valor, fonte, url, consultadoEm: AGORA, confianca, estado, tipoFonte });

const env = (valor, fonte, estado, evs, confianca = 0.9) =>
  ({ valor, fonte, consultadoEm: AGORA, confianca, estado, ...(evs ? { evidencias: evs } : {}) });

function lead(over = {}) {
  return { id:'google-ChIJx', nome:'Clínica Açúcar & Canela, Lda', nicho:'saude', lat:41.55, lon:-8.42,
    segmento:'Clínica', morada:'Praça da Conceição, nº 3', codigoPostal:'4700-123', localidade:'Póvoa de Varzim',
    distrito:'Évora', concelho:'Setúbal', telefone:'253 123 456', telemovel:ND, website:'https://x.pt',
    instagram:ND, facebook:ND, linkedin:ND, distanciaKm:1.2, fonte:'Google Places', leadType:'BUSINESS',
    fontes:['google'], dataPesquisa:'2026-09-28', socials:vaziosSoc(), emails:[{email:'geral@x.pt'}],
    empresa: semEmp(), ...over };
}

const linha = (l, ctx = {}) => X.leadToExportRow(l, ctx);

/* As 33 colunas que já existiam, pela ordem exata. */
const ORIGINAIS = [
  'Empresa / Profissional','Atividade','Segmento','Tipo de lead','Morada','Código Postal','Localidade',
  'Concelho','Distrito','País','Telefone','Telemóvel','Email','Website','Instagram','Instagram @',
  'Facebook','LinkedIn','TikTok','YouTube','Latitude','Longitude','Distância (km)','Fonte','Place ID',
  'OSM ID','Google Maps','Pesquisa','Lead já capturada','Número de capturas','Primeira captura',
  'ID da pesquisa','Data da Pesquisa'
];

/* ================================================================ *
 * 32 — retrocompatibilidade                                         *
 * ================================================================ */

test('32: as 33 colunas originais continuam lá, na mesma ordem', () => {
  const cab = Object.keys(linha(lead()));
  assert.deepEqual(cab.slice(0, 33), ORIGINAIS,
    'alguém a consumir este ficheiro depende desta ordem');
});

test('32: as novas colunas vêm DEPOIS das originais', () => {
  const cab = Object.keys(linha(lead()));
  assert.ok(cab.length > 33, 'não foram acrescentadas colunas');
  for (const o of ORIGINAIS) assert.ok(cab.indexOf(o) < 33, o + ' saiu do bloco original');
});

test('33: todas as linhas têm o mesmo número de colunas', () => {
  const leads = [lead(), lead({ empresa: null }), { id:'x', nome:'mínimo' },
    lead({ empresa: { cae: env('86230','SICAE','CONFIRMADO',[ev('86230','SICAE','FONTE_OFICIAL','http://s.pt')]) } })];
  const rows = leads.map(l => linha(l));
  const n = Object.keys(rows[0]).length;
  for (const r of rows) assert.equal(Object.keys(r).length, n);
});

/* ================================================================ *
 * 1, 22, 23 — snapshots                                             *
 * ================================================================ */

test('1/22: lead antigo sem campo empresa não quebra a exportação', () => {
  const antigo = { id:'google-velho', nome:'Padaria Antiga', nicho:'padaria', lat:41, lon:-8,
    segmento:'S', morada:'R', codigoPostal:'4700-000', localidade:'Braga', distrito:'Braga',
    concelho:'Braga', telefone:ND, telemovel:ND, website:ND, instagram:ND, facebook:ND, linkedin:ND,
    distanciaKm:1, fonte:'OpenStreetMap', fontes:['osm'], dataPesquisa:'2026-09-01' };
  const r = linha(antigo);
  assert.equal(r['Empresa / Profissional'], 'Padaria Antiga');
  for (const rot of ['NIF / NIPC', 'CAE', 'Capital social (€)', 'Funcionários', 'Faturação anual (€)']) {
    assert.equal(r[rot], '', rot + ' devia estar vazio');
    assert.equal(r[rot + ' — Estado'], 'NAO_CONSULTADO', 'o estado tem de dizer que ninguém procurou');
    assert.equal(r[rot + ' — Nº evidências'], 0);
  }
  assert.equal(r['Evidências empresariais'], '');
  assert.equal(r['Evidências JSON'], '');
});

test('23: snapshot novo com empresa e evidências exporta tudo', () => {
  const r = linha(lead({ empresa: { ...semEmp(),
    nif: env('508459451','Website oficial','CONFIRMADO',[ev('508459451','Website oficial','SITE_OFICIAL','https://x.pt/contactos')]) } }));
  assert.equal(r['NIF / NIPC'], '508459451');
  assert.equal(r['NIF / NIPC — Estado'], 'CONFIRMADO');
  assert.equal(r['NIF / NIPC — URL'], 'https://x.pt/contactos');
  assert.equal(r['NIF / NIPC — Tipo de fonte'], 'SITE_OFICIAL');
});

/* ================================================================ *
 * 2 a 8 — campos empresariais                                       *
 * ================================================================ */

test('3: CAE do SICAE chega com fonte oficial', () => {
  const r = linha(lead({ empresa: { ...semEmp(),
    cae: env('86230','SICAE','CONFIRMADO',[ev('86230','SICAE','FONTE_OFICIAL','http://www.sicae.pt/Consulta.aspx')]) } }));
  assert.equal(r['CAE'], '86230');
  assert.equal(r['CAE — Fonte'], 'SICAE');
  assert.equal(r['CAE — Tipo de fonte'], TIPO_FONTE.FONTE_OFICIAL);
  assert.equal(r['CAE — Confiança'], 90);
});

test('5/6: capital social de um milhão continua um milhão, e é número', () => {
  /* o caso real que obrigou a corrigir o separador de milhares */
  const r = linha(lead({ empresa: { ...semEmp(),
    capitalSocial: env(1000000,'Website oficial','CONFIRMADO',[ev(1000000,'Website oficial','SITE_OFICIAL','https://x.pt/termos',undefined,0.75)],0.75) } }));
  assert.equal(r['Capital social (€)'], 1000000);
  assert.equal(typeof r['Capital social (€)'], 'number', 'string não soma nem ordena no Excel');
  assert.equal(r['Capital social (€) — Confiança'], 75);
});

test('7/8: funcionários e faturação saem como números', () => {
  const r = linha(lead({ empresa: { ...semEmp(),
    funcionarios: env(47,'Website oficial','CONFIRMADO'),
    faturacaoAnual: env(2400000,'Website oficial','CONFIRMADO') } }));
  assert.equal(r['Funcionários'], 47);
  assert.equal(r['Faturação anual (€)'], 2400000);
  assert.equal(typeof r['Funcionários'], 'number');
  assert.equal(typeof r['Faturação anual (€)'], 'number');
});

test('9/10: estimado e confirmado distinguem-se, e o número continua número', () => {
  const r = linha(lead({ empresa: { ...semEmp(),
    funcionarios: env(120,'Website oficial','ESTIMADO', null, 0.6) } }));
  assert.equal(r['Funcionários'], 120, 'o valor continua utilizável para filtros');
  assert.equal(r['Funcionários — Estado'], 'ESTIMADO', 'mas a folha diz que é estimativa');
  assert.equal(r['Funcionários — Confiança'], 60);
});

test('11/12: não consultado e não encontrado são estados diferentes', () => {
  const r = linha(lead({ empresa: { ...semEmp(),
    capitalSocial: { valor:null, fonte:null, consultadoEm:null, confianca:null, estado:'NAO_ENCONTRADO' } } }));
  assert.equal(r['Capital social (€) — Estado'], 'NAO_ENCONTRADO', 'procurou-se e não há');
  assert.equal(r['Funcionários — Estado'], 'NAO_CONSULTADO', 'ninguém procurou');
  assert.notEqual(r['Capital social (€) — Estado'], r['Funcionários — Estado']);
  /* e nenhum dos dois vira zero */
  assert.equal(r['Capital social (€)'], '');
  assert.notEqual(r['Capital social (€)'], 0);
});

/* ================================================================ *
 * 13 a 16 — conflito e evidências                                   *
 * ================================================================ */

test('13/14: um conflito exporta o valor escolhido E as duas evidências', () => {
  const r = linha(lead({ empresa: { ...semEmp(), funcionarios: env(51,'Fornecedor comercial','CONFLITO', [
    ev(51,'Fornecedor comercial','PROVIDER_COMERCIAL','https://p.pt'),
    ev(42,'Diretório','DIRETORIO','https://d.pt')
  ], 0.5) } }));
  assert.equal(r['Funcionários'], 51);
  assert.equal(r['Funcionários — Estado'], 'CONFLITO');
  assert.equal(r['Funcionários — Nº evidências'], 2);
  assert.equal(r['Tem conflito'], 'SIM');
  assert.equal(r['Nº campos em conflito'], 1);
  const e = r['Evidências empresariais'];
  assert.ok(e.includes('51'), 'falta a afirmação vencedora');
  assert.ok(e.includes('42'), 'a evidência discordante desapareceu — sem ela não há auditoria');
});

test('15/16: cada evidência traz fonte, tipo, confiança, data e URL', () => {
  const r = linha(lead({ empresa: { ...semEmp(),
    cae: env('86230','SICAE','CONFIRMADO',[ev('86230','SICAE','FONTE_OFICIAL','http://www.sicae.pt/Consulta.aspx')]) } }));
  const e = r['Evidências empresariais'];
  assert.ok(e.includes('SICAE'));
  assert.ok(e.includes('FONTE_OFICIAL'));
  assert.ok(e.includes('90%'));
  assert.ok(e.includes('http://www.sicae.pt/Consulta.aspx'), 'a URL tem de sobreviver inteira');
  assert.ok(/\d{2}\/\d{2}\/\d{4}/.test(e), 'falta a data');
});

test('a coluna JSON é JSON válido, e vazia quando não há evidências', () => {
  const r = linha(lead({ empresa: { ...semEmp(),
    cae: env('86230','SICAE','CONFIRMADO',[ev('86230','SICAE','FONTE_OFICIAL','http://s.pt')]) } }));
  const j = JSON.parse(r['Evidências JSON']);
  assert.equal(j.cae[0].valor, '86230');
  assert.equal(j.cae[0].tipoFonte, 'FONTE_OFICIAL');
  assert.equal(linha(lead())['Evidências JSON'], '', 'sem evidências não se escreve "{}"');
});

/* ================================================================ *
 * 4 — match                                                         *
 * ================================================================ */

test('4: o match e os critérios chegam ao ficheiro', () => {
  const av = { total:3, match:'PARCIAL', modo:'INTELIGENTE', confirmados:1, desconhecidos:2, naoCumpre:0,
    status: { funcionarios:'DESCONHECIDO', faturacaoAnual:'DESCONHECIDO', capitalSocial:'CUMPRE' } };
  const f = { minFuncionarios:30, minFaturacaoAnual:1000000, minCapitalSocial:50000, caeQuery:'', estadoEmpresa:'' };
  const r = linha(lead(), { avaliacao: av, filtros: f, estadoInvestigacao:'ANALISADA' });
  assert.equal(r['Match empresarial'], 'PARCIAL');
  assert.equal(r['Modo de correspondência'], 'INTELIGENTE');
  assert.equal(r['Critérios ativos'], 'Funcionários >= 30 | Faturação >= 1000000 | Capital >= 50000');
  assert.equal(r['Critérios cumpridos'], 'Capital');
  assert.equal(r['Critérios desconhecidos'], 'Funcionários | Faturação');
  assert.equal(r['Critérios não cumpridos'], '');
  assert.equal(r['Nº critérios confirmados'], 1);
  assert.equal(r['Nº critérios total'], 3);
  assert.equal(r['Estado da investigação'], 'ANALISADA');
});

test('4: sem avaliação calculada não se inventa match', () => {
  const r = linha(lead());
  assert.equal(r['Match empresarial'], '');
  assert.equal(r['Modo de correspondência'], '');
  assert.equal(r['Nº critérios total'], '');
});

/* ================================================================ *
 * 26 — exportar a meio da investigação                              *
 * ================================================================ */

test('26: exportar durante INVESTIGANDO não finge que terminou', () => {
  const r = linha(lead(), { estadoInvestigacao: 'INVESTIGANDO' });
  assert.equal(r['Estado da investigação'], 'INVESTIGANDO');
  assert.equal(r['CAE — Estado'], 'NAO_CONSULTADO');
  assert.equal(r['CAE'], '');
});

/* ================================================================ *
 * 17 a 21 — higiene das células                                     *
 * ================================================================ */

test('19/20/21: nada de [object Object], undefined, NaN ou null', () => {
  const casos = [
    lead(), lead({ empresa: null }), lead({ empresa: 'texto' }), lead({ emails: null }),
    lead({ socials: undefined }), { id:'só-id' }, lead({ lat: NaN, lon: undefined, distanciaKm: null }),
    lead({ empresa: { ...semEmp(), cae: env('1','f','CONFIRMADO',[ev('1','f','API','https://a')]) } })
  ];
  for (const l of casos) {
    for (const [k, v] of Object.entries(linha(l))) {
      const s = String(v);
      assert.notEqual(s, '[object Object]', k);
      assert.notEqual(s, 'undefined', k);
      assert.notEqual(s, 'NaN', k);
      assert.notEqual(s, 'null', k);
    }
  }
});

test('17: valor inexistente é célula vazia, nunca zero', () => {
  const r = linha(lead());
  for (const rot of ['Capital social (€)', 'Funcionários', 'Faturação anual (€)']) {
    assert.equal(r[rot], '');
    assert.notEqual(r[rot], 0);
  }
});

test('18: arrays viram texto legível', () => {
  const r = linha(lead({ emails: [{email:'a@x.pt'},{email:'b@x.pt'}], fontes:['google','osm'],
    searchQueries:['clínicas','dentistas'] }));
  assert.equal(r['Email'], 'a@x.pt; b@x.pt');
  assert.equal(r['Fontes de descoberta'], 'google | osm');
  assert.equal(r['Pesquisa'], 'clínicas; dentistas');
  assert.equal(r['Emails encontrados'], 2);
});

/* ================================================================ *
 * 27 — acentos e 14 — números                                       *
 * ================================================================ */

test('27: acentuação portuguesa intacta', () => {
  const r = linha(lead());
  assert.equal(r['Empresa / Profissional'], 'Clínica Açúcar & Canela, Lda');
  assert.equal(r['Morada'], 'Praça da Conceição, nº 3');
  assert.equal(r['Localidade'], 'Póvoa de Varzim');
  assert.equal(r['Distrito'], 'Évora');
});

test('14/30: coordenadas e distância são números', () => {
  const r = linha(lead());
  for (const k of ['Latitude', 'Longitude', 'Distância (km)']) {
    assert.equal(typeof r[k], 'number', k + ' tem de ser número');
  }
});

/* ================================================================ *
 * 15 — datas                                                        *
 * ================================================================ */

test('15: datas em DD/MM/AAAA HH:mm, consistentes', () => {
  assert.match(X.dataExport('2026-09-28T23:57:00.000Z'), /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  assert.equal(X.dataExport(null), '');
  assert.equal(X.dataExport('não é data'), '');
  const r = linha(lead({ empresa: { ...semEmp(), cae: env('86230','SICAE','CONFIRMADO') } }));
  assert.match(r['CAE — Consultado em'], /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
});

/* ================================================================ *
 * 31 — segurança                                                    *
 * ================================================================ */

test('31: nenhuma credencial chega ao ficheiro', () => {
  const r = linha(lead({ empresa: { ...semEmp(), cae: env('86230','SICAE','CONFIRMADO',[ev('86230','SICAE','FONTE_OFICIAL','http://s.pt')]) } }),
    { avaliacao:{total:1,match:'FORTE',modo:'ESTRITO',confirmados:1,desconhecidos:0,status:{cae:'CUMPRE'}},
      filtros:{ caeQuery:'86230' } });
  const txt = JSON.stringify(r);
  for (const p of ['accessToken','apiKey','api_key','secret','password','cookie','authorization',
                   'bearer','verifyToken','appSecret','SUPABASE_SERVICE_ROLE','GOOGLE_API_KEY',
                   'META_','OPENAI_','ANTHROPIC_']) {
    assert.equal(new RegExp(p, 'i').test(txt), false, 'exportou ' + p);
  }
});

test('injeção de fórmula: neutralizada sem estragar telefones nem negativos', () => {
  assert.equal(X.seguroParaFolha('=HYPERLINK("http://mau")'), "'=HYPERLINK(\"http://mau\")");
  assert.equal(X.seguroParaFolha('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(X.seguroParaFolha('+CMD()'), "'+CMD()");
  /* estes têm de passar intactos: um telefone e um número negativo */
  assert.equal(X.seguroParaFolha('+351 253 123 456'), '+351 253 123 456');
  assert.equal(X.seguroParaFolha('-5'), '-5');
  assert.equal(X.seguroParaFolha('Clínica Açúcar'), 'Clínica Açúcar');
});

test('um nome malicioso é neutralizado na linha exportada', () => {
  const r = linha(lead({ nome: '=1+1' }));
  assert.equal(r['Empresa / Profissional'][0], "'", 'o Excel executaria isto');
});

/* ================================================================ *
 * 34 — contrato do schema                                           *
 * ================================================================ */

test('34: todos os campos empresariais do modelo têm colunas de exportação', () => {
  /* Se alguém acrescentar um campo ao contrato e esquecer a exportação,
     este teste falha — foi para isso que foi escrito. */
  const cab = Object.keys(linha(lead()));
  const ROT = { nif:'NIF / NIPC', cae:'CAE', capitalSocial:'Capital social (€)',
                funcionarios:'Funcionários', faturacaoAnual:'Faturação anual (€)' };
  for (const c of CAMPOS) {
    const rot = ROT[c];
    assert.ok(rot, 'campo sem rótulo de exportação: ' + c);
    for (const suf of ['', ' — Estado', ' — Fonte', ' — URL', ' — Consultado em',
                       ' — Confiança', ' — Tipo de fonte', ' — Nº evidências']) {
      assert.ok(cab.includes(rot + suf), 'falta a coluna: ' + rot + suf);
    }
  }
});

test('34: as facetas do envelope e do match estão representadas', () => {
  const cab = Object.keys(linha(lead())).join('|');
  for (const faceta of ['Estado', 'Fonte', 'URL', 'Consultado em', 'Confiança',
                        'Tipo de fonte', 'Nº evidências', 'Evidências empresariais',
                        'Evidências JSON', 'Match empresarial', 'Tem conflito']) {
    assert.ok(cab.includes(faceta), 'falta representação de: ' + faceta);
  }
});

test('34: todos os estados do modelo podem aparecer na coluna de estado', () => {
  for (const estado of Object.keys(ESTADO_DADO)) {
    const comValor = ['CONFIRMADO', 'ESTIMADO', 'CONFLITO'].includes(estado);
    const r = linha(lead({ empresa: { ...semEmp(), cae: comValor
      ? env('86230','f',estado) : { valor:null, fonte:null, consultadoEm:null, confianca:null, estado } } }));
    assert.equal(r['CAE — Estado'], estado, 'o estado ' + estado + ' não sobrevive à exportação');
  }
});

/* ================================================================ *
 * 26 — qualidade da folha                                           *
 * ================================================================ */

test('a largura das colunas é derivada do cabeçalho, não de uma lista à mão', () => {
  assert.ok(X.larguraDaColuna('Evidências empresariais') >= 50, 'texto longo precisa de espaço');
  assert.ok(X.larguraDaColuna('Latitude') <= 12);
  assert.ok(X.larguraDaColuna('CAE — Nº evidências') <= 20);
  /* e nunca devolve algo absurdo */
  for (const n of Object.keys(linha(lead()))) {
    const w = X.larguraDaColuna(n);
    assert.ok(Number.isFinite(w) && w >= 10 && w <= 60, 'largura inválida para ' + n);
  }
});

test('o ficheiro sai com filtro automático e larguras por coluna', () => {
  /* Estas duas foram confirmadas no artefacto, não só no código: o .xlsx
     gerado, descompactado, traz <autoFilter ref="A1:CM4"/> e 91 <col>.
     Não se afirma nada sobre congelar a primeira linha — a build
     community do SheetJS não escreve <pane>, e um teste que verificasse
     a linha no código enquanto o ficheiro sai sem ela não provava nada. */
  const src = semComentarios(fatia('function buildWorkbook(list, opts = {})', 'function ensureXlsx'));
  assert.ok(/!autofilter/.test(src));
  assert.ok(/larguraDaColuna/.test(src));
  assert.equal(/!freeze/.test(src), false, 'o SheetJS CE ignora !freeze — não prometer o que o ficheiro não cumpre');
});

test('XLSX e CSV usam a mesma representação', () => {
  const csv = fatia('function exportCsv(list, opts = {})', 'async function exportLeads');
  assert.ok(/leadsToRows\(list, opts\)/.test(csv), 'o CSV tem de partilhar o schema');
  const xlsx = fatia('function buildWorkbook(list, opts = {})', 'function ensureXlsx');
  assert.ok(/leadsToRows\(list, opts\)/.test(xlsx));
});

test('o schema é explícito, não Object.keys(lead)', () => {
  const src = semComentarios(fatia('function leadToExportRow(l, contexto = {})', 'function leadsToRows'));
  assert.equal(/Object\.keys\(l\)|Object\.entries\(l\)/.test(src), false,
    'percorrer as chaves do lead faria as colunas mudarem sozinhas e podia exportar campos internos');
});

/* ================================================================ *
 * Identidade empresarial na exportação (Fase 3.2)                   *
 * ================================================================ */

const identReal = {
  estado: IDENTIDADE.CONFLITO, confianca: 0, nif: '501135227',
  nomeLead: 'Clínica Onda de Sorrisos', firmaOficial: 'J. J. LOURO PEREIRA, S.A.',
  dominio: 'ondadesorrisos',
  sinais: [{ sinal: SINAL.NIF_CONTEXTUAL, peso: 0.15, detalhe: 'NIPC' },
           { sinal: SINAL.NOME_INCOMPATIVEL, peso: -0.45, detalhe: 'J. J. LOURO PEREIRA, S.A.' }],
  conflitos: ['O registo diz "J. J. LOURO PEREIRA, S.A.", que não corresponde ao lead.'],
  candidatos: [{ nif: '501135227', rotulo: 'NIPC', ocorrencias: 2 }],
  derivadosNaoAtribuidos: [{ campo: 'cae', valor: '31004', fonte: 'SICAE',
    url: 'http://www.sicae.pt/Consulta.aspx', motivo: 'CONFLITO' }],
  validadoEm: AGORA
};

test('23: as 91 colunas anteriores continuam nas 91 primeiras posições', () => {
  /* O bloco de identidade foi acrescentado ao FIM. Quem já consome este
     ficheiro não pode ver nada mexer-se. */
  const cab = Object.keys(linha(lead()));
  assert.equal(cab.length, 97, 'colunas: ' + cab.length);
  assert.deepEqual(cab.slice(0, 33), ORIGINAIS);
  for (const c of ['NIF / NIPC', 'CAE — Estado', 'Capital social (€)', 'Match empresarial',
                   'Evidências empresariais', 'Evidências JSON', 'Redes sociais encontradas']) {
    assert.ok(cab.indexOf(c) < 91, c + ' saiu do bloco das 91');
  }
  assert.equal(cab[90], 'Redes sociais encontradas', 'a 91.ª coluna mudou');
});

test('24: as colunas de identidade existem e vêm no fim', () => {
  const cab = Object.keys(linha(lead()));
  assert.deepEqual(cab.slice(91), [
    'Identidade empresarial — Estado',
    'Identidade empresarial — Confiança',
    'Firma oficial',
    'Identidade — Sinais',
    'Identidade — Conflitos',
    'Identidade — Dados não atribuídos'
  ]);
});

test('24: o caso real chega ao ficheiro com a firma e o motivo', () => {
  const r = linha(lead({ empresa: comIdent(identReal) }));
  assert.equal(r['Identidade empresarial — Estado'], 'CONFLITO');
  assert.equal(r['Identidade empresarial — Confiança'], 0);
  assert.equal(r['Firma oficial'], 'J. J. LOURO PEREIRA, S.A.');
  assert.ok(r['Identidade — Conflitos'].includes('J. J. LOURO PEREIRA'));
  const bloq = r['Identidade — Dados não atribuídos'];
  assert.ok(bloq.includes('CAE 31004'), 'o dado recusado tem de ficar registado');
  assert.ok(bloq.includes('identidade CONFLITO'), 'com o motivo');
  assert.ok(bloq.includes('sicae.pt'), 'e com a URL, para se poder confirmar à mão');
});

test('24: os sinais saem com + e - à frente', () => {
  const r = linha(lead({ empresa: comIdent(identReal) }));
  const s = r['Identidade — Sinais'];
  assert.ok(s.includes('+NIF_CONTEXTUAL'), s);
  assert.ok(s.includes('-NOME_INCOMPATIVEL'),
    'sem o sinal à frente, "firma não corresponde" lê-se como uma qualidade da empresa');
});

test('24: uma identidade confirmada não inventa conflitos nem bloqueios', () => {
  const r = linha(lead({ empresa: comIdent({
    ...identReal, estado: IDENTIDADE.CONFIRMADA, confianca: 1,
    firmaOficial: 'MEDIBRACARA - CENTRO MÉDICO LDA',
    sinais: [{ sinal: SINAL.NOME_EXATO, peso: 0.55, detalhe: 'MEDIBRACARA - CENTRO MÉDICO LDA' }],
    conflitos: [], derivadosNaoAtribuidos: []
  }) }));
  assert.equal(r['Identidade empresarial — Estado'], 'CONFIRMADA');
  assert.equal(r['Identidade empresarial — Confiança'], 100);
  assert.equal(r['Identidade — Conflitos'], '');
  assert.equal(r['Identidade — Dados não atribuídos'], '');
  assert.equal(typeof r['Identidade empresarial — Confiança'], 'number');
});

test('24: lead sem NIF não afirma identidade nenhuma', () => {
  const r = linha(lead());
  for (const c of ['Identidade empresarial — Estado', 'Identidade empresarial — Confiança',
                   'Firma oficial', 'Identidade — Sinais', 'Identidade — Conflitos',
                   'Identidade — Dados não atribuídos']) {
    assert.equal(r[c], '', c);
  }
});

test('24: snapshot antigo — identidade vazia, sem [object Object]', () => {
  const antigo = { id: 'google-velho', nome: 'Padaria Antiga',
    empresa: { cae: env('86230', 'SICAE', 'CONFIRMADO') } };
  const r = linha(antigo);
  assert.equal(r['Identidade empresarial — Estado'], '', 'sem NIF não se afirma estado');
  assert.equal(r['CAE'], '86230', 'o dado antigo não se apaga');
  for (const [k, v] of Object.entries(r)) {
    assert.notEqual(String(v), '[object Object]', k);
    assert.notEqual(String(v), 'undefined', k);
  }
});

test('24: uma firma maliciosa é neutralizada como qualquer outro texto', () => {
  const r = linha(lead({ empresa: comIdent({
    ...identReal, firmaOficial: '=HYPERLINK("http://mau","x")' }) }));
  assert.equal(r['Firma oficial'][0], "'");
});

test('24: as colunas de identidade não exportam nada de pessoal', () => {
  const r = linha(lead({ empresa: comIdent(identReal) }));
  const txt = [r['Identidade — Sinais'], r['Identidade — Conflitos'],
               r['Identidade — Dados não atribuídos'], r['Firma oficial']].join(' ');
  for (const p of ['residente', 'morada', 'gerente', 'sócio', 'socio', 'cartão de cidadão']) {
    assert.equal(new RegExp(p, 'i').test(txt), false, p);
  }
});

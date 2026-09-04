/**
 * LeadMap Pro — exportação das "Listas geradas"
 * =============================================
 *   node --test tests/export-listas.test.mjs
 *
 * O ficheiro descarregado a partir de "Listas geradas" saía sem email e
 * sem redes sociais. Havia duas causas, e os testes cobrem as duas:
 *
 *   1. O snapshot era gravado antes de o enriquecimento existir, e o
 *      IndexedDB serializa no momento da escrita — as mutações
 *      posteriores nunca lá chegavam.
 *   2. `leadsToRows` lia os campos legados planos e ignorava
 *      `l.socials`, onde vivem TikTok e YouTube (que não têm campo
 *      legado nenhum e por isso desapareciam sempre).
 *
 * As funções de exportação vivem dentro do `index.html`, num bloco de
 * script clássico. São extraídas daí e avaliadas — assim testa-se o
 * código que corre mesmo, e não uma cópia que pode divergir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* ---------------------------------------------------------------- *
 * Extrair as funções reais do index.html                            *
 * ---------------------------------------------------------------- */

function extrair(nome, ate) {
  const i = HTML.indexOf(nome);
  assert.ok(i > 0, 'não encontrei ' + nome + ' no index.html');
  const j = HTML.indexOf(ate, i);
  assert.ok(j > i, 'não encontrei o fim de ' + nome);
  return HTML.slice(i, j);
}

const FONTE = [
  'const ND = "N/D";',
  /* dependências que leadsToRows usa e que não são o objeto do teste */
  'const NICHES = { personalizado: { label: "Personalizado" }, padaria: { label: "Padarias" } };',
  'function nichoLabel(l) {',
  '  if (l.nicho === "personalizado" && l.searchQueries && l.searchQueries.length) return l.searchQueries[0];',
  '  return (NICHES[l.nicho] || NICHES.personalizado).label;',
  '}',
  'function fonteLabel(l) {',
  '  const f = Array.isArray(l.fontes) ? l.fontes : [];',
  '  if (f.length > 1) return "Google Places + OpenStreetMap";',
  '  return l.fonte;',
  '}',
  'function fmtDataHora(iso) { return iso ? String(iso) : ND; }',
  'const SOCIAL_NETS = ["instagram", "facebook", "tiktok", "youtube", "linkedin"];',
  extrair('function emptySocials()', 'const socialEnrichmentCache'),
  extrair('const celula =', 'function buildWorkbook'),
  'return { leadsToRows, instagramUsername, idsDaFonte, celula };'
].join('\n');

const { leadsToRows, instagramUsername, idsDaFonte } = new Function(FONTE)();

/* getSocials vem do bloco extraído (está entre emptySocials e o cache) */

/* ---------------------------------------------------------------- *
 * Fábrica de leads, com a forma exata de cleanLead()                *
 * ---------------------------------------------------------------- */

const ND = 'N/D';
const vazios = () => ({
  instagram: { url: null, found: false, source: null },
  facebook: { url: null, found: false, source: null },
  tiktok: { url: null, found: false, source: null },
  youtube: { url: null, found: false, source: null },
  linkedin: { url: null, found: false, source: null }
});

function lead(over = {}) {
  return {
    id: 'google-ChIJexemplo123', nicho: 'padaria', lat: 41.55, lon: -8.42,
    nome: 'Padaria Açúcar & Canela, Lda', segmento: 'Padaria',
    morada: 'Rua da Estação, 14', codigoPostal: '4700-123',
    localidade: 'Braga', distrito: 'Braga', concelho: 'Braga',
    telefone: '253 123 456', telemovel: ND,
    website: 'https://acucarecanela.pt',
    instagram: ND, facebook: ND, linkedin: ND,
    distanciaKm: 1.2, fonte: 'Google Places', leadType: 'BUSINESS',
    fontes: ['google'], dataPesquisa: '2026-09-04',
    socials: vazios(), emails: [],
    ...over
  };
}

const linha = l => leadsToRows([l])[0];

/* ================================================================ *
 * A — lead com email e Instagram                                    *
 * ================================================================ */

test('A: email e Instagram enriquecidos aparecem no ficheiro', () => {
  const s = vazios();
  s.instagram = { url: 'https://instagram.com/acucarecanela', found: true, source: 'website' };
  const r = linha(lead({ socials: s, emails: [{ email: 'geral@acucarecanela.pt' }] }));
  assert.equal(r['Email'], 'geral@acucarecanela.pt');
  assert.equal(r['Instagram'], 'https://instagram.com/acucarecanela');
  assert.equal(r['Instagram @'], '@acucarecanela');
});

test('A: vários emails saem todos, separados por ponto e vírgula', () => {
  const r = linha(lead({ emails: [{ email: 'a@x.pt' }, { email: 'b@x.pt' }] }));
  assert.equal(r['Email'], 'a@x.pt; b@x.pt');
});

/* ================================================================ *
 * B — Instagram sem email                                           *
 * ================================================================ */

test('B: Instagram sem email — a coluna Email fica vazia, não "N/D"', () => {
  const s = vazios();
  s.instagram = { url: 'https://www.instagram.com/panificadora/', found: true, source: 'website' };
  const r = linha(lead({ socials: s }));
  assert.equal(r['Instagram'], 'https://www.instagram.com/panificadora/');
  assert.equal(r['Instagram @'], '@panificadora');
  assert.equal(r['Email'], '');
});

/* ================================================================ *
 * C — email sem Instagram                                           *
 * ================================================================ */

test('C: email sem redes — as colunas sociais ficam vazias', () => {
  const r = linha(lead({ emails: [{ email: 'info@x.pt' }] }));
  assert.equal(r['Email'], 'info@x.pt');
  for (const c of ['Instagram', 'Instagram @', 'Facebook', 'LinkedIn', 'TikTok', 'YouTube']) {
    assert.equal(r[c], '', c + ' devia estar vazio');
  }
});

/* ================================================================ *
 * D — várias redes, incluindo as que se perdiam                     *
 * ================================================================ */

test('D: TikTok e YouTube são exportados — era o que se perdia sempre', () => {
  const s = vazios();
  s.instagram = { url: 'https://instagram.com/casa', found: true, source: 'website' };
  s.facebook = { url: 'https://facebook.com/casa', found: true, source: 'website' };
  s.tiktok = { url: 'https://tiktok.com/@casa', found: true, source: 'website' };
  s.youtube = { url: 'https://youtube.com/@casa', found: true, source: 'website' };
  s.linkedin = { url: 'https://linkedin.com/company/casa', found: true, source: 'website' };
  const r = linha(lead({ socials: s }));
  assert.equal(r['TikTok'], 'https://tiktok.com/@casa');
  assert.equal(r['YouTube'], 'https://youtube.com/@casa');
  assert.equal(r['Facebook'], 'https://facebook.com/casa');
  assert.equal(r['LinkedIn'], 'https://linkedin.com/company/casa');
});

test('D: TikTok e YouTube não têm campo legado — só o modelo normalizado os tem', () => {
  /* prova de que a leitura antiga (l.tiktok) nunca podia funcionar */
  const l = lead();
  assert.equal(l.tiktok, undefined);
  assert.equal(l.youtube, undefined);
});

/* ================================================================ *
 * E — lead sem redes nenhumas                                       *
 * ================================================================ */

test('E: lead sem redes continua a produzir uma linha válida', () => {
  const r = linha(lead());
  assert.equal(r['Empresa / Profissional'], 'Padaria Açúcar & Canela, Lda');
  assert.equal(r['Instagram'], '');
  assert.equal(r['Telemóvel'], '', 'N/D devia virar vazio');
  assert.equal(Object.keys(r).length, 33);
});

/* ================================================================ *
 * F/G — o ficheiro não depende do ecrã nem contacta ninguém          *
 * ================================================================ */

test('F: leadsToRows não lê state — o ficheiro não depende da pesquisa aberta', () => {
  const corpo = extrair('function leadsToRows', 'const LARGURAS_XLSX');
  assert.equal(/\bstate\./.test(corpo), false, 'leadsToRows voltou a ler state');
});

test('F: o id da geração vem de quem chama, não do ecrã', () => {
  const r = leadsToRows([lead()], { searchId: 'p-lista-de-ontem' })[0];
  assert.equal(r['ID da pesquisa'], 'p-lista-de-ontem');
  /* e o histórico do próprio lead ganha ao fallback */
  const comHist = leadsToRows(
    [lead({ historico: { estado: 'JA_CAPTURADA', firstSearchId: 'p-original', captureCount: 3 } })],
    { searchId: 'p-lista-de-ontem' })[0];
  assert.equal(comHist['ID da pesquisa'], 'p-original');
  assert.equal(comHist['Lead já capturada'], 'SIM');
  assert.equal(comHist['Número de capturas'], 3);
});

test('G: o download é puro — nenhuma chamada externa no caminho de exportação', () => {
  const corpo = extrair('function baixarLista', 'async function renomearLista');
  for (const proibido of ['fetch(', 'enrichLead', 'startSocialEnrichment', 'startEmailEnrichment', 'XMLHttpRequest']) {
    assert.equal(corpo.includes(proibido), false, 'baixarLista faz ' + proibido);
  }
  assert.ok(corpo.includes('lerSnapshot'), 'baixarLista devia ler o snapshot');
});

test('G: leadsToRows não contacta nada', () => {
  const corpo = extrair('function leadsToRows', 'const LARGURAS_XLSX');
  for (const proibido of ['fetch(', 'XMLHttpRequest', 'import(']) {
    assert.equal(corpo.includes(proibido), false);
  }
});

/* ================================================================ *
 * H — snapshots antigos                                             *
 * ================================================================ */

test('H: snapshot antigo sem .socials continua exportável', () => {
  const antigo = lead();
  delete antigo.socials;
  delete antigo.emails;
  const r = linha(antigo);
  assert.equal(r['Instagram'], '');
  assert.equal(r['Email'], '');
  assert.equal(r['Empresa / Profissional'], 'Padaria Açúcar & Canela, Lda');
});

test('H: campos legados vindos da fonte continuam a ser exportados', () => {
  const antigo = lead({ instagram: 'https://instagram.com/legado', facebook: 'https://facebook.com/legado' });
  delete antigo.socials;
  const r = linha(antigo);
  assert.equal(r['Instagram'], 'https://instagram.com/legado');
  assert.equal(r['Instagram @'], '@legado');
  assert.equal(r['Facebook'], 'https://facebook.com/legado');
});

test('H: o modelo normalizado ganha ao legado quando ambos existem', () => {
  const s = vazios();
  s.instagram = { url: 'https://instagram.com/novo', found: true, source: 'website' };
  const r = linha(lead({ socials: s, instagram: 'https://instagram.com/antigo' }));
  assert.equal(r['Instagram'], 'https://instagram.com/novo');
});

/* ================================================================ *
 * I — volume                                                        *
 * ================================================================ */

test('I: 137 leads dão 137 linhas, todas com as mesmas 33 colunas', () => {
  const lista = Array.from({ length: 137 }, (_, i) => lead({ id: 'google-p' + i, nome: 'Lead ' + i }));
  const rows = leadsToRows(lista);
  assert.equal(rows.length, 137);
  const chaves = Object.keys(rows[0]).join('|');
  for (const r of rows) assert.equal(Object.keys(r).join('|'), chaves, 'colunas deslocadas');
});

/* ================================================================ *
 * J — acentos                                                       *
 * ================================================================ */

test('J: acentuação portuguesa sobrevive intacta', () => {
  const r = linha(lead({
    nome: 'Confeitaria São João — Açores, Lda',
    morada: 'Praça da Conceição, nº 3',
    localidade: 'Póvoa de Varzim', distrito: 'Évora', concelho: 'Setúbal'
  }));
  assert.equal(r['Empresa / Profissional'], 'Confeitaria São João — Açores, Lda');
  assert.equal(r['Morada'], 'Praça da Conceição, nº 3');
  assert.equal(r['Localidade'], 'Póvoa de Varzim');
  assert.equal(r['Distrito'], 'Évora');
  assert.equal(r['Concelho'], 'Setúbal');
});

/* ================================================================ *
 * @ do Instagram: determinístico, nunca inventado                   *
 * ================================================================ */

test('@: extraído só de URLs de perfil', () => {
  assert.equal(instagramUsername('https://instagram.com/exemplo'), '@exemplo');
  assert.equal(instagramUsername('https://www.instagram.com/exemplo/'), '@exemplo');
  assert.equal(instagramUsername('instagram.com/exemplo?hl=pt'), '@exemplo');
  assert.equal(instagramUsername('https://instagram.com/nome.com_ponto'), '@nome.com_ponto');
});

test('@: publicações e páginas internas não geram username', () => {
  for (const u of [
    'https://instagram.com/p/ABC123/',
    'https://instagram.com/reel/XYZ/',
    'https://instagram.com/explore/tags/pao/',
    'https://instagram.com/stories/alguem/123',
    'https://instagram.com/'
  ]) assert.equal(instagramUsername(u), '', u + ' não devia dar username');
});

test('@: outro domínio nunca produz username de Instagram', () => {
  assert.equal(instagramUsername('https://facebook.com/exemplo'), '');
  assert.equal(instagramUsername('https://instagram.com.falso.pt/exemplo'), '');
  assert.equal(instagramUsername(ND), '');
  assert.equal(instagramUsername(''), '');
});

/* ================================================================ *
 * Place ID / OSM ID: lidos do id, nunca inventados                  *
 * ================================================================ */

test('IDs: um lead da Google dá Place ID e um link de mapa', () => {
  const r = linha(lead({ id: 'google-ChIJN1t_tDeuEmsRUsoyG83frY4' }));
  assert.equal(r['Place ID'], 'ChIJN1t_tDeuEmsRUsoyG83frY4');
  assert.equal(r['OSM ID'], '');
  assert.ok(r['Google Maps'].includes('place_id:ChIJN1t_tDeuEmsRUsoyG83frY4'));
});

test('IDs: um lead do OSM dá OSM ID no formato tipo/número', () => {
  const r = linha(lead({ id: 'osm-node-240109189', fonte: 'OpenStreetMap', fontes: ['osm'] }));
  assert.equal(r['OSM ID'], 'node/240109189');
  assert.equal(r['Place ID'], '');
  assert.equal(r['Google Maps'], 'https://www.openstreetmap.org/node/240109189');
});

test('IDs: um id de outra forma não inventa nada', () => {
  const r = linha(lead({ id: 'demo-3' }));
  assert.equal(r['Place ID'], '');
  assert.equal(r['OSM ID'], '');
  assert.equal(r['Google Maps'], '');
});

/* ================================================================ *
 * País: só o que vier explícito                                     *
 * ---------------------------------------------------------------- *
 * Concelho e distrito não provam país. O modo Portugal delimita por *
 * bounding box, não pela fronteira política, e o próprio código     *
 * assume que as zonas de fronteira trazem empresas espanholas.      *
 * ================================================================ */

test('País: nunca inferido a partir de concelho ou distrito', () => {
  assert.equal(linha(lead())['País'], '', 'concelho e distrito portugueses não são prova de país');
  assert.equal(linha(lead({ concelho: ND, distrito: 'Faro' }))['País'], '');
  assert.equal(linha(lead({ concelho: 'Braga', distrito: 'Braga' }))['País'], '');
});

test('País: vazio quando não há nada', () => {
  assert.equal(linha(lead({ concelho: ND, distrito: ND }))['País'], '');
});

test('País: exportado quando vier explícito nos dados', () => {
  assert.equal(linha(lead({ pais: 'Portugal' }))['País'], 'Portugal');
  assert.equal(linha(lead({ country: 'España' }))['País'], 'España');
  /* o campo próprio ganha ao inglês da fonte */
  assert.equal(linha(lead({ pais: 'Portugal', country: 'Portugal (PT)' }))['País'], 'Portugal');
});

test('País: um valor vazio ou N/D não conta como explícito', () => {
  assert.equal(linha(lead({ pais: ND }))['País'], '');
  assert.equal(linha(lead({ pais: '   ' }))['País'], '');
  assert.equal(linha(lead({ pais: '', country: 'Portugal' }))['País'], 'Portugal');
});

test('País: nenhuma fonte preenche o campo hoje — a coluna sai vazia', () => {
  /* prova de que cleanLead() não cria país nenhum: se um dia criar,
     este teste falha e obriga a rever a regra */
  const modelo = HTML.slice(HTML.indexOf('function cleanLead'), HTML.indexOf('/* ---------- 5. Validação'));
  assert.equal(/\b(pais|country)\s*:/.test(modelo), false,
    'cleanLead passou a ter país — rever a regra da coluna País');
});

/* ================================================================ *
 * Persistência do enriquecimento no snapshot                        *
 * ================================================================ */

test('SNAPSHOT: o enriquecimento agenda a regravação do snapshot', () => {
  for (const fn of ['function applySocials', 'function applyEmails']) {
    const corpo = extrair(fn, '\n}\n');
    assert.ok(corpo.includes('agendarSincronizacaoSnapshot()'),
      fn + ' não agenda a regravação — o snapshot voltaria a ficar sem enriquecimento');
  }
});

test('SNAPSHOT: só a geração desta sessão pode ser regravada', () => {
  const corpo = extrair('async sincronizarEnriquecimento', '\n      },');
  assert.ok(corpo.includes('if (!snapshotVivo'), 'sem snapshotVivo não pode regravar nada');
  assert.ok(corpo.includes('snapshotVivo.ids.size'), 'falta a guarda pelo número de leads');
  assert.ok(corpo.includes('snapshotVivo.ids.has'), 'falta a guarda pelos ids');
});

test('SNAPSHOT: abrir uma lista antiga não a torna regravável', () => {
  const corpo = extrair('async function abrirLista', 'renderAll();');
  assert.ok(/snapshotVivo = null/.test(corpo),
    'abrirLista devia limpar snapshotVivo para não reescrever histórico');
});

test('SNAPSHOT: a regravação usa o mesmo store, sem novo pedido externo', () => {
  const corpo = extrair('async sincronizarEnriquecimento', '\n      },');
  assert.ok(corpo.includes('histStore.guardarSnapshot'), 'devia usar o store existente');
  assert.equal(/fetch\(|enrichLead/.test(corpo), false, 'a regravação não pode contactar ninguém');
});

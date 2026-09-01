/**
 * LeadMap Pro — testes do histórico de listas e capturas (v1.0.1)
 * ===============================================================
 *   node --test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chavesDeIdentidade, mesmaLead, normalizarSite, normalizarTelefone,
  normalizarInstagram, normalizarTexto
} from '../providers/history/identity.mjs';
import {
  IndiceCapturas, classificarLeads, nomeAutomatico, registoDePesquisa,
  renomear, contarCobertura, ESTADO_LEAD
} from '../providers/history/model.mjs';
import { LocalLeadHistoryStore, MemoryBackend } from '../providers/history/store.mjs';

const lead = (n, extra = {}) => ({
  id: 'L' + n, nome: 'Empresa ' + n, website: 'https://empresa' + n + '.pt',
  telefone: '21000' + String(1000 + n), codigoPostal: '1000-' + String(100 + n),
  localidade: 'Lisboa', ...extra
});

async function loja() {
  const s = new LocalLeadHistoryStore({ backend: new MemoryBackend() });
  await s.iniciar();
  return s;
}

/* ---------------------------------------------------------------- *
 * §33 Identidade                                                    *
 * ---------------------------------------------------------------- */

test('identidade: Place ID é a chave mais forte', () => {
  const c = chavesDeIdentidade({ id: 'ChIJabc123', nome: 'X', website: 'https://x.pt' });
  assert.equal(c[0], 'place:ChIJabc123');
});

test('identidade: OSM é reconhecido', () => {
  assert.ok(chavesDeIdentidade({ id: 'node/12345', nome: 'X' }).includes('osm:node/12345'));
});

test('identidade por website normalizado', () => {
  assert.equal(normalizarSite('https://www.Loja-X.pt/contactos?a=1'), 'loja-x.pt');
  assert.ok(mesmaLead({ website: 'https://loja.pt' }, { website: 'http://www.loja.pt/sobre' }));
});

test('identidade: hosts partilhados NÃO identificam um negócio', () => {
  for (const u of ['https://facebook.com/loja', 'https://instagram.com/loja', 'https://linktr.ee/loja', 'https://pai.pt/x']) {
    assert.equal(normalizarSite(u), null, u + ' não devia servir de identidade');
  }
  assert.equal(mesmaLead({ website: 'https://facebook.com/a' }, { website: 'https://facebook.com/b' }), false);
});

test('identidade por telefone normalizado', () => {
  assert.equal(normalizarTelefone('+351 912 345 678'), '912345678');
  assert.equal(normalizarTelefone('00351912345678'), '912345678');
  assert.equal(normalizarTelefone('123'), null);
  assert.ok(mesmaLead({ telefone: '+351 21 123 4567' }, { telemovel: '211234567' }));
});

test('identidade por Instagram normalizado', () => {
  assert.equal(normalizarInstagram('https://instagram.com/Loja_X/'), 'loja_x');
  assert.ok(mesmaLead({ instagram: '@Loja_X' }, { instagram: 'https://www.instagram.com/loja_x' }));
  assert.equal(normalizarInstagram('instagram.com/p/ABC'), null);
});

test('identidade por nome+CP exige AMBOS', () => {
  assert.deepEqual(chavesDeIdentidade({ nome: 'Padaria Central' }), []);
  assert.deepEqual(chavesDeIdentidade({ codigoPostal: '1000-001' }), []);
  assert.deepEqual(chavesDeIdentidade({ nome: 'Padaria Central', codigoPostal: '1000-001' }),
    ['nomecp:padaria central|1000-001']);
});

test('FALSO POSITIVO: nomes semelhantes NÃO são a mesma lead', () => {
  const pares = [
    [{ nome: 'Padaria Central', codigoPostal: '1000-001' }, { nome: 'Padaria Central', codigoPostal: '4000-002' }],
    [{ nome: 'Clínica Sorriso', codigoPostal: '1000-001' }, { nome: 'Clínica Sorrisos', codigoPostal: '1000-001' }],
    [{ nome: 'Café Lisboa', codigoPostal: '1000-001' }, { nome: 'Café Lisboa II', codigoPostal: '1000-001' }],
    [{ nome: 'Auto Silva', website: 'https://autosilva.pt' }, { nome: 'Auto Silva', website: 'https://auto-silva.pt' }]
  ];
  for (const [a, b] of pares) {
    assert.equal(mesmaLead(a, b), false, JSON.stringify(a.nome) + ' vs ' + JSON.stringify(b.nome));
  }
});

test('lead sem nenhum identificador não tem chaves — é sempre tratada como nova', () => {
  assert.deepEqual(chavesDeIdentidade({ nome: 'X' }), []);
  const idx = new IndiceCapturas();
  const r1 = classificarLeads([{ nome: 'X' }], idx, { searchId: 's1' });
  idx.carregar(r1.linhas);
  const r2 = classificarLeads([{ nome: 'X' }], idx, { searchId: 's2' });
  assert.equal(r2.jaCapturadas, 0);
});

test('normalizarTexto ignora acentos e pontuação', () => {
  assert.equal(normalizarTexto('Café  Açores, Lda.'), 'cafe acores lda');
});

/* ---------------------------------------------------------------- *
 * §32 Histórico de capturas                                         *
 * ---------------------------------------------------------------- */

test('primeira pesquisa: todas as leads são novas', () => {
  const idx = new IndiceCapturas();
  const r = classificarLeads([lead(1), lead(2), lead(3)], idx, { searchId: 's1' });
  assert.equal(r.novas, 3);
  assert.equal(r.jaCapturadas, 0);
  assert.ok(r.leads.every(l => l.historico.estado === ESTADO_LEAD.NOVA));
  assert.ok(r.leads.every(l => l.historico.captureCount === 1));
});

test('segunda pesquisa com sobreposição identifica as repetidas', () => {
  const idx = new IndiceCapturas();
  idx.carregar(classificarLeads([lead(1), lead(2), lead(3)], idx, { searchId: 's1' }).linhas);
  const r = classificarLeads([lead(2), lead(3), lead(9)], idx, { searchId: 's2' });
  assert.equal(r.novas, 1);
  assert.equal(r.jaCapturadas, 2);
  assert.equal(r.leads[0].historico.estado, ESTADO_LEAD.JA_CAPTURADA);
  assert.equal(r.leads[2].historico.estado, ESTADO_LEAD.NOVA);
});

test('§12 CRÍTICO: a mesma lead via Google e OSM na MESMA execução não é "já capturada"', () => {
  const idx = new IndiceCapturas();
  const viaGoogle = { id: 'ChIJx', nome: 'Loja', website: 'https://loja.pt', telefone: '211234567' };
  const viaOsm = { id: 'node/99', nome: 'Loja', website: 'https://loja.pt', telefone: '211234567' };
  const r = classificarLeads([viaGoogle, viaOsm], idx, { searchId: 's1' });
  assert.equal(r.jaCapturadas, 0, 'dedupe interno não pode contar como repetição histórica');
  assert.equal(r.novas, 1);
  assert.ok(r.leads.every(l => l.historico.estado === ESTADO_LEAD.NOVA));
  assert.ok(r.leads.every(l => l.historico.captureCount === 1));
});

test('§12: a mesma lead em várias células geográficas continua nova', () => {
  const idx = new IndiceCapturas();
  const mesma = () => ({ nome: 'Loja', website: 'https://loja.pt' });
  const r = classificarLeads([mesma(), mesma(), mesma()], idx, { searchId: 's1' });
  assert.equal(r.jaCapturadas, 0);
  assert.equal(r.novas, 1);
});

test('captureCount incrementa a cada pesquisa nova, e as datas evoluem', () => {
  const idx = new IndiceCapturas();
  let t = '2026-08-18T10:00:00.000Z';
  idx.carregar(classificarLeads([lead(1)], idx, { searchId: 's1', agora: () => t }).linhas);
  t = '2026-09-01T10:00:00.000Z';
  const r2 = classificarLeads([lead(1)], idx, { searchId: 's2', agora: () => t });
  idx.carregar(r2.linhas);
  t = '2026-09-05T10:00:00.000Z';
  const r3 = classificarLeads([lead(1)], idx, { searchId: 's3', agora: () => t });

  assert.equal(r2.leads[0].historico.captureCount, 2);
  assert.equal(r3.leads[0].historico.captureCount, 3);
  assert.equal(r3.leads[0].historico.firstCapturedAt, '2026-08-18T10:00:00.000Z');
  assert.equal(r3.leads[0].historico.firstSearchId, 's1');
  assert.equal(r3.leads[0].historico.lastCapturedAt, '2026-09-05T10:00:00.000Z');
});

test('lead reconhecida por uma chave diferente da usada antes', () => {
  const idx = new IndiceCapturas();
  /* 1ª vez: só com website */
  idx.carregar(classificarLeads([{ nome: 'Loja', website: 'https://loja.pt' }], idx, { searchId: 's1' }).linhas);
  /* 2ª vez: sem website, mas com o Instagram que entretanto foi descoberto...
     não pode ser reconhecida (chave nova), e isso é o comportamento seguro */
  const semLigacao = classificarLeads([{ nome: 'Loja', instagram: '@loja' }], idx, { searchId: 's2' });
  assert.equal(semLigacao.jaCapturadas, 0);
  /* mas se trouxer o website outra vez, é reconhecida */
  const comLigacao = classificarLeads([{ nome: 'Outro', website: 'https://loja.pt' }], idx, { searchId: 's3' });
  assert.equal(comLigacao.jaCapturadas, 1);
});

/* ---------------------------------------------------------------- *
 * Nome, metadados e resumo                                          *
 * ---------------------------------------------------------------- */

test('nome automático legível para Local e Portugal', () => {
  assert.equal(
    nomeAutomatico({ query: 'eletricistas', modo: 'local', localizacao: 'Lisboa', raioKm: 30, criadaEm: '2026-09-01T10:00:00Z' }),
    'Eletricistas — Lisboa — 30 km — 01/09/2026');
  assert.equal(
    nomeAutomatico({ query: 'arquitetos', modo: 'portugal', criadaEm: '2026-09-01T10:00:00Z' }),
    'Arquitetos — Portugal — 01/09/2026');
});

test('renomear passa a nome próprio e recusa vazio', () => {
  const meta = { id: 'p1', nome: 'A', nomeAutomatico: true };
  const r = renomear(meta, '  Minha lista  ');
  assert.equal(r.nome, 'Minha lista');
  assert.equal(r.nomeAutomatico, false);
  assert.throws(() => renomear(meta, '   '), /nome/);
});

test('registo de pesquisa guarda todos os campos exigidos', () => {
  const leads = [
    { ...lead(1), emails: [{ email: 'a@a.pt' }], instagram: '@a' },
    { ...lead(2), website: 'N/D', telefone: 'N/D', instagram: 'N/D' }
  ];
  const r = registoDePesquisa({
    id: 'p1', criadaEm: '2026-09-01T10:00:00Z', modo: 'local', query: 'eletricistas',
    localizacao: 'Lisboa', raioKm: 30, fontes: ['google', 'osm'],
    totalBruto: 50, leads, novas: 1, jaCapturadas: 1, estado: 'CONCLUIDA'
  });
  for (const campo of ['id','nome','criadaEm','modo','query','localizacao','raioKm','distrito','concelho',
                       'fontes','totalBruto','totalFinal','novas','jaCapturadas','comEmail','comTelefone',
                       'comWebsite','comInstagram','estado']) {
    assert.ok(campo in r, 'falta ' + campo);
  }
  assert.equal(r.totalFinal, 2);
  assert.equal(r.comEmail, 1);
  assert.equal(r.comInstagram, 1);
  assert.equal(r.comWebsite, 1);
});

test('contarCobertura não conta N/D como preenchido', () => {
  const c = contarCobertura([{ website: 'N/D', telefone: 'N/D', instagram: 'N/D', emails: [] }]);
  assert.deepEqual(c, { comEmail: 0, comTelefone: 0, comWebsite: 0, comInstagram: 0 });
});

/* ---------------------------------------------------------------- *
 * Armazenamento, snapshots e §25                                    *
 * ---------------------------------------------------------------- */

test('snapshot guardado é devolvido tal e qual', async () => {
  const s = await loja();
  const leads = [lead(1), lead(2), lead(3)];
  await s.guardarSnapshot('p1', leads);
  assert.deepEqual(await s.lerSnapshot('p1'), leads);
});

test('abrir lista antiga devolve o mesmo snapshot, não uma nova pesquisa', async () => {
  const s = await loja();
  const original = [lead(1), lead(2)];
  await s.guardarSnapshot('p1', original);
  await s.guardarPesquisa({ id: 'p1', nome: 'Lista', criadaEm: '2026-09-01T10:00:00Z', totalFinal: 2 });
  /* leads "novas" aparecem depois — o snapshot não muda */
  await s.guardarSnapshot('p2', [lead(3)]);
  assert.deepEqual(await s.lerSnapshot('p1'), original);
});

test('§25 apagar uma lista NÃO apaga o registo global de capturas', async () => {
  const s = await loja();
  const idx = new IndiceCapturas();
  const r = classificarLeads([lead(1), lead(2)], idx, { searchId: 'p1' });
  await s.guardarRegistos(r.linhas);
  await s.guardarPesquisa({ id: 'p1', nome: 'Lista', criadaEm: '2026-09-01T10:00:00Z' });
  await s.guardarSnapshot('p1', r.leads);

  await s.apagarPesquisa('p1');
  assert.equal((await s.listarPesquisas()).length, 0);
  assert.equal(await s.lerSnapshot('p1'), null);

  /* o registo global sobrevive: a lead continua a ser reconhecida */
  const idx2 = new IndiceCapturas(await s.carregarRegisto());
  const depois = classificarLeads([lead(1)], idx2, { searchId: 'p2' });
  assert.equal(depois.jaCapturadas, 1, 'apagar a lista não pode apagar a memória de captura');
});

test('§24 limpar o registo global é uma ação separada', async () => {
  const s = await loja();
  const idx = new IndiceCapturas();
  await s.guardarRegistos(classificarLeads([lead(1)], idx, { searchId: 'p1' }).linhas);
  await s.guardarPesquisa({ id: 'p1', nome: 'Lista', criadaEm: '2026-09-01T10:00:00Z' });

  await s.limparRegistoGlobal();
  assert.equal((await s.carregarRegisto()).size, 0);
  /* as listas guardadas não são afetadas */
  assert.equal((await s.listarPesquisas()).length, 1);

  const idx2 = new IndiceCapturas(await s.carregarRegisto());
  assert.equal(classificarLeads([lead(1)], idx2, { searchId: 'p2' }).jaCapturadas, 0);
});

test('listas são devolvidas da mais recente para a mais antiga', async () => {
  const s = await loja();
  await s.guardarPesquisa({ id: 'a', nome: 'A', criadaEm: '2026-08-01T10:00:00Z' });
  await s.guardarPesquisa({ id: 'c', nome: 'C', criadaEm: '2026-09-05T10:00:00Z' });
  await s.guardarPesquisa({ id: 'b', nome: 'B', criadaEm: '2026-09-01T10:00:00Z' });
  assert.deepEqual((await s.listarPesquisas()).map(l => l.id), ['c', 'b', 'a']);
});

test('sem persistência real, o aviso é explícito — nada é perdido em silêncio', async () => {
  const s = new LocalLeadHistoryStore({ backend: new MemoryBackend() });
  await s.iniciar();
  assert.match(s.avisoPersistencia, /memória/i);
});

test('§23 histórico não é cache: sobrevive a limpar leads e listas', async () => {
  const s = await loja();
  const idx = new IndiceCapturas();
  await s.guardarRegistos(classificarLeads([lead(1)], idx, { searchId: 'p1' }).linhas);
  await s.apagarPesquisa('p1');
  const idx2 = new IndiceCapturas(await s.carregarRegisto());
  assert.equal(idx2.tamanho, 1);
});

/* ---------------------------------------------------------------- *
 * §35/§36 Performance                                               *
 * ---------------------------------------------------------------- */

test('classificação de 3000 leads é rápida e sem comparação quadrática', async () => {
  const medidas = {};
  const idx = new IndiceCapturas();
  for (const n of [100, 1000, 3000]) {
    const leads = [];
    for (let i = 1; i <= n; i++) leads.push(lead(i + n * 10));
    const t0 = Date.now();
    const r = classificarLeads(leads, idx, { searchId: 's' + n });
    const t1 = Date.now();
    idx.carregar(r.linhas);
    medidas[n] = t1 - t0;
    assert.equal(r.novas, n);
  }
  /* segunda passagem sobre 3000 já conhecidas: o custo tem de continuar linear */
  const repetidas = [];
  for (let i = 1; i <= 3000; i++) repetidas.push(lead(i + 30000));
  const t0 = Date.now();
  const r = classificarLeads(repetidas, idx, { searchId: 'rep' });
  const tRep = Date.now() - t0;
  assert.equal(r.jaCapturadas, 3000);

  assert.ok(medidas[3000] < 3000, '3000 novas demorou ' + medidas[3000] + ' ms');
  assert.ok(tRep < 3000, '3000 repetidas demorou ' + tRep + ' ms');
  /* linearidade: 3000 não pode custar mais de 60× o de 100 */
  const fator = (medidas[3000] + 1) / (medidas[100] + 1);
  assert.ok(fator < 60, 'crescimento suspeito de quadrático: fator ' + fator.toFixed(1));
});

test('índice faz lookup O(1) mesmo com 20 000 leads no registo', () => {
  const idx = new IndiceCapturas();
  const leads = [];
  for (let i = 1; i <= 20000; i++) leads.push(lead(i));
  idx.carregar(classificarLeads(leads, idx, { searchId: 's1' }).linhas);
  const t0 = Date.now();
  for (let i = 0; i < 5000; i++) idx.procurar(lead((i % 20000) + 1));
  const t = Date.now() - t0;
  assert.ok(t < 1500, '5000 lookups em ' + t + ' ms — deveria ser quase instantâneo');
});

test('guardar e reler snapshots de 3000 leads', async () => {
  const s = await loja();
  const leads = [];
  for (let i = 1; i <= 3000; i++) leads.push(lead(i));
  const t0 = Date.now();
  await s.guardarSnapshot('grande', leads);
  const lido = await s.lerSnapshot('grande');
  const t = Date.now() - t0;
  assert.equal(lido.length, 3000);
  assert.ok(t < 5000, 'snapshot de 3000 demorou ' + t + ' ms');
});

/* ================================================================ *
 * §44–§48 Ciclo de vida das gerações                                *
 * ================================================================ */

import { CapturedLeadRegistry, ESTADO_PESQUISA } from '../providers/history/model.mjs';

/** Simula uma execução completa: classifica, persiste registo, meta e snapshot. */
async function gerar(store, registry, { leads, query, historyId, searchId, criadaEm, modo = 'local', localizacao = 'Lisboa', raioKm = 30, lat = 38.7, lon = -9.2 }) {
  const r = registry.classificar(leads, searchId, { agora: () => criadaEm });
  await registry.confirmar(r);
  const meta = registoDePesquisa({
    historyId, searchId, criadaEm, modo, query, localizacao, raioKm, lat, lon,
    fontes: ['google'], totalBruto: leads.length, leads: r.leads,
    novas: r.novas, jaCapturadas: r.jaCapturadas, estado: 'CONCLUIDA'
  });
  await store.guardarPesquisa(meta);
  await store.guardarSnapshot(historyId, r.leads);
  return { meta, resultado: r };
}

test('§44 A é guardada corretamente com snapshot e metadados', async () => {
  const store = await loja();
  const registry = new CapturedLeadRegistry(store);
  const { meta } = await gerar(store, registry, {
    leads: [lead(1), lead(2), lead(3)], query: 'eletricistas',
    historyId: 'hA', searchId: 'sA', criadaEm: '2026-08-18T10:00:00.000Z'
  });
  assert.equal(meta.historyId, 'hA');
  assert.equal(meta.searchId, 'sA');
  assert.equal(meta.totalFinal, 3);
  assert.equal(meta.novas, 3);
  assert.equal(meta.estado, ESTADO_PESQUISA.CONCLUIDA);
  assert.equal((await store.lerSnapshot('hA')).length, 3);
});

test('§44 Preview de A usa o snapshot de A, não a lista atual', async () => {
  const store = await loja();
  const registry = new CapturedLeadRegistry(store);
  await gerar(store, registry, { leads: [lead(1), lead(2)], query: 'a', historyId: 'hA', searchId: 'sA', criadaEm: '2026-08-18T10:00:00.000Z' });
  await gerar(store, registry, { leads: [lead(7), lead(8), lead(9)], query: 'b', historyId: 'hB', searchId: 'sB', criadaEm: '2026-09-01T10:00:00.000Z' });

  const a = await store.lerSnapshot('hA');
  assert.equal(a.length, 2);
  assert.deepEqual(a.map(l => l.nome), ['Empresa 1', 'Empresa 2']);
  assert.ok(a.every(l => l.historico.estado === 'NOVA'));
});

test('§29 CRÍTICO: com B aberta, baixar A gera o XLSX de A', async () => {
  const store = await loja();
  const registry = new CapturedLeadRegistry(store);
  await gerar(store, registry, { leads: [lead(1), lead(2)], query: 'a', historyId: 'hA', searchId: 'sA', criadaEm: '2026-08-18T10:00:00.000Z' });
  await gerar(store, registry, { leads: [lead(7), lead(8), lead(9)], query: 'b', historyId: 'hB', searchId: 'sB', criadaEm: '2026-09-01T10:00:00.000Z' });

  /* "lista atualmente aberta" = B */
  const listaAberta = await store.lerSnapshot('hB');
  assert.equal(listaAberta.length, 3);

  /* baixar A tem de usar exclusivamente o snapshot de A */
  const paraExportar = await store.lerSnapshot('hA');
  assert.equal(paraExportar.length, 2);
  assert.deepEqual(paraExportar.map(l => l.nome).sort(), ['Empresa 1', 'Empresa 2']);
  assert.equal(paraExportar.some(l => l.nome === 'Empresa 7'), false, 'não pode conter leads de B');
  assert.ok(paraExportar.every(l => l.historico.firstSearchId === 'sA'));
});

test('§44 B não altera A', async () => {
  const store = await loja();
  const registry = new CapturedLeadRegistry(store);
  await gerar(store, registry, { leads: [lead(1), lead(2)], query: 'a', historyId: 'hA', searchId: 'sA', criadaEm: '2026-08-18T10:00:00.000Z' });
  const antes = JSON.stringify(await store.lerSnapshot('hA'));
  const metaAntes = JSON.stringify((await store.listarPesquisas()).find(l => l.historyId === 'hA'));

  /* B repete as mesmas leads: passam a "já captadas" em B, mas A fica igual */
  await gerar(store, registry, { leads: [lead(1), lead(2)], query: 'a', historyId: 'hB', searchId: 'sB', criadaEm: '2026-09-01T10:00:00.000Z' });

  assert.equal(JSON.stringify(await store.lerSnapshot('hA')), antes, 'o snapshot de A mudou');
  assert.equal(JSON.stringify((await store.listarPesquisas()).find(l => l.historyId === 'hA')), metaAntes);
  const b = await store.lerSnapshot('hB');
  assert.ok(b.every(l => l.historico.estado === 'JA_CAPTURADA'));
  assert.ok(b.every(l => l.historico.captureCount === 2));
});

test('§13/§44 Repetir A cria C, sem tocar em A', async () => {
  const store = await loja();
  const registry = new CapturedLeadRegistry(store);
  const { meta: mA } = await gerar(store, registry, {
    leads: [lead(1), lead(2)], query: 'eletricistas', historyId: 'hA', searchId: 'sA',
    criadaEm: '2026-08-18T10:00:00.000Z', raioKm: 30, localizacao: 'Lisboa', lat: 38.7, lon: -9.2
  });
  /* "Repetir" recupera os parâmetros de A e executa nova pesquisa */
  const { meta: mC } = await gerar(store, registry, {
    leads: [lead(1), lead(2), lead(5)], query: mA.query, historyId: 'hC', searchId: 'sC',
    criadaEm: '2026-09-05T10:00:00.000Z', raioKm: mA.raioKm, localizacao: mA.localizacao, lat: mA.lat, lon: mA.lon
  });

  assert.equal(mC.query, mA.query);
  assert.equal(mC.raioKm, mA.raioKm);
  assert.notEqual(mC.historyId, mA.historyId);
  assert.notEqual(mC.searchId, mA.searchId);
  assert.equal((await store.listarPesquisas()).length, 2, 'A continua a existir');
  assert.equal((await store.lerSnapshot('hA')).length, 2, 'o snapshot de A não foi tocado');
  assert.equal(mC.novas, 1);
  assert.equal(mC.jaCapturadas, 2);
});

test('§44 apagar B não altera A nem C', async () => {
  const store = await loja();
  const registry = new CapturedLeadRegistry(store);
  await gerar(store, registry, { leads: [lead(1)], query: 'a', historyId: 'hA', searchId: 'sA', criadaEm: '2026-08-01T10:00:00.000Z' });
  await gerar(store, registry, { leads: [lead(2)], query: 'b', historyId: 'hB', searchId: 'sB', criadaEm: '2026-08-15T10:00:00.000Z' });
  await gerar(store, registry, { leads: [lead(3)], query: 'c', historyId: 'hC', searchId: 'sC', criadaEm: '2026-09-01T10:00:00.000Z' });

  await store.apagarPesquisa('hB');
  const restantes = (await store.listarPesquisas()).map(l => l.historyId).sort();
  assert.deepEqual(restantes, ['hA', 'hC']);
  assert.equal((await store.lerSnapshot('hA')).length, 1);
  assert.equal((await store.lerSnapshot('hC')).length, 1);
  assert.equal(await store.lerSnapshot('hB'), null);
});

test('§17/§44 apagar B não apaga o registo global', async () => {
  const store = await loja();
  const registry = new CapturedLeadRegistry(store);
  await gerar(store, registry, { leads: [lead(1), lead(2)], query: 'b', historyId: 'hB', searchId: 'sB', criadaEm: '2026-08-15T10:00:00.000Z' });
  const antes = registry.tamanho;
  await store.apagarPesquisa('hB');

  const registryDepois = new CapturedLeadRegistry(store);
  await registryDepois.carregar();
  assert.equal(registryDepois.tamanho, antes, 'o registo global foi perdido ao apagar a lista');
  const r = registryDepois.classificar([lead(1)], 'sZ');
  assert.equal(r.jaCapturadas, 1, 'a lead deixou de ser reconhecida');
});

test('§48 depois de recarregar: histórico, snapshot e registo continuam lá', async () => {
  const backend = new MemoryBackend();   /* mesmo backend = mesmo "browser" */
  const store1 = new LocalLeadHistoryStore({ backend }); await store1.iniciar();
  const reg1 = new CapturedLeadRegistry(store1); await reg1.carregar();
  await gerar(store1, reg1, { leads: [lead(1), lead(2), lead(3)], query: 'x', historyId: 'hA', searchId: 'sA', criadaEm: '2026-09-01T10:00:00.000Z' });

  /* recarregar o browser: instâncias novas sobre o mesmo armazenamento */
  const store2 = new LocalLeadHistoryStore({ backend }); await store2.iniciar();
  const reg2 = new CapturedLeadRegistry(store2); await reg2.carregar();

  assert.equal((await store2.listarPesquisas()).length, 1);
  assert.equal((await store2.lerSnapshot('hA')).length, 3, 'preview continua a funcionar');
  assert.equal(reg2.tamanho, 3, 'registo de capturas continua a existir');
  assert.equal(reg2.classificar([lead(1)], 'sB').jaCapturadas, 1);
});

test('§45 três execuções: Nova/1 → Já captada/2 → Já captada/3', async () => {
  const store = await loja();
  const registry = new CapturedLeadRegistry(store);
  const r1 = await gerar(store, registry, { leads: [lead(1)], query: 'x', historyId: 'h1', searchId: 's1', criadaEm: '2026-08-01T10:00:00.000Z' });
  const r2 = await gerar(store, registry, { leads: [lead(1)], query: 'x', historyId: 'h2', searchId: 's2', criadaEm: '2026-08-15T10:00:00.000Z' });
  const r3 = await gerar(store, registry, { leads: [lead(1)], query: 'x', historyId: 'h3', searchId: 's3', criadaEm: '2026-09-01T10:00:00.000Z' });

  assert.equal(r1.resultado.leads[0].historico.estado, 'NOVA');
  assert.equal(r1.resultado.leads[0].historico.captureCount, 1);
  assert.equal(r2.resultado.leads[0].historico.estado, 'JA_CAPTURADA');
  assert.equal(r2.resultado.leads[0].historico.captureCount, 2);
  assert.equal(r3.resultado.leads[0].historico.estado, 'JA_CAPTURADA');
  assert.equal(r3.resultado.leads[0].historico.captureCount, 3);
  assert.equal(r3.resultado.leads[0].historico.firstCapturedAt, '2026-08-01T10:00:00.000Z');
  assert.equal(r3.resultado.leads[0].historico.lastCapturedAt, '2026-09-01T10:00:00.000Z');
});

test('§27 Novas + Já captadas = Total final, em todas as gerações', async () => {
  const store = await loja();
  const registry = new CapturedLeadRegistry(store);
  const conjuntos = [
    [lead(1), lead(2), lead(3)],
    [lead(2), lead(3), lead(4), lead(5)],
    [lead(1), lead(5), lead(6)]
  ];
  let i = 0;
  for (const leads of conjuntos) {
    i += 1;
    const { meta } = await gerar(store, registry, { leads, query: 'x', historyId: 'h' + i, searchId: 's' + i, criadaEm: '2026-09-0' + i + 'T10:00:00.000Z' });
    assert.equal(meta.novas + meta.jaCapturadas, meta.totalFinal,
      'geração ' + i + ': ' + meta.novas + ' + ' + meta.jaCapturadas + ' != ' + meta.totalFinal);
  }
});

test('§35 histórico com 10, 50 e 100 listas', async () => {
  const store = await loja();
  const registry = new CapturedLeadRegistry(store);
  const t0 = Date.now();
  for (let i = 1; i <= 100; i++) {
    const leads = [];
    for (let j = 1; j <= 20; j++) leads.push(lead(i * 100 + j));
    await gerar(store, registry, {
      leads, query: 'q' + i, historyId: 'h' + i, searchId: 's' + i,
      criadaEm: new Date(Date.UTC(2026, 0, 1 + i)).toISOString()
    });
    if (i === 10) assert.equal((await store.listarPesquisas()).length, 10);
    if (i === 50) assert.equal((await store.listarPesquisas()).length, 50);
  }
  const t = Date.now() - t0;
  const listas = await store.listarPesquisas();
  assert.equal(listas.length, 100);
  assert.equal(listas[0].historyId, 'h100', 'a mais recente vem primeiro');
  assert.equal(registry.tamanho, 2000);
  assert.equal((await store.lerSnapshot('h1')).length, 20, 'a lista mais antiga continua descarregável');
  assert.ok(t < 15000, '100 gerações demoraram ' + t + ' ms');
});

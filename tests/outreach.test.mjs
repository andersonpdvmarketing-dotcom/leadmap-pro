/**
 * LeadMap Pro — testes do Outreach (Fase B, simulação)
 * =====================================================
 *   node --test
 *
 * Nenhum teste toca na rede. Há um teste que instrumenta `globalThis.fetch`
 * e falha se qualquer pedido sair durante um fluxo completo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estadoInicial, adicionarContactos, contactoDeLead, normalizarInstagram, chaveContacto,
  definirOptOut, adicionarConta, removerConta,
  criarTemplate, editarTemplate, duplicarTemplate, eliminarTemplate, resolverVariaveis, variaveisDe,
  separarElegiveis, validarCampanha, criarCampanha, mudarEstadoCampanha,
  gerarFila, simularProcessamento, resultadoSimulado, kpisCampanha, kpisGerais,
  CONTACT_STATUS, CAMPAIGN_STATUS, QUEUE_STATUS, MOTIVO_EXCLUSAO, MAX_CONTAS, VARIAVEIS
} from '../providers/outreach/model.mjs';
import {
  LocalOutreachStore, MemoryStorage, CHAVE_ARMAZENAMENTO,
  encontrarSegredos, removerSegredos
} from '../providers/outreach/store.mjs';
import { MockInstagramProvider } from '../providers/instagram/index.mjs';

/* ---------------------------------------------------------------- *
 * Utilitários                                                       *
 * ---------------------------------------------------------------- */

const lead = (n, ig, extra = {}) => ({
  id: 'L' + n, nome: 'Empresa ' + n, instagram: ig,
  localidade: 'Lisboa', distrito: 'Lisboa', searchQueries: ['cabeleireiros'], ...extra
});

function cenario({ nContactos = 3, comConta = true, comTemplate = true } = {}) {
  const est = estadoInicial();
  const leads = [];
  for (let i = 1; i <= nContactos; i++) leads.push(lead(i, '@empresa_' + i));
  adicionarContactos(est, leads);
  if (comConta) adicionarConta(est, { username: '@conta_teste', displayName: 'Conta Teste' });
  if (comTemplate) criarTemplate(est, { nome: 'Base', mensagem: 'Olá {{nome}}, fala {{cidade}}?' });
  return est;
}

/* ---------------------------------------------------------------- *
 * 1. Instagram e deduplicação                                       *
 * ---------------------------------------------------------------- */

test('normalizarInstagram aceita URL, @handle e recusa o que não é perfil', () => {
  assert.equal(normalizarInstagram('https://instagram.com/loja_x/'), 'loja_x');
  assert.equal(normalizarInstagram('@Loja_X'), 'loja_x');
  assert.equal(normalizarInstagram('www.instagram.com/loja.x?hl=pt'), 'loja.x');
  assert.equal(normalizarInstagram('instagram.com/p/ABC123'), null);
  assert.equal(normalizarInstagram('instagram.com/explore/tags/x'), null);
  assert.equal(normalizarInstagram('N/D'), null);
  assert.equal(normalizarInstagram(''), null);
  assert.equal(normalizarInstagram(null), null);
  assert.equal(normalizarInstagram('nome com espaços'), null);
});

test('dedupe: o mesmo Instagram em formatos diferentes é um só contacto', () => {
  const est = estadoInicial();
  const r = adicionarContactos(est, [
    lead(1, 'https://instagram.com/loja_x'),
    lead(2, '@LOJA_X'),
    lead(3, 'instagram.com/loja_x/')
  ]);
  assert.equal(est.contactos.length, 1);
  assert.equal(r.adicionados, 1);
  assert.equal(r.atualizados, 2);
});

test('dedupe: sem Instagram a chave é o id do lead', () => {
  const est = estadoInicial();
  adicionarContactos(est, [lead(1, 'N/D'), lead(2, 'N/D')]);
  assert.equal(est.contactos.length, 2, 'leads distintos sem IG não podem colapsar num só');
  adicionarContactos(est, [lead(1, 'N/D')]);
  assert.equal(est.contactos.length, 2, 'o mesmo lead não duplica');
});

test('dedupe: um contacto existente é atualizado, não duplicado', () => {
  const est = estadoInicial();
  adicionarContactos(est, [{ id: 'L1', nome: 'Loja', instagram: '@loja' }]);
  adicionarContactos(est, [{ id: 'L1', nome: 'Loja', instagram: '@loja', localidade: 'Porto', website: 'https://loja.pt' }]);
  assert.equal(est.contactos.length, 1);
  assert.equal(est.contactos[0].cidade, 'Porto');
  assert.equal(est.contactos[0].website, 'https://loja.pt');
});

test('dedupe preserva OPTED_OUT ao reimportar o mesmo lead', () => {
  const est = estadoInicial();
  adicionarContactos(est, [lead(1, '@loja')]);
  definirOptOut(est, est.contactos[0].id, true);
  adicionarContactos(est, [lead(1, '@loja')]);
  assert.equal(est.contactos.length, 1);
  assert.equal(est.contactos[0].status, CONTACT_STATUS.OPTED_OUT);
});

/* ---------------------------------------------------------------- *
 * 2. Contacto sem Instagram e estado inicial                        *
 * ---------------------------------------------------------------- */

test('ter Instagram NÃO significa poder receber DM: estado inicial é UNKNOWN', () => {
  const est = estadoInicial();
  adicionarContactos(est, [lead(1, '@loja')]);
  assert.equal(est.contactos[0].status, CONTACT_STATUS.UNKNOWN);
  assert.notEqual(est.contactos[0].status, CONTACT_STATUS.ELIGIBLE);
});

test('contacto sem Instagram fica marcado e não é elegível', () => {
  const est = estadoInicial();
  const r = adicionarContactos(est, [lead(1, 'N/D')]);
  assert.equal(r.semInstagram, 1);
  const c = est.contactos[0];
  assert.equal(c.temInstagram, false);
  const { incluidos, excluidos } = separarElegiveis(est, [c.id]);
  assert.equal(incluidos.length, 0);
  assert.equal(excluidos[0].motivo, MOTIVO_EXCLUSAO.SEM_INSTAGRAM);
});

test('contactoDeLead nunca inventa Instagram a partir do nome', () => {
  const c = contactoDeLead({ id: 'L9', nome: 'Padaria Central', instagram: 'N/D' });
  assert.equal(c.instagram, null);
  assert.equal(c.temInstagram, false);
});

/* ---------------------------------------------------------------- *
 * 3. Opt-out                                                        *
 * ---------------------------------------------------------------- */

test('opt-out exclui de campanhas e a reativação repõe o estado anterior', () => {
  const est = cenario({ nContactos: 2 });
  const [a, b] = est.contactos;
  definirOptOut(est, a.id, true);
  assert.equal(a.status, CONTACT_STATUS.OPTED_OUT);

  const sep = separarElegiveis(est, [a.id, b.id]);
  assert.equal(sep.incluidos.length, 1);
  assert.equal(sep.excluidos[0].motivo, MOTIVO_EXCLUSAO.OPTED_OUT);

  definirOptOut(est, a.id, false);
  assert.equal(a.status, CONTACT_STATUS.UNKNOWN);
  assert.equal(separarElegiveis(est, [a.id, b.id]).incluidos.length, 2);
});

/* ---------------------------------------------------------------- *
 * 4. Contas — até 5, sexta rejeitada                                *
 * ---------------------------------------------------------------- */

test('até 5 contas; a sexta é rejeitada com a mensagem exata', () => {
  const est = estadoInicial();
  for (let i = 1; i <= MAX_CONTAS; i++) adicionarConta(est, { username: 'conta' + i });
  assert.equal(est.contas.length, 5);
  assert.throws(() => adicionarConta(est, { username: 'conta6' }),
    /Limite máximo de 5 contas conectadas\./);
});

test('remover uma conta liberta espaço para outra', () => {
  const est = estadoInicial();
  for (let i = 1; i <= MAX_CONTAS; i++) adicionarConta(est, { username: 'conta' + i });
  removerConta(est, est.contas[0].id);
  const nova = adicionarConta(est, { username: 'conta_nova' });
  assert.equal(nova.username, 'conta_nova');
  assert.equal(est.contas.length, 5);
});

test('conta duplicada é recusada e o username é normalizado', () => {
  const est = estadoInicial();
  const c = adicionarConta(est, { username: '@A_Minha_Loja' });
  assert.equal(c.username, 'a_minha_loja');
  assert.throws(() => adicionarConta(est, { username: 'a_minha_loja' }), /já está ligada/);
});

test('conta sem username é recusada e nenhuma password é aceite', () => {
  const est = estadoInicial();
  assert.throws(() => adicionarConta(est, { username: '  ' }), /Indique o nome de utilizador/);
  const c = adicionarConta(est, { username: 'x', password: 'nao-guardar' });
  assert.equal('password' in c, false);
  assert.equal(JSON.stringify(est).includes('nao-guardar'), false);
});

/* ---------------------------------------------------------------- *
 * 5. Templates e variáveis                                          *
 * ---------------------------------------------------------------- */

test('criar, editar, duplicar e eliminar template', () => {
  const est = estadoInicial();
  const t = criarTemplate(est, { nome: 'A', mensagem: 'Olá {{nome}}' });
  assert.equal(est.templates.length, 1);
  editarTemplate(est, t.id, { nome: 'B', mensagem: 'Olá {{nome}}!' });
  assert.equal(est.templates[0].nome, 'B');
  const d = duplicarTemplate(est, t.id);
  assert.equal(est.templates.length, 2);
  assert.equal(d.nome, 'B (cópia)');
  assert.equal(d.mensagem, 'Olá {{nome}}!');
  eliminarTemplate(est, t.id);
  assert.equal(est.templates.length, 1);
});

test('template sem nome ou sem mensagem é recusado', () => {
  const est = estadoInicial();
  assert.throws(() => criarTemplate(est, { nome: '', mensagem: 'x' }), /nome/);
  assert.throws(() => criarTemplate(est, { nome: 'A', mensagem: '   ' }), /vazia/);
});

test('resolução de variáveis com todos os dados presentes', () => {
  const c = { nome: 'Loja X', empresa: 'Loja X', cidade: 'Lisboa', atividade: 'cabeleireiros' };
  const r = resolverVariaveis('Olá {{nome}} de {{cidade}}, trabalha com {{atividade}}?', c);
  assert.equal(r.texto, 'Olá Loja X de Lisboa, trabalha com cabeleireiros?');
  assert.equal(r.completo, true);
  assert.deepEqual(r.faltam, []);
});

test('variável sem dado NÃO é inventada — fica por resolver e é assinalada', () => {
  const r = resolverVariaveis('Olá {{nome}}, de {{cidade}}', { nome: 'Loja X', cidade: null });
  assert.equal(r.texto, 'Olá Loja X, de {{cidade}}');
  assert.deepEqual(r.faltam, ['cidade']);
  assert.equal(r.completo, false);
  assert.equal(r.texto.includes('undefined'), false);
  assert.equal(r.texto.includes('null'), false);
});

test('variável desconhecida é assinalada e deixada visível', () => {
  const r = resolverVariaveis('Olá {{inexistente}}', { nome: 'X' });
  assert.deepEqual(r.desconhecidas, ['inexistente']);
  assert.equal(r.texto, 'Olá {{inexistente}}');
});

test('variaveisDe lista as variáveis usadas, sem repetir', () => {
  assert.deepEqual(variaveisDe('{{nome}} {{cidade}} {{nome}}'), ['nome', 'cidade']);
  assert.deepEqual(variaveisDe('sem variáveis'), []);
  assert.deepEqual(VARIAVEIS, ['nome', 'empresa', 'cidade', 'atividade']);
});

/* ---------------------------------------------------------------- *
 * 6. Campanhas e validações                                         *
 * ---------------------------------------------------------------- */

test('criar campanha guarda conta e provider e liga os contactos', () => {
  const est = cenario();
  const k = criarCampanha(est, {
    nome: 'C1', contactoIds: est.contactos.map(c => c.id),
    contaId: est.contas[0].id, templateId: est.templates[0].id
  });
  assert.equal(k.status, CAMPAIGN_STATUS.DRAFT);
  assert.equal(k.contaId, est.contas[0].id);
  assert.equal(k.provider, 'mock');
  assert.equal(k.contactoIds.length, 3);
  assert.ok(est.contactos[0].campanhas.includes(k.id));
});

test('campanha sem contactos, sem conta ou com mensagem vazia é recusada', () => {
  const est = cenario();
  const base = { nome: 'C', contactoIds: est.contactos.map(c => c.id), contaId: est.contas[0].id, mensagem: 'Olá' };
  assert.throws(() => criarCampanha(est, { ...base, contactoIds: [] }), /contacto/i);
  assert.throws(() => criarCampanha(est, { ...base, contaId: null }), /conta/i);
  assert.throws(() => criarCampanha(est, { ...base, mensagem: '   ', templateId: null }), /vazia/i);
  assert.throws(() => criarCampanha(est, { ...base, nome: '' }), /nome/i);
});

test('campanha exclui automaticamente OPTED_OUT e SEM INSTAGRAM, e diz quantos e porquê', () => {
  const est = cenario({ nContactos: 2 });
  adicionarContactos(est, [lead(9, 'N/D')]);
  definirOptOut(est, est.contactos[0].id, true);

  const k = criarCampanha(est, {
    nome: 'C', contactoIds: est.contactos.map(c => c.id),
    contaId: est.contas[0].id, mensagem: 'Olá {{nome}}'
  });
  assert.equal(k.contactoIds.length, 1);
  assert.equal(k.excluidos.length, 2);
  const motivos = k.excluidos.map(x => x.motivo).sort();
  assert.deepEqual(motivos, [MOTIVO_EXCLUSAO.OPTED_OUT, MOTIVO_EXCLUSAO.SEM_INSTAGRAM].sort());
});

test('validarCampanha devolve incluídos e excluídos sem alterar o estado', () => {
  const est = cenario({ nContactos: 2 });
  const antes = JSON.stringify(est);
  const v = validarCampanha(est, {
    nome: 'C', contactoIds: est.contactos.map(c => c.id),
    contaId: est.contas[0].id, mensagem: 'Olá'
  });
  assert.equal(v.valido, true);
  assert.equal(v.incluidos.length, 2);
  assert.equal(JSON.stringify(est), antes, 'validar não pode ter efeitos secundários');
});

test('pause, resume e cancel refletem-se na fila', () => {
  const est = cenario();
  const k = criarCampanha(est, { nome: 'C', contactoIds: est.contactos.map(c => c.id), contaId: est.contas[0].id, mensagem: 'Olá' });
  gerarFila(est, k.id);
  const daCampanha = () => est.fila.filter(i => i.campanhaId === k.id);

  mudarEstadoCampanha(est, k.id, CAMPAIGN_STATUS.PAUSED);
  assert.ok(daCampanha().every(i => i.status === QUEUE_STATUS.PAUSED));

  mudarEstadoCampanha(est, k.id, CAMPAIGN_STATUS.RUNNING);
  assert.ok(daCampanha().every(i => i.status === QUEUE_STATUS.PENDING));

  mudarEstadoCampanha(est, k.id, CAMPAIGN_STATUS.CANCELLED);
  assert.ok(daCampanha().every(i => i.status === QUEUE_STATUS.SKIPPED));
  assert.equal(est.campanhas[0].status, CAMPAIGN_STATUS.CANCELLED);
});

/* ---------------------------------------------------------------- *
 * 7. Fila mock                                                      *
 * ---------------------------------------------------------------- */

test('gerarFila é idempotente por (campanha, contacto)', () => {
  const est = cenario();
  const k = criarCampanha(est, { nome: 'C', contactoIds: est.contactos.map(c => c.id), contaId: est.contas[0].id, mensagem: 'Olá' });
  const r1 = gerarFila(est, k.id);
  const r2 = gerarFila(est, k.id);
  assert.equal(r1.criados, 3);
  assert.equal(r2.criados, 0, 'gerar a fila outra vez não duplica itens');
  assert.equal(est.fila.length, 3);
});

test('simulação é determinística: o mesmo par dá sempre o mesmo desfecho', () => {
  const item = { campanhaId: 'k-1', contactoId: 'c-7' };
  const primeiro = resultadoSimulado(item);
  for (let i = 0; i < 20; i++) assert.equal(resultadoSimulado(item), primeiro);
  assert.ok(['SENT', 'REPLIED', 'FAILED', 'RATE_LIMITED'].includes(primeiro));
});

test('simular processamento move os itens e atualiza contactos e KPIs', async () => {
  const est = cenario({ nContactos: 12 });
  const k = criarCampanha(est, { nome: 'C', contactoIds: est.contactos.map(c => c.id), contaId: est.contas[0].id, mensagem: 'Olá {{nome}}' });
  gerarFila(est, k.id);

  const r = await simularProcessamento(est, k.id, { provider: new MockInstagramProvider({ script: {} }) });
  assert.equal(r.processados, 12);
  assert.ok(r.enviados > 0);

  const kp = kpisCampanha(est, k.id);
  assert.equal(kp.total, 12);
  assert.equal(kp.enviados + kp.falhas + kp.pendentes, 12);
  assert.equal(kp.enviados, r.enviados);
  assert.equal(kp.respostas, r.respostas);

  const enviados = est.fila.filter(i => i.status === QUEUE_STATUS.SENT);
  assert.ok(enviados.every(i => i.providerMessageId), 'cada envio tem id do fornecedor');
  assert.ok(est.mensagens.length >= enviados.length);
});

test('simulação não corre com a campanha em pausa ou cancelada', async () => {
  const est = cenario();
  const k = criarCampanha(est, { nome: 'C', contactoIds: est.contactos.map(c => c.id), contaId: est.contas[0].id, mensagem: 'Olá' });
  gerarFila(est, k.id);
  const p = new MockInstagramProvider({ script: {} });

  mudarEstadoCampanha(est, k.id, CAMPAIGN_STATUS.PAUSED);
  await assert.rejects(() => simularProcessamento(est, k.id, { provider: p }), /pausa/);

  mudarEstadoCampanha(est, k.id, CAMPAIGN_STATUS.CANCELLED);
  await assert.rejects(() => simularProcessamento(est, k.id, { provider: p }), /cancelada/);
});

test('simular exige um provider — nunca corre sozinho', async () => {
  const est = cenario();
  const k = criarCampanha(est, { nome: 'C', contactoIds: est.contactos.map(c => c.id), contaId: est.contas[0].id, mensagem: 'Olá' });
  gerarFila(est, k.id);
  await assert.rejects(() => simularProcessamento(est, k.id, {}), /MockInstagramProvider/);
});

/* ---------------------------------------------------------------- *
 * 8. Persistência local                                             *
 * ---------------------------------------------------------------- */

test('guardar e recarregar repõe o estado completo', async () => {
  const storage = new MemoryStorage();
  const store = new LocalOutreachStore({ storage, estadoInicial });
  const est = cenario({ nContactos: 4 });
  const k = criarCampanha(est, { nome: 'C', contactoIds: est.contactos.map(c => c.id), contaId: est.contas[0].id, mensagem: 'Olá {{nome}}' });
  gerarFila(est, k.id);
  await simularProcessamento(est, k.id, { provider: new MockInstagramProvider({ script: {} }) });
  store.save(est);

  /* simula um recarregamento do browser */
  const outro = new LocalOutreachStore({ storage, estadoInicial }).load();
  assert.equal(outro.contactos.length, 4);
  assert.equal(outro.contas.length, 1);
  assert.equal(outro.templates.length, 1);
  assert.equal(outro.campanhas.length, 1);
  assert.equal(outro.fila.length, 4);
  assert.deepEqual(kpisCampanha(outro, k.id), kpisCampanha(est, k.id));
});

test('estado corrompido não parte a aplicação', () => {
  const storage = new MemoryStorage({ [CHAVE_ARMAZENAMENTO]: '{ isto não é json' });
  const store = new LocalOutreachStore({ storage, estadoInicial });
  const e = store.load();
  assert.deepEqual(e.contactos, []);
  assert.equal(store.ultimoErro, 'JSON inválido');
});

test('estado truncado é completado pela migração', () => {
  const storage = new MemoryStorage({ [CHAVE_ARMAZENAMENTO]: JSON.stringify({ versao: 1, contactos: [{ id: 'c-1' }] }) });
  const e = new LocalOutreachStore({ storage, estadoInicial }).load();
  assert.equal(e.contactos.length, 1);
  assert.deepEqual(e.campanhas, []);
  assert.deepEqual(e.fila, []);
});

test('estado de versão futura é recusado em vez de mal interpretado', () => {
  const storage = new MemoryStorage({ [CHAVE_ARMAZENAMENTO]: JSON.stringify({ versao: 99, contactos: [{ id: 'x' }] }) });
  const store = new LocalOutreachStore({ storage, estadoInicial });
  const e = store.load();
  assert.deepEqual(e.contactos, []);
  assert.match(store.ultimoErro, /mais recente/);
});

test('clear() apaga o estado guardado', () => {
  const storage = new MemoryStorage();
  const store = new LocalOutreachStore({ storage, estadoInicial });
  store.save(cenario());
  assert.ok(storage.getItem(CHAVE_ARMAZENAMENTO));
  store.clear();
  assert.equal(storage.getItem(CHAVE_ARMAZENAMENTO), null);
});

test('a chave de armazenamento é versionada', () => {
  assert.equal(CHAVE_ARMAZENAMENTO, 'leadmap_outreach_v1');
});

/* ---------------------------------------------------------------- *
 * 9. Ausência de segredos no estado local                           *
 * ---------------------------------------------------------------- */

test('encontrarSegredos deteta credenciais aninhadas e dentro de arrays', () => {
  assert.deepEqual(encontrarSegredos({ apiKey: 'x' }), ['apiKey']);
  assert.deepEqual(encontrarSegredos({ a: { b: { token: 'x' } } }), ['a.b.token']);
  assert.deepEqual(encontrarSegredos({ lista: [{ password: 'x' }] }), ['lista[0].password']);
  assert.deepEqual(encontrarSegredos({ nome: 'ok', cidade: 'Lisboa' }), []);
});

test('save() recusa gravar segredos e o que fica no armazenamento está limpo', () => {
  const storage = new MemoryStorage();
  const store = new LocalOutreachStore({ storage, estadoInicial });
  const est = cenario();
  est.contas[0].accessToken = 'TOKEN-SECRETO';
  est.contas[0].cookie = 'COOKIE-SECRETO';
  est.perigoso = { nested: [{ apiKey: 'CHAVE-SECRETA' }] };

  store.save(est);
  const gravado = storage.getItem(CHAVE_ARMAZENAMENTO);
  for (const segredo of ['TOKEN-SECRETO', 'COOKIE-SECRETO', 'CHAVE-SECRETA']) {
    assert.equal(gravado.includes(segredo), false, 'fuga de ' + segredo);
  }
  assert.deepEqual(encontrarSegredos(JSON.parse(gravado)), []);
});

for (const chave of ['password', 'token', 'accessToken', 'refreshToken', 'cookie', 'session', 'apiKey', 'clientSecret', 'appSecret']) {
  test('o campo "' + chave + '" nunca chega ao armazenamento local', () => {
    const storage = new MemoryStorage();
    const store = new LocalOutreachStore({ storage, estadoInicial });
    const est = estadoInicial();
    est.contas.push({ id: 'a-1', username: 'x', [chave]: 'VALOR-SENSIVEL' });
    store.save(est);
    assert.equal(storage.getItem(CHAVE_ARMAZENAMENTO).includes('VALOR-SENSIVEL'), false);
  });
}

test('removerSegredos preserva os dados úteis', () => {
  const limpo = removerSegredos({ nome: 'Loja', instagram: 'loja', token: 'x', dados: { cidade: 'Lisboa', apiKey: 'y' } });
  assert.equal(limpo.nome, 'Loja');
  assert.equal(limpo.dados.cidade, 'Lisboa');
  assert.equal('token' in limpo, false);
  assert.equal('apiKey' in limpo.dados, false);
});

/* ---------------------------------------------------------------- *
 * 10. Escala — 3000 contactos                                       *
 * ---------------------------------------------------------------- */

test('3000 contactos: adicionar, deduplicar, criar campanha e simular', async () => {
  const est = estadoInicial();
  const leads = [];
  for (let i = 1; i <= 3000; i++) leads.push(lead(i, i % 10 === 0 ? 'N/D' : '@empresa_' + i));

  const t0 = Date.now();
  const r = adicionarContactos(est, leads);
  const tAdd = Date.now() - t0;
  assert.equal(r.adicionados, 3000);
  assert.equal(r.semInstagram, 300);

  /* reimportar os mesmos 3000 não pode duplicar nada */
  const t1 = Date.now();
  adicionarContactos(est, leads);
  const tDedupe = Date.now() - t1;
  assert.equal(est.contactos.length, 3000);

  adicionarConta(est, { username: 'conta' });
  const k = criarCampanha(est, {
    nome: 'Massiva', contactoIds: est.contactos.map(c => c.id),
    contaId: est.contas[0].id, mensagem: 'Olá {{nome}}'
  });
  assert.equal(k.contactoIds.length, 2700);
  assert.equal(k.excluidos.length, 300);

  gerarFila(est, k.id);
  assert.equal(est.fila.length, 2700);

  const t2 = Date.now();
  await simularProcessamento(est, k.id, { provider: new MockInstagramProvider({ script: {} }), lote: 500 });
  const tSim = Date.now() - t2;

  /* orçamento generoso: o objetivo é apanhar regressões quadráticas */
  assert.ok(tAdd < 4000, 'adicionar 3000 demorou ' + tAdd + ' ms');
  assert.ok(tDedupe < 4000, 'deduplicar 3000 demorou ' + tDedupe + ' ms');
  assert.ok(tSim < 8000, 'simular 500 demorou ' + tSim + ' ms');
});

/* ---------------------------------------------------------------- *
 * 11. Zero chamadas externas                                        *
 * ---------------------------------------------------------------- */

test('ZERO REDE: um fluxo completo não faz nenhum pedido externo', async () => {
  const original = globalThis.fetch;
  const tentativas = [];
  globalThis.fetch = async (url) => { tentativas.push(String(url)); throw new Error('rede proibida nos testes'); };
  try {
    const est = cenario({ nContactos: 20 });
    const k = criarCampanha(est, {
      nome: 'C', contactoIds: est.contactos.map(c => c.id),
      contaId: est.contas[0].id, templateId: est.templates[0].id
    });
    gerarFila(est, k.id);
    await simularProcessamento(est, k.id, { provider: new MockInstagramProvider({ script: {} }) });
    const store = new LocalOutreachStore({ storage: new MemoryStorage(), estadoInicial });
    store.save(est);
    store.load();
    kpisGerais(est);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(tentativas, [], 'saíram pedidos de rede: ' + tentativas.join(', '));
});

/* ---------------------------------------------------------------- *
 * 12. Fluxo completo                                                *
 * ---------------------------------------------------------------- */

test('fluxo ponta a ponta: leads → contactos → conta → template → campanha → fila → simulação → recarregar', async () => {
  const storage = new MemoryStorage();
  const store = new LocalOutreachStore({ storage, estadoInicial });
  let est = store.load();

  adicionarContactos(est, [lead(1, '@a'), lead(2, '@b'), lead(3, 'N/D'), lead(4, '@d')]);
  adicionarConta(est, { username: '@minha_conta', displayName: 'Minha Conta' });
  criarTemplate(est, { nome: 'Intro', mensagem: 'Olá {{nome}}, de {{cidade}}.' });
  definirOptOut(est, est.contactos[1].id, true);

  const k = criarCampanha(est, {
    nome: 'Primeira', contactoIds: est.contactos.map(c => c.id),
    contaId: est.contas[0].id, templateId: est.templates[0].id
  });
  assert.equal(k.contactoIds.length, 2, 'entram só os 2 com Instagram e sem opt-out');
  assert.equal(k.excluidos.length, 2);

  gerarFila(est, k.id);
  const r = await simularProcessamento(est, k.id, { provider: new MockInstagramProvider({ script: {} }) });
  assert.equal(r.processados, 2);
  store.save(est);

  /* recarregar o browser */
  est = new LocalOutreachStore({ storage, estadoInicial }).load();
  const kp = kpisCampanha(est, k.id);
  assert.equal(kp.total, 2);
  assert.equal(kp.enviados + kp.falhas + kp.pendentes, 2);
  const g = kpisGerais(est);
  assert.equal(g.contactos, 4);
  assert.equal(g.comInstagram, 3);
  assert.equal(g.campanhas, 1);
  assert.equal(encontrarSegredos(est).length, 0);
});

/* ================================================================ *
 * 13. Migração v1 → v2 (v1.0.1)                                     *
 * ================================================================ */

test('MIGRAÇÃO v1→v2: resultados de envio não confirmados são limpos', () => {
  const v1 = {
    versao: 1,
    contactos: [
      { id: 'c-1', nome: 'A', status: 'SENT', ultimaAcao: '2026-08-01', temInstagram: true, campanhas: ['k-1'] },
      { id: 'c-2', nome: 'B', status: 'REPLIED', temInstagram: true, campanhas: [] },
      { id: 'c-3', nome: 'C', status: 'OPTED_OUT', temInstagram: true, campanhas: [] }
    ],
    contas: [{ id: 'a-1', username: 'x', provider: 'mock', status: 'CONNECTED' }],
    templates: [{ id: 't-1', nome: 'T', mensagem: 'Olá {{nome}}' }],
    campanhas: [{ id: 'k-1', nome: 'K', status: 'COMPLETED', contactoIds: ['c-1'], excluidos: [] }],
    fila: [
      { id: 'q-1', campanhaId: 'k-1', contactoId: 'c-1', status: 'SENT', tentativas: 1, providerMessageId: 'm1', erro: null },
      { id: 'q-2', campanhaId: 'k-1', contactoId: 'c-2', status: 'FAILED', tentativas: 2, erro: 'x' }
    ],
    mensagens: [{ id: 'm-1', contactoId: 'c-1', texto: 'Olá', direcao: 'saida' }],
    seq: 9
  };
  const storage = new MemoryStorage({ [CHAVE_ARMAZENAMENTO]: JSON.stringify(v1) });
  const e = new LocalOutreachStore({ storage, estadoInicial }).load();

  assert.equal(e.versao, 2);
  /* o trabalho real do utilizador é preservado (§31) */
  assert.equal(e.contactos.length, 3);
  assert.equal(e.contas.length, 1);
  assert.equal(e.templates.length, 1);
  assert.equal(e.templates[0].mensagem, 'Olá {{nome}}');
  assert.equal(e.campanhas.length, 1);
  assert.equal(e.fila.length, 2);
  assert.equal(e.seq, 9);
  /* o opt-out é uma decisão do utilizador: mantém-se */
  assert.equal(e.contactos[2].status, 'OPTED_OUT');

  /* §29: nada que sugira envio real sobrevive */
  assert.equal(e.mensagens.length, 0);
  assert.equal(e.contactos[0].status, 'UNKNOWN');
  assert.equal(e.contactos[1].status, 'UNKNOWN');
  assert.equal(e.campanhas[0].status, 'READY');
  assert.ok(e.fila.every(i => i.status === 'PENDING'));
  assert.ok(e.fila.every(i => i.tentativas === 0 && !i.providerMessageId && !i.erro));
});

test('MIGRAÇÃO: um estado já em v2 não é alterado', () => {
  const v2 = { ...estadoInicial(), versao: 2, contactos: [{ id: 'c-1', nome: 'A', status: 'SENT', temInstagram: true, campanhas: [] }] };
  const storage = new MemoryStorage({ [CHAVE_ARMAZENAMENTO]: JSON.stringify(v2) });
  const e = new LocalOutreachStore({ storage, estadoInicial }).load();
  assert.equal(e.contactos[0].status, 'SENT', 'a v2 não volta a migrar');
});

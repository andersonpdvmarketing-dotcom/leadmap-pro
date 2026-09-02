/**
 * LeadMap Pro — testes do emparelhamento ManyChat
 * ===============================================
 *   node --test
 *
 * Sem rede: o provider é substituído por um duplo que devolve o que o
 * teste mandar. O que se verifica aqui é sobretudo aquilo que o sistema
 * **recusa** fazer — porque é aí que mora o risco de escrever à pessoa
 * errada.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MATCH_STATUS, emparelharLead, emparelharLote, contar, elegiveis,
  normalizarEmail, normalizarTelefone, normalizarInstagram
} from '../providers/instagram/manychat-matching.mjs';

/** Provider falso: `procura` por chave, `subscribers` por id. */
function duplo({ procura = {}, subscribers = {}, erro = null } = {}) {
  const chamadas = [];
  return {
    chamadas,
    async procurarSubscriber(c) {
      chamadas.push({ tipo: 'procurar', ...c });
      if (erro === 'procurar') throw new Error('ManyChat indisponível');
      const chave = c.email || c.phone;
      return procura[chave] || [];
    },
    async lerSubscriber(id) {
      chamadas.push({ tipo: 'ler', id });
      if (erro === 'ler') throw new Error('falha a ler subscriber');
      if (!subscribers[id]) throw new Error('Subscriber não encontrado na ManyChat.');
      return subscribers[id];
    }
  };
}

const SUB = (id, extra = {}) => ({
  subscriberId: String(id), name: 'Ana Silva', igUsername: 'clinica_alfa',
  igId: '6384638', email: 'ana@exemplo.pt', phone: '+351912345678',
  lastInteraction: '2026-08-30T10:12:00+00:00', ...extra
});

/* ================================================================ *
 * Normalização                                                      *
 * ================================================================ */

test('MATCH: email é normalizado com trim e minúsculas', () => {
  assert.equal(normalizarEmail('  Ana@Exemplo.PT '), 'ana@exemplo.pt');
  assert.equal(normalizarEmail('sem-arroba'), null);
  assert.equal(normalizarEmail(''), null);
  assert.equal(normalizarEmail(null), null);
});

test('MATCH: telefone mantém o país e nunca o inventa', () => {
  assert.deepEqual(normalizarTelefone('+351 912 345 678'), { valor: '+351912345678', paisConhecido: true });
  assert.deepEqual(normalizarTelefone('00351912345678'), { valor: '+351912345678', paisConhecido: true });
  assert.deepEqual(normalizarTelefone('912 345 678'), { valor: '912345678', paisConhecido: false });
  assert.deepEqual(normalizarTelefone('(351) 912-345-678'), { valor: '351912345678', paisConhecido: false });
  assert.equal(normalizarTelefone('123'), null, 'curto demais para ser um número');
  assert.equal(normalizarTelefone(''), null);
});

test('MATCH: Instagram normaliza @, URL e barra final — e nada mais', () => {
  for (const v of ['clinica_alfa', '@clinica_alfa', 'https://instagram.com/clinica_alfa',
                   'https://www.instagram.com/clinica_alfa/', 'CLINICA_ALFA']) {
    assert.equal(normalizarInstagram(v), 'clinica_alfa', 'falhou para ' + v);
  }
  assert.equal(normalizarInstagram('clinica alfa'), null, 'espaços não são um username');
  assert.equal(normalizarInstagram('clinica-alfa!'), null);
});

/* ================================================================ *
 * A ordem de tentativa                                              *
 * ================================================================ */

test('MATCH: email primeiro; o telefone só entra se o email falhar', async () => {
  const p = duplo({
    procura: { 'ana@exemplo.pt': [{ subscriberId: '1' }] },
    subscribers: { 1: SUB(1) }
  });
  const r = await emparelharLead({ email: 'Ana@Exemplo.pt', telefone: '+351912345678', instagram: '@clinica_alfa' }, p);
  assert.equal(r.status, MATCH_STATUS.MATCH_CONFIRMED);
  assert.equal(r.via, 'email');
  assert.equal(p.chamadas.filter(c => c.phone).length, 0, 'não devia ter procurado por telefone');
});

test('MATCH: sem resultado por email, tenta telefone', async () => {
  const p = duplo({
    procura: { '+351912345678': [{ subscriberId: '1' }] },
    subscribers: { 1: SUB(1) }
  });
  const r = await emparelharLead({ email: 'ninguem@exemplo.pt', telefone: '+351 912 345 678', instagram: 'clinica_alfa' }, p);
  assert.equal(r.status, MATCH_STATUS.MATCH_CONFIRMED);
  assert.equal(r.via, 'telefone');
});

test('MATCH: nunca há procura por nome nem por Instagram', async () => {
  const p = duplo({ procura: {}, subscribers: {} });
  await emparelharLead({ email: 'x@y.pt', nome: 'Ana Silva', instagram: 'clinica_alfa' }, p);
  for (const c of p.chamadas) {
    assert.equal(c.name, undefined, 'houve procura por nome');
    assert.equal(c.instagram, undefined, 'houve procura por Instagram');
  }
});

/* ================================================================ *
 * Os estados que §2 exige                                           *
 * ================================================================ */

test('MATCH: sem email nem telefone → NO_LOOKUP_DATA, sem tocar na API', async () => {
  const p = duplo();
  const r = await emparelharLead({ instagram: '@clinica_alfa', nome: 'Ana' }, p);
  assert.equal(r.status, MATCH_STATUS.NO_LOOKUP_DATA);
  assert.match(r.motivo, /não permite procurar por username/);
  assert.equal(p.chamadas.length, 0);
});

test('MATCH: não encontrado → NOT_IN_MANYCHAT', async () => {
  const p = duplo({ procura: {} });
  const r = await emparelharLead({ email: 'ninguem@exemplo.pt' }, p);
  assert.equal(r.status, MATCH_STATUS.NOT_IN_MANYCHAT);
});

test('MATCH: dois subscribers com o mesmo email → AMBIGUOUS_MATCH', async () => {
  const p = duplo({
    procura: { 'ana@exemplo.pt': [{ subscriberId: '1' }, { subscriberId: '2' }] },
    subscribers: { 1: SUB(1), 2: SUB(2) }
  });
  const r = await emparelharLead({ email: 'ana@exemplo.pt' }, p);
  assert.equal(r.status, MATCH_STATUS.AMBIGUOUS_MATCH);
  assert.equal(p.chamadas.filter(c => c.tipo === 'ler').length, 0, 'não devia ler nenhum dos dois');
});

test('MATCH: o mesmo subscriber repetido não é ambiguidade', async () => {
  const p = duplo({
    procura: { 'ana@exemplo.pt': [{ subscriberId: '1' }, { subscriberId: '1' }] },
    subscribers: { 1: SUB(1) }
  });
  const r = await emparelharLead({ email: 'ana@exemplo.pt', instagram: 'clinica_alfa' }, p);
  assert.equal(r.status, MATCH_STATUS.MATCH_CONFIRMED);
});

test('MATCH: Instagram diferente → INSTAGRAM_MISMATCH e nunca elegível', async () => {
  const p = duplo({
    procura: { 'ana@exemplo.pt': [{ subscriberId: '1' }] },
    subscribers: { 1: SUB(1, { igUsername: 'outra_clinica' }) }
  });
  const r = await emparelharLead({ email: 'ana@exemplo.pt', instagram: '@clinica_alfa' }, p);
  assert.equal(r.status, MATCH_STATUS.INSTAGRAM_MISMATCH);
  assert.match(r.motivo, /não é o do lead/);
  assert.equal(elegiveis([r]).length, 0);
});

test('MATCH: opt-out ganha a tudo e não consulta a API', async () => {
  const p = duplo({ procura: { 'ana@exemplo.pt': [{ subscriberId: '1' }] }, subscribers: { 1: SUB(1) } });
  const r = await emparelharLead({ email: 'ana@exemplo.pt', instagram: 'clinica_alfa', optOut: true }, p);
  assert.equal(r.status, MATCH_STATUS.OPTED_OUT);
  assert.equal(p.chamadas.length, 0);
});

test('MATCH: falha do fornecedor → PROVIDER_ERROR, não NOT_IN_MANYCHAT', async () => {
  const a = await emparelharLead({ email: 'ana@exemplo.pt' }, duplo({ erro: 'procurar' }));
  assert.equal(a.status, MATCH_STATUS.PROVIDER_ERROR);
  const b = await emparelharLead({ email: 'ana@exemplo.pt' },
    duplo({ procura: { 'ana@exemplo.pt': [{ subscriberId: '1' }] }, erro: 'ler' }));
  assert.equal(b.status, MATCH_STATUS.PROVIDER_ERROR);
});

/* ================================================================ *
 * §4 — a armadilha do telefone sem país                             *
 * ================================================================ */

test('MATCH: telefone sem indicativo não confirma sozinho', async () => {
  const p = duplo({
    procura: { '912345678': [{ subscriberId: '1' }] },
    subscribers: { 1: SUB(1, { igUsername: null }) }
  });
  const r = await emparelharLead({ telefone: '912 345 678' }, p);
  assert.equal(r.status, MATCH_STATUS.AMBIGUOUS_MATCH);
  assert.match(r.motivo, /sem indicativo de país/);
});

test('MATCH: telefone sem indicativo é aceite se o Instagram cruzar', async () => {
  const p = duplo({
    procura: { '912345678': [{ subscriberId: '1' }] },
    subscribers: { 1: SUB(1) }
  });
  const r = await emparelharLead({ telefone: '912345678', instagram: '@clinica_alfa' }, p);
  assert.equal(r.status, MATCH_STATUS.MATCH_CONFIRMED);
});

test('MATCH: telefone com indicativo confirma sem precisar de Instagram', async () => {
  const p = duplo({
    procura: { '+351912345678': [{ subscriberId: '1' }] },
    subscribers: { 1: SUB(1, { igUsername: null }) }
  });
  const r = await emparelharLead({ telefone: '+351912345678' }, p);
  assert.equal(r.status, MATCH_STATUS.MATCH_CONFIRMED);
  assert.match(r.motivo, /não tem Instagram para cruzar/);
});

/* ================================================================ *
 * Lote                                                              *
 * ================================================================ */

test('MATCH: lote conta por estado e só os confirmados são elegíveis', async () => {
  const p = duplo({
    procura: {
      'ok@exemplo.pt': [{ subscriberId: '1' }],
      'ambiguo@exemplo.pt': [{ subscriberId: '1' }, { subscriberId: '2' }],
      'errado@exemplo.pt': [{ subscriberId: '3' }]
    },
    subscribers: { 1: SUB(1), 2: SUB(2), 3: SUB(3, { igUsername: 'outra' }) }
  });
  const leads = [
    { id: 'a', email: 'ok@exemplo.pt', instagram: 'clinica_alfa' },
    { id: 'b', email: 'ninguem@exemplo.pt' },
    { id: 'c', instagram: 'so_instagram' },
    { id: 'd', email: 'ambiguo@exemplo.pt' },
    { id: 'e', email: 'errado@exemplo.pt', instagram: 'clinica_alfa' },
    { id: 'f', email: 'ok@exemplo.pt', optOut: true }
  ];
  const { resultados, resumo } = await emparelharLote(leads, p);
  assert.equal(resultados.length, 6);
  assert.equal(resumo.MATCH_CONFIRMED, 1);
  assert.equal(resumo.NOT_IN_MANYCHAT, 1);
  assert.equal(resumo.NO_LOOKUP_DATA, 1);
  assert.equal(resumo.AMBIGUOUS_MATCH, 1);
  assert.equal(resumo.INSTAGRAM_MISMATCH, 1);
  assert.equal(resumo.OPTED_OUT, 1);
  assert.equal(elegiveis(resultados).length, 1);
  assert.equal(elegiveis(resultados)[0].lead.id, 'a');
});

test('MATCH: o lote corre em série, para não estourar os limites da API', async () => {
  let simultaneos = 0, pico = 0;
  const p = {
    async procurarSubscriber() {
      simultaneos++; pico = Math.max(pico, simultaneos);
      await new Promise(r => setTimeout(r, 5));
      simultaneos--;
      return [];
    },
    async lerSubscriber() { throw new Error('não usado'); }
  };
  await emparelharLote(Array.from({ length: 6 }, (_, i) => ({ email: 'a' + i + '@x.pt' })), p);
  assert.equal(pico, 1, 'houve chamadas em paralelo — a ManyChat limita getInfo a 10 q/s');
});

test('MATCH: contar cobre todos os estados, mesmo os que não aparecem', () => {
  const c = contar([]);
  for (const s of Object.values(MATCH_STATUS)) assert.equal(c[s], 0, 'falta o estado ' + s);
});

/**
 * LeadMap Pro — testes da UI multi-provider
 * =========================================
 *   node --test
 *
 * O `index.html` é lido como texto: o que se verifica é que o ecrã não
 * promete o que os fornecedores não fazem, e que nenhum segredo lá
 * entra. As rotas são exercitadas a sério, com o despachador real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { despachar, ROTAS } from '../providers/outreach/routes.mjs';
import { criarHashPassword, criarSessao, COOKIE_SESSAO } from '../providers/outreach/auth.mjs';
import { PROVIDER_TYPES } from '../providers/instagram/router.mjs';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const ENV = () => ({
  OUTREACH_ENV: 'test',
  OUTREACH_AUTH_SECRET: 'x'.repeat(48),
  OUTREACH_OPERATOR_EMAIL: 'op@example.com',
  OUTREACH_OPERATOR_PASSWORD_HASH: criarHashPassword('password-de-teste-forte'),
  OUTREACH_WORKER_SECRET: 'w'.repeat(40)
});

async function chamar(nome, { env = ENV(), autenticado = true, metodo = 'GET' } = {}) {
  const anterior = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^OUTREACH|^INSTAGRAM|^MANYCHAT|^SUPABASE|^DATABASE/.test(k)) delete process.env[k];
  Object.assign(process.env, env);
  const cookie = autenticado
    ? COOKIE_SESSAO + '=' + encodeURIComponent(criarSessao({ subject: 'op@example.com', roles: ['outreach:operator', 'outreach:admin'] }, env))
    : '';
  const req = { method: metodo, url: '/api/outreach/' + nome, headers: cookie ? { cookie } : {},
                query: { rota: [nome] }, body: {} };
  const res = { _s: 0, _b: null, _h: {} };
  res.status = s => { res._s = s; return res; };
  res.json = b => { res._b = b; res.writableEnded = true; return res; };
  res.setHeader = () => res; res.end = () => { res.writableEnded = true; return res; };
  const err = console.error; console.error = () => {};
  try { await despachar(req, res); } finally {
    console.error = err;
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, anterior);
  }
  return { status: res._s, corpo: res._b || {} };
}

/* ================================================================ *
 * Seletor de provider                                               *
 * ================================================================ */

test('UI: o seletor de provider existe, com label e três opções', () => {
  assert.match(HTML, /<label for="oContaProvider">Provider<\/label>/);
  assert.match(HTML, /<select[^>]*id="oContaProvider"/);
  for (const v of ['meta', 'manychat', 'external']) {
    assert.match(HTML, new RegExp('<option value="' + v + '"'), 'falta a opção ' + v);
  }
});

test('UI: os valores do seletor são ids estáveis, não etiquetas', () => {
  const bloco = HTML.slice(HTML.indexOf('id="oContaProvider"'), HTML.indexOf('id="oContaProvider"') + 420);
  const valores = [...bloco.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(valores, ['meta', 'manychat', 'external']);
  for (const v of valores) assert.ok(PROVIDER_TYPES.includes(v), v + ' não é um tipo conhecido pelo router');
  /* uma etiqueta como valor partiria a base de dados na primeira tradução */
  for (const v of valores) assert.equal(/[A-Z\s]/.test(v), false, 'valor com maiúsculas ou espaços: ' + v);
});

test('UI: o seletor é acessível — label associada e descrição ligada', () => {
  assert.match(HTML, /id="oContaProvider"[^>]*aria-describedby="oContaProviderDesc"/);
  assert.match(HTML, /id="oContaProviderDesc"/);
  /* o aviso de troca é anunciado, não só mostrado */
  assert.match(HTML, /id="oContaProviderAviso"[^>]*role="status"/);
});

test('UI: as descrições são as pedidas e nenhuma promete demais', () => {
  for (const frase of [
    'Ligação direta à API oficial da Meta',
    'Ligação através da API da ManyChat',
    'Ligação através de um fornecedor externo configurado no LeadMap'
  ]) assert.ok(HTML.includes(frase), 'falta: ' + frase);

  /* §45: o produto não promete o que a plataforma não dá.
     Procura-se no que o utilizador vê, não nos comentários do código —
     um comentário a explicar «nada de ilimitado» não é uma promessa. */
  const visivel = HTML
    .replace(/\/\*[\s\S]*?\*\//g, '')      /* comentários de bloco */
    .replace(/^\s*\/\/.*$/gm, '');          /* comentários de linha */
  const proibidas = /\bilimitad|sem bloqueios?\b|envio livre|DM fria garantida|sem limites\b/i;
  const achado = visivel.match(proibidas);
  assert.equal(achado, null, 'o ecrã usa linguagem que promete demais: ' + (achado && achado[0]));
});

test('UI: trocar provider avisa que a fila antiga não muda', () => {
  assert.ok(HTML.includes('Alterar o provider afeta apenas novos itens colocados na fila. ' +
    'Itens já enfileirados mantêm o provider original.'),
    'falta o aviso — e a semântica do worker é mesmo essa');
});

test('UI: o aviso só aparece quando o provider muda de facto', () => {
  const i = HTML.indexOf('function sincronizarDescricaoProvider');
  const bloco = HTML.slice(i, i + 900);
  assert.match(bloco, /const mudou = Boolean\(anterior\) && sel\.value !== anterior/);
  assert.match(bloco, /aviso\.hidden = !mudou/);
});

test('UI: um provider desconhecido não rebenta o ecrã nem ganha nome inventado', () => {
  const i = HTML.indexOf('function nomeProvider');
  const bloco = HTML.slice(i, i + 260);
  assert.match(bloco, /PROVIDER_NOME\[id\] \|\|/);
  assert.match(bloco, /Não definido/);
});

/* ================================================================ *
 * Cartão da conta                                                   *
 * ================================================================ */

test('UI: o cartão mostra provider e o que esse canal consegue fazer', () => {
  assert.match(HTML, /o-acct-prov/);
  assert.match(HTML, /nomeProvider\(c\.provider\)/);
  assert.match(HTML, /descricaoEnvio\(c\.provider\)/);
});

test('UI: a descrição de envio diz a restrição real de cada canal', () => {
  assert.ok(HTML.includes('Envio apenas para quem já escreveu para esta conta, dentro de 24 horas.'));
  assert.ok(HTML.includes('Envio apenas para contactos que já existem na ManyChat.'));
  assert.ok(HTML.includes('Envio indisponível: provider não definido.'));
});

test('UI: o cartão tem botão de editar, para poder trocar o provider', () => {
  assert.match(HTML, /o-conta-editar/);
});

/* ================================================================ *
 * Configurações → Integrações                                       *
 * ================================================================ */

test('CARDS: Meta e External aparecem, além dos anteriores', async () => {
  const r = await chamar('integrations', { autenticado: false });
  const ids = r.corpo.integracoes.map(i => i.id);
  for (const id of ['meta', 'manychat', 'external']) assert.ok(ids.includes(id), 'falta o card ' + id);
});

test('CARDS: Meta não configurado diz exatamente o que falta', async () => {
  const r = await chamar('integrations', { autenticado: false });
  const meta = r.corpo.integracoes.find(i => i.id === 'meta');
  assert.equal(meta.configurada, false);
  assert.deepEqual(meta.emFalta, ['INSTAGRAM_META_ACCESS_TOKEN']);
});

test('CARDS: Meta configurado ainda não é Meta validado', async () => {
  const r = await chamar('providers', { env: { ...ENV(), INSTAGRAM_META_ACCESS_TOKEN: 'IGAA-x' } });
  const meta = r.corpo.providers.find(p => p.id === 'meta');
  assert.equal(meta.configurado, true);
  assert.equal(meta.estadoLigacao, 'CONFIGURED', 'ter token não pode valer por ligação validada');
});

test('CARDS: /providers nunca devolve credenciais nem o host externo', async () => {
  const env = {
    ...ENV(),
    INSTAGRAM_META_ACCESS_TOKEN: 'IGAA-SEGREDO-meta',
    INSTAGRAM_META_APP_SECRET: 'APPSECRET-SEGREDO',
    MANYCHAT_API_TOKEN: '1:MC-SEGREDO',
    INSTAGRAM_EXTERNAL_BASE_URL: 'https://host-SEGREDO.example',
    INSTAGRAM_EXTERNAL_API_KEY: 'EXT-SEGREDO'
  };
  const r = await chamar('providers', { env });
  const txt = JSON.stringify(r.corpo);
  for (const seg of ['IGAA-SEGREDO-meta', 'APPSECRET-SEGREDO', 'MC-SEGREDO', 'host-SEGREDO', 'EXT-SEGREDO']) {
    assert.equal(txt.includes(seg), false, 'fuga em /providers: ' + seg);
  }
});

test('CARDS: as capacidades vêm dos providers, não do ecrã', async () => {
  const r = await chamar('providers', { env: { ...ENV(), INSTAGRAM_META_ACCESS_TOKEN: 'x', MANYCHAT_API_TOKEN: '1:t' } });
  const meta = r.corpo.providers.find(p => p.id === 'meta');
  const mc = r.corpo.providers.find(p => p.id === 'manychat');
  assert.equal(meta.capabilities.canInitiateFirstContact, false);
  assert.equal(meta.capabilities.canLookupByUsername, false);
  assert.equal(mc.capabilities.canLookupByEmailOrPhone, true);
  assert.equal(mc.capabilities.canLookupByUsername, false);
});

test('CARDS: /providers exige sessão', async () => {
  assert.equal((await chamar('providers', { autenticado: false })).status, 401);
  assert.equal((await chamar('meta-test', { autenticado: false })).status, 401);
});

test('CARDS: meta-test devolve o account ID mascarado', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ id: '17841400000000000', user_id: '17841400000000000',
                         username: 'aminhaloja', name: 'Loja', account_type: 'BUSINESS' })
  });
  try {
    const r = await chamar('meta-test', { env: { ...ENV(), INSTAGRAM_META_ACCESS_TOKEN: 'IGAA-x' } });
    assert.equal(r.corpo.meta.conta.idMascarado, '1784…0000');
    assert.equal(JSON.stringify(r.corpo).includes('17841400000000000'), false, 'o id completo saiu');
  } finally { globalThis.fetch = original; }
});

/* ================================================================ *
 * ManyChat e External preservados                                   *
 * ================================================================ */

test('PRESERVADO: o card ManyChat continua com testar e ver automações', () => {
  assert.match(HTML, /id="cfgMcTestar"/);
  assert.match(HTML, /id="cfgMcFlows"/);
  assert.ok(HTML.includes('Ver automações'));
});

test('PRESERVADO: o External não ganhou campos de credencial no ecrã', () => {
  const i = HTML.indexOf("if (i.id === 'external')");
  const bloco = HTML.slice(i, i + 700);
  assert.equal(/INSTAGRAM_EXTERNAL_API_KEY['"]\s*\)/.test(bloco), false);
  assert.ok(bloco.includes('vivem só no backend'));
});

/* ================================================================ *
 * Segredos no frontend                                              *
 * ================================================================ */

test('SEGURANÇA: nenhum nome de variável tem valor atribuído no HTML', () => {
  for (const nome of ['INSTAGRAM_META_ACCESS_TOKEN', 'INSTAGRAM_META_APP_SECRET',
                      'INSTAGRAM_META_VERIFY_TOKEN', 'INSTAGRAM_EXTERNAL_API_KEY', 'MANYCHAT_API_TOKEN']) {
    assert.equal(new RegExp(nome + '\\s*[=:]\\s*[\'"][^\'"]+[\'"]').test(HTML), false,
      'o index.html atribui valor a ' + nome);
  }
});

test('SEGURANÇA: a UI multi-provider não escreve em storage', () => {
  const i = HTML.indexOf('function sincronizarDescricaoProvider');
  const bloco = HTML.slice(i, i + 1200);
  for (const s of ['localStorage', 'sessionStorage', 'indexedDB']) {
    assert.equal(bloco.includes(s), false, 'o seletor de provider mexe em ' + s);
  }
});

/* ================================================================ *
 * Arquitetura                                                       *
 * ================================================================ */

test('ARQUITETURA: as rotas novas vivem no catch-all', () => {
  for (const n of ['providers', 'meta-test', 'meta-webhook']) {
    assert.equal(typeof ROTAS[n], 'function', 'falta a rota lógica ' + n);
  }
});

test('ARQUITETURA: continuam 7 Serverless Functions', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const base = new URL('../api/', import.meta.url);
  const contar = (dir) => readdirSync(dir).reduce((n, f) => {
    const u = new URL(f + (statSync(new URL(f, dir)).isDirectory() ? '/' : ''), dir);
    return n + (statSync(u).isDirectory() ? contar(u) : (/\.(js|mjs)$/.test(f) ? 1 : 0));
  }, 0);
  assert.equal(contar(base), 7);
});

test('ARQUITETURA: 5 migrations — a 005 traz a identidade do destinatário', async () => {
  const { readdirSync } = await import('node:fs');
  const m = readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort();
  assert.equal(m.length, 5);
  assert.equal(m[4], '005_outreach_instagram_identity.sql');
});

/* ================================================================ *
 * O enum do domínio tem de conhecer os mesmos fornecedores          *
 * ================================================================ */

test('PERSISTÊNCIA: o backend aceita os três providers do seletor', async () => {
  const { OutreachService } = await import('../providers/outreach/service.mjs');
  const { InMemoryOutreachRepository } = await import('../providers/outreach/repository.mjs');
  for (const p of ['meta', 'manychat', 'external']) {
    const svc = new OutreachService({ repository: new InMemoryOutreachRepository(), actor: 't', env: { OUTREACH_ENV: 'test' } });
    const c = await svc.criarConta({ username: 'loja_' + p, displayName: 'L', provider: p });
    assert.equal(c.provider, p, 'o backend recusou ' + p);
  }
});

test('PERSISTÊNCIA: um provider fora da lista é recusado', async () => {
  const { OutreachService } = await import('../providers/outreach/service.mjs');
  const { InMemoryOutreachRepository } = await import('../providers/outreach/repository.mjs');
  const svc = new OutreachService({ repository: new InMemoryOutreachRepository(), actor: 't', env: { OUTREACH_ENV: 'test' } });
  await assert.rejects(() => svc.criarConta({ username: 'x', provider: 'telegram' }), /não permitido/);
});

test('PERSISTÊNCIA: o enum do domínio e os tipos do router não divergem', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../providers/outreach/service.mjs', import.meta.url), 'utf8');
  const m = src.match(/provider: \{ tipo: 'enum', valores: \[([^\]]+)\]/);
  assert.ok(m, 'não encontrei o enum do provider');
  const dominio = m[1].split(',').map(x => x.trim().replace(/'/g, ''));
  /* dois sítios com listas de fornecedores é uma divergência à espera
     de acontecer — foi exatamente o que aconteceu com o manychat */
  assert.deepEqual([...dominio].sort(), [...PROVIDER_TYPES].sort());
});

test('PERSISTÊNCIA: o item de fila herda o provider da conta', async () => {
  const { OutreachService } = await import('../providers/outreach/service.mjs');
  const { InMemoryOutreachRepository } = await import('../providers/outreach/repository.mjs');
  const repo = new InMemoryOutreachRepository();
  const svc = new OutreachService({ repository: repo, actor: 't', env: { OUTREACH_ENV: 'test' } });
  const conta = await svc.criarConta({ username: 'loja', provider: 'manychat' });
  await svc.importarContactos({ contacts: [{ leadId: 'L1', normalizedInstagram: 'c1', name: 'C' }] });
  const cs = await svc.listarContactos({ limit: 10, offset: 0 });
  const k = await svc.criarCampanha({ name: 'C', accountId: conta.id, body: 'Olá' });
  await svc.iniciarCampanha(k.id, { contactIds: cs.items.map(c => c.id) });
  const fila = await svc.listarFila({ campaignId: k.id, limit: 10, offset: 0 });
  assert.equal(fila.items[0].provider, 'manychat', 'o item de fila não guardou o provider da conta');
});

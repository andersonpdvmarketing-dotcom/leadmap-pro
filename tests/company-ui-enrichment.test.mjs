/**
 * LeadMap Pro — ligação do Open Company Intelligence à interface (3.1)
 * ====================================================================
 *   node --test tests/company-ui-enrichment.test.mjs
 *
 * O motor já estava provado; o que se testa aqui é o que o ecrã faz com
 * ele. Sobretudo três coisas que, se falharem, transformam uma
 * funcionalidade útil num incómodo:
 *
 *   1. com a caixa desligada nada acontece — nem um pedido;
 *   2. os leads aparecem antes de a investigação começar;
 *   3. uma resposta de uma pesquisa antiga nunca se cola a leads novos.
 *
 * O `index.html` é lido como texto: é assim que o resto da suite verifica
 * o bloco de script clássico, que não é importável.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CAMPOS } from '../providers/company/contract.mjs';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/** Corpo de uma função do bloco clássico. */
function corpoDe(nome, ate) {
  const i = HTML.indexOf('function ' + nome);
  assert.ok(i > 0, 'função não encontrada: ' + nome);
  const j = ate ? HTML.indexOf(ate, i) : HTML.indexOf('\n}\n', i) + 3;
  assert.ok(j > i, 'fim não encontrado para ' + nome);
  return HTML.slice(i, j);
}

/* ================================================================ *
 * 1 e 2 — a caixa manda                                             *
 * ================================================================ */

test('1: com a caixa desligada não arranca nada', () => {
  const c = corpoDe('startEmpresaEnrichment', 'function cancelarEnriquecimentoEmpresa');
  assert.ok(/enriquecerEmpresa !== true\) return/.test(c),
    'sem esta guarda a pesquisa normal passaria a fazer pedidos que ninguém pediu');
  /* e as outras guardas de sempre continuam lá */
  assert.ok(/IS_FILE\) return/.test(c));
  assert.ok(/currentSource === 'demo'\) return/.test(c), 'dados fictícios não podem gerar consultas reais');
});

test('2: a única chamada a /api/enrich/company está dentro da investigação', () => {
  const ocorrencias = (HTML.match(/\/api\/enrich\/company/g) || []).length;
  assert.equal(ocorrencias, 1, 'a rota é chamada em mais do que um sítio');
  const c = corpoDe('investigarLeadEmpresa', 'function pumpFilaEmpresa');
  assert.ok(c.includes('/api/enrich/company'), 'a chamada devia viver aqui');
});

test('3: a investigação arranca DEPOIS de os leads estarem no ecrã', () => {
  /* no `finally` do runSearch, a seguir aos outros enriquecimentos */
  const i = HTML.indexOf("try { startSocialEnrichment(); startEmailEnrichment(); }");
  const j = HTML.indexOf('startEmpresaEnrichment();', i);
  assert.ok(i > 0 && j > i, 'a investigação empresarial não arranca no sítio certo');
  /* e o render dos leads acontece antes disso */
  const render = HTML.indexOf('renderAll({ animate: true })');
  assert.ok(render > 0 && render < i, 'os leads têm de estar no ecrã primeiro');
});

/* ================================================================ *
 * 4 e 5 — fila                                                      *
 * ================================================================ */

test('4/5: teto de 25 por lote e concorrência 2', () => {
  assert.match(HTML, /const EMPRESA_CONCURRENCY = 2;/);
  assert.match(HTML, /const EMPRESA_MAX_LOTE = 25;/);
  const c = corpoDe('startEmpresaEnrichment', 'function cancelarEnriquecimentoEmpresa');
  assert.ok(/slice\(0, EMPRESA_MAX_LOTE\)/.test(c), 'o teto por lote não é aplicado');
  const p = corpoDe('pumpFilaEmpresa', 'function startEmpresaEnrichment');
  assert.ok(/empresaActivos < EMPRESA_CONCURRENCY/.test(p), 'a concorrência não é respeitada');
});

test('4: a fila prioriza quem pode mudar o resultado', () => {
  const c = corpoDe('ordenarParaInvestigar', 'function renderProgressoEmpresa');
  assert.ok(/website && l\.website !== ND/.test(c), 'sem website não há por onde começar');
  assert.ok(/e\.nif && e\.nif\.valor/.test(c));
  assert.ok(/a\.desconhecidos > 0/.test(c),
    'com critérios ativos, quem está por decidir é quem a investigação desempata');
});

/* ================================================================ *
 * 6 — estados por empresa                                           *
 * ================================================================ */

test('6: os cinco estados existem e o erro é um deles', () => {
  for (const e of ['POR_INVESTIGAR', 'INVESTIGANDO', 'ANALISADA', 'PARCIAL', 'ERRO']) {
    assert.ok(HTML.includes("'" + e + "'"), 'falta o estado ' + e);
  }
  const c = corpoDe('investigarLeadEmpresa', 'function pumpFilaEmpresa');
  assert.ok(/catch \(err\)/.test(c), 'um erro tem de ser apanhado, não propagado');
  assert.ok(/empresaEstado\.set\(lead\.id, 'ERRO'\)/.test(c));
});

test('6: um erro não para a fila', () => {
  const p = corpoDe('pumpFilaEmpresa', 'function startEmpresaEnrichment');
  /* a continuação está no .then, que corre mesmo depois de um erro
     apanhado lá dentro */
  assert.ok(/\.then\(mudou => \{/.test(p));
  assert.ok(/pumpFilaEmpresa\(geracao\);/.test(p), 'a fila não continua');
});

/* ================================================================ *
 * 7 — atualização progressiva                                       *
 * ================================================================ */

test('7: um erro nunca apaga dados empresariais já obtidos', () => {
  const c = corpoDe('aplicarEmpresaInvestigada', 'async function investigarLeadEmpresa');
  assert.ok(/else if \(aTemValor\) \{ novo\[c\] = a; \}/.test(c),
    'um campo que volte vazio não pode levar consigo o que outra fonte já tinha dado');
});

test('7: a resposta redesenha tabela, KPIs e popups — e só quando muda', () => {
  const p = corpoDe('pumpFilaEmpresa', 'function startEmpresaEnrichment');
  assert.ok(/if \(mudou\) \{ computeFiltered\(\); renderTable\(\); renderKPIs\(\); atualizarPopupsEmpresa\(\); \}/.test(p),
    'faltam passos de atualização, ou redesenha-se sem necessidade');
  /* o mapa não é reposicionado: o utilizador pode estar a meio de uma escolha */
  assert.equal(/fitRadius|setCenter/.test(p), false, 'o mapa não pode saltar durante a investigação');
});

test('7: a seleção não é tocada pela investigação', () => {
  const c = corpoDe('startEmpresaEnrichment', 'function cancelarEnriquecimentoEmpresa') +
            corpoDe('pumpFilaEmpresa', 'function startEmpresaEnrichment');
  assert.equal(/state\.selected\.clear\(\)/.test(c), false, 'a investigação apagou a seleção');
});

test('7: o resultado é gravado no snapshot pelo mecanismo existente', () => {
  const c = corpoDe('investigarLeadEmpresa', 'function pumpFilaEmpresa');
  assert.ok(/agendarSincronizacaoSnapshot\(\)/.test(c),
    'sem isto, reabrir a lista perderia o que se investigou');
});

/* ================================================================ *
 * 11 e 12 — snapshot e cancelamento                                 *
 * ================================================================ */

test('12: cada pesquisa tem uma geração, e a antiga é invalidada', () => {
  const c = corpoDe('investigarLeadEmpresa', 'function pumpFilaEmpresa');
  const guardas = (c.match(/geracao !== empresaGeracao/g) || []).length;
  assert.ok(guardas >= 3,
    'a geração tem de ser verificada antes e depois de cada espera: ' + guardas);
  assert.ok(HTML.includes('cancelarEnriquecimentoEmpresa();'), 'nada cancela a fila anterior');
});

test('12: uma nova pesquisa cancela a investigação em curso', () => {
  const i = HTML.indexOf('state.avaliacaoPorte = new Map();');
  const bloco = HTML.slice(i, i + 320);
  assert.ok(/cancelarEnriquecimentoEmpresa\(\)/.test(bloco),
    'o reset da pesquisa devia invalidar a fila anterior');
});

test('11: nenhuma migration foi criada', async () => {
  const { readdirSync } = await import('node:fs');
  const m = readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql'));
  assert.equal(m.length, 5, 'apareceram migrations nesta fase');
});

/* ================================================================ *
 * 5 — contador                                                      *
 * ================================================================ */

test('5: contador discreto, sem modal nem ecrã de carregamento', () => {
  assert.match(HTML, /id="empProgresso"[^>]*role="status"[^>]*aria-live="polite"/);
  const c = corpoDe('renderProgressoEmpresa', 'function aplicarEmpresaInvestigada');
  assert.ok(/A investigar dados empresariais…/.test(c));
  assert.ok(/Dados empresariais analisados:/.test(c));
  /* nada que bloqueie o ecrã */
  assert.equal(/modal|backdrop|overlay|disabled/i.test(c), false, 'o contador não pode bloquear a interface');
});

test('5: o contador desaparece quando não há nada a investigar', () => {
  const c = corpoDe('renderProgressoEmpresa', 'function aplicarEmpresaInvestigada');
  assert.ok(/if \(!empresaTotal\) \{ el\.hidden = true; return; \}/.test(c));
});

/* ================================================================ *
 * 9 e 10 — filtros                                                  *
 * ================================================================ */

test('9: o filtro de CAE compara código e descrição, sem inventar', () => {
  const c = corpoDe('cumpreTextoEmpresa', 'function filtrosEmpresaVazios');
  assert.ok(/normalizeStr\(String\(env\.valor\)\)\.includes\(normalizeStr\(q\)\)/.test(c));
  /* um CAE por consultar não satisfaz o filtro */
  assert.ok(/if \(env\.valor == null\) return false/.test(c));
});

test('10: a semântica dos três modos não foi tocada', () => {
  const c = corpoDe('avaliarEmpresa', 'function scorePorte');
  assert.ok(/modo === 'ESTRITO'/.test(c));
  assert.ok(/modo === 'EXPLORATORIO'/.test(c));
  assert.ok(/passa = naoCumpre === 0/.test(c), 'o modo inteligente mudou de regra');
});

/* ================================================================ *
 * 14 — erros silenciosos                                            *
 * ================================================================ */

test('14: erros esperados não enchem a consola', () => {
  const c = corpoDe('investigarLeadEmpresa', 'function pumpFilaEmpresa');
  assert.equal(/console\.(error|warn)/.test(c), false,
    'um site em baixo é o caso normal, não um incidente para registar 25 vezes');
});

/* ================================================================ *
 * 15 — mobile                                                       *
 * ================================================================ */

test('15: a barra encolhe em vez de criar scroll horizontal', () => {
  assert.ok(/\.emp-prog-t \{[^}]*text-overflow: ellipsis/.test(HTML));
  assert.ok(/\.emp-prog-t \{[^}]*min-width: 0/.test(HTML));
  assert.ok(/@media \(max-width: 560px\) \{ \.emp-prog/.test(HTML), 'falta o ajuste para ecrãs pequenos');
});

test('15: a animação respeita quem prefere movimento reduzido', () => {
  assert.ok(/prefers-reduced-motion: reduce\) \{ \.emp-prog-dot \{ animation: none/.test(HTML));
});

/* ================================================================ *
 * 17 e 18 — nada de pago, nada de novo                              *
 * ================================================================ */

test('17: nenhuma fonte nova e nenhuma API paga', async () => {
  const { COMPANY_PROVIDER_TYPES } = await import('../providers/company/router.mjs');
  assert.deepEqual([...COMPANY_PROVIDER_TYPES], ['website', 'mock']);
  /* nomes de fornecedor com fronteira de palavra: "informa" sozinho
     casaria com "informação" e com o verbo */
  for (const pago of [/\bracius\b/i, /\bnif\.pt\b/i, /\bnifpt\b/i,
                      /\binforma\s*d&b\b/i, /\biberinform\b/i, /\beinforma\b/i]) {
    assert.equal(pago.test(HTML), false, 'o ecrã menciona ' + pago);
  }
});

test('17: o cliente não fala com fontes externas diretamente', () => {
  const c = corpoDe('investigarLeadEmpresa', 'function pumpFilaEmpresa');
  /* tudo passa pelo próprio backend: é lá que vivem as guardas */
  assert.equal(/sicae\.pt|publicacoes\.mj\.pt|https?:\/\//.test(c), false,
    'o browser não pode contactar fontes diretamente');
});

test('o modelo empresarial continua com os mesmos cinco campos', () => {
  const m = HTML.match(/const CAMPOS_EMPRESA = \[([^\]]+)\]/);
  const doEcra = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(doEcra, [...CAMPOS]);
});

/* ================================================================ *
 * Exposição para diagnóstico                                        *
 * ================================================================ */

test('a investigação é inspecionável a partir do browser', () => {
  assert.ok(/investigacao: \{ startEmpresaEnrichment, cancelarEnriquecimentoEmpresa/.test(HTML));
  assert.ok(/progresso: \(\) => \(\{ feitos: empresaFeitos, total: empresaTotal, geracao: empresaGeracao \}\)/.test(HTML));
});

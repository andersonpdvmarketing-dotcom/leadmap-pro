/**
 * LeadMap Pro — extração de dados empresariais de texto público
 * =============================================================
 * Lê o que uma empresa DECLARA sobre si própria no seu próprio site.
 * Não infere, não estima, não conta pessoas em fotografias.
 *
 * A LINHA QUE NÃO SE ATRAVESSA
 * ----------------------------
 * "Somos uma equipa de 75 profissionais" é uma declaração da empresa
 * sobre a sua dimensão: é evidência. Dez caras numa página "Equipa" não
 * é nada — é um layout. Contar elementos de uma listagem e chamar-lhe
 * número de funcionários produziria um número que parece medido e não é,
 * e alguém filtraria "30+ funcionários" com base nisso.
 *
 * Por isso cada extrator exige um padrão linguístico explícito, e na
 * dúvida devolve nada. Não trazer um dado custa uma oportunidade; trazer
 * um dado errado custa credibilidade e uma decisão comercial errada.
 *
 * CONTEXTO PARA AUDITORIA
 * -----------------------
 * Cada achado guarda um excerto curto à volta do sítio onde foi lido —
 * o suficiente para alguém verificar, sem copiar a página.
 */

/** Excerto guardado à volta de um achado. Curto de propósito. */
const CONTEXTO_CHARS = 90;

function contexto(texto, indice, tamanho) {
  const i = Math.max(0, indice - 35);
  const f = Math.min(texto.length, indice + tamanho + 45);
  return texto.slice(i, f).replace(/\s+/g, ' ').trim().slice(0, CONTEXTO_CHARS);
}

/* ---------------------------------------------------------------- *
 * Números em português                                              *
 * ---------------------------------------------------------------- */

/**
 * "1.250.000,50" → 1250000.5 · "75" → 75 · "2,5" → 2.5
 *
 * O ponto é separador de milhares em português e a vírgula é decimal —
 * ao contrário do inglês. Trocar os dois transforma €1.500 em €1500,00
 * ou pior.
 */
export function numeroPt(bruto) {
  if (bruto == null) return null;
  let s = String(bruto).trim().replace(/\s/g, '');
  if (!s) return null;
  const temPonto = s.includes('.'), temVirgula = s.includes(',');
  if (temPonto && temVirgula) s = s.replace(/\./g, '').replace(',', '.');
  else if (temVirgula) s = s.replace(',', '.');
  else if (temPonto) {
    /* "1.250" é mil duzentos e cinquenta; "1.5" seria decimal inglês e
       não se assume: grupos de três dígitos revelam milhares */
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Multiplicadores escritos por extenso. */
const ESCALAS = [
  { re: /\b(mil\s*milh(?:õ|o)es|bili(?:õ|o)es)\b/i, x: 1e9 },
  { re: /\bmilh(?:õ|o)es?\b/i, x: 1e6 },
  { re: /\bmil\b/i, x: 1e3 },
  { re: /\bM\b/, x: 1e6 },
  { re: /\bK\b/i, x: 1e3 }
];

function aplicarEscala(valor, sufixo) {
  if (valor == null) return null;
  for (const e of ESCALAS) if (e.re.test(sufixo)) return valor * e.x;
  return valor;
}

/**
 * Linguagem que denuncia um número AGREGADO, não individual.
 *
 * "Volume de negócios do setor: média de 300.000 € por empresa" é uma
 * estatística de mercado. Importá-la como faturação desta empresa seria
 * exatamente o erro que o modelo de evidências existe para impedir: um
 * número verdadeiro sobre o mundo, atribuído à entidade errada.
 *
 * Na dúvida não se traz o dado. Uma frase sobre o setor que fale de si
 * própria em termos ambíguos é preferível descartar.
 */
const AGREGADO = /\b(?:do\s+setor|do\s+sector|no\s+setor|no\s+sector|m(?:é|e)dia|mediana|por\s+empresa|em\s+m(?:é|e)dia|nacional|do\s+mercado|da\s+ind(?:ú|u)stria|INE|estat(?:í|i)stic)/i;

/** A vizinhança do achado fala de agregados em vez desta empresa? */
function pareceAgregado(t, inicio, fim) {
  return AGREGADO.test(t.slice(Math.max(0, inicio - 40), fim + 60));
}

/**
 * Procura um valor monetário numa janela depois de um rótulo.
 *
 * Existe porque frases reais metem um ano entre o rótulo e o número —
 * "faturação 2025: 2.400.000 €". Uma expressão que exigisse o número
 * imediatamente a seguir apanharia o ano e desistiria. Aqui varrem-se os
 * candidatos da janela e escolhe-se o primeiro que se comporta como
 * dinheiro: tem moeda ou escala ao lado, ou é grande de mais para ser
 * um ano.
 */
function valorMonetarioApos(t, fim, janela = 70) {
  const trecho = t.slice(fim, fim + janela);
  const re = /([\d][\d.,]{0,19})\s*(€|EUR|euros?|milh(?:õ|o)es?|mil|M\b|K\b)?/gi;
  let m;
  while ((m = re.exec(trecho)) !== null) {
    const base = numeroPt(m[1]);
    if (base == null) continue;
    const sufixo = m[2] || '';
    const temMoeda = Boolean(sufixo);
    /* um ano solto sem moeda nem escala não é um valor */
    if (!temMoeda && base >= 1900 && base <= 2100) continue;
    const valor = aplicarEscala(base, sufixo);
    if (valor == null) continue;
    return { valor, deslocamento: m.index, comprimento: m[0].length, temMoeda };
  }
  return null;
}

/* ---------------------------------------------------------------- *
 * Capital social                                                    *
 * ---------------------------------------------------------------- */

/**
 * "Capital Social: €100.000" · "capital social de 50.000 euros"
 *
 * Exige sempre o rótulo. Um número com € ao lado numa página pode ser um
 * preço, um prémio ou uma faturação — só o rótulo distingue.
 */
export function extrairCapitalSocial(t) {
  if (typeof t !== 'string' || !t) return [];
  const re = /capital\s+social(?:\s+(?:de|é|:|no\s+valor\s+de|em))?/gi;
  const achados = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    const fim = m.index + m[0].length;
    const v = valorMonetarioApos(t, fim);
    if (!v) continue;
    /* abaixo de 1 € ou acima de mil milhões não é leitura credível:
       quase de certeza apanhou-se outra coisa */
    if (!(v.valor >= 1 && v.valor <= 1e9)) continue;
    /* §9: uma estatística do setor não é o número desta empresa */
    if (pareceAgregado(t, m.index, fim + v.deslocamento + v.comprimento)) continue;
    achados.push({ campo: 'capitalSocial', valor: v.valor, contexto: contexto(t, m.index, (fim - m.index) + v.deslocamento + v.comprimento) });
  }
  return dedup(achados);
}

/* ---------------------------------------------------------------- *
 * CAE                                                               *
 * ---------------------------------------------------------------- */

/** "CAE 62010" · "CAE principal: 41200" — cinco dígitos, com rótulo. */
export function extrairCae(t) {
  if (typeof t !== 'string' || !t) return [];
  const re = /\bCAE\b(?:\s*(?:principal|prim(?:á|a)rio|rev\.?\s*\d))?\s*[:\-–—n.º°]*\s*(\d{5})\b/gi;
  const achados = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    achados.push({ campo: 'cae', valor: m[1], contexto: contexto(t, m.index, m[0].length) });
  }
  return dedup(achados);
}

/* ---------------------------------------------------------------- *
 * Funcionários                                                      *
 * ---------------------------------------------------------------- */

/**
 * Só afirmações sobre a dimensão da empresa.
 *
 * `operador` distingue "somos 75" de "mais de 75": o segundo é um
 * mínimo, e um mínimo satisfaz "30+" com a mesma legitimidade — mas não
 * pode ser apresentado como o número exato.
 */
const PESSOAS = '(?:colaboradores?|funcion(?:á|a)rios?|profissionais|empregados?|pessoas|trabalhadores?|especialistas|t(?:é|e)cnicos?)';

export function extrairFuncionarios(t) {
  if (typeof t !== 'string' || !t) return [];
  const achados = [];

  /* "mais de 120 colaboradores" · "superior a 50 funcionários" */
  const reMin = new RegExp('\\b(?:mais\\s+de|superior\\s+a|acima\\s+de|over|\\+\\s*de)\\s*([\\d.,]{1,9})\\s*' + PESSOAS, 'gi');
  /* "equipa de 75 profissionais" · "conta com 40 colaboradores" · "75 colaboradores" */
  const reExato = new RegExp('\\b(?:equipa\\s+(?:de|com)|conta\\s+com|somos|contamos\\s+com|uma\\s+equipa\\s+de|quadro\\s+de)\\s*([\\d.,]{1,9})\\s*' + PESSOAS, 'gi');

  for (const [re, operador] of [[reMin, '>='], [reExato, '=']]) {
    let m;
    while ((m = re.exec(t)) !== null) {
      const v = numeroPt(m[1]);
      /* abaixo de 1 não é uma empresa; acima de 500 mil é quase de certeza
         outra coisa a ser lida como pessoas */
      if (v == null || !(v >= 1 && v <= 500000)) continue;
      if (pareceAgregado(t, m.index, m.index + m[0].length)) continue;
      achados.push({ campo: 'funcionarios', valor: Math.round(v), operador, contexto: contexto(t, m.index, m[0].length) });
    }
  }
  return dedup(achados);
}

/* ---------------------------------------------------------------- *
 * Faturação                                                         *
 * ---------------------------------------------------------------- */

/**
 * "Volume de negócios de €5 milhões" · "faturação 2025: 2.400.000 €"
 *
 * Só a faturação DESTA empresa. Uma média do setor não entra aqui — e
 * como o extrator exige o rótulo junto do número, uma frase sobre o
 * mercado não o aciona.
 */
export function extrairFaturacao(t) {
  if (typeof t !== 'string' || !t) return [];
  const re = /\b(?:volume\s+de\s+neg(?:ó|o)cios|factura(?:ç|c)(?:ã|a)o|fatura(?:ç|c)(?:ã|a)o|receitas?\s+anuais?|turnover)\b/gi;
  const achados = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    const fim = m.index + m[0].length;
    const v = valorMonetarioApos(t, fim);
    if (!v) continue;
    if (!(v.valor >= 1000 && v.valor <= 1e11)) continue;
    /* §9: uma estatística do setor não é o número desta empresa */
    if (pareceAgregado(t, m.index, fim + v.deslocamento + v.comprimento)) continue;
    achados.push({ campo: 'faturacaoAnual', valor: v.valor, contexto: contexto(t, m.index, (fim - m.index) + v.deslocamento + v.comprimento) });
  }
  return dedup(achados);
}

/* ---------------------------------------------------------------- *
 * Tudo junto                                                        *
 * ---------------------------------------------------------------- */

/** Todos os achados de uma página. */
export function extrairTudo(t) {
  return [
    ...extrairCapitalSocial(t),
    ...extrairCae(t),
    ...extrairFuncionarios(t),
    ...extrairFaturacao(t)
  ];
}

function dedup(achados) {
  const vistos = new Set();
  const out = [];
  for (const a of achados) {
    const k = a.campo + '|' + a.valor + '|' + (a.operador || '');
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push(a);
  }
  return out;
}

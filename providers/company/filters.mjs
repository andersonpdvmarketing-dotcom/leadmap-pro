/**
 * LeadMap Pro — filtros de porte empresarial
 * ==========================================
 * Decide o que o utilizador vê quando pede critérios de porte. Não fala
 * com a rede, não conhece fornecedores, não lê o DOM.
 *
 * TRÊS ESTADOS, NÃO DOIS
 * ----------------------
 * A pergunta "esta empresa tem 30+ funcionários?" tem três respostas
 * possíveis, não duas: sim, não, e não se sabe. Um motor que só conheça
 * as duas primeiras é obrigado a tratar a ignorância como um "não" — e
 * apaga do ecrã precisamente as empresas que ainda valia a pena
 * investigar. Sem fornecedor configurado, apagá-las-ia a todas.
 *
 * Daí STATUS_CRITERIO: CUMPRE, NAO_CUMPRE, DESCONHECIDO. Ausência de
 * dado produz DESCONHECIDO, nunca NAO_CUMPRE. Uma empresa cujos
 * funcionários ninguém consultou não tem zero funcionários — tem
 * funcionários desconhecidos, e desconhecido não é maior nem menor do
 * que 30.
 *
 * O QUE CADA MODO FAZ COM A IGNORÂNCIA
 * ------------------------------------
 * ESTRITO exige certeza e aceita perder empresas por isso. INTELIGENTE
 * — o default — só exclui quem comprovadamente falha, e ordena o resto
 * por força de evidência. EXPLORATORIO não exclui nada e limita-se a
 * marcar o que se sabe de cada uma.
 *
 * Nenhum deles deixa um dado em falta CONTAR COMO CUMPRIDO: a diferença
 * está em quem sobrevive à lista, não em fingir que se sabe.
 *
 * COMPATIBILIDADE
 * ---------------
 * `cumpreMinimo` e `cumpreTexto` continuam a existir com a semântica
 * booleana da primeira versão, porque são a resposta certa à pergunta
 * "há evidência de que cumpre?". O que mudou foi quem as chama e o que
 * faz com um "não" — hoje passa por `avaliarCriterioNumerico`, que
 * distingue o "não" do "não sei".
 */

import { ESTADO_DADO, CAMPOS_NUMERICOS, temValor } from './contract.mjs';

/* ---------------------------------------------------------------- *
 * Qualidade exigida                                                 *
 * ---------------------------------------------------------------- */

/**
 * Que estados podem satisfazer um critério.
 *
 * `TODOS` não significa "qualquer coisa serve": significa os mesmos
 * estados com valor que `CONFIRMADO_ESTIMADO`. Um dado inexistente
 * continua a não satisfazer nada — o nome refere-se aos dados
 * disponíveis, não à ausência deles.
 */
export const QUALIDADE = Object.freeze({
  CONFIRMADO: 'CONFIRMADO',
  CONFIRMADO_ESTIMADO: 'CONFIRMADO_ESTIMADO',
  TODOS: 'TODOS'
});

export const QUALIDADE_VALIDA = Object.freeze(Object.keys(QUALIDADE));

/** Rótulos da interface. */
export const QUALIDADE_ROTULO = Object.freeze({
  CONFIRMADO: 'Somente confirmados',
  CONFIRMADO_ESTIMADO: 'Confirmados + estimados',
  TODOS: 'Todos os dados disponíveis'
});

const ESTADOS_ACEITES = Object.freeze({
  /* CONFLITO tem valor, mas é um valor que duas fontes disputam: não
     pode contar como confirmado. Entra a partir do nível que aceita
     dados não assentes. */
  CONFIRMADO: [ESTADO_DADO.CONFIRMADO],
  CONFIRMADO_ESTIMADO: [ESTADO_DADO.CONFIRMADO, ESTADO_DADO.ESTIMADO],
  TODOS: [ESTADO_DADO.CONFIRMADO, ESTADO_DADO.ESTIMADO, ESTADO_DADO.CONFLITO]
});

/** Estados que este nível de qualidade aceita. */
export function estadosAceites(qualidade) {
  return ESTADOS_ACEITES[qualidade] || ESTADOS_ACEITES.CONFIRMADO_ESTIMADO;
}

/* ---------------------------------------------------------------- *
 * Decisão                                                           *
 * ---------------------------------------------------------------- */

/**
 * O envelope satisfaz um mínimo numérico?
 *
 * `minimo` nulo significa "sem critério" e devolve sempre true — não há
 * nada a cumprir.
 */
export function cumpreMinimo(env, minimo, qualidade = QUALIDADE.CONFIRMADO_ESTIMADO) {
  if (minimo == null || minimo === '') return true;
  const min = Number(minimo);
  if (!Number.isFinite(min)) return true;          /* critério inválido não filtra nada */
  if (!env || typeof env !== 'object') return false;
  if (!estadosAceites(qualidade).includes(env.estado)) return false;
  if (env.valor == null) return false;             /* ausência nunca é zero */
  const v = Number(env.valor);
  if (!Number.isFinite(v)) return false;
  return v >= min;
}

/**
 * Porque é que este envelope não cumpriu — para a interface poder
 * explicar uma lista vazia em vez de a deixar parecer uma avaria.
 *
 * Devolve null quando cumpriu.
 */
export function motivoExclusao(env, minimo, qualidade = QUALIDADE.CONFIRMADO_ESTIMADO) {
  if (cumpreMinimo(env, minimo, qualidade)) return null;
  const estado = env && env.estado;
  if (estado === ESTADO_DADO.NAO_CONSULTADO) return 'SEM_DADOS';
  if (estado === ESTADO_DADO.NAO_ENCONTRADO) return 'SEM_DADOS';
  if (estado === ESTADO_DADO.ESTIMADO && !estadosAceites(qualidade).includes(ESTADO_DADO.ESTIMADO)) {
    return 'QUALIDADE_INSUFICIENTE';
  }
  return 'ABAIXO_DO_MINIMO';
}

/**
 * Texto livre contra um envelope de texto (CAE, por exemplo).
 *
 * Compara código e descrição, sem acentos e sem maiúsculas, porque um CAE
 * pode chegar como "41200" ou como "Construção de edifícios".
 */
export function cumpreTexto(env, procura, qualidade = QUALIDADE.CONFIRMADO_ESTIMADO) {
  const q = String(procura == null ? '' : procura).trim();
  if (!q) return true;
  if (!env || typeof env !== 'object') return false;
  if (!estadosAceites(qualidade).includes(env.estado)) return false;
  if (env.valor == null) return false;
  return normalizar(String(env.valor)).includes(normalizar(q));
}

function normalizar(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/* ---------------------------------------------------------------- *
 * Critérios de uma pesquisa                                         *
 * ---------------------------------------------------------------- */

/** Nenhum critério de porte. É o estado por omissão. */
export function filtrosEmpresaVazios() {
  return {
    minFuncionarios: null,
    minFaturacaoAnual: null,
    minCapitalSocial: null,
    caeQuery: '',
    estadoEmpresa: '',
    qualidadeDados: QUALIDADE.CONFIRMADO_ESTIMADO,
    modoCorrespondencia: MODO.INTELIGENTE,
    enriquecerEmpresa: false
  };
}

/**
 * Algum critério está ativo?
 *
 * `qualidadeDados` e `enriquecerEmpresa` não contam: o primeiro modula
 * critérios, o segundo é uma intenção de recolha. Sem critério nenhum a
 * pesquisa tem de comportar-se exatamente como antes desta fase.
 */
export function temCriterioEmpresa(f) {
  if (!f) return false;
  return f.minFuncionarios != null || f.minFaturacaoAnual != null || f.minCapitalSocial != null ||
    Boolean(String(f.caeQuery || '').trim()) || Boolean(String(f.estadoEmpresa || '').trim());
}

/** Os campos empresariais que os critérios ativos exigem. */
export function camposExigidos(f) {
  const out = [];
  if (!f) return out;
  if (f.minFuncionarios != null) out.push('funcionarios');
  if (f.minFaturacaoAnual != null) out.push('faturacaoAnual');
  if (f.minCapitalSocial != null) out.push('capitalSocial');
  if (String(f.caeQuery || '').trim()) out.push('cae');
  return out;
}

/* ---------------------------------------------------------------- *
 * Estado de um critério                                             *
 * ---------------------------------------------------------------- */

/**
 * CUMPRE       — há evidência válida de que cumpre.
 * NAO_CUMPRE   — há evidência válida de que NÃO cumpre.
 * DESCONHECIDO — não há informação suficiente para dizer qualquer coisa.
 *
 * A distinção entre os dois últimos é o coração deste motor. Uma empresa
 * cujos funcionários ninguém consultou não é uma empresa que falhou o
 * critério: é uma empresa por investigar. Tratá-las da mesma maneira
 * apagava do ecrã exatamente os negócios que ainda valia a pena olhar —
 * e, sem fornecedor configurado, apagava-os a todos.
 */
export const STATUS_CRITERIO = Object.freeze({
  CUMPRE: 'CUMPRE',
  NAO_CUMPRE: 'NAO_CUMPRE',
  DESCONHECIDO: 'DESCONHECIDO'
});

/* ---------------------------------------------------------------- *
 * Modos de correspondência                                          *
 * ---------------------------------------------------------------- */

/**
 * ESTRITO      — só empresas com TODOS os critérios confirmados.
 * INTELIGENTE  — exclui quem falha comprovadamente; mantém o que ainda
 *                não se sabe, ordenado por força de evidência.
 * EXPLORATORIO — mostra tudo o que foi descoberto, marcando cada
 *                critério.
 *
 * INTELIGENTE é o default porque é o único que não confunde "não
 * cumpre" com "ainda não sei".
 */
export const MODO = Object.freeze({
  ESTRITO: 'ESTRITO',
  INTELIGENTE: 'INTELIGENTE',
  EXPLORATORIO: 'EXPLORATORIO'
});

export const MODOS_VALIDOS = Object.freeze(Object.keys(MODO));

export const MODO_ROTULO = Object.freeze({
  ESTRITO: 'Estrito',
  INTELIGENTE: 'Inteligente',
  EXPLORATORIO: 'Exploratório'
});

export const MODO_DESCRICAO = Object.freeze({
  ESTRITO: 'Só empresas com todos os critérios confirmados.',
  INTELIGENTE: 'Exclui quem comprovadamente não cumpre. Mantém quem ainda está por investigar.',
  EXPLORATORIO: 'Mostra tudo o que foi descoberto, marcando o que já se sabe de cada empresa.'
});

/* ---------------------------------------------------------------- *
 * Classificação de correspondência                                  *
 * ---------------------------------------------------------------- */

export const MATCH = Object.freeze({
  FORTE: 'FORTE',
  PARCIAL: 'PARCIAL',
  INCONCLUSIVO: 'INCONCLUSIVO',
  NAO_CUMPRE: 'NAO_CUMPRE'
});

export const MATCH_ROTULO = Object.freeze({
  FORTE: 'Match forte',
  PARCIAL: 'Match parcial',
  INCONCLUSIVO: 'Inconclusivo',
  NAO_CUMPRE: 'Não cumpre'
});

/* ---------------------------------------------------------------- *
 * Avaliação                                                         *
 * ---------------------------------------------------------------- */

/**
 * Estado de um critério numérico face a um envelope.
 *
 * Sem dado utilizável, DESCONHECIDO — nunca NAO_CUMPRE. É a diferença
 * entre "esta empresa é pequena" e "não sei o tamanho desta empresa".
 */
export function avaliarCriterioNumerico(env, minimo, qualidade = QUALIDADE.CONFIRMADO_ESTIMADO) {
  if (minimo == null || minimo === '') return STATUS_CRITERIO.CUMPRE;
  const min = Number(minimo);
  if (!Number.isFinite(min)) return STATUS_CRITERIO.CUMPRE;
  if (!temValor(env)) return STATUS_CRITERIO.DESCONHECIDO;
  const v = Number(env.valor);
  if (!Number.isFinite(v)) return STATUS_CRITERIO.DESCONHECIDO;
  /* o dado existe mas o nível de qualidade escolhido não o aceita: não
     se sabe o suficiente PARA ESTE UTILIZADOR, logo desconhecido */
  if (!estadosAceites(qualidade).includes(env.estado)) return STATUS_CRITERIO.DESCONHECIDO;
  return v >= min ? STATUS_CRITERIO.CUMPRE : STATUS_CRITERIO.NAO_CUMPRE;
}

/** O mesmo para um critério de texto, como o CAE. */
export function avaliarCriterioTexto(env, procura, qualidade = QUALIDADE.CONFIRMADO_ESTIMADO) {
  const q = String(procura == null ? '' : procura).trim();
  if (!q) return STATUS_CRITERIO.CUMPRE;
  if (!temValor(env)) return STATUS_CRITERIO.DESCONHECIDO;
  if (!estadosAceites(qualidade).includes(env.estado)) return STATUS_CRITERIO.DESCONHECIDO;
  return normalizar(String(env.valor)).includes(normalizar(q))
    ? STATUS_CRITERIO.CUMPRE : STATUS_CRITERIO.NAO_CUMPRE;
}

/** Match a partir dos estados dos critérios. */
export function classificarMatch(status) {
  const vs = Object.values(status || {});
  if (!vs.length) return MATCH.FORTE;                       /* sem critérios, tudo serve */
  if (vs.includes(STATUS_CRITERIO.NAO_CUMPRE)) return MATCH.NAO_CUMPRE;
  if (vs.every(v => v === STATUS_CRITERIO.CUMPRE)) return MATCH.FORTE;
  if (vs.some(v => v === STATUS_CRITERIO.CUMPRE)) return MATCH.PARCIAL;
  return MATCH.INCONCLUSIVO;                                /* só desconhecidos */
}

/**
 * Avalia uma empresa contra os critérios, no modo escolhido.
 *
 * Devolve sempre o estado de cada critério, mesmo quando não passa: é
 * isso que permite ao ecrã dizer "faturação: informação não encontrada"
 * em vez de deixar o utilizador a supor que foi verificada.
 */
export function avaliarEmpresa(empresa, f) {
  const modo = (f && MODOS_VALIDOS.includes(f.modoCorrespondencia)) ? f.modoCorrespondencia : MODO.INTELIGENTE;
  if (!temCriterioEmpresa(f)) {
    return { passa: true, status: {}, match: MATCH.FORTE, modo,
             confirmados: 0, desconhecidos: 0, naoCumpre: 0, total: 0, forca: 0 };
  }
  const q = f.qualidadeDados || QUALIDADE.CONFIRMADO_ESTIMADO;
  const e = empresa || {};
  const status = {};

  for (const [campo, minimo] of [['funcionarios', f.minFuncionarios],
                                 ['faturacaoAnual', f.minFaturacaoAnual],
                                 ['capitalSocial', f.minCapitalSocial]]) {
    if (minimo == null) continue;
    if (!CAMPOS_NUMERICOS.includes(campo)) continue;
    status[campo] = avaliarCriterioNumerico(e[campo], minimo, q);
  }

  const cae = String((f && f.caeQuery) || '').trim();
  if (cae) status.cae = avaliarCriterioTexto(e.cae, cae, q);

  /* O modelo não tem estado jurídico e não o vai inferir. O critério
     fica DESCONHECIDO — que é a verdade — em vez de excluir toda a
     gente como se soubéssemos que não cumprem. */
  if (String((f && f.estadoEmpresa) || '').trim()) status.estadoEmpresa = STATUS_CRITERIO.DESCONHECIDO;

  const vs = Object.values(status);
  const confirmados = vs.filter(v => v === STATUS_CRITERIO.CUMPRE).length;
  const desconhecidos = vs.filter(v => v === STATUS_CRITERIO.DESCONHECIDO).length;
  const naoCumpre = vs.filter(v => v === STATUS_CRITERIO.NAO_CUMPRE).length;
  const match = classificarMatch(status);

  let passa;
  if (modo === MODO.ESTRITO) passa = vs.length > 0 && vs.every(v => v === STATUS_CRITERIO.CUMPRE);
  else if (modo === MODO.EXPLORATORIO) passa = true;
  else passa = naoCumpre === 0;   /* INTELIGENTE: só sai quem comprovadamente falha */

  return {
    passa, status, match, modo, confirmados, desconhecidos, naoCumpre,
    total: vs.length,
    /* Para ordenar: mais critérios confirmados primeiro, e entre iguais
       quem tem menos incógnitas. Não é uma pontuação de porte — é a
       força da evidência sobre os critérios que o utilizador pediu. */
    forca: confirmados * 10 - desconhecidos
  };
}

/**
 * Ordena por força de evidência, sem alterar a ordem relativa de quem
 * empata — a distância continua a decidir nesses casos.
 */
export function ordenarPorEvidencia(leads, f, lerEmpresaDe) {
  if (!temCriterioEmpresa(f)) return leads;
  return leads
    .map((l, i) => ({ l, i, a: avaliarEmpresa(lerEmpresaDe(l), f) }))
    .sort((x, y) => (y.a.forca - x.a.forca) || (x.i - y.i))
    .map(x => x.l);
}

/* ---------------------------------------------------------------- *
 * Score de porte — preparado, não calculado                         *
 * ---------------------------------------------------------------- */

/**
 * Reservado para uma fase futura.
 *
 * Devolve null enquanto não houver dados suficientes, e hoje não há
 * nenhum: inventar um número entre 0 e 100 a partir de campos vazios
 * seria exatamente o tipo de falsa precisão que este modelo existe para
 * evitar. A assinatura fica fixada para que o resto do código já possa
 * contar com ela.
 */
export function scorePorte(empresa) {
  const e = empresa || {};
  const comValor = ['funcionarios', 'faturacaoAnual', 'capitalSocial']
    .filter(c => e[c] && e[c].valor != null &&
      (e[c].estado === ESTADO_DADO.CONFIRMADO || e[c].estado === ESTADO_DADO.ESTIMADO));
  if (comValor.length < 2) return null;   /* um sinal isolado não é um porte */
  return null;                            /* fórmula por definir — Fase futura */
}

/**
 * LeadMap Pro — contrato CompanyEnrichmentProvider
 * ================================================
 * Tipos, enumerações e validadores partilhados por todos os fornecedores de
 * dados empresariais. Este ficheiro não fala com a rede nem conhece nenhum
 * fornecedor concreto: é o único sítio onde está escrito o que um
 * fornecedor tem de cumprir.
 *
 * A REGRA QUE DÁ ORIGEM A TUDO O RESTO
 * ------------------------------------
 * Dados de porte económico são, em grande parte do mercado, MODELADOS e não
 * declarados: um fornecedor que devolve "faturação: 1.2M€" pode estar a
 * estimar a partir do setor e do número de funcionários. Apresentar isso ao
 * lado de um capital social lido do registo comercial, com o mesmo aspeto,
 * é transformar um palpite em facto.
 *
 * Por isso nenhum valor circula aqui sozinho. Todo o dado empresarial viaja
 * dentro de um envelope que diz de onde veio, quando, com que confiança, e
 * se é confirmado ou estimado. Um fornecedor não pode devolver um número
 * solto nem que queira: `envelope()` recusa-o.
 *
 * AUSÊNCIA NÃO É ZERO
 * -------------------
 * Uma empresa sem dados de faturação não fatura zero — não se sabe quanto
 * fatura. São coisas diferentes e filtram de maneira diferente. Daí quatro
 * estados distintos, e `valor: null` em três deles.
 */

/* ---------------------------------------------------------------- *
 * 1. Campos empresariais                                            *
 * ---------------------------------------------------------------- */

/**
 * Os campos que o modelo empresarial conhece. Lista fechada: um campo fora
 * disto é um erro de programação, não um campo novo silencioso.
 */
export const CAMPOS = Object.freeze([
  'nif',              /* NIF/NIPC português, 9 dígitos, com dígito de controlo válido */
  'cae',              /* Classificação Portuguesa de Atividades Económicas */
  'funcionarios',     /* número de pessoas ao serviço */
  'faturacaoAnual',   /* volume de negócios anual, em euros */
  'capitalSocial'     /* capital social, em euros */
]);

/** Campos cujo valor é numérico — validados como tal. */
export const CAMPOS_NUMERICOS = Object.freeze(['funcionarios', 'faturacaoAnual', 'capitalSocial']);

/** Rótulos para interface. Mantidos aqui para não se dispersarem pelo HTML. */
export const CAMPO_ROTULO = Object.freeze({
  nif: 'NIF / NIPC',
  cae: 'CAE',
  funcionarios: 'Funcionários',
  faturacaoAnual: 'Faturação anual',
  capitalSocial: 'Capital social'
});

/* ---------------------------------------------------------------- *
 * 2. Estado de um dado                                              *
 * ---------------------------------------------------------------- */

/**
 * CONFIRMADO      — veio de uma fonte que o declara. Tem valor.
 * ESTIMADO        — foi modelado ou inferido pelo fornecedor. Tem valor,
 *                   e a interface é obrigada a dizer que é estimativa.
 * NAO_ENCONTRADO  — procurou-se mesmo e não existe. Não tem valor.
 * NAO_CONSULTADO  — ainda não se procurou. Não tem valor.
 *
 * A distinção entre os dois últimos é a que impede o ecrã de mentir: dizer
 * "Não encontrado" sobre algo que nunca foi consultado é uma afirmação
 * falsa sobre o mundo.
 */
export const ESTADO_DADO = Object.freeze({
  CONFIRMADO: 'CONFIRMADO',
  ESTIMADO: 'ESTIMADO',
  NAO_ENCONTRADO: 'NAO_ENCONTRADO',
  NAO_CONSULTADO: 'NAO_CONSULTADO',
  /* Duas fontes credíveis discordam e nenhuma se impõe. Tem valor — o
     que o motor escolheu — mas o utilizador tem de saber que há
     desacordo, em vez de ver um número que parece assente. */
  CONFLITO: 'CONFLITO'
});

export const ESTADOS_VALIDOS = Object.freeze(Object.keys(ESTADO_DADO));

/** Os únicos estados em que um valor pode existir. */
export const ESTADOS_COM_VALOR = Object.freeze([
  ESTADO_DADO.CONFIRMADO, ESTADO_DADO.ESTIMADO, ESTADO_DADO.CONFLITO
]);

/** O que o utilizador lê. Nenhum destes rótulos afirma mais do que se sabe. */
export const ESTADO_ROTULO = Object.freeze({
  CONFIRMADO: 'Confirmado',
  ESTIMADO: 'Estimativa',
  NAO_ENCONTRADO: 'Não encontrado',
  NAO_CONSULTADO: 'Por consultar',
  CONFLITO: 'Fontes divergem'
});

/* ---------------------------------------------------------------- *
 * Tipo de fonte                                                     *
 * ---------------------------------------------------------------- */

/**
 * De que natureza é a fonte de uma evidência. Serve para resolver
 * conflitos sem arbitrariedade: o registo comercial ganha ao diretório,
 * e o diretório ganha a um palpite comercial modelado.
 */
export const TIPO_FONTE = Object.freeze({
  SITE_OFICIAL: 'SITE_OFICIAL',
  FONTE_OFICIAL: 'FONTE_OFICIAL',
  DADO_ABERTO: 'DADO_ABERTO',
  DIRETORIO: 'DIRETORIO',
  API: 'API',
  PROVIDER_COMERCIAL: 'PROVIDER_COMERCIAL',
  OUTRO: 'OUTRO'
});

export const TIPOS_FONTE_VALIDOS = Object.freeze(Object.keys(TIPO_FONTE));

/**
 * Autoridade de cada tipo, usada para escolher o valor principal quando
 * há desacordo. Não é opinião: um dado publicado no registo comercial é
 * declarado por lei; um número de um agregador comercial é, com
 * frequência, modelado a partir do setor.
 */
export const AUTORIDADE_FONTE = Object.freeze({
  FONTE_OFICIAL: 100,
  DADO_ABERTO: 80,
  SITE_OFICIAL: 70,
  API: 55,
  PROVIDER_COMERCIAL: 45,
  DIRETORIO: 30,
  OUTRO: 10
});

/** Custo de consultar uma fonte. O motor prefere sempre o que não custa. */
export const CUSTO_FONTE = Object.freeze({
  GRATUITA: 'GRATUITA',
  FREEMIUM: 'FREEMIUM',
  PAGA: 'PAGA'
});

export const CUSTOS_VALIDOS = Object.freeze(Object.keys(CUSTO_FONTE));

/** Um valor destes pode ser usado num filtro numérico? */
export function temValor(env) {
  return Boolean(env && ESTADOS_COM_VALOR.includes(env.estado) && env.valor != null);
}

/** É uma estimativa? A interface tem de o mostrar de forma diferente. */
export function ehEstimativa(env) {
  return Boolean(env && env.estado === ESTADO_DADO.ESTIMADO);
}

/* ---------------------------------------------------------------- *
 * 3. Envelope                                                       *
 * ---------------------------------------------------------------- */

/** Envelope vazio: nunca consultado, sem valor. */
export function envelopeVazio() {
  return {
    valor: null,
    fonte: null,
    consultadoEm: null,
    confianca: null,
    estado: ESTADO_DADO.NAO_CONSULTADO
  };
}

/**
 * Constrói um envelope válido, ou lança.
 *
 * As recusas não são preciosismo: cada uma corresponde a uma forma
 * concreta de o ecrã passar a mentir.
 */
export function envelope({ valor = null, fonte = null, consultadoEm = null, confianca = null, estado } = {}) {
  if (!ESTADOS_VALIDOS.includes(estado)) {
    throw new CompanyProviderError('INVALID_DATA',
      'Estado inválido: "' + estado + '". Válidos: ' + ESTADOS_VALIDOS.join(', ') + '.');
  }

  const comValor = ESTADOS_COM_VALOR.includes(estado);

  /* Um valor sem estado que o suporte seria um facto sem proveniência. */
  if (!comValor && valor != null) {
    throw new CompanyProviderError('INVALID_DATA',
      'Estado ' + estado + ' não pode transportar valor.');
  }
  /* E o inverso: dizer CONFIRMADO sem nada confirmado. */
  if (comValor && valor == null) {
    throw new CompanyProviderError('INVALID_DATA',
      'Estado ' + estado + ' exige um valor.');
  }
  /* Saber algo sem saber de onde veio não é saber. */
  if (comValor && !fonte) {
    throw new CompanyProviderError('INVALID_DATA',
      'Um valor tem de trazer a fonte onde foi obtido.');
  }
  /* Um dado empresarial envelhece. Sem data não se sabe se ainda vale. */
  if (comValor && !consultadoEm) {
    throw new CompanyProviderError('INVALID_DATA',
      'Um valor tem de trazer a data em que foi consultado.');
  }
  if (confianca != null && (typeof confianca !== 'number' || !(confianca >= 0 && confianca <= 1))) {
    throw new CompanyProviderError('INVALID_DATA', 'Confiança tem de ser um número entre 0 e 1.');
  }

  return {
    valor: comValor ? valor : null,
    fonte: comValor ? String(fonte) : null,
    consultadoEm: comValor ? String(consultadoEm) : null,
    confianca: comValor ? confianca : null,
    estado
  };
}

/** Atalho legível para o caso mais comum. */
export function confirmado({ valor, fonte, consultadoEm, confianca = 1 }) {
  return envelope({ valor, fonte, consultadoEm, confianca, estado: ESTADO_DADO.CONFIRMADO });
}

/** Procurou-se e não há. Diferente de nunca ter procurado. */
export function naoEncontrado() {
  return envelope({ estado: ESTADO_DADO.NAO_ENCONTRADO });
}

/* ---------------------------------------------------------------- *
 * 4. Bloco empresarial de uma lead                                  *
 * ---------------------------------------------------------------- */

/** Todos os campos por consultar. É o que `cleanLead()` põe em cada lead. */
export function semDadosEmpresa() {
  const o = {};
  for (const c of CAMPOS) o[c] = envelopeVazio();
  return o;
}

/**
 * Leitura tolerante, para snapshots gravados antes de este campo existir.
 *
 * Um envelope em falta lê-se como NAO_CONSULTADO, que é a verdade: aquela
 * geração nunca consultou nada. Nunca se converte ausência em zero nem em
 * "não encontrado".
 */
export function lerEmpresa(lead) {
  const base = semDadosEmpresa();
  const e = lead && lead.empresa;
  if (!e || typeof e !== 'object') return base;
  for (const c of CAMPOS) {
    const v = e[c];
    if (!v || typeof v !== 'object') continue;
    if (!ESTADOS_VALIDOS.includes(v.estado)) continue;   /* estado desconhecido: ignora-se */
    const comValor = ESTADOS_COM_VALOR.includes(v.estado);
    if (comValor && v.valor == null) continue;           /* incoerente: trata-se como ausente */
    base[c] = {
      valor: comValor ? v.valor : null,
      fonte: comValor ? (v.fonte || null) : null,
      consultadoEm: comValor ? (v.consultadoEm || null) : null,
      confianca: comValor && typeof v.confianca === 'number' ? v.confianca : null,
      estado: v.estado
    };
    /* as evidências são a razão de o conflito ser inspecionável: uma
       leitura que as deitasse fora tornaria o estado CONFLITO opaco */
    if (Array.isArray(v.evidencias) && v.evidencias.length) base[c].evidencias = v.evidencias;
  }
  return base;
}

/** Um campo específico, com a mesma tolerância. */
export function lerCampo(lead, campo) {
  if (!CAMPOS.includes(campo)) {
    throw new CompanyProviderError('INVALID_REQUEST',
      'Campo empresarial desconhecido: "' + campo + '". Conhecidos: ' + CAMPOS.join(', ') + '.');
  }
  return lerEmpresa(lead)[campo];
}

/* ---------------------------------------------------------------- *
 * 5. Erros                                                          *
 * ---------------------------------------------------------------- */

export const ERROR_CODES = Object.freeze({
  RATE_LIMITED: { code: 'RATE_LIMITED', retryable: true },
  TIMEOUT: { code: 'TIMEOUT', retryable: true },
  NETWORK: { code: 'NETWORK', retryable: true },
  PROVIDER_UNAVAILABLE: { code: 'PROVIDER_UNAVAILABLE', retryable: true },
  INVALID_TOKEN: { code: 'INVALID_TOKEN', retryable: false },
  /* o fornecedor existe mas não está configurado nesta instalação */
  PROVIDER_NOT_CONFIGURED: { code: 'PROVIDER_NOT_CONFIGURED', retryable: false },
  /* não há chave por onde procurar: sem NIF, sem domínio, sem nada */
  NO_LOOKUP_KEY: { code: 'NO_LOOKUP_KEY', retryable: false },
  /* o fornecedor respondeu, mas não conhece esta empresa */
  COMPANY_NOT_FOUND: { code: 'COMPANY_NOT_FOUND', retryable: false },
  /* o fornecedor devolveu algo que viola o contrato */
  INVALID_DATA: { code: 'INVALID_DATA', retryable: false },
  NOT_SUPPORTED: { code: 'NOT_SUPPORTED', retryable: false },
  INVALID_REQUEST: { code: 'INVALID_REQUEST', retryable: false },
  UNKNOWN: { code: 'UNKNOWN', retryable: false }
});

/** Erro tipado. Nunca transporta credenciais nem a resposta bruta. */
export class CompanyProviderError extends Error {
  constructor(codigo, mensagem, extra = {}) {
    const def = ERROR_CODES[codigo] || ERROR_CODES.UNKNOWN;
    super(mensagem || def.code);
    this.name = 'CompanyProviderError';
    this.errorCode = def.code;
    this.retryable = extra.retryable != null ? extra.retryable === true : def.retryable;
    this.retryAfterSec = Number.isFinite(extra.retryAfterSec) ? extra.retryAfterSec : null;
  }
}

/* ---------------------------------------------------------------- *
 * 6. Resposta normalizada de consulta                               *
 * ---------------------------------------------------------------- */

/**
 * Forma única devolvida por QUALQUER fornecedor:
 *   { success, provider, empresa, errorCode, errorMessage, retryable }
 *
 * `empresa` traz sempre os cinco campos. Um fornecedor que só sabe o
 * capital social devolve os outros quatro como NAO_ENCONTRADO — não os
 * omite, porque omitir deixaria o leitor sem saber se foi procurado.
 */
export function respostaConsulta({
  success,
  provider = null,
  empresa = null,
  errorCode = null,
  errorMessage = null,
  retryable = null
} = {}) {
  const dados = semDadosEmpresa();
  if (success && empresa && typeof empresa === 'object') {
    for (const c of CAMPOS) {
      const v = empresa[c];
      if (!v) continue;
      if (!ESTADOS_VALIDOS.includes(v.estado)) {
        throw new CompanyProviderError('INVALID_DATA',
          'Fornecedor devolveu estado inválido em "' + c + '": ' + v.estado);
      }
      /* revalida-se tudo o que vem de fora: o contrato não confia no adapter */
      dados[c] = envelope(v);
      /* mas as evidências atravessam: revalidar não pode significar
         perder a proveniência que o adapter recolheu */
      if (Array.isArray(v.evidencias) && v.evidencias.length) dados[c].evidencias = v.evidencias;
      if (CAMPOS_NUMERICOS.includes(c) && temValor(dados[c]) && typeof dados[c].valor !== 'number') {
        throw new CompanyProviderError('INVALID_DATA',
          'Campo "' + c + '" tem de ser numérico.');
      }
    }
  }
  const def = errorCode ? (ERROR_CODES[errorCode] || ERROR_CODES.UNKNOWN) : null;
  return {
    success: success === true,
    provider: provider || null,
    empresa: dados,
    errorCode: def ? def.code : null,
    errorMessage: errorMessage || null,
    retryable: retryable != null ? retryable === true : (def ? def.retryable : false)
  };
}

/* ---------------------------------------------------------------- *
 * 7. Evidências                                                     *
 * ---------------------------------------------------------------- *
 * Um campo pode ser afirmado por várias fontes, e elas podem
 * discordar. O envelope continua a existir e a ser a resposta à
 * pergunta "o que é que o LeadMap mostra?" — mas deixa de ser tudo o
 * que se sabe.
 *
 * PORQUE NÃO SE SOBREPÕE EM SILÊNCIO
 * ----------------------------------
 * Se a fonte A diz 42 funcionários e a fonte B diz 51, escolher uma e
 * deitar fora a outra destrói a única informação que interessa: que há
 * desacordo. Quem está a decidir se contacta esta empresa merece saber
 * que o número não é seguro. Daí `evidencias[]` e o estado CONFLITO.
 * ---------------------------------------------------------------- */

/** Uma afirmação de uma fonte sobre um campo. */
export function evidencia({
  valor, fonte, url = null, consultadoEm = null, confianca = null,
  estado = ESTADO_DADO.CONFIRMADO, tipoFonte = TIPO_FONTE.OUTRO
} = {}) {
  if (!TIPOS_FONTE_VALIDOS.includes(tipoFonte)) {
    throw new CompanyProviderError('INVALID_DATA',
      'Tipo de fonte inválido: "' + tipoFonte + '". Válidos: ' + TIPOS_FONTE_VALIDOS.join(', ') + '.');
  }
  if (estado === ESTADO_DADO.CONFLITO) {
    throw new CompanyProviderError('INVALID_DATA',
      'CONFLITO é conclusão do motor, não estado de uma evidência isolada.');
  }
  /* reutiliza a validação do envelope: uma evidência é um envelope com
     origem declarada, e não pode ser mais permissiva do que ele */
  const base = envelope({ valor, fonte, consultadoEm, confianca, estado });
  return { ...base, url: url ? String(url) : null, tipoFonte };
}

/** Quanto pesa uma evidência quando as fontes discordam. */
export function pesoEvidencia(ev) {
  if (!ev) return 0;
  const autoridade = AUTORIDADE_FONTE[ev.tipoFonte] != null ? AUTORIDADE_FONTE[ev.tipoFonte] : AUTORIDADE_FONTE.OUTRO;
  /* um dado declarado vale mais do que um modelado, venha de onde vier */
  const declarado = ev.estado === ESTADO_DADO.CONFIRMADO ? 1 : 0.6;
  const confianca = typeof ev.confianca === 'number' ? ev.confianca : 0.5;
  /* atualidade: um dado de há cinco anos não vale o mesmo que o de ontem */
  let frescura = 1;
  const t = ev.consultadoEm ? Date.parse(ev.consultadoEm) : NaN;
  if (Number.isFinite(t)) {
    const anos = (Date.now() - t) / (365.25 * 24 * 3600 * 1000);
    frescura = anos <= 1 ? 1 : anos >= 5 ? 0.6 : 1 - (anos - 1) * 0.1;
  }
  return autoridade * declarado * confianca * frescura;
}

/** Dois valores são o mesmo, para efeitos de desacordo? */
export function mesmoValor(a, b) {
  if (a == null || b == null) return a === b;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    if (na === nb) return true;
    /* números de porte nunca são exatos; 10% é ruído, não desacordo */
    const maior = Math.max(Math.abs(na), Math.abs(nb));
    return maior > 0 && Math.abs(na - nb) / maior <= 0.10;
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Escolhe o valor principal a partir das evidências, e diz se há
 * conflito.
 *
 * Conflito é desacordo entre fontes que ambas merecem crédito. Se a
 * mais forte esmagar a outra — registo oficial contra diretório — não
 * há conflito: há uma fonte melhor. O limiar é relativo de propósito,
 * para que uma fonte fraca não consiga levantar dúvida sobre um dado
 * oficial só por existir.
 */
export function escolherPrincipal(evidencias = []) {
  const lista = (Array.isArray(evidencias) ? evidencias : []).filter(e => e && e.valor != null);
  if (!lista.length) return { envelope: envelopeVazio(), conflito: false, evidencias: [] };

  const ordenadas = [...lista].sort((a, b) => pesoEvidencia(b) - pesoEvidencia(a));
  const principal = ordenadas[0];
  const pesoP = pesoEvidencia(principal);

  /* metade do peso do vencedor: uma fonte com crédito comparável levanta
     dúvida legítima; uma claramente mais fraca não consegue pôr em causa
     um dado oficial só por existir */
  const discordantes = ordenadas.slice(1).filter(e =>
    !mesmoValor(e.valor, principal.valor) && pesoEvidencia(e) >= pesoP * 0.5);

  const estado = discordantes.length
    ? ESTADO_DADO.CONFLITO
    : (ordenadas.some(e => e.estado === ESTADO_DADO.ESTIMADO) && principal.estado === ESTADO_DADO.ESTIMADO
        ? ESTADO_DADO.ESTIMADO : principal.estado);

  return {
    envelope: envelope({
      valor: principal.valor,
      fonte: principal.fonte,
      consultadoEm: principal.consultadoEm,
      /* um conflito por resolver não pode manter a confiança do vencedor */
      confianca: discordantes.length
        ? Math.min(typeof principal.confianca === 'number' ? principal.confianca : 0.5, 0.5)
        : principal.confianca,
      estado
    }),
    conflito: discordantes.length > 0,
    evidencias: ordenadas
  };
}

/**
 * Acrescenta uma evidência a um campo e recalcula o principal.
 * Nunca apaga o que já lá estava.
 */
export function comEvidencia(campoAtual, nova) {
  const anteriores = (campoAtual && Array.isArray(campoAtual.evidencias)) ? campoAtual.evidencias : [];
  const todas = [...anteriores, nova];
  const r = escolherPrincipal(todas);
  return { ...r.envelope, evidencias: r.evidencias };
}

/** As evidências de um campo, tolerante a envelopes da Fase 1. */
export function evidenciasDe(campo) {
  return (campo && Array.isArray(campo.evidencias)) ? campo.evidencias : [];
}

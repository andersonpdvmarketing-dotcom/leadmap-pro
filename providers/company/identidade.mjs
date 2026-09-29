/**
 * LeadMap Pro — resolução de identidade empresarial
 * =================================================
 * Responde a uma pergunta só, e não responde a mais nenhuma:
 *
 *   este NIF pertence mesmo a esta empresa?
 *
 * PORQUE É QUE ISTO EXISTE
 * ------------------------
 * Um caso real, encontrado em produção. Uma clínica dentária em Odivelas
 * tem na sua página de termos a frase "NIPC 501135227, com sede na …
 * Colinas do Cruzeiro" — a morada da clínica. O número tem dígito de
 * controlo válido, prefixo de pessoa coletiva, e um rótulo legal
 * explícito. A extração fez o que devia.
 *
 * Só que 501135227 é o NIPC da J. J. LOURO PEREIRA, S.A., cujo CAE
 * principal é 31004 — fabricação de mobiliário. A página foi montada a
 * partir de um modelo e ficou com o NIPC de outra empresa lá dentro (o
 * próprio texto mostra a substituição malfeita: "www.clínica onda de
 * sorrisos.com NIPC 501135227").
 *
 * O SICAE respondeu corretamente. A pergunta é que estava errada. E o
 * resultado foi o CAE de um fabricante de móveis atribuído a uma clínica.
 *
 * A DISTINÇÃO QUE FALTAVA
 * -----------------------
 * Ter dígito de controlo válido diz que um número TEM ESTRUTURA DE NIF.
 * Não diz de quem é. Eram duas afirmações tratadas como uma:
 *
 *   NIF_VALIDO              ≠  NIF_PERTENCE_A_ESTA_EMPRESA
 *
 * Este módulo trata da segunda.
 *
 * O SINAL QUE DECIDE, E PORQUE NÃO É CIRCULAR
 * -------------------------------------------
 * Comparar o nome comercial com a firma registada não basta. Em Portugal
 * a firma é quase sempre diferente da marca: "Oral Plus" chama-se
 * "CLÍNICA DE ESTOMATOLOGIA E MEDICINA DENTÁRIA DE DR. …" no registo.
 * Zero palavras em comum, e é a mesma empresa.
 *
 * Só que "Clínica Onda de Sorrisos" vs "J. J. Louro Pereira" tem
 * exatamente o mesmo aspeto: zero palavras em comum. Pelo nome, os dois
 * casos são indistinguíveis.
 *
 * O que os separa é o próprio site. Lidas 8 páginas de
 * ondadesorrisos.com — 50 mil caracteres — as palavras "Louro" e
 * "Pereira" não aparecem em sítio nenhum: o site nunca afirma ser aquela
 * empresa. Já fortecmd.net diz "Forte" e "Medicina Dentária", que é
 * precisamente a firma registada.
 *
 * Daí o sinal FIRMA_NO_SITE: a firma devolvida pelo registo é
 * corroborada pelo texto do próprio site do lead. É determinístico,
 * auditável, e não usa o CAE para nada — usar o CAE seria circular
 * ("é clínica, logo o CAE devia ser dentário, logo o NIF está errado"),
 * e um CAE inesperado tem causas legítimas.
 *
 * A REGRA DE OURO
 * ---------------
 * Entre não saber e atribuir os dados da empresa errada, preferimos não
 * saber. Uma identidade inconclusiva preserva tudo o que se encontrou —
 * NIF, URL, trecho, resposta do registo — e não promove nada disso a
 * facto sobre o lead.
 */

import { CAMPOS } from './contract.mjs';
import { ehNipc } from './nif.mjs';

/* ---------------------------------------------------------------- *
 * 1. Estados da identidade                                          *
 * ---------------------------------------------------------------- */

/**
 * CONFIRMADA     — a firma registada é corroborada pelo nome, pelo
 *                  domínio ou pelo texto do próprio site.
 * PROVAVEL       — o NIF está no site oficial em contexto legal e há
 *                  sinais razoáveis de relação, mas a firma não fecha
 *                  com o nome comercial.
 * INCONCLUSIVA   — encontrou-se o NIF e falta corroboração. Não se
 *                  afirma nem que é nem que não é.
 * CONFLITO       — a firma registada não tem nada a ver com o lead e o
 *                  site nunca a menciona.
 * REJEITADA      — há indicação explícita de que o NIF é de terceiro.
 * NAO_VERIFICADA — ninguém verificou. É o estado de tudo o que foi
 *                  gravado antes desta camada existir.
 */
export const IDENTIDADE = Object.freeze({
  CONFIRMADA: 'CONFIRMADA',
  PROVAVEL: 'PROVAVEL',
  INCONCLUSIVA: 'INCONCLUSIVA',
  CONFLITO: 'CONFLITO',
  REJEITADA: 'REJEITADA',
  NAO_VERIFICADA: 'NAO_VERIFICADA'
});

export const IDENTIDADES_VALIDAS = Object.freeze(Object.keys(IDENTIDADE));

/** Nenhum destes rótulos afirma mais do que se sabe. */
export const IDENTIDADE_ROTULO = Object.freeze({
  CONFIRMADA: 'Confirmada',
  PROVAVEL: 'Provável',
  INCONCLUSIVA: 'Inconclusiva',
  CONFLITO: 'Em conflito',
  REJEITADA: 'Rejeitada',
  NAO_VERIFICADA: 'Não verificada'
});

/**
 * Os estados em que os dados derivados do NIF podem ser atribuídos ao
 * lead. Curto de propósito: é a lista que impede o CAE de um fabricante
 * de móveis de virar o CAE de uma clínica.
 */
export const IDENTIDADES_SUFICIENTES = Object.freeze([
  IDENTIDADE.CONFIRMADA, IDENTIDADE.PROVAVEL
]);

/** E estes são os que provam em Modo ESTRITO. Só o topo. */
export const IDENTIDADES_ESTRITAS = Object.freeze([IDENTIDADE.CONFIRMADA]);

/* ---------------------------------------------------------------- *
 * 2. Sinais                                                         *
 * ---------------------------------------------------------------- */

/**
 * Cada sinal é uma observação independente, com peso positivo ou
 * negativo. Não há aprendizagem automática nem pontuação opaca: dado o
 * mesmo input, sai sempre o mesmo resultado, e cada peso está escrito
 * aqui para poder ser discutido.
 */
export const SINAL = Object.freeze({
  /* positivos */
  NOME_EXATO: 'NOME_EXATO',
  NOME_NORMALIZADO: 'NOME_NORMALIZADO',
  TOKEN_DISTINTIVO: 'TOKEN_DISTINTIVO',
  FIRMA_NO_SITE: 'FIRMA_NO_SITE',
  DOMINIO_COMPATIVEL: 'DOMINIO_COMPATIVEL',
  NIF_CONTEXTUAL: 'NIF_CONTEXTUAL',
  CONTEXTO_LEGAL: 'CONTEXTO_LEGAL',
  /* negativos */
  NOME_INCOMPATIVEL: 'NOME_INCOMPATIVEL',
  TERCEIRO_EXPLICITO: 'TERCEIRO_EXPLICITO',
  MULTIPLOS_CANDIDATOS: 'MULTIPLOS_CANDIDATOS',
  FIRMA_DESCONHECIDA: 'FIRMA_DESCONHECIDA',
  NIF_NAO_EMPRESARIAL: 'NIF_NAO_EMPRESARIAL'
});

const PESO = Object.freeze({
  NOME_EXATO: 0.55,
  NOME_NORMALIZADO: 0.45,
  TOKEN_DISTINTIVO: 0.30,
  FIRMA_NO_SITE: 0.35,
  DOMINIO_COMPATIVEL: 0.40,
  NIF_CONTEXTUAL: 0.15,
  CONTEXTO_LEGAL: 0.10,
  NOME_INCOMPATIVEL: -0.45,
  TERCEIRO_EXPLICITO: -0.60,
  MULTIPLOS_CANDIDATOS: -0.20,
  FIRMA_DESCONHECIDA: -0.10,
  NIF_NAO_EMPRESARIAL: -1.00
});

export const SINAL_ROTULO = Object.freeze({
  NOME_EXATO: 'nome comercial igual à firma registada',
  NOME_NORMALIZADO: 'nome comercial contido na firma registada',
  TOKEN_DISTINTIVO: 'palavra distintiva comum ao nome e à firma',
  FIRMA_NO_SITE: 'firma registada mencionada no próprio site',
  DOMINIO_COMPATIVEL: 'domínio compatível com a firma',
  NIF_CONTEXTUAL: 'NIF com rótulo legal explícito',
  CONTEXTO_LEGAL: 'NIF em página legal da empresa',
  NOME_INCOMPATIVEL: 'firma registada não corresponde ao lead',
  TERCEIRO_EXPLICITO: 'NIF junto a indicação de terceiro',
  MULTIPLOS_CANDIDATOS: 'vários NIFs na mesma página',
  FIRMA_DESCONHECIDA: 'registo não devolveu a firma',
  NIF_NAO_EMPRESARIAL: 'o número não tem prefixo de pessoa coletiva'
});

/* ---------------------------------------------------------------- *
 * 3. Normalização de nomes                                          *
 * ---------------------------------------------------------------- */

/**
 * Formas jurídicas. Saem da comparação porque não distinguem ninguém:
 * metade das empresas portuguesas acaba em "LDA".
 */
const SUFIXOS_JURIDICOS = [
  'sociedade unipessoal por quotas', 'sociedade unipessoal', 'unipessoal por quotas',
  'sociedade por quotas', 'sociedade anonima', 'unipessoal lda', 'unipessoal',
  'limitada', 'lda', 'sa', 's a', 'scr', 'sgps', 'crl', 'eirl', 'aci', 'ace',
  /* "XPTO, Sociedade Unipessoal, Lda." fica em "xpto sociedade" depois de
     sair "unipessoal lda"; sem isto, o resto da forma jurídica contava
     como parte do nome */
  'sociedade'
];

/**
 * Palavras que não distinguem uma empresa de outra no mesmo setor.
 *
 * "Centro Médico" não identifica nada — há centenas. "Medibracara"
 * identifica um. Sem esta lista, "Clínica Lisboa" corresponderia a
 * qualquer empresa com "Lisboa" no nome, que é precisamente o falso
 * positivo que não queremos.
 *
 * Inclui também nomes próprios muito comuns: uma firma "JOÃO SILVA,
 * LDA" e um lead "João Costa" não são a mesma coisa por partilharem
 * "joao".
 */
const GENERICAS = new Set([
  /* atividade */
  'clinica', 'clinicas', 'centro', 'centros', 'consultorio', 'consultorios',
  'medico', 'medica', 'medicos', 'medicas', 'medicina', 'medical', 'saude',
  'dental', 'dentaria', 'dentario', 'dentista', 'dentistas', 'estomatologia',
  'odontologia', 'health', 'care', 'clinic', 'hospital', 'laboratorio',
  'imobiliaria', 'imobiliarias', 'estetica', 'automovel', 'automoveis',
  'servicos', 'servico', 'services', 'solucoes', 'comercio', 'industria',
  'construcoes', 'construcao', 'sociedade', 'empresa', 'grupo', 'group',
  'unipessoal', 'associados', 'associacao', 'gestao', 'investimentos',
  'consultoria', 'estudios', 'estudio', 'studio', 'fotografia', 'fotografias',
  /* geografia */
  'portugal', 'lisboa', 'porto', 'braga', 'coimbra', 'faro', 'aveiro',
  'setubal', 'evora', 'leiria', 'viseu', 'guarda', 'beja', 'braganca',
  'santarem', 'madeira', 'acores', 'algarve', 'norte', 'sul',
  /* nomes próprios frequentes */
  'joao', 'jose', 'maria', 'antonio', 'manuel', 'pedro', 'paulo', 'carlos',
  'ana', 'luis', 'miguel', 'nuno', 'ricardo', 'rui', 'silva', 'santos',
  'ferreira', 'costa', 'oliveira', 'rodrigues', 'martins', 'sousa',
  /* ruído */
  'dos', 'das', 'dr', 'dra', 'irmaos', 'filhos', 'novo', 'nova', 'the'
]);

/** Acentos fora, minúsculas, pontuação a espaço, espaços colapsados. */
export function semAcentos(s) {
  if (typeof s !== 'string') return '';
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Normalização conservadora para comparação.
 *
 * "MEDIBRACARA - CENTRO MÉDICO LDA" e "Medibracara Centro Médico"
 * passam ambas a "medibracara centro medico". Não faz mais nada: não
 * remove plurais, não corrige erros, não aproxima palavras parecidas.
 * Aproximar é onde nascem os falsos positivos.
 */
export function normalizarNome(s) {
  let t = semAcentos(String(s || '')).toLowerCase();
  t = t.replace(/&/g, ' e ');
  t = t.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  /* sufixos jurídicos só saem do FIM, e um de cada vez: "lda" no meio de
     um nome pode ser parte dele */
  let mudou = true;
  while (mudou) {
    mudou = false;
    for (const suf of SUFIXOS_JURIDICOS) {
      if (t === suf) return '';
      if (t.endsWith(' ' + suf)) { t = t.slice(0, -(suf.length + 1)).trim(); mudou = true; }
    }
  }
  return t;
}

/** Palavras com 4+ letras que não estão na lista das que não distinguem. */
export function tokensDistintivos(s) {
  const t = normalizarNome(s);
  if (!t) return [];
  const out = [];
  for (const p of t.split(' ')) {
    if (p.length < 4) continue;          /* "cmd", "jm", "sa" não identificam */
    if (/^\d+$/.test(p)) continue;
    if (GENERICAS.has(p)) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** O nome do domínio sem www nem TLD: "www.fortecmd.net" → "fortecmd". */
export function rotuloDominio(bruto) {
  if (!bruto) return '';
  let h = String(bruto).trim();
  try { h = new URL(/^https?:\/\//i.test(h) ? h : 'https://' + h).hostname; } catch (e) { /* já era host */ }
  h = semAcentos(h).toLowerCase().replace(/^www\./, '');
  const partes = h.split('.').filter(Boolean);
  if (!partes.length) return '';
  /* domínios .com.pt / .co.uk: o rótulo é o penúltimo significativo */
  if (partes.length >= 3 && ['com', 'co', 'org', 'net', 'gov', 'edu'].includes(partes[partes.length - 2])) {
    return partes[partes.length - 3];
  }
  return partes.length >= 2 ? partes[partes.length - 2] : partes[0];
}

/* ---------------------------------------------------------------- *
 * 4. Terceiros explícitos                                           *
 * ---------------------------------------------------------------- */

/**
 * Marcas de que o número ao lado é de outra entidade. Se uma destas
 * aparece na janela em volta do NIF, o NIF não é do lead — é do
 * fornecedor de pagamentos, da agência que fez o site, ou da entidade
 * do livro de reclamações.
 */
const MARCAS_TERCEIRO = [
  'powered by', 'desenvolvido por', 'website by', 'site by', 'criado por',
  'fornecedor', 'fornecido por', 'prestador de servicos', 'parceiro',
  'plataforma de pagamento', 'gateway', 'processador de pagamentos',
  'livro de reclamacoes', 'entidade gestora', 'entidade reguladora',
  'agencia', 'web design', 'webdesign', 'alojamento', 'hosting',
  'registrar', 'operado por', 'em nome de', 'representante'
];

/** Rótulos do NIF que valem como afirmação legal sobre a própria entidade. */
const ROTULOS_FORTES = new Set(['NIPC', 'NIF', 'VAT PT', 'Número de Contribuinte', 'N.º Contribuinte']);

/** Sinais de que o trecho é a identificação legal da empresa do site. */
const MARCAS_LEGAIS = [
  'sede', 'com sede', 'capital social', 'matriculada', 'registada',
  'conservatoria', 'pessoa coletiva', 'termos e condicoes', 'politica de privacidade'
];

/* ---------------------------------------------------------------- *
 * 5. O envelope da identidade                                       *
 * ---------------------------------------------------------------- */

/**
 * Snapshots gravados antes desta camada existir não têm identidade — e
 * não é o mesmo que ter sido verificada e falhado. NAO_VERIFICADA diz a
 * verdade sobre eles, e a próxima investigação resolve-os.
 */
export function identidadeVazia() {
  return {
    estado: IDENTIDADE.NAO_VERIFICADA,
    confianca: null,
    nif: null,
    nomeLead: null,
    firmaOficial: null,
    /* qual registo devolveu a firma. Sem isto o ecrã teria de escrever
       "SICAE" à mão e passaria a mentir no dia em que houver outro. */
    firmaFonte: null,
    dominio: null,
    sinais: [],
    conflitos: [],
    candidatos: [],
    derivadosNaoAtribuidos: [],
    validadoEm: null
  };
}

/** Leitura tolerante: qualquer coisa que não seja identidade válida lê-se como não verificada. */
export function lerIdentidade(bruto) {
  const base = identidadeVazia();
  if (!bruto || typeof bruto !== 'object') return base;
  if (!IDENTIDADES_VALIDAS.includes(bruto.estado)) return base;
  base.estado = bruto.estado;
  base.confianca = typeof bruto.confianca === 'number' ? bruto.confianca : null;
  base.nif = bruto.nif != null ? String(bruto.nif) : null;
  base.nomeLead = bruto.nomeLead != null ? String(bruto.nomeLead) : null;
  base.firmaOficial = bruto.firmaOficial != null ? String(bruto.firmaOficial) : null;
  base.firmaFonte = bruto.firmaFonte != null ? String(bruto.firmaFonte) : null;
  base.dominio = bruto.dominio != null ? String(bruto.dominio) : null;
  base.sinais = Array.isArray(bruto.sinais) ? bruto.sinais.filter(s => s && s.sinal) : [];
  base.conflitos = Array.isArray(bruto.conflitos) ? bruto.conflitos.slice() : [];
  base.candidatos = Array.isArray(bruto.candidatos) ? bruto.candidatos.slice() : [];
  base.derivadosNaoAtribuidos = Array.isArray(bruto.derivadosNaoAtribuidos)
    ? bruto.derivadosNaoAtribuidos.filter(d => d && CAMPOS.includes(d.campo)) : [];
  base.validadoEm = bruto.validadoEm != null ? String(bruto.validadoEm) : null;
  return base;
}

/* ---------------------------------------------------------------- *
 * 6. A avaliação                                                    *
 * ---------------------------------------------------------------- */

/** Quanto texto do trecho se guarda. Curto: é para auditar, não para arquivar a página. */
const MAX_TRECHO = 220;

export function recortarTrecho(t, alvo) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (!alvo) return s.slice(0, MAX_TRECHO);
  const i = s.indexOf(String(alvo));
  if (i < 0) return s.slice(0, MAX_TRECHO);
  const meio = Math.floor(MAX_TRECHO / 2);
  const de = Math.max(0, i - meio);
  return (de > 0 ? '…' : '') + s.slice(de, de + MAX_TRECHO).trim() + '…';
}

/**
 * Decide se um NIF pertence a um lead.
 *
 * Tudo o que entra é observação, não opinião: o nome do lead, o domínio,
 * a firma que o registo devolveu, o trecho em volta do NIF, e o texto do
 * site. O CAE não entra — a pouca ou muita coerência da atividade é
 * assunto do alerta de atividade, nunca da identidade (ver §14 da
 * missão: usar o CAE aqui seria raciocínio circular).
 *
 * @param {object} e
 * @param {string} e.nomeLead      nome comercial como o lead o traz
 * @param {string} [e.dominio]     website do lead
 * @param {string} [e.firmaOficial] denominação devolvida pelo registo
 * @param {string} [e.nif]
 * @param {string} [e.rotuloNif]   rótulo com que o NIF foi encontrado
 * @param {string} [e.trecho]      texto em volta do NIF
 * @param {string} [e.urlNif]      página onde o NIF foi encontrado
 * @param {string} [e.corpusSite]  texto das páginas lidas do site (não é guardado)
 * @param {Array}  [e.candidatos]  outros NIFs encontrados na mesma página
 * @param {string} [e.agora]
 */
export function avaliarIdentidade({
  nomeLead = '', dominio = null, firmaOficial = null, firmaFonte = null, nif = null,
  rotuloNif = null, trecho = null, urlNif = null, corpusSite = null,
  candidatos = [], agora = new Date().toISOString()
} = {}) {
  const id = identidadeVazia();
  id.nif = nif ? String(nif) : null;
  id.nomeLead = nomeLead || null;
  id.firmaOficial = firmaOficial || null;
  id.firmaFonte = firmaOficial ? (firmaFonte || null) : null;
  id.dominio = dominio ? rotuloDominio(dominio) : null;
  id.validadoEm = agora;
  id.candidatos = (candidatos || []).map(c => ({
    nif: c.nif, rotulo: c.rotulo || null, ocorrencias: c.ocorrencias || 1
  }));

  /* Sem NIF não há nada para validar. */
  if (!id.nif) {
    id.estado = IDENTIDADE.NAO_VERIFICADA;
    return id;
  }

  const sinais = [];
  const juntar = (sinal, detalhe = null) => sinais.push({ sinal, peso: PESO[sinal], detalhe });

  const trechoNorm = semAcentos(String(trecho || '')).toLowerCase();
  const corpusNorm = semAcentos(String(corpusSite || '')).toLowerCase();

  /* ---- terceiro explícito: decide sozinho ---- */
  const marcaTerceiro = MARCAS_TERCEIRO.find(m => trechoNorm.includes(m));
  if (marcaTerceiro) {
    juntar(SINAL.TERCEIRO_EXPLICITO, marcaTerceiro);
    id.sinais = sinais;
    id.conflitos.push('O NIF aparece junto a "' + marcaTerceiro + '": é de outra entidade.');
    id.estado = IDENTIDADE.REJEITADA;
    id.confianca = 0;
    return id;
  }

  /* ---- é sequer o número de uma empresa? ----
     Um NIF de pessoa singular passa o mesmo dígito de controlo que um
     NIPC. Tratá-lo como identificador da empresa seria importar o número
     fiscal de uma pessoa para uma base de dados de empresas, o que não
     se faz. Um empresário em nome individual usa legitimamente o seu NIF
     no negócio — por isso o achado não se apaga: fica registado, e o que
     não acontece é ser promovido a identidade da empresa. */
  if (!ehNipc(id.nif)) {
    juntar(SINAL.NIF_NAO_EMPRESARIAL, id.nif.slice(0, 1) + '…');
    id.sinais = sinais;
    id.conflitos.push('O número encontrado não tem prefixo de pessoa coletiva: ' +
      'não se usa como identificação da empresa.');
    id.estado = IDENTIDADE.INCONCLUSIVA;
    id.confianca = 0;
    return id;
  }

  /* ---- o NIF: como foi encontrado ---- */
  if (rotuloNif && ROTULOS_FORTES.has(rotuloNif)) juntar(SINAL.NIF_CONTEXTUAL, rotuloNif);
  const marcaLegal = MARCAS_LEGAIS.find(m => trechoNorm.includes(m))
    || (urlNif && MARCAS_LEGAIS.find(m => semAcentos(urlNif).toLowerCase().includes(m.replace(/ /g, '-'))));
  if (marcaLegal) juntar(SINAL.CONTEXTO_LEGAL, marcaLegal);
  if ((candidatos || []).length > 1) {
    juntar(SINAL.MULTIPLOS_CANDIDATOS, (candidatos || []).length + ' NIFs');
    id.conflitos.push('A página tem ' + candidatos.length + ' NIFs distintos.');
  }

  /* ---- a firma: o que o registo diz ---- */
  const nomeNorm = normalizarNome(nomeLead);
  const firmaNorm = normalizarNome(firmaOficial);

  if (!firmaNorm) {
    /* O registo não respondeu, ou respondeu sem denominação. Não se
       conclui nada sobre a identidade — e sobretudo não se conclui que
       está certa só porque nada a contradisse. */
    juntar(SINAL.FIRMA_DESCONHECIDA);
    id.sinais = sinais;
    id.confianca = arredondar(pontuacao(sinais));
    id.estado = IDENTIDADE.INCONCLUSIVA;
    return id;
  }

  /* O SICAE corta firmas longas com "…" na própria página. Uma firma
     truncada continua a servir para comparar o que dela sobrou, mas não
     se pode exigir igualdade exata a um nome que veio cortado. */
  const firmaTruncada = /\.{3}|…/.test(String(firmaOficial));

  const tokLead = tokensDistintivos(nomeLead);
  const tokFirma = tokensDistintivos(firmaOficial);
  const comuns = tokFirma.filter(t => tokLead.includes(t));
  const rotDominio = id.dominio || '';

  if (nomeNorm && firmaNorm && !firmaTruncada && nomeNorm === firmaNorm) {
    juntar(SINAL.NOME_EXATO, firmaOficial);
  } else if (nomeNorm.length >= 6 && firmaNorm.length >= 6
             && (firmaNorm.includes(nomeNorm) || nomeNorm.includes(firmaNorm))) {
    juntar(SINAL.NOME_NORMALIZADO, firmaOficial);
  }
  if (comuns.length) juntar(SINAL.TOKEN_DISTINTIVO, comuns.join(', '));

  /* O domínio conta quando contém uma palavra distintiva da firma:
     "fortecmd" contém "forte", da firma "JOÃO FORTE - MEDICINA DENTÁRIA".

     Pesa tanto como um nome parecido, e de propósito. Um domínio não é
     uma coincidência de palavras — é propriedade registada, e uma empresa
     que publica o seu NIF num site cujo domínio é o seu próprio nome
     registado está a identificar-se. Sozinho chega a PROVÁVEL, nunca a
     CONFIRMADA: para isso é preciso mais do que ter comprado o domínio. */
  const dominioCasa = rotDominio && tokFirma.some(t => rotDominio.includes(t));
  if (dominioCasa) juntar(SINAL.DOMINIO_COMPATIVEL, rotDominio);

  /* O sinal que separa marca-diferente-da-firma de empresa-errada.
     Duas maneiras de a firma estar no site:

     por palavra distintiva — "forte" da firma "JOÃO FORTE - MEDICINA
     DENTÁRIA" aparece em fortecmd.net;

     por frase exata — há firmas feitas só de palavras genéricas
     ("CLÍNICA DE ESTOMATOLOGIA E MEDICINA DENTÁRIA DE DR. …"), onde
     nenhuma palavra distingue mas a sequência inteira distingue muito.
     Casar 20+ caracteres contíguos não é aproximar: é encontrar. */
  const tokensNoSite = corpusNorm ? tokFirma.filter(t => corpusNorm.includes(t)) : [];
  const fraseNoSite = Boolean(corpusNorm && firmaNorm.length >= 20 && corpusNorm.includes(firmaNorm));
  if (tokensNoSite.length || fraseNoSite) {
    juntar(SINAL.FIRMA_NO_SITE, fraseNoSite ? firmaNorm.slice(0, 60) : tokensNoSite.join(', '));
  }

  /* Incompatível é não haver corroboração em NENHUM sítio: nem no nome,
     nem no domínio, nem no texto do site. Só o nome ser diferente não
     basta — em Portugal a firma quase nunca é a marca. */
  const algumaCorroboracao = sinais.some(s => [
    SINAL.NOME_EXATO, SINAL.NOME_NORMALIZADO, SINAL.TOKEN_DISTINTIVO,
    SINAL.DOMINIO_COMPATIVEL, SINAL.FIRMA_NO_SITE
  ].includes(s.sinal));

  /* Uma firma feita só de palavras que não distinguem ninguém — e há
     muitas — não permite concluir nada por palavras. Dizer que é
     "incompatível" seria transformar ausência de sinal em sinal
     negativo, que é o erro simétrico ao que esta camada existe para
     evitar. Fica inconclusiva. */
  const firmaSemDistintivo = tokFirma.length === 0;

  if (!algumaCorroboracao && !firmaSemDistintivo) {
    juntar(SINAL.NOME_INCOMPATIVEL, firmaOficial);
    id.conflitos.push('O registo diz "' + firmaOficial + '", que não corresponde a "' +
      (nomeLead || '—') + '" nem aparece no site.');
  }

  id.sinais = sinais;
  const p = pontuacao(sinais);
  id.confianca = arredondar(p);

  /* ---- classificação ---- */
  if (!algumaCorroboracao) {
    /* Só é CONFLITO quando havia como corroborar e não corroborou: uma
       firma com palavras distintivas, um site lido, e nada em comum. Sem
       site lido, ou com uma firma sem nada de distintivo, a conclusão
       honesta é que não se sabe. */
    id.estado = (corpusNorm && !firmaSemDistintivo)
      ? IDENTIDADE.CONFLITO : IDENTIDADE.INCONCLUSIVA;
    return id;
  }
  const forte = sinais.some(s => [SINAL.NOME_EXATO, SINAL.NOME_NORMALIZADO,
                                  SINAL.TOKEN_DISTINTIVO, SINAL.FIRMA_NO_SITE].includes(s.sinal));
  if (p >= 0.70 && forte) id.estado = IDENTIDADE.CONFIRMADA;
  else if (p >= 0.40) id.estado = IDENTIDADE.PROVAVEL;
  else id.estado = IDENTIDADE.INCONCLUSIVA;
  return id;
}

function pontuacao(sinais) {
  let p = 0;
  for (const s of sinais) p += (typeof s.peso === 'number' ? s.peso : 0);
  return Math.max(0, Math.min(1, p));
}

function arredondar(n) { return Math.round(n * 100) / 100; }

/* ---------------------------------------------------------------- *
 * 7. Uso a jusante                                                  *
 * ---------------------------------------------------------------- */

/**
 * Os dados derivados do NIF podem ser atribuídos a este lead?
 *
 * NAO_VERIFICADA responde "não". Não é severidade: é que não se sabe, e
 * dados antigos passam a ser revalidados na próxima investigação em vez
 * de continuarem a valer por inércia.
 */
export function identidadeSuficiente(identidade) {
  const e = identidade && identidade.estado;
  return IDENTIDADES_SUFICIENTES.includes(e);
}

/** E para provar num critério em Modo ESTRITO? Só CONFIRMADA. */
export function identidadeProvaEstrito(identidade) {
  const e = identidade && identidade.estado;
  return IDENTIDADES_ESTRITAS.includes(e);
}

/** Há algo na identidade que quem lê a tabela precisa de ver? */
export function identidadeAlerta(identidade) {
  const e = identidade && identidade.estado;
  return e === IDENTIDADE.CONFLITO || e === IDENTIDADE.REJEITADA
      || e === IDENTIDADE.INCONCLUSIVA;
}

/**
 * Registo de proveniência de um dado derivado, para sabermos de que NIF
 * e de que identidade ele depende. Metadata simples, não um grafo: o que
 * precisamos é que, se o NIF cair, o que veio dele caia também.
 */
export function dependenciaDeIdentidade(identidade) {
  return {
    nif: (identidade && identidade.nif) || null,
    identidade: (identidade && identidade.estado) || IDENTIDADE.NAO_VERIFICADA
  };
}

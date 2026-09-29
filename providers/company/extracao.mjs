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

/** Excerto um pouco maior, para quem quiser ler a frase inteira. §16 fixa 300. */
const TEXTO_ORIGINAL_CHARS = 300;

/**
 * O ano a que o número diz respeito, se a frase o disser.
 *
 * "Em 2018 tínhamos 40 colaboradores" não é uma afirmação sobre hoje, e
 * apresentá-la como se fosse seria inventar uma atualização que ninguém
 * fez. Sem ano explícito não se inventa nenhum: a ausência fica a null e
 * quem decide sabe que não sabe.
 */
const ANO_MIN = 1990;

/**
 * Anos que pertencem a outra coisa da frase.
 *
 * "Constituída em 12/06/2013. … O capital social é de € 250.000" — o
 * 2013 é a data de constituição, não o ano a que o capital diz respeito.
 * Marcá-lo como ano de referência seria afirmar algo que a página não
 * diz. Apanhado a rever, à mão, o que uma medição real produziu.
 */
const ANO_DE_OUTRA_COISA = /\b(?:constitu(?:í|i)da|fundada|criada|estabelecida|nasceu|iniciou|in(?:í|i)cio|desde|opera\s+desde|no\s+mercado\s+desde|h(?:á|a)\s+\d+\s+anos)\b[^.]{0,40}$/i;

function anoPerto(t, inicio, fim) {
  /* Janela apertada: quanto mais longe o ano estiver do número, menos
     provável é que lhe diga respeito. */
  const de = Math.max(0, inicio - 40);
  const janela = t.slice(de, fim + 40);
  const anoCorrente = new Date().getFullYear();
  let melhor = null;
  for (const m of janela.matchAll(/\b(?:19[9]\d|20\d{2})\b/g)) {
    const a = Number(m[0]);
    if (a < ANO_MIN || a > anoCorrente + 1) continue;
    /* o ano está preso a uma data de fundação? então não é deste dado */
    if (ANO_DE_OUTRA_COISA.test(janela.slice(0, m.index))) continue;
    /* o mais recente da janela: numa frase com "desde 1985 … em 2024",
       o ano do dado é o segundo, não o da fundação */
    if (melhor == null || a > melhor) melhor = a;
  }
  return melhor;
}

function textoOriginal(t, inicio, fim) {
  const i = Math.max(0, inicio - 40);
  const f = Math.min(t.length, fim + 60);
  return t.slice(i, f).replace(/\s+/g, ' ').trim().slice(0, TEXTO_ORIGINAL_CHARS);
}

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
export function numeroPt(bruto, { decimalVirgula = false } = {}) {
  if (bruto == null) return null;
  /* O espaço é separador de milhares em português: "1 000 000 €" é um
     milhão, não um euro. Custou-me exatamente isso num teste real. */
  let s = String(bruto).trim().replace(/\s/g, '');
  if (!s) return null;
  const temPonto = s.includes('.'), temVirgula = s.includes(',');
  if (temPonto && temVirgula) {
    /* Os dois separadores presentes: o ÚLTIMO é o decimal. Serve para as
       duas convenções sem ter de adivinhar a língua da página —
       "1.250.000,50" é português, "1,250,000.50" é inglês, e em ambos o
       separador que aparece por último separa os cêntimos. */
    s = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (temVirgula) {
    /* "2,000,000" são dois milhões em inglês; "2,5" são dois e meio em
       português. Só grupos certinhos de três revelam milhares.

       `decimalVirgula` é a desempate quando quem chama sabe que o texto
       é português: "1,250 milhões" são 1,25 milhões e não 1250 milhões,
       e a palavra "milhões" ao lado é que o denuncia. Sem esta pista o
       erro seria de mil vezes. */
    s = (!decimalVirgula && /^\d{1,3}(,\d{3})+$/.test(s))
      ? s.replace(/,/g, '')
      : s.replace(',', '.');
  } else if (temPonto) {
    /* "1.250" é mil duzentos e cinquenta; "1.5" seria decimal inglês e
       não se assume: grupos de três dígitos revelam milhares */
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Multiplicadores escritos por extenso. */
const ESCALAS = [
  { re: /\b(mil\s*milh(?:õ|o)es|bili(?:õ|o)es|billions?|bn)\b/i, x: 1e9 },
  { re: /\b(milh(?:õ|o)es?|millions?)\b/i, x: 1e6 },
  { re: /\b(mil|thousands?)\b/i, x: 1e3 },
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
 * Pessoas que não trabalham cá.
 *
 * "Rede com 500 médicos" não são 500 funcionários. Nem "formámos 800
 * profissionais", nem "apoiamos 200 trabalhadores", nem "3 membros
 * dedicados por cliente". Uma medição real em 30 empresas mostrou que o
 * ruído desta natureza é MUITO mais frequente do que a declaração
 * verdadeira — as páginas dizem "+800 Clientes Satisfeitos" e "Equipa
 * com +20 anos" quase tanto quanto dizem quantos são.
 *
 * Por isso o padrão solto "N pessoas" só é aceite se nada à volta
 * sugerir que aquelas pessoas são de outra gente.
 */
/* A lista olha para o que vem IMEDIATAMENTE ANTES do número, e só para
   aí. Uma primeira versão varria também o texto a seguir, e rejeitava
   "equipa de 12 pessoas focadas no cliente" — uma declaração verdadeira,
   deitada fora porque a frase dizia que a equipa é focada no cliente.
   Foi apanhado a medir em empresas reais.

   As pessoas contadas já são filtradas por PESSOAS: "500 clientes",
   "rede com 500 médicos" e "3 membros" nunca chegam aqui, porque
   clientes, médicos e membros não são palavras de efetivos. O que falta
   travar são os verbos que dizem que aquelas pessoas são de outra
   gente — formámos, apoiamos, recrutamos. */
const TERCEIROS_ANTES = /(?:form(?:á|a)mos|formamos|forma(?:ç|c)(?:ã|a)o\s+(?:de|a)|formad\w+\s+|apoiamos|apoiámos|servimos|gerimos|processamos|acompanhamos|recrutamos|recrutámos|selecionamos|colocamos|colocámos|ao\s+servi(?:ç|c)o\s+de|rede\s+(?:de|com)|para\s+(?:mais\s+de\s+)?)\s*$/i;

function pareceDeTerceiros(t, inicio) {
  return TERCEIROS_ANTES.test(t.slice(Math.max(0, inicio - 40), inicio));
}

/**
 * Um número que é um ano nunca é um efetivo.
 *
 * "Integrou a equipa da Bukip em 2022" apanhou-se nove vezes numa única
 * empresa durante a medição. Um padrão que ligasse "equipa" a um número
 * próximo devolveria 2022 funcionários.
 */
function ehAno(n) {
  return Number.isInteger(n) && n >= 1900 && n <= new Date().getFullYear() + 1;
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
  /* Grupos separados por espaço ou ponto — "1 000 000" e "1.000.000" —
     antes do caso simples, para que a alternativa mais longa ganhe. A
     moeda conta tanto à frente ("€100.000") como atrás ("100.000 €"). */
  /* Grupos separados por espaço ou ponto — "1 000 000" e "1.000.000" — e
     também por vírgula, que é como o inglês os escreve. A alternativa
     mais longa vem primeiro para ganhar ao caso simples. A escala aceita
     as palavras das duas línguas; `mil` leva fronteira à direita para
     não morder o princípio de "million". */
  const re = /(€|EUR)?\s*(\d{1,3}(?:[ .]\d{3})+(?:,\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)\s*(€|EUR|euros?|milh(?:õ|o)es?|millions?|billions?|thousands?|mil\b|bn\b|M\b|K\b)?/gi;
  let m;
  while ((m = re.exec(trecho)) !== null) {
    const bruto = m[2];
    const sufixo = m[3] || '';
    /* uma escala escrita em português diz que o número também está */
    const ptBR = /milh|mil\b|milhar/i.test(sufixo);
    const base = numeroPt(bruto, { decimalVirgula: ptBR });
    if (base == null) continue;
    const temMoeda = Boolean(m[1]) || Boolean(sufixo);
    /* um ano solto sem moeda nem escala não é um valor */
    if (!temMoeda && base >= 1900 && base <= 2100) continue;
    /* um número com espaços é ambíguo — "n.º 514 998 270" é um NIPC, não
       um valor. Só conta se houver moeda a dizer que é dinheiro. */
    if (!temMoeda && /\s/.test(bruto.trim())) continue;
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
  const re = /(?:capital\s+social|share\s+capital)(?:\s+(?:de|é|:|no\s+valor\s+de|em|integralmente\s+(?:realizado|subscrito)(?:\s+de)?))?/gi;
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
    const fimValor = fim + v.deslocamento + v.comprimento;
    achados.push({ campo: 'capitalSocial', valor: v.valor,
      contexto: contexto(t, m.index, (fim - m.index) + v.deslocamento + v.comprimento),
      anoReferencia: anoPerto(t, m.index, fimValor),
      textoOriginal: textoOriginal(t, m.index, fimValor) });
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
const PESSOAS = '(?:colaboradores?|funcion(?:á|a)rios?|profissionais|empregados?|pessoas|trabalhadores?|especialistas|t(?:é|e)cnicos?|employees?|staff|workers?)';

/** O mesmo, só no plural. Uma contagem de pessoas não vem no singular. */
const PESSOAS_PLURAL = '(?:colaboradores|funcion(?:á|a)rios|profissionais|empregados|pessoas|trabalhadores|especialistas|t(?:é|e)cnicos|employees|workers)';

/**
 * Um número de telefone português não é um efetivo.
 *
 * "Dep. Comercial / Técnico: 912 528 106" — o 912 é o princípio de um
 * telemóvel, e foi lido como 912 funcionários numa medição real. Um
 * número seguido de mais grupos de dígitos é um contacto, não uma
 * contagem.
 */
function pareceTelefone(t, fim) {
  return /^\s*\d{3}/.test(t.slice(fim, fim + 6));
}

export function extrairFuncionarios(t) {
  if (typeof t !== 'string' || !t) return [];
  const achados = [];

  /* "mais de 120 colaboradores" · "superior a 50 funcionários" · "over 500 employees" */
  const reMin = new RegExp('\\b(?:mais\\s+de|superior\\s+a|acima\\s+de|over|more\\s+than|\\+\\s*de)\\s*([\\d.,]{1,9})\\s*' + PESSOAS, 'gi');
  /* "equipa de 75 profissionais" · "conta com 40 colaboradores" · "temos 137" */
  const reExato = new RegExp('\\b(?:equipa\\s+(?:de|com)|conta\\s+com|somos|contamos\\s+com|uma\\s+equipa\\s+de|quadro\\s+de|temos|empregamos|possu(?:í|i)mos|integra|re(?:ú|u)ne|team\\s+of|staff\\s+of|workforce\\s+of|employs?)\\s*(?:um\\s+|uma\\s+|a\\s+)?(?:total\\s+de\\s+)?([\\d.,]{1,9})\\s*' + PESSOAS, 'gi');
  /* Formato de ficha técnica: "Nº total de trabalhadores: 21".
     É o modo mais formal de o declarar e era o que faltava — numa
     medição em 30 empresas reais, era a única declaração verdadeira de
     efetivos que a extração não apanhava.

     Exige contagem explícita ("Nº", "número de", "total de") OU a
     palavra no plural. A primeira versão aceitava o singular e leu
     "Dep. Comercial / Técnico: 912 528 106" como 912 funcionários — era
     o telemóvel da empresa. Um rótulo de departamento é singular; uma
     contagem de pessoas é plural. */
  const reRotulo = new RegExp(
    '(?:\\b(?:n\\.?\\s*[ºo°]\\s*|n(?:ú|u)mero\\s+(?:de\\s+)?|total\\s+(?:de\\s+)?)+' + PESSOAS +
    '|\\b' + PESSOAS_PLURAL + ')\\s*[:\\-–—]\\s*([\\d.,]{1,9})\\b', 'gi');
  /* "workforce of 350" · "team of 40" — em inglês o substantivo vem
     antes e o número sozinho depois, sem repetir a palavra. */
  const reIngles = /\b(?:workforce|team|staff|headcount)\s+of\s+([\d.,]{1,9})\b/gi;
  /* Último recurso: "120 colaboradores" sem nada à frente. É o padrão
     mais produtivo e o mais perigoso — só passa com a guarda de §10. */
  const reSolto = new RegExp('\\b([\\d.,]{1,9})\\s*' + PESSOAS + '\\b', 'gi');

  /* Onde já se leu alguma coisa. Sem isto, "mais de 100 colaboradores"
     produzia DOIS achados: o mínimo 100+ e, por cima, um exato 100 vindo
     do padrão solto — e o exato apresentaria como contagem o que é um
     limite inferior. O mínimo é lido primeiro e fica com o terreno. */
  const ocupado = [];
  const sobrepoe = (de, ate) => ocupado.some(([a, b]) => de < b && ate > a);

  for (const [re, operador, exigeGuarda] of [[reMin, '>=', false], [reExato, '=', false],
                                             [reRotulo, '=', false], [reIngles, '=', false],
                                             [reSolto, '=', true]]) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(t)) !== null) {
      if (sobrepoe(m.index, m.index + m[0].length)) continue;
      const v = numeroPt(m[1]);
      /* abaixo de 1 não é uma empresa; acima de 500 mil é quase de certeza
         outra coisa a ser lida como pessoas */
      if (v == null || !(v >= 1 && v <= 500000)) continue;
      const fim = m.index + m[0].length;
      if (pareceAgregado(t, m.index, fim)) continue;
      /* §10: pessoas que não trabalham cá */
      if (pareceDeTerceiros(t, m.index)) continue;
      /* "integrou a equipa em 2022" não são 2022 funcionários */
      if (ehAno(v) && (exigeGuarda || v >= 1900)) continue;
      /* "912 528 106" é um telemóvel, não novecentos e doze pessoas */
      if (pareceTelefone(t, fim)) continue;
      ocupado.push([m.index, fim]);
      achados.push({ campo: 'funcionarios', valor: Math.round(v), operador,
        contexto: contexto(t, m.index, m[0].length),
        anoReferencia: anoPerto(t, m.index, fim),
        textoOriginal: textoOriginal(t, m.index, fim) });
    }
  }
  return dedup(achados);
}

/* ---------------------------------------------------------------- *
 * Faturação                                                         *
 * ---------------------------------------------------------------- */

/**
 * §12 — grandezas que não são faturação e que aparecem ao lado dela.
 *
 * EBITDA, lucro, capital, investimento, um contrato adjudicado: são
 * todos números verdadeiros e nenhum é o volume de negócios. €2M em
 * contratos públicos não é faturação de €2M.
 */
const NAO_E_FATURACAO = /\b(?:EBITDA|lucro\w*|resultado\s+l(?:í|i)quido|resultados?\s+(?:do\s+)?exerc(?:í|i)cio|capital\s+(?:social|pr(?:ó|o)prio)|ativos?|activos?|passivos?|patrim(?:ó|o)nio|investimento\w*|financiamento\w*|subs(?:í|i)dio\w*|contrat\w+|adjudica(?:ç|c)\w+|or(?:ç|c)amento\w*|VAB|valuation|avalia(?:ç|c)(?:ã|a)o\s+da\s+empresa|margem|d(?:í|i)vida)\b/i;

/**
 * "Faturação" como serviço prestado, não como grandeza da empresa.
 *
 * Uma contabilista que ofereça "Tesouraria e Faturação" está a listar um
 * serviço. Um software "com módulo de Faturação" é uma ferramenta. Foi o
 * que a medição real encontrou em 100% dos casos deste setor.
 */
const FATURACAO_SERVICO = /\b(?:servi(?:ç|c)os?|m(?:ó|o)dulos?|software|programa|ferramentas?|plataforma|apoio|gest(?:ã|a)o\s+de|emiss(?:ã|a)o\s+de|processamento|consultoria|solu(?:ç|c)(?:õ|o)es|inclui|oferecemos|tratamos)\b/i;

function pareceServico(t, inicio, fim) {
  return FATURACAO_SERVICO.test(t.slice(Math.max(0, inicio - 55), fim + 25));
}

/**
 * "Volume de negócios de €5 milhões" · "faturação 2025: 2.400.000 €"
 *
 * Só a faturação DESTA empresa. Uma média do setor não entra aqui — e
 * como o extrator exige o rótulo junto do número, uma frase sobre o
 * mercado não o aciona.
 */
export function extrairFaturacao(t) {
  if (typeof t !== 'string' || !t) return [];
  const re = /\b(?:volume\s+de\s+neg(?:ó|o)cios|factura(?:ç|c)(?:ã|a)o|fatura(?:ç|c)(?:ã|a)o|receitas?\s+anuais?|receita\s+anual|turnover|annual\s+revenues?|revenues?)\b/gi;
  const achados = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    const fim = m.index + m[0].length;
    /* §12: a palavra sozinha não chega. Numa medição em 30 empresas
       reais, TODAS as ocorrências de "faturação" eram o nome de um
       serviço prestado ou de um módulo de software — "Tesouraria e
       Faturação", "Toconline (…, Facturação, …)". Nenhuma era a
       faturação da empresa. Por isso quem fala de faturação como
       atividade não conta. */
    if (pareceServico(t, m.index, fim)) continue;
    const v = valorMonetarioApos(t, fim);
    if (!v) continue;
    if (!(v.valor >= 1000 && v.valor <= 1e11)) continue;
    /* §9: uma estatística do setor não é o número desta empresa */
    const fimValor = fim + v.deslocamento + v.comprimento;
    if (pareceAgregado(t, m.index, fimValor)) continue;
    /* §12: o valor pode pertencer a outra grandeza que a frase nomeia —
       "volume de negócios e EBITDA de €2M". Olha-se só do rótulo até ao
       valor, e um pouco além. Uma primeira versão varria 60 caracteres
       ANTES do rótulo e perdia a faturação sempre que a mesma frase
       mencionasse o capital social — que é precisamente o que uma página
       institucional faz. */
    if (NAO_E_FATURACAO.test(t.slice(m.index, fimValor + 15))) continue;
    achados.push({ campo: 'faturacaoAnual', valor: v.valor,
      contexto: contexto(t, m.index, (fim - m.index) + v.deslocamento + v.comprimento),
      anoReferencia: anoPerto(t, m.index, fimValor),
      textoOriginal: textoOriginal(t, m.index, fimValor) });
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

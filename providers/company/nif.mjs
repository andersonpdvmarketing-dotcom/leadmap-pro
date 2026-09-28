/**
 * LeadMap Pro — NIF/NIPC português
 * ================================
 * Validação formal e extração conservadora a partir do HTML que o
 * enriquecimento JÁ descarrega. Não faz pedidos de rede e não conhece
 * fornecedores: é aritmética e leitura de texto.
 *
 * PORQUE NÃO CHEGA PROCURAR NOVE DÍGITOS
 * --------------------------------------
 * Uma página portuguesa está cheia de sequências de nove dígitos que não
 * são NIFs: telefones fixos (2xxxxxxxx) e telemóveis (9xxxxxxxx) têm
 * exatamente nove. Pior, o dígito de controlo do NIF acerta por acaso em
 * cerca de uma em cada onze sequências — portanto validar o checksum
 * sozinho aceitaria uma boa parte dos telefones do país.
 *
 * Daí a regra: só se aceita um número que apareça JUNTO de um rótulo que
 * diga o que ele é. Contexto primeiro, aritmética depois. Sem rótulo, não
 * há NIF, por mais bem formado que o número esteja.
 *
 * O código postal (1234-567) não entra nesta conversa porque tem sete
 * dígitos e um hífen — mas o extrator remove-os na mesma antes de
 * procurar, para que "1234-567" nunca se cole a outro número e produza
 * nove dígitos por acidente.
 */

/* ---------------------------------------------------------------- *
 * Validação formal                                                  *
 * ---------------------------------------------------------------- */

/**
 * Prefixos atribuíveis pela AT. Um NIF bem formado começa por um destes.
 *
 * Um dígito: 1,2,3 pessoa singular · 5 pessoa coletiva (NIPC) ·
 *            6 entidade pública · 8 empresário em nome individual ·
 *            9 sociedades irregulares e outros
 * Dois dígitos: 45 não residente singular · 70,74,75 heranças e
 *            co-propriedades · 71 não residente coletivo · 72 fundos ·
 *            77 atribuição oficiosa · 78,98 não residentes ·
 *            79 regime excecional · 90,91 condomínios e sociedades civis ·
 *            99 sociedades civis sem personalidade jurídica
 */
const PREFIXOS_1 = new Set(['1', '2', '3', '5', '6', '8', '9']);
const PREFIXOS_2 = new Set(['45', '70', '71', '72', '74', '75', '77', '78', '79', '90', '91', '98', '99']);

/** Só dígitos, aceitando espaços e pontos de formatação e o prefixo PT. */
export function normalizarNif(bruto) {
  if (bruto == null) return null;
  const s = String(bruto).trim().replace(/^PT\s*/i, '');
  const d = s.replace(/[\s.\-]/g, '');
  return /^\d{9}$/.test(d) ? d : null;
}

/**
 * Valida um NIF português: prefixo atribuível e dígito de controlo.
 *
 * O dígito de controlo é o módulo 11 da soma dos oito primeiros dígitos
 * ponderados de 9 a 2. Resto 0 ou 1 implica dígito de controlo 0.
 */
export function nifValido(bruto) {
  const d = normalizarNif(bruto);
  if (!d) return false;

  /* prefixo: tenta dois dígitos primeiro, porque 45 e 4 são coisas
     diferentes e só o de dois dígitos é atribuível */
  if (!PREFIXOS_2.has(d.slice(0, 2)) && !PREFIXOS_1.has(d[0])) return false;

  let soma = 0;
  for (let i = 0; i < 8; i++) soma += Number(d[i]) * (9 - i);
  const resto = soma % 11;
  const controlo = resto < 2 ? 0 : 11 - resto;
  return controlo === Number(d[8]);
}

/** É um NIPC — pessoa coletiva? Informativo; um NIF de 1/2/3 também é válido. */
export function ehNipc(bruto) {
  const d = normalizarNif(bruto);
  if (!d || !nifValido(d)) return false;
  return d[0] === '5' || d[0] === '6' || PREFIXOS_2.has(d.slice(0, 2));
}

/* ---------------------------------------------------------------- *
 * Extração a partir de HTML                                         *
 * ---------------------------------------------------------------- */

/**
 * Rótulos que autorizam a leitura de um número como NIF, e quanta
 * confiança cada um merece.
 *
 * "VAT" sozinho vale menos porque num site multilingue pode estar ao lado
 * do número de IVA de outro país. O prefixo PT explícito resolve isso e
 * por isso vale mais.
 */
const ROTULOS = [
  { re: /\bPT\s*(\d{9})\b/gi,                                                    peso: 0.95, nome: 'VAT PT' },
  { re: /\bNIPC\b[\s:.\-–—]*(?:n\.?[ºo°]?)?[\s:.\-–—]*(\d[\d\s.\-]{8,13})/gi,     peso: 0.95, nome: 'NIPC' },
  { re: /\bn(?:ú|u)mero\s+de\s+contribuinte\b[\s:.\-–—]*(\d[\d\s.\-]{8,13})/gi,   peso: 0.9,  nome: 'Número de Contribuinte' },
  { re: /\bn\.?\s*[ºo°]?\s*contribuinte\b[\s:.\-–—]*(\d[\d\s.\-]{8,13})/gi,       peso: 0.9,  nome: 'N.º Contribuinte' },
  /* "Contribuinte n.º 5…" — o n.º aparece DEPOIS do rótulo tantas vezes
     como antes, e sem o aceitar aqui o padrão não chega ao número */
  { re: /\bcontribuinte\b[\s:.\-–—]*(?:n\.?\s*[ºo°]?\.?)?[\s:.\-–—]*(\d[\d\s.\-]{8,13})/gi, peso: 0.85, nome: 'Contribuinte' },
  { re: /\bNIF\b[\s:.\-–—]*(?:n\.?[ºo°]?)?[\s:.\-–—]*(\d[\d\s.\-]{8,13})/gi,      peso: 0.9,  nome: 'NIF' },
  { re: /\bVAT(?:\s*(?:number|no\.?|n\.?[ºo°]))?\b[\s:.\-–—]*(?:PT)?[\s:.\-–—]*(\d[\d\s.\-]{8,13})/gi, peso: 0.8, nome: 'VAT' }
];

/** Máximo de HTML analisado. O resto é ignorado em vez de arriscar o evento loop. */
const MAX_HTML = 2 * 1024 * 1024;

/**
 * HTML → texto plano, preservando as fronteiras entre elementos.
 *
 * As fronteiras importam: `<td>NIF</td><td>501234567</td>` sem separador
 * viraria "NIF501234567" e o rótulo deixaria de estar "junto" do número
 * de forma reconhecível. Com espaço, funciona.
 */
export function htmlParaTexto(html) {
  if (typeof html !== 'string') return '';
  return html
    .slice(0, MAX_HTML)
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    /* entidades que separam ou colam números */
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    /* códigos postais fora do caminho: 1234-567 nunca deve colar-se a nada */
    .replace(/\b\d{4}-\d{3}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Procura um NIF no HTML. Devolve sempre a mesma forma:
 *   { encontrado, nif, rotulo, confianca, candidatos }
 *
 * Um candidato só conta se tiver rótulo E passar na validação formal.
 * Quando aparecem vários NIFs diferentes — acontece em páginas com o NIF
 * do cliente, do fornecedor e da agência que fez o site — só se aceita se
 * um deles for claramente mais forte. Em empate devolve-se nada: é
 * preferível não saber a atribuir o NIF errado a uma empresa.
 */
export function extrairNif(html) {
  const vazio = { encontrado: false, nif: null, rotulo: null, confianca: null, candidatos: [] };
  const texto = htmlParaTexto(html);
  if (!texto) return vazio;

  /* nif → { peso, rotulo, ocorrencias } */
  const achados = new Map();

  for (const { re, peso, nome } of ROTULOS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(texto)) !== null) {
      const d = normalizarNif(m[1]);
      if (!d || !nifValido(d)) continue;
      const anterior = achados.get(d);
      if (!anterior) {
        achados.set(d, { peso, rotulo: nome, ocorrencias: 1 });
      } else {
        anterior.ocorrencias += 1;
        if (peso > anterior.peso) { anterior.peso = peso; anterior.rotulo = nome; }
      }
    }
  }

  if (!achados.size) return vazio;

  const candidatos = [...achados.entries()]
    .map(([nif, v]) => ({ nif, ...v }))
    .sort((a, b) => (b.peso - a.peso) || (b.ocorrencias - a.ocorrencias));

  if (candidatos.length > 1) {
    const [p, s] = candidatos;
    /* empate real: mesmo peso e mesma contagem. Não se escolhe à sorte. */
    if (p.peso === s.peso && p.ocorrencias === s.ocorrencias) {
      return { ...vazio, candidatos };
    }
  }

  const escolhido = candidatos[0];
  /* vários NIFs na página reduzem a certeza mesmo quando um se destaca */
  const confianca = candidatos.length > 1
    ? Math.round(Math.max(0.5, escolhido.peso - 0.15) * 100) / 100
    : escolhido.peso;

  return {
    encontrado: true,
    nif: escolhido.nif,
    rotulo: escolhido.rotulo,
    confianca,
    candidatos
  };
}

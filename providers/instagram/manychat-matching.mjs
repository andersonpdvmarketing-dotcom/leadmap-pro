/**
 * LeadMap Pro — emparelhar leads com subscribers da ManyChat
 * ==========================================================
 * A ManyChat não permite procurar por username de Instagram. A ordem de
 * tentativa é, por isso, a única que a API suporta:
 *
 *   1. email     → findBySystemField(email)
 *   2. telefone  → findBySystemField(phone)
 *   3. manual    → subscriber_id introduzido por quem opera
 *
 * Encontrado o subscriber, `getInfo` devolve `ig_username`. Quando o
 * lead **também** tem Instagram, os dois são comparados. É esta
 * comparação que transforma um resultado de pesquisa numa prova.
 *
 * NADA AQUI ADIVINHA
 * ------------------
 * Não há procura por nome, não há fuzzy matching, não há "parece ser
 * ele". Um email que devolve duas pessoas fica `AMBIGUOUS_MATCH` e pára
 * ali. A alternativa — escolher a primeira — seria escrever a um
 * estranho em nome do utilizador, e isso não se desfaz.
 */

export const MATCH_STATUS = Object.freeze({
  MATCH_CONFIRMED:    'MATCH_CONFIRMED',
  NOT_IN_MANYCHAT:    'NOT_IN_MANYCHAT',
  AMBIGUOUS_MATCH:    'AMBIGUOUS_MATCH',
  INSTAGRAM_MISMATCH: 'INSTAGRAM_MISMATCH',
  NO_LOOKUP_DATA:     'NO_LOOKUP_DATA',
  OPTED_OUT:          'OPTED_OUT',
  PROVIDER_ERROR:     'PROVIDER_ERROR'
});

/** Rótulos para o passo 2 do assistente. */
export const MATCH_ROTULO = Object.freeze({
  MATCH_CONFIRMED:    'Elegíveis ManyChat',
  NOT_IN_MANYCHAT:    'Não encontrados',
  NO_LOOKUP_DATA:     'Sem dados para procura',
  INSTAGRAM_MISMATCH: 'Instagram incompatível',
  AMBIGUOUS_MATCH:    'Correspondência ambígua',
  OPTED_OUT:          'Opt-out',
  PROVIDER_ERROR:     'Erro do fornecedor'
});

/* ---------------------------------------------------------------- *
 * Normalização                                                      *
 * ---------------------------------------------------------------- */

export function normalizarEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  /* validação deliberadamente mínima: só recusa o que não pode ser um
     email. Inventar regras mais apertadas aqui rejeitaria endereços
     válidos e estranhos que existem mesmo. */
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/**
 * Normaliza um número mantendo a informação de país.
 *
 * Só se removem separadores. Um `00` inicial vira `+`. O que **não** se
 * faz é inventar um indicativo: `912345678` pode ser português ou de
 * outro país qualquer, e adivinhar aqui trocaria a identidade da pessoa.
 * Nesse caso o número segue para a procura, mas fica marcado — e um
 * resultado assim nunca é confirmado sozinho.
 */
export function normalizarTelefone(v) {
  const bruto = String(v || '').trim();
  if (!bruto) return null;
  let s = bruto.replace(/[\s()./-]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  const temMais = s.startsWith('+');
  const digitos = s.replace(/\D/g, '');
  if (digitos.length < 6 || digitos.length > 15) return null;
  return { valor: (temMais ? '+' : '') + digitos, paisConhecido: temMais };
}

/** Reduz um Instagram à sua forma comparável. Sem fuzzy matching. */
export function normalizarInstagram(v) {
  let s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\/(www\.)?instagram\.com\//, '');
  s = s.replace(/\/+$/, '');
  s = s.replace(/^@/, '');
  s = s.split(/[?#]/)[0];
  return /^[a-z0-9._]{1,30}$/.test(s) ? s : null;
}

/* ---------------------------------------------------------------- *
 * Emparelhamento                                                    *
 * ---------------------------------------------------------------- */

function resultado(status, extra = {}) {
  return { status, subscriber: null, motivo: null, via: null, ...extra };
}

/**
 * Emparelha UM lead.
 *
 * @param {object} lead      { id, nome, email, telefone, instagram, optOut }
 * @param {ManyChatInstagramProvider} provider
 */
export async function emparelharLead(lead = {}, provider) {
  if (lead.optOut === true || lead.status === 'OPTED_OUT') {
    return resultado(MATCH_STATUS.OPTED_OUT, { motivo: 'O contacto pediu para não ser contactado.' });
  }

  const email = normalizarEmail(lead.email);
  const tel = normalizarTelefone(lead.telefone || lead.phone);
  const igLead = normalizarInstagram(lead.instagram || lead.normalizedInstagram);

  if (!email && !tel) {
    return resultado(MATCH_STATUS.NO_LOOKUP_DATA, {
      motivo: igLead
        ? 'Só há Instagram, e a ManyChat não permite procurar por username. É preciso associar o subscriber à mão.'
        : 'Sem email nem telefone para procurar na ManyChat.'
    });
  }

  let achados = [];
  let via = null;
  try {
    if (email) {
      achados = await provider.procurarSubscriber({ email });
      via = 'email';
    }
    if (!achados.length && tel) {
      achados = await provider.procurarSubscriber({ phone: tel.valor });
      via = 'telefone';
    }
  } catch (err) {
    return resultado(MATCH_STATUS.PROVIDER_ERROR, {
      motivo: (err && err.message) || 'Falha a consultar a ManyChat.', via
    });
  }

  if (!achados.length) {
    return resultado(MATCH_STATUS.NOT_IN_MANYCHAT, {
      via,
      motivo: 'Não existe subscriber com este ' + (via === 'email' ? 'email' : 'telefone') +
              '. Alguém tem de ter falado consigo primeiro.'
    });
  }

  /* §3: mais do que um resultado é uma dúvida, não uma escolha */
  const unicos = [...new Map(achados.map(a => [a.subscriberId, a])).values()];
  if (unicos.length > 1) {
    return resultado(MATCH_STATUS.AMBIGUOUS_MATCH, {
      via,
      motivo: unicos.length + ' subscribers com o mesmo ' + (via === 'email' ? 'email' : 'telefone') + '. Escolha manual.'
    });
  }

  /* Confirmar contra a fonte: `getInfo` é que traz o ig_username. */
  let subscriber;
  try {
    subscriber = await provider.lerSubscriber(unicos[0].subscriberId);
  } catch (err) {
    return resultado(MATCH_STATUS.PROVIDER_ERROR, { via, motivo: (err && err.message) || 'Falha a ler o subscriber.' });
  }

  const igMc = normalizarInstagram(subscriber.igUsername);

  if (igLead && igMc && igLead !== igMc) {
    return resultado(MATCH_STATUS.INSTAGRAM_MISMATCH, {
      subscriber, via,
      motivo: 'O Instagram do subscriber (@' + igMc + ') não é o do lead (@' + igLead + ').'
    });
  }

  /* §4: um telefone sem indicativo pode pertencer a outro país. Só é
     aceite sozinho quando o Instagram confirma o mesmo par. */
  if (via === 'telefone' && tel && !tel.paisConhecido && !(igLead && igMc && igLead === igMc)) {
    return resultado(MATCH_STATUS.AMBIGUOUS_MATCH, {
      subscriber, via,
      motivo: 'Telefone sem indicativo de país e sem Instagram para cruzar. Confirme à mão.'
    });
  }

  return resultado(MATCH_STATUS.MATCH_CONFIRMED, {
    subscriber, via,
    motivo: igLead && igMc ? 'Instagram confirmado pela ManyChat.'
      : 'Encontrado por ' + (via === 'email' ? 'email' : 'telefone') + '; o subscriber não tem Instagram para cruzar.'
  });
}

/**
 * Emparelha vários leads, em série.
 *
 * Em série de propósito: `findBySystemField` permite 50 q/s e `getInfo`
 * só 10 q/s. Disparar tudo em paralelo é a forma mais rápida de apanhar
 * um 429 e ficar sem saber quais leads chegaram a ser consultados.
 */
export async function emparelharLote(leads = [], provider, { aoProgresso = null, limite = 200 } = {}) {
  const lista = leads.slice(0, limite);
  const resultados = [];
  for (let i = 0; i < lista.length; i++) {
    const r = await emparelharLead(lista[i], provider);
    resultados.push({ lead: lista[i], ...r });
    if (aoProgresso) aoProgresso(i + 1, lista.length, r);
  }
  return {
    resultados,
    resumo: contar(resultados),
    truncado: leads.length > lista.length ? leads.length - lista.length : 0
  };
}

/** Contagem por estado — é o que o passo 2 do assistente mostra. */
export function contar(resultados = []) {
  const base = Object.fromEntries(Object.values(MATCH_STATUS).map(s => [s, 0]));
  for (const r of resultados) if (base[r.status] !== undefined) base[r.status] += 1;
  return base;
}

/** Só estes podem entrar numa campanha. */
export function elegiveis(resultados = []) {
  return resultados.filter(r => r.status === MATCH_STATUS.MATCH_CONFIRMED && r.subscriber);
}

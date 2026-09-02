/**
 * LeadMap Pro — domínio do Outreach (Fase B, SIMULAÇÃO)
 * =====================================================
 * Contactos, templates, campanhas e fila. Tudo puro e testável em Node:
 * não toca no DOM, não toca na rede, não lê o relógio sem que lho passem.
 *
 * MODO DE SIMULAÇÃO
 * -----------------
 * Nada aqui envia mensagens. O processamento usa o `MockInstagramProvider`
 * da Fase A, com resultados determinísticos derivados de um hash do par
 * (campanha, contacto) — a mesma campanha simulada duas vezes dá sempre o
 * mesmo resultado. Nenhum pedido sai para graph.facebook.com, para o
 * instagram.com nem para fornecedor nenhum.
 *
 * As capacidades, estados de conta e códigos de erro vêm do contrato da
 * Fase A. Não há segunda definição.
 */

import {
  ACCOUNT_STATUS, MESSAGE_STATUS, ELIGIBILITY, MAX_CONTAS, normalizarConta
} from '../instagram/contract.mjs';

export { MAX_CONTAS, ACCOUNT_STATUS, MESSAGE_STATUS, ELIGIBILITY };

/* ---------------------------------------------------------------- *
 * Enumerações próprias do Outreach                                  *
 * ---------------------------------------------------------------- */

/** Estado de um contacto na base do Outreach. */
export const CONTACT_STATUS = Object.freeze({
  /* Ter @instagram NÃO é o mesmo que poder receber DM: o estado inicial
     é sempre UNKNOWN, nunca ELIGIBLE. */
  UNKNOWN: 'UNKNOWN',
  ELIGIBLE: 'ELIGIBLE',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  OPTED_OUT: 'OPTED_OUT',
  SENT: 'SENT',
  REPLIED: 'REPLIED'
});

export const CAMPAIGN_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  READY: 'READY',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED'
});

export const QUEUE_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  PAUSED: 'PAUSED'
});

/** Motivos de exclusão de um contacto de uma campanha. */
export const MOTIVO_EXCLUSAO = Object.freeze({
  SEM_INSTAGRAM: 'SEM_INSTAGRAM',
  OPTED_OUT: 'OPTED_OUT',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE'
});

export const VARIAVEIS = Object.freeze(['nome', 'empresa', 'cidade', 'atividade']);

const ND = 'N/D';

/* ---------------------------------------------------------------- *
 * Estado                                                            *
 * ---------------------------------------------------------------- */

export function estadoInicial() {
  return {
    versao: 1,
    contactos: [],
    contas: [],
    templates: [],
    campanhas: [],
    fila: [],
    mensagens: [],     /* histórico simulado, por contacto */
    seq: 0
  };
}

function proximoId(estado, prefixo) {
  estado.seq = (Number(estado.seq) || 0) + 1;
  return prefixo + '-' + estado.seq;
}

/* ---------------------------------------------------------------- *
 * Instagram: normalização e chave de deduplicação                   *
 * ---------------------------------------------------------------- */

/**
 * Extrai o handle de um URL ou de um @nome. Devolve null quando não há
 * Instagram utilizável — nunca inventa um a partir do nome da empresa.
 */
export function normalizarInstagram(bruto) {
  if (!bruto || typeof bruto !== 'string') return null;
  let s = bruto.trim();
  if (!s || s === ND) return null;
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  if (/^instagram\.com\//i.test(s) || /^m\.instagram\.com\//i.test(s)) {
    s = s.replace(/^m?\.?instagram\.com\//i, '');
  }
  s = s.split(/[?#]/)[0].replace(/\/+$/, '').replace(/^@/, '');
  if (!s) return null;
  /* caminhos que não são perfis */
  if (/^(p|reel|reels|stories|explore|accounts|direct|tv)(\/|$)/i.test(s)) return null;
  if (s.includes('/')) return null;
  if (!/^[a-z0-9._]{1,30}$/i.test(s)) return null;
  return s.toLowerCase();
}

/** Chave de deduplicação: Instagram normalizado; sem ele, o id do lead. */
export function chaveContacto(c) {
  const ig = normalizarInstagram(c.instagram);
  return ig ? 'ig:' + ig : 'lead:' + String(c.leadId || c.id || '');
}

/* ---------------------------------------------------------------- *
 * Contactos                                                         *
 * ---------------------------------------------------------------- */

function valorOuNulo(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return (!s || s === ND) ? null : s;
}

/** Converte um lead do LeadMap num contacto de Outreach. */
export function contactoDeLead(lead, origem = 'pesquisa') {
  const ig = normalizarInstagram(lead.instagram);
  return {
    id: null,                        /* atribuído ao inserir */
    leadId: lead.id != null ? String(lead.id) : null,
    nome: valorOuNulo(lead.nome) || 'Sem nome',
    empresa: valorOuNulo(lead.nome),
    instagram: ig,
    temInstagram: Boolean(ig),
    atividade: valorOuNulo((lead.searchQueries && lead.searchQueries[0]) || lead.segmento),
    cidade: valorOuNulo(lead.localidade),
    distrito: valorOuNulo(lead.distrito),
    concelho: valorOuNulo(lead.concelho),
    website: valorOuNulo(lead.website),
    telefone: valorOuNulo(lead.telefone) || valorOuNulo(lead.telemovel),
    email: (lead.emails && lead.emails.length) ? valorOuNulo(lead.emails[0].email) : null,
    origem,
    status: CONTACT_STATUS.UNKNOWN,   /* nunca ELIGIBLE por omissão */
    campanhas: [],
    adicionadoEm: null,
    ultimaAcao: null
  };
}

/**
 * Adiciona leads à base de contactos, sem duplicar.
 * Um contacto já existente é ATUALIZADO (preenche lacunas), nunca
 * duplicado, e o seu estado — incluindo OPTED_OUT — é preservado.
 */
export function adicionarContactos(estado, leads, { origem = 'pesquisa', agora = () => new Date().toISOString() } = {}) {
  const indice = new Map(estado.contactos.map(c => [chaveContacto(c), c]));
  const resumo = { adicionados: 0, atualizados: 0, semInstagram: 0, ids: [] };

  for (const lead of (leads || [])) {
    const novo = contactoDeLead(lead, origem);
    const chave = chaveContacto(novo);
    const existente = indice.get(chave);

    if (existente) {
      for (const campo of ['nome', 'empresa', 'instagram', 'atividade', 'cidade', 'distrito', 'concelho', 'website', 'telefone', 'email']) {
        if (!existente[campo] && novo[campo]) existente[campo] = novo[campo];
      }
      existente.temInstagram = Boolean(normalizarInstagram(existente.instagram));
      resumo.atualizados += 1;
      resumo.ids.push(existente.id);
      if (!existente.temInstagram) resumo.semInstagram += 1;
      continue;
    }

    novo.id = proximoId(estado, 'c');
    novo.adicionadoEm = agora();
    estado.contactos.push(novo);
    indice.set(chave, novo);
    resumo.adicionados += 1;
    resumo.ids.push(novo.id);
    if (!novo.temInstagram) resumo.semInstagram += 1;
  }
  return resumo;
}

export function definirOptOut(estado, contactoId, optOut = true) {
  const c = estado.contactos.find(x => x.id === contactoId);
  if (!c) return null;
  if (optOut) {
    c.statusAnterior = c.status;
    c.status = CONTACT_STATUS.OPTED_OUT;
  } else {
    c.status = c.statusAnterior || CONTACT_STATUS.UNKNOWN;
    delete c.statusAnterior;
  }
  return c;
}

/* ---------------------------------------------------------------- *
 * Contas (mock) — teto de 5, reutilizando o contrato da Fase A      *
 * ---------------------------------------------------------------- */

export function adicionarConta(estado, { username, displayName, provider = 'mock' }, { agora = () => new Date().toISOString() } = {}) {
  const user = valorOuNulo(username);
  if (!user) throw new Error('Indique o nome de utilizador da conta.');
  const handle = normalizarInstagram(user) || user.replace(/^@/, '').toLowerCase();

  if (estado.contas.some(c => c.username === handle && c.status !== ACCOUNT_STATUS.DISCONNECTED)) {
    throw new Error('Essa conta já está ligada.');
  }
  const ativas = estado.contas.filter(c => c.status !== ACCOUNT_STATUS.DISCONNECTED);
  if (ativas.length >= MAX_CONTAS) {
    throw new Error('Limite máximo de ' + MAX_CONTAS + ' contas registadas.');
  }
  /* normalizarConta é a mesma função que valida contas na Fase A */
  const base = normalizarConta({
    provider,
    providerAccountId: provider + '-acct-' + handle,
    username: handle,
    displayName: valorOuNulo(displayName) || handle,
    status: ACCOUNT_STATUS.CONNECTED,
    connectedAt: agora()
  });
  const conta = { ...base, id: proximoId(estado, 'a'), accountId: provider + ':' + base.providerAccountId };
  estado.contas.push(conta);
  return conta;
}

export function removerConta(estado, contaId) {
  const i = estado.contas.findIndex(c => c.id === contaId);
  if (i < 0) return false;
  estado.contas.splice(i, 1);
  return true;
}

/* ---------------------------------------------------------------- *
 * Templates                                                         *
 * ---------------------------------------------------------------- */

export function criarTemplate(estado, { nome, mensagem }) {
  const n = valorOuNulo(nome);
  const m = typeof mensagem === 'string' ? mensagem : '';
  if (!n) throw new Error('Indique um nome para o template.');
  if (!m.trim()) throw new Error('A mensagem não pode estar vazia.');
  const t = { id: proximoId(estado, 't'), nome: n, mensagem: m, criadoEm: new Date(0).toISOString() };
  estado.templates.push(t);
  return t;
}

export function editarTemplate(estado, id, campos) {
  const t = estado.templates.find(x => x.id === id);
  if (!t) throw new Error('Template não encontrado.');
  if (campos.nome !== undefined) {
    const n = valorOuNulo(campos.nome);
    if (!n) throw new Error('Indique um nome para o template.');
    t.nome = n;
  }
  if (campos.mensagem !== undefined) {
    if (!String(campos.mensagem).trim()) throw new Error('A mensagem não pode estar vazia.');
    t.mensagem = String(campos.mensagem);
  }
  return t;
}

export function duplicarTemplate(estado, id) {
  const t = estado.templates.find(x => x.id === id);
  if (!t) throw new Error('Template não encontrado.');
  const copia = { id: proximoId(estado, 't'), nome: t.nome + ' (cópia)', mensagem: t.mensagem, criadoEm: t.criadoEm };
  estado.templates.push(copia);
  return copia;
}

export function eliminarTemplate(estado, id) {
  const i = estado.templates.findIndex(x => x.id === id);
  if (i < 0) return false;
  estado.templates.splice(i, 1);
  return true;
}

/** Variáveis usadas num texto, na ordem em que aparecem. */
export function variaveisDe(texto) {
  const encontradas = [];
  for (const m of String(texto || '').matchAll(/\{\{\s*([a-z]+)\s*\}\}/gi)) {
    const v = m[1].toLowerCase();
    if (!encontradas.includes(v)) encontradas.push(v);
  }
  return encontradas;
}

/**
 * Resolve as variáveis de um template para um contacto.
 * NUNCA inventa valores: uma variável sem dado fica por resolver e é
 * devolvida em `faltam`, para o UI poder avisar antes de enviar.
 */
export function resolverVariaveis(texto, contacto) {
  const faltam = [];
  const desconhecidas = [];
  const saida = String(texto || '').replace(/\{\{\s*([a-z]+)\s*\}\}/gi, (todo, bruta) => {
    const v = bruta.toLowerCase();
    if (!VARIAVEIS.includes(v)) {
      if (!desconhecidas.includes(v)) desconhecidas.push(v);
      return todo;                                  /* deixa visível o erro */
    }
    const valor = valorOuNulo(contacto && contacto[v]);
    if (!valor) {
      if (!faltam.includes(v)) faltam.push(v);
      return todo;                                  /* não se inventa nada */
    }
    return valor;
  });
  return { texto: saida, faltam, desconhecidas, completo: faltam.length === 0 && desconhecidas.length === 0 };
}

/* ---------------------------------------------------------------- *
 * Campanhas                                                         *
 * ---------------------------------------------------------------- */

/**
 * Separa os contactos elegíveis dos excluídos, com o motivo de cada
 * exclusão. Sem Instagram e OPTED_OUT saem sempre.
 */
export function separarElegiveis(estado, contactoIds) {
  const porId = new Map(estado.contactos.map(c => [c.id, c]));
  const incluidos = [];
  const excluidos = [];
  for (const id of (contactoIds || [])) {
    const c = porId.get(id);
    if (!c) continue;
    if (!c.temInstagram) { excluidos.push({ contacto: c, motivo: MOTIVO_EXCLUSAO.SEM_INSTAGRAM }); continue; }
    if (c.status === CONTACT_STATUS.OPTED_OUT) { excluidos.push({ contacto: c, motivo: MOTIVO_EXCLUSAO.OPTED_OUT }); continue; }
    if (c.status === CONTACT_STATUS.NOT_ELIGIBLE) { excluidos.push({ contacto: c, motivo: MOTIVO_EXCLUSAO.NOT_ELIGIBLE }); continue; }
    incluidos.push(c);
  }
  return { incluidos, excluidos };
}

export function validarCampanha(estado, { nome, contactoIds, contaId, mensagem, templateId }) {
  const erros = [];
  if (!valorOuNulo(nome)) erros.push('Indique um nome para a campanha.');
  if (!contaId) erros.push('Escolha a conta Instagram que vai enviar.');
  else if (!estado.contas.some(c => c.id === contaId)) erros.push('A conta escolhida já não existe.');

  const corpo = templateId
    ? (estado.templates.find(t => t.id === templateId) || {}).mensagem
    : mensagem;
  if (!String(corpo || '').trim()) erros.push('A mensagem não pode estar vazia.');

  const { incluidos, excluidos } = separarElegiveis(estado, contactoIds);
  if (!incluidos.length) {
    erros.push(excluidos.length
      ? 'Nenhum dos contactos escolhidos pode receber esta campanha.'
      : 'Escolha pelo menos um contacto.');
  }
  return { valido: erros.length === 0, erros, incluidos, excluidos };
}

export function criarCampanha(estado, dados, { agora = () => new Date().toISOString() } = {}) {
  const v = validarCampanha(estado, dados);
  if (!v.valido) { const e = new Error(v.erros[0]); e.erros = v.erros; throw e; }

  const conta = estado.contas.find(c => c.id === dados.contaId);
  const corpo = dados.templateId
    ? estado.templates.find(t => t.id === dados.templateId).mensagem
    : dados.mensagem;

  const campanha = {
    id: proximoId(estado, 'k'),
    nome: valorOuNulo(dados.nome),
    contaId: conta.id,
    /* congelado: a campanha regista o fornecedor com que foi criada */
    provider: conta.provider,
    templateId: dados.templateId || null,
    mensagem: corpo,
    contactoIds: v.incluidos.map(c => c.id),
    excluidos: v.excluidos.map(x => ({ contactoId: x.contacto.id, motivo: x.motivo })),
    status: CAMPAIGN_STATUS.DRAFT,
    criadaEm: agora()
  };
  estado.campanhas.push(campanha);
  for (const c of v.incluidos) if (!c.campanhas.includes(campanha.id)) c.campanhas.push(campanha.id);
  return campanha;
}

export function mudarEstadoCampanha(estado, campanhaId, novo) {
  const k = estado.campanhas.find(x => x.id === campanhaId);
  if (!k) throw new Error('Campanha não encontrada.');
  if (!CAMPAIGN_STATUS[novo]) throw new Error('Estado inválido.');
  k.status = novo;
  if (novo === CAMPAIGN_STATUS.PAUSED) {
    for (const i of estado.fila) if (i.campanhaId === k.id && i.status === QUEUE_STATUS.PENDING) i.status = QUEUE_STATUS.PAUSED;
  }
  if (novo === CAMPAIGN_STATUS.RUNNING) {
    for (const i of estado.fila) if (i.campanhaId === k.id && i.status === QUEUE_STATUS.PAUSED) i.status = QUEUE_STATUS.PENDING;
  }
  if (novo === CAMPAIGN_STATUS.CANCELLED) {
    for (const i of estado.fila) {
      if (i.campanhaId === k.id && (i.status === QUEUE_STATUS.PENDING || i.status === QUEUE_STATUS.PAUSED)) {
        i.status = QUEUE_STATUS.SKIPPED;
        i.erro = 'Campanha cancelada.';
      }
    }
  }
  return k;
}

/* ---------------------------------------------------------------- *
 * Fila (simulação)                                                  *
 * ---------------------------------------------------------------- */

/** Cria os itens de fila de uma campanha. Idempotente por (campanha, contacto). */
export function gerarFila(estado, campanhaId) {
  const k = estado.campanhas.find(x => x.id === campanhaId);
  if (!k) throw new Error('Campanha não encontrada.');
  const jaExiste = new Set(estado.fila.filter(i => i.campanhaId === k.id).map(i => i.contactoId));
  const porId = new Map(estado.contactos.map(c => [c.id, c]));
  let criados = 0;

  for (const cid of k.contactoIds) {
    if (jaExiste.has(cid)) continue;
    const c = porId.get(cid);
    if (!c) continue;
    estado.fila.push({
      id: proximoId(estado, 'q'),
      campanhaId: k.id,
      contactoId: cid,
      contaId: k.contaId,
      provider: k.provider,
      instagram: c.instagram,
      status: QUEUE_STATUS.PENDING,
      tentativas: 0,
      ultimaTentativa: null,
      erro: null,
      providerMessageId: null
    });
    criados += 1;
  }
  if (k.status === CAMPAIGN_STATUS.DRAFT) k.status = CAMPAIGN_STATUS.READY;
  return { criados, total: estado.fila.filter(i => i.campanhaId === k.id).length };
}

/* Hash estável: o mesmo par (campanha, contacto) dá sempre o mesmo
   resultado simulado, em qualquer máquina e em qualquer execução. */
function hashEstavel(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}

/** Resultado simulado para um item — determinístico, sem aleatoriedade. */
export function resultadoSimulado(item) {
  const n = hashEstavel(item.campanhaId + '|' + item.contactoId) % 100;
  if (n < 72) return 'SENT';
  if (n < 84) return 'REPLIED';
  if (n < 93) return 'FAILED';
  return 'RATE_LIMITED';
}

/**
 * Processa a fila de uma campanha em SIMULAÇÃO, através do
 * MockInstagramProvider da Fase A. Nenhum pedido de rede acontece.
 *
 * @param {object} deps.provider  instância de MockInstagramProvider
 */
export async function simularProcessamento(estado, campanhaId, deps = {}) {
  const { provider, lote = 200, agora = () => new Date().toISOString() } = deps;
  if (!provider) throw new Error('simularProcessamento exige um MockInstagramProvider.');
  const k = estado.campanhas.find(x => x.id === campanhaId);
  if (!k) throw new Error('Campanha não encontrada.');
  if (k.status === CAMPAIGN_STATUS.CANCELLED) throw new Error('Campanha cancelada.');
  if (k.status === CAMPAIGN_STATUS.PAUSED) throw new Error('Campanha em pausa.');

  const porId = new Map(estado.contactos.map(c => [c.id, c]));
  const conta = estado.contas.find(c => c.id === k.contaId);
  const pendentes = estado.fila.filter(i => i.campanhaId === k.id && i.status === QUEUE_STATUS.PENDING).slice(0, lote);
  const resumo = { processados: 0, enviados: 0, falhas: 0, respostas: 0, limitados: 0 };

  k.status = CAMPAIGN_STATUS.RUNNING;

  for (const item of pendentes) {
    const contacto = porId.get(item.contactoId);
    if (!contacto) { item.status = QUEUE_STATUS.SKIPPED; item.erro = 'Contacto removido.'; continue; }

    const desfecho = resultadoSimulado(item);
    /* guiona o mock e deixa-o produzir a resposta normalizada */
    provider.script.porDestinatario = provider.script.porDestinatario || {};
    provider.script.porDestinatario[contacto.instagram] =
      desfecho === 'FAILED' ? 'RECIPIENT_UNAVAILABLE'
        : desfecho === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'ok';

    item.status = QUEUE_STATUS.PROCESSING;
    item.tentativas += 1;
    item.ultimaTentativa = agora();

    const r = await provider.sendMessage({
      account: conta,
      recipient: { username: contacto.instagram },
      message: resolverVariaveis(k.mensagem, contacto).texto,
      campaignId: k.id
    });
    resumo.processados += 1;

    if (r.success) {
      item.status = QUEUE_STATUS.SENT;
      item.providerMessageId = r.providerMessageId;
      item.erro = null;
      contacto.status = desfecho === 'REPLIED' ? CONTACT_STATUS.REPLIED : CONTACT_STATUS.SENT;
      contacto.ultimaAcao = item.ultimaTentativa;
      estado.mensagens.push({
        id: proximoId(estado, 'm'),
        contactoId: contacto.id, campanhaId: k.id, contaId: k.contaId,
        direcao: 'saida', texto: resolverVariaveis(k.mensagem, contacto).texto,
        estado: MESSAGE_STATUS.SENT, em: item.ultimaTentativa, simulado: true
      });
      resumo.enviados += 1;
      if (desfecho === 'REPLIED') {
        estado.mensagens.push({
          id: proximoId(estado, 'm'),
          contactoId: contacto.id, campanhaId: k.id, contaId: k.contaId,
          direcao: 'entrada', texto: '[resposta simulada] Obrigado pelo contacto.',
          estado: MESSAGE_STATUS.DELIVERED, em: item.ultimaTentativa, simulado: true
        });
        resumo.respostas += 1;
      }
    } else if (r.errorCode === 'RATE_LIMITED') {
      item.status = QUEUE_STATUS.PENDING;   /* fica para a passagem seguinte */
      item.erro = r.errorMessage;
      resumo.limitados += 1;
    } else {
      item.status = QUEUE_STATUS.FAILED;
      item.erro = r.errorMessage;
      contacto.ultimaAcao = item.ultimaTentativa;
      resumo.falhas += 1;
    }
  }

  const restam = estado.fila.some(i => i.campanhaId === k.id && i.status === QUEUE_STATUS.PENDING);
  k.status = restam ? CAMPAIGN_STATUS.RUNNING : CAMPAIGN_STATUS.COMPLETED;
  return resumo;
}

/* ---------------------------------------------------------------- *
 * KPIs                                                              *
 * ---------------------------------------------------------------- */

export function kpisCampanha(estado, campanhaId) {
  const itens = estado.fila.filter(i => i.campanhaId === campanhaId);
  const respostas = estado.mensagens.filter(m => m.campanhaId === campanhaId && m.direcao === 'entrada').length;
  return {
    total: itens.length,
    pendentes: itens.filter(i => i.status === QUEUE_STATUS.PENDING || i.status === QUEUE_STATUS.PAUSED).length,
    enviados: itens.filter(i => i.status === QUEUE_STATUS.SENT).length,
    falhas: itens.filter(i => i.status === QUEUE_STATUS.FAILED).length,
    ignorados: itens.filter(i => i.status === QUEUE_STATUS.SKIPPED).length,
    respostas
  };
}

export function kpisGerais(estado) {
  const ativas = [CAMPAIGN_STATUS.RUNNING, CAMPAIGN_STATUS.READY];
  return {
    contactos: estado.contactos.length,
    comInstagram: estado.contactos.filter(c => c.temInstagram).length,
    campanhas: estado.campanhas.length,
    ativas: estado.campanhas.filter(k => ativas.includes(k.status)).length,
    pendentes: estado.fila.filter(i => i.status === QUEUE_STATUS.PENDING || i.status === QUEUE_STATUS.PAUSED).length,
    enviados: estado.fila.filter(i => i.status === QUEUE_STATUS.SENT).length,
    falhas: estado.fila.filter(i => i.status === QUEUE_STATUS.FAILED).length,
    respostas: estado.mensagens.filter(m => m.direcao === 'entrada').length
  };
}

/**
 * LeadMap Pro — porta de entrada do Outreach (Fase D)
 * ===================================================
 * Decide o que a interface do Outreach mostra, e onde é que os dados
 * vivem. A lógica está aqui, fora do `index.html`, para poder ser
 * testada sem browser.
 *
 * A REGRA QUE MANDA EM TUDO (§17)
 * -------------------------------
 * Se o backend remoto falhar, **não** se volta ao armazenamento local.
 * Mostrar dados locais depois de o utilizador ter entrado numa conta é
 * mostrar-lhe uma realidade que não existe: ele acredita que está a ver
 * a base de dados, edita em cima disso, e as duas versões divergem em
 * silêncio. Um erro visível é sempre melhor do que dados errados com
 * ar de certos.
 *
 * O armazenamento local continua a existir, mas com um só papel: ser a
 * origem da migração e uma cópia de segurança do trabalho da Fase B.
 * Nunca é o estado ativo de uma sessão autenticada.
 */

import { analisarEstadoLocal, migrarParaRemoto } from './migrate-local.mjs';

/** Estados possíveis da área de Outreach. */
export const ESTADO_UI = Object.freeze({
  NAO_CONFIGURADO: 'NAO_CONFIGURADO',   /* backend sem auth configurada */
  SEM_BANCO:       'SEM_BANCO',         /* auth pronta, base de dados não */
  LOGIN:           'LOGIN',             /* falta autenticar */
  PRONTO:          'PRONTO',            /* autenticado e com banco */
  INDISPONIVEL:    'INDISPONIVEL'       /* o backend respondeu mal ou não respondeu */
});

/**
 * Traduz a resposta de `/api/outreach/session` num estado de interface.
 *
 * `erro` presente ganha sempre: se não se conseguiu falar com o
 * backend, não se sabe nada e não se inventa.
 */
export function decidirEstadoUI(estado, erro = null) {
  if (erro) return ESTADO_UI.INDISPONIVEL;
  const e = estado || {};
  if (!e.configured) return ESTADO_UI.NAO_CONFIGURADO;
  if (!e.authenticated) return ESTADO_UI.LOGIN;
  if (!e.databaseConfigured) return ESTADO_UI.SEM_BANCO;
  return ESTADO_UI.PRONTO;
}

/** Mensagem que o utilizador vê em cada estado. Nenhuma delas mente. */
export const MENSAGEM = Object.freeze({
  [ESTADO_UI.NAO_CONFIGURADO]: {
    titulo: 'Outreach ainda não configurado',
    texto: 'O backend do Outreach não tem autenticação configurada. Os dados que tem nesta máquina continuam guardados e podem ser migrados quando a configuração estiver feita.'
  },
  [ESTADO_UI.SEM_BANCO]: {
    titulo: 'Base de dados por configurar',
    texto: 'A autenticação está pronta, mas ainda não há base de dados ligada. Nada é gravado até isso acontecer.'
  },
  [ESTADO_UI.LOGIN]: {
    titulo: 'Entrar no Outreach',
    texto: 'Esta área é privada. A sessão fica num cookie que o JavaScript não consegue ler.'
  },
  [ESTADO_UI.INDISPONIVEL]: {
    titulo: 'Outreach temporariamente indisponível',
    texto: 'Não foi possível falar com o servidor. Os dados locais não são mostrados aqui de propósito: seriam diferentes dos que estão na base de dados.'
  }
});

/* ---------------------------------------------------------------- *
 * Sessão                                                            *
 * ---------------------------------------------------------------- */

export class SessaoOutreach {
  /**
   * @param {object} opts
   * @param {RemoteOutreachStore} opts.remoto
   */
  constructor({ remoto } = {}) {
    if (!remoto) throw new Error('SessaoOutreach exige um store remoto.');
    this.remoto = remoto;
    this.estado = ESTADO_UI.INDISPONIVEL;
    this.info = { configured: false, authenticated: false, databaseConfigured: false };
    this.erro = null;
  }

  get autenticado() { return this.estado === ESTADO_UI.PRONTO; }

  /** Pergunta ao backend em que pé estamos. Nunca lança. */
  async avaliar() {
    this.erro = null;
    try {
      this.info = await this.remoto.estado();
      /* `estado()` engole os erros e devolve tudo a false; distinguimos
         "respondeu que não está configurado" de "não respondeu" pelo
         erro que ele guarda */
      if (this.remoto.ultimoErro) { this.erro = this.remoto.ultimoErro; }
    } catch (err) {
      this.erro = (err && err.message) || 'sem resposta do servidor';
      this.info = { configured: false, authenticated: false, databaseConfigured: false };
    }
    this.estado = decidirEstadoUI(this.info, this.erro);
    return this.estado;
  }

  async entrar(email, password) {
    await this.remoto.entrar(email, password);
    return this.avaliar();
  }

  /** Sai da sessão. O estado local NÃO é apagado (§15). */
  async sair() {
    try { await this.remoto.sair(); } finally { await this.avaliar(); }
    return this.estado;
  }

  /**
   * Carrega o estado de trabalho **do servidor**.
   *
   * Se qualquer pedido falhar, devolve o erro e deixa o chamador sem
   * dados — nunca preenche com o que estiver em localStorage.
   */
  async hidratar({ limitePagina = 100 } = {}) {
    if (!this.autenticado) {
      const e = new Error('Sessão não autenticada.');
      e.errorCode = 'UNAUTHENTICATED';
      throw e;
    }
    const [contactos, templates, contas, campanhas, fila] = await Promise.all([
      this.remoto.listarContactos({ limit: limitePagina, offset: 0 }),
      this.remoto.listarTemplates({ limit: limitePagina, offset: 0 }),
      this.remoto.listarContas(),
      this.remoto.listarCampanhas({ limit: limitePagina, offset: 0 }),
      this.remoto.listarFila({ limit: limitePagina, offset: 0 })
    ]);
    return {
      remoto: true,
      contactos: contactos.items || [],
      totalContactos: contactos.total || 0,
      templates: templates.items || [],
      contas: contas.items || [],
      campanhas: campanhas.items || [],
      fila: fila.items || [],
      mensagens: []
    };
  }
}

/* ---------------------------------------------------------------- *
 * Migração local → remoto                                           *
 * ---------------------------------------------------------------- */

/** Estados de fila/mensagem que só podem ter vindo do fornecedor de teste. */
const FABRICADOS = ['SENT', 'DELIVERED', 'REPLIED', 'READ', 'FAILED'];

/**
 * Classifica o que há no armazenamento local antes de migrar (§27/§29).
 *
 * O objetivo não é contar tudo: é separar o que é trabalho verdadeiro
 * — contactos que a pessoa recolheu, textos que escreveu — do que é
 * resultado do fornecedor de teste. Um "enviado" fabricado migrado como
 * enviado transformava simulação em histórico de produção.
 */
export function preverMigracao(estadoLocal) {
  const e = estadoLocal || {};
  const base = analisarEstadoLocal(e);

  const contactos = Array.isArray(e.contactos) ? e.contactos : [];
  const campanhas = Array.isArray(e.campanhas) ? e.campanhas : [];
  const mensagens = Array.isArray(e.mensagens) ? e.mensagens : [];
  const fila = Array.isArray(e.fila) ? e.fila : [];

  const migraveis = contactos.filter(c => c.instagram || c.leadId);
  const semIdentidade = contactos.length - migraveis.length;
  const rascunhos = campanhas.filter(k => k.status === 'DRAFT' || k.status === 'READY');
  const jaCorreram = campanhas.filter(k => !['DRAFT', 'READY'].includes(k.status));
  const fabricadas = mensagens.filter(m => FABRICADOS.includes(String(m.status || '').toUpperCase()));

  return {
    migravel: {
      contactos: migraveis.length,
      templates: base.templates,
      campanhasDraft: rascunhos.length
    },
    ignorado: {
      /* simulação — nunca entra como atividade real */
      mensagensSimuladas: fabricadas.length,
      itensDeFila: fila.length,
      campanhasJaExecutadas: jaCorreram.length,
      /* legítimos, mas sem forma de os identificar na base de dados */
      contactosSemIdentidade: semIdentidade,
      /* contas locais são registos de teste; ligam-se de novo no backend */
      contas: base.contas
    },
    totalSimulacao: fabricadas.length + fila.length + jaCorreram.length,
    nada: migraveis.length === 0 && base.templates === 0 && rascunhos.length === 0
  };
}

/**
 * Executa a migração depois de o utilizador confirmar o resumo.
 *
 * `confirmado` não tem valor por omissão de propósito: quem chama tem
 * de dizer explicitamente que o utilizador viu o resumo e concordou.
 */
export async function executarMigracao(estadoLocal, remoto, { confirmado, incluirCampanhas = false } = {}) {
  if (confirmado !== true) {
    const e = new Error('A migração precisa de confirmação explícita.');
    e.errorCode = 'NOT_CONFIRMED';
    throw e;
  }
  const previsao = preverMigracao(estadoLocal);
  const resumo = await migrarParaRemoto(estadoLocal, remoto, { incluirCampanhas });
  /* o estado local fica intacto (§31): é a cópia de segurança */
  return { previsao, resumo, localApagado: false };
}

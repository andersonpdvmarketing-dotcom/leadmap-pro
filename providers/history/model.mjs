/**
 * LeadMap Pro — histórico de listas e registo global de capturas
 * ==============================================================
 * Lógica pura: não toca no DOM, não abre bases de dados, não lê o
 * relógio sem que lho passem. O armazenamento vive em store.mjs.
 *
 * O QUE "JÁ CAPTURADA" SIGNIFICA
 * ------------------------------
 * Uma lead está "já capturada" quando apareceu numa execução ANTERIOR.
 *
 * Encontrar a mesma empresa duas vezes DENTRO da mesma pesquisa — via
 * Google e OSM, ou em duas células da grelha — é deduplicação interna e
 * já foi resolvida antes de chegar aqui. Isso nunca conta como
 * repetição histórica: a classificação é feita contra o registo tal como
 * estava ANTES desta pesquisa, e só depois é que as capturas desta
 * execução entram no registo.
 */

import { chavesDeIdentidade } from './identity.mjs';

export const ESTADO_LEAD = Object.freeze({ NOVA: 'NOVA', JA_CAPTURADA: 'JA_CAPTURADA' });

export const ESTADO_PESQUISA = Object.freeze({
  CONCLUIDA: 'CONCLUIDA',
  PARCIAL: 'PARCIAL',
  CANCELADA: 'CANCELADA',
  FALHADA: 'FALHADA'
});

/* ---------------------------------------------------------------- *
 * Índice de identidade — lookup O(1)                                *
 * ---------------------------------------------------------------- */

/**
 * Índice em memória sobre o registo global. Uma lead pode ter várias
 * chaves (place, site, telefone, Instagram, nome+CP) e todas apontam
 * para o mesmo registo, para que a lead seja reconhecida mesmo que a
 * pesquisa seguinte só traga uma delas.
 *
 * A procura é por Map: O(1) por chave, nunca uma varredura do histórico.
 */
export class IndiceCapturas {
  constructor(registoInicial) {
    this.porChave = new Map();
    this.registos = new Map();          /* idRegisto → registo */
    if (registoInicial) this.carregar(registoInicial);
  }

  carregar(mapaOuLinhas) {
    const linhas = mapaOuLinhas instanceof Map ? [...mapaOuLinhas.values()] : (mapaOuLinhas || []);
    for (const linha of linhas) {
      if (!linha || !linha.chave) continue;
      this.porChave.set(linha.chave, linha.registoId);
      const existente = this.registos.get(linha.registoId);
      if (!existente || String(linha.lastCapturedAt || '') > String(existente.lastCapturedAt || '')) {
        this.registos.set(linha.registoId, {
          registoId: linha.registoId,
          firstCapturedAt: linha.firstCapturedAt,
          firstSearchId: linha.firstSearchId,
          lastCapturedAt: linha.lastCapturedAt,
          lastSearchId: linha.lastSearchId,
          captureCount: linha.captureCount
        });
      }
    }
    return this;
  }

  /** Registo de captura de uma lead, ou null se nunca foi vista. */
  procurar(lead) {
    for (const chave of chavesDeIdentidade(lead)) {
      const id = this.porChave.get(chave);
      if (id) return this.registos.get(id) || null;
    }
    return null;
  }

  get tamanho() { return this.registos.size; }
}

/* ---------------------------------------------------------------- *
 * CapturedLeadRegistry                                              *
 * ---------------------------------------------------------------- */

/**
 * Registo global das leads que já passaram pela plataforma.
 *
 * É a estrutura B do §17: distinta do histórico de listas. Apagar uma
 * lista não lhe toca — só `limpar()`, que é uma ação explícita do
 * utilizador. A UI fala com esta classe e nunca com IndexedDB.
 */
export class CapturedLeadRegistry {
  /** @param {object} store  LeadHistoryStore (opcional; sem ele fica em memória) */
  constructor(store) {
    this.store = store || null;
    this.indice = new IndiceCapturas();
    this.carregado = false;
  }

  async carregar() {
    if (this.store) this.indice = new IndiceCapturas(await this.store.carregarRegisto());
    this.carregado = true;
    return this;
  }

  /** Classifica sem alterar nada — o registo só muda em `confirmar()`. */
  classificar(leads, searchId, opts = {}) {
    return classificarLeads(leads, this.indice, { searchId, ...opts });
  }

  /** Persiste as capturas de uma execução já concluída. */
  async confirmar(resultado) {
    if (!resultado || !resultado.linhas) return;
    this.indice.carregar(resultado.linhas);
    if (this.store) await this.store.guardarRegistos(resultado.linhas);
  }

  procurar(lead) { return this.indice.procurar(lead); }
  get tamanho() { return this.indice.tamanho; }

  /** Ação destrutiva e separada de apagar listas (§17). */
  async limpar() {
    this.indice = new IndiceCapturas();
    if (this.store) await this.store.limparRegistoGlobal();
  }
}

/* ---------------------------------------------------------------- *
 * Classificação                                                     *
 * ---------------------------------------------------------------- */

/**
 * Classifica as leads de UMA execução contra o índice, e devolve as
 * linhas de registo a persistir. Não altera o índice recebido enquanto
 * classifica — as leads desta execução só passam a contar como
 * capturadas depois de a pesquisa terminar.
 *
 * @returns {{leads, novas, jaCapturadas, linhas}}
 */
export function classificarLeads(leads, indice, { searchId, agora = () => new Date().toISOString() } = {}) {
  const quando = agora();
  const linhas = [];
  const vistasNestaExecucao = new Map();   /* chave → registoId, para o caso raro
                                              de o dedupe interno deixar passar */
  let novas = 0, jaCapturadas = 0;

  const saida = (leads || []).map(lead => {
    const chaves = chavesDeIdentidade(lead);
    let registo = indice.procurar(lead);

    /* já apareceu nesta mesma execução? continua a ser a mesma lead
       nova — nunca "já capturada" (ver nota no topo) */
    if (!registo) {
      for (const c of chaves) {
        const id = vistasNestaExecucao.get(c);
        if (id) { registo = { registoId: id, novaNestaExecucao: true }; break; }
      }
    }

    if (registo && !registo.novaNestaExecucao) {
      jaCapturadas += 1;
      const atualizado = {
        registoId: registo.registoId,
        firstCapturedAt: registo.firstCapturedAt,
        firstSearchId: registo.firstSearchId,
        lastCapturedAt: quando,
        lastSearchId: searchId,
        captureCount: (Number(registo.captureCount) || 1) + 1
      };
      for (const c of chaves) {
        linhas.push({ chave: c, ...atualizado });
        vistasNestaExecucao.set(c, atualizado.registoId);
      }
      return {
        ...lead,
        historico: {
          estado: ESTADO_LEAD.JA_CAPTURADA,
          firstCapturedAt: atualizado.firstCapturedAt,
          firstSearchId: atualizado.firstSearchId,
          lastCapturedAt: atualizado.lastCapturedAt,
          captureCount: atualizado.captureCount
        }
      };
    }

    /* lead nova (ou repetição interna desta mesma execução) */
    const registoId = registo && registo.registoId ? registo.registoId : (chaves[0] || ('lead:' + (lead.id || Math.abs(hash(String(lead.nome || ''))))));
    if (!registo) novas += 1;
    const novoRegisto = {
      registoId,
      firstCapturedAt: quando,
      firstSearchId: searchId,
      lastCapturedAt: quando,
      lastSearchId: searchId,
      captureCount: 1
    };
    for (const c of chaves) {
      linhas.push({ chave: c, ...novoRegisto });
      vistasNestaExecucao.set(c, registoId);
    }
    return {
      ...lead,
      historico: {
        estado: ESTADO_LEAD.NOVA,
        firstCapturedAt: quando,
        firstSearchId: searchId,
        lastCapturedAt: quando,
        captureCount: 1
      }
    };
  });

  return { leads: saida, novas, jaCapturadas, linhas };
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* ---------------------------------------------------------------- *
 * Nome e metadados da lista                                         *
 * ---------------------------------------------------------------- */

const ND = 'N/D';

function dataCurta(iso) {
  const d = iso ? new Date(iso) : new Date();
  const p = n => String(n).padStart(2, '0');
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
}

/**
 * Nome legível gerado automaticamente.
 *   "Eletricistas — Lisboa — 30 km — 01/09/2026"
 *   "Arquitetos — Portugal — 01/09/2026"
 */
export function nomeAutomatico({ query, modo, localizacao, raioKm, criadaEm }) {
  const partes = [];
  const q = String(query || '').trim();
  partes.push(q ? q.charAt(0).toUpperCase() + q.slice(1) : 'Pesquisa');
  if (modo === 'portugal') {
    partes.push('Portugal');
  } else {
    if (localizacao) partes.push(localizacao);
    if (raioKm) partes.push(raioKm + ' km');
  }
  partes.push(dataCurta(criadaEm));
  return partes.join(' — ');
}

/** Resumo de contactabilidade de uma lista, calculado das leads reais. */
export function contarCobertura(leads) {
  const tem = (l, campo) => l[campo] && l[campo] !== ND;
  return {
    comEmail: leads.filter(l => (l.emails && l.emails.length) || tem(l, 'email')).length,
    comTelefone: leads.filter(l => tem(l, 'telefone') || tem(l, 'telemovel')).length,
    comWebsite: leads.filter(l => tem(l, 'website')).length,
    comInstagram: leads.filter(l => tem(l, 'instagram')).length
  };
}

/** Constrói o registo de histórico de uma pesquisa concluída. */
export function registoDePesquisa({
  id, historyId, searchId, criadaEm, modo, query, localizacao, raioKm, distrito, concelho,
  fontes, totalBruto, leads, novas, jaCapturadas, estado, lat, lon
}) {
  const cobertura = contarCobertura(leads || []);
  const sid = searchId || id;
  return {
    /* `historyId` identifica a GERAÇÃO (a entrada do histórico);
       `searchId` identifica a EXECUÇÃO que a produziu. Repetir uma
       pesquisa cria ambos novos, sem tocar na geração anterior. */
    historyId: historyId || sid,
    searchId: sid,
    id: historyId || sid,
    nome: nomeAutomatico({ query, modo, localizacao, raioKm, criadaEm }),
    nomeAutomatico: true,
    criadaEm,
    modo: modo || 'local',
    query: query || '',
    localizacao: localizacao || null,
    raioKm: raioKm || null,
    distrito: distrito || null,
    concelho: concelho || null,
    fontes: Array.isArray(fontes) ? fontes : (fontes ? [fontes] : []),
    /* guardado para o botão Repetir poder reconstruir a pesquisa */
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    totalBruto: Number(totalBruto) || (leads ? leads.length : 0),
    totalFinal: leads ? leads.length : 0,
    novas: Number(novas) || 0,
    jaCapturadas: Number(jaCapturadas) || 0,
    ...cobertura,
    estado: ESTADO_PESQUISA[estado] || ESTADO_PESQUISA.CONCLUIDA
  };
}

/** Renomear uma lista: passa a nome próprio, deixa de ser automático. */
export function renomear(meta, novoNome) {
  const n = String(novoNome || '').trim();
  if (!n) throw new Error('Indique um nome para a lista.');
  return { ...meta, nome: n, nomeAutomatico: false };
}

/**
 * LeadMap Pro — LeadHistoryStore
 * ==============================
 * Guarda o histórico de listas geradas e o registo global de capturas.
 *
 * PORQUÊ IndexedDB E NÃO localStorage
 * -----------------------------------
 * Medido com leads reais desta aplicação: ~835 bytes por lead.
 *
 *     100 leads →   82 KB
 *    1000 leads →  816 KB
 *    3000 leads → 2,39 MB
 *
 * A quota de localStorage medida no browser ronda os 15 MB. Seis listas
 * de 3000 leads esgotam-na, e uma única pesquisa nacional de 10 000
 * leads ocupa ~8 MB sozinha. Guardar snapshots em localStorage acabaria
 * em erro de quota — e a pior versão disso seria perder listas em
 * silêncio. Por isso os snapshots vivem em IndexedDB.
 *
 * Se o IndexedDB não estiver disponível, o histórico continua a
 * funcionar em memória durante a sessão e `avisoPersistencia` explica o
 * que não vai ser guardado. Nada é descartado às escondidas.
 *
 * DUAS COISAS DIFERENTES, DE PROPÓSITO (ver §25 do pedido)
 * --------------------------------------------------------
 *   · histórico de listas   — o que foi pesquisado e os seus snapshots
 *   · registo global        — que leads já passaram pela plataforma
 *
 * Apagar uma lista NÃO apaga o registo global. Se apagasse, uma lead
 * capturada há meses voltaria a aparecer como "nova" só porque se
 * arrumou uma lista antiga — que é exatamente o contrário do que este
 * mecanismo existe para fazer. Limpar o registo global é uma ação
 * separada e explícita.
 */

export const DB_NOME = 'leadmap_history_v1';
export const DB_VERSAO = 1;
export const LOJA_PESQUISAS = 'pesquisas';
export const LOJA_SNAPSHOTS = 'snapshots';
export const LOJA_REGISTO = 'registo';

/* ---------------------------------------------------------------- *
 * Backends                                                          *
 * ---------------------------------------------------------------- */

/** Backend em memória — usado nos testes e quando não há IndexedDB. */
export class MemoryBackend {
  constructor() { this.lojas = new Map(); this.persistente = false; }
  loja(nome) {
    if (!this.lojas.has(nome)) this.lojas.set(nome, new Map());
    return this.lojas.get(nome);
  }
  async get(nome, chave) { const v = this.loja(nome).get(chave); return v === undefined ? null : v; }
  async put(nome, chave, valor) { this.loja(nome).set(chave, valor); }
  async putMuitos(nome, pares) { for (const [k, v] of pares) this.loja(nome).set(k, v); }
  async delete(nome, chave) { this.loja(nome).delete(chave); }
  async todos(nome) { return [...this.loja(nome).values()]; }
  async limpar(nome) { this.loja(nome).clear(); }
}

/** Backend IndexedDB — o normal no browser. */
export class IndexedDBBackend {
  constructor(idb) {
    this.idb = idb || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    this.db = null;
    this.persistente = true;
  }
  static disponivel(idb) { return Boolean(idb || (typeof indexedDB !== 'undefined' ? indexedDB : null)); }

  abrir() {
    if (this.db) return Promise.resolve(this.db);
    if (!this.idb) return Promise.reject(new Error('IndexedDB indisponível.'));
    return new Promise((resolve, reject) => {
      const pedido = this.idb.open(DB_NOME, DB_VERSAO);
      pedido.onupgradeneeded = () => {
        const db = pedido.result;
        for (const nome of [LOJA_PESQUISAS, LOJA_SNAPSHOTS, LOJA_REGISTO]) {
          if (!db.objectStoreNames.contains(nome)) db.createObjectStore(nome);
        }
      };
      pedido.onsuccess = () => { this.db = pedido.result; resolve(this.db); };
      pedido.onerror = () => reject(pedido.error || new Error('Falha ao abrir IndexedDB.'));
    });
  }

  async transacao(nome, modo, fn) {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(nome, modo);
      const loja = tx.objectStore(nome);
      let resultado;
      try { resultado = fn(loja); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(resultado && resultado.result !== undefined ? resultado.result : resultado);
      tx.onerror = () => reject(tx.error || new Error('Transação falhou.'));
      tx.onabort = () => reject(tx.error || new Error('Transação abortada.'));
    });
  }

  async get(nome, chave) {
    const r = await this.transacao(nome, 'readonly', loja => loja.get(chave));
    return r === undefined ? null : r;
  }
  async put(nome, chave, valor) { await this.transacao(nome, 'readwrite', loja => loja.put(valor, chave)); }
  async putMuitos(nome, pares) {
    await this.transacao(nome, 'readwrite', loja => { for (const [k, v] of pares) loja.put(v, k); });
  }
  async delete(nome, chave) { await this.transacao(nome, 'readwrite', loja => loja.delete(chave)); }
  async todos(nome) { return (await this.transacao(nome, 'readonly', loja => loja.getAll())) || []; }
  async limpar(nome) { await this.transacao(nome, 'readwrite', loja => loja.clear()); }
}

/* ---------------------------------------------------------------- *
 * Contrato                                                          *
 * ---------------------------------------------------------------- */

export class LeadHistoryStore {
  async iniciar() { throw new Error('iniciar() não implementado.'); }
  async listarPesquisas() { throw new Error('listarPesquisas() não implementado.'); }
  async guardarPesquisa() { throw new Error('guardarPesquisa() não implementado.'); }
  async apagarPesquisa() { throw new Error('apagarPesquisa() não implementado.'); }
  async lerSnapshot() { throw new Error('lerSnapshot() não implementado.'); }
  async carregarRegisto() { throw new Error('carregarRegisto() não implementado.'); }
  async limparRegistoGlobal() { throw new Error('limparRegistoGlobal() não implementado.'); }
}

/* ---------------------------------------------------------------- *
 * Implementação local                                               *
 * ---------------------------------------------------------------- */

export class LocalLeadHistoryStore extends LeadHistoryStore {
  /**
   * @param {object} opts
   * @param {object} opts.backend  IndexedDBBackend, MemoryBackend ou compatível
   */
  constructor({ backend } = {}) {
    super();
    this.backend = backend || (IndexedDBBackend.disponivel() ? new IndexedDBBackend() : new MemoryBackend());
    this.avisoPersistencia = null;
    this.pronto = false;
  }

  async iniciar() {
    if (this.backend instanceof IndexedDBBackend) {
      try { await this.backend.abrir(); }
      catch (err) {
        /* nunca falhar em silêncio: troca-se para memória e diz-se porquê */
        this.backend = new MemoryBackend();
        this.avisoPersistencia =
          'O histórico não vai ser guardado neste browser (' + (err.message || 'IndexedDB indisponível') +
          '). As listas desta sessão continuam disponíveis até fechar o separador.';
      }
    } else if (!this.backend.persistente) {
      this.avisoPersistencia = 'Histórico apenas em memória: não persiste entre sessões.';
    }
    this.pronto = true;
    return this;
  }

  /* ---------- pesquisas (metadados, sem leads) ---------- */

  async listarPesquisas() {
    const todas = await this.backend.todos(LOJA_PESQUISAS);
    return todas.sort((a, b) => String(b.criadaEm || '').localeCompare(String(a.criadaEm || '')));
  }

  async guardarPesquisa(meta) {
    if (!meta || !meta.id) throw new Error('Pesquisa sem id.');
    await this.backend.put(LOJA_PESQUISAS, meta.id, meta);
    return meta;
  }

  /**
   * Apaga uma lista e o seu snapshot. NÃO toca no registo global — ver
   * a nota no topo deste ficheiro.
   */
  async apagarPesquisa(id) {
    await this.backend.delete(LOJA_PESQUISAS, id);
    await this.backend.delete(LOJA_SNAPSHOTS, id);
    return true;
  }

  /* ---------- snapshots ---------- */

  async guardarSnapshot(id, leads) {
    await this.backend.put(LOJA_SNAPSHOTS, id, { id, leads, guardadoEm: new Date().toISOString() });
  }

  async lerSnapshot(id) {
    const s = await this.backend.get(LOJA_SNAPSHOTS, id);
    return s && Array.isArray(s.leads) ? s.leads : null;
  }

  /* ---------- registo global de capturas ---------- */

  /** Devolve um Map chave-de-identidade → registo de captura. */
  async carregarRegisto() {
    const linhas = await this.backend.todos(LOJA_REGISTO);
    const mapa = new Map();
    for (const l of linhas) {
      if (!l || !l.chave) continue;
      mapa.set(l.chave, l);
    }
    return mapa;
  }

  async guardarRegistos(linhas) {
    if (!linhas || !linhas.length) return;
    await this.backend.putMuitos(LOJA_REGISTO, linhas.map(l => [l.chave, l]));
  }

  /** Ação destrutiva e separada: só é chamada com confirmação explícita. */
  async limparRegistoGlobal() {
    await this.backend.limpar(LOJA_REGISTO);
    return true;
  }

  async limparTudo() {
    for (const loja of [LOJA_PESQUISAS, LOJA_SNAPSHOTS, LOJA_REGISTO]) await this.backend.limpar(loja);
    return true;
  }

  /** Tamanho aproximado ocupado, para mostrar ao utilizador. */
  async estatisticas() {
    const pesquisas = await this.backend.todos(LOJA_PESQUISAS);
    const snapshots = await this.backend.todos(LOJA_SNAPSHOTS);
    const registo = await this.backend.todos(LOJA_REGISTO);
    let bytes = 0;
    for (const s of snapshots) bytes += JSON.stringify(s).length;
    return {
      pesquisas: pesquisas.length,
      snapshots: snapshots.length,
      leadsNoRegisto: registo.length,
      bytesSnapshots: bytes,
      persistente: this.backend.persistente !== false
    };
  }
}

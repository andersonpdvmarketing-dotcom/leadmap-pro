/**
 * LeadMap Pro — OutreachStore
 * ===========================
 *
 * TEMPORARY / NOT PRODUCTION PERSISTENCE
 * --------------------------------------
 * `LocalOutreachStore` guarda o estado do Outreach em `localStorage`, numa
 * única chave versionada (`leadmap_outreach_v1`). É armazenamento de
 * simulação: vive no browser de uma pessoa, não é partilhado, não tem
 * transações e desaparece com a limpeza do site. A persistência real
 * pertence à Fase C.
 *
 * Todo o acesso a `localStorage` passa por aqui — nenhuma outra parte do
 * sistema lhe toca diretamente. Trocar de armazenamento é implementar
 * `OutreachStore` outra vez.
 *
 * SEGREDOS: `save()` recusa gravar qualquer campo com aspeto de
 * credencial (password, token, cookie, apiKey…), a qualquer profundidade
 * e dentro de arrays. O estado local nunca contém segredos — e isso é
 * verificado em vez de prometido.
 */

export const CHAVE_ARMAZENAMENTO = 'leadmap_outreach_v1';
export const VERSAO_ESTADO = 2;

/* ---------------------------------------------------------------- *
 * Segredos proibidos no estado local                                *
 * ---------------------------------------------------------------- */

const CHAVES_SECRETAS = [
  'password', 'passwd', 'pwd', 'token', 'accesstoken', 'refreshtoken',
  'idtoken', 'sessiontoken', 'cookie', 'cookies', 'session', 'sessionid',
  'apikey', 'api_key', 'clientsecret', 'appsecret', 'secret',
  'authorization', 'bearer', 'credential', 'credentials', 'privatekey'
];

function pareceSegredo(chave) {
  const k = String(chave).toLowerCase().replace(/[_\-\s]/g, '');
  return CHAVES_SECRETAS.some(s => k === s.replace(/[_\-]/g, ''));
}

/**
 * Encontra caminhos de campos com aspeto de credencial. Percorre objetos
 * E arrays: um token escondido dentro de uma lista conta na mesma.
 */
export function encontrarSegredos(valor, prefixo = '', prof = 0, achados = []) {
  if (valor == null || typeof valor !== 'object' || prof > 8) return achados;
  if (Array.isArray(valor)) {
    valor.forEach((v, i) => encontrarSegredos(v, prefixo + '[' + i + ']', prof + 1, achados));
    return achados;
  }
  for (const [k, v] of Object.entries(valor)) {
    const caminho = prefixo ? prefixo + '.' + k : k;
    if (pareceSegredo(k)) achados.push(caminho);
    else if (v && typeof v === 'object') encontrarSegredos(v, caminho, prof + 1, achados);
  }
  return achados;
}

/** Devolve uma cópia sem nenhum campo com aspeto de credencial. */
export function removerSegredos(valor, prof = 0) {
  if (valor == null || typeof valor !== 'object' || prof > 8) return valor;
  if (Array.isArray(valor)) return valor.map(v => removerSegredos(v, prof + 1));
  const saida = {};
  for (const [k, v] of Object.entries(valor)) {
    if (pareceSegredo(k)) continue;                      /* simplesmente não entra */
    saida[k] = (v && typeof v === 'object') ? removerSegredos(v, prof + 1) : v;
  }
  return saida;
}

/* ---------------------------------------------------------------- *
 * Armazenamento em memória (testes e ambientes sem localStorage)    *
 * ---------------------------------------------------------------- */

export class MemoryStorage {
  constructor(inicial = {}) { this.dados = new Map(Object.entries(inicial)); }
  getItem(k) { return this.dados.has(k) ? this.dados.get(k) : null; }
  setItem(k, v) { this.dados.set(k, String(v)); }
  removeItem(k) { this.dados.delete(k); }
}

/* ---------------------------------------------------------------- *
 * Contrato                                                          *
 * ---------------------------------------------------------------- */

export class OutreachStore {
  load() { throw new Error('load() não implementado.'); }
  save() { throw new Error('save() não implementado.'); }
  clear() { throw new Error('clear() não implementado.'); }
  migrate(bruto) { return bruto; }
}

/* ---------------------------------------------------------------- *
 * Implementação local — TEMPORARY / NOT PRODUCTION PERSISTENCE      *
 * ---------------------------------------------------------------- */

export class LocalOutreachStore extends OutreachStore {
  /**
   * @param {object} opts
   * @param {Storage} opts.storage  localStorage ou compatível (getItem/setItem/removeItem)
   * @param {string}  opts.chave
   * @param {Function} opts.estadoInicial  fábrica do estado vazio
   */
  constructor({ storage, chave = CHAVE_ARMAZENAMENTO, estadoInicial } = {}) {
    super();
    this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : new MemoryStorage());
    this.chave = chave;
    this.estadoInicial = estadoInicial || (() => ({ versao: VERSAO_ESTADO }));
    this.ultimoErro = null;
  }

  /** Nunca lança: um estado corrompido devolve estado limpo, não um ecrã em branco. */
  load() {
    this.ultimoErro = null;
    let bruto = null;
    try { bruto = this.storage.getItem(this.chave); }
    catch (e) { this.ultimoErro = 'leitura: ' + e.message; return this.estadoInicial(); }
    if (!bruto) return this.estadoInicial();
    let dados;
    try { dados = JSON.parse(bruto); }
    catch (e) { this.ultimoErro = 'JSON inválido'; return this.estadoInicial(); }
    if (!dados || typeof dados !== 'object') return this.estadoInicial();
    try { return this.migrate(dados); }
    catch (e) { this.ultimoErro = 'migração: ' + e.message; return this.estadoInicial(); }
  }

  /**
   * Grava. Os segredos são removidos antes de tocar no armazenamento —
   * a proteção está no caminho de escrita, não numa convenção.
   */
  save(estado) {
    const limpo = removerSegredos({ ...estado, versao: VERSAO_ESTADO });
    const restantes = encontrarSegredos(limpo);
    if (restantes.length) {
      throw new Error('Recusado: o estado ainda contém campos secretos (' + restantes.join(', ') + ').');
    }
    try {
      this.storage.setItem(this.chave, JSON.stringify(limpo));
      this.ultimoErro = null;
      return limpo;
    } catch (e) {
      /* quota cheia ou modo privado: o Outreach continua a funcionar em
         memória; só avisa que não persistiu */
      this.ultimoErro = 'escrita: ' + e.message;
      return limpo;
    }
  }

  clear() {
    try { this.storage.removeItem(this.chave); this.ultimoErro = null; }
    catch (e) { this.ultimoErro = 'limpeza: ' + e.message; }
    return this.estadoInicial();
  }

  /**
   * Migração entre versões do estado.
   *
   * v1 → v2: a v1 podia conter resultados de envio produzidos por um
   * fornecedor de teste. Mostrar "Enviado"/"Respondido" sem que uma
   * mensagem real tenha saído seria inventar atividade, por isso esses
   * resultados são limpos. Contactos, contas, templates e campanhas —
   * o trabalho real do utilizador — são preservados na íntegra.
   */
  migrate(bruto) {
    let dados = bruto;
    const versao = Number(dados.versao) || 0;
    if (versao > VERSAO_ESTADO) {
      /* estado de uma versão mais recente da app: não adivinhar o formato */
      throw new Error('estado da versão ' + versao + ' é mais recente do que esta app (v' + VERSAO_ESTADO + ')');
    }
    if (versao < 1) {
      dados = { ...this.estadoInicial(), ...dados, versao: 1 };
    }
    if (versao < 2) {
      dados.mensagens = [];
      if (Array.isArray(dados.fila)) {
        for (const item of dados.fila) {
          if (item && (item.status === 'SENT' || item.status === 'FAILED' || item.status === 'PROCESSING')) {
            item.status = 'PENDING';
            item.tentativas = 0;
            item.ultimaTentativa = null;
            item.erro = null;
            item.providerMessageId = null;
          }
        }
      }
      if (Array.isArray(dados.contactos)) {
        for (const c of dados.contactos) {
          if (c && (c.status === 'SENT' || c.status === 'REPLIED')) { c.status = 'UNKNOWN'; c.ultimaAcao = null; }
        }
      }
      if (Array.isArray(dados.campanhas)) {
        for (const k of dados.campanhas) {
          if (k && (k.status === 'COMPLETED' || k.status === 'RUNNING')) k.status = 'READY';
        }
      }
      dados.versao = 2;
    }
    /* garante a forma mínima mesmo com um estado truncado */
    const base = this.estadoInicial();
    for (const k of Object.keys(base)) {
      if (dados[k] === undefined) dados[k] = base[k];
      else if (Array.isArray(base[k]) && !Array.isArray(dados[k])) dados[k] = base[k];
    }
    dados.versao = VERSAO_ESTADO;
    return dados;
  }
}

/**
 * LeadMap Pro — auditoria de Outreach
 * ===================================
 * Regista quem enviou o quê, por que fornecedor e com que resultado (§17).
 *
 * NUNCA guarda tokens, API keys nem qualquer credencial: cada entrada
 * passa por `redigir()` antes de ser gravada, e os campos aceites são
 * uma lista fechada — um campo novo com um token dentro não entra por
 * acidente.
 *
 * A implementação por omissão é em memória. Para produção, injetar um
 * `sink` (base de dados, ficheiro, serviço de logs) com o mesmo método
 * `escrever(entrada)`; a redação já foi feita antes de o sink ver algo.
 */

import { redigir } from './contract.mjs';

const CAMPOS = [
  'provider', 'accountId', 'username', 'campaignId', 'recipient',
  'providerMessageId', 'status', 'errorCode', 'errorMessage', 'tentativa'
];

export class OutreachAudit {
  /**
   * @param {object} opts
   * @param {{escrever: Function}} opts.sink  destino externo (opcional)
   * @param {Function} opts.now
   * @param {number} opts.maxEmMemoria
   */
  constructor({ sink = null, now = () => new Date().toISOString(), maxEmMemoria = 5000 } = {}) {
    this.sink = sink;
    this.now = now;
    this.maxEmMemoria = maxEmMemoria;
    this.entradas = [];
  }

  registar(bruta = {}) {
    const entrada = { timestamp: this.now() };
    for (const c of CAMPOS) {
      entrada[c] = bruta[c] !== undefined ? bruta[c] : null;
    }
    /* dupla proteção: lista fechada de campos + redação de segredos */
    const segura = redigir(entrada);
    this.entradas.push(segura);
    if (this.entradas.length > this.maxEmMemoria) {
      this.entradas.splice(0, this.entradas.length - this.maxEmMemoria);
    }
    if (this.sink && typeof this.sink.escrever === 'function') {
      try { this.sink.escrever(segura); } catch (e) { /* a auditoria nunca derruba o envio */ }
    }
    return segura;
  }

  listar(filtro = {}) {
    return this.entradas.filter(e => {
      for (const [k, v] of Object.entries(filtro)) {
        if (v != null && e[k] !== v) return false;
      }
      return true;
    });
  }

  /** Contagem por resultado, para o painel da campanha. */
  resumoPorCampanha(campaignId) {
    const linhas = this.listar({ campaignId });
    const porEstado = {};
    for (const l of linhas) porEstado[l.status] = (porEstado[l.status] || 0) + 1;
    return { campaignId, total: linhas.length, porEstado };
  }
}

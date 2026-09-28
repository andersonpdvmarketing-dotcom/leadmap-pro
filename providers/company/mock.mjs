/**
 * LeadMap Pro — fornecedor empresarial de simulação
 * =================================================
 * Existe para os testes e para exercitar o router sem contratar nada.
 * Não faz pedidos de rede. Responde a partir de um mapa dado na
 * construção, por NIF ou por domínio.
 *
 * NUNCA EM PRODUÇÃO
 * -----------------
 * `mockPermitido()` guarda esta porta no lado do Instagram; aqui o mock
 * nem sequer é registado quando o ambiente é produção (ver registry.mjs).
 * Dados empresariais inventados a aparecer num ecrã de vendas seriam
 * indistinguíveis de dados reais — e alguém decidiria com eles.
 */

import { CompanyEnrichmentProvider } from './base.mjs';
import { CAMPOS, ESTADO_DADO, envelope, CompanyProviderError } from './contract.mjs';

export class MockCompanyProvider extends CompanyEnrichmentProvider {
  /**
   * @param {object} opts
   * @param {object} [opts.dados]   chave (nif ou domínio) → { campo: {valor, estado, ...} }
   * @param {boolean} [opts.configurado]
   */
  constructor({ dados = {}, campos = CAMPOS, configurado = true, id = 'mock' } = {}) {
    super({ id, nome: 'Simulação', campos });
    this.dados = dados;
    this.configurado = configurado === true;
    this.chamadas = [];            /* os testes verificam que não houve pedidos a mais */
  }

  isConfigured() { return this.configurado; }

  async _consultar({ nif, dominio, nome }) {
    this.chamadas.push({ nif, dominio, nome });
    const chave = (nif && this.dados[nif]) ? nif : (dominio && this.dados[dominio]) ? dominio : null;
    if (!chave) {
      return { success: true, empresa: this.nadaEncontrado() };
    }
    const bruto = this.dados[chave];
    const empresa = this.nadaEncontrado();
    const agora = new Date().toISOString();
    for (const c of CAMPOS) {
      if (!bruto[c]) continue;
      if (!this.suporta(c)) {
        throw new CompanyProviderError('INVALID_DATA',
          'Mock configurado para devolver "' + c + '", que não declara suportar.');
      }
      const v = bruto[c];
      empresa[c] = envelope({
        valor: v.valor,
        fonte: v.fonte || ('mock:' + chave),
        consultadoEm: v.consultadoEm || agora,
        confianca: v.confianca != null ? v.confianca : 1,
        estado: v.estado || ESTADO_DADO.CONFIRMADO
      });
    }
    return { success: true, empresa };
  }
}

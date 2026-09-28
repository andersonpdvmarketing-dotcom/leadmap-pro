/**
 * LeadMap Pro — CompanyEnrichmentProvider (classe base)
 * =====================================================
 * O que um fornecedor de dados empresariais tem de implementar. Esta
 * classe não fala com a rede: define a forma, valida a entrada e garante
 * que a saída cumpre o contrato, mesmo quando o adapter é descuidado.
 *
 * PORQUE A VALIDAÇÃO ESTÁ AQUI E NÃO EM CADA ADAPTER
 * --------------------------------------------------
 * Um adapter que devolva `{ funcionarios: 30 }` em vez de um envelope
 * está a transformar um número sem proveniência num facto. Se cada
 * adapter fosse responsável por se disciplinar, bastava um distraído para
 * o ecrã passar a mentir. `consultar()` é final: chama `_consultar()` do
 * adapter e faz a resposta passar pelo contrato antes de a devolver.
 */

import {
  CAMPOS, CompanyProviderError, respostaConsulta, semDadosEmpresa, naoEncontrado
} from './contract.mjs';

export class CompanyEnrichmentProvider {
  /**
   * @param {object} opts
   * @param {string} opts.id          identificador do fornecedor
   * @param {string} [opts.nome]      nome legível
   * @param {string[]} [opts.campos]  campos que este fornecedor sabe responder
   */
  constructor({ id, nome = null, campos = [] } = {}) {
    if (!id) throw new CompanyProviderError('INVALID_REQUEST', 'Um fornecedor tem de ter id.');
    const desconhecidos = campos.filter(c => !CAMPOS.includes(c));
    if (desconhecidos.length) {
      throw new CompanyProviderError('INVALID_REQUEST',
        'Campos desconhecidos: ' + desconhecidos.join(', ') + '. Conhecidos: ' + CAMPOS.join(', ') + '.');
    }
    this.id = id;
    this.nome = nome || id;
    this.campos = Object.freeze([...campos]);
  }

  /** Está pronto a ser usado? Um fornecedor sem credenciais diz que não. */
  isConfigured() { return false; }

  /** Sabe responder a este campo? A UI usa isto para não prometer o que não há. */
  suporta(campo) { return this.campos.includes(campo); }

  /**
   * Consulta uma empresa. Ponto de entrada único e final.
   *
   * @param {object} chaves  { nif, dominio, nome, morada } — o que se souber
   */
  async consultar(chaves = {}) {
    const { nif = null, dominio = null, nome = null } = chaves || {};
    if (!nif && !dominio && !nome) {
      throw new CompanyProviderError('NO_LOOKUP_KEY',
        'Sem NIF, domínio ou nome não há por onde procurar.');
    }
    if (!this.isConfigured()) {
      throw new CompanyProviderError('PROVIDER_NOT_CONFIGURED',
        'Fornecedor "' + this.id + '" não está configurado.');
    }
    const bruto = await this._consultar({ nif, dominio, nome, ...chaves });
    /* a resposta do adapter volta a passar pelo contrato, sempre */
    return respostaConsulta({ ...bruto, provider: this.id });
  }

  /** Implementado por cada fornecedor. Nunca chamado diretamente. */
  async _consultar() {
    throw new CompanyProviderError('NOT_SUPPORTED',
      'Fornecedor "' + this.id + '" não implementa _consultar().');
  }

  /**
   * Bloco empresarial em que os campos que este fornecedor sabe responder
   * ficam NAO_ENCONTRADO e os outros ficam NAO_CONSULTADO.
   *
   * A distinção não é cosmética: dizer "não encontrado" sobre faturação
   * quando o fornecedor nem sequer sabe responder faturação seria afirmar
   * algo sobre a empresa que ninguém verificou.
   */
  nadaEncontrado() {
    const o = semDadosEmpresa();
    for (const c of this.campos) o[c] = naoEncontrado();
    return o;
  }
}

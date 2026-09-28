/**
 * LeadMap Pro — CompanyProviderRouter
 * ===================================
 * Ponto único onde se decide QUEM responde a uma consulta empresarial.
 *
 * SEM FALLBACK SILENCIOSO
 * -----------------------
 * Se o fornecedor A falhar, o router não tenta o B sozinho. No Instagram
 * essa regra existe porque um fallback duplicaria mensagens a pessoas
 * reais; aqui existe por outra razão, igualmente séria: dois fornecedores
 * dão números diferentes para a mesma empresa, e trocar de fonte a meio
 * sem o dizer produz um valor cuja proveniência deixa de corresponder ao
 * que está escrito no envelope. Quem chama decide se quer tentar outro.
 *
 * Um id desconhecido lança em vez de cair num fornecedor por omissão.
 */

import { CompanyProviderError } from './contract.mjs';

/** Fornecedores que o LeadMap conhece. Um id fora disto é um erro. */
export const COMPANY_PROVIDER_TYPES = Object.freeze(['website', 'mock']);

/** Descrições curtas, para interface futura. */
export const COMPANY_PROVIDER_INFO = Object.freeze({
  website: {
    nome: 'Website da empresa',
    descricao: 'Lê o NIF publicado no site da própria empresa. Sem custo e sem API externa.'
  },
  mock: {
    nome: 'Simulação',
    descricao: 'Fornecedor de teste. Não consulta nada.'
  }
});

export class CompanyProviderRouter {
  /**
   * @param {object} opts
   * @param {object} [opts.providers]  mapa id → provider
   */
  constructor({ providers = null } = {}) {
    if (!providers || typeof providers !== 'object') {
      throw new CompanyProviderError('INVALID_REQUEST', 'CompanyProviderRouter exige providers.');
    }
    this.mapa = new Map(Object.entries(providers));
    for (const id of this.mapa.keys()) {
      if (!COMPANY_PROVIDER_TYPES.includes(id)) {
        throw new CompanyProviderError('INVALID_REQUEST',
          'Fornecedor desconhecido no registo: "' + id + '". Conhecidos: ' + COMPANY_PROVIDER_TYPES.join(', ') + '.');
      }
    }
  }

  listar() { return [...this.mapa.keys()]; }

  tem(id) { return this.mapa.has(id); }

  /** Fornecedores registados, configurados, que sabem responder a este campo. */
  paraCampo(campo) {
    return this.listar()
      .map(id => this.mapa.get(id))
      .filter(p => p && p.isConfigured() && p.suporta(campo));
  }

  /**
   * Resolve um fornecedor por id.
   *
   * Um id que não existe não cai num fornecedor por omissão: seria a
   * forma mais silenciosa de atribuir a uma empresa um dado vindo de
   * outro sítio que não o anunciado.
   */
  porId(providerType) {
    const id = String(providerType || '').trim().toLowerCase();
    if (!id) {
      throw new CompanyProviderError('INVALID_REQUEST', 'Falta o fornecedor (providerType).');
    }
    if (!COMPANY_PROVIDER_TYPES.includes(id)) {
      throw new CompanyProviderError('INVALID_REQUEST',
        'Fornecedor desconhecido: "' + id + '". Conhecidos: ' + COMPANY_PROVIDER_TYPES.join(', ') + '.');
    }
    if (!this.tem(id)) {
      throw new CompanyProviderError('PROVIDER_NOT_CONFIGURED',
        'Fornecedor "' + id + '" não está registado nesta instalação.');
    }
    const p = this.mapa.get(id);
    if (!p.isConfigured()) {
      throw new CompanyProviderError('PROVIDER_NOT_CONFIGURED',
        'Fornecedor "' + id + '" está registado mas não configurado.');
    }
    return p;
  }

  /**
   * Consulta através de um fornecedor explícito.
   * Uma falha propaga-se: não se tenta outro por conta própria.
   */
  async consultar(providerType, chaves) {
    return this.porId(providerType).consultar(chaves);
  }
}

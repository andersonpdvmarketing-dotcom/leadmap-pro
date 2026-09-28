/**
 * LeadMap Pro — registo de fornecedores empresariais
 * ==================================================
 * Constrói o router a partir do ambiente. É o único sítio que decide o
 * que existe numa instalação concreta.
 *
 * O mock NUNCA é registado em produção: dados empresariais inventados num
 * ecrã de vendas são indistinguíveis dos reais, e alguém decidiria com
 * eles. Fora de produção é útil para exercitar o router sem contratar
 * nada.
 */

import { CompanyProviderRouter } from './router.mjs';
import { WebsiteCompanyProvider } from './website.mjs';
import { MockCompanyProvider } from './mock.mjs';

/** 'production' | 'test' | 'development', lido do ambiente. */
export function ambienteDe(env = {}) {
  const bruto = String(env.OUTREACH_ENV || env.NODE_ENV || 'development').toLowerCase();
  if (bruto.startsWith('prod')) return 'production';
  if (bruto.startsWith('test')) return 'test';
  return 'development';
}

/**
 * Router com os fornecedores disponíveis nesta instalação.
 *
 * Nenhum fornecedor comercial está ligado. Quando algum for contratado,
 * entra aqui e no `COMPANY_PROVIDER_TYPES` do router — mais nada muda.
 */
export function construirRouterEmpresarial(env = {}, opts = {}) {
  const providers = {
    website: new WebsiteCompanyProvider()
  };
  const permitirMock = opts.permitirMock != null
    ? opts.permitirMock === true
    : ambienteDe(env) !== 'production';
  if (permitirMock && opts.mock) providers.mock = opts.mock;
  else if (permitirMock && opts.comMock) providers.mock = new MockCompanyProvider({});
  return new CompanyProviderRouter({ providers });
}

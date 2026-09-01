/**
 * LeadMap Pro — superfície pública do módulo Instagram
 * ====================================================
 * O resto do LeadMap importa daqui e de mais lado nenhum. Nenhum
 * endpoint de fornecedor, nenhuma credencial e nenhum detalhe de
 * adapter atravessa esta fronteira (§13).
 */

export {
  CAPABILITIES, ACCOUNT_STATUS, MESSAGE_STATUS, ELIGIBILITY, ERROR_CODES,
  MAX_CONTAS, ProviderError, respostaEnvio, respostaDeErro,
  normalizarConta, normalizarCapacidades, nenhumaCapacidade,
  rejeitarConfigNaoConforme, redigir
} from './contract.mjs';

export { BaseInstagramProvider, WEBHOOK_EVENTS } from './base.mjs';
export { MockInstagramProvider } from './mock.mjs';
export { MetaInstagramProvider } from './meta.mjs';
export { ExternalInstagramProvider } from './external.mjs';
export { InstagramRegistry } from './registry.mjs';
export { OutreachQueue, ITEM_STATUS, LIMITES_PADRAO } from './queue.mjs';
export { OutreachAudit } from './audit.mjs';
export { construirRegistry, construirFila, vistaPublica, lerLimites } from './config.mjs';

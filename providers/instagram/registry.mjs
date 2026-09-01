/**
 * LeadMap Pro — registo de fornecedores e contas
 * ==============================================
 * Resolve, para cada conta, qual o fornecedor a usar. Cada conta pode
 * ter o seu — nunca se assume que todas partilham o mesmo (§6).
 *
 * O resto do LeadMap fala com este registo, não com adapters concretos.
 */

import { ProviderError, ACCOUNT_STATUS, MAX_CONTAS, normalizarConta } from './contract.mjs';

export class InstagramRegistry {
  constructor() {
    this.providers = new Map();   /* providerId → instância            */
    this.contas = new Map();      /* accountId  → conta normalizada    */
  }

  /* ---------------- fornecedores ---------------- */

  register(provider) {
    if (!provider || !provider.id) {
      throw new ProviderError('INVALID_REQUEST', 'Fornecedor sem id.');
    }
    this.providers.set(provider.id, provider);
    return provider;
  }

  getProvider(id) {
    const p = this.providers.get(id);
    if (!p) throw new ProviderError('NOT_CONFIGURED', 'Fornecedor "' + id + '" não registado.');
    return p;
  }

  hasProvider(id) { return this.providers.has(id); }

  /** Vista segura para o frontend: sem credenciais, com capacidades reais. */
  listProviders() {
    return [...this.providers.values()].map(p => p.describe());
  }

  /* ---------------- contas ---------------- */

  /**
   * Chave local da conta. Inclui o fornecedor de propósito: a mesma
   * conta Instagram ligada por dois fornecedores são dois registos, e
   * a campanha guarda qual foi usado.
   */
  static accountKey(provider, providerAccountId) {
    return provider + ':' + providerAccountId;
  }

  /** Liga uma conta através do fornecedor indicado. Teto de 5 contas (§5). */
  async connectAccount(providerId, params = {}) {
    const provider = this.getProvider(providerId);
    const { account } = await provider.connect(params);
    const chave = InstagramRegistry.accountKey(account.provider, account.providerAccountId);

    if (!this.contas.has(chave) && this.contasAtivas().length >= MAX_CONTAS) {
      /* Não fica meia-ligada: desfaz do lado do fornecedor. */
      try { await provider.disconnect(account); } catch (e) { /* melhor esforço */ }
      throw new ProviderError(
        'INVALID_REQUEST',
        'Limite de ' + MAX_CONTAS + ' contas Instagram ligadas em simultâneo atingido. ' +
        'Desligue uma conta antes de ligar outra.'
      );
    }
    this.contas.set(chave, { ...account, accountId: chave });
    return this.contas.get(chave);
  }

  async disconnectAccount(accountId) {
    const conta = this.getAccount(accountId);
    const provider = this.getProvider(conta.provider);
    const { account } = await provider.disconnect(conta);
    const atualizada = { ...conta, ...account, accountId };
    this.contas.set(accountId, atualizada);
    return atualizada;
  }

  getAccount(accountId) {
    const c = this.contas.get(accountId);
    if (!c) throw new ProviderError('INVALID_REQUEST', 'Conta "' + accountId + '" não encontrada.');
    return c;
  }

  /** Fornecedor de uma conta concreta — o ponto único de resolução (§6). */
  providerForAccount(accountId) {
    return this.getProvider(this.getAccount(accountId).provider);
  }

  listAccounts() {
    return [...this.contas.values()];
  }

  contasAtivas() {
    return this.listAccounts().filter(c => c.status !== ACCOUNT_STATUS.DISCONNECTED);
  }

  /** Atualiza estado/última sincronização — usado por webhooks e por erros. */
  updateAccount(accountId, campos = {}) {
    const conta = this.getAccount(accountId);
    const atualizada = normalizarConta({ ...conta, ...campos, provider: conta.provider });
    this.contas.set(accountId, { ...atualizada, accountId });
    return this.contas.get(accountId);
  }

  /**
   * Vista da tabela Outreach > Contas Instagram (§11): inclui a coluna
   * Provider já formatada e as capacidades, para o UI só mostrar ações
   * que o fornecedor daquela conta suporta.
   */
  accountsView() {
    return this.listAccounts().map(c => {
      const p = this.providers.get(c.provider);
      return {
        accountId: c.accountId,
        provider: c.provider,
        providerLabel: p ? p.displayName : c.provider,
        providerAccountId: c.providerAccountId,
        username: c.username,
        displayName: c.displayName,
        status: c.status,
        connectedAt: c.connectedAt,
        lastSyncAt: c.lastSyncAt,
        capabilities: p ? { ...p.capabilities } : null,
        providerConfigured: p ? p.isConfigured() : false
      };
    });
  }
}

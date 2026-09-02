/**
 * LeadMap Pro — InstagramProviderRouter
 * =====================================
 * Ponto ÚNICO onde se decide por que fornecedor sai uma mensagem.
 *
 *   Outreach Engine → InstagramProviderRouter → { manychat | meta | external }
 *
 * O `InstagramRegistry` já sabia responder «que fornecedor é o desta
 * conta?». O que faltava era alguém a fazer-lhe essa pergunta na altura
 * do envio: o worker recebia um fornecedor fixo no construtor e usava-o
 * para tudo, ignorando o `provider` que estava gravado na fila. Este
 * ficheiro fecha esse buraco.
 *
 * A REGRA DE PRECEDÊNCIA, E PORQUÊ
 * --------------------------------
 * Quando um item de fila diz `provider: 'manychat'` e a conta entretanto
 * passou a `meta`, **vence o item de fila**.
 *
 * Não é uma escolha estética. O `idempotencyKey` da mensagem foi
 * calculado quando o item entrou na fila, e a linha de `message` já
 * existe com aquele fornecedor. Reencaminhar um item já enfileirado
 * significaria enviar por um canal que ninguém reviu, e arriscar um
 * segundo envio a coberto de uma chave que já não corresponde. Mudar o
 * fornecedor de uma conta afeta o que for enfileirado A SEGUIR — nunca
 * o que já está em voo.
 *
 * SEM FALLBACK AUTOMÁTICO (§20)
 * -----------------------------
 * Se o fornecedor resolvido falhar, o router **não** tenta outro. Uma
 * falha pode ser um timeout depois de a mensagem já ter sido aceite do
 * outro lado; repetir noutro canal duplicaria a mensagem para uma
 * pessoa real. Trocar de fornecedor é uma decisão de quem opera, tomada
 * com o erro à frente.
 */

import { ProviderError } from './contract.mjs';

/** Fornecedores que o LeadMap conhece. Um id fora disto é um erro. */
export const PROVIDER_TYPES = Object.freeze(['manychat', 'meta', 'external', 'mock']);

/** Descrições curtas — usadas no seletor de conta (§44). */
export const PROVIDER_INFO = Object.freeze({
  meta: { nome: 'Meta Oficial', descricao: 'Integração direta com a plataforma Meta.' },
  manychat: { nome: 'ManyChat', descricao: 'Integração através da API da ManyChat.' },
  external: { nome: 'API Externa', descricao: 'Integração através de fornecedor terceiro configurado.' },
  mock: { nome: 'Simulação', descricao: 'Fornecedor de teste. Não envia nada.' }
});

export class InstagramProviderRouter {
  /**
   * @param {object} opts
   * @param {InstagramRegistry} [opts.registry]  fonte dos fornecedores
   * @param {object} [opts.providers]            alternativa: mapa id→provider
   */
  constructor({ registry = null, providers = null } = {}) {
    if (!registry && !providers) {
      throw new Error('InstagramProviderRouter exige registry ou providers.');
    }
    this.registry = registry;
    this.mapa = providers ? new Map(Object.entries(providers)) : null;
  }

  /** Ids conhecidos por este router. */
  listar() {
    if (this.mapa) return [...this.mapa.keys()];
    return [...this.registry.providers.keys()];
  }

  tem(id) {
    if (this.mapa) return this.mapa.has(id);
    return this.registry.hasProvider(id);
  }

  /**
   * Resolve um fornecedor por id.
   *
   * Um id que não existe **não** cai num fornecedor por omissão: seria
   * a forma mais silenciosa de escrever a alguém pelo canal errado.
   */
  porId(providerType) {
    const id = String(providerType || '').trim().toLowerCase();
    if (!id) {
      throw new ProviderError('INVALID_REQUEST', 'Falta o fornecedor (providerType).');
    }
    if (!PROVIDER_TYPES.includes(id)) {
      throw new ProviderError('INVALID_REQUEST',
        'Fornecedor desconhecido: "' + id + '". Conhecidos: ' + PROVIDER_TYPES.join(', ') + '.');
    }
    if (!this.tem(id)) {
      throw new ProviderError('NOT_CONFIGURED', 'Fornecedor "' + id + '" não está registado nesta instalação.');
    }
    const p = this.mapa ? this.mapa.get(id) : this.registry.getProvider(id);
    if (p && typeof p.isConfigured === 'function' && !p.isConfigured()) {
      throw new ProviderError('NOT_CONFIGURED',
        'Fornecedor "' + id + '" está registado mas não configurado.', { status: 'NOT_CONFIGURED' });
    }
    return p;
  }

  /**
   * Resolve para um item de trabalho concreto.
   *
   * `item.provider` (o que ficou gravado na fila) tem precedência sobre
   * `account.provider`. Ver a nota de precedência no topo do ficheiro.
   *
   * @param {object} contexto  { item, account }
   */
  resolve({ item = null, account = null } = {}) {
    const doItem = item && item.provider;
    const daConta = account && (account.provider || account.providerType);
    const escolhido = doItem || daConta;
    if (!escolhido) {
      throw new ProviderError('INVALID_REQUEST',
        'Não há fornecedor no item de fila nem na conta.');
    }
    return {
      providerType: String(escolhido).toLowerCase(),
      provider: this.porId(escolhido),
      /* de onde veio a decisão — vai para a auditoria */
      origem: doItem ? 'queue_item' : 'account',
      /* sinalizar a divergência sem a resolver: é informação útil para
         quem lê a auditoria, não motivo para mudar de canal */
      divergente: Boolean(doItem && daConta && String(doItem).toLowerCase() !== String(daConta).toLowerCase())
    };
  }

  /** Capacidades declaradas por um fornecedor. Nunca inventadas. */
  capacidades(providerType) {
    return this.porId(providerType).capabilities;
  }

  /**
   * Vista para a interface: que fornecedores existem, quais estão
   * configurados e o que cada um diz saber fazer. Sem credenciais.
   */
  vista() {
    const ids = this.listar();
    return ids.map(id => {
      const p = this.mapa ? this.mapa.get(id) : this.registry.getProvider(id);
      const info = PROVIDER_INFO[id] || { nome: id, descricao: '' };
      return {
        id,
        nome: info.nome,
        descricao: info.descricao,
        configurado: typeof p.isConfigured === 'function' ? p.isConfigured() === true : true,
        capabilities: p.capabilities || {}
      };
    });
  }
}

/** Atalho: router a partir de um registry já construído. */
export function construirRouter(registry) {
  return new InstagramProviderRouter({ registry });
}

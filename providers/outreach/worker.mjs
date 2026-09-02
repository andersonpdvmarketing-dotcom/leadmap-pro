/**
 * LeadMap Pro — worker de Outreach (Fase C)
 * =========================================
 * Reclama itens da fila, executa o fornecedor e persiste o resultado.
 *
 * NESTA FASE O WORKER NÃO ENVIA NADA PARA A META. Usa um fornecedor
 * controlado, para validar a infraestrutura — fila durável, claim
 * atómico, retries persistentes — sem tocar em nenhuma API real.
 *
 * Serverless em mente (§38): nenhum estado crítico fica em memória. O
 * worker pode morrer a meio que outro reclama o item quando o lock
 * expirar; e um item terminal nunca é reprocessado.
 */

import {
  QUEUE_STATUS, planoDeRetry, motivoDeExclusao, resolverTemplate,
  AUDIT_ACTION, LOCK_TIMEOUT_SEG, redigir
} from './domain.mjs';

/**
 * Identificador do worker. Serve para saber quem detém um lock e para a
 * auditoria; não é segredo nenhum.
 */
export function novoWorkerId(prefixo = 'w') {
  const rnd = Math.random().toString(36).slice(2, 8);
  const host = (typeof process !== 'undefined' && process.env && (process.env.VERCEL_REGION || process.env.HOSTNAME)) || 'local';
  const pid = (typeof process !== 'undefined' && process.pid) || 0;
  return [prefixo, host, pid, Date.now().toString(36), rnd].join(':');
}

export class OutreachWorker {
  /**
   * @param {object} opts
   * @param {OutreachRepository} opts.repository
   * @param {object} [opts.router]    InstagramProviderRouter — escolhe o
   *                                  fornecedor item a item
   * @param {object} [opts.provider]  fornecedor único (modo antigo)
   * @param {string} opts.workerId
   */
  constructor({ repository, provider = null, router = null, workerId,
                lockTimeoutSeg = LOCK_TIMEOUT_SEG, agora = () => Date.now() } = {}) {
    if (!repository) throw new Error('OutreachWorker exige um repository.');
    if (!provider && !router) throw new Error('OutreachWorker exige um provider ou um router.');
    this.repo = repository;
    /* Os dois modos coexistem de propósito. Um worker construído com um
       fornecedor único continua a funcionar exatamente como antes — é
       assim que dezenas de testes o constroem, e migrá-los todos seria
       trocar cobertura real por uma assinatura mais bonita. Havendo
       router, é ele que manda. */
    this.provider = provider;
    this.router = router;
    this.workerId = workerId || novoWorkerId();
    this.lockTimeoutSeg = lockTimeoutSeg;
    this.agora = agora;
  }

  /**
   * Que fornecedor usar para um item concreto.
   *
   * Sem router, é o de sempre. Com router, quem decide é o `provider`
   * gravado no item de fila — não uma configuração global nem o estado
   * atual da conta.
   */
  resolverProvider(item, contacto) {
    if (!this.router) return { provider: this.provider, providerType: (item && item.provider) || null, origem: 'injetado' };
    return this.router.resolve({
      item,
      account: { provider: item && item.provider, id: item && item.accountId }
    });
  }

  /** Uma passagem: reclama até `limit` itens e processa-os. */
  async processar({ limit = 10 } = {}) {
    const resumo = { reclamados: 0, enviados: 0, falhados: 0, adiados: 0, ignorados: 0, jaTerminais: 0 };
    const itens = await this.repo.reclamarItens({
      workerId: this.workerId, limit, lockTimeoutSeg: this.lockTimeoutSeg
    });
    resumo.reclamados = itens.length;

    for (const item of itens) {
      await this.repo.registarAuditoria({
        actor: this.workerId, action: AUDIT_ACTION.QUEUE_ITEM_CLAIMED,
        entityType: 'queue_item', entityId: item.id,
        metadata: { campaignId: item.campaignId, attempt: item.attemptCount }
      });
      const r = await this.processarItem(item);
      if (r.jaTerminal) resumo.jaTerminais += 1;
      else if (r.outcome === 'SENT') resumo.enviados += 1;
      else if (r.outcome === 'RETRY') resumo.adiados += 1;
      else if (r.outcome === 'SKIPPED') resumo.ignorados += 1;
      else resumo.falhados += 1;
    }
    return resumo;
  }

  async processarItem(item) {
    const mensagem = await this.repo.lerMensagem(item.messageId);
    /* pelo contrato do repositório — nunca pelos interiores de uma
       implementação concreta, senão o worker só funciona com uma delas */
    const contacto = await this.repo.lerContacto(item.contactId);

    /* O opt-out pode ter acontecido DEPOIS de o item entrar na fila.
       Reavaliar aqui é a única forma de não contactar quem pediu para
       não ser contactado (§30). */
    const motivo = motivoDeExclusao(contacto);
    if (motivo) {
      await this.repo.concluirItem({
        itemId: item.id, outcome: 'SKIPPED', errorCode: motivo,
        errorMessage: 'Contacto não elegível no momento do envio.'
      });
      return { outcome: 'SKIPPED', motivo };
    }

    const corpo = resolverTemplate(mensagem ? mensagem.body : '', contacto);

    await this.repo.registarAuditoria({
      actor: this.workerId, action: AUDIT_ACTION.MESSAGE_ATTEMPTED,
      entityType: 'message', entityId: item.messageId,
      metadata: { attempt: item.attemptCount, provider: item.provider }
    });

    /* Resolver o fornecedor ANTES de qualquer envio. Um fornecedor
       desconhecido ou não configurado falha aqui, sem sair nada — e sem
       tentar outro (§20: um fallback automático podia duplicar a
       mensagem para uma pessoa real). */
    let escolha;
    try {
      escolha = this.resolverProvider(item, contacto);
    } catch (err) {
      await this.repo.concluirItem({
        itemId: item.id, outcome: 'FAILED',
        errorCode: (err && err.errorCode) || 'PROVIDER_NOT_CONFIGURED',
        errorMessage: String(err && err.message)
      });
      await this.repo.registarAuditoria({
        actor: this.workerId, action: AUDIT_ACTION.MESSAGE_FAILED,
        entityType: 'message', entityId: item.messageId,
        metadata: { errorCode: (err && err.errorCode) || 'PROVIDER_NOT_CONFIGURED', provider: item.provider }
      });
      return { outcome: 'FAILED', motivo: (err && err.errorCode) || 'PROVIDER_NOT_CONFIGURED' };
    }

    let resposta;
    try {
      resposta = await escolha.provider.sendMessage({
        account: { providerAccountId: item.accountId, id: item.accountId },
        recipient: { username: contacto.normalizedInstagram },
        message: corpo.texto,
        campaignId: item.campaignId,
        /* passado ao fornecedor quando ele o suportar: é o que permite
           que um envio repetido após uma falha de rede não duplique */
        idempotencyKey: mensagem ? mensagem.idempotencyKey : null
      });
    } catch (err) {
      resposta = { success: false, errorCode: 'UNKNOWN', errorMessage: String(err && err.message), retryable: true };
    }

    if (resposta.success) {
      const r = await this.repo.concluirItem({
        itemId: item.id, outcome: 'SENT', providerMessageId: resposta.providerMessageId
      });
      if (!r.jaTerminal) {
        await this.repo.registarAuditoria({
          actor: this.workerId, action: AUDIT_ACTION.MESSAGE_SENT,
          entityType: 'message', entityId: item.messageId,
          metadata: redigir({ providerMessageId: resposta.providerMessageId })
        });
      }
      return { outcome: 'SENT', jaTerminal: Boolean(r.jaTerminal) };
    }

    const plano = planoDeRetry({
      resposta, attemptCount: item.attemptCount, maxAttempts: item.maxAttempts, agora: this.agora()
    });

    if (plano.acao === 'RETRY') {
      await this.repo.concluirItem({
        itemId: item.id, outcome: 'RETRY',
        errorCode: resposta.errorCode, errorMessage: resposta.errorMessage,
        availableAt: plano.availableAt
      });
      await this.repo.registarAuditoria({
        actor: this.workerId, action: AUDIT_ACTION.RETRY_SCHEDULED,
        entityType: 'queue_item', entityId: item.id,
        metadata: { errorCode: resposta.errorCode, emSegundos: plano.segundos, tentativa: item.attemptCount }
      });
      return { outcome: 'RETRY', segundos: plano.segundos };
    }

    await this.repo.concluirItem({
      itemId: item.id, outcome: 'FAILED',
      errorCode: resposta.errorCode, errorMessage: resposta.errorMessage
    });
    await this.repo.registarAuditoria({
      actor: this.workerId, action: AUDIT_ACTION.MESSAGE_FAILED,
      entityType: 'message', entityId: item.messageId,
      metadata: { errorCode: resposta.errorCode, motivo: plano.motivo }
    });
    return { outcome: 'FAILED', motivo: plano.motivo };
  }
}

/**
 * LeadMap Pro — fila de envio Outreach
 * ====================================
 *
 * OUTREACH QUEUE: DOMAIN / TEST COMPONENT — NÃO USAR PARA ENVIO REAL
 * ------------------------------------------------------------------
 * Isto é lógica de domínio testável, EM MEMÓRIA. Não é uma fila de
 * produção. Em serverless (Vercel) cada invocação é um processo novo:
 * os itens perdem-se e os contadores de limite reiniciam, pelo que os
 * limites deixam de ser fiáveis.
 *
 * Não usar para envio real enquanto não existirem:
 *   · persistência durável        · idempotency key
 *   · unique constraint           · atomic claim
 *   · worker locking              · cancelamento persistente
 *   · retry persistente
 *
 * Limitação conhecida e deliberadamente não escondida: sem claim
 * atómico, dois workers no mesmo item enviam os dois. Só é seguro com um
 * único worker. O teste `AUDITORIA §13` documenta-o e falha se alguém
 * acrescentar um lock sem atualizar esta nota.
 *
 * Fluxo único, igual para todos os fornecedores (§8):
 *
 *   Campaign → Queue → InstagramProvider → fornecedor → resposta normalizada
 *
 * A fila é onde vivem os limites e a política de retry. Duas regras que
 * o código impõe, não apenas documenta:
 *
 *  §9  Limites internos (hora/dia) por conta E respeito pelo `retryAfter`
 *      devolvido pelo fornecedor. Não existe caminho que os contorne:
 *      um 429 adia o item, nunca o reencaminha nem acelera.
 *  §15/§16  A campanha fixa `accountId` + `provider`. A fila nunca troca
 *      de fornecedor sozinha; um reencaminhamento manual exige um pedido
 *      novo e explícito (ver `reencaminharManualmente`), porque trocar
 *      automaticamente duplicaria mensagens.
 */

import { ProviderError, MESSAGE_STATUS, ELIGIBILITY, ACCOUNT_STATUS, respostaEnvio } from './contract.mjs';

/** Limites internos por conta. Sobrepõem-se sempre aos do fornecedor se forem menores. */
export const LIMITES_PADRAO = Object.freeze({
  OUTREACH_MAX_PER_HOUR: 20,
  OUTREACH_MAX_PER_DAY: 100
});

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;

/** Estados de um item na fila. */
export const ITEM_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  DEFERRED: 'DEFERRED'
});

export class OutreachQueue {
  /**
   * @param {object} opts
   * @param {InstagramRegistry} opts.registry
   * @param {object}  opts.limites      { OUTREACH_MAX_PER_HOUR, OUTREACH_MAX_PER_DAY }
   * @param {object}  opts.audit        auditoria (ver audit.mjs)
   * @param {Function} opts.now         relógio injetável, para testes
   * @param {number}  opts.maxTentativas
   */
  constructor({ registry, limites, audit = null, now = () => Date.now(), maxTentativas = 3 } = {}) {
    if (!registry) throw new ProviderError('INVALID_REQUEST', 'Fila sem registo de fornecedores.');
    this.registry = registry;
    this.limites = { ...LIMITES_PADRAO, ...(limites || {}) };
    this.audit = audit;
    this.now = now;
    this.maxTentativas = maxTentativas;
    this.itens = [];
    /* histórico de envios bem-sucedidos por conta, para os limites */
    this.historico = new Map();      /* accountId → [timestamps] */
    /* pausa imposta pelo fornecedor (429), por conta */
    this.pausadoAte = new Map();     /* accountId → timestamp    */
    this._seq = 0;
  }

  /* ------------------------------------------------------------ *
   * Entrada                                                       *
   * ------------------------------------------------------------ */

  /**
   * Coloca um envio em fila. `campaign` fixa a conta e, com ela, o
   * fornecedor: é isso que fica guardado no item e na auditoria (§15).
   */
  enqueue({ campaignId, accountId, recipient, message }) {
    const conta = this.registry.getAccount(accountId);   /* lança se não existir */
    this._seq += 1;
    const item = {
      id: 'q-' + this._seq,
      campaignId: campaignId || null,
      accountId,
      /* congelado no momento do enqueue — a fila não o recalcula depois */
      provider: conta.provider,
      recipient,
      message,
      status: ITEM_STATUS.PENDING,
      tentativas: 0,
      naoAntesDe: 0,
      resultado: null
    };
    this.itens.push(item);
    return item;
  }

  pendentes() {
    return this.itens.filter(i => i.status === ITEM_STATUS.PENDING || i.status === ITEM_STATUS.DEFERRED);
  }

  /* ------------------------------------------------------------ *
   * Limites                                                       *
   * ------------------------------------------------------------ */

  registarEnvio(accountId) {
    if (!this.historico.has(accountId)) this.historico.set(accountId, []);
    this.historico.get(accountId).push(this.now());
  }

  contagens(accountId) {
    const agora = this.now();
    const h = (this.historico.get(accountId) || []).filter(t => agora - t < DIA_MS);
    this.historico.set(accountId, h);
    return {
      ultimaHora: h.filter(t => agora - t < HORA_MS).length,
      ultimoDia: h.length
    };
  }

  /**
   * Diz se a conta pode enviar agora. Devolve o motivo e quando poderá
   * voltar a tentar — nunca uma forma de contornar o limite.
   */
  podeEnviar(accountId) {
    const agora = this.now();
    const pausa = this.pausadoAte.get(accountId) || 0;
    if (pausa > agora) {
      return {
        ok: false, motivo: 'PROVIDER_RATE_LIMIT', retomarEm: pausa,
        detalhe: 'Em pausa a pedido do fornecedor.'
      };
    }
    const { ultimaHora, ultimoDia } = this.contagens(accountId);
    if (ultimoDia >= this.limites.OUTREACH_MAX_PER_DAY) {
      return {
        ok: false, motivo: 'INTERNAL_DAILY_LIMIT', retomarEm: agora + HORA_MS,
        detalhe: 'Limite interno diário (' + this.limites.OUTREACH_MAX_PER_DAY + ') atingido.'
      };
    }
    if (ultimaHora >= this.limites.OUTREACH_MAX_PER_HOUR) {
      return {
        ok: false, motivo: 'INTERNAL_HOURLY_LIMIT', retomarEm: agora + HORA_MS,
        detalhe: 'Limite interno horário (' + this.limites.OUTREACH_MAX_PER_HOUR + ') atingido.'
      };
    }
    return { ok: true, motivo: null, retomarEm: 0, detalhe: null };
  }

  /** Aplica a pausa pedida pelo fornecedor. Respeitar, não contornar. */
  aplicarPausa(accountId, segundos) {
    const s = Number.isFinite(segundos) && segundos > 0 ? segundos : 60;
    this.pausadoAte.set(accountId, this.now() + s * 1000);
  }

  /* ------------------------------------------------------------ *
   * Processamento                                                 *
   * ------------------------------------------------------------ */

  /**
   * Processa um item. Nunca lança: devolve sempre o item com o
   * resultado normalizado. Usa exclusivamente o fornecedor gravado no
   * item — mesmo que a conta tenha entretanto mudado de fornecedor.
   */
  async processarItem(item) {
    /* Estados terminais nunca voltam ao fornecedor. `processar()` já
       filtra por `pendentes()`, mas uma chamada direta a este método
       reenviaria um item SENT e duplicaria a mensagem. */
    if (item.status === ITEM_STATUS.SENT ||
        item.status === ITEM_STATUS.FAILED ||
        item.status === ITEM_STATUS.SKIPPED) {
      return item;
    }
    const agora = this.now();
    if (item.naoAntesDe > agora) return item;

    const conta = this.registry.getAccount(item.accountId);
    if (conta.provider !== item.provider) {
      /* Trocar de fornecedor a meio duplicaria mensagens: não se faz. */
      item.status = ITEM_STATUS.SKIPPED;
      item.resultado = respostaEnvio({
        success: false, errorCode: 'INVALID_REQUEST',
        errorMessage: 'A conta mudou de fornecedor (' + item.provider + ' → ' + conta.provider +
          '). O item foi parado para não duplicar o envio; reenvie manualmente.',
        retryable: false
      });
      this.registarAuditoria(item);
      return item;
    }

    if (conta.status === ACCOUNT_STATUS.DISCONNECTED || conta.status === ACCOUNT_STATUS.RESTRICTED) {
      item.status = ITEM_STATUS.SKIPPED;
      item.resultado = respostaEnvio({
        success: false, errorCode: 'ACCOUNT_RESTRICTED',
        errorMessage: 'Conta em estado ' + conta.status + '.', retryable: false
      });
      this.registarAuditoria(item);
      return item;
    }

    const permissao = this.podeEnviar(item.accountId);
    if (!permissao.ok) {
      item.status = ITEM_STATUS.DEFERRED;
      item.naoAntesDe = permissao.retomarEm;
      item.ultimoMotivo = permissao.motivo;
      return item;
    }

    const provider = this.registry.getProvider(item.provider);

    /* Elegibilidade: se o fornecedor souber responder, respeita-se. Se
       não souber, o estado é UNKNOWN e o envio segue — mas nunca se
       marca como elegível quem não foi verificado (§10). */
    if (provider.supports('canCheckEligibility')) {
      const eleg = await provider.checkEligibility(conta, item.recipient);
      item.eligibility = eleg.status;
      if (eleg.status === ELIGIBILITY.INELIGIBLE) {
        item.status = ITEM_STATUS.SKIPPED;
        item.resultado = respostaEnvio({
          success: false, errorCode: 'RECIPIENT_INELIGIBLE',
          errorMessage: eleg.reason || 'Destinatário não elegível.', retryable: false
        });
        this.registarAuditoria(item);
        return item;
      }
    } else {
      item.eligibility = ELIGIBILITY.UNKNOWN;
    }

    item.tentativas += 1;
    const resposta = await provider.sendMessage({
      account: conta,
      recipient: item.recipient,
      message: item.message,
      campaignId: item.campaignId
    });
    item.resultado = resposta;

    if (resposta.success) {
      item.status = ITEM_STATUS.SENT;
      item.providerMessageId = resposta.providerMessageId;
      this.registarEnvio(item.accountId);
      this.registarAuditoria(item);
      return item;
    }

    /* Falha: o fornecedor manda no ritmo. */
    if (resposta.errorCode === 'RATE_LIMITED') {
      this.aplicarPausa(item.accountId, resposta.retryAfterSec);
      this.registry.updateAccount(item.accountId, { status: ACCOUNT_STATUS.RATE_LIMITED });
    }
    if (resposta.errorCode === 'INVALID_TOKEN') {
      this.registry.updateAccount(item.accountId, { status: ACCOUNT_STATUS.TOKEN_EXPIRED });
    }
    if (resposta.errorCode === 'ACCOUNT_RESTRICTED') {
      this.registry.updateAccount(item.accountId, { status: ACCOUNT_STATUS.RESTRICTED });
    }

    if (resposta.retryable && item.tentativas < this.maxTentativas) {
      item.status = ITEM_STATUS.DEFERRED;
      const espera = Number.isFinite(resposta.retryAfterSec) && resposta.retryAfterSec > 0
        ? resposta.retryAfterSec * 1000
        : Math.min(HORA_MS, 30000 * Math.pow(2, item.tentativas - 1));   /* recuo exponencial */
      item.naoAntesDe = this.now() + espera;
    } else {
      item.status = ITEM_STATUS.FAILED;
    }
    this.registarAuditoria(item);
    return item;
  }

  /**
   * Corre uma passagem pela fila. `maxItens` limita o lote; itens
   * adiados ficam para a passagem seguinte.
   */
  async processar({ maxItens = 50 } = {}) {
    const resumo = { processados: 0, enviados: 0, falhados: 0, adiados: 0, ignorados: 0 };
    const lote = this.pendentes().slice(0, maxItens);
    for (const item of lote) {
      const antes = item.status;
      await this.processarItem(item);
      if (item.status === antes && item.status === ITEM_STATUS.DEFERRED) continue;
      resumo.processados += 1;
      if (item.status === ITEM_STATUS.SENT) resumo.enviados += 1;
      else if (item.status === ITEM_STATUS.FAILED) resumo.falhados += 1;
      else if (item.status === ITEM_STATUS.DEFERRED) resumo.adiados += 1;
      else if (item.status === ITEM_STATUS.SKIPPED) resumo.ignorados += 1;
    }
    return resumo;
  }

  /* ------------------------------------------------------------ *
   * Reencaminhamento manual                                       *
   * ------------------------------------------------------------ */

  /**
   * Reenvia um item falhado por OUTRA conta/fornecedor. Só manualmente
   * e com confirmação explícita (§16): não há fallback automático, porque
   * uma mensagem que a Meta recusou pode ter sido entregue à mesma.
   */
  reencaminharManualmente(itemId, novoAccountId, { confirmadoPeloUtilizador = false } = {}) {
    if (confirmadoPeloUtilizador !== true) {
      throw new ProviderError(
        'INVALID_REQUEST',
        'Reencaminhar para outro fornecedor exige confirmação explícita do utilizador: ' +
        'o envio original pode ter sido entregue e a mensagem ficaria duplicada.'
      );
    }
    const original = this.itens.find(i => i.id === itemId);
    if (!original) throw new ProviderError('INVALID_REQUEST', 'Item "' + itemId + '" não encontrado.');
    if (original.status === ITEM_STATUS.SENT) {
      throw new ProviderError('INVALID_REQUEST', 'O item já foi enviado com sucesso; reenviar duplicaria a mensagem.');
    }
    const novo = this.enqueue({
      campaignId: original.campaignId,
      accountId: novoAccountId,
      recipient: original.recipient,
      message: original.message
    });
    novo.reencaminhadoDe = original.id;
    novo.reencaminhadoDoProvider = original.provider;
    original.reencaminhadoPara = novo.id;
    return novo;
  }

  /* ------------------------------------------------------------ *
   * Auditoria                                                     *
   * ------------------------------------------------------------ */

  registarAuditoria(item) {
    if (!this.audit) return;
    const conta = this.registry.contas.get(item.accountId) || {};
    this.audit.registar({
      provider: item.provider,
      accountId: item.accountId,
      username: conta.username || null,
      campaignId: item.campaignId,
      recipient: item.recipient && (item.recipient.username || item.recipient.providerUserId),
      providerMessageId: (item.resultado && item.resultado.providerMessageId) || null,
      status: item.resultado ? item.resultado.status : MESSAGE_STATUS.UNKNOWN,
      errorCode: item.resultado ? item.resultado.errorCode : null,
      errorMessage: item.resultado ? item.resultado.errorMessage : null,
      tentativa: item.tentativas
    });
  }
}

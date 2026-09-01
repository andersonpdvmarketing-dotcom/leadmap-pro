/**
 * LeadMap Pro — serviço de Outreach (Fase C)
 * ==========================================
 * Casos de uso entre a API e o repositório: validam, aplicam as regras
 * do domínio, escrevem auditoria e devolvem sempre a mesma forma de
 * resposta. A API fica fina; as regras ficam aqui e são testáveis sem
 * HTTP.
 */

import {
  AUDIT_ACTION, CAMPAIGN_STATUS, MAX_ACCOUNTS, exigirTransicao,
  separarElegiveis, extrair, ValidationError, MAX_TEMPLATE_BODY, MAX_NOME,
  ambienteDe, mockPermitido
} from './domain.mjs';
import { RepositoryError } from './repository.mjs';

export class OutreachService {
  constructor({ repository, actor = 'sistema', env = {} } = {}) {
    if (!repository) throw new Error('OutreachService exige um repository.');
    this.repo = repository;
    this.actor = actor;
    this.env = env;
  }

  auditar(action, entityType, entityId, metadata) {
    return this.repo.registarAuditoria({ actor: this.actor, action, entityType, entityId, metadata: metadata || {} });
  }

  /* ---------- contas ---------- */

  async criarConta(corpo) {
    const dados = extrair(corpo, {
      username: { tipo: 'texto', obrigatorio: true, min: 1, max: 30, padrao: /^@?[a-zA-Z0-9._]{1,30}$/ },
      displayName: { tipo: 'texto', max: MAX_NOME },
      provider: { tipo: 'enum', valores: ['mock', 'meta', 'external'], omissao: 'mock' }
    });
    const username = dados.username.replace(/^@/, '').toLowerCase();

    /* o teto é aplicado aqui E no banco — a UI é a terceira barreira */
    const contas = await this.repo.listarContas();
    if (contas.length >= MAX_ACCOUNTS) {
      throw new RepositoryError('MAX_ACCOUNTS', 'Limite máximo de ' + MAX_ACCOUNTS + ' contas conectadas.');
    }
    const conta = await this.repo.criarConta({ ...dados, username });
    await this.auditar(AUDIT_ACTION.ACCOUNT_CREATED, 'instagram_account', conta.id, { username, provider: conta.provider });
    return conta;
  }

  listarContas() { return this.repo.listarContas(); }

  /* ---------- contactos ---------- */

  async importarContactos(corpo) {
    const dados = extrair(corpo, {
      contacts: {
        tipo: 'lista', obrigatorio: true, max: 5000,
        item: { tipo: 'texto', max: 4000 }   /* validado em detalhe abaixo */
      }
    });
    /* a lista chega como objetos; `extrair` só garante que é lista e o
       tamanho. Cada item passa por um esquema próprio. */
    const brutos = Array.isArray(corpo.contacts) ? corpo.contacts : [];
    const resumo = { criados: 0, atualizados: 0, ignorados: 0, ids: [] };
    for (const bruto of brutos) {
      let c;
      try {
        c = extrair(bruto, {
          leadId: { tipo: 'id' },
          normalizedInstagram: { tipo: 'texto', max: 30, padrao: /^[a-z0-9._]{1,30}$/ },
          name: { tipo: 'texto', obrigatorio: true, max: MAX_NOME },
          company: { tipo: 'texto', max: MAX_NOME },
          city: { tipo: 'texto', max: MAX_NOME },
          district: { tipo: 'texto', max: MAX_NOME },
          activity: { tipo: 'texto', max: MAX_NOME },
          source: { tipo: 'texto', max: MAX_NOME }
        });
      } catch (e) { resumo.ignorados += 1; continue; }
      if (!c.normalizedInstagram && !c.leadId) { resumo.ignorados += 1; continue; }
      const { contacto, criado } = await this.repo.upsertContacto(c);
      resumo.ids.push(contacto.id);
      if (criado) { resumo.criados += 1; await this.auditar(AUDIT_ACTION.CONTACT_CREATED, 'contact', contacto.id, { name: contacto.name }); }
      else { resumo.atualizados += 1; }
    }
    return resumo;
  }

  listarContactos(opts) { return this.repo.listarContactos(opts); }

  async definirOptOut(contactId, optOut) {
    const c = await this.repo.definirOptOut(contactId, optOut);
    if (optOut) await this.auditar(AUDIT_ACTION.CONTACT_OPTED_OUT, 'contact', contactId, {});
    else await this.auditar(AUDIT_ACTION.CONTACT_UPDATED, 'contact', contactId, { reativado: true });
    return c;
  }

  /* ---------- templates ---------- */

  async criarTemplate(corpo) {
    const dados = extrair(corpo, {
      name: { tipo: 'texto', obrigatorio: true, max: MAX_NOME },
      body: { tipo: 'texto', obrigatorio: true, min: 1, max: MAX_TEMPLATE_BODY }
    });
    return this.repo.criarTemplate(dados);
  }
  listarTemplates(opts) { return this.repo.listarTemplates(opts); }
  async atualizarTemplate(id, corpo) {
    const dados = extrair(corpo, {
      name: { tipo: 'texto', max: MAX_NOME },
      body: { tipo: 'texto', min: 1, max: MAX_TEMPLATE_BODY }
    });
    if (!Object.keys(dados).length) throw new ValidationError('Nada para atualizar.');
    return this.repo.atualizarTemplate(id, dados);
  }
  apagarTemplate(id) { return this.repo.apagarTemplate(id); }

  /* ---------- campanhas ---------- */

  async criarCampanha(corpo) {
    const dados = extrair(corpo, {
      name: { tipo: 'texto', obrigatorio: true, max: MAX_NOME },
      accountId: { tipo: 'id', obrigatorio: true },
      templateId: { tipo: 'id' },
      body: { tipo: 'texto', max: MAX_TEMPLATE_BODY }
    });
    let body = dados.body;
    if (dados.templateId) {
      const { items } = await this.repo.listarTemplates({ limit: 200, offset: 0 });
      const t = items.find(x => x.id === dados.templateId);
      if (!t) throw new ValidationError('Template não encontrado.', 'templateId');
      body = t.body;
    }
    if (!body || !body.trim()) throw new ValidationError('A mensagem não pode estar vazia.', 'body');

    const k = await this.repo.criarCampanha({ ...dados, body });
    await this.auditar(AUDIT_ACTION.CAMPAIGN_CREATED, 'campaign', k.id, { name: k.name, accountId: k.accountId });
    return k;
  }

  lerCampanha(id) { return this.repo.lerCampanha(id); }
  listarCampanhas(opts) { return this.repo.listarCampanhas(opts); }

  /**
   * Arranque. Idempotente por construção: chamar duas vezes não duplica
   * a fila, porque a chave de idempotência das mensagens colide.
   */
  async iniciarCampanha(campaignId, corpo) {
    const dados = extrair(corpo || {}, {
      contactIds: { tipo: 'lista', max: 5000, item: { tipo: 'id' } }
    });
    const k = await this.repo.lerCampanha(campaignId);
    if (!k) throw new RepositoryError('NOT_FOUND', 'Campanha não encontrada.');
    if (k.status === CAMPAIGN_STATUS.CANCELLED || k.status === CAMPAIGN_STATUS.COMPLETED) {
      throw new RepositoryError('CAMPAIGN_TERMINAL', 'Campanha em estado terminal: ' + k.status + '.');
    }

    let ids = dados.contactIds;
    if (!ids || !ids.length) {
      const { items } = await this.repo.listarContactos({ limit: 5000, offset: 0 });
      ids = items.map(c => c.id);
    }
    if (!ids.length) throw new ValidationError('Escolha pelo menos um contacto.', 'contactIds');

    const resumo = await this.repo.iniciarCampanha(campaignId, ids);
    if (!resumo.incluidos && !resumo.jaExistiam) {
      throw new ValidationError('Nenhum dos contactos escolhidos pode receber esta campanha.');
    }
    await this.auditar(AUDIT_ACTION.CAMPAIGN_STARTED, 'campaign', campaignId, resumo);
    return resumo;
  }

  async pausarCampanha(id) {
    const k = await this.repo.lerCampanha(id);
    if (!k) throw new RepositoryError('NOT_FOUND', 'Campanha não encontrada.');
    exigirTransicao(k.status, CAMPAIGN_STATUS.PAUSED);
    const n = await this.repo.pausarCampanha(id);
    await this.auditar(AUDIT_ACTION.CAMPAIGN_PAUSED, 'campaign', id, { itensPausados: n });
    return n;
  }

  async retomarCampanha(id) {
    const k = await this.repo.lerCampanha(id);
    if (!k) throw new RepositoryError('NOT_FOUND', 'Campanha não encontrada.');
    exigirTransicao(k.status, CAMPAIGN_STATUS.RUNNING);
    const n = await this.repo.retomarCampanha(id);
    await this.auditar(AUDIT_ACTION.CAMPAIGN_RESUMED, 'campaign', id, { itensRetomados: n });
    return n;
  }

  async cancelarCampanha(id) {
    const k = await this.repo.lerCampanha(id);
    if (!k) throw new RepositoryError('NOT_FOUND', 'Campanha não encontrada.');
    exigirTransicao(k.status, CAMPAIGN_STATUS.CANCELLED);
    const n = await this.repo.cancelarCampanha(id);
    await this.auditar(AUDIT_ACTION.CAMPAIGN_CANCELLED, 'campaign', id, { itensCancelados: n });
    return n;
  }

  /* ---------- fila e auditoria ---------- */

  listarFila(opts) { return this.repo.listarFila(opts); }
  listarAuditoria(opts) { return this.repo.listarAuditoria(opts); }

  /** Estado do subsistema, sem revelar configuração sensível (§75/§76). */
  async estado() {
    const db = await this.repo.disponivel();
    return {
      environment: ambienteDe(this.env),
      databaseConfigured: db,
      mockAllowed: mockPermitido(this.env),
      maxAccounts: MAX_ACCOUNTS
    };
  }
}

/**
 * LeadMap Pro — RemoteOutreachStore (Fase C)
 * ==========================================
 * Implementação de `OutreachStore` que fala com /api/outreach/* em vez
 * de localStorage. A UI passa a poder trocar de armazenamento sem saber
 * onde os dados vivem.
 *
 * O browser nunca vê credenciais: a sessão viaja em cookie HttpOnly, que
 * o JavaScript não consegue ler, e todas as chamadas usam
 * `credentials: 'same-origin'`.
 */

import { OutreachStore } from './store.mjs';

export class RemoteOutreachStore extends OutreachStore {
  constructor({ baseUrl = '/api/outreach', fetchImpl = null } = {}) {
    super();
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.ultimoErro = null;
    this.estadoSessao = { authenticated: false, configured: false, databaseConfigured: false };
  }

  async pedir(caminho, { metodo = 'GET', corpo = null } = {}) {
    const f = this.fetchImpl || globalThis.fetch;
    const resp = await f(this.baseUrl + caminho, {
      method: metodo,
      credentials: 'same-origin',              /* o cookie HttpOnly acompanha */
      headers: corpo ? { 'Content-Type': 'application/json' } : {},
      body: corpo ? JSON.stringify(corpo) : undefined
    });
    let json = null;
    try { json = await resp.json(); } catch (e) { json = null; }
    if (!resp.ok || (json && json.success === false)) {
      const err = new Error((json && json.message) || ('HTTP ' + resp.status));
      err.errorCode = (json && json.errorCode) || 'HTTP_' + resp.status;
      err.status = resp.status;
      throw err;
    }
    return json || {};
  }

  /** Diz se o backend está pronto — a UI usa isto para não fingir nada. */
  async estado() {
    try {
      const r = await this.pedir('/session');
      this.estadoSessao = {
        authenticated: Boolean(r.authenticated),
        configured: Boolean(r.configured),
        databaseConfigured: Boolean(r.databaseConfigured),
        environment: r.environment || null,
        subject: r.subject || null
      };
      this.ultimoErro = null;
    } catch (err) {
      this.ultimoErro = err.message;
      this.estadoSessao = { authenticated: false, configured: false, databaseConfigured: false };
    }
    return this.estadoSessao;
  }

  entrar(email, password) { return this.pedir('/session', { metodo: 'POST', corpo: { email, password } }); }
  sair() { return this.pedir('/session', { metodo: 'DELETE' }); }

  listarContactos(opts = {}) { return this.pedir('/contacts?' + new URLSearchParams(opts)); }
  importarContactos(contacts) { return this.pedir('/contacts', { metodo: 'POST', corpo: { contacts } }); }

  listarTemplates(opts = {}) { return this.pedir('/templates?' + new URLSearchParams(opts)); }
  criarTemplate(dados) { return this.pedir('/templates', { metodo: 'POST', corpo: dados }); }
  atualizarTemplate(id, dados) { return this.pedir('/templates?id=' + encodeURIComponent(id), { metodo: 'PATCH', corpo: dados }); }
  apagarTemplate(id) { return this.pedir('/templates?id=' + encodeURIComponent(id), { metodo: 'DELETE' }); }

  listarContas() { return this.pedir('/accounts'); }
  criarConta(dados) { return this.pedir('/accounts', { metodo: 'POST', corpo: dados }); }

  listarCampanhas(opts = {}) { return this.pedir('/campaigns?' + new URLSearchParams(opts)); }
  lerCampanha(id) { return this.pedir('/campaigns?id=' + encodeURIComponent(id)); }
  criarCampanha(dados) { return this.pedir('/campaigns', { metodo: 'POST', corpo: dados }); }
  accaoCampanha(id, accao, corpo = {}) {
    return this.pedir('/campaigns?id=' + encodeURIComponent(id) + '&action=' + encodeURIComponent(accao), { metodo: 'POST', corpo });
  }

  listarFila(opts = {}) { return this.pedir('/queue?' + new URLSearchParams(opts)); }
  listarAuditoria(opts = {}) { return this.pedir('/audit?' + new URLSearchParams(opts)); }

  /* Contrato do OutreachStore: no modo remoto o estado vive no servidor. */
  load() { return { versao: 2, remoto: true, contactos: [], contas: [], templates: [], campanhas: [], fila: [], mensagens: [], seq: 0 }; }
  save() { return null; }
  clear() { return null; }
}

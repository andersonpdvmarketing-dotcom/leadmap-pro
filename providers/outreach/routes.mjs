/**
 * LeadMap Pro — handlers das rotas do Outreach
 * ============================================
 * Os handlers viviam um por ficheiro em `api/outreach/`. Cada ficheiro
 * ali é uma Serverless Function, e oito delas estouraram o teto do plano
 * — o build falhava por inteiro, sem chegar sequer a servir os ficheiros
 * estáticos. Os handlers passaram para aqui **sem alteração de lógica**;
 * `api/outreach/[...rota].js` é o único ficheiro em `api/` e limita-se a
 * escolher qual chamar.
 *
 * A autenticação, a autorização, o repositório e o formato dos erros
 * continuam onde sempre estiveram: dentro de `rota()`, em `http.mjs`.
 * Este módulo não repete nenhuma regra de negócio.
 */

import { rota, corpoDe, idDoPedido, responderErro, construirRepositorio } from './http.mjs';
import {
  autenticarOperador, cookieDeSessao, cookieDeLogout, exigirSessao,
  authConfigurada, exigirSegredoDoWorker, AuthError
} from './auth.mjs';
import { OutreachService } from './service.mjs';
import { ambienteDe, mockPermitido } from './domain.mjs';
import { OutreachWorker, novoWorkerId } from './worker.mjs';
import { MockInstagramProvider } from '../instagram/index.mjs';

/* ---------------------------------------------------------------- *
 * session                                                           *
 * ---------------------------------------------------------------- */

/**
 * POST   → login (cria sessão HttpOnly)
 * DELETE → logout
 * GET    → estado da sessão e do subsistema
 *
 * A password do OPERADOR do LeadMap é verificada contra um hash scrypt
 * guardado em variável de ambiente. Nunca há password de Instagram aqui.
 */
export async function session(req, res) {
  const requestId = idDoPedido(req);
  const env = process.env;
  const seguro = ambienteDe(env) === 'production';
  try {
    if (req.method === 'POST') {
      const { email, password } = corpoDe(req);
      const token = autenticarOperador({ email, password }, env);
      res.setHeader('Set-Cookie', cookieDeSessao(token, { seguro }));
      return res.status(200).json({ success: true, requestId });
    }
    if (req.method === 'DELETE') {
      res.setHeader('Set-Cookie', cookieDeLogout({ seguro }));
      return res.status(200).json({ success: true, requestId });
    }
    if (req.method === 'GET') {
      if (!authConfigurada(env)) {
        return res.status(200).json({ success: true, authenticated: false, configured: false, requestId });
      }
      let sessao = null;
      try { sessao = exigirSessao(req, env); } catch (e) { sessao = null; }
      const repo = construirRepositorio(env);
      const estado = repo ? await new OutreachService({ repository: repo, env }).estado() : { databaseConfigured: false };
      return res.status(200).json({
        success: true, authenticated: Boolean(sessao), configured: true,
        subject: sessao ? sessao.sub : null, ...estado, requestId
      });
    }
    return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', requestId });
  } catch (err) {
    return responderErro(res, err, requestId, env);
  }
}

/* ---------------------------------------------------------------- *
 * contactos                                                         *
 * ---------------------------------------------------------------- */

/** GET lista contactos (paginado) · POST importa contactos. */
export const contacts = rota({
  metodos: ['GET', 'POST'],
  handler: async ({ req, service, pagina }) => {
    if (req.method === 'GET') {
      const r = await service.listarContactos({ ...pagina, status: (req.query && req.query.status) || null });
      return { total: r.total, items: r.items, limit: pagina.limit, offset: pagina.offset };
    }
    return { resumo: await service.importarContactos(corpoDe(req)) };
  }
});

/* ---------------------------------------------------------------- *
 * templates                                                         *
 * ---------------------------------------------------------------- */

/** GET lista · POST cria · PATCH atualiza · DELETE apaga (soft). */
export const templates = rota({
  metodos: ['GET', 'POST', 'PATCH', 'DELETE'],
  handler: async ({ req, service, pagina }) => {
    const id = req.query && req.query.id;
    if (req.method === 'GET') {
      const r = await service.listarTemplates(pagina);
      return { total: r.total, items: r.items, limit: pagina.limit, offset: pagina.offset };
    }
    if (req.method === 'POST') return { template: await service.criarTemplate(corpoDe(req)) };
    if (!id) { const e = new Error('Falta o parâmetro id.'); e.errorCode = 'INVALID_REQUEST'; throw e; }
    if (req.method === 'PATCH') return { template: await service.atualizarTemplate(id, corpoDe(req)) };
    return { apagado: await service.apagarTemplate(id) };
  }
});

/* ---------------------------------------------------------------- *
 * contas Instagram                                                  *
 * ---------------------------------------------------------------- */

/** GET lista contas · POST liga uma conta (teto de 5 aplicado no backend). */
export const accounts = rota({
  metodos: ['GET', 'POST'],
  handler: async ({ req, service }) => {
    if (req.method === 'GET') return { items: await service.listarContas() };
    return { account: await service.criarConta(corpoDe(req)) };
  }
});

/* ---------------------------------------------------------------- *
 * campanhas                                                         *
 * ---------------------------------------------------------------- */

const ACOES = ['start', 'pause', 'resume', 'cancel'];

/**
 * GET  ?id=…            → detalhe de uma campanha (com KPIs da fila)
 * GET                    → lista paginada
 * POST                   → cria campanha
 * POST ?id=…&action=…    → start | pause | resume | cancel
 *
 * `start` é idempotente: chamar duas vezes não duplica a fila.
 */
export const campaigns = rota({
  metodos: ['GET', 'POST'],
  handler: async ({ req, service, pagina }) => {
    const id = req.query && req.query.id;
    const accao = req.query && req.query.action;

    if (req.method === 'GET') {
      if (id) {
        const campaign = await service.lerCampanha(id);
        if (!campaign) { const e = new Error('Campanha não encontrada.'); e.errorCode = 'NOT_FOUND'; throw e; }
        const fila = await service.listarFila({ campaignId: id, limit: 1000, offset: 0 });
        const conta = (n) => fila.items.filter(i => i.status === n).length;
        return {
          campaign,
          kpis: {
            total: fila.total,
            pendentes: conta('PENDING') + conta('PAUSED'),
            processando: conta('PROCESSING'),
            enviados: conta('SENT'),
            falhas: conta('FAILED'),
            ignorados: conta('SKIPPED'),
            cancelados: conta('CANCELLED')
          }
        };
      }
      const r = await service.listarCampanhas(pagina);
      return { total: r.total, items: r.items, limit: pagina.limit, offset: pagina.offset };
    }

    if (!accao) return { campaign: await service.criarCampanha(corpoDe(req)) };

    if (!id) { const e = new Error('Falta o parâmetro id.'); e.errorCode = 'INVALID_REQUEST'; throw e; }
    if (!ACOES.includes(accao)) { const e = new Error('Ação inválida.'); e.errorCode = 'INVALID_REQUEST'; throw e; }

    if (accao === 'start') return { resumo: await service.iniciarCampanha(id, corpoDe(req)) };
    if (accao === 'pause') return { itens: await service.pausarCampanha(id) };
    if (accao === 'resume') return { itens: await service.retomarCampanha(id) };
    return { itens: await service.cancelarCampanha(id) };
  }
});

/* ---------------------------------------------------------------- *
 * fila                                                              *
 * ---------------------------------------------------------------- */

/** GET fila paginada, filtrável por campanha e estado. */
export const queue = rota({
  metodos: ['GET'],
  handler: async ({ req, service, pagina }) => {
    const r = await service.listarFila({
      campaignId: (req.query && req.query.campaignId) || null,
      status: (req.query && req.query.status) || null,
      ...pagina
    });
    return { total: r.total, items: r.items, limit: pagina.limit, offset: pagina.offset };
  }
});

/* ---------------------------------------------------------------- *
 * auditoria                                                         *
 * ---------------------------------------------------------------- */

/** GET auditoria paginada — só para quem tem o papel de administração. */
export const audit = rota({
  metodos: ['GET'],
  papel: 'outreach:admin',
  handler: async ({ req, service, pagina }) => {
    const r = await service.listarAuditoria({
      entityId: (req.query && req.query.entityId) || null,
      action: (req.query && req.query.action) || null,
      ...pagina
    });
    return { total: r.total, items: r.items, limit: pagina.limit, offset: pagina.offset };
  }
});

/* ---------------------------------------------------------------- *
 * worker                                                            *
 * ---------------------------------------------------------------- */

/**
 * POST — processa um lote da fila. NÃO é uma rota de browser: exige o
 * segredo OUTREACH_WORKER_SECRET num cabeçalho e não aceita sessão de
 * utilizador.
 *
 * Nesta fase o worker usa um fornecedor controlado e NÃO envia nada para
 * a Meta nem para o Instagram. Em produção, sem fornecedor real
 * configurado, recusa-se a correr em vez de simular envios.
 */
export async function worker(req, res) {
  const requestId = idDoPedido(req);
  const env = process.env;
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', requestId });
    }
    exigirSegredoDoWorker(req, env);

    const repo = construirRepositorio(env);
    if (!repo) throw new AuthError(503, 'NOT_CONFIGURED', 'Base de dados do Outreach não configurada.');

    /* Em produção não há fornecedor real aprovado: o worker não corre.
       Nunca se apresenta um envio de teste como envio verdadeiro. */
    if (!mockPermitido(env)) {
      return res.status(503).json({
        success: false, errorCode: 'PROVIDER_NOT_AVAILABLE',
        message: 'Nenhum fornecedor de envio aprovado para produção. O worker não processa a fila.',
        requestId
      });
    }

    const { limit } = corpoDe(req);
    const w = new OutreachWorker({
      repository: repo,
      provider: new MockInstagramProvider({ script: {} }),
      workerId: novoWorkerId('api')
    });
    const resumo = await w.processar({ limit: Math.min(Number(limit) || 10, 100) });
    return res.status(200).json({ success: true, environment: ambienteDe(env), workerId: w.workerId, resumo, requestId });
  } catch (err) {
    return responderErro(res, err, requestId, env);
  }
}

/* ---------------------------------------------------------------- *
 * Tabela de despacho                                                *
 * ---------------------------------------------------------------- */

/** Nome do último segmento de `/api/outreach/<nome>` → handler. */
export const ROTAS = Object.freeze({
  session, contacts, templates, accounts, campaigns, queue, audit, worker
});

/**
 * Extrai o nome da rota do pedido.
 *
 * A Vercel entrega os segmentos do catch-all em `req.query.rota`. O
 * fallback pelo URL existe para proxies e para os testes, que constroem
 * o pedido à mão.
 */
export function nomeDaRota(req) {
  const q = req && req.query && req.query.rota;
  if (Array.isArray(q)) return q.join('/');
  if (typeof q === 'string' && q) return q;

  const url = (req && req.url) || '';
  const caminho = url.split('?')[0].replace(/\/+$/, '');
  const m = caminho.match(/\/api\/outreach\/(.+)$/);
  return m ? m[1] : '';
}

/**
 * Despacha um pedido para o handler certo.
 *
 * Um nome desconhecido devolve 404 no mesmo formato de erro das outras
 * respostas — nunca uma exceção por chamar `undefined`.
 */
export async function despachar(req, res) {
  const nome = nomeDaRota(req);
  const handler = Object.prototype.hasOwnProperty.call(ROTAS, nome) ? ROTAS[nome] : null;
  if (!handler) {
    return res.status(404).json({
      success: false, errorCode: 'NOT_FOUND',
      message: 'Rota de Outreach desconhecida.',
      requestId: idDoPedido(req)
    });
  }
  return handler(req, res);
}

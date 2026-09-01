/**
 * LeadMap Pro — plumbing HTTP do Outreach (Fase C)
 * ================================================
 * Fábrica partilhada pelas rotas: monta o repositório certo para o
 * ambiente, aplica autenticação/autorização e normaliza as respostas de
 * erro. Assim cada rota fica com uma dúzia de linhas e nenhuma delas
 * repete regras de segurança.
 */

import { InMemoryOutreachRepository } from './repository.mjs';
import { PostgresOutreachRepository, bancoConfigurado } from './postgres.mjs';
import { OutreachService } from './service.mjs';
import { exigirSessao, exigirPapel, AuthError, authConfigurada } from './auth.mjs';
import { ambienteDe, redigir, paginacao } from './domain.mjs';

/** Repositório partilhado por invocação (serverless: nada crítico em RAM). */
export function construirRepositorio(env = process.env, deps = {}) {
  if (bancoConfigurado(env)) return new PostgresOutreachRepository({}, { env, fetch: deps.fetch });
  /* Sem banco configurado NÃO se cai para memória em produção: seria
     fingir que há persistência. Fora de produção, o repositório em
     memória permite trabalhar sem infraestrutura. */
  if (ambienteDe(env) === 'production') return null;
  if (!globalThis.__outreachMemRepo) globalThis.__outreachMemRepo = new InMemoryOutreachRepository();
  return globalThis.__outreachMemRepo;
}

export function idDoPedido(req) {
  return (req && req.headers && (req.headers['x-vercel-id'] || req.headers['x-request-id']))
    || ('req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
}

/** Formato único de erro; nunca inclui stack trace em produção (§74). */
export function responderErro(res, err, requestId, env = process.env) {
  const status = err && err.status ? err.status
    : (err && err.errorCode === 'NOT_CONFIGURED') ? 503
    : (err && err.errorCode === 'NOT_FOUND') ? 404
    : (err && (err.errorCode === 'DUPLICATE' || err.errorCode === 'MAX_ACCOUNTS' || err.errorCode === 'INVALID_REQUEST'
        || err.errorCode === 'INVALID_TRANSITION' || err.errorCode === 'CAMPAIGN_TERMINAL')) ? 409
    : 500;
  const corpo = {
    success: false,
    errorCode: (err && err.errorCode) || 'INTERNAL',
    message: (err && err.message) ? String(err.message) : 'Erro inesperado.',
    requestId
  };
  if (ambienteDe(env) !== 'production' && err && err.stack) corpo.stack = String(err.stack).split('\n').slice(0, 4);
  /* log estruturado, com segredos redigidos (§73) */
  console.error(JSON.stringify(redigir({
    level: 'error', requestId, errorCode: corpo.errorCode, message: corpo.message
  })));
  return res.status(status).json(corpo);
}

export function responderOk(res, dados, requestId) {
  return res.status(200).json({ success: true, requestId, ...dados });
}

/**
 * Envolve um handler: método permitido, sessão, papel, repositório e
 * tratamento de erros. Uma rota nova não pode esquecer-se da auth,
 * porque a auth está aqui e não na rota.
 */
export function rota({ metodos = ['GET'], papel = 'outreach:operator', handler }) {
  return async function (req, res) {
    const requestId = idDoPedido(req);
    try {
      if (!metodos.includes(req.method)) {
        return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', message: 'Método não permitido.', requestId });
      }
      const env = process.env;
      if (!authConfigurada(env)) {
        throw new AuthError(503, 'NOT_CONFIGURED', 'Autenticação do Outreach não configurada no backend.');
      }
      const sessao = exigirSessao(req, env);        /* 401 */
      exigirPapel(sessao, papel);                   /* 403 */

      const repo = construirRepositorio(env);
      if (!repo) {
        throw new AuthError(503, 'NOT_CONFIGURED', 'Base de dados do Outreach não configurada.');
      }
      const service = new OutreachService({ repository: repo, actor: sessao.sub, env });
      const dados = await handler({ req, res, service, repo, sessao, requestId, pagina: paginacao(req.query || {}) });
      if (res.writableEnded) return undefined;
      return responderOk(res, dados || {}, requestId);
    } catch (err) {
      return responderErro(res, err, requestId);
    }
  };
}

/** Corpo JSON tolerante: a Vercel entrega objeto; um proxy pode entregar texto. */
export function corpoDe(req) {
  const b = req && req.body;
  if (!b) return {};
  if (typeof b === 'string') { try { return JSON.parse(b); } catch (e) { return {}; } }
  return b;
}

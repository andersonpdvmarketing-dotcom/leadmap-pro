/**
 * POST /api/outreach/session   → login (cria sessão HttpOnly)
 * DELETE /api/outreach/session → logout
 * GET  /api/outreach/session   → estado da sessão e do subsistema
 *
 * A password do OPERADOR do LeadMap é verificada contra um hash scrypt
 * guardado em variável de ambiente. Nunca há password de Instagram aqui.
 */
import { autenticarOperador, cookieDeSessao, cookieDeLogout, exigirSessao, authConfigurada, AuthError } from '../../providers/outreach/auth.mjs';
import { construirRepositorio, corpoDe, idDoPedido, responderErro } from '../../providers/outreach/http.mjs';
import { OutreachService } from '../../providers/outreach/service.mjs';
import { ambienteDe } from '../../providers/outreach/domain.mjs';

export default async function handler(req, res) {
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

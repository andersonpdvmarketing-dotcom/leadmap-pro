/** GET auditoria paginada — só para quem tem o papel de administração. */
import { rota } from '../../providers/outreach/http.mjs';

export default rota({
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

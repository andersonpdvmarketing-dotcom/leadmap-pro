/** GET fila paginada, filtrável por campanha e estado. */
import { rota } from '../../providers/outreach/http.mjs';

export default rota({
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

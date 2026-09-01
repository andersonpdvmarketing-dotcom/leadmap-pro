/** GET lista contactos (paginado) · POST importa contactos. */
import { rota, corpoDe } from '../../providers/outreach/http.mjs';

export default rota({
  metodos: ['GET', 'POST'],
  handler: async ({ req, service, pagina }) => {
    if (req.method === 'GET') {
      const r = await service.listarContactos({ ...pagina, status: (req.query && req.query.status) || null });
      return { total: r.total, items: r.items, limit: pagina.limit, offset: pagina.offset };
    }
    return { resumo: await service.importarContactos(corpoDe(req)) };
  }
});

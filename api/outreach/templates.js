/** GET lista · POST cria · PATCH atualiza · DELETE apaga (soft). */
import { rota, corpoDe } from '../../providers/outreach/http.mjs';

export default rota({
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

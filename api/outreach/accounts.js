/** GET lista contas · POST liga uma conta (teto de 5 aplicado no backend). */
import { rota, corpoDe } from '../../providers/outreach/http.mjs';

export default rota({
  metodos: ['GET', 'POST'],
  handler: async ({ req, service }) => {
    if (req.method === 'GET') return { items: await service.listarContas() };
    return { account: await service.criarConta(corpoDe(req)) };
  }
});

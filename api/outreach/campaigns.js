/**
 * GET  ?id=…            → detalhe de uma campanha (com KPIs da fila)
 * GET                    → lista paginada
 * POST                   → cria campanha
 * POST ?id=…&action=…    → start | pause | resume | cancel
 *
 * `start` é idempotente: chamar duas vezes não duplica a fila.
 */
import { rota, corpoDe } from '../../providers/outreach/http.mjs';

const ACOES = ['start', 'pause', 'resume', 'cancel'];

export default rota({
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

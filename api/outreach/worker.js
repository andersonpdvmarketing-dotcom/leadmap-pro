/**
 * POST /api/outreach/worker
 * =========================
 * Processa um lote da fila. NÃO é uma rota de browser: exige o segredo
 * OUTREACH_WORKER_SECRET num cabeçalho e não aceita sessão de utilizador.
 *
 * Nesta fase o worker usa um fornecedor controlado e NÃO envia nada para
 * a Meta nem para o Instagram. Em produção, sem fornecedor real
 * configurado, recusa-se a correr em vez de simular envios.
 */
import { exigirSegredoDoWorker, AuthError } from '../../providers/outreach/auth.mjs';
import { construirRepositorio, corpoDe, idDoPedido, responderErro } from '../../providers/outreach/http.mjs';
import { OutreachWorker, novoWorkerId } from '../../providers/outreach/worker.mjs';
import { ambienteDe, mockPermitido } from '../../providers/outreach/domain.mjs';
import { MockInstagramProvider } from '../../providers/instagram/index.mjs';

export default async function handler(req, res) {
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
    const worker = new OutreachWorker({
      repository: repo,
      provider: new MockInstagramProvider({ script: {} }),
      workerId: novoWorkerId('api')
    });
    const resumo = await worker.processar({ limit: Math.min(Number(limit) || 10, 100) });
    return res.status(200).json({ success: true, environment: ambienteDe(env), workerId: worker.workerId, resumo, requestId });
  } catch (err) {
    return responderErro(res, err, requestId, env);
  }
}

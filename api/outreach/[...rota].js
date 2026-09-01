/**
 * /api/outreach/*  —  única Serverless Function do Outreach
 * =========================================================
 * O plano da Vercel tem um teto de Serverless Functions por deployment.
 * Oito ficheiros em `api/outreach/` eram oito funções e faziam o build
 * falhar por inteiro. Este catch-all é uma só função e serve todos os
 * endpoints, com os URLs públicos inalterados:
 *
 *   /api/outreach/session    /api/outreach/campaigns
 *   /api/outreach/contacts   /api/outreach/queue
 *   /api/outreach/templates  /api/outreach/audit
 *   /api/outreach/accounts   /api/outreach/worker
 *
 * O ficheiro não decide nada: escolhe o handler pelo nome da rota. As
 * regras — sessão, papéis, segredo do worker, validação, formato dos
 * erros — vivem em `providers/outreach/routes.mjs` e `http.mjs`, os
 * mesmos módulos de antes.
 */
import { despachar } from '../../providers/outreach/routes.mjs';

export default async function handler(req, res) {
  return despachar(req, res);
}

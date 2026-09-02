/**
 * LeadMap Pro — verificação criptográfica dos webhooks da Meta
 * ============================================================
 * Vive fora de `meta.mjs` por uma razão concreta: o browser importa a
 * árvore de `providers/instagram/index.mjs` para a interface do
 * Outreach, e um `import 'node:crypto'` nessa árvore faz o navegador
 * recusar o módulo inteiro — a UI do Outreach morre com um erro de CORS
 * que não parece ter nada a ver.
 *
 * Verificar assinaturas é trabalho de servidor. Fica aqui, e só o
 * backend importa este ficheiro.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError } from './contract.mjs';

/**
 * Handshake de subscrição (§16). Devolve o `hub.challenge` só quando o
 * verify token bate certo.
 */
export function verificarSubscricao(provider, query = {}) {
  const modo = query['hub.mode'] || query.hub_mode;
  const token = query['hub.verify_token'] || query.hub_verify_token;
  const desafio = query['hub.challenge'] || query.hub_challenge;
  if (!provider.verifyToken) {
    throw new ProviderError('NOT_CONFIGURED', 'INSTAGRAM_META_VERIFY_TOKEN não configurado.');
  }
  const a = Buffer.from(String(token || ''), 'utf8');
  const b = Buffer.from(provider.verifyToken, 'utf8');
  const igual = a.length === b.length && timingSafeEqual(a, b);
  if (modo !== 'subscribe' || !igual) {
    throw new ProviderError('INVALID_TOKEN', 'Verify token do webhook não corresponde.');
  }
  return String(desafio || '');
}

/**
 * Valida a assinatura de um payload de webhook.
 *
 * A Meta assina o corpo com o App Secret e envia em
 * `X-Hub-Signature-256: sha256=…`. Sem esta verificação, qualquer um
 * que descubra o URL pode injetar "mensagens recebidas" e abrir
 * janelas de resposta que nunca existiram.
 *
 * O corpo tem de ser o texto **em bruto**: reserializar o JSON muda
 * bytes e a assinatura deixa de bater.
 */
export function verificarAssinatura(provider, corpoBruto, cabecalho) {
  if (!provider.appSecret) {
    throw new ProviderError('NOT_CONFIGURED', 'INSTAGRAM_META_APP_SECRET não configurado.');
  }
  const recebida = String(cabecalho || '');
  if (!recebida.startsWith('sha256=')) {
    throw new ProviderError('INVALID_REQUEST', 'Assinatura de webhook em falta ou com formato inesperado.');
  }
  const esperada = 'sha256=' + createHmac('sha256', provider.appSecret)
    .update(typeof corpoBruto === 'string' ? corpoBruto : String(corpoBruto), 'utf8').digest('hex');
  const a = Buffer.from(recebida, 'utf8');
  const b = Buffer.from(esperada, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ProviderError('INVALID_TOKEN', 'Assinatura de webhook inválida.');
  }
  return true;
}


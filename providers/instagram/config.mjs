/**
 * LeadMap Pro — configuração de fornecedores (só backend)
 * =======================================================
 * Lê as variáveis de ambiente e constrói o registo. Este ficheiro só
 * corre no servidor: nenhum valor aqui pode chegar ao browser, e a
 * única coisa que sai para o frontend é `vistaPublica()`, que não
 * transporta credenciais.
 *
 * Nenhum valor real é definido aqui — apenas nomes de variáveis (§12/§19).
 *
 *   INSTAGRAM_META_ACCESS_TOKEN      token da App Meta
 *   INSTAGRAM_META_APP_SECRET        assinatura de webhooks
 *   INSTAGRAM_META_VERIFY_TOKEN      handshake de subscrição
 *   INSTAGRAM_META_GRAPH_VERSION     opcional (por omissão v21.0)
 *   INSTAGRAM_META_ENABLED_FOR_REAL_REQUESTS  "1" levanta o bloqueio do
 *                                    adapter da Meta — só depois de validar
 *                                    os endpoints na documentação oficial
 *
 *   MANYCHAT_API_TOKEN               token da ManyChat, formato
 *                                    `<pageId>:<segredo>` — só no backend
 *
 *   INSTAGRAM_EXTERNAL_PROVIDER      nome do fornecedor (para o UI)
 *   INSTAGRAM_EXTERNAL_BASE_URL      origem HTTPS da API
 *   INSTAGRAM_EXTERNAL_API_KEY       credencial
 *   INSTAGRAM_EXTERNAL_ACCOUNT_ID    conta por omissão (opcional)
 *   INSTAGRAM_EXTERNAL_CAPABILITIES  ex.: "canSendMessage,canFetchProfile"
 *   INSTAGRAM_EXTERNAL_PATHS         JSON opcional com caminhos alternativos
 *
 *   OUTREACH_MAX_PER_HOUR            limite interno por conta
 *   OUTREACH_MAX_PER_DAY             limite interno por conta
 *   OUTREACH_ENABLE_MOCK             "1" para registar o fornecedor mock
 */

import { InstagramRegistry } from './registry.mjs';
import { MetaInstagramProvider } from './meta.mjs';
import { ExternalInstagramProvider } from './external.mjs';
import { ManyChatInstagramProvider } from './manychat.mjs';
import { MockInstagramProvider } from './mock.mjs';
import { OutreachAudit } from './audit.mjs';
import { OutreachQueue, LIMITES_PADRAO } from './queue.mjs';
import { CAPABILITIES } from './contract.mjs';

function inteiro(bruto, omissao) {
  const n = Number(bruto);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : omissao;
}

function capacidadesDeLista(bruto) {
  if (!bruto) return {};
  const pedidas = String(bruto).split(',').map(s => s.trim()).filter(Boolean);
  const mapa = {};
  for (const c of pedidas) if (CAPABILITIES.includes(c)) mapa[c] = true;
  return mapa;
}

function jsonOuNulo(bruto) {
  if (!bruto) return null;
  try { return JSON.parse(bruto); } catch (e) { return null; }
}

/** Limites internos, com os valores por omissão como teto de segurança. */
export function lerLimites(env = process.env) {
  return {
    OUTREACH_MAX_PER_HOUR: inteiro(env.OUTREACH_MAX_PER_HOUR, LIMITES_PADRAO.OUTREACH_MAX_PER_HOUR),
    OUTREACH_MAX_PER_DAY: inteiro(env.OUTREACH_MAX_PER_DAY, LIMITES_PADRAO.OUTREACH_MAX_PER_DAY)
  };
}

/**
 * Constrói o registo a partir do ambiente. Fornecedores sem configuração
 * são na mesma registados — aparecem no UI como "não configurados", que
 * é mais útil do que desaparecerem sem explicação.
 */
export function construirRegistry(env = process.env, deps = {}) {
  const registry = new InstagramRegistry();

  registry.register(new MetaInstagramProvider({
    accessToken: env.INSTAGRAM_META_ACCESS_TOKEN || null,
    appSecret: env.INSTAGRAM_META_APP_SECRET || null,
    verifyToken: env.INSTAGRAM_META_VERIFY_TOKEN || null,
    graphVersion: env.INSTAGRAM_META_GRAPH_VERSION || undefined,
    /* Bloqueado por omissão. Só levantar depois de validar os endpoints
       da Graph API contra a documentação oficial (ver INSTAGRAM_PROVIDERS.md). */
    enabledForRealRequests: env.INSTAGRAM_META_ENABLED_FOR_REAL_REQUESTS === '1'
  }, deps));

  /* ManyChat: fornecedor real. Sem token fica registado à mesma, como
     "não configurado" — desaparecer do UI sem explicação é pior. */
  registry.register(new ManyChatInstagramProvider({
    apiToken: env.MANYCHAT_API_TOKEN || null,
    fetchImpl: deps.fetch || null
  }));

  if (env.INSTAGRAM_EXTERNAL_PROVIDER || env.INSTAGRAM_EXTERNAL_BASE_URL) {
    /* Se a configuração externa for não conforme, o construtor lança:
       o fornecedor não é registado e o erro fica visível na configuração,
       em vez de o sistema arrancar com uma integração proibida. */
    registry.register(new ExternalInstagramProvider({
      providerName: env.INSTAGRAM_EXTERNAL_PROVIDER || 'External',
      baseUrl: env.INSTAGRAM_EXTERNAL_BASE_URL || null,
      apiKey: env.INSTAGRAM_EXTERNAL_API_KEY || null,
      accountId: env.INSTAGRAM_EXTERNAL_ACCOUNT_ID || null,
      capabilities: capacidadesDeLista(env.INSTAGRAM_EXTERNAL_CAPABILITIES),
      paths: jsonOuNulo(env.INSTAGRAM_EXTERNAL_PATHS)
    }, deps));
  }

  if (env.OUTREACH_ENABLE_MOCK === '1') {
    registry.register(new MockInstagramProvider());
  }

  return registry;
}

/** Fila pronta a usar, com auditoria e limites do ambiente. */
export function construirFila(registry, env = process.env) {
  const audit = new OutreachAudit();
  const queue = new OutreachQueue({ registry, limites: lerLimites(env), audit });
  return { queue, audit };
}

/**
 * Vista para Outreach > Configurações > Providers. Diz que fornecedores
 * existem, o que sabem fazer e se estão configurados — sem nunca
 * transportar baseUrl privado, token ou API key.
 */
export function vistaPublica(registry, env = process.env) {
  return {
    limites: lerLimites(env),
    maxContas: 5,
    providers: registry.listProviders().map(p => ({
      id: p.id,
      displayName: p.displayName,
      capabilities: p.capabilities,
      configured: p.configured,
      /* nomes das variáveis em falta — nunca os valores */
      missingEnv: variaveisEmFalta(p.id, env)
    }))
  };
}

function variaveisEmFalta(providerId, env) {
  const falta = [];
  if (providerId === 'meta') {
    if (!env.INSTAGRAM_META_ACCESS_TOKEN) falta.push('INSTAGRAM_META_ACCESS_TOKEN');
    if (env.INSTAGRAM_META_ENABLED_FOR_REAL_REQUESTS !== '1') {
      falta.push('INSTAGRAM_META_ENABLED_FOR_REAL_REQUESTS (bloqueado: endpoints por validar)');
    }
  } else if (providerId === 'manychat') {
    if (!env.MANYCHAT_API_TOKEN) falta.push('MANYCHAT_API_TOKEN');
  } else if (providerId.startsWith('external')) {
    if (!env.INSTAGRAM_EXTERNAL_BASE_URL) falta.push('INSTAGRAM_EXTERNAL_BASE_URL');
    if (!env.INSTAGRAM_EXTERNAL_API_KEY) falta.push('INSTAGRAM_EXTERNAL_API_KEY');
  }
  return falta;
}

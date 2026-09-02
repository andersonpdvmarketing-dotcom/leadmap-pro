/**
 * LeadMap Pro — handlers das rotas do Outreach
 * ============================================
 * Os handlers viviam um por ficheiro em `api/outreach/`. Cada ficheiro
 * ali é uma Serverless Function, e oito delas estouraram o teto do plano
 * — o build falhava por inteiro, sem chegar sequer a servir os ficheiros
 * estáticos. Os handlers passaram para aqui **sem alteração de lógica**;
 * `api/outreach/[...rota].mjs` é o único ficheiro em `api/` e limita-se a
 * escolher qual chamar.
 *
 * A autenticação, a autorização, o repositório e o formato dos erros
 * continuam onde sempre estiveram: dentro de `rota()`, em `http.mjs`.
 * Este módulo não repete nenhuma regra de negócio.
 */

import { rota, corpoDe, idDoPedido, responderErro, construirRepositorio, semCache } from './http.mjs';
import {
  autenticarOperador, cookieDeSessao, cookieDeLogout, exigirSessao,
  authConfigurada, exigirSegredoDoWorker, AuthError, exigirMesmaOrigem,
  origemDoPedido, exigirTentativaDisponivel, registarFalha, limparTentativas
} from './auth.mjs';
import { OutreachService } from './service.mjs';
import { ambienteDe, mockPermitido } from './domain.mjs';
import { OutreachWorker, novoWorkerId } from './worker.mjs';
import { MockInstagramProvider, ManyChatInstagramProvider } from '../instagram/index.mjs';
import { MetaInstagramProvider } from '../instagram/meta.mjs';
import { verificarSubscricao, verificarAssinatura } from '../instagram/meta-webhook-crypto.mjs';
import { createHash } from 'node:crypto';
import { emparelharLote } from '../instagram/manychat-matching.mjs';

/* ---------------------------------------------------------------- *
 * session                                                           *
 * ---------------------------------------------------------------- */

/**
 * POST   → login (cria sessão HttpOnly)
 * DELETE → logout
 * GET    → estado da sessão e do subsistema
 *
 * A password do OPERADOR do LeadMap é verificada contra um hash scrypt
 * guardado em variável de ambiente. Nunca há password de Instagram aqui.
 */
export async function session(req, res) {
  const requestId = idDoPedido(req);
  const env = process.env;
  const seguro = ambienteDe(env) === 'production';
  try {
    semCache(res);                                  /* nunca cachear sessão */
    exigirMesmaOrigem(req);                         /* 403 CSRF */

    if (req.method === 'POST') {
      const { email, password } = corpoDe(req);
      /* limitar antes de gastar scrypt: um atacante não deve conseguir
         transformar o login numa bomba de CPU (§49) */
      const chave = origemDoPedido(req);
      exigirTentativaDisponivel(chave);
      let token;
      try {
        token = autenticarOperador({ email, password }, env);
      } catch (err) {
        if (err && err.status === 401) registarFalha(chave);
        throw err;
      }
      /* sessão nova a cada entrada; o contador limpa-se no sucesso */
      limparTentativas(chave);
      res.setHeader('Set-Cookie', cookieDeSessao(token, { seguro }));
      return res.status(200).json({ success: true, requestId });
    }
    if (req.method === 'DELETE') {
      res.setHeader('Set-Cookie', cookieDeLogout({ seguro }));
      return res.status(200).json({ success: true, requestId });
    }
    if (req.method === 'GET') {
      if (!authConfigurada(env)) {
        return res.status(200).json({ success: true, authenticated: false, configured: false, requestId });
      }
      let sessao = null;
      try { sessao = exigirSessao(req, env); } catch (e) { sessao = null; }
      const repo = construirRepositorio(env);
      const estado = repo ? await new OutreachService({ repository: repo, env }).estado() : { databaseConfigured: false };
      return res.status(200).json({
        success: true, authenticated: Boolean(sessao), configured: true,
        subject: sessao ? sessao.sub : null, ...estado, requestId
      });
    }
    return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', requestId });
  } catch (err) {
    return responderErro(res, err, requestId, env);
  }
}

/* ---------------------------------------------------------------- *
 * contactos                                                         *
 * ---------------------------------------------------------------- */

/** GET lista contactos (paginado) · POST importa contactos. */
export const contacts = rota({
  metodos: ['GET', 'POST'],
  handler: async ({ req, service, pagina }) => {
    if (req.method === 'GET') {
      const r = await service.listarContactos({ ...pagina, status: (req.query && req.query.status) || null });
      return { total: r.total, items: r.items, limit: pagina.limit, offset: pagina.offset };
    }
    return { resumo: await service.importarContactos(corpoDe(req)) };
  }
});

/* ---------------------------------------------------------------- *
 * templates                                                         *
 * ---------------------------------------------------------------- */

/** GET lista · POST cria · PATCH atualiza · DELETE apaga (soft). */
export const templates = rota({
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

/* ---------------------------------------------------------------- *
 * contas Instagram                                                  *
 * ---------------------------------------------------------------- */

/** GET lista contas · POST liga uma conta (teto de 5 aplicado no backend). */
export const accounts = rota({
  metodos: ['GET', 'POST'],
  handler: async ({ req, service }) => {
    if (req.method === 'GET') return { items: await service.listarContas() };
    return { account: await service.criarConta(corpoDe(req)) };
  }
});

/* ---------------------------------------------------------------- *
 * campanhas                                                         *
 * ---------------------------------------------------------------- */

const ACOES = ['start', 'pause', 'resume', 'cancel'];

/**
 * GET  ?id=…            → detalhe de uma campanha (com KPIs da fila)
 * GET                    → lista paginada
 * POST                   → cria campanha
 * POST ?id=…&action=…    → start | pause | resume | cancel
 *
 * `start` é idempotente: chamar duas vezes não duplica a fila.
 */
export const campaigns = rota({
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

/* ---------------------------------------------------------------- *
 * fila                                                              *
 * ---------------------------------------------------------------- */

/** GET fila paginada, filtrável por campanha e estado. */
export const queue = rota({
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

/* ---------------------------------------------------------------- *
 * auditoria                                                         *
 * ---------------------------------------------------------------- */

/** GET auditoria paginada — só para quem tem o papel de administração. */
export const audit = rota({
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

/* ---------------------------------------------------------------- *
 * worker                                                            *
 * ---------------------------------------------------------------- */

/**
 * POST — processa um lote da fila. NÃO é uma rota de browser: exige o
 * segredo OUTREACH_WORKER_SECRET num cabeçalho e não aceita sessão de
 * utilizador.
 *
 * Nesta fase o worker usa um fornecedor controlado e NÃO envia nada para
 * a Meta nem para o Instagram. Em produção, sem fornecedor real
 * configurado, recusa-se a correr em vez de simular envios.
 */
export async function worker(req, res) {
  const requestId = idDoPedido(req);
  const env = process.env;
  try {
    semCache(res);
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
    const w = new OutreachWorker({
      repository: repo,
      provider: new MockInstagramProvider({ script: {} }),
      workerId: novoWorkerId('api')
    });
    const resumo = await w.processar({ limit: Math.min(Number(limit) || 10, 100) });
    return res.status(200).json({ success: true, environment: ambienteDe(env), workerId: w.workerId, resumo, requestId });
  } catch (err) {
    return responderErro(res, err, requestId, env);
  }
}

/* ---------------------------------------------------------------- *
 * ManyChat                                                          *
 * ---------------------------------------------------------------- */

/** Constrói o provider a partir do ambiente. O token nunca sai daqui. */
function manychatDoAmbiente(env) {
  return new ManyChatInstagramProvider({ apiToken: env.MANYCHAT_API_TOKEN || null });
}

/**
 * GET  ?action=test    → testa a ligação à ManyChat
 * GET  ?action=flows   → lista as automações existentes
 * GET  ?action=lookup&email=… | &phone=… | &fieldId=…&value=…
 * GET  ?action=verify&subscriberId=…&instagram=…
 * POST ?action=send-test → UM envio, com confirmação explícita
 *
 * O browser nunca fala com a api.manychat.com: o token vive só aqui.
 */
export const manychat = rota({
  metodos: ['GET', 'POST'],
  handler: async ({ req, service, sessao }) => {
    const env = process.env;
    const q = req.query || {};
    const accao = String(q.action || '').toLowerCase();
    const mc = manychatDoAmbiente(env);

    if (req.method === 'GET') {
      if (accao === 'test' || accao === '') {
        /* devolve só o vocabulário do contrato — nunca o token */
        return { manychat: await mc.testarLigacao() };
      }
      if (accao === 'flows') {
        if (!mc.isConfigured()) {
          const e = new Error('MANYCHAT_API_TOKEN não configurado.'); e.errorCode = 'NOT_CONFIGURED'; throw e;
        }
        return { flows: await mc.listarFlows() };
      }
      if (accao === 'lookup') {
        /* A ManyChat não procura por @instagram. Pedir isso devolve um
           erro claro em vez de um resultado inventado. */
        if (q.instagram && !q.email && !q.phone && !q.fieldId) {
          const e = new Error('A ManyChat não permite procurar por username de Instagram. Use email, telefone ou um campo personalizado.');
          e.errorCode = 'NOT_SUPPORTED'; throw e;
        }
        const r = await mc.procurarSubscriber({
          email: q.email || null, phone: q.phone || null,
          fieldId: q.fieldId || null, value: q.value || null
        });
        return { subscribers: r };
      }
      if (accao === 'verify') {
        if (!q.subscriberId) { const e = new Error('Falta subscriberId.'); e.errorCode = 'INVALID_REQUEST'; throw e; }
        return { verificacao: await mc.confirmarPar(q.subscriberId, q.instagram || '') };
      }
      const e = new Error('Ação desconhecida.'); e.errorCode = 'INVALID_REQUEST'; throw e;
    }

    /* -------- POST: emparelhar um lote -------- */
    if (accao === 'match') {
      if (!mc.isConfigured()) {
        const e = new Error('MANYCHAT_API_TOKEN não configurado.'); e.errorCode = 'NOT_CONFIGURED'; throw e;
      }
      const { leads } = corpoDe(req);
      if (!Array.isArray(leads) || !leads.length) {
        const e = new Error('Sem leads para emparelhar.'); e.errorCode = 'INVALID_REQUEST'; throw e;
      }
      /* teto por pedido: o emparelhamento corre em série e cada lead
         gasta até duas chamadas à ManyChat, que limita getInfo a 10 q/s */
      const r = await emparelharLote(leads.slice(0, 100), mc);
      return {
        resumo: r.resumo,
        truncado: r.truncado,
        resultados: r.resultados.map(x => ({
          leadId: x.lead.id || null,
          status: x.status,
          motivo: x.motivo,
          via: x.via,
          subscriber: x.subscriber
            ? { subscriberId: x.subscriber.subscriberId, name: x.subscriber.name,
                igUsername: x.subscriber.igUsername, lastInteraction: x.subscriber.lastInteraction }
            : null
        }))
      };
    }

    /* -------- POST: envio de teste -------- */
    if (accao !== 'send-test') {
      const e = new Error('Só as ações match e send-test são aceites em POST.'); e.errorCode = 'INVALID_REQUEST'; throw e;
    }
    const corpo = corpoDe(req);
    const { subscriberId, flowNs, instagram, confirmado } = corpo;

    /* §14: nada sai sem uma confirmação explícita de quem está a operar */
    if (confirmado !== true) {
      const e = new Error('O envio de teste exige confirmação explícita.');
      e.errorCode = 'NOT_CONFIRMED'; e.status = 409; throw e;
    }
    if (!subscriberId || !flowNs) {
      const e = new Error('São precisos subscriberId e flowNs.'); e.errorCode = 'INVALID_REQUEST'; throw e;
    }

    /* §12: confirmar que o subscriber é mesmo quem se pensa, pela API,
       antes de escrever a alguém em nome do utilizador */
    const par = await mc.confirmarPar(subscriberId, instagram || '');
    if (instagram && !par.confirmado) {
      const e = new Error(par.motivo || 'O subscriber não corresponde ao Instagram indicado.');
      e.errorCode = 'RECIPIENT_UNAVAILABLE'; e.status = 409; throw e;
    }

    await service.auditar('MANYCHAT_TEST_SEND_ATTEMPTED', 'manychat', String(subscriberId), {
      flowNs, instagram: instagram || null, actor: sessao ? sessao.sub : null
    });

    const resposta = await mc.sendMessage({
      account: { id: 'manychat', providerAccountId: 'manychat' },
      recipient: {
        username: par.subscriber.igUsername || instagram || 'subscriber',
        manychatSubscriberId: subscriberId
      },
      flowNs
    });

    await service.auditar(
      resposta.success ? 'MANYCHAT_TEST_SEND_OK' : 'MANYCHAT_TEST_SEND_FAILED',
      'manychat', String(subscriberId),
      { flowNs, status: resposta.status, errorCode: resposta.errorCode }
    );

    return { envio: resposta, subscriber: par.subscriber };
  }
});

/* ---------------------------------------------------------------- *
 * Identidade — associação manual                                    *
 * ---------------------------------------------------------------- */

/**
 * GET  /api/outreach/identity?action=pending  → inbounds por associar
 * POST /api/outreach/identity                 → associa, com confirmação
 *
 * A associação é sempre um ato de quem opera. O backend nunca liga um
 * IGSID a um contacto por iniciativa própria.
 */
export const identity = rota({
  metodos: ['GET', 'POST'],
  handler: async ({ req, repo, service, sessao }) => {
    const env = process.env;

    if (req.method === 'GET') {
      const eventos = await repo.listarWebhooks({ provider: 'meta', limit: 50 });
      const pendentes = [];
      for (const e of (eventos.items || [])) {
        const igsid = e.payloadRedacted && e.payloadRedacted.senderIgsid;
        if (!igsid) continue;
        const dono = await repo.contactoPorRecipient('meta', igsid);
        if (dono) continue;
        pendentes.push({
          eventoId: e.providerEventId,
          contaReceptora: (e.payloadRedacted && e.payloadRedacted.accountId) || null,
          quando: (e.payloadRedacted && e.payloadRedacted.at) || e.receivedAt,
          provider: 'meta',
          /* §15: nunca o identificador completo para o frontend */
          recipientMascarado: mascararId(igsid),
          estado: 'RECIPIENT_DISCOVERED'
        });
      }
      return { pendentes };
    }

    const corpo = corpoDe(req);
    const { contactId, recipientId, provider = 'meta', confirmado } = corpo;
    if (confirmado !== true) {
      const e = new Error('A associação de identidade exige confirmação explícita.');
      e.errorCode = 'NOT_CONFIRMED'; e.status = 409; throw e;
    }
    if (!contactId || !recipientId) {
      const e = new Error('São precisos contactId e recipientId.'); e.errorCode = 'INVALID_REQUEST'; throw e;
    }

    const contacto = await repo.lerContacto(contactId);
    if (!contacto) { const e = new Error('Contacto não encontrado.'); e.errorCode = 'NOT_FOUND'; throw e; }

    /* §7: se a API conseguir confirmar o handle, confirma-se. Se não
       conseguir, a associação fica por verificar — não se promove uma
       coincidência a prova. */
    let verificado = false, motivo = null;
    const mt = metaDoAmbiente(env);
    if (provider === 'meta' && mt.isConfigured() && contacto.normalizedInstagram) {
      const v = await mt.verificarIdentidade(recipientId, contacto.normalizedInstagram);
      verificado = v.verificado === true;
      motivo = v.motivo;
    }

    let r;
    try {
      r = await repo.associarRecipient({ contactId, provider, recipientId, verificado });
    } catch (err) {
      /* §17: um destinatário que já pertence a outro contacto não muda
         de dono sozinho. */
      const e = new Error((err && err.message) || 'Não foi possível associar.');
      e.errorCode = (err && err.errorCode) || 'RECIPIENT_ALREADY_LINKED';
      e.status = 409; throw e;
    }

    await service.auditar('META_RECIPIENT_LINKED', 'contact', contactId, {
      provider, recipientMascarado: mascararId(recipientId),
      verificado, actor: sessao ? sessao.sub : null
    });

    return {
      identidade: {
        contactId,
        provider,
        recipientMascarado: mascararId(recipientId),
        estado: verificado ? 'RECIPIENT_VERIFIED' : 'RECIPIENT_UNVERIFIED',
        jaExistia: r.jaExistia === true,
        motivo
      }
    };
  }
});

/* ---------------------------------------------------------------- *
 * Fornecedores — vista para a interface                             *
 * ---------------------------------------------------------------- */

/**
 * GET /api/outreach/providers
 *
 * Que fornecedores existem, se estão configurados e o que declaram
 * saber fazer. Nunca credenciais — nem sequer o host do fornecedor
 * externo, que já é uma pista sobre a infraestrutura.
 */
export const providers = rota({
  metodos: ['GET'],
  handler: async () => {
    const env = process.env;
    const mc = manychatDoAmbiente(env);
    const mt = metaDoAmbiente(env);
    const externoConfigurado = Boolean(env.INSTAGRAM_EXTERNAL_BASE_URL && env.INSTAGRAM_EXTERNAL_API_KEY);
    return {
      providers: [
        {
          id: 'meta', nome: 'Meta Oficial',
          descricao: 'Ligação direta à API oficial da Meta. Requer conta profissional e respeita as regras de mensagens do Instagram.',
          configurado: Boolean(env.INSTAGRAM_META_ACCESS_TOKEN),
          estadoLigacao: mt.estadoLigacao(),
          capabilities: mt.capabilities,
          variaveis: ['INSTAGRAM_META_ACCESS_TOKEN', 'INSTAGRAM_META_APP_SECRET', 'INSTAGRAM_META_VERIFY_TOKEN']
        },
        {
          id: 'manychat', nome: 'ManyChat',
          descricao: 'Ligação através da API da ManyChat. A disponibilidade depende do plano e da configuração da conta.',
          configurado: mc.isConfigured(),
          estadoLigacao: mc.isConfigured() ? 'CONFIGURED' : 'NOT_CONFIGURED',
          capabilities: mc.capabilities,
          variaveis: ['MANYCHAT_API_TOKEN']
        },
        {
          id: 'external', nome: 'API Externa',
          descricao: 'Ligação através de um fornecedor externo configurado no LeadMap.',
          configurado: externoConfigurado,
          estadoLigacao: externoConfigurado ? 'CONFIGURED' : 'NOT_CONFIGURED',
          /* o nome do fornecedor é escolhido por quem configura e não é
             um segredo; o host e a chave nunca saem daqui */
          fornecedor: env.INSTAGRAM_EXTERNAL_PROVIDER || null,
          authType: env.INSTAGRAM_EXTERNAL_AUTH_TYPE || (externoConfigurado ? 'bearer' : null),
          capabilities: {},
          variaveis: ['INSTAGRAM_EXTERNAL_BASE_URL', 'INSTAGRAM_EXTERNAL_API_KEY']
        }
      ]
    };
  }
});

/**
 * GET /api/outreach/meta-test — teste de ligação, só leitura.
 * Devolve o account ID mascarado: o id completo identifica a conta e
 * não é preciso para nada no ecrã.
 */
export const metaTest = rota({
  metodos: ['GET'],
  handler: async () => {
    const mt = metaDoAmbiente(process.env);
    const r = await mt.testarLigacao();
    const id = r.conta && r.conta.id ? String(r.conta.id) : null;
    return {
      meta: {
        estado: r.estado,
        conta: r.conta ? {
          idMascarado: id ? id.slice(0, 4) + '…' + id.slice(-4) : null,
          username: r.conta.username, nome: r.conta.nome, tipo: r.conta.tipo
        } : null,
        profissional: r.profissional === true,
        scopes: r.scopes,
        mensagem: r.mensagem,
        testadoEm: new Date().toISOString()
      }
    };
  }
});

/* ---------------------------------------------------------------- *
 * Webhook da Meta                                                   *
 * ---------------------------------------------------------------- */

function metaDoAmbiente(env) {
  return new MetaInstagramProvider({
    accessToken: env.INSTAGRAM_META_ACCESS_TOKEN || null,
    appSecret: env.INSTAGRAM_META_APP_SECRET || null,
    verifyToken: env.INSTAGRAM_META_VERIFY_TOKEN || null,
    graphVersion: env.INSTAGRAM_META_GRAPH_VERSION || undefined,
    enabledForRealRequests: env.INSTAGRAM_META_ENABLED_FOR_REAL_REQUESTS === '1'
  });
}

/**
 * Lê os BYTES ORIGINAIS do pedido.
 *
 * A assinatura da Meta é um HMAC do corpo tal como veio. Reserializar o
 * JSON muda espaços e ordem de chaves, e a assinatura deixa de bater —
 * pior, passaria a validar um corpo diferente do que foi assinado.
 *
 * Na Vercel isto funciona porque o runtime, depois de ler o corpo,
 * repõe-no num stream reproduzível (`restoreBody`). Se por alguma razão
 * os bytes não estiverem disponíveis, devolve-se `null` e o pedido é
 * **recusado** — nunca se valida contra um corpo reconstruído.
 */
export async function lerCorpoBruto(req) {
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  if (typeof req[Symbol.asyncIterator] === 'function') {
    try {
      const partes = [];
      for await (const c of req) partes.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
      const bruto = Buffer.concat(partes).toString('utf8');
      if (bruto) return bruto;
    } catch (e) { /* stream já consumido e não reposto */ }
  }
  return null;
}

/**
 * Identificador estável do evento, para não o processar duas vezes.
 *
 * A Meta traz `message.mid`, que é único por mensagem — é esse o id
 * preferido. Quando não existe (entregas, leituras), constrói-se uma
 * impressão digital a partir de campos imutáveis: conta, remetente,
 * instante e tipo. Nunca do texto sozinho, que se repete.
 */
/** §15: um identificador completo não precisa de andar por aí. */
export function mascararId(id) {
  const v = String(id || '');
  if (!v) return null;
  return v.length <= 8 ? '…' + v.slice(-3) : v.slice(0, 4) + '…' + v.slice(-4);
}

export function idDoEvento(entrada, m) {
  if (m && m.message && m.message.mid) return String(m.message.mid);
  const partes = [
    entrada && entrada.id, m && m.sender && m.sender.id,
    m && m.timestamp, m && (m.delivery ? 'delivery' : m.read ? 'read' : 'outro')
  ].map(x => String(x === undefined || x === null ? '' : x)).join('|');
  return 'fp:' + createHash('sha256').update(partes).digest('hex').slice(0, 32);
}

/**
 * GET  → handshake de subscrição
 * POST → receção de eventos, com assinatura validada
 *
 * Sem sessão: quem chama é a Meta, e a autenticação É a assinatura.
 */
export async function metaWebhook(req, res) {
  const requestId = idDoPedido(req);
  const env = process.env;
  const mc = metaDoAmbiente(env);
  try {
    semCache(res);

    /* -------- handshake -------- */
    if (req.method === 'GET') {
      try {
        const desafio = verificarSubscricao(mc, req.query || {});
        res.setHeader('Content-Type', 'text/plain');
        return res.status(200).end(desafio);
      } catch (err) {
        /* 403 e mais nada: não se diz porque falhou, nem se ecoa o token */
        return res.status(403).json({ success: false, errorCode: 'FORBIDDEN', requestId });
      }
    }
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', requestId });
    }

    /* -------- assinatura sobre os bytes originais -------- */
    const bruto = await lerCorpoBruto(req);
    if (bruto === null) {
      return res.status(400).json({
        success: false, errorCode: 'RAW_BODY_UNAVAILABLE',
        message: 'Não foi possível ler o corpo original para validar a assinatura.', requestId
      });
    }
    const assinatura = (req.headers && (req.headers['x-hub-signature-256'] || req.headers['X-Hub-Signature-256'])) || '';
    try {
      verificarAssinatura(mc, bruto, assinatura);
    } catch (err) {
      return res.status(401).json({ success: false, errorCode: 'INVALID_SIGNATURE', requestId });
    }

    let corpo;
    try { corpo = JSON.parse(bruto); } catch (e) {
      return res.status(400).json({ success: false, errorCode: 'INVALID_REQUEST', requestId });
    }
    if (!corpo || corpo.object !== 'instagram' || !Array.isArray(corpo.entry)) {
      return res.status(400).json({ success: false, errorCode: 'INVALID_REQUEST', requestId });
    }

    const repo = construirRepositorio(env);
    if (!repo) {
      /* sem persistência não há idempotência; melhor a Meta repetir */
      return res.status(503).json({ success: false, errorCode: 'NOT_CONFIGURED', requestId });
    }
    const service = new OutreachService({ repository: repo, actor: 'meta-webhook', env });

    const resumo = { recebidos: 0, duplicados: 0, semCorrespondencia: 0, correspondidos: 0, ignorados: 0 };

    for (const entrada of corpo.entry) {
      for (const m of (entrada.messaging || [])) {
        /* §4: nesta fase só interessam mensagens recebidas */
        const ehMensagem = Boolean(m && m.message && !m.message.is_echo);
        if (!ehMensagem) { resumo.ignorados += 1; continue; }

        const eventoId = idDoEvento(entrada, m);
        const igsid = m.sender && m.sender.id ? String(m.sender.id) : null;

        /* §9: persistir ANTES de processar. O UNIQUE(provider, event_id)
           é o que impede um segundo processamento se a Meta repetir. */
        const r = await repo.registarWebhook({
          provider: 'meta', providerEventId: eventoId, eventType: 'messages',
          payload: {
            accountId: entrada.id ? String(entrada.id) : null,
            senderIgsid: igsid,
            at: m.timestamp ? new Date(Number(m.timestamp)).toISOString() : null,
            temTexto: Boolean(m.message && m.message.text)
          }
        });
        if (r && r.duplicado) { resumo.duplicados += 1; continue; }
        resumo.recebidos += 1;

        await service.auditar('META_WEBHOOK_RECEIVED', 'webhook_event', eventoId,
          { provider: 'meta', senderIgsid: igsid });

        /* §9: procura EXATA por (fornecedor, identificador). Nunca por
           nome, nunca por semelhança. Zero ou um — nunca "o mais
           parecido". */
        let contacto = null;
        try { contacto = igsid ? await repo.contactoPorRecipient('meta', igsid) : null; }
        catch (e) { contacto = null; }

        if (contacto) {
          resumo.correspondidos += 1;
          await service.auditar('META_INBOUND_MATCHED', 'contact', contacto.id,
            { provider: 'meta', recipientMascarado: mascararId(igsid) });
        } else {
          /* Não se cria contacto a partir de um IGSID (§13): um
             identificador não é uma pessoa que alguém tenha pesquisado,
             e inventar um contacto encheria a base de fantasmas. */
          resumo.semCorrespondencia += 1;
          await service.auditar('META_INBOUND_UNMATCHED', 'webhook_event', eventoId,
            { provider: 'meta', motivo: 'RECIPIENT_NOT_LINKED', recipientMascarado: mascararId(igsid) });
        }
      }
    }

    return res.status(200).json({ success: true, resumo, requestId });
  } catch (err) {
    return responderErro(res, err, requestId, env);
  }
}

/* ---------------------------------------------------------------- *
 * Integrações — estado, nunca valores                               *
 * ---------------------------------------------------------------- */

/**
 * As variáveis que este projeto usa mesmo, e a que integração pertencem.
 * A lista é escrita à mão de propósito: enumerar `process.env` daria uma
 * fuga de nomes de tudo o que a Vercel injeta.
 */
export const INTEGRACOES = Object.freeze([
  { id: 'manychat', nome: 'ManyChat',
    descricao: 'Envio de mensagens Instagram, via ManyChat.',
    envs: ['MANYCHAT_API_TOKEN'], testavel: true },
  { id: 'meta', nome: 'Meta Instagram',
    descricao: 'API oficial. Requer conta profissional e respeita as regras de mensagens do Instagram.',
    envs: ['INSTAGRAM_META_ACCESS_TOKEN'], testavel: true },
  { id: 'external', nome: 'API Externa',
    descricao: 'Fornecedor terceiro configurado no backend.',
    envs: ['INSTAGRAM_EXTERNAL_BASE_URL', 'INSTAGRAM_EXTERNAL_API_KEY'] },
  { id: 'google-places', nome: 'Google Places',
    descricao: 'Pesquisa de estabelecimentos.',
    envs: ['GOOGLE_PLACES_API_KEY'] },
  { id: 'google-maps', nome: 'Google Maps',
    descricao: 'Geocodificação de moradas.',
    envs: ['GOOGLE_MAPS_API_KEY'] },
  { id: 'enrich-email', nome: 'Enriquecimento de email',
    descricao: 'Lê o site público do negócio. Não usa chave nenhuma.',
    envs: [], semChave: true },
  { id: 'enrich-social', nome: 'Enriquecimento de redes sociais',
    descricao: 'Lê o site público do negócio. Não usa chave nenhuma.',
    envs: [], semChave: true },
  { id: 'outreach-db', nome: 'Base de dados do Outreach',
    descricao: 'Persistência de contactos, campanhas e fila.',
    envs: ['OUTREACH_DB_URL', 'OUTREACH_DB_SERVICE_KEY'] },
  { id: 'outreach-auth', nome: 'Autenticação do Outreach',
    descricao: 'Sessão do operador.',
    envs: ['OUTREACH_AUTH_SECRET', 'OUTREACH_OPERATOR_EMAIL', 'OUTREACH_OPERATOR_PASSWORD_HASH'] }
]);

/**
 * Testa se a base de dados **responde** — `disponivel()` só olha para a
 * configuração, e uma base configurada mas em baixo é exatamente o caso
 * que interessa distinguir. Uma leitura minúscula é a única prova.
 */
export const dbProbe = rota({
  metodos: ['GET'],
  handler: async ({ service }) => {
    try {
      await service.listarTemplates({ limit: 1, offset: 0 });
      return { base: { configurada: true, disponivel: true, erro: null } };
    } catch (err) {
      return { base: { configurada: true, disponivel: false, erro: (err && err.errorCode) || 'ERRO' } };
    }
  }
});

/**
 * GET /api/outreach/integrations
 *
 * Diz o que está configurado — **só isso**. Devolve booleanos e nomes de
 * variáveis; nunca um valor, nem sequer truncado ou mascarado. Um
 * prefixo de token é um token parcialmente vazado.
 *
 * Sem sessão exigida, à semelhança de `GET /session`: sem isto não haveria
 * como ver o que falta configurar antes de a autenticação estar
 * configurada — e o que se revela é apenas se uma variável está ou não
 * definida, o que quem opera a aplicação já sabe.
 */
export async function integrations(req, res) {
  const requestId = idDoPedido(req);
  const env = process.env;
  try {
    semCache(res);
    if (req.method !== 'GET') {
      return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', requestId });
    }
    const itens = INTEGRACOES.map(i => {
      const emFalta = i.envs.filter(n => !env[n]);
      return {
        id: i.id, nome: i.nome, descricao: i.descricao,
        semChave: i.semChave === true,
        testavel: i.testavel === true,
        /* uma integração sem chave está sempre pronta: não há nada para configurar */
        configurada: i.semChave === true ? true : emFalta.length === 0,
        variaveis: i.envs,
        emFalta
      };
    });
    return res.status(200).json({
      success: true, requestId,
      environment: ambienteDe(env),
      integracoes: itens
    });
  } catch (err) {
    return responderErro(res, err, requestId, env);
  }
}

/* ---------------------------------------------------------------- *
 * Tabela de despacho                                                *
 * ---------------------------------------------------------------- */

/** Nome do último segmento de `/api/outreach/<nome>` → handler. */
export const ROTAS = Object.freeze({
  session, contacts, templates, accounts, campaigns, queue, audit, worker, manychat, integrations,
  'db-probe': dbProbe,
  'meta-webhook': metaWebhook,
  providers, 'meta-test': metaTest, identity
});

/**
 * Extrai o nome da rota do pedido.
 *
 * A Vercel entrega os segmentos do catch-all em `req.query.rota`. O
 * fallback pelo URL existe para proxies e para os testes, que constroem
 * o pedido à mão.
 */
export function nomeDaRota(req) {
  const q = req && req.query && req.query.rota;
  if (Array.isArray(q)) return q.join('/');
  if (typeof q === 'string' && q) return q;

  const url = (req && req.url) || '';
  const caminho = url.split('?')[0].replace(/\/+$/, '');
  const m = caminho.match(/\/api\/outreach\/(.+)$/);
  return m ? m[1] : '';
}

/**
 * Despacha um pedido para o handler certo.
 *
 * Um nome desconhecido devolve 404 no mesmo formato de erro das outras
 * respostas — nunca uma exceção por chamar `undefined`.
 */
export async function despachar(req, res) {
  const nome = nomeDaRota(req);
  const handler = Object.prototype.hasOwnProperty.call(ROTAS, nome) ? ROTAS[nome] : null;
  if (!handler) {
    semCache(res);
    return res.status(404).json({
      success: false, errorCode: 'NOT_FOUND',
      message: 'Rota de Outreach desconhecida.',
      requestId: idDoPedido(req)
    });
  }
  return handler(req, res);
}

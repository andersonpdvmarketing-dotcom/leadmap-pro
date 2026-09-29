/**
 * LeadMap Pro — Open Company Intelligence
 * =======================================
 * Junta o que se consegue saber sobre uma empresa a partir de fontes
 * públicas e gratuitas, sem depender de nenhuma API paga.
 *
 * A REGRA QUE DEFINE ESTE MÓDULO
 * ------------------------------
 * Nenhuma fonte é obrigatória. Se o SICAE estiver em baixo, o website
 * continua a ser lido. Se o website não existir, o SICAE continua a ser
 * consultado. Uma fonte que falhe devolve menos informação, nunca um
 * erro que interrompa a investigação das outras — daí `allSettled` e não
 * `all`.
 *
 * ORDEM, E PORQUÊ
 * ---------------
 * 1. cache          — não se paga duas vezes pelo mesmo
 * 2. dados já lidos — o NIF que a Fase 1 já tinha evita uma leitura
 * 3. website        — grátis, do próprio, e é onde está o NIF
 * 4. SICAE          — precisa do NIF, por isso vem depois
 *
 * O website vem antes do SICAE por dependência, não por preferência: sem
 * NIF não há consulta ao SICAE que se possa fazer.
 */

import {
  ESTADO_DADO, TIPO_FONTE, evidencia, semDadosEmpresa, naoEncontrado,
  comEvidencia, lerEmpresa
} from './contract.mjs';
import { investigarWebsite } from './website-deep.mjs';
import { SicaeProvider } from './sicae.mjs';
import { avaliarIdentidade, identidadeSuficiente, dependenciaDeIdentidade,
         identidadeVazia, IDENTIDADE } from './identidade.mjs';
import { nifValido, normalizarNif } from './nif.mjs';

/* ---------------------------------------------------------------- *
 * Cache                                                             *
 * ---------------------------------------------------------------- */

/** TTL por fonte, em milissegundos. */
export const TTL = Object.freeze({
  sicae: 30 * 24 * 3600 * 1000,      /* o CAE muda raramente */
  website: 7 * 24 * 3600 * 1000      /* um site pode ser reescrito a qualquer momento */
});

/**
 * Cache em memória, com chave provider+identificador.
 *
 * Vive no processo. Numa função serverless isso significa "enquanto a
 * instância estiver quente", que chega para o caso que interessa: o
 * mesmo utilizador a investigar a mesma lista. Não precisa de migration,
 * e um arranque a frio custa uma consulta, não correção.
 */
export class CacheEmpresa {
  constructor({ agora = () => Date.now(), max = 2000 } = {}) {
    this.mapa = new Map();
    this.agora = agora;
    this.max = max;
    this.acertos = 0;
    this.faltas = 0;
  }
  chave(provider, id) { return provider + ':' + String(id || '').toLowerCase(); }
  ler(provider, id) {
    const k = this.chave(provider, id);
    const e = this.mapa.get(k);
    if (!e) { this.faltas += 1; return null; }
    if (e.expiraEm <= this.agora()) { this.mapa.delete(k); this.faltas += 1; return null; }
    this.acertos += 1;
    return e.valor;
  }
  guardar(provider, id, valor, ttl) {
    if (this.mapa.size >= this.max) {
      /* despejo simples: o mais antigo sai. Não vale a pena um LRU para
         uma cache que morre com a instância. */
      const primeiro = this.mapa.keys().next().value;
      if (primeiro !== undefined) this.mapa.delete(primeiro);
    }
    this.mapa.set(this.chave(provider, id), { valor, expiraEm: this.agora() + (ttl || TTL.website) });
  }
}

/* ---------------------------------------------------------------- *
 * Consolidação                                                      *
 * ---------------------------------------------------------------- */

/**
 * Transforma achados do website em evidências.
 *
 * Um achado com operador ">=" — "mais de 120 colaboradores" — é
 * ESTIMADO, não CONFIRMADO: a empresa afirmou um mínimo, não um número.
 * Filtrar "100+" com ele é legítimo; mostrá-lo como "120 funcionários"
 * não seria.
 */
export function evidenciasDoWebsite(achados, quando) {
  const out = [];
  for (const a of achados || []) {
    if (a.valor == null) continue;
    const minimo = a.operador === '>=';
    out.push({
      campo: a.campo,
      ev: evidencia({
        valor: a.valor,
        fonte: 'Website oficial',
        url: a.url || null,
        consultadoEm: quando,
        /* o próprio a declarar sobre si: alta, mas não máxima — não há
           terceiro a verificar */
        confianca: minimo ? 0.6 : 0.75,
        estado: minimo ? ESTADO_DADO.ESTIMADO : ESTADO_DADO.CONFIRMADO,
        tipoFonte: TIPO_FONTE.SITE_OFICIAL
      }),
      contexto: a.contexto || null
    });
  }
  return out;
}

/* ---------------------------------------------------------------- *
 * Pipeline                                                          *
 * ---------------------------------------------------------------- */

/**
 * Investiga uma empresa. Nunca lança: uma falha é menos informação.
 *
 * @returns {{empresa, fontes, erros, auditoria}}
 */
export async function investigarEmpresa(lead, {
  cache = null,
  sicae = null,
  investigar = investigarWebsite,
  agora = () => new Date().toISOString()
} = {}) {
  const quando = agora();
  const empresa = lerEmpresa(lead);
  const fontes = [];
  const erros = [];
  const auditoria = [];

  const website = lead && lead.website && lead.website !== 'N/D' ? lead.website : null;
  let nif = empresa.nif && empresa.nif.valor ? String(empresa.nif.valor) : null;
  /* matéria-prima da identidade: o texto do site e o contexto do NIF.
     Nenhuma das duas é gravada no modelo — do site guarda-se um trecho. */
  let corpusSite = '';
  let contextoNif = { trecho: null, rotulo: null, url: null, candidatos: [] };
  let firmaOficial = null;
  let firmaFonte = null;
  let evsSicae = [];

  /* ---- 1/2/3. website ---- */
  if (website) {
    const cacheado = cache ? cache.ler('website', website) : null;
    let r = cacheado;
    if (!r) {
      const res = await Promise.allSettled([investigar(website)]);
      if (res[0].status === 'fulfilled' && res[0].value) {
        r = res[0].value;
        if (cache) cache.guardar('website', website, r, TTL.website);
      } else {
        erros.push({ fonte: 'website', erro: res[0].reason ? String(res[0].reason.message || res[0].reason) : 'sem resposta' });
      }
    }
    if (r) {
      fontes.push({ fonte: 'website', cache: Boolean(cacheado), paginas: r.paginasLidas });
      corpusSite = r.corpus || '';
      if (r.nif) {
        /* o contexto do NIF viaja para a camada de identidade mesmo
           quando não houve escolha: candidatos empatados são a razão
           pela qual não se sabe, e isso tem de ficar dito */
        contextoNif = { trecho: r.nif.trecho || null, rotulo: r.nif.rotulo || null,
                        url: r.nif.url || null, candidatos: r.nif.candidatos || [] };
      }
      if (!nif && r.nif && nifValido(r.nif.valor)) {
        nif = normalizarNif(r.nif.valor);
        empresa.nif = comEvidencia(empresa.nif, evidencia({
          valor: nif, fonte: 'Website oficial', url: r.nif.url, consultadoEm: quando,
          confianca: r.nif.confianca != null ? r.nif.confianca : 0.9,
          estado: ESTADO_DADO.CONFIRMADO, tipoFonte: TIPO_FONTE.SITE_OFICIAL
        }));
      }
      for (const { campo, ev, contexto } of evidenciasDoWebsite(r.achados, quando)) {
        empresa[campo] = comEvidencia(empresa[campo], ev);
        auditoria.push({ campo, valor: ev.valor, url: ev.url, contexto });
      }
      /* páginas lidas e nada encontrado é "não encontrado", não "por
         consultar": procurou-se mesmo */
      if (r.paginasLidas > 0) {
        for (const c of ['capitalSocial', 'funcionarios', 'faturacaoAnual']) {
          if (empresa[c].estado === ESTADO_DADO.NAO_CONSULTADO) empresa[c] = naoEncontrado();
        }
        if (!nif && empresa.nif.estado === ESTADO_DADO.NAO_CONSULTADO) empresa.nif = naoEncontrado();
      }
    }
  }

  /* ---- 5. SICAE, só com NIPC ---- */
  if (nif && nifValido(nif)) {
    const cacheado = cache ? cache.ler('sicae', nif) : null;
    let r = cacheado;
    if (!r) {
      const prov = sicae || new SicaeProvider();
      if (prov.isConfigured()) {
        const res = await Promise.allSettled([prov.consultar({ nif })]);
        if (res[0].status === 'fulfilled') {
          r = res[0].value;
          if (cache) cache.guardar('sicae', nif, r, TTL.sicae);
        } else {
          erros.push({ fonte: 'sicae', erro: res[0].reason ? String(res[0].reason.message || res[0].reason) : 'falhou' });
        }
      } else {
        erros.push({ fonte: 'sicae', erro: prov.motivoDesativacao || 'desativado' });
      }
    }
    if (r && r.empresa) {
      fontes.push({ fonte: 'sicae', cache: Boolean(cacheado) });
      /* a denominação oficial é o que permite perguntar de quem é o NIF */
      firmaOficial = r.denominacao || null;
      firmaFonte = firmaOficial ? nomeDoRegisto(r, sicae) : null;
      /* o CAE do SICAE é oficial e entra como mais uma evidência: se o
         website dizia outro, o conflito fica registado em vez de um
         sobrepor o outro em silêncio */
      const evs = (r.empresa.cae && Array.isArray(r.empresa.cae.evidencias)) ? r.empresa.cae.evidencias : [];
      evsSicae = evs;
      /* O provider já distingue "consultei e não há" de "não consegui
         consultar": o primeiro devolve NAO_ENCONTRADO, o segundo deixa
         NAO_CONSULTADO. Adotar esse estado em vez de o decidir aqui — a
         versão anterior marcava "não encontrado" com o SICAE em baixo,
         que é afirmar algo que ninguém verificou. */
      if (!evs.length && empresa.cae.estado === ESTADO_DADO.NAO_CONSULTADO
          && r.empresa.cae && r.empresa.cae.estado === ESTADO_DADO.NAO_ENCONTRADO) {
        empresa.cae = naoEncontrado();
      }
    }
  }

  /* ---- 6. identidade: de quem é este NIF? ----
     Corre depois do registo porque precisa da firma, e antes de o CAE ser
     promovido porque é ela que decide se pode ser. */
  const identidade = nif
    ? avaliarIdentidade({
        nomeLead: (lead && lead.nome) || '',
        dominio: website,
        firmaOficial,
        firmaFonte,
        nif,
        rotuloNif: contextoNif.rotulo,
        trecho: contextoNif.trecho,
        urlNif: contextoNif.url,
        corpusSite,
        candidatos: contextoNif.candidatos,
        agora: quando
      })
    : identidadeVazia();

  /* ---- 7. dados derivados do NIF ----
     O CAE do SICAE é oficial e correto PARA O NIF CONSULTADO. Se a
     identidade não liga esse NIF a este lead, o dado continua guardado e
     auditável, mas não é atribuído: era exatamente assim que o CAE de um
     fabricante de móveis passava a ser o CAE de uma clínica dentária. */
  if (evsSicae.length) {
    if (identidadeSuficiente(identidade)) {
      const dep = dependenciaDeIdentidade(identidade);
      for (const ev of evsSicae) empresa.cae = comEvidencia(empresa.cae, ev);
      empresa.cae.dependeDe = dep;
    } else {
      for (const ev of evsSicae) {
        identidade.derivadosNaoAtribuidos.push({
          campo: 'cae', valor: ev.valor, fonte: ev.fonte, url: ev.url || null,
          consultadoEm: ev.consultadoEm || null, motivo: identidade.estado
        });
      }
      /* O registo foi consultado — deixar o campo em NAO_CONSULTADO diria
         que ninguém procurou, e isso é falso. Procurou-se, e não se
         obteve um CAE que se possa atribuir a ESTE lead. A razão fica no
         envelope da identidade, não escondida num estado ambíguo. */
      if (empresa.cae.estado === ESTADO_DADO.NAO_CONSULTADO) empresa.cae = naoEncontrado();
      auditoria.push({ campo: 'cae', valor: evsSicae[0].valor, url: evsSicae[0].url,
                       contexto: 'não atribuído: identidade ' + identidade.estado });
    }
  }

  empresa.identidade = identidade;
  return { empresa, fontes, erros, auditoria, identidade };
}

/** O nome legível do registo que respondeu, para o ecrã não o adivinhar. */
function nomeDoRegisto(resposta, prov) {
  const ev = resposta && resposta.empresa && resposta.empresa.cae
    && Array.isArray(resposta.empresa.cae.evidencias) ? resposta.empresa.cae.evidencias[0] : null;
  if (ev && ev.fonte) return String(ev.fonte);
  if (prov && prov.nome) return String(prov.nome);
  return resposta && resposta.provider ? String(resposta.provider).toUpperCase() : null;
}

/* ---------------------------------------------------------------- *
 * Fila                                                              *
 * ---------------------------------------------------------------- */

/**
 * Investiga uma lista com concorrência limitada.
 *
 * Uma pesquisa nacional devolve milhares de empresas. Disparar uma
 * investigação por cada uma seria um ataque de negação de serviço contra
 * fontes públicas que nos estão a fazer um favor — e contra o próprio
 * browser de quem pesquisa. Daí concorrência 2 e um teto por lote.
 */
export async function investigarLote(leads, {
  concorrencia = 2,
  max = 25,
  aoProgredir = null,
  ...opts
} = {}) {
  const fila = (leads || []).slice(0, max);
  const resultados = new Map();
  let feitos = 0;
  let i = 0;

  async function trabalhador() {
    while (i < fila.length) {
      const lead = fila[i++];
      try {
        resultados.set(lead.id, await investigarEmpresa(lead, opts));
      } catch (e) {
        /* nunca derruba o lote */
        resultados.set(lead.id, { empresa: lerEmpresa(lead), fontes: [], erros: [{ fonte: 'pipeline', erro: String(e && e.message || e) }], auditoria: [] });
      }
      feitos += 1;
      if (aoProgredir) { try { aoProgredir(feitos, fila.length, lead.id); } catch (e) { /* a UI não pode parar a fila */ } }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concorrencia, fila.length) }, trabalhador));
  return resultados;
}

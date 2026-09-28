/**
 * LeadMap Pro — provider SICAE
 * ============================
 * Sistema de Informação da Classificação Portuguesa de Atividades
 * Económicas. Fonte oficial do CAE de pessoas coletivas inscritas no
 * Ficheiro Central de Pessoas Coletivas.
 *
 * COMO SE CONSULTA, E PORQUE É LEGÍTIMO
 * ------------------------------------
 * O site oferece uma consulta pública por NIPC — o próprio texto de
 * ajuda diz "Pode efetuar pesquisas por Firma, NIPC ou Código CAE". Não
 * há autenticação, não há CAPTCHA, não há aviso contra consulta
 * automatizada. É um formulário ASP.NET WebForms: lê-se a página, tiram-se
 * os tokens `__VIEWSTATE` e `__EVENTVALIDATION`, e devolvem-se no POST
 * com o NIPC. Isso é usar o formulário como ele foi feito, não contorná-lo.
 *
 * Se algum dia o SICAE passar a exigir CAPTCHA ou a declarar restrição a
 * automação, este provider desliga-se — ver `desativar()`. Nada aqui
 * existe para dar a volta a uma proteção.
 *
 * O CANAL NÃO É CIFRADO
 * ---------------------
 * O SICAE só serve HTTP. A resposta pode ser alterada em trânsito, e é
 * por isso que a confiança destas evidências é 0.9 e não 1: o dado é
 * oficial na origem, mas o caminho não é autenticado. Preferia não ter
 * de o dizer, mas é o que há.
 *
 * O QUE ESTE PROVIDER NÃO FAZ
 * ---------------------------
 * Devolve CAE e denominação. Não devolve — nem infere — funcionários,
 * faturação ou capital social. Um CAE diz a que atividade a empresa se
 * dedica, não o tamanho que tem.
 */

import { CompanyEnrichmentProvider } from './base.mjs';
import { ESTADO_DADO, TIPO_FONTE, evidencia, semDadosEmpresa, naoEncontrado, comEvidencia } from './contract.mjs';
import { lerPagina, texto } from './http.mjs';
import { nifValido, normalizarNif } from './nif.mjs';

const BASE = 'http://www.sicae.pt/Consulta.aspx';

/** Falhas seguidas a partir das quais se para de insistir. */
const FALHAS_ATE_ABRIR = 4;
/** Quanto tempo o disjuntor fica aberto depois de disparar. */
const ABERTO_MS = 5 * 60 * 1000;

export class SicaeProvider extends CompanyEnrichmentProvider {
  constructor({ fetchPagina = lerPagina, agora = () => Date.now() } = {}) {
    super({ id: 'sicae', nome: 'SICAE', campos: ['cae'] });
    this.lerPagina = fetchPagina;
    this.agora = agora;
    this.falhas = 0;
    this.abertoAte = 0;
    this.desativado = false;
    this.motivoDesativacao = null;
    this.consultas = 0;
  }

  isConfigured() { return !this.desativado; }

  /** Custo declarado, para o motor preferir o que não custa. */
  get custo() { return 'GRATUITA'; }

  /**
   * Desliga o provider. Chamado quando a fonte passa a exigir algo que
   * não vamos contornar, ou quando falha de forma persistente.
   */
  desativar(motivo) {
    this.desativado = true;
    this.motivoDesativacao = motivo;
  }

  disjuntorAberto() { return this.agora() < this.abertoAte; }

  registarFalha() {
    this.falhas += 1;
    if (this.falhas >= FALHAS_ATE_ABRIR) {
      this.abertoAte = this.agora() + ABERTO_MS;
      this.falhas = 0;
    }
  }

  registarSucesso() { this.falhas = 0; }

  async _consultar({ nif }) {
    const nipc = normalizarNif(nif);
    if (!nipc || !nifValido(nipc)) {
      /* sem NIPC válido não há por onde procurar; não se inventa consulta */
      return { success: true, empresa: semDadosEmpresa() };
    }
    if (this.disjuntorAberto()) {
      return { success: true, empresa: semDadosEmpresa() };   /* por consultar, não "não encontrado" */
    }

    const form = await this.lerPagina(BASE, { permitirHttp: true });
    if (!form) { this.registarFalha(); return { success: true, empresa: semDadosEmpresa() }; }

    /* Se a fonte passar a exigir CAPTCHA, desliga-se em vez de tentar
       qualquer coisa. Não é uma verificação decorativa: é a condição que
       o utilizador impôs para este provider poder existir. */
    if (/captcha|nobot/i.test(form.texto)) {
      this.desativar('A fonte passou a exigir verificação anti-automação.');
      return { success: true, empresa: semDadosEmpresa() };
    }

    const vs = campo(form.texto, '__VIEWSTATE');
    const ev = campo(form.texto, '__EVENTVALIDATION');
    const vg = campo(form.texto, '__VIEWSTATEGENERATOR');
    if (!vs || !ev) { this.registarFalha(); return { success: true, empresa: semDadosEmpresa() }; }

    const corpo = new URLSearchParams();
    corpo.set('__VIEWSTATE', vs);
    corpo.set('__EVENTVALIDATION', ev);
    if (vg) corpo.set('__VIEWSTATEGENERATOR', vg);
    corpo.set('ctl00$MainContent$ipFirma', '');
    corpo.set('ctl00$MainContent$ipNipc', nipc);
    corpo.set('ctl00$MainContent$ipCae', '');
    corpo.set('ctl00$MainContent$btnPesquisa', 'Pesquisar');

    this.consultas += 1;
    const res = await this.lerPagina(BASE, {
      metodo: 'POST',
      permitirHttp: true,
      corpo: corpo.toString(),
      cookies: form.cookies,
      cabecalhos: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (!res) { this.registarFalha(); return { success: true, empresa: semDadosEmpresa() }; }
    this.registarSucesso();

    const dados = extrairSicae(res.texto, nipc);
    const empresa = semDadosEmpresa();
    if (!dados) {
      /* a consulta correu e o SICAE não conhece este NIPC */
      empresa.cae = naoEncontrado();
      return { success: true, empresa, denominacao: null };
    }

    const quando = new Date().toISOString();
    const evs = [];
    if (dados.caePrincipal) {
      evs.push(evidencia({
        valor: dados.caePrincipal, fonte: 'SICAE', url: BASE, consultadoEm: quando,
        /* 0.9 e não 1: a origem é oficial, o canal não é cifrado */
        confianca: 0.9, estado: ESTADO_DADO.CONFIRMADO, tipoFonte: TIPO_FONTE.FONTE_OFICIAL
      }));
    }
    let campoCae = empresa.cae;
    for (const e of evs) campoCae = comEvidencia(campoCae, e);
    empresa.cae = evs.length ? campoCae : naoEncontrado();

    return {
      success: true,
      empresa,
      denominacao: dados.denominacao || null,
      caesSecundarios: dados.secundarios
    };
  }
}

/** Valor de um campo escondido do ASP.NET. */
function campo(html, nome) {
  const re = new RegExp('id="' + nome + '"[^>]*value="([^"]*)"', 'i');
  const m = re.exec(html);
  if (m) return desescapar(m[1]);
  const re2 = new RegExp('name="' + nome + '"[^>]*value="([^"]*)"', 'i');
  const m2 = re2.exec(html);
  return m2 ? desescapar(m2[1]) : null;
}

function desescapar(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/**
 * Lê a tabela de resultados.
 *
 * Só se aceita a linha cujo NIPC bate exatamente com o pedido. O SICAE
 * pagina resultados, e atribuir o CAE da empresa errada a um lead seria
 * pior do que não trazer CAE nenhum.
 */
export function extrairSicae(html, nipcPedido) {
  const t = texto(html);
  if (!t || !nipcPedido) return null;
  const i = t.indexOf(nipcPedido);
  if (i < 0) return null;

  /* a seguir ao NIPC vem a denominação e depois os códigos */
  const bloco = t.slice(i + nipcPedido.length, i + nipcPedido.length + 320);
  const codigos = [...bloco.matchAll(/\b(\d{5})\b/g)].map(m => m[1]);
  if (!codigos.length) return null;

  const ateCodigo = bloco.indexOf(codigos[0]);
  const denominacao = bloco.slice(0, ateCodigo).replace(/[,\s]+$/, '').trim() || null;

  return {
    nipc: nipcPedido,
    denominacao: denominacao && denominacao.length <= 160 ? denominacao : null,
    caePrincipal: codigos[0],
    secundarios: codigos.slice(1)
  };
}

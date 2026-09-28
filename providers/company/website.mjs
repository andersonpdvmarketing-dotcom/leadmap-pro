/**
 * LeadMap Pro — fornecedor "website"
 * ==================================
 * Lê o NIF/NIPC que a própria empresa publica no seu site.
 *
 * NÃO FAZ PEDIDOS DE REDE
 * -----------------------
 * Este fornecedor não descarrega nada. Recebe o HTML que o enriquecimento
 * de emails JÁ descarregou e analisa-o. É por isso que acrescentar NIF ao
 * LeadMap não acrescenta um único pedido: aproveita uma página que já
 * tinha sido lida, dentro das mesmas guardas de SSRF, timeout e tamanho.
 *
 * Sem HTML, a resposta é NAO_CONSULTADO — não "não encontrado". Uma
 * empresa sem website não é uma empresa sem NIF; é uma empresa cujo NIF
 * ninguém procurou.
 */

import { CompanyEnrichmentProvider } from './base.mjs';
import { ESTADO_DADO, envelope, semDadosEmpresa, naoEncontrado } from './contract.mjs';
import { extrairNif } from './nif.mjs';

export class WebsiteCompanyProvider extends CompanyEnrichmentProvider {
  constructor() {
    /* só sabe responder NIF. Os outros quatro campos ficam por consultar
       em vez de "não encontrados": este fornecedor não os procura. */
    super({ id: 'website', nome: 'Website da empresa', campos: ['nif'] });
  }

  /** Não precisa de credenciais nenhumas. */
  isConfigured() { return true; }

  async _consultar({ html = null, url = null }) {
    if (typeof html !== 'string' || !html.trim()) {
      /* nada foi analisado: todos os campos ficam NAO_CONSULTADO */
      return { success: true, empresa: semDadosEmpresa() };
    }

    const r = extrairNif(html);
    const empresa = semDadosEmpresa();

    if (!r.encontrado) {
      /* a página foi mesmo lida e não tinha NIF reconhecível */
      empresa.nif = naoEncontrado();
      return { success: true, empresa };
    }

    empresa.nif = envelope({
      valor: r.nif,
      fonte: url || 'website',
      consultadoEm: new Date().toISOString(),
      confianca: r.confianca,
      /* lido de uma declaração da própria empresa, validado formalmente:
         é confirmado, não estimado */
      estado: ESTADO_DADO.CONFIRMADO
    });
    return { success: true, empresa };
  }
}

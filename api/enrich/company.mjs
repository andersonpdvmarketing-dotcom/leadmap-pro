/**
 * LeadMap Pro — POST /api/enrich/company
 * ======================================
 *   body: { lead: { id, nome, website, nif } }
 *
 * Investiga UMA empresa em fontes públicas gratuitas e devolve o bloco
 * empresarial com as evidências. Uma empresa por pedido: a fila e a
 * concorrência vivem no cliente, que é quem sabe quantas o utilizador
 * mandou investigar.
 *
 * PORQUE É NO SERVIDOR E NÃO NO BROWSER
 * -------------------------------------
 * O SICAE só serve HTTP, e uma página em HTTPS não pode pedir HTTP —
 * mixed content. Nem os sites das empresas enviam cabeçalhos CORS. Nada
 * disto é contornável do lado do cliente, nem deve ser: aqui as guardas
 * de SSRF, timeout e tamanho aplicam-se num sítio só.
 *
 * PORQUE É `.mjs` E NÃO `.js`
 * --------------------------
 * `package.json` está no .gitignore, por isso o deployment não declara
 * "type": "module"; um `.js` seria CommonJS e o `import` de um `.mjs`
 * falharia em runtime. NÃO renomear para `.js`.
 *
 * NUNCA DEVOLVE DADOS PESSOAIS
 * ----------------------------
 * Só os cinco campos empresariais e a sua proveniência. Nomes de sócios,
 * moradas residenciais ou NIF de pessoas singulares não entram — e os
 * extratores nem os procuram.
 */

import { investigarEmpresa, CacheEmpresa } from '../../providers/company/open-intelligence.mjs';
import { SicaeProvider } from '../../providers/company/sicae.mjs';

/* Vivem enquanto a instância estiver quente. Um arranque a frio custa
   uma consulta, não correção. */
const cache = new CacheEmpresa();
const sicae = new SicaeProvider();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object' || !body.lead || typeof body.lead !== 'object') {
    return res.status(400).json({ success: false, error: 'Body inválido: esperado { lead: { … } }.' });
  }

  const bruto = body.lead;
  const leadId = typeof bruto.id === 'string' ? bruto.id.slice(0, 200) : null;
  if (!leadId) return res.status(400).json({ success: false, error: 'lead.id é obrigatório.' });

  /* só o que a investigação precisa; nada mais do lead atravessa */
  const lead = {
    id: leadId,
    /* texto e nada mais: serve para comparar com a firma do registo, e
       quem o consome normaliza-o antes de o usar. Cortado como os
       outros campos — um nome de 200 caracteres já não é um nome. */
    nome: typeof bruto.nome === 'string' ? bruto.nome.trim().slice(0, 200) : null,
    website: typeof bruto.website === 'string' ? bruto.website.slice(0, 2048) : null,
    empresa: (bruto.nif && typeof bruto.nif === 'string')
      ? { nif: { valor: bruto.nif.slice(0, 20), fonte: 'cliente', consultadoEm: new Date().toISOString(), confianca: 0.9, estado: 'CONFIRMADO' } }
      : null
  };

  try {
    const r = await investigarEmpresa(lead, { cache, sicae });
    return res.status(200).json({
      success: true,
      leadId,
      empresa: r.empresa,
      fontes: r.fontes,
      /* os erros dizem que fonte falhou, nunca porquê em detalhe: uma
         mensagem de rede pode transportar o host interno */
      erros: r.erros.map(e => ({ fonte: e.fonte })),
      auditoria: r.auditoria
    });
  } catch (err) {
    /* nunca 500: uma investigação falhada é menos informação, não um erro
       da aplicação */
    return res.status(200).json({
      success: true, leadId, empresa: null, fontes: [], erros: [{ fonte: 'pipeline' }], auditoria: []
    });
  }
}

/**
 * LeadMap Pro — migração do estado local para o backend (Fase C)
 * ==============================================================
 * Move o trabalho real feito na Fase B — contactos e templates — para a
 * base de dados. É explícita: nada acontece sem o utilizador mandar, e o
 * estado local NÃO é apagado (§44).
 *
 * O QUE NÃO MIGRA, E PORQUÊ (§46)
 * -------------------------------
 * Mensagens, respostas e resultados de envio produzidos pelo fornecedor
 * de teste ficam de fora. Migrá-los transformaria atividade fabricada em
 * histórico de produção — exatamente o que a v1.0.1 corrigiu.
 *
 * Campanhas migram apenas como DRAFT, sem fila: uma campanha "a correr"
 * no estado local nunca esteve realmente a enviar.
 *
 * IDEMPOTENTE (§45): correr duas vezes não duplica. Contactos são
 * deduplicados pelo Instagram normalizado (ou leadId) e os templates
 * pela combinação nome+corpo.
 */

export function analisarEstadoLocal(estado) {
  const e = estado || {};
  const contactos = Array.isArray(e.contactos) ? e.contactos : [];
  const templates = Array.isArray(e.templates) ? e.templates : [];
  const campanhas = Array.isArray(e.campanhas) ? e.campanhas : [];
  const contas = Array.isArray(e.contas) ? e.contas : [];
  return {
    contactos: contactos.length,
    comInstagram: contactos.filter(c => c.temInstagram && c.instagram).length,
    templates: templates.length,
    campanhas: campanhas.length,
    campanhasMigraveis: campanhas.filter(k => k.status === 'DRAFT' || k.status === 'READY').length,
    contas: contas.length,
    /* declarado explicitamente para o utilizador ver o que fica de fora */
    naoMigra: {
      mensagens: Array.isArray(e.mensagens) ? e.mensagens.length : 0,
      fila: Array.isArray(e.fila) ? e.fila.length : 0,
      contas: contas.length
    }
  };
}

function chaveTemplate(t) {
  return String(t.nome || t.name || '').trim().toLowerCase() + '|' + String(t.mensagem || t.body || '').trim();
}

/**
 * Executa a migração através de um cliente remoto.
 * @param {object} estado     estado do LocalOutreachStore
 * @param {object} remoto     RemoteOutreachStore (ou compatível)
 */
export async function migrarParaRemoto(estado, remoto, { incluirCampanhas = false } = {}) {
  const e = estado || {};
  const resumo = {
    contactos: { enviados: 0, criados: 0, atualizados: 0, ignorados: 0 },
    templates: { criados: 0, jaExistiam: 0 },
    campanhas: { criadas: 0, ignoradas: 0 },
    naoMigrado: { mensagens: (e.mensagens || []).length, fila: (e.fila || []).length, contas: (e.contas || []).length }
  };

  /* ---- contactos ---- */
  const contactos = (e.contactos || [])
    .map(c => ({
      leadId: c.leadId || null,
      normalizedInstagram: c.instagram || null,
      name: c.nome || 'Sem nome',
      company: c.empresa || null,
      city: c.cidade || null,
      district: c.distrito || null,
      activity: c.atividade || null,
      source: c.origem || 'migracao-local'
    }))
    .filter(c => c.normalizedInstagram || c.leadId);
  resumo.contactos.enviados = contactos.length;

  if (contactos.length) {
    /* em lotes, para não estourar limites de pedido */
    for (let i = 0; i < contactos.length; i += 500) {
      const r = await remoto.importarContactos(contactos.slice(i, i + 500));
      const s = (r && r.resumo) || {};
      resumo.contactos.criados += Number(s.criados) || 0;
      resumo.contactos.atualizados += Number(s.atualizados) || 0;
      resumo.contactos.ignorados += Number(s.ignorados) || 0;
    }
  }

  /* ---- templates (dedupe por nome+corpo) ---- */
  const existentes = new Set(
    (((await remoto.listarTemplates({ limit: 200 })) || {}).items || []).map(chaveTemplate)
  );
  for (const t of (e.templates || [])) {
    if (existentes.has(chaveTemplate(t))) { resumo.templates.jaExistiam += 1; continue; }
    await remoto.criarTemplate({ name: t.nome || t.name, body: t.mensagem || t.body });
    existentes.add(chaveTemplate(t));
    resumo.templates.criados += 1;
  }

  /* ---- campanhas: só rascunhos, só a pedido, e sem fila ---- */
  if (incluirCampanhas) {
    const contas = ((await remoto.listarContas()) || {}).items || [];
    for (const k of (e.campanhas || [])) {
      if (k.status !== 'DRAFT' && k.status !== 'READY') { resumo.campanhas.ignoradas += 1; continue; }
      if (!contas.length) { resumo.campanhas.ignoradas += 1; continue; }
      await remoto.criarCampanha({ name: k.nome, accountId: contas[0].id, body: k.mensagem });
      resumo.campanhas.criadas += 1;
    }
  } else {
    resumo.campanhas.ignoradas = (e.campanhas || []).length;
  }

  return resumo;
}

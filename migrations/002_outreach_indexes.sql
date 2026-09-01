-- =====================================================================
-- LeadMap Pro — Outreach Fase C · 002 índices
-- ---------------------------------------------------------------------
-- Cada índice existe para uma consulta concreta do worker ou da API.
-- =====================================================================

-- O worker procura sempre o mesmo: itens elegíveis, por prioridade e
-- data de disponibilidade. Índice parcial porque só PENDING interessa —
-- fica pequeno mesmo com milhões de itens já terminados.
CREATE INDEX IF NOT EXISTS queue_item_claim_idx
  ON outreach.queue_item (priority DESC, available_at ASC, id ASC)
  WHERE status = 'PENDING';

-- Recuperação de locks expirados: varre só o que está PROCESSING.
CREATE INDEX IF NOT EXISTS queue_item_stale_idx
  ON outreach.queue_item (locked_at)
  WHERE status = 'PROCESSING';

-- Painel da campanha e contagens por estado.
CREATE INDEX IF NOT EXISTS queue_item_campaign_idx ON outreach.queue_item (campaign_id, status);
CREATE INDEX IF NOT EXISTS queue_item_account_idx  ON outreach.queue_item (account_id, status);
CREATE INDEX IF NOT EXISTS queue_item_contact_idx  ON outreach.queue_item (contact_id);

-- Mensagens: histórico por campanha e por contacto; reconciliação por
-- id do fornecedor quando um webhook chegar.
CREATE INDEX IF NOT EXISTS message_campaign_idx ON outreach.message (campaign_id, status);
CREATE INDEX IF NOT EXISTS message_contact_idx  ON outreach.message (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS message_provider_idx ON outreach.message (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Listagem de contactos: filtros por estado e ordenação por data.
CREATE INDEX IF NOT EXISTS contact_status_idx  ON outreach.contact (status, created_at DESC);
CREATE INDEX IF NOT EXISTS contact_created_idx ON outreach.contact (created_at DESC);
-- Exclusão de opt-out antes de criar campanha.
CREATE INDEX IF NOT EXISTS contact_opted_out_idx ON outreach.contact (opted_out_at)
  WHERE opted_out_at IS NOT NULL;

-- Campanha ↔ contacto nos dois sentidos.
CREATE INDEX IF NOT EXISTS campaign_contact_contact_idx ON outreach.campaign_contact (contact_id);

-- Listagem de campanhas.
CREATE INDEX IF NOT EXISTS campaign_status_idx ON outreach.campaign (status, created_at DESC);

-- Auditoria: consulta por entidade e por ordem cronológica inversa.
CREATE INDEX IF NOT EXISTS audit_event_entity_idx  ON outreach.audit_event (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_event_created_idx ON outreach.audit_event (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_event_action_idx  ON outreach.audit_event (action, created_at DESC);

-- Webhooks por processar.
CREATE INDEX IF NOT EXISTS webhook_event_pending_idx ON outreach.webhook_event (received_at)
  WHERE processed_at IS NULL;

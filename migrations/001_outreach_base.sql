-- =====================================================================
-- LeadMap Pro — Outreach Fase C · 001 base
-- ---------------------------------------------------------------------
-- Esquema de produção do Outreach. Aplicar por ordem numérica; cada
-- migration é idempotente (IF NOT EXISTS) para poder ser reaplicada sem
-- estragar nada.
--
-- Nenhuma tabela guarda credenciais: nem password de Instagram, nem
-- cookie, nem token de fornecedor. Os tokens vivem em variáveis de
-- ambiente do backend, indexados por provider_account_id.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS outreach;

-- ---------------------------------------------------------------------
-- Contas Instagram
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach.instagram_account (
  id                  TEXT PRIMARY KEY,
  display_name        TEXT NOT NULL,
  username            TEXT NOT NULL,
  provider            TEXT NOT NULL,
  provider_account_id TEXT,
  status              TEXT NOT NULL DEFAULT 'CONNECTED',
  capabilities        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at         TIMESTAMPTZ,
  CONSTRAINT instagram_account_status_chk
    CHECK (status IN ('CONNECTED','DISCONNECTED','TOKEN_EXPIRED','RESTRICTED','RATE_LIMITED','ERROR')),
  -- a mesma conta não pode ser ligada duas vezes pelo mesmo fornecedor
  CONSTRAINT instagram_account_provider_username_uk UNIQUE (provider, username)
);

-- Teto de 5 contas ativas aplicado NO BANCO, não só na UI (§63).
CREATE OR REPLACE FUNCTION outreach.enforce_max_accounts() RETURNS TRIGGER AS $$
DECLARE
  ativas INTEGER;
BEGIN
  SELECT count(*) INTO ativas
    FROM outreach.instagram_account
   WHERE disabled_at IS NULL AND status <> 'DISCONNECTED';
  IF ativas > 5 THEN
    RAISE EXCEPTION 'MAX_ACCOUNTS: limite máximo de 5 contas conectadas'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS instagram_account_max_trg ON outreach.instagram_account;
CREATE CONSTRAINT TRIGGER instagram_account_max_trg
  AFTER INSERT OR UPDATE ON outreach.instagram_account
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION outreach.enforce_max_accounts();

-- ---------------------------------------------------------------------
-- Contactos
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach.contact (
  id                   TEXT PRIMARY KEY,
  lead_id              TEXT,
  normalized_instagram TEXT,
  name                 TEXT NOT NULL,
  company              TEXT,
  city                 TEXT,
  district             TEXT,
  activity             TEXT,
  source               TEXT,
  status               TEXT NOT NULL DEFAULT 'UNKNOWN',
  opted_out_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contact_status_chk
    CHECK (status IN ('UNKNOWN','ELIGIBLE','NOT_ELIGIBLE','OPTED_OUT','SENT','REPLIED')),
  CONSTRAINT contact_identity_chk CHECK (normalized_instagram IS NOT NULL OR lead_id IS NOT NULL)
);

-- Deduplicação real: o Instagram normalizado identifica o contacto; sem
-- ele, o lead_id. São índices parciais porque ambos os campos são opcionais.
CREATE UNIQUE INDEX IF NOT EXISTS contact_instagram_uk
  ON outreach.contact (normalized_instagram)
  WHERE normalized_instagram IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS contact_lead_uk
  ON outreach.contact (lead_id)
  WHERE normalized_instagram IS NULL AND lead_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach.template (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT template_body_chk CHECK (length(body) BETWEEN 1 AND 2000)
);

-- ---------------------------------------------------------------------
-- Campanhas
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach.campaign (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  account_id   TEXT NOT NULL REFERENCES outreach.instagram_account(id) ON DELETE RESTRICT,
  template_id  TEXT REFERENCES outreach.template(id) ON DELETE SET NULL,
  body         TEXT NOT NULL,
  message_version INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'DRAFT',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  paused_at    TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT campaign_status_chk
    CHECK (status IN ('DRAFT','READY','RUNNING','PAUSED','COMPLETED','CANCELLED','FAILED'))
);

-- ---------------------------------------------------------------------
-- Campanha ↔ contacto
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach.campaign_contact (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES outreach.campaign(id) ON DELETE CASCADE,
  contact_id  TEXT NOT NULL REFERENCES outreach.contact(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'PENDING',
  skip_reason TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- impede dupla inclusão do mesmo contacto na mesma campanha (§13)
  CONSTRAINT campaign_contact_uk UNIQUE (campaign_id, contact_id)
);

-- ---------------------------------------------------------------------
-- Mensagens
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach.message (
  id                  TEXT PRIMARY KEY,
  campaign_id         TEXT NOT NULL REFERENCES outreach.campaign(id) ON DELETE CASCADE,
  contact_id          TEXT NOT NULL REFERENCES outreach.contact(id) ON DELETE CASCADE,
  account_id          TEXT NOT NULL REFERENCES outreach.instagram_account(id) ON DELETE RESTRICT,
  provider            TEXT NOT NULL,
  provider_message_id TEXT,
  -- chave determinística: dois "start" concorrentes colidem aqui em vez
  -- de criarem dois envios (§17/§18)
  idempotency_key     TEXT NOT NULL,
  body                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'QUEUED',
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  last_attempt_at     TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  replied_at          TIMESTAMPTZ,
  last_error_code     TEXT,
  last_error_message  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT message_idempotency_uk UNIQUE (idempotency_key),
  CONSTRAINT message_status_chk
    CHECK (status IN ('QUEUED','SENDING','SENT','DELIVERED','READ','REPLIED','FAILED','SKIPPED'))
);

-- ---------------------------------------------------------------------
-- Fila durável
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach.queue_item (
  id                 TEXT PRIMARY KEY,
  message_id         TEXT NOT NULL REFERENCES outreach.message(id) ON DELETE CASCADE,
  campaign_id        TEXT NOT NULL REFERENCES outreach.campaign(id) ON DELETE CASCADE,
  contact_id         TEXT NOT NULL REFERENCES outreach.contact(id) ON DELETE CASCADE,
  account_id         TEXT NOT NULL REFERENCES outreach.instagram_account(id) ON DELETE RESTRICT,
  provider           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'PENDING',
  priority           INTEGER NOT NULL DEFAULT 0,
  available_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  max_attempts       INTEGER NOT NULL DEFAULT 3,
  locked_at          TIMESTAMPTZ,
  locked_by          TEXT,
  last_error_code    TEXT,
  last_error_message TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT queue_item_message_uk UNIQUE (message_id),
  CONSTRAINT queue_item_status_chk
    CHECK (status IN ('PENDING','PROCESSING','SENT','FAILED','SKIPPED','PAUSED','CANCELLED'))
);

-- ---------------------------------------------------------------------
-- Eventos de webhook (modelo apenas — nenhum endpoint real nesta fase)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach.webhook_event (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  payload_redacted  JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'RECEIVED',
  -- o mesmo evento recebido duas vezes não é processado duas vezes (§35)
  CONSTRAINT webhook_event_uk UNIQUE (provider, provider_event_id),
  CONSTRAINT webhook_event_status_chk CHECK (status IN ('RECEIVED','PROCESSED','IGNORED','FAILED'))
);

-- ---------------------------------------------------------------------
-- Auditoria
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach.audit_event (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- updated_at automático
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION outreach.touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['instagram_account','contact','template','campaign','campaign_contact','message','queue_item']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_touch_trg ON outreach.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_touch_trg BEFORE UPDATE ON outreach.%I FOR EACH ROW EXECUTE FUNCTION outreach.touch_updated_at()',
      t, t);
  END LOOP;
END $$;

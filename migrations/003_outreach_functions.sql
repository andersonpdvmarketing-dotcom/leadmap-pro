-- =====================================================================
-- LeadMap Pro — Outreach Fase C · 003 funções transacionais
-- ---------------------------------------------------------------------
-- As operações que não podem ficar a meio vivem aqui, dentro de uma
-- única transação do PostgreSQL. É isto que dá ao sistema as garantias
-- que a Fase B declarou em falta: claim atómico, arranque idempotente e
-- estado consistente entre campanha, mensagens e fila.
--
-- Chamadas por RPC a partir do backend (nunca do browser).
-- =====================================================================

-- ---------------------------------------------------------------------
-- claim_queue_items — o coração da concorrência (§19)
-- ---------------------------------------------------------------------
-- FOR UPDATE SKIP LOCKED: cada worker leva itens diferentes sem esperar
-- pelos outros. Nunca há "SELECT primeiro, UPDATE depois" — a seleção e
-- a marcação acontecem na mesma instrução, na mesma transação.
--
-- Também recupera itens PROCESSING cujo lock expirou (§22), para que um
-- worker que morreu a meio não deixe trabalho preso para sempre.
CREATE OR REPLACE FUNCTION outreach.claim_queue_items(
  p_worker_id     TEXT,
  p_limit         INTEGER DEFAULT 1,
  p_lock_timeout_seconds INTEGER DEFAULT 300
) RETURNS SETOF outreach.queue_item AS $$
BEGIN
  RETURN QUERY
  WITH elegiveis AS (
    SELECT q.id
      FROM outreach.queue_item q
      JOIN outreach.campaign c ON c.id = q.campaign_id
     WHERE c.status = 'RUNNING'                    -- campanha pausada não cede itens (§27)
       AND (
             (q.status = 'PENDING' AND q.available_at <= now())
          OR (q.status = 'PROCESSING'
              AND q.locked_at IS NOT NULL
              AND q.locked_at < now() - make_interval(secs => p_lock_timeout_seconds))
           )
     ORDER BY q.priority DESC, q.available_at ASC, q.id ASC
     LIMIT p_limit
     FOR UPDATE OF q SKIP LOCKED
  )
  UPDATE outreach.queue_item q
     SET status        = 'PROCESSING',
         locked_at     = now(),
         locked_by     = p_worker_id,
         attempt_count = q.attempt_count + 1
    FROM elegiveis e
   WHERE q.id = e.id
  RETURNING q.*;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- start_campaign — arranque idempotente (§53/§54)
-- ---------------------------------------------------------------------
-- Numa só transação: valida, cria campaign_contacts, messages e
-- queue_items. Chamar duas vezes não duplica nada, porque as inserções
-- colidem com as constraints UNIQUE e são ignoradas.
CREATE OR REPLACE FUNCTION outreach.start_campaign(
  p_campaign_id TEXT,
  p_contact_ids TEXT[],
  p_now         TIMESTAMPTZ DEFAULT now()
) RETURNS TABLE (
  incluidos INTEGER,
  excluidos INTEGER,
  criados   INTEGER,
  ja_existiam INTEGER
) AS $$
DECLARE
  v_campaign  outreach.campaign%ROWTYPE;
  v_incluidos INTEGER := 0;
  v_excluidos INTEGER := 0;
  v_criados   INTEGER := 0;
  v_existiam  INTEGER := 0;
  r RECORD;
  v_msg_id   TEXT;
  v_idem     TEXT;
BEGIN
  SELECT * INTO v_campaign FROM outreach.campaign WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAMPAIGN_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_campaign.status IN ('CANCELLED','COMPLETED') THEN
    RAISE EXCEPTION 'CAMPAIGN_TERMINAL: %', v_campaign.status USING ERRCODE = 'check_violation';
  END IF;

  FOR r IN
    SELECT c.* FROM outreach.contact c WHERE c.id = ANY(p_contact_ids)
  LOOP
    -- elegibilidade verificada no banco, não só na UI (§30)
    IF r.normalized_instagram IS NULL THEN
      v_excluidos := v_excluidos + 1;
      INSERT INTO outreach.campaign_contact (id, campaign_id, contact_id, status, skip_reason)
      VALUES (p_campaign_id || ':' || r.id, p_campaign_id, r.id, 'SKIPPED', 'NO_INSTAGRAM')
      ON CONFLICT (campaign_id, contact_id) DO NOTHING;
      CONTINUE;
    END IF;
    IF r.opted_out_at IS NOT NULL OR r.status = 'OPTED_OUT' THEN
      v_excluidos := v_excluidos + 1;
      INSERT INTO outreach.campaign_contact (id, campaign_id, contact_id, status, skip_reason)
      VALUES (p_campaign_id || ':' || r.id, p_campaign_id, r.id, 'SKIPPED', 'OPTED_OUT')
      ON CONFLICT (campaign_id, contact_id) DO NOTHING;
      CONTINUE;
    END IF;

    v_incluidos := v_incluidos + 1;

    INSERT INTO outreach.campaign_contact (id, campaign_id, contact_id, status)
    VALUES (p_campaign_id || ':' || r.id, p_campaign_id, r.id, 'PENDING')
    ON CONFLICT (campaign_id, contact_id) DO NOTHING;

    -- chave determinística: a segunda chamada colide e não cria mensagem
    v_idem := p_campaign_id || ':' || r.id || ':' || v_campaign.account_id
              || ':v' || v_campaign.message_version;
    v_msg_id := 'm:' || v_idem;

    INSERT INTO outreach.message (
      id, campaign_id, contact_id, account_id, provider,
      idempotency_key, body, status
    ) VALUES (
      v_msg_id, p_campaign_id, r.id, v_campaign.account_id,
      (SELECT provider FROM outreach.instagram_account WHERE id = v_campaign.account_id),
      v_idem, v_campaign.body, 'QUEUED'
    )
    ON CONFLICT (idempotency_key) DO NOTHING;

    IF FOUND THEN v_criados := v_criados + 1; ELSE v_existiam := v_existiam + 1; END IF;

    INSERT INTO outreach.queue_item (
      id, message_id, campaign_id, contact_id, account_id, provider, status, available_at
    ) VALUES (
      'q:' || v_idem, v_msg_id, p_campaign_id, r.id, v_campaign.account_id,
      (SELECT provider FROM outreach.instagram_account WHERE id = v_campaign.account_id),
      'PENDING', p_now
    )
    ON CONFLICT (message_id) DO NOTHING;
  END LOOP;

  UPDATE outreach.campaign
     SET status = 'RUNNING', started_at = COALESCE(started_at, p_now)
   WHERE id = p_campaign_id;

  incluidos := v_incluidos; excluidos := v_excluidos;
  criados := v_criados; ja_existiam := v_existiam;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- pause / resume / cancel — persistentes (§27/§28/§29)
-- ---------------------------------------------------------------------
-- Pausar impede NOVOS claims mas não interrompe um item já reclamado:
-- interromper a meio de uma operação já iniciada arriscaria duplicar o
-- envio. O item em curso termina; nenhum outro arranca.
CREATE OR REPLACE FUNCTION outreach.pause_campaign(p_campaign_id TEXT)
RETURNS INTEGER AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE outreach.campaign SET status = 'PAUSED', paused_at = now()
   WHERE id = p_campaign_id AND status IN ('RUNNING','READY');
  UPDATE outreach.queue_item SET status = 'PAUSED'
   WHERE campaign_id = p_campaign_id AND status = 'PENDING';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- Retomar não recria mensagens nem repõe attempt_count (§28).
CREATE OR REPLACE FUNCTION outreach.resume_campaign(p_campaign_id TEXT)
RETURNS INTEGER AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE outreach.campaign SET status = 'RUNNING', paused_at = NULL
   WHERE id = p_campaign_id AND status = 'PAUSED';
  UPDATE outreach.queue_item SET status = 'PENDING'
   WHERE campaign_id = p_campaign_id AND status = 'PAUSED';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- Cancelar não apaga nem reenvia o que já foi SENT (§29).
CREATE OR REPLACE FUNCTION outreach.cancel_campaign(p_campaign_id TEXT)
RETURNS INTEGER AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE outreach.campaign SET status = 'CANCELLED', cancelled_at = now()
   WHERE id = p_campaign_id AND status NOT IN ('CANCELLED','COMPLETED');
  UPDATE outreach.queue_item
     SET status = 'CANCELLED', last_error_code = 'CAMPAIGN_CANCELLED'
   WHERE campaign_id = p_campaign_id AND status IN ('PENDING','PAUSED');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- complete_queue_item — persiste o resultado de uma tentativa
-- ---------------------------------------------------------------------
-- Numa transação: fila + mensagem + contacto. Um item em estado terminal
-- nunca é reaberto (§60), pelo que um segundo worker que chegue tarde
-- não consegue transformar um SENT noutra coisa.
CREATE OR REPLACE FUNCTION outreach.complete_queue_item(
  p_item_id      TEXT,
  p_worker_id    TEXT,
  p_outcome      TEXT,          -- SENT | RETRY | FAILED | SKIPPED
  p_provider_message_id TEXT,
  p_error_code   TEXT,
  p_error_message TEXT,
  p_available_at TIMESTAMPTZ
) RETURNS outreach.queue_item AS $$
DECLARE
  v_item outreach.queue_item%ROWTYPE;
BEGIN
  SELECT * INTO v_item FROM outreach.queue_item WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUEUE_ITEM_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_item.status IN ('SENT','CANCELLED','SKIPPED','FAILED') THEN
    RETURN v_item;                       -- terminal: nada a fazer
  END IF;

  IF p_outcome = 'SENT' THEN
    UPDATE outreach.queue_item
       SET status = 'SENT', locked_at = NULL, locked_by = NULL,
           last_error_code = NULL, last_error_message = NULL
     WHERE id = p_item_id;
    UPDATE outreach.message
       SET status = 'SENT', provider_message_id = p_provider_message_id,
           sent_at = now(), last_attempt_at = now(),
           attempt_count = attempt_count + 1,
           last_error_code = NULL, last_error_message = NULL
     WHERE id = v_item.message_id;
    UPDATE outreach.contact SET status = 'SENT' WHERE id = v_item.contact_id
       AND status NOT IN ('OPTED_OUT','REPLIED');

  ELSIF p_outcome = 'RETRY' THEN
    UPDATE outreach.queue_item
       SET status = 'PENDING', locked_at = NULL, locked_by = NULL,
           available_at = COALESCE(p_available_at, now()),
           last_error_code = p_error_code, last_error_message = p_error_message
     WHERE id = p_item_id;
    UPDATE outreach.message
       SET status = 'QUEUED', last_attempt_at = now(),
           attempt_count = attempt_count + 1,
           last_error_code = p_error_code, last_error_message = p_error_message
     WHERE id = v_item.message_id;

  ELSIF p_outcome = 'SKIPPED' THEN
    UPDATE outreach.queue_item
       SET status = 'SKIPPED', locked_at = NULL, locked_by = NULL,
           last_error_code = p_error_code, last_error_message = p_error_message
     WHERE id = p_item_id;
    UPDATE outreach.message
       SET status = 'SKIPPED', last_error_code = p_error_code, last_error_message = p_error_message
     WHERE id = v_item.message_id;

  ELSE   -- FAILED
    UPDATE outreach.queue_item
       SET status = 'FAILED', locked_at = NULL, locked_by = NULL,
           last_error_code = p_error_code, last_error_message = p_error_message
     WHERE id = p_item_id;
    UPDATE outreach.message
       SET status = 'FAILED', last_attempt_at = now(),
           attempt_count = attempt_count + 1,
           last_error_code = p_error_code, last_error_message = p_error_message
     WHERE id = v_item.message_id;
  END IF;

  -- campanha sem itens por processar fica concluída
  UPDATE outreach.campaign c SET status = 'COMPLETED', completed_at = now()
   WHERE c.id = v_item.campaign_id
     AND c.status = 'RUNNING'
     AND NOT EXISTS (
       SELECT 1 FROM outreach.queue_item q
        WHERE q.campaign_id = c.id AND q.status IN ('PENDING','PROCESSING','PAUSED')
     );

  SELECT * INTO v_item FROM outreach.queue_item WHERE id = p_item_id;
  RETURN v_item;
END;
$$ LANGUAGE plpgsql;

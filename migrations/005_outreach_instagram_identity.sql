-- =====================================================================
-- 005 — identidade Instagram do contacto, com escopo de fornecedor
-- ---------------------------------------------------------------------
-- O webhook da Meta traz um IGSID (`sender.id`). O contacto do LeadMap
-- guarda um `@perfil`. Não havia forma de ligar os dois de maneira
-- persistente, e por isso todo o inbound ficava por associar.
--
-- PORQUÊ COM ESCOPO DE FORNECEDOR
-- -------------------------------
-- Um IGSID é *Instagram-scoped*: só significa alguma coisa dentro da
-- conta profissional que o recebeu, através daquele fornecedor. O mesmo
-- ser humano tem um id diferente noutra app, e um `subscriber_id` da
-- ManyChat não é comparável com um IGSID da Meta. Guardar um "id de
-- Instagram" sem dizer de quem é seria criar colisões entre fornecedores
-- que nunca partilharam espaço de identificadores.
--
-- PORQUÊ NÃO HÁ COLUNA DE ÚLTIMA INTERAÇÃO
-- ----------------------------------------
-- A janela de 24 horas mede-se desde a última mensagem recebida, e isso
-- já existe: `webhook_event.received_at`, com o IGSID no payload. Uma
-- coluna nova seria uma segunda cópia da mesma verdade, e as duas
-- acabariam por divergir.
--
-- Idempotente: `IF NOT EXISTS` em tudo.
-- =====================================================================

ALTER TABLE outreach.contact ADD COLUMN IF NOT EXISTS ig_user_id TEXT;
ALTER TABLE outreach.contact ADD COLUMN IF NOT EXISTS ig_user_id_provider TEXT;
ALTER TABLE outreach.contact ADD COLUMN IF NOT EXISTS ig_user_id_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN outreach.contact.ig_user_id IS
  'Identificador do destinatário no fornecedor (IGSID na Meta). Nunca derivado de um username.';
COMMENT ON COLUMN outreach.contact.ig_user_id_provider IS
  'Fornecedor a que o identificador pertence: meta, manychat ou external.';
COMMENT ON COLUMN outreach.contact.ig_user_id_verified_at IS
  'Quando a identidade foi confirmada pela API do fornecedor. NULL = associada mas por verificar.';

-- Os dois campos andam sempre juntos: um identificador sem fornecedor
-- não se pode comparar com nada.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'contact_ig_identity_chk'
       AND conrelid = 'outreach.contact'::regclass
  ) THEN
    ALTER TABLE outreach.contact ADD CONSTRAINT contact_ig_identity_chk
      CHECK (
        (ig_user_id IS NULL AND ig_user_id_provider IS NULL)
        OR (ig_user_id IS NOT NULL AND ig_user_id_provider IS NOT NULL)
      );
  END IF;
END $$;

-- Um destinatário pertence a UM contacto. Parcial porque a esmagadora
-- maioria dos contactos não tem identificador — e vários NULL têm de
-- continuar a ser válidos.
CREATE UNIQUE INDEX IF NOT EXISTS contact_provider_recipient_uk
  ON outreach.contact (ig_user_id_provider, ig_user_id)
  WHERE ig_user_id IS NOT NULL;

-- Procura pelo caminho quente: webhook chega com um IGSID e é preciso
-- saber de quem é.
CREATE INDEX IF NOT EXISTS contact_ig_user_id_idx
  ON outreach.contact (ig_user_id) WHERE ig_user_id IS NOT NULL;

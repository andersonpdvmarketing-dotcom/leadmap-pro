-- =====================================================================
-- 004 — email e telefone no contacto
-- ---------------------------------------------------------------------
-- A ManyChat não permite procurar subscribers por username de Instagram.
-- Os únicos campos que a API aceita em `findBySystemField` são o email e
-- o telefone — e o contacto do Outreach não guardava nenhum dos dois.
--
-- Sem estas colunas, a estratégia de emparelhamento escolhida
-- (email → telefone → subscriber_id manual) não tem por onde começar:
-- todos os contactos caem em NO_LOOKUP_DATA.
--
-- Migration nova em vez de alterar a 001: a 001 já correu contra bases
-- reais, e reescrevê-la partia o histórico de quem já a aplicou.
--
-- Idempotente: `IF NOT EXISTS` em tudo.
-- =====================================================================

ALTER TABLE outreach.contact ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE outreach.contact ADD COLUMN IF NOT EXISTS phone TEXT;

-- Guardados já normalizados, para que a procura na ManyChat use
-- exatamente o mesmo valor que foi gravado.
COMMENT ON COLUMN outreach.contact.email IS
  'Email normalizado (trim + minúsculas). Usado em ManyChat findBySystemField.';
COMMENT ON COLUMN outreach.contact.phone IS
  'Telefone com indicativo quando conhecido, sem separadores. Nunca se inventa o país.';

-- Índices para o emparelhamento em lote não varrer a tabela toda.
-- Parciais porque a maioria dos contactos não tem estes campos.
CREATE INDEX IF NOT EXISTS contact_email_idx
  ON outreach.contact (email) WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS contact_phone_idx
  ON outreach.contact (phone) WHERE phone IS NOT NULL;

-- NOTA: não há UNIQUE nestes campos de propósito. Duas pessoas podem
-- partilhar um email de empresa (geral@clinica.pt), e transformar isso
-- num conflito impediria importações legítimas. A ambiguidade é
-- resolvida no emparelhamento, que devolve AMBIGUOUS_MATCH e pára.

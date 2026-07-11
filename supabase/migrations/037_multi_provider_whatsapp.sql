-- ============================================================
-- 037_multi_provider_whatsapp.sql
--
-- Estende a tabela `whatsapp_config` para suportar múltiplos
-- provedores (Meta Oficial e APIs não oficiais como MegaAPI/Z-API).
-- Torna colunas específicas da Meta opcionais e adiciona
-- campos genéricos de tipo de provedor e configurações JSONB.
-- ============================================================

-- 1. Remover a restrição NOT NULL das colunas específicas da Meta
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

-- 2. Adicionar colunas para o tipo de provedor e configurações JSONB
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS provider_type TEXT DEFAULT 'meta' CHECK (provider_type IN ('meta', 'megaapi', 'zapi'));
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS provider_settings JSONB DEFAULT '{}'::jsonb;

-- 3. Backfill: Migrar configurações existentes da Meta para o campo JSONB
UPDATE whatsapp_config
SET provider_settings = jsonb_build_object(
  'phone_number_id', phone_number_id,
  'waba_id', waba_id,
  'access_token', access_token,
  'verify_token', verify_token
)
WHERE provider_type = 'meta' AND (provider_settings IS NULL OR provider_settings = '{}'::jsonb);

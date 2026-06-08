-- Truman-parity persona form: voice-characteristic fields collected by the
-- richer "New persona" form. The `voice` column now holds the selected
-- ElevenLabs voice_id (string); these add the surrounding characteristics.
ALTER TABLE sim_personas ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';
ALTER TABLE sim_personas ADD COLUMN IF NOT EXISTS gender TEXT DEFAULT 'unspecified';
ALTER TABLE sim_personas ADD COLUMN IF NOT EXISTS accent TEXT DEFAULT 'neutral';
ALTER TABLE sim_personas ADD COLUMN IF NOT EXISTS speaking_speed TEXT DEFAULT 'normal';
ALTER TABLE sim_personas ADD COLUMN IF NOT EXISTS interruption_level TEXT DEFAULT 'medium';
ALTER TABLE sim_personas ADD COLUMN IF NOT EXISTS background_noise TEXT DEFAULT 'none';
ALTER TABLE sim_personas ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT true;

-- Account scoping for the judge registry. Judges reach AO through a shared
-- gateway in multi-tenant deployments, so custom judges must be visible only
-- to the account that created them. account_id = '' means unscoped — every
-- default judge, and all custom judges on single-tenant/OSS installs (where
-- nothing sends an account id). NOT NULL DEFAULT '' rather than NULL because
-- Postgres treats NULLs as distinct in unique indexes, which would let one
-- account create the same judge name twice.
--
-- Name uniqueness becomes per-account: two accounts can each have
-- metric:appointment_booked. Fan-out rows stay unambiguous — they are read
-- per-session, and sessions carry their own account_id.
ALTER TABLE ao_judges ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ao_judges_name_key') THEN
    ALTER TABLE ao_judges DROP CONSTRAINT ao_judges_name_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_judges_account_name ON ao_judges (account_id, name);
CREATE INDEX IF NOT EXISTS idx_judges_account ON ao_judges (account_id);

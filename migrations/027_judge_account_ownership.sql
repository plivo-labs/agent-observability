-- Account identifiers are opaque to AO. NULL on defaults means shared/read-only;
-- NULL on legacy customs means ownership has not been established. Scoped callers
-- must never claim such a row merely by knowing its UUID.
ALTER TABLE ao_judges ADD COLUMN IF NOT EXISTS account_id TEXT;

-- Infer an owner only when EVERY mapping has the same known agent owner.
-- Unmapped and ambiguous customs require an operator's ownership reconciliation.
WITH owners AS (
  SELECT aj.judge_id, min(a.account_id) AS account_id
  FROM ao_agent_judges aj
  LEFT JOIN ao_agents a ON a.agent_id = aj.agent_id
  GROUP BY aj.judge_id
  HAVING count(*) = count(NULLIF(btrim(a.account_id), ''))
    AND count(DISTINCT a.account_id) = 1
)
UPDATE ao_judges j SET account_id = owners.account_id
FROM owners
WHERE j.id = owners.judge_id AND j.type = 'custom' AND j.account_id IS NULL;

ALTER TABLE ao_judges DROP CONSTRAINT IF EXISTS ao_judges_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_judges_default_name
  ON ao_judges (name) WHERE type = 'default';
CREATE UNIQUE INDEX IF NOT EXISTS idx_judges_custom_account_name
  ON ao_judges (COALESCE(account_id, ''), name) WHERE type = 'custom';
CREATE INDEX IF NOT EXISTS idx_judges_account ON ao_judges (account_id) WHERE type = 'custom';

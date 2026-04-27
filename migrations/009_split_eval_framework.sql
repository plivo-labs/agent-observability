-- Split the conflated `framework` field on eval_runs into two distinct
-- concepts:
--   * `framework`           — agent framework family (livekit / pipecat / …)
--   * `testing_framework`   — test framework that ran the suite (pytest /
--                             vitest / …)
--
-- Old columns map as:
--     framework          -> testing_framework         (pytest / vitest)
--     framework_version  -> testing_framework_version
--     sdk                -> framework                 (livekit-agents -> livekit)
--     sdk_version        -> framework_version
--
-- We rename the testing-framework columns first (so the new `framework` slot
-- is free), then rename the SDK columns into the freed `framework` slot.
-- After the rename, normalize legacy values: `livekit-agents` → `livekit`,
-- `pipecat-ai` / `pipecat-ai-flows` → `pipecat`.

ALTER TABLE eval_runs RENAME COLUMN framework         TO testing_framework;
ALTER TABLE eval_runs RENAME COLUMN framework_version TO testing_framework_version;

ALTER TABLE eval_runs RENAME COLUMN sdk         TO framework;
ALTER TABLE eval_runs RENAME COLUMN sdk_version TO framework_version;

UPDATE eval_runs
SET framework = 'livekit'
WHERE framework = 'livekit-agents';

UPDATE eval_runs
SET framework = 'pipecat'
WHERE framework IN ('pipecat-ai', 'pipecat-ai-flows');

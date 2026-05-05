-- Cached portion of prompt_tokens (OpenAI prompt_tokens_details.cached_tokens
-- / Anthropic cache_read_input_tokens). Always <= prompt_tokens.
-- Stays 0 until the transport SDKs start emitting it on usage events.
ALTER TABLE eval_cases ADD COLUMN IF NOT EXISTS cached_prompt_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE eval_runs  ADD COLUMN IF NOT EXISTS cached_prompt_tokens BIGINT NOT NULL DEFAULT 0;

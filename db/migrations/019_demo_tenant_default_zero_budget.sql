-- Gate new tenants out of LLM-backed runs by default.
-- Existing tenants keep their current budget; only future inserts get 0.
-- To grant a tenant runs: UPDATE tenants SET llm_budget_tokens_monthly = 1000000 WHERE id = '...';

ALTER TABLE tenants
  ALTER COLUMN llm_budget_tokens_monthly SET DEFAULT 0;

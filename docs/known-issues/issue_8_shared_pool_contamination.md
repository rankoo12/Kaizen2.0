# Issue 8: Shared Pool Contamination from Manual Overrides

When a user manually selects a DOM candidate to override an LLM/pgvector choice, we currently insert the correct selector into the tenant's scoped `selector_cache` and purge the old selector. We **deliberately do not** push the user's manual override directly into the global shared pool (`is_shared = true`, L4).

### The Problem
If we allow manual overrides to instantly populate the shared pool, a single malicious or mistaken user could poison the global selector pool for all other tenants on that domain. However, by restricting overrides to the tenant level, other tenants might continue experiencing the same incorrect LLM resolution until the L4 crawler or natural verification catches up.

### Potential Solution
Implement a consensus or threshold-based promotion mechanism for shared selectors:
- **Thresholds**: "If X% of tenants manually override to the same selector, then it's probably the correct selector and can be promoted to the global shared pool."
- **Crawler Validation**: Flag the user's overridden selector for priority re-validation by the headless worker crawler. Once the crawler verifies it independently, it can be marked as shared.

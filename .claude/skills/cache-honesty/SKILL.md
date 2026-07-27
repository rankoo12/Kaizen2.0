---
name: cache-honesty
description: Prove Kaizen's warm/hot runs execute against the LIVE browser and never false-pass from a stale cache. Poison a cached selector, confirm the run FAILS, verify src=redis on a clean repeat, and exercise the self-heal path. Use when the user says /cache-honesty, "does the hot run just replay from redis", or after any change to the resolver / cache / healing layers.
---

# Cache Honesty

The claim under test: a warm run reuses cached SELECTOR STRINGS but still drives a real browser on the live site — so a stale cache causes a FAILURE, never a false green. Assertions bypass cache entirely.

## Facts to hold
- Cache chain: L0 archetype → L1 Redis → L2 Postgres `db_exact` → L3/L4 pgvector → L5 LLM. Cache hits are returned UNVALIDATED; validation happens at execution (`page.click` / `page.fill`).
- Redis keys (no prefix): `sel:{tenantId}:{targetHash}:{domain}` (1h TTL). Healing budget: `healing:resolve_retry:{tenantId}`, MAX 2/hr.
- **`selector_cache.content_hash` stores the step's `targetHash`, not `contentHash`.** Key any manual poke on `targetHash`.

## Protocol
1. **Warm it** — run a passing test twice. The second run's resolved steps should show `src=redis` (or `db_exact`) and still PASS live. Confirm `sel:*` keys exist (`redis-cli KEYS 'sel:*'`).
2. **Poison** — `UPDATE selector_cache SET selectors='[{"selector":"#bogus-does-not-exist"}]' WHERE content_hash = '<targetHash>'` and delete the matching `sel:` key. Re-run. The run MUST FAIL (or self-heal then pass — see step 3). **If it passes with `#bogus`, that is a false-pass defect** — the cache is replaying instead of executing. Root-cause immediately.
3. **Self-heal** — with a TIMING / ELEMENT_OBSCURED classification, `ResolveAndRetryStrategy` should re-resolve, overwrite `selector_cache.selectors` (keyed on `targetHash`), restore confidence, and the NEXT run should pass from the corrected cache. If the heal budget is exhausted (`healing:resolve_retry:*`), delete the key to re-test.
4. **Report** — for each step: `src=`, verdict, and whether the poison surfaced as a failure. A stale cache that produces green is the finding that matters most.

## Guardrail
Never leave poisoned rows behind — the browser validates, but the next real run inherits the bad selector until it heals. Restore the row or let the heal path correct it, and confirm before finishing.

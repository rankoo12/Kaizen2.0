# Spec: Archetype fallback after verdict=fail

Created: 2026-04-27
Updated: 2026-04-27

## 1. Reproduction

Same shape as the previous "ambiguous cache write" bug
([spec-element-resolver-ambiguous-cache-write.md](spec-element-resolver-ambiguous-cache-write.md)),
but via the **archetype** path instead of `db_exact`.

Step text: `under signup type testingKaizen@kaizen.com in signup-email`.

| Run | Resolution source | Selector returned | User verdict |
|---|---|---|---|
| 1 | LLM (correct) | `[data-kaizen-id='kz-14']` | fail (wrong; first run was archetype, this is run that the user clicked when they marked previous as fail) |
| 2 | LLM (correct again) | `[data-kaizen-id='kz-14']` | (n/a) |
| 3 | **archetype** (wrong) | `role=textbox[name='Email Address']` | fail again |

Run 3 shouldn't be possible: the user already marked fail on the same archetype
match in a prior run. The verdict route writes a row to `archetype_failures`
with `(tenant_id, domain, target_hash, archetype_name)`, and the archetype
resolver is supposed to read that cooldown set and skip matching archetypes.

The bug is one of:

- **A.** The cooldown row isn't being written. Possible causes:
  - `step_results.archetype_name` is NULL on the failed run, so the
    [verdict route](src/api/routes/runs.ts) at L#358 short-circuits.
  - `runs.environment_url` is NULL, same short-circuit.
- **B.** The cooldown row is written but the resolver doesn't read it on the
  next run. Possible causes:
  - The resolver queries by a different key shape (e.g. `domain` mismatch:
    `new URL(...).hostname` vs full URL).
  - The cooldown 24-hour window is being computed wrong.
- **C.** A *different* archetype (not the one cooled down) matches on run 3
  and produces the same wrong selector. The cooldown is keyed by
  `archetype_name`; a sibling archetype with overlapping coverage isn't
  cooled. This is the most likely cause — and the hardest to distinguish from
  A/B without trace logs.
- **D.** The LLM's correct selector from run 2 was never persisted to
  `selector_cache` (preserve-cache regression?), so run 3 falls all the way
  back to archetype matching.

Investigation is part of implementation. The spec just frames what's broken.

## 2. Goal

When a user marks a step `failed`, the wrong selector should not return on any
future run for the same `(tenant_id, target_hash, environment_url)` — through
**any** resolution path: archetype (L0), Redis (L1), db_exact (L2),
pgvector tenant (L3), pgvector shared (L4), LLM (L5).

The previous fix closed L2/L3/L4 and partially L0 (cooldown for the matched
archetype only). This spec finishes L0 by **selector-based blocking** rather
than archetype-name-based blocking, so a sibling archetype that returns the
same wrong selector is also blocked.

## 3. Design

### 3.1 New cooldown table column or new table

Two options:

**Option A — extend `archetype_failures`.** Add the existing row's behaviour
plus: after writing a failure row, the archetype resolver checks
`archetype_failures.selector_used` for any row matching `(tenant_id, domain,
target_hash)` regardless of `archetype_name`, and rejects any candidate
selector that matches.

**Option B — new `selector_blocklist` table.** Single-purpose: `(tenant_id,
domain, target_hash, blocked_selector, created_at)`. Read by every layer of
the resolver chain after generating a candidate.

Option A reuses the existing schema and is enough for this fix. Option B is
cleaner long-term but is its own migration. **This spec picks A.**

### 3.2 Verdict route change

No change. The route already writes `archetype_failures` with
`selector_used`. Confirm via integration test that `selector_used` is in
fact non-NULL when the route is hit.

### 3.3 Archetype resolver change

In `src/modules/element-resolver/archetype.element-resolver.ts`, add a second
check after the existing per-archetype cooldown:

1. (Existing) Look up `archetype_failures` rows for
   `(tenant_id, domain, target_hash)`.
2. (Existing) Build a Set of `archetype_name` values to skip.
3. **(New)** Build a Set of `selector_used` values (the wrong selectors the
   user has already rejected).
4. (Existing) Run archetype matchers; for each candidate selector,
   **(New)** reject the candidate if its top selector ∈ the rejected-selector
   Set.
5. If every archetype's top selector is rejected, return null and let the
   chain fall through to L1+.

### 3.4 Other layers — drive-by check

Run a sanity check that every other layer also honours selector_used
rejections written by the verdict route:

- L1/L2/L3/L4 already delete by `target_hash` (existing behaviour) — covered.
- The drive-by question is whether the **shared pool** (L4) writes new rows
  later that contain the rejected selector. The previous fix added a
  catch-all DELETE in the verdict route at runs.ts L303-314 by selector
  contents. Trust but verify with a test.

## 4. Investigation steps (do these first)

Before writing code, confirm cause from the list in §1 by:

1. Reproduce the bug with a fresh DB (`scripts/truncate-caches.ts`). Trigger
   the three runs.
2. After run 1, query
   `SELECT archetype_name, selector_used, resolution_source FROM step_results WHERE run_id = ...;`
   Confirm whether `archetype_name` is NULL or populated.
3. After marking fail, query
   `SELECT * FROM archetype_failures WHERE tenant_id = ... AND target_hash = ...;`
   Confirm a row exists with the correct `selector_used`.
4. After run 2 (LLM correct), query `selector_cache` for that
   `(tenant_id, content_hash)`. Confirm a row exists with the correct
   selector.
5. After run 3 (archetype wrong), check `step_results.archetype_name` on the
   wrong row. If it's a different archetype than the one in
   `archetype_failures`, the bug is C (sibling archetype) and the §3.3 fix
   applies.
6. If selector_cache from step 4 was missing, the bug is D and a separate
   investigation into LLM resolver cache writes is needed.

## 5. Test plan

Unit test in `src/modules/element-resolver/__tests__/archetype.element-resolver.test.ts`:

1. Given a row in `archetype_failures` with `selector_used = X`, the resolver
   does **not** return X even if a different archetype matches X.
2. Given two archetypes match — one with the rejected selector, one with a
   fresh selector — the resolver returns the fresh selector.
3. The 24-hour cooldown window still applies to selector-based blocking.

Integration test in `src/api/routes/__tests__/runs.test.ts` (or the verdict
test file):

1. Create case → run → archetype-resolved → mark fail. Re-run → archetype
   resolver returns null (or fresh selector) → falls through to LLM.
2. The same selector being returned by **a different** archetype on the same
   step is also blocked.

Manual verification mirrors the §1 reproduction: three runs, third run no
longer returns `role=textbox[name='Email Address']`.

## 6. Risks

- **False blocking.** A user might mark fail on a step that was actually
  correct (UI mistake). The selector then gets blocked for the whole 24-hour
  window. Acceptable — verdict was always treated as ground truth.
- **Cooldown window length.** The existing 24h window might be too long for
  iterative debugging. Out of scope; configurable in a follow-up.
- **Performance.** The selector-Set check is O(n) per archetype candidate
  per step. With single-digit cooled selectors per target this is
  negligible. If we ever scale this to thousands of cooled selectors per
  tenant, an index on `archetype_failures.selector_used` becomes worth it.

## 7. Related

- [spec-element-resolver-ambiguous-cache-write.md](spec-element-resolver-ambiguous-cache-write.md) —
  the cache-write side of the same family of bug.
- [spec-element-resolver-archetype-disambiguation.md](spec-element-resolver-archetype-disambiguation.md) —
  the original archetype tie-break / cooldown work.
- [spec-element-resolver-cache-semantic-guard.md](spec-element-resolver-cache-semantic-guard.md) —
  cache hits guarded by stored embeddings.

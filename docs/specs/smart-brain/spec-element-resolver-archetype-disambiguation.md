# Spec: Element Resolver — Archetype Disambiguation & Failure Signal

**Status:** Draft
**Created:** 2026-04-21
**Branch:** `fix/element-resolver/archetype-ambiguous-match`
**Spec ref:** [spec-smart-brain-layer0.md](./spec-smart-brain-layer0.md) (Layer 0 archetype library)
**Depends on:** current archetype resolver behaviour in [src/modules/element-resolver/archetype.element-resolver.ts](../../../src/modules/element-resolver/archetype.element-resolver.ts) and [db.archetype-resolver.ts](../../../src/modules/element-resolver/db.archetype-resolver.ts)

---

## Problem

Two distinct defects combine to produce one user-visible symptom: **the archetype layer (L0) confidently routes a step to the wrong DOM element, and marking the step as failed in the UI does nothing — the next run picks the same wrong element again.**

Real repro from 2026-04-20:
> Step: _"type rankoo in the username field"_
> Resolved: `role=textbox[name="Password"]`
> Result: value typed into the password field.
> User marks step failed → next run: same archetype hit, same wrong selector, same outcome.

### Failure modes

**F1 — First-match-wins in `match()`.**
[db.archetype-resolver.ts](../../../src/modules/element-resolver/db.archetype-resolver.ts) iterates archetypes in SQL order (`ORDER BY role, name`) and returns on the first pattern that matches. Two archetypes with overlapping name_patterns (e.g. `full_name_input` with pattern `"name"` vs. any other `*_input` archetype on a candidate whose accessible name happens to contain that token) resolve deterministically to whichever sorts first alphabetically. There is no ambiguity check.

**F2 — Candidate ranking ignores archetype semantics.**
[archetype.element-resolver.ts](../../../src/modules/element-resolver/archetype.element-resolver.ts) `rankCandidates()` scores by word-overlap against `step.targetDescription`. When the target description uses a word the DOM does not expose (e.g. page labels the field "Email or Username" but step says "username"), _every_ candidate scores 0 and the name-length tiebreak picks the shortest `name` field. "Password" (8 chars) beats "Email Address" (13 chars) and wins the tie — producing a selector for the password textbox when the step asked for the username textbox.

**F3 — `recordFailure` is a no-op at L0.**
[archetype.element-resolver.ts:125-126](../../../src/modules/element-resolver/archetype.element-resolver.ts#L125-L126) — `recordFailure` is empty. A user marking the step failed via the UI invokes `composite.recordFailure(...)`, which fans out to each resolver, but the archetype resolver discards the signal. Next run: identical chain, identical outcome. Zero learning at L0.

### Why this is different from the dom-pruner whitespace bug

The dom-pruner fix ([spec-dom-pruner-aria-snapshot.md](../dom-pruner/spec-dom-pruner-aria-snapshot.md)) makes selector names _exact_. That is necessary but not sufficient: an exact selector for the wrong element is still wrong. This spec addresses selection correctness, not name fidelity.

---

## Solution (three narrow changes)

### S1 — Ambiguity guard in `match()`

Collect _all_ archetypes that match the candidate's (role, action, name) triple. Resolve as follows:

- **0 matches** → null (unchanged).
- **1 match** → return it (unchanged).
- **≥ 2 matches** →
  - If one match has confidence ≥ `best.confidence - AMBIGUITY_MARGIN` over _all_ others, return it.
  - Otherwise return null and log `archetype_resolver.ambiguous` with the candidate + matched archetype names.

`AMBIGUITY_MARGIN = 0.10` (confidence is on [0,1]; ten points is enough to prefer a high-confidence `password_input` over a permissive `full_name_input` with `"name"` pattern).

Tie → null is deliberate: L1–L5 are cheap enough that an ambiguous L0 hit is strictly worse than a miss.

### S2 — Target-description filter at candidate selection

Before scoring candidates, filter by _keyword salience_ against `step.targetDescription`:

1. Extract content words from the target description (drop stopwords like `the`, `a`, `in`, `to`, action verbs like `type`, `click`, `enter`).
2. For each candidate, compute overlap with:
   - the candidate's `name` (existing behaviour), AND
   - the candidate's DOM context (`attributes.id`, `attributes.name`, `attributes.placeholder`, `attributes["aria-label"]`, `parentContext`).
3. Rank by combined score.

Rationale: when the page label is "Email or Username" but the user says "username", the `<input name="username">` attribute carries the signal. This is a pure ranking change; a low-scoring candidate is still considered (top-5 iteration stays).

### S3 — Cooldown table for `recordFailure`

Introduce a short-lived per-target cooldown so a user-marked failure suppresses the same archetype pick on retry:

**Schema** — new table `archetype_failures`:
```sql
CREATE TABLE archetype_failures (
  tenant_id         uuid NOT NULL,
  domain            text NOT NULL,
  target_hash       text NOT NULL,
  archetype_name    text NOT NULL,
  selector_used     text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, domain, target_hash, archetype_name)
);
CREATE INDEX archetype_failures_created_at_idx ON archetype_failures (created_at);
```

**Cooldown window:** `ARCHETYPE_FAILURE_COOLDOWN_HOURS = 24` (configurable). Rows older than the window are ignored by the reader and purged by a background prune.

**Reader:** `ArchetypeElementResolver.resolve` skips any `(archetypeName, selector)` present in the table for the current `(tenant_id, domain, targetHash)`.

**Writer:** `ArchetypeElementResolver.recordFailure` inserts a row (`ON CONFLICT DO UPDATE SET created_at = now()`) using the selector that was attempted. Fire-and-forget safe; errors logged only.

**Why a separate table (not reuse `selector_cache` failure window):** archetype resolutions are not written to `selector_cache` (see [archetype.element-resolver.ts](../../../src/modules/element-resolver/archetype.element-resolver.ts) — `fromCache: false`). Reusing the outcome_window machinery would require inventing synthetic cache rows and would conflate "this cached selector broke" with "this archetype is wrong for this target," which are different remedies.

---

## Acceptance Tests

### AT-1: Username/password disambiguation (F2)

Page: `<input name="username" placeholder="Email Address">` and `<input name="password" placeholder="Password">`.
Step: `type rankoo in the username field`.
Expected: resolver returns `role=textbox[name="Email Address"]` (or the DOM-exposed AX name for the username field), **not** `role=textbox[name="Password"]`.
Regression guard: assert that the selected candidate's `attributes.name === "username"`.

### AT-2: Ambiguous archetype match (F1)

Candidate: `role=textbox`, accessible name `"name"`.
Archetype library: two archetypes match the name `"name"` with patterns from different families.
Expected: `match()` returns null. `obs.increment('archetype_resolver.ambiguous')` fires with both archetype names.

### AT-3: Confident archetype match with close loser (F1)

Candidate: `role=textbox`, name `"password"`.
Archetype library: `password_input` (confidence 0.95), plus a permissive generic input (confidence 0.60) that also matches `"password"`.
Expected: `match()` returns `password_input` because 0.95 − 0.60 = 0.35 > 0.10 margin.

### AT-4: Mark-failed suppresses archetype on next run (F3)

1. Run step → archetype resolver returns `role=textbox[name="Password"]`.
2. User marks step failed → `composite.recordFailure(targetHash, domain, 'role=textbox[name="Password"]')` is invoked.
3. Re-run step in the same test run → archetype resolver must NOT return `password_input` for this `(tenantId, domain, targetHash)` until `ARCHETYPE_FAILURE_COOLDOWN_HOURS` elapses; resolution falls through to L1.
4. After the cooldown, the archetype is eligible again.

### AT-5: Cooldown is tenant-scoped

Two tenants marking the same archetype failed on the same domain+target MUST have independent cooldowns. Cross-tenant leakage is a multi-tenancy violation.

---

## Affected Files

| File | Change |
|---|---|
| `src/modules/element-resolver/db.archetype-resolver.ts` | `match()` becomes "collect all hits, apply ambiguity margin"; new prepared-statement reader for cooldown table |
| `src/modules/element-resolver/archetype.element-resolver.ts` | `rankCandidates()` folds DOM attribute signals into score; new cooldown check before archetype call; `recordFailure` writes to `archetype_failures` |
| `src/modules/element-resolver/archetype.interfaces.ts` | New `recordFailure(candidate, archetypeName, selector, ctx)` method on `IArchetypeResolver` |
| `src/modules/element-resolver/__tests__/archetype.element-resolver.test.ts` | Add AT-1, AT-4, AT-5 |
| `src/modules/element-resolver/__tests__/db.archetype-resolver.test.ts` | Add AT-2, AT-3 + cooldown reader/writer tests |
| `db/migrations/NNN_archetype_failures.sql` | New table + indexes |
| `src/types/index.ts` | Widen `CandidateNode` usage if needed to carry `attributes` into ranker (already present) |

---

## Observability

New counters:
- `archetype_resolver.ambiguous` — match collapsed to null because ≥ 2 archetypes tied within the margin.
- `archetype_resolver.cooldown_skip` — candidate was eligible but skipped because of a recent failure row.
- `archetype_resolver.record_failure` — user-driven failure was recorded successfully.
- `archetype_resolver.record_failure_error` — DB insert for cooldown row failed.

All existing `resolver.archetype_*` counters stay unchanged.

---

## Known Risks

- **Cooldown table growth:** per `(tenant, domain, target_hash, archetype_name)` with a 24h window. Bounded by distinct targets a tenant tests per day — low cardinality in practice. Add a prune job (delete rows older than 7 days) if volume becomes a problem.
- **Ambiguity-margin tuning:** 0.10 is an educated starting point. If production logs show `archetype_resolver.ambiguous` rate climbing above ~5% of L0 attempts, widen the margin _or_ adjust seed confidences, don't widen blindly.
- **Attribute signal noise:** generic attributes (e.g. `id="field-1"`) may accidentally pull unrelated target-description tokens. Stopword list for attribute values should strip common prefixes like `field-`, `input-`, digits.

---

## Out of Scope

- Teaching archetypes from user feedback (promotion/demotion beyond the existing `learn()` path). Separate spec if needed.
- UI changes to show "this archetype was skipped because you marked it failed" — purely backend for v1.
- Rewriting the full archetype library. Disambiguation works with the current seed set.

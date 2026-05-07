# Spec: Archetype Verdict Cooldown — Permanence + Uniqueness Probe

Created: 2026-04-30
Updated: 2026-04-30

## 1. Reproduction

Step text: `under signup type testingKaizen@kaizen.com in signup-email`.

Sequence today:

| Run | Resolution | Selector | Verdict |
|---|---|---|---|
| 1 | archetype | `role=textbox[name="Email Address"]` | user marks fail |
| 2 | LLM | `[data-kaizen-id='kz-14']` … then writes `selector_cache` row (correct) | passes |
| 3 (within 24h) | (cooldown blocks archetype) → cache → correct | — | passes |
| 4 (after 24h) | **archetype again** → `role=textbox[name="Email Address"]` (wrong) | passes silently / fail again |

Run 4 is the bug: 24h after the verdict the `archetype_failures` row falls
out of the resolver's cooldown query window
(`created_at > now() - 24 hours`), so the resolver no longer sees the
selector as cooled, and archetype matches first in the chain. The wrong
selector ships before the cache layer is even consulted.

## 2. Diagnosis (three compounding issues)

### 2.1 Cooldown is time-bounded

[`src/modules/element-resolver/db.archetype-resolver.ts:22`](src/modules/element-resolver/db.archetype-resolver.ts):

```ts
const ARCHETYPE_FAILURE_COOLDOWN_HOURS = 24;
```

And the query:

```sql
SELECT archetype_name, selector_used
  FROM archetype_failures
 WHERE tenant_id = $1 AND domain = $2 AND target_hash = $3
   AND created_at > now() - ($4 || ' hours')::interval
```

A user verdict=fail is treated as "ground truth for 24 hours". After that,
the archetype is rehabilitated automatically. There is no persistence
distinction between "selector was wrong because the page changed mid-test"
(legitimate to retry later) and "user explicitly said this is the wrong
element" (should never come back).

### 2.2 Live-DOM validation accepts non-unique matches

[`src/modules/element-resolver/archetype.element-resolver.ts:179`](src/modules/element-resolver/archetype.element-resolver.ts):

```ts
const handle = await page.$(match.selector);
if (handle === null) continue;
```

`page.$()` returns the **first** match. On automationexercise.com the
selector `role=textbox[name="Email Address"]` actually matches **two**
elements (login email + signup email). The validator sees a non-null
handle, validates as good, and ships the selector. Playwright's
`page.locator(selector).first()` is what eventually clicks at run time —
which is also the first match — so the test silently runs against the
wrong element.

This is a uniqueness gap, not a cooldown gap. Even with no cooldown, an
archetype returning an ambiguous selector should be rejected.

### 2.3 Architecture: archetype runs before the cache

[`composite.element-resolver.ts:14-17`](src/modules/element-resolver/composite.element-resolver.ts):

```
[0] ArchetypeElementResolver (L0)
[1] CachedElementResolver   (L1–L4)
[2] LLMElementResolver      (L5)
```

Even when the LLM (run 2) successfully writes a correct selector to
`selector_cache`, that row is **never read** on run 4 because archetype
returns first and short-circuits the chain. The cached correct answer is
dead weight.

The chain order is intentional today (archetype is cheap, no DB / no
embedding cost), but it relies on archetype always being either correct or
cooled-down. When the cooldown expires, that contract breaks.

## 3. Goal

A user verdict=`fail` on a selector for a `(tenant_id, target_hash,
environment_url)` triple is **ground truth, permanent**. That selector
must never be returned by any resolver layer for that target — regardless
of which archetype generates it, regardless of how much time has passed,
until a human explicitly un-marks the verdict.

Independently of the verdict mechanism, archetype must reject any
selector that resolves to ≠ 1 elements live on the page, so future
ambiguity bugs that haven't been verdict-marked yet still get caught.

## 4. Design

### 4.1 Permanent selector block via `pinned_at` (option C from prior conversation)

`archetype_failures` already has a `created_at` column. Add an optional
`expires_at` column (nullable timestamp) and let the cooldown query treat
NULL as "never expires":

```sql
ALTER TABLE archetype_failures
  ADD COLUMN expires_at timestamptz NULL;
```

The cooldown query becomes:

```sql
SELECT archetype_name, selector_used
  FROM archetype_failures
 WHERE tenant_id = $1 AND domain = $2 AND target_hash = $3
   AND (expires_at IS NULL OR expires_at > now())
```

Verdict route writes rows with `expires_at = NULL` (permanent) when
`user_verdict = 'failed'` is recorded. The 24-hour rolling cooldown that
exists today is preserved for **non-user-driven failures** (worker-side
healing, transient DOM mismatches) which still write rows with
`expires_at = now() + 24 hours`.

This is symmetric with the existing `selector_cache.pinned_at` pattern
used by the manual-override feature: pinned = permanent positive,
NULL-expires = permanent negative.

### 4.2 Live uniqueness probe

In `archetype.element-resolver.ts`, replace the `page.$(selector)` check
with a `page.locator(selector).count()` check:

```ts
const count = await page.locator(match.selector).count();
if (count !== 1) {
  this.observability.increment('resolver.archetype_dom_miss', {
    archetype: match.archetypeName,
    reason: count === 0 ? 'no_match' : 'ambiguous',
    count,
  });
  continue;
}
```

A selector that matches multiple elements is rejected just like a
selector that matches none. The chain falls through to cache (which may
have a more specific cached selector) or the LLM (which can pick by
context).

### 4.3 Self-healing dead-letter: archetype consults cache before returning

Even with §4.1 + §4.2, there's still a one-time wrong run after a 24h+
gap if the first archetype match is unique-but-wrong (e.g. the page
structure subtly changed and the new "Email Address" textbox happens to
be the only match). The defense-in-depth move: archetype, **after**
matching and validating uniqueness, checks whether the same
`(tenant_id, content_hash, domain)` has a non-pinned `selector_cache`
row whose top selector differs from archetype's pick. If so, defer to
cache.

Pseudo-code for the new check at the bottom of the archetype resolve
loop, just before returning success:

```ts
if (this.cacheReader) {
  const cached = await this.cacheReader.peek({
    tenantId: context.tenantId,
    contentHash: step.targetHash,
    domain: context.domain,
  });
  if (cached && cached.selectors[0]?.selector !== match.selector) {
    this.observability.increment('resolver.archetype_deferred_to_cache', {
      archetype: match.archetypeName,
    });
    return MISS; // let the chain fall through to CachedElementResolver
  }
}
```

This is a **read-only** consult — no mutation. The cache layer that comes
next handles the actual selector return.

This is more conservative than reordering the chain (which would change
the cost profile for every cache miss). It only kicks in when archetype
*would* have returned but disagrees with cache.

### 4.4 Resolver-chain unchanged

The composite chain stays `[Archetype, Cached, LLM]`. §4.3 gives cache an
implicit veto over archetype without rearranging the layers — the
reorder option is rejected for now to avoid changing latency on the much
more common cache-miss path.

## 5. Schema migration

Single migration: `db/migrations/00X_archetype_failures_expires_at.sql`

```sql
ALTER TABLE archetype_failures
  ADD COLUMN expires_at timestamptz NULL;

-- Backfill: every existing row was written under the old 24h convention.
-- Honor that for in-flight rows.
UPDATE archetype_failures
   SET expires_at = created_at + interval '24 hours'
 WHERE expires_at IS NULL;
```

After the backfill, NULL = permanent and existing rows behave identically
to today (they expire 24h after their original write).

## 6. Verdict route change

[`src/api/routes/runs.ts`](src/api/routes/runs.ts) (the section that
INSERTs into `archetype_failures` on verdict=failed):

```ts
await pool.query(
  `INSERT INTO archetype_failures
     (tenant_id, domain, target_hash, archetype_name, selector_used, expires_at)
   VALUES ($1, $2, $3, $4, $5, NULL)               -- NULL = permanent
   ON CONFLICT (tenant_id, domain, target_hash, archetype_name)
   DO UPDATE SET selector_used = EXCLUDED.selector_used,
                 created_at    = now(),
                 expires_at    = NULL`,            -- upgrade to permanent on re-verdict
  [tenantId, cooldownDomain, targetHash, archetypeName, selectorUsed],
);
```

Worker-side failures (the non-user path) keep writing
`expires_at = now() + interval '24 hours'`.

## 7. Un-mark / un-block flow (out of scope, but considered)

If a user changes their mind ("oh I marked the wrong one fail"), the
manual-candidate-override flow already pins a positive cache row, which
means the chain returns from cache regardless of what archetype thinks.
The negative `archetype_failures` row stays around but is harmless once
cache is pinned.

Explicit un-marking — wiping the failures row — is a follow-up if users
ask for it. Not in this spec.

## 8. Test plan

Unit (`db.archetype-resolver.test.ts`):

1. Row with `expires_at IS NULL` is returned by the cooldown query forever.
2. Row with `expires_at < now()` is excluded.
3. Row with `expires_at > now()` is included.
4. Backfill behaviour: rows with `created_at` 25h ago and `expires_at`
   set to `created_at + 24h` are excluded (24h after creation).

Unit (`archetype.element-resolver.test.ts`):

5. `page.locator(s).count() === 0` → archetype miss, falls through.
6. `page.locator(s).count() === 1` → archetype returns the selector.
7. `page.locator(s).count() === 2` → archetype rejects, falls through
   (new behaviour).
8. Cache peek returns a different selector → archetype defers (returns
   MISS), even when its own validation passed.
9. Cache peek returns the same selector → archetype returns normally.
10. `cacheReader` not provided → no peek, archetype returns its match
    (preserves existing call sites that don't wire the reader).

Integration (`runs.test.ts` verdict route):

11. Verdict=failed writes a row with `expires_at = NULL`.
12. Worker-emitted failure (e.g. via `recordFailure()` if any path uses
    it) writes a row with `expires_at = now() + 24h`.

Manual repro:

- Truncate caches.
- Run the §1 sequence; mark fail on run 1.
- Wait > 24h (or set the test row's `created_at` and `expires_at` to
  simulate).
- Run 4 should NOT pick `role=textbox[name="Email Address"]` via
  archetype anymore — chain falls through to cache and returns the
  correct selector.

## 9. Risks

- **False permanent blocks.** A user who clicks fail by mistake permanently
  burns that selector for that step. Acceptable for v1: verdict has always
  been treated as ground truth, and the manual-override flow gives them a
  one-click way to install a positive override.
- **Migration ordering.** The backfill UPDATE must run after the ADD
  COLUMN. The migration script handles both in one file, but operators
  should run migrations cleanly before deploying the new resolver code.
  Old code reading `expires_at` doesn't exist (column is new), so safe.
- **Locator probe latency.** `count()` is one extra round-trip per
  archetype match. Same order of magnitude as the existing `page.$()`,
  so neutral. Real cost is locator setup, which is the same.
- **Cache peek extra DB query.** Adds one indexed `selector_cache` lookup
  per archetype match. Single-digit ms; same query the cache layer would
  run anyway if we let it. Acceptable cost for the dead-letter safety.

## 10. Related

- [spec-archetype-verdict-cooldown.md](spec-archetype-verdict-cooldown.md) —
  the original cooldown work. This spec extends §3.1's "selector-based
  blocking" idea with permanence.
- [spec-element-resolver-ambiguous-cache-write.md](spec-element-resolver-ambiguous-cache-write.md) —
  the cache-side fix for ambiguous selectors. §4.2 of this spec brings
  the same uniqueness check to the archetype layer.
- [spec-manual-candidate-override.md](spec-manual-candidate-override.md) —
  the positive analog: pinned cache rows. This spec adds the negative
  analog: permanent verdict-fail blocks.

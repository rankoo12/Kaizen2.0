# Smart Brain — Layer 0: Element Archetype Library
**Branch:** `feat/tests/brain/archetypes`
**Spec ref:** `kaizen-spec-v3.md` §8 (Element Resolution & Caching)

---

## Goal

Resolve the most common UI elements (login buttons, email inputs, password fields, submit
buttons, etc.) **with zero LLM calls and zero vector search** on any website, even one Kaizen
has never seen before.

The insight: `role=button[name="Log in"]` is a valid ARIA selector on every site that has a
login button — regardless of domain, CSS framework, or component library. We do not need to
learn this from experience. We can encode it once and benefit forever.

Layer 0 runs *before* all other cache layers (L1–L4) and before the LLM (L5). It is the
fastest, cheapest resolution path: a normalised-string lookup against an in-memory table of
known UI archetypes, returning a pre-validated ARIA selector.

---

## Milestone Definition

The milestone is met when:

1. A fresh tenant with no prior cache runs a test step `"click the login button"` against any
   website that has a button with accessible name matching a login archetype (e.g. "Login",
   "Log in", "Sign in"). The step resolves with `resolutionSource: 'archetype'` and
   `tokensUsed: 0`. No LLM call is made.
2. `npm run db:migrate` applies `015_element_archetypes.sql` without error.
3. `npm run archetypes:seed` populates `element_archetypes` with at least 8 entries.
4. The archetype resolver gracefully falls through (returns null) for elements it does not
   recognise — the existing L1–L5 chain continues normally.

---

## What Already Exists (Do Not Rebuild)

| Existing | Location |
|---|---|
| `CompositeElementResolver` — chains resolvers in priority order | `src/modules/element-resolver/composite.element-resolver.ts` |
| `IElementResolver` interface | `src/modules/element-resolver/interfaces.ts` |
| `ResolutionSource` union type | `src/types/index.ts` |
| `SelectorSet` type (incl. `tokensUsed`) | `src/types/index.ts` |
| ARIA selector generation in `PlaywrightDOMPruner` | `src/modules/dom-pruner/playwright.dom-pruner.ts` |
| `CandidateNode.role` + `CandidateNode.name` (AX-tree stable) | `src/types/index.ts` |

**Gaps to close:**

1. No `element_archetypes` DB table.
2. No `IArchetypeResolver` interface or implementation.
3. `ResolutionSource` does not include `'archetype'`.
4. `CompositeElementResolver` supports exactly two resolvers (cached + LLM); L0 needs to be
   prepended.
5. No seed script or npm command for archetypes.

---

## 1. Database Migration: 015

File: `db/migrations/015_element_archetypes.sql`

```sql
-- Migration 015: Element Archetype Library
--
-- Stores universal UI element patterns that resolve via ARIA selectors
-- on any website without embeddings or LLM calls.
--
-- name          : unique slug, e.g. 'login_button'
-- role          : ARIA role to match (exact), e.g. 'button'
-- name_patterns : normalised name variants (lowercase, trimmed) that identify
--                 this archetype, e.g. ARRAY['login', 'log in', 'sign in']
-- action_hint   : if set, only match steps of this action type.
--                 NULL means valid for any action.
-- confidence    : confidence score assigned to ARIA selectors returned by this
--                 archetype. Slightly below 1.0 (0.95) to allow human verdicts
--                 to override pinned entries.

CREATE TABLE IF NOT EXISTS element_archetypes (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT        NOT NULL UNIQUE,
  role           TEXT        NOT NULL,
  name_patterns  TEXT[]      NOT NULL,
  action_hint    TEXT,
  confidence     NUMERIC(3,2) NOT NULL DEFAULT 0.95,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup by role (the first filter applied in the resolver)
CREATE INDEX IF NOT EXISTS idx_element_archetypes_role
  ON element_archetypes (role);
```

---

## 2. Archetype Seed Data

File: `db/seeds/element_archetypes.sql`

Pre-seeded archetypes. This file is idempotent (`ON CONFLICT DO NOTHING`).
The `name_patterns` array uses **normalised** strings: lowercase, trimmed,
internal whitespace collapsed. The resolver normalises the candidate name
before comparison.

```sql
INSERT INTO element_archetypes (name, role, name_patterns, action_hint, confidence)
VALUES

-- ── Authentication ──────────────────────────────────────────────────────────
('login_button',   'button',   ARRAY['login', 'log in', 'log into', 'sign in', 'sign into'],
  'click', 0.95),

('logout_button',  'button',   ARRAY['log out', 'logout', 'sign out', 'signout'],
  'click', 0.95),

('signup_button',  'button',   ARRAY['sign up', 'signup', 'create account', 'register',
                                     'get started', 'join', 'join now', 'create free account'],
  'click', 0.95),

-- ── Form fields ─────────────────────────────────────────────────────────────
('email_input',    'textbox',  ARRAY['email', 'email address', 'e-mail', 'e-mail address',
                                     'work email', 'username or email', 'email or username',
                                     'email / username'],
  'type', 0.95),

('password_input', 'textbox',  ARRAY['password', 'current password', 'enter password',
                                     'your password'],
  'type', 0.95),

('search_input',   'searchbox', ARRAY['search', 'search...', 'search for anything',
                                      'what are you looking for'],
  'type', 0.95),

('search_input_textbox', 'textbox', ARRAY['search', 'search...'],
  'type', 0.92),

-- ── Navigation ───────────────────────────────────────────────────────────────
('submit_button',  'button',   ARRAY['submit', 'continue', 'next', 'confirm', 'save',
                                     'save changes', 'apply', 'done', 'update', 'finish'],
  'click', 0.90)

ON CONFLICT (name) DO NOTHING;
```

> **Note on confidence tiers:**
> - 0.95 — high-specificity patterns (only one thing could be "Log in")
> - 0.92 — moderate-specificity (textbox labelled "search" is common but might be wrong)
> - 0.90 — low-specificity (submit/continue match many things — still better than LLM for known pattern)

---

## 3. Seed Script

File: `scripts/seed-archetypes.ts`

```typescript
// Reads db/seeds/element_archetypes.sql and executes it against the configured DB.
// Idempotent — safe to run multiple times.
// Usage: npm run archetypes:seed
```

Add to `package.json`:
```json
"archetypes:seed": "tsx scripts/seed-archetypes.ts"
```

---

## 4. Update `ResolutionSource` Type

File: `src/types/index.ts`

```typescript
// Before:
export type ResolutionSource =
  'redis' | 'db_exact' | 'pgvector_step' | 'pgvector_element' | 'llm';

// After:
export type ResolutionSource =
  'archetype' | 'redis' | 'db_exact' | 'pgvector_step' | 'pgvector_element' | 'llm';
```

---

## 5. IArchetypeResolver Interface (SDD — interface before implementation)

File: `src/modules/element-resolver/archetype.interfaces.ts`

```typescript
/**
 * Spec ref: Smart Brain Layer 0 — Element Archetype Library
 *
 * Resolves DOM candidates against the pre-seeded element_archetypes table.
 * Returns an ARIA-strategy selector when the candidate's role + normalised
 * accessible name matches a known archetype. Returns null on miss.
 *
 * Contract:
 *   - MUST NOT make LLM calls.
 *   - MUST NOT call pgvector or any embedding API.
 *   - MUST return null (not throw) on any DB error — the fallback chain continues.
 *   - The returned selector MUST use strategy: 'aria' and MUST be validated
 *     against the live DOM before being returned by the ArchetypeElementResolver.
 */
export interface IArchetypeResolver {
  /**
   * Attempt to match a DOM candidate against a known archetype.
   *
   * @param candidate  The top word-overlap candidate from the DOM pruner.
   * @param action     The step action ('click', 'type', etc.) — used to respect action_hint.
   * @returns          An ArchetypeMatch if recognised; null otherwise.
   */
  match(candidate: CandidateNode, action: string): Promise<ArchetypeMatch | null>;
}

import type { CandidateNode } from '../../types';

export type ArchetypeMatch = {
  /** Slug from element_archetypes.name, e.g. 'login_button'. */
  archetypeName: string;
  /** ARIA selector built from the candidate's real accessible name. Always portable. */
  selector: string;
  /** Confidence score from the archetype row. */
  confidence: number;
};
```

---

## 6. `DBArchetypeResolver` Implementation

File: `src/modules/element-resolver/db.archetype-resolver.ts`

### Constructor

```typescript
constructor(
  private readonly observability: IObservability,
)
```

### In-memory cache

Archetypes change rarely. Load them from DB once per process, refresh after
`ARCHETYPE_CACHE_TTL_MS` (5 minutes) in the background so hot paths are never blocked.

```typescript
private cache: ArchetypeRow[] | null = null;
private cacheExpiresAt = 0;

private async getArchetypes(): Promise<ArchetypeRow[]> {
  if (this.cache && Date.now() < this.cacheExpiresAt) return this.cache;
  // fetch from DB, update this.cache + this.cacheExpiresAt
  // on DB error: return stale cache if available, else []
}
```

### `match(candidate, action)` logic

```
1. archetypes = await getArchetypes()
2. Filter archetypes where archetype.role === candidate.role
3. normalised = normalise(candidate.name || candidate.textContent)
   normalise(s) = s.toLowerCase().trim().replace(/\s+/g, ' ')
4. For each role-matching archetype:
   a. If archetype.action_hint is not null AND action_hint !== action → skip
   b. If normalised is in archetype.name_patterns → match found
5. If match:
   a. Build ARIA selector: `role=${candidate.role}[name="${candidate.name}"]`
   b. Return { archetypeName: match.name, selector, confidence: match.confidence }
6. No match → return null
```

> **Name escape note:** If `candidate.name` contains double quotes, escape them in the
> ARIA selector: `candidate.name.replace(/"/g, '\\"')`.

---

## 7. `ArchetypeElementResolver` — Implements `IElementResolver`

File: `src/modules/element-resolver/archetype.element-resolver.ts`

This is a thin wrapper that:
1. Calls the DOM pruner to get candidates (same as LLMElementResolver)
2. Picks the top word-overlap candidate (`pickTopCandidate`)
3. Calls `IArchetypeResolver.match(topCandidate, step.action)`
4. On match: validates the ARIA selector against the live DOM (`page.$(selector)`)
5. On valid: returns a `SelectorSet` with `resolutionSource: 'archetype'`, `tokensUsed: 0`
6. On invalid DOM hit or null match: returns an empty `SelectorSet` (fall through to L1)

```typescript
export class ArchetypeElementResolver implements IElementResolver {
  constructor(
    private readonly domPruner: IDOMPruner,
    private readonly archetypeResolver: IArchetypeResolver,
    private readonly observability: IObservability,
  ) {}

  async resolve(step: StepAST, context: ResolutionContext): Promise<SelectorSet> { ... }

  // recordSuccess / recordFailure: no-ops — archetypes are static
  async recordSuccess(): Promise<void> {}
  async recordFailure(): Promise<void> {}
}
```

**Return shape on match:**
```typescript
{
  selectors: [{ selector, strategy: 'aria', confidence }],
  fromCache: false,
  cacheSource: null,
  resolutionSource: 'archetype',
  similarityScore: null,
  tokensUsed: 0,
}
```

---

## 8. Update `CompositeElementResolver`

File: `src/modules/element-resolver/composite.element-resolver.ts`

`CompositeElementResolver` currently takes exactly two resolvers: `cached` and `llm`.
Extend it to support an ordered chain of `N` resolvers (first non-empty result wins).

```typescript
export class CompositeElementResolver implements IElementResolver {
  constructor(
    private readonly resolvers: IElementResolver[],   // ordered: first wins
    private readonly observability: IObservability,
  ) {}

  async resolve(step: StepAST, context: ResolutionContext): Promise<SelectorSet> {
    for (const resolver of this.resolvers) {
      const result = await resolver.resolve(step, context);
      if (result.selectors.length > 0) return result;
    }
    return MISS;
  }

  async recordSuccess(...) { await Promise.all(this.resolvers.map(r => r.recordSuccess(...))); }
  async recordFailure(...) { await Promise.all(this.resolvers.map(r => r.recordFailure(...))); }
}
```

**Backwards-compatible call sites:** existing `new CompositeElementResolver(cached, llm, obs)`
becomes `new CompositeElementResolver([cached, llm], obs)`. Update both call sites in
`src/workers/worker.ts`.

---

## 9. Wire into Worker

File: `src/workers/worker.ts`

```typescript
// Before:
const resolver = new CompositeElementResolver(cachedResolver, llmResolver, obs);

// After:
const archetypeResolver = new DBArchetypeResolver(obs);
const archetypeElementResolver = new ArchetypeElementResolver(domPruner, archetypeResolver, obs);
const resolver = new CompositeElementResolver(
  [archetypeElementResolver, cachedResolver, llmResolver],
  obs,
);
```

---

## 10. Observability

Increment counters in `ArchetypeElementResolver` so the dashboard can track archetype hit rate:

```typescript
obs.increment('resolver.cache_hit', { source: 'archetype' });          // on hit + valid DOM
obs.increment('resolver.archetype_dom_miss', { archetype: match.archetypeName }); // matched but selector not in DOM
obs.increment('resolver.archetype_miss');                               // no archetype matched
```

---

## 11. Tests

### Unit: `src/modules/element-resolver/__tests__/db.archetype-resolver.test.ts`

| # | Test |
|---|---|
| 1 | Returns `ArchetypeMatch` when role + name matches an archetype with no action_hint |
| 2 | Returns `ArchetypeMatch` when role + name matches and action matches action_hint |
| 3 | Returns null when action does not match action_hint |
| 4 | Returns null when role matches but no name_pattern matches |
| 5 | Returns null when role does not match (early exit) |
| 6 | Name normalisation: "Log In" → "log in" matches pattern "log in" |
| 7 | Name normalisation: " Email Address " (extra spaces) matches "email address" |
| 8 | Returns null (does not throw) when DB raises an error |
| 9 | Uses in-memory cache on second call (DB queried only once) |
| 10 | Refreshes cache after TTL expires |

### Unit: `src/modules/element-resolver/__tests__/archetype.element-resolver.test.ts`

| # | Test |
|---|---|
| 1 | Returns SelectorSet with `resolutionSource: 'archetype'` when archetype matches + DOM valid |
| 2 | Returns empty SelectorSet when archetype matches but selector not in DOM |
| 3 | Returns empty SelectorSet when no archetype matches (fallthrough) |
| 4 | `tokensUsed` is always 0 |

---

## 12. Execution Order

Follow strictly — each step depends on the previous:

- [ ] **Step 1:** Write `db/migrations/015_element_archetypes.sql` → run `npm run db:migrate`
- [ ] **Step 2:** Write `db/seeds/element_archetypes.sql`
- [ ] **Step 3:** Write `scripts/seed-archetypes.ts` → add `archetypes:seed` to `package.json`
- [ ] **Step 4:** Run `npm run archetypes:seed` — verify rows in DB
- [ ] **Step 5:** Add `'archetype'` to `ResolutionSource` in `src/types/index.ts`
- [ ] **Step 6:** Write `src/modules/element-resolver/archetype.interfaces.ts`
- [ ] **Step 7:** Write `src/modules/element-resolver/db.archetype-resolver.ts`
- [ ] **Step 8:** Write `src/modules/element-resolver/archetype.element-resolver.ts`
- [ ] **Step 9:** Refactor `CompositeElementResolver` to accept resolver array
- [ ] **Step 10:** Update `src/workers/worker.ts` to wire `ArchetypeElementResolver` as first in chain
- [ ] **Step 11:** Write unit tests for `DBArchetypeResolver`
- [ ] **Step 12:** Write unit tests for `ArchetypeElementResolver`
- [ ] **Step 13:** Verify milestone: run a test with "click the login button" and confirm `resolutionSource: 'archetype'` in logs

---

## 13. Files to Create / Modify

| Action | File |
|---|---|
| CREATE | `db/migrations/015_element_archetypes.sql` |
| CREATE | `db/seeds/element_archetypes.sql` |
| CREATE | `scripts/seed-archetypes.ts` |
| MODIFY | `src/types/index.ts` — add `'archetype'` to `ResolutionSource` |
| CREATE | `src/modules/element-resolver/archetype.interfaces.ts` |
| CREATE | `src/modules/element-resolver/db.archetype-resolver.ts` |
| CREATE | `src/modules/element-resolver/archetype.element-resolver.ts` |
| MODIFY | `src/modules/element-resolver/composite.element-resolver.ts` — array-based chain |
| MODIFY | `src/workers/worker.ts` — wire archetype resolver, update Composite construction |
| CREATE | `src/modules/element-resolver/__tests__/db.archetype-resolver.test.ts` |
| CREATE | `src/modules/element-resolver/__tests__/archetype.element-resolver.test.ts` |
| MODIFY | `package.json` — add `archetypes:seed` script |

---

## 14. What Is NOT In This Spec

Deferred to future iterations:

- **Auto-promotion:** Identifying new archetypes from high-confidence `selector_cache` entries
  automatically. Requires a batch job that clusters entries by role+name and promotes stable
  ones to `element_archetypes`. Deferred — needs volume data to be meaningful.
- **Admin API for archetypes:** A `GET/POST/DELETE /admin/archetypes` endpoint for managing
  the table without running SQL directly. Deferred — internal tooling for now.
- **Archetype confidence decay:** If a returned archetype selector repeatedly fails DOM
  validation (archetype mismatch), lower its confidence score automatically. Deferred.
- **Fuzzy name matching:** Currently exact after normalisation. Levenshtein distance or
  embedding similarity for name matching (e.g. "Connexion" → login for French sites). Deferred.
- **Locale-aware archetypes:** Separate archetype rows per locale/language. Deferred.

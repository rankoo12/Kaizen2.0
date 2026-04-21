# Reliability — Tier 2: Cache Hit Rate & Archetype Coverage
**Branch:** `feat/reliability/tier2-cache-coverage`
**Spec ref:** Post-analysis of production flakiness patterns
**Depends on:** `spec-reliability-tier1.md` (feedback loop must be reliable first)

---

## Goal

Maximise the percentage of steps that resolve from cache (L0-L4) without an LLM call.
Today the system has two problems:

1. **Cosine threshold too tight (0.95):** Minor wording variations cause cache misses,
   forcing an LLM call for steps that are semantically identical to cached entries.
2. **Archetype library too small (~10 entries):** L0 only covers authentication and basic
   form fields. Common patterns like navigation, modals, tables, and e-commerce are missing.
3. **Pre-validation gap:** Selectors are validated at resolve time, then the DOM can change
   before execution. On SPAs this causes false failures.

Fixing these pushes reliability from ~75% (after Tier 1) toward ~90%.

**Expected impact:** Dramatically higher cache hit rates (fewer LLM calls, more
deterministic runs), better first-run coverage on unseen sites via archetypes.

---

## Milestone Definition

The milestone is met when:

1. Two semantically identical steps with different wording (e.g. "Click the login button"
   vs "Click login button") resolve from the same cache entry without an LLM call.
2. The archetype library contains 50+ entries covering authentication, navigation, forms,
   modals, e-commerce, media, tables, and social patterns.
3. Running a basic login flow on an unseen site resolves 100% of common steps from L0
   archetypes without any LLM call.
4. Pre-validation of cached selectors is removed; execution uses Playwright's native
   auto-wait, and failures flow to the existing healing engine.
5. All existing tests continue to pass. New tests verify threshold behaviour.

---

## What Already Exists (Do Not Rebuild)

| Existing | Location |
|---|---|
| `COSINE_THRESHOLD = 0.95` | `cached.element-resolver.ts:20` |
| `ELEMENT_EMBEDDING_THRESHOLD = 0.95` | `llm.element-resolver.ts:50` |
| `vectorSearch` method (L3/L4) | `cached.element-resolver.ts:141-172` |
| `elementEmbeddingLookup` (L2.5) | `llm.element-resolver.ts:250-281` |
| `element_archetypes` table + seed | `db/seeds/element_archetypes.sql` |
| `DBArchetypeResolver.match()` | `db.archetype-resolver.ts:142-171` |
| `validateSelectors` in LLMElementResolver | `llm.element-resolver.ts:301-322` |
| L2.5 pre-validation (`validFromCache`) | `llm.element-resolver.ts:124-129` |

---

## 1. Lower Cosine Similarity Thresholds

### 1a. Step embedding threshold: 0.95 -> 0.90

File: `src/modules/element-resolver/cached.element-resolver.ts`

```typescript
// Before:
const COSINE_THRESHOLD = 0.95;

// After:
const COSINE_THRESHOLD = 0.90;
```

**Rationale:** Step embeddings encode `"{action} {targetDescription}"`. At 0.95, minor
wording differences ("Click the login button" vs "Click login button" vs "Press the sign
in button") produce cosine similarities in the 0.90-0.94 range — all cache misses today.
At 0.90, these all hit the cache.

**Risk:** Lower threshold increases false-positive matches. Mitigated by:
- L2 exact hash still runs first (0 false positives)
- L3/L4 results are validated against the live DOM before use
- Confidence score filtering (`> 0.4`) already excludes degraded entries
- The healing engine catches any false positive that slips through

### 1b. Element embedding threshold: 0.95 -> 0.92

File: `src/modules/element-resolver/llm.element-resolver.ts`

```typescript
// Before:
const ELEMENT_EMBEDDING_THRESHOLD = 0.95;

// After:
const ELEMENT_EMBEDDING_THRESHOLD = 0.92;
```

**Rationale:** Element embeddings encode `"{role}: {name} @ {path}"`. The URL path component
already provides strong disambiguation. Lowering from 0.95 to 0.92 catches cases where the
accessible name has minor variations (e.g. "Email Address" vs "Email address" vs "email").

**Risk:** Lower than step threshold (0.90) because element embedding already has URL path
scoping. Keep at 0.92 (not 0.90) because same-role elements on the same page are harder
to distinguish.

### 1c. Make thresholds configurable via environment variables

Both thresholds should be overridable for experimentation without code changes:

```typescript
const COSINE_THRESHOLD = parseFloat(process.env.KAIZEN_STEP_COSINE_THRESHOLD ?? '0.90');
const ELEMENT_EMBEDDING_THRESHOLD = parseFloat(process.env.KAIZEN_ELEMENT_COSINE_THRESHOLD ?? '0.92');
```

Add to `.env.example`:
```
# Cosine similarity thresholds for vector cache lookups (lower = more cache hits, higher false-positive risk)
# KAIZEN_STEP_COSINE_THRESHOLD=0.90
# KAIZEN_ELEMENT_COSINE_THRESHOLD=0.92
```

---

## 2. Expand Archetype Library to 50+ Entries

File: `db/seeds/element_archetypes.sql`

### New archetype categories to add:

#### Navigation (8 entries)
| name | role | name_patterns | action_hint |
|---|---|---|---|
| `nav_home` | `link` | `home, homepage, main page, go home, home page` | `click` |
| `nav_about` | `link` | `about, about us, about me, who we are` | `click` |
| `nav_contact` | `link` | `contact, contact us, get in touch, reach us` | `click` |
| `nav_pricing` | `link` | `pricing, plans, plans & pricing, see pricing` | `click` |
| `nav_dashboard` | `link` | `dashboard, my dashboard, overview` | `click` |
| `nav_settings` | `link` | `settings, preferences, account settings, my settings` | `click` |
| `nav_profile` | `link` | `profile, my profile, account, my account, view profile` | `click` |
| `nav_help` | `link` | `help, support, help center, help & support, faq` | `click` |

#### Form fields (8 entries)
| name | role | name_patterns | action_hint |
|---|---|---|---|
| `first_name_input` | `textbox` | `first name, given name, first, your first name` | `type` |
| `last_name_input` | `textbox` | `last name, family name, surname, last, your last name` | `type` |
| `phone_input` | `textbox` | `phone, phone number, mobile, mobile number, telephone, cell phone` | `type` |
| `address_input` | `textbox` | `address, street address, address line 1, your address` | `type` |
| `city_input` | `textbox` | `city, town, your city` | `type` |
| `zip_input` | `textbox` | `zip, zip code, postal code, postcode, zip / postal code` | `type` |
| `username_input` | `textbox` | `username, user name, your username, choose a username` | `type` |
| `confirm_password_input` | `textbox` | `confirm password, re-enter password, repeat password, password confirmation, verify password` | `type` |

#### Modal/dialog (5 entries)
| name | role | name_patterns | action_hint |
|---|---|---|---|
| `close_button` | `button` | `close, close dialog, close modal, dismiss, x` | `click` |
| `cancel_button` | `button` | `cancel, nevermind, go back, discard` | `click` |
| `confirm_button` | `button` | `ok, okay, yes, confirm, got it, i understand, accept` | `click` |
| `delete_button` | `button` | `delete, remove, trash, discard, delete permanently` | `click` |
| `modal_close_icon` | `button` | `close, dismiss` | `click` |

#### E-commerce (6 entries)
| name | role | name_patterns | action_hint |
|---|---|---|---|
| `add_to_cart` | `button` | `add to cart, add to bag, add to basket, add item` | `click` |
| `buy_now` | `button` | `buy now, buy, purchase, checkout, proceed to checkout` | `click` |
| `quantity_input` | `spinbutton` | `quantity, qty, amount` | `type` |
| `quantity_textbox` | `textbox` | `quantity, qty, amount` | `type` |
| `coupon_input` | `textbox` | `coupon, coupon code, promo code, discount code, voucher` | `type` |
| `apply_coupon` | `button` | `apply, apply coupon, apply code, redeem` | `click` |

#### Media controls (4 entries)
| name | role | name_patterns | action_hint |
|---|---|---|---|
| `play_button` | `button` | `play, play video, play audio, resume` | `click` |
| `pause_button` | `button` | `pause, pause video, pause audio` | `click` |
| `mute_button` | `button` | `mute, unmute, toggle mute, sound` | `click` |
| `fullscreen_button` | `button` | `fullscreen, full screen, enter fullscreen, exit fullscreen` | `click` |

#### Table/list operations (5 entries)
| name | role | name_patterns | action_hint |
|---|---|---|---|
| `sort_button` | `button` | `sort, sort by, order by` | `click` |
| `filter_button` | `button` | `filter, filters, filter results, show filters` | `click` |
| `next_page` | `button` | `next, next page, >, >>` | `click` |
| `prev_page` | `button` | `previous, prev, previous page, <, <<, back` | `click` |
| `select_all_checkbox` | `checkbox` | `select all, check all, toggle all` | `click` |

#### Social/sharing (4 entries)
| name | role | name_patterns | action_hint |
|---|---|---|---|
| `like_button` | `button` | `like, heart, favorite, favourite` | `click` |
| `share_button` | `button` | `share, share this, share post` | `click` |
| `comment_input` | `textbox` | `comment, add a comment, write a comment, your comment, leave a comment` | `type` |
| `follow_button` | `button` | `follow, subscribe, follow user` | `click` |

#### Textarea variants (3 entries)
| name | role | name_patterns | action_hint |
|---|---|---|---|
| `message_textarea` | `textbox` | `message, your message, write a message, send a message` | `type` |
| `description_textarea` | `textbox` | `description, your description, add description, add a description` | `type` |
| `notes_textarea` | `textbox` | `notes, additional notes, add notes, comments` | `type` |

#### Cookie/consent (3 entries)
| name | role | name_patterns | action_hint |
|---|---|---|---|
| `accept_cookies` | `button` | `accept, accept all, accept cookies, accept all cookies, i agree, agree` | `click` |
| `reject_cookies` | `button` | `reject, reject all, decline, decline all, deny` | `click` |
| `cookie_settings` | `button` | `manage cookies, cookie settings, customize, manage preferences` | `click` |

**Total new: ~46 entries. Combined with existing ~10 = ~56 archetypes.**

### Migration for new archetypes

The seed file (`db/seeds/element_archetypes.sql`) should be extended with the new entries.
Use the existing pattern: `ON CONFLICT (name) DO UPDATE SET name_patterns = EXCLUDED.name_patterns`.

No migration file needed — seeds are re-runnable.

---

## 3. Remove Pre-Validation of Cached Selectors

### Problem

In `llm.element-resolver.ts:124-129`, cached selectors from L2.5 (element embedding) are
validated against the live DOM before being returned:

```typescript
const validFromCache = await this.validateSelectors(elementHit.selectors, page);
if (validFromCache.length > 0) { ... }
```

This creates a timing window: the selector exists at validation time but may not exist
50-200ms later when the execution engine tries to use it. On SPAs with frequent re-renders,
this causes false failures.

Additionally, validation is unnecessary at this point because:
1. The execution engine already handles missing elements via the healing engine
2. Playwright's `page.click()` has built-in auto-wait (up to `actionTimeout`)
3. A validation failure just causes a cache miss, forcing an LLM call that will see the
   same (or worse) DOM state

### Solution

Remove the validation call and return the cached selectors directly. The execution engine
and healing engine handle failures.

**Before:**
```typescript
if (elementHit) {
  const validFromCache = await this.validateSelectors(elementHit.selectors, page);
  if (validFromCache.length > 0) {
    this.observability.increment('resolver.cache_hit', { source: 'element_embedding' });
    return { selectors: validFromCache, ... };
  }
}
```

**After:**
```typescript
if (elementHit) {
  this.observability.increment('resolver.cache_hit', { source: 'element_embedding' });
  return {
    selectors: elementHit.selectors,
    fromCache: true,
    cacheSource: 'tenant',
    resolutionSource: 'pgvector_element',
    similarityScore: elementHit.similarity,
    candidates: toCompactCandidates(candidates),
  };
}
```

**Keep validation for LLM output (L5).** LLM-generated selectors can be hallucinated, so
validation at `llm.element-resolver.ts:135` remains essential. The distinction:
- Cached selectors: were validated when first stored, confirmed working → trust them
- LLM selectors: generated fresh, may be hallucinated → validate before use

---

## 4. Add Basic Retry for DB Reads in Resolver

File: `src/modules/element-resolver/cached.element-resolver.ts`

The `fetchByHash` and `vectorSearch` methods catch errors and return null (cache miss).
A transient DB error forces an unnecessary LLM call. Add a single retry:

```typescript
private async fetchByHash(
  targetHash: string,
  domain: string,
  tenantId: string,
): Promise<SelectorSet | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { rows } = await getPool().query<{ selectors: SelectorEntry[] }>(...);
      if (rows.length === 0) return null;
      return { ... };
    } catch (e: any) {
      if (attempt === 0 && isTransient(e)) {
        this.observability.increment('resolver.cache_read_retry');
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      this.observability.log('warn', 'cache_resolver.fetch_by_hash_failed', { error: e.message });
      return null;
    }
  }
  return null;
}
```

Import `isTransient` from `llm.element-resolver.ts` (or extract to a shared utility in
Tier 1's `redis-cache.utils.ts` → rename to `db.utils.ts`).

---

## 5. Tests

### Unit: `src/modules/element-resolver/__tests__/cosine-threshold.test.ts`

| # | Test |
|---|---|
| 1 | `vectorSearch` returns a hit when cosine similarity is 0.91 (above new 0.90 threshold) |
| 2 | `vectorSearch` returns null when cosine similarity is 0.89 (below threshold) |
| 3 | `COSINE_THRESHOLD` can be overridden via `KAIZEN_STEP_COSINE_THRESHOLD` env var |
| 4 | `ELEMENT_EMBEDDING_THRESHOLD` can be overridden via `KAIZEN_ELEMENT_COSINE_THRESHOLD` env var |

### Unit: `src/modules/element-resolver/__tests__/archetype-coverage.test.ts`

| # | Test |
|---|---|
| 1 | `DBArchetypeResolver.match()` matches "Add to cart" button with archetype `add_to_cart` |
| 2 | `DBArchetypeResolver.match()` matches "Accept all cookies" button with `accept_cookies` |
| 3 | `DBArchetypeResolver.match()` matches "First name" textbox with `first_name_input` |
| 4 | `DBArchetypeResolver.match()` does NOT match a custom button name with no archetype |
| 5 | `DBArchetypeResolver.match()` respects action_hint — does not match "Home" link for `type` action |

### Unit: `src/modules/element-resolver/__tests__/l25-no-prevalidation.test.ts`

| # | Test |
|---|---|
| 1 | L2.5 element embedding hit returns selectors directly without calling `page.$()` |
| 2 | L5 LLM result still validates selectors against DOM (calls `page.$()`) |

---

## 6. Execution Order

- [ ] **Step 1:** Lower `COSINE_THRESHOLD` to 0.90 and add env var override
- [ ] **Step 2:** Lower `ELEMENT_EMBEDDING_THRESHOLD` to 0.92 and add env var override
- [ ] **Step 3:** Update `.env.example` with new threshold variables
- [ ] **Step 4:** Remove pre-validation from L2.5 element embedding lookup
- [ ] **Step 5:** Add retry to `fetchByHash` and `vectorSearch`
- [ ] **Step 6:** Expand `db/seeds/element_archetypes.sql` with ~46 new entries
- [ ] **Step 7:** Run `npm run archetypes:seed` to verify seeding
- [ ] **Step 8:** Write threshold tests
- [ ] **Step 9:** Write archetype coverage tests
- [ ] **Step 10:** Write pre-validation removal tests
- [ ] **Step 11:** Run `npm run typecheck && npm run lint && npm run test`

---

## 7. Files to Create / Modify

| Action | File |
|---|---|
| MODIFY | `src/modules/element-resolver/cached.element-resolver.ts` — lower threshold, add retry |
| MODIFY | `src/modules/element-resolver/llm.element-resolver.ts` — lower threshold, remove L2.5 pre-validation |
| MODIFY | `db/seeds/element_archetypes.sql` — add ~46 new archetype entries |
| MODIFY | `.env.example` — add threshold env vars |
| CREATE | `src/modules/element-resolver/__tests__/cosine-threshold.test.ts` |
| CREATE | `src/modules/element-resolver/__tests__/archetype-coverage.test.ts` |
| CREATE | `src/modules/element-resolver/__tests__/l25-no-prevalidation.test.ts` |

---

## 8. What Is NOT In This Spec

Deferred to Tier 3:

- **Circuit breaker for LLM provider** — fast-fail on provider outages
- **Cross-worker archetype sync** — Postgres NOTIFY or Redis pub/sub
- **Failure classifier hardening** — structural DOM diffing fallback
- **Locale-aware archetypes** — French/Spanish/German pattern variants
- **Archetype auto-discovery** — batch job that promotes high-confidence cache entries to archetypes

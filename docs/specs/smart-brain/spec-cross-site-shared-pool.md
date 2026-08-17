# Spec — Cross-Site Shared Pool (portable selectors, stack fingerprints)

Created: 2026-08-17
Status: Design for review; implementation not started.
Owner: Smart Brain workstream
Depends on: `037_shared_brain_rls.sql` (shared rows readable under RLS — landed);
`kaizen-phase4-spec.md` §3 (the existing shared pool); the archetype layer
(`db.archetype-resolver.ts`), which stays the owner of *semantic* generalisation.

---

## 0. What exists, measured — read before designing

Kaizen has two mechanisms that generalise across customers, and they are not the
same thing:

| layer | generalises | scope today |
|---|---|---|
| **Archetypes** (`element_archetypes`, L0) | *vocabulary* — "a login button is called any of these 23 things" | global: no tenant, no domain, 147 rows, self-teaching |
| **Shared selector pool** (`selector_cache.is_shared`, L4) | *structure* — "this step resolved to this selector" | opt-in, quality-gated, **and locked to the domain it was learned on** |

The lock is one predicate — `AND domain = $2` in `vectorSearch()`
(`cached.element-resolver.ts:369`). So the shared pool only helps two customers
who test **the same website**. It never carries anything from Acme's app to
BigCorp's, which is what "shared brain" sounds like it does.

The pool's contents, on the dev database (243 rows, 117 shared, 31 domains, 414
individual selectors):

| strategy | count | positional (`nth-child`, `>`) | hashed class | semantic (`role=`, `data-testid`) |
|---|---|---|---|---|
| css | 230 | 31 | 0 | 2 |
| aria | 163 | 0 | 0 | 163 |
| data-testid | 21 | 0 | 0 | 21 |

Two facts fall out of that table and drive the whole design:

1. **44% of stored selectors are portable by construction.** `role=textbox[name="First name *"]`
   or `[data-qa="zipcode"]` mean the same thing on any page that has that
   control. Sharing them across sites is nearly free of false-match risk.
2. **Only 7% are positional.** The dangerous class — selectors that describe
   *where* something is rather than *what* it is — is small. It needs excluding,
   not the whole pool.

## 1. The problem to solve, precisely

Dropping the domain constraint is not the feature. The danger of cross-site
matching is not that a foreign selector *fails* — a miss falls through to the
next layer for the price of one query. The danger is that it **matches the
wrong element and the step passes**. `.btn-primary` exists on a million sites
and means something different on each. That is a false green: the one failure
this product exists to prevent, and the one thing the trust ledger cannot
survive.

Today the domain predicate is doing the job of "these two pages are probably
built the same way." Removing it requires replacing it with something that does
that job better — not with nothing.

## 2. Product decisions (proposed; locked on approval)

1. **Cross-site sharing is a per-selector property, not a per-row switch.**
   Whether a selector may travel is decided at *contribution* time by what the
   selector is, and recorded on the row. Matching honours that flag. A `role=`
   selector travels; an `nth-child` chain never does, no matter how confident.
2. **Domain is replaced by a stack fingerprint, not by nothing.** A row is
   matched cross-site only when the target page shares a fingerprint with the
   page it was learned on — Shopify to Shopify, Material UI to Material UI. Two
   arbitrary pages never trade selectors just because a step description
   sounds similar.
3. **The archetype layer keeps the semantic half.** It already generalises
   vocabulary globally. The shared pool generalises *structure*. Do not rebuild
   one inside the other; do not let the shared pool start learning phrasing.
4. **Consent is unchanged.** `global_brain_opt_in` still gates contribution.
   Cross-site reach widens what an opted-in row is *used for*, not who may
   contribute. Copy on the opt-in setting is amended to say so (§7).
5. **A shared row must be portable in the confidentiality sense too.** Selector
   text can carry internal names (`#refund-override-finance`,
   `[data-testid="acme-payroll-export"]`). The portability filter is also a
   scrubber: a selector that embeds a token which does not appear in the
   generic UI vocabulary is *stripped of that selector* before sharing, or the
   row is not shared. Wider reach means these strings get read far more often;
   the filter is what makes that acceptable.
6. **A bad shared selector must not propagate.** Cross-site, one wrong entry
   can mislead many customers, so shared rows get a global demotion path — the
   same shape `archetype_failures` already gives archetypes — instead of relying
   on the per-domain `fail_count_window` alone.

## 3. Portability classification (contribution time)

A pure function, unit-tested against the existing 414 selectors:

```
classify(selector, strategy) → 'portable' | 'site_local' | 'unsafe'
```

| class | rule | shares cross-site? |
|---|---|---|
| **portable** | `role=…[name=…]`; `[aria-label=…]`; `[data-testid|data-test|data-qa|data-cy=…]`; `input[name=…]`/`select[name=…]` where the name is a common form field (`email`, `password`, `first_name`, `zip`, `phone`…, from a fixed list) | yes |
| **site_local** | plain `#id`, `.class`, `tag.class` — meaningful, but tied to one codebase | same-domain only (today's behaviour) |
| **unsafe** | anything positional (`nth-child`, `nth-of-type`, `>`, `:eq`), any hashed/generated class (`css-1x7fj2k`, `sc-AbCdE`, `.[a-z]+_[0-9a-f]{5,}`), any selector over 120 chars | never shared at all — not even same-domain |

The `unsafe` bucket is new and applies to the *existing* same-domain sharing
too: positional selectors are exactly what breaks when a page re-renders, and
sharing them was already a bad idea. Backfill marks existing rows.

A row's `portability` is the *best* class among its selectors after stripping
`unsafe` ones; the stripped copy is what gets written to the shared row. The
tenant's own private row is untouched — the customer keeps everything they
learned, including the positional fallbacks that work on their own site.

### 3.1 The vocabulary scrub (decision 5)

For `portable` selectors that carry a name (`role=button[name="…"]`,
`[data-testid="…"]`), the name is tokenised and every token must be in one of:
the archetype `name_patterns` (147 archetypes' worth of generic UI vocabulary),
a fixed common-form-field list, or a short stopword list. A name with an
unrecognised token — `acme`, `payroll`, a person's name, an SKU — makes that
selector `site_local`, not `portable`. This is deliberately conservative: it
will keep some genuinely-generic selectors local, and that is the right
direction to err. It also means the archetype layer's vocabulary is the single
source of truth for "generic", which is one thing to maintain rather than two.

## 4. Stack fingerprint (decision 2)

A short, ordered set of tags describing what a page is built from, computed by
the DOM pruner from what it already parses:

- **generator**: `<meta name="generator">` (WordPress, Shopify, Wix, Webflow…),
  Next/Nuxt/Gatsby markers (`__NEXT_DATA__`, `__nuxt`), Rails/Django CSRF
  conventions.
- **component library**: characteristic class prefixes on ≥ 3 distinct elements
  — `Mui`, `ant-`, `chakra-`, `mantine-`, `bp4-`, `p-` (PrimeReact), `v-`
  (Vuetify), Bootstrap's `btn btn-`/`form-control` pair, Tailwind is *not* a
  fingerprint (utility classes are not structure).
- **platform**: known SaaS shells (Salesforce Lightning `slds-`, Zendesk
  `garden-`, HubSpot `hs-`).

Stored as `text[]` on the row (`stack_tags`) and computed for the live page at
resolution time. Cross-site match requires **at least one shared tag and the
selector marked `portable`**. No tag on either side ⇒ same-domain behaviour
only.

Fingerprints are cheap (already-parsed DOM, string checks) and imperfect on
purpose. A false fingerprint match still has to clear the cosine threshold, the
semantic guard and the frame guard that gate every L4 hit today; the
fingerprint narrows the candidate set, it does not authorise a match on its own.

## 5. Resolution changes (`cached.element-resolver.ts`)

L4 becomes two queries, in order, both behind the existing guards:

1. **Same-domain shared** — exactly today's query. Unchanged.
2. **Cross-site shared** — `is_shared AND portability = 'portable' AND
   stack_tags && $liveTags AND domain <> $domain`, same cosine threshold, same
   `semanticGuardPasses`, same `frameGuardPasses`. New `resolutionSource:
   'pgvector_shared_xsite'` so runs, the Brain screen and cost attribution can
   tell the two apart — a cross-site hit is a claim worth being able to audit.

Everything after L4 (L5 LLM) is unchanged. A cross-site miss costs one indexed
query.

## 6. Demotion (decision 6)

New table `shared_selector_failures (content_hash, domain_seen, stack_tags,
failed_at)` written when a `pgvector_shared_xsite` hit leads to a failed step
that the healer then resolves to a *different* selector. Three failures across
two distinct domains within 30 days ⇒ the row's `portability` is downgraded to
`site_local` (it keeps working where it was learned) and a metric fires. A user
verdict of "wrong element" on a cross-site hit downgrades immediately, mirroring
`archetype_failures.expires_at = NULL`.

## 7. Confidentiality and consent surface

- Opt-in copy (`PATCH /auth/brain-opt-in`, the settings screen) gains one
  sentence: *"Selectors that describe generic controls — a sign-in button, an
  email field — may also help other workspaces testing sites built on the same
  platform. Selectors specific to your app stay in your workspace."*
- Shared rows already carry `domain` and `attribution.contributors`. Neither is
  exposed anywhere today; this spec does not expose them, and any future "show
  the pool" screen must strip both (`spec` note recorded so it is not
  rediscovered).
- Behind-auth exclusion is unchanged: `behindAuth` runs never contribute
  (`worker.ts:866`), so nothing learned inside a customer's signed-in system
  ever reaches the pool, portable or not.

## 8. Migration

One additive migration (next free number):

```sql
ALTER TABLE selector_cache
  ADD COLUMN IF NOT EXISTS portability TEXT NOT NULL DEFAULT 'site_local'
    CHECK (portability IN ('portable','site_local','unsafe')),
  ADD COLUMN IF NOT EXISTS stack_tags TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS selector_cache_xsite_idx
  ON selector_cache USING gin (stack_tags) WHERE is_shared AND portability = 'portable';
CREATE TABLE IF NOT EXISTS shared_selector_failures (…);
```

Plus a backfill script that classifies the existing 414 selectors and marks
`unsafe` rows so they stop being shared same-domain too. Default `site_local`
means: until backfilled, nothing new happens — the feature is dark on deploy.

## 9. Testing

- **Classifier**: table-driven over the real dev-cache selectors (exported as a
  fixture), asserting every `role=`/`data-testid` lands `portable`, every
  `nth-child` lands `unsafe`, `#refund-override-finance`-style names land
  `site_local` via the vocabulary scrub.
- **Fingerprint**: fixtures for a Shopify page, a MUI page, a Bootstrap page,
  and a Tailwind page (which must yield no tag).
- **Resolver**: cross-site hit only when portable + tag overlap + guards pass;
  a positional selector on the same stack is never returned; a portable
  selector with no tag overlap is never returned; the new `resolutionSource` is
  set.
- **Demotion**: three failures across two domains downgrade; a user verdict
  downgrades immediately.
- **Live**: two dev suites on two different Shopify (or MUI) demo sites; second
  site's first run resolves the sign-in / add-to-cart / email steps from
  `pgvector_shared_xsite` with zero LLM calls; a Tailwind site gets no
  cross-site hits.

## 10. Phasing

1. **Classify + stop sharing `unsafe`** — the migration, the classifier, the
   backfill. Ships alone; it is a strict improvement to today's same-domain pool
   and carries no cross-site risk. This is the "step one" that pays for itself.
2. **Fingerprint + cross-site read path + demotion** — the actual feature.
3. **Opt-in copy + Brain-screen attribution** of `pgvector_shared_xsite` hits.

## 11. Out of scope

- Sharing anything learned behind authentication. Never.
- Letting the shared pool learn *vocabulary* — that is the archetype layer's
  job and it already does it.
- A customer-facing "browse the shared pool" screen (see §7 for why it needs
  its own design first).
- Cross-site sharing of `site_local` selectors under any threshold. If the
  classifier says it is tied to one codebase, no confidence score overrides
  that.

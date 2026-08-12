# Scenario Archetype Catalog v1 (curated)

Created: 2026-08-06
Status: v1 — 30 curated entries. Injected into `planScenarios` as a static
prompt block (generation-pipeline spec §2). The `scenario_archetypes` table +
binder + telemetry are deferred; this document is the source of truth until then.
Curation owner: founder + core team. Every entry must be expressible in the
`StepIntent` union and executable by the current engine.

> **Deferral expired (2026-08-12).** This header used to exclude `assert_count`
> "until the engine implements it" — **the engine has implemented it**
> (`types/index.ts` StepAction union, `worker.ts` routing,
> `playwright.execution-engine.ts`; the WRITE schema already whitelists the
> action). The only remaining gap is WRITE-side: the `StepIntent` union variant,
> canonical templates, and pre/post count capture (assessment step 8 —
> `docs/assessments/2026-08-12-testwriter-full-assessment.md`). Count-based
> entries (cart badge N→N+1, list length after create/delete) are the sharpest
> oracle family for CRUD/list flows — the audit found every generated oracle
> degenerating to visibility, which is exactly the shape that anchored on the
> wrong element. Author count-based entries alongside the planned SaaS/CRUD
> archetype family once the WRITE union lands; do NOT rebuild the engine half.

## 1. Entry format

```
### <family>.<name>[.<kind>]
kind: happy | negative | edge      priority: critical | high | normal
requires: page purposes / capabilities / elements that MUST exist in the
          suite's Site Knowledge for this archetype to be instantiable —
          {slot} placeholders bind to real page_elements/site_pages rows.
safety:   read-safe            — no state created; always allowed
          synthetic-safe       — creates throwaway per-run data; requires the
                                 suite's allow_synthetic_data consent flag
          stop-before-money    — navigates toward payment, never clicks it
skeleton: numbered steps in canonical NL with {slots} and {{seed}} tokens
oracle:   ordered ladder — first graph-satisfiable candidate binds; entries
          marked (discover) have no crawled row (post-submit states) and are
          hardened from the validation-run harvest (generation spec §5.1)
variants: sibling scenarios planned from the same entry
```

Planning rules for the LLM (rendered with the block): prefer instantiating
catalog entries whose `requires` are satisfied by the App Brief/Site Knowledge;
NEVER instantiate an entry whose required slots don't bind; reserve ~30% of the
budget for app-specific scenarios no entry covers; every negative ends in a
POSITIVE assertion of the rejection state (Tier-1).

## 2. The catalog

### auth.signup.happy
kind: happy   priority: critical   safety: synthetic-safe
requires: auth/signup page with form(email or username, password) + submit
skeleton:
  1. navigate to {signup_page}
  2. type {{email}} in the {email_field}
  3. type {{password}} in the {password_field}
  4. (per required field) type {{seed}} in the {field}
  5. click the {signup_submit}
oracle: (discover) verify the success confirmation text is visible → verify
  the url no longer contains {signup_path}
variants: minimal-required-fields only; with newsletter checkbox checked

### auth.signup.negative.existing-email
kind: negative   priority: high   safety: synthetic-safe
requires: auth.signup.happy instantiable (runs it as setup steps 1–5, then repeats with the SAME {{email}})
skeleton: steps 1–5 of signup, then navigate to {signup_page} and repeat 2–5 with the same {{email}}
oracle: (discover) verify the already-registered error message is visible →
  verify the url still contains {signup_path}
variants: —

### auth.signup.negative.invalid-email
kind: negative   priority: high   safety: read-safe (submit is blocked by validation; no record created)
requires: signup form with an email-type field
skeleton:
  1. navigate to {signup_page}
  2. type "not-an-email" in the {email_field}
  3. type {{password}} in the {password_field}
  4. click the {signup_submit}
oracle: (discover) verify the email validation error is visible → verify the
  url still contains {signup_path}
variants: empty email; password-only submitted

### auth.login.happy
kind: happy   priority: critical   safety: synthetic-safe (needs an account it created) — P3 with login recipe otherwise
requires: auth page with form(identifier, password); account from auth.signup.happy in the same scenario OR a login recipe (P3)
skeleton: signup steps (setup), then:
  6. navigate to {login_page}
  7. type {{email}} in the {login_email_field}
  8. type {{password}} in the {login_password_field}
  9. click the {login_submit}
oracle: (discover) verify the logged-in indicator is visible → verify the url
  no longer contains {login_path}
variants: —

### auth.login.negative.wrong-password
kind: negative   priority: critical   safety: read-safe (failed logins create nothing)
requires: auth page with form(identifier, password) + submit
skeleton:
  1. navigate to {login_page}
  2. type {{email}} in the {login_email_field}
  3. type "wrong-{{password}}" in the {login_password_field}
  4. click the {login_submit}
oracle: (discover) verify the invalid-credentials error message is visible →
  verify the url still contains {login_path}
variants: unknown account; empty password; empty both

### auth.password-reset.request
kind: happy   priority: normal   safety: read-safe (requesting a reset for a random email mutates nothing meaningful)
requires: forgot-password page/link with an email field + submit
skeleton:
  1. navigate to {forgot_password_page}
  2. type {{email}} in the {email_field}
  3. click the {reset_submit}
oracle: (discover) verify the check-your-email confirmation is visible
variants: invalid email format → validation error visible

### permissions.protected-page-requires-login
kind: negative   priority: critical   safety: read-safe
requires: any site_pages row with requires_auth=true (recon captures these
  WITHOUT auth scope — this archetype grounds purely from public crawl data)
skeleton:
  1. navigate to {protected_page}
oracle: verify the url contains {login_path} → (discover) verify the login
  form is visible
variants: one scenario per distinct requires_auth section (cap 3)
note: the exemplar class — chronically under-written by humans, free to ground.

### search.find-known-entity
kind: happy   priority: high   safety: read-safe
requires: capability "user can search" + a {known_entity} name harvested from
  crawled listing/link text (grounded — the entity provably exists)
skeleton:
  1. navigate to {search_page_or_home}
  2. type "{known_entity}" in the {search_field}
  3. press enter
oracle: verify the text "{known_entity}" is shown → verify the url contains {search_path}
variants: search from a subpage; click first result → verify detail page title contains "{known_entity}"

### search.negative.no-results
kind: negative   priority: high   safety: read-safe
requires: capability "user can search"
skeleton:
  1. navigate to {search_page_or_home}
  2. type "zzqx-kaizen-no-such-item-{{username}}" in the {search_field}
  3. press enter
oracle: (discover) verify the no-results message is visible
variants: whitespace-only query

### search.edge.special-characters
kind: edge   priority: normal   safety: read-safe
skeleton: as no-results with query `"><script>alert(1)</script>`
oracle: (discover) verify the no-results or results header is visible (page
  renders normally — no error page); verify the url contains {search_path}
note: a rendering/XSS smoke via the UI only — Kaizen asserts the page survived.

### forms.contact.negative.required-fields
kind: negative   priority: high   safety: read-safe
requires: a form page (contact/feedback/quote) with required fields + submit
skeleton:
  1. navigate to {form_page}
  2. click the {form_submit}          (submit EMPTY)
oracle: (discover) verify the required-field validation message is visible →
  verify the url still contains {form_path}
variants: fill all but one required field

### forms.contact.negative.invalid-format
kind: negative   priority: normal   safety: read-safe
requires: form with a typed-format field (email/phone)
skeleton: fill required fields with valid {{seed}} tokens, type "abc" in the
  {email_or_phone_field}, click the {form_submit}
oracle: (discover) verify the format validation error is visible

### forms.contact.happy
kind: happy   priority: normal   safety: synthetic-safe (creates a real inquiry record)
skeleton: fill every required field with {{seed}} tokens, click the {form_submit}
oracle: (discover) verify the submission confirmation is visible

### commerce.cart.add-random-item
kind: happy   priority: critical   safety: synthetic-safe (session cart state)
requires: capability "user can add to cart" on a listing page
skeleton:
  1. navigate to {listing_page}
  2. add a random product to the cart        (click_random, captures {{selectedItem}})
  3. navigate to {cart_page}
oracle: verify the item name matches the one selected ({{selectedItem}} closes
  the loop) → (discover) verify the cart count indicator shows an item
variants: add from product detail page instead of listing

### commerce.cart.remove-item
kind: happy   priority: high   safety: synthetic-safe (removes only what it added)
requires: commerce.cart.add-random-item instantiable (setup)
skeleton: add-random steps, then:
  4. click the {remove_from_cart}
oracle: (discover) verify the empty-cart message is visible → verify the text
  "{{selectedItem}}" is not shown
variants: —

### commerce.product.detail-from-listing
kind: happy   priority: high   safety: read-safe
requires: listing page with product links
skeleton:
  1. navigate to {listing_page}
  2. click a random product link             (captures {{selectedItem}})
oracle: verify the page title contains "{{selectedItem}}" → verify the text
  "{{selectedItem}}" is shown
variants: via category page

### commerce.listing.filter-or-sort
kind: happy   priority: normal   safety: read-safe
requires: listing page with a filter/sort control (combobox or link group)
skeleton:
  1. navigate to {listing_page}
  2. select "{sort_option}" from the {sort_control}
oracle: verify the url contains {sort_param_or_path} → (discover) verify the
  listing header is still visible (page re-rendered, didn't error)

### commerce.checkout.reach-payment (stop-before-money)
kind: happy   priority: critical   safety: stop-before-money + synthetic-safe (cart setup)
requires: add-to-cart instantiable + checkout entry from cart
skeleton: add-random steps, then:
  4. navigate to {cart_page}
  5. click the {checkout_button}
  6. (per pre-payment form step) fill required fields with {{seed}} tokens and continue
oracle: verify the url contains {payment_or_checkout_path} → (discover) verify
  the payment/order-summary heading is visible
GUARD: the skeleton NEVER clicks the final pay/place-order control — encoded
  here and enforced by the stop-before-money lint (generation spec §4.2).

### commerce.checkout.negative.empty-cart
kind: negative   priority: high   safety: read-safe
requires: cart page reachable with an empty session
skeleton:
  1. navigate to {cart_page}
oracle: (discover) verify the empty-cart message is visible
variants: navigate directly to {checkout_path} with empty cart → verify
  redirected back (url contains {cart_path}) OR blocked message visible

### nav.critical-journey-links
kind: happy   priority: high   safety: read-safe
requires: a graph-verified journey from the App Brief
skeleton: for the journey's page path:
  1. navigate to {journey_start}
  2..n. click the {nav_link_to_next_page} per hop
oracle: after each hop — verify the url contains {next_page_path}; final:
  verify the page title contains "{final_page_title_word}"
variants: one scenario per critical journey (cap 3)

### nav.negative.not-found
kind: negative   priority: normal   safety: read-safe
skeleton:
  1. navigate to {origin}/kaizen-definitely-not-a-page-{{username}}
oracle: (discover) verify the not-found message is visible OR verify the url
  contains the site's 404 path
note: distinguishes a designed 404 from a blank/error crash.

### nav.footer-legal-pages
kind: happy   priority: normal   safety: read-safe
requires: footer links to terms/privacy (crawled)
skeleton:
  1. navigate to {home}
  2. click the {privacy_or_terms_link}
oracle: verify the url contains {legal_path} → verify the page title contains
  "{Privacy|Terms}"

### nav.header-reveals-menu
kind: happy   priority: normal   safety: read-safe
requires: a safe-reveal menu opener with revealed links (recon's
  revealed_states — grounded from probe data)
skeleton:
  1. navigate to {page}
  2. click the {menu_opener}
oracle: verify the "{revealed_link_name}" link is visible
variants: revealed link navigates — click it → verify url contains {target_path}

### content.pagination.next
kind: happy   priority: normal   safety: read-safe
requires: listing with a next/pagination control + page-2 url pattern crawled
skeleton:
  1. navigate to {listing_page}
  2. click the {next_page_control}
oracle: verify the url contains {page_2_marker} → (discover) verify the
  listing header is still visible

### content.language-or-currency-switch
kind: happy   priority: normal   safety: read-safe
requires: a language/currency selector (combobox/menu) crawled or revealed
skeleton:
  1. navigate to {home}
  2. select "{option}" from the {switcher}
oracle: verify the url contains {locale_marker} OR (discover) verify text in
  the switched language/currency symbol is shown

### newsletter.subscribe.happy
kind: happy   priority: normal   safety: synthetic-safe (creates a subscription for a throwaway {{email}})
requires: newsletter form (email + submit), commonly in the footer
skeleton:
  1. navigate to {page_with_newsletter}
  2. type {{email}} in the {newsletter_email_field}
  3. click the {newsletter_submit}
oracle: (discover) verify the subscription confirmation is visible

### newsletter.subscribe.negative.invalid-email
kind: negative   priority: normal   safety: read-safe
skeleton: as happy with "not-an-email"
oracle: (discover) verify the email validation error is visible

### dialog.open-and-close
kind: happy   priority: normal   safety: read-safe
requires: a modal opener classified safe-reveal with revealed content (probe data)
skeleton:
  1. navigate to {page}
  2. click the {modal_opener}
  3. press escape
oracle: after 2 — verify the "{revealed_element_name}" is visible; after 3 —
  verify the "{revealed_element_name}" is not visible

### account.negative.direct-admin-url
kind: negative   priority: high   safety: read-safe
requires: an admin-looking path observed in links OR requires_auth admin page
skeleton:
  1. navigate to {admin_path}
oracle: verify the url contains {login_path} OR (discover) verify the
  access-denied message is visible
note: never attempts to bypass — asserts the gate EXISTS.

### form.persistence.edge.reload-clears
kind: edge   priority: normal   safety: read-safe
requires: any multi-field public form
skeleton:
  1. navigate to {form_page}
  2. type {{firstName}} in the {first_field}
  3. reload the page
oracle: (discover) verify the {first_field} is empty (assert_attribute value=)
  OR verify the text "{{firstName}}" is not shown
note: catches accidental-persistence bugs; skip when the app intentionally drafts.

### search.result-navigates
kind: happy   priority: high   safety: read-safe
requires: search.find-known-entity instantiable
skeleton: search steps, then:
  4. click the "{known_entity}" link
oracle: verify the page title contains "{known_entity}"

### home.smoke
kind: happy   priority: critical   safety: read-safe
requires: always instantiable (home page + its crawled h1 + one primary nav element)
skeleton:
  1. navigate to {home}
oracle: verify the text "{crawled_h1_text}" is shown → verify the
  {primary_nav_element} is visible
note: the cheapest canary — a designed smoke, not page-poking: it asserts the
  two elements the App Brief calls load-bearing, chosen at instantiation time.

## 3. Prompt-block rendering

Rendered once into the `planScenarios` static prefix as compact YAML-ish text
(~3–4k tokens): entry key, kind, priority, one-line requires, one-line intent,
safety class. Skeletons/oracles are NOT included at PLAN time (the planner
selects; WRITE receives the full entry for selected keys only). Ordering fixed
alphabetically for provider prompt-cache stability. `source.archetypeKey` is
recorded per planned scenario for provenance.

## 4. Growth path

Curated-only in v1. First extension: human-gated promotion — approved,
high-scoring generated scenarios abstracted into new entries (structure only,
never tenant data). Telemetry counters and ranking arrive with the
`scenario_archetypes` table when fleet volume exists. The G2 gap signal
(app-type × flow-type combos where LLM gap-fill out-produces the catalog)
names the next entry to write.

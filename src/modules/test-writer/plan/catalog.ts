/**
 * Scenario archetype catalog — curated QA patterns, v1.
 * Source of truth: docs/specs/test-writer/catalog-v1.md
 *
 * This is the scenario-level analogue of `element_archetypes`: battle-tested
 * QA knowledge that does NOT depend on any single app, carrying no tenant data
 * (no urls, no selectors, no DOM). PLAN selects entries whose requirements the
 * observed Site Knowledge satisfies; WRITE receives the selected entry's
 * skeleton and binds its {slots} to real crawled elements.
 *
 * The `scenario_archetypes` table, slot binder and outcome telemetry are
 * deliberately deferred (spec §4) — a prompt block delivers the quality floor
 * at a fraction of the machinery, and there is no fleet to learn from yet.
 */

export type ArchetypeSafety = 'read-safe' | 'synthetic-safe' | 'stop-before-money';

export type ScenarioArchetype = {
  key: string;
  kind: 'happy' | 'negative' | 'edge';
  priority: 'critical' | 'high' | 'normal';
  safety: ArchetypeSafety;
  /** One line for the PLAN prompt block. */
  intent: string;
  /** What must exist in Site Knowledge for this to be instantiable. */
  requires: string;
  /** Step skeleton + oracle ladder, handed to WRITE for selected entries. */
  skeleton: string;
};

export const SCENARIO_ARCHETYPES: ScenarioArchetype[] = [
  {
    key: 'auth.signup.happy',
    kind: 'happy', priority: 'critical', safety: 'synthetic-safe',
    intent: 'A new user registers an account successfully.',
    requires: 'signup/auth page with a form containing email or username + password + submit',
    skeleton: [
      '1. navigate to {signup_page}',
      '2. type {{email}} in the {email_field}',
      '3. type {{password}} in the {password_field}',
      '4. per remaining required field: type the matching {{seed}} token',
      '5. click the {signup_submit}',
      'oracle: (discover) the success/confirmation message is visible; fallback: url no longer contains the signup path',
    ].join('\n'),
  },
  {
    key: 'auth.signup.negative.invalid-email',
    kind: 'negative', priority: 'high', safety: 'read-safe',
    intent: 'Signup rejects a malformed email address.',
    requires: 'signup form with an email field',
    skeleton: [
      '1. navigate to {signup_page}',
      '2. type "not-an-email" in the {email_field}',
      '3. type {{password}} in the {password_field}',
      '4. click the {signup_submit}',
      'oracle: (discover) the email validation error is visible; fallback: url still contains the signup path',
    ].join('\n'),
  },
  {
    key: 'auth.login.negative.wrong-password',
    kind: 'negative', priority: 'critical', safety: 'read-safe',
    intent: 'Login rejects a valid identifier with the wrong password.',
    requires: 'login page with identifier + password fields and a submit control',
    skeleton: [
      '1. navigate to {login_page}',
      '2. type {{email}} in the {login_identifier_field}',
      '3. type "wrong-{{password}}" in the {login_password_field}',
      '4. click the {login_submit}',
      'oracle: (discover) the invalid-credentials error is visible; fallback: url still contains the login path',
    ].join('\n'),
  },
  {
    key: 'auth.login.negative.empty-password',
    kind: 'negative', priority: 'high', safety: 'read-safe',
    intent: 'Login blocks submission when the password is empty.',
    requires: 'login page with identifier + password fields',
    skeleton: [
      '1. navigate to {login_page}',
      '2. type {{email}} in the {login_identifier_field}',
      '3. click the {login_submit}',
      'oracle: (discover) the required-field or invalid-credentials message is visible; fallback: url still contains the login path',
    ].join('\n'),
  },
  {
    key: 'auth.password-reset.request',
    kind: 'happy', priority: 'normal', safety: 'read-safe',
    intent: 'A user requests a password-reset email.',
    requires: 'forgot-password page with an email field and submit',
    skeleton: [
      '1. navigate to {forgot_password_page}',
      '2. type {{email}} in the {email_field}',
      '3. click the {reset_submit}',
      'oracle: (discover) the check-your-email confirmation is visible',
    ].join('\n'),
  },
  {
    key: 'permissions.protected-page-requires-login',
    kind: 'negative', priority: 'critical', safety: 'read-safe',
    intent: 'An authenticated-only page redirects an anonymous visitor to login.',
    requires: 'a page recorded as requires_auth during recon (grounds from public crawl data alone)',
    skeleton: [
      '1. navigate to {protected_page}',
      'oracle: url contains the login path; fallback: (discover) the login form or access-denied message is visible',
    ].join('\n'),
  },
  {
    key: 'permissions.negative.direct-admin-url',
    kind: 'negative', priority: 'high', safety: 'read-safe',
    intent: 'An admin-only path is gated for anonymous visitors.',
    requires: 'an admin-looking path observed in links or marked requires_auth',
    skeleton: [
      '1. navigate to {admin_path}',
      'oracle: url contains the login path; fallback: (discover) the access-denied message is visible',
      'NOTE: asserts the gate EXISTS — never attempts to bypass it.',
    ].join('\n'),
  },
  {
    key: 'search.find-known-entity',
    kind: 'happy', priority: 'high', safety: 'read-safe',
    intent: 'Searching for an item that provably exists returns it.',
    requires: 'a search capability plus an entity name harvested from crawled listing/link text',
    skeleton: [
      '1. navigate to {search_page_or_home}',
      '2. type "{known_entity}" in the {search_field}',
      '3. press enter (or click the {search_submit})',
      'oracle: the text "{known_entity}" is shown; secondary: url contains the search path',
    ].join('\n'),
  },
  {
    key: 'search.negative.no-results',
    kind: 'negative', priority: 'high', safety: 'read-safe',
    intent: 'A nonsense query produces an explicit no-results state.',
    requires: 'a search capability',
    skeleton: [
      '1. navigate to {search_page_or_home}',
      '2. type "zzqx-kaizen-no-such-item" in the {search_field}',
      '3. press enter',
      'oracle: (discover) the no-results message is visible',
    ].join('\n'),
  },
  {
    key: 'search.result-navigates',
    kind: 'happy', priority: 'high', safety: 'read-safe',
    intent: 'Clicking a search result opens that item.',
    requires: 'search capability + a known entity name',
    skeleton: [
      '1..3. as search.find-known-entity',
      '4. click the "{known_entity}" result link',
      'oracle: the page title contains "{known_entity}"',
    ].join('\n'),
  },
  {
    key: 'search.edge.special-characters',
    kind: 'edge', priority: 'normal', safety: 'read-safe',
    intent: 'A query with markup characters renders normally instead of erroring.',
    requires: 'a search capability',
    skeleton: [
      '1. navigate to {search_page_or_home}',
      '2. type "\\"><script>alert(1)</script>" in the {search_field}',
      '3. press enter',
      'oracle: (discover) the results or no-results header is visible AND url contains the search path',
    ].join('\n'),
  },
  {
    key: 'forms.negative.required-fields',
    kind: 'negative', priority: 'high', safety: 'read-safe',
    intent: 'Submitting an empty form surfaces required-field validation.',
    requires: 'a public form page (contact/feedback/quote) with required fields',
    skeleton: [
      '1. navigate to {form_page}',
      '2. click the {form_submit}   (submit with every field empty)',
      'oracle: (discover) the required-field validation message is visible; fallback: url still contains the form path',
    ].join('\n'),
  },
  {
    key: 'forms.negative.invalid-format',
    kind: 'negative', priority: 'normal', safety: 'read-safe',
    intent: 'A typed field rejects a malformed value.',
    requires: 'a form with an email or phone field',
    skeleton: [
      '1. navigate to {form_page}',
      '2. fill the other required fields with {{seed}} tokens',
      '3. type "abc" in the {email_or_phone_field}',
      '4. click the {form_submit}',
      'oracle: (discover) the format validation error is visible',
    ].join('\n'),
  },
  {
    key: 'forms.contact.happy',
    kind: 'happy', priority: 'normal', safety: 'synthetic-safe',
    intent: 'A visitor submits the contact form successfully.',
    requires: 'a public contact/enquiry form with a submit control',
    skeleton: [
      '1. navigate to {form_page}',
      '2. fill every required field with the matching {{seed}} token',
      '3. click the {form_submit}',
      'oracle: (discover) the submission confirmation is visible',
    ].join('\n'),
  },
  {
    key: 'forms.edge.reload-clears',
    kind: 'edge', priority: 'normal', safety: 'read-safe',
    intent: 'Reloading a form does not silently retain typed input.',
    requires: 'any multi-field public form',
    skeleton: [
      '1. navigate to {form_page}',
      '2. type {{firstName}} in the {first_text_field}',
      '3. reload',
      'oracle: the text "{{firstName}}" is not shown (or the field value attribute is empty)',
      'NOTE: skip when the app intentionally drafts/persists form state.',
    ].join('\n'),
  },
  {
    key: 'commerce.cart.add-random-item',
    kind: 'happy', priority: 'critical', safety: 'synthetic-safe',
    intent: 'Adding a product to the cart puts that exact product in the cart.',
    requires: 'a listing page with add-to-cart controls, plus a cart page',
    skeleton: [
      '1. navigate to {listing_page}',
      '2. click_random on "an add to cart button", captureAs selectedItem',
      '3. navigate to {cart_page}',
      'oracle: the text "{{selectedItem}}" is shown (the capture closes the loop)',
    ].join('\n'),
  },
  {
    key: 'commerce.cart.remove-item',
    kind: 'happy', priority: 'high', safety: 'synthetic-safe',
    intent: 'Removing the item just added empties the cart.',
    requires: 'add-to-cart instantiable + a remove control on the cart page',
    skeleton: [
      '1..3. as commerce.cart.add-random-item',
      '4. click the {remove_from_cart_control}',
      'oracle: the text "{{selectedItem}}" is not shown; secondary: (discover) the empty-cart message is visible',
    ].join('\n'),
  },
  {
    key: 'commerce.product.detail-from-listing',
    kind: 'happy', priority: 'high', safety: 'read-safe',
    intent: 'Opening a product from the listing shows that product.',
    requires: 'a listing page whose items link to detail pages',
    skeleton: [
      '1. navigate to {listing_page}',
      '2. click_random on "a product link", captureAs selectedItem',
      'oracle: the text "{{selectedItem}}" is shown on the detail page',
    ].join('\n'),
  },
  {
    key: 'commerce.listing.filter-or-sort',
    kind: 'happy', priority: 'normal', safety: 'read-safe',
    intent: 'Sorting or filtering a listing re-renders it without error.',
    requires: 'a listing page with a sort/filter combobox or link group',
    skeleton: [
      '1. navigate to {listing_page}',
      '2. select "{sort_option}" from the {sort_control}',
      'oracle: url contains the sort marker; fallback: (discover) the listing header is still visible',
    ].join('\n'),
  },
  {
    key: 'commerce.checkout.reach-payment',
    kind: 'happy', priority: 'critical', safety: 'stop-before-money',
    intent: 'A shopper can carry a cart all the way to the payment step.',
    requires: 'add-to-cart instantiable + a checkout entry point from the cart',
    skeleton: [
      '1..3. as commerce.cart.add-random-item',
      '4. click the {checkout_button}',
      '5. fill each pre-payment required field with {{seed}} tokens and continue',
      'oracle: url contains the payment/checkout path; fallback: (discover) the payment or order-summary heading is visible',
      'HARD GUARD: never click the final pay / place-order control.',
    ].join('\n'),
  },
  {
    key: 'commerce.checkout.negative.empty-cart',
    kind: 'negative', priority: 'high', safety: 'read-safe',
    intent: 'Checkout is unavailable with an empty cart.',
    requires: 'a cart page reachable without prior state',
    skeleton: [
      '1. navigate to {cart_page}',
      'oracle: (discover) the empty-cart message is visible',
      'variant: navigate straight to {checkout_path} → url returns to the cart path or a blocked message is visible',
    ].join('\n'),
  },
  {
    key: 'nav.critical-journey-links',
    kind: 'happy', priority: 'high', safety: 'read-safe',
    intent: 'A critical journey is walkable through the UI, hop by hop.',
    requires: 'a graph-verified journey in the App Brief',
    skeleton: [
      '1. navigate to {journey_start}',
      '2..n. click the {link_to_next_page} for each hop',
      'oracle: after each hop, url contains the next page path; final: the page title contains a distinctive word of the destination',
    ].join('\n'),
  },
  {
    key: 'nav.negative.not-found',
    kind: 'negative', priority: 'normal', safety: 'read-safe',
    intent: 'An unknown path shows a designed 404 rather than a crash.',
    requires: 'nothing beyond the site origin',
    skeleton: [
      '1. navigate to {origin}/kaizen-definitely-not-a-page',
      'oracle: (discover) the not-found message is visible; fallback: url contains the 404 path',
    ].join('\n'),
  },
  {
    key: 'nav.footer-legal-pages',
    kind: 'happy', priority: 'normal', safety: 'read-safe',
    intent: 'Legal/footer links open the right document.',
    requires: 'crawled footer links to terms or privacy',
    skeleton: [
      '1. navigate to {home}',
      '2. click the {privacy_or_terms_link}',
      'oracle: url contains the legal path AND the page title contains "Privacy" or "Terms"',
    ].join('\n'),
  },
  {
    key: 'nav.header-reveals-menu',
    kind: 'happy', priority: 'normal', safety: 'read-safe',
    intent: 'A navigation menu opens and exposes its links.',
    requires: 'a safe-reveal menu opener with elements recorded via revealed_by',
    skeleton: [
      '1. navigate to {page}',
      '2. click the {menu_opener}',
      'oracle: the {revealed_link} is visible',
    ].join('\n'),
  },
  {
    key: 'dialog.open-and-close',
    kind: 'happy', priority: 'normal', safety: 'read-safe',
    intent: 'A modal opens on demand and closes cleanly.',
    requires: 'a modal opener with elements recorded via revealed_by',
    skeleton: [
      '1. navigate to {page}',
      '2. click the {modal_opener}',
      '3. press Escape',
      'oracle: after step 2 the {revealed_element} is visible; after step 3 it is not visible',
    ].join('\n'),
  },
  {
    key: 'content.pagination.next',
    kind: 'happy', priority: 'normal', safety: 'read-safe',
    intent: 'Paging a listing advances to the next page of results.',
    requires: 'a listing with a next/pagination control',
    skeleton: [
      '1. navigate to {listing_page}',
      '2. click the {next_page_control}',
      'oracle: url contains the page-2 marker; fallback: (discover) the listing header is still visible',
    ].join('\n'),
  },
  {
    key: 'content.language-or-currency-switch',
    kind: 'happy', priority: 'normal', safety: 'read-safe',
    intent: 'Switching locale or currency changes the page accordingly.',
    requires: 'a language/currency selector (combobox or revealed menu)',
    skeleton: [
      '1. navigate to {home}',
      '2. select "{option}" from the {switcher}',
      'oracle: url contains the locale marker; fallback: (discover) switched text or the currency symbol is shown',
    ].join('\n'),
  },
  {
    key: 'newsletter.subscribe.happy',
    kind: 'happy', priority: 'normal', safety: 'synthetic-safe',
    intent: 'A visitor subscribes to the newsletter.',
    requires: 'a newsletter form (email + submit), commonly in the footer',
    skeleton: [
      '1. navigate to {page_with_newsletter}',
      '2. type {{email}} in the {newsletter_email_field}',
      '3. click the {newsletter_submit}',
      'oracle: (discover) the subscription confirmation is visible',
    ].join('\n'),
  },
  {
    key: 'newsletter.subscribe.negative.invalid-email',
    kind: 'negative', priority: 'normal', safety: 'read-safe',
    intent: 'Newsletter signup rejects a malformed address.',
    requires: 'a newsletter form with an email field',
    skeleton: [
      '1. navigate to {page_with_newsletter}',
      '2. type "not-an-email" in the {newsletter_email_field}',
      '3. click the {newsletter_submit}',
      'oracle: (discover) the email validation error is visible',
    ].join('\n'),
  },
  {
    key: 'home.smoke',
    kind: 'happy', priority: 'critical', safety: 'read-safe',
    intent: 'The landing page loads with its headline and primary navigation intact.',
    requires: 'the home page plus one crawled heading and one primary nav element',
    skeleton: [
      '1. navigate to {home}',
      'oracle: the text "{crawled_heading}" is shown AND the {primary_nav_element} is visible',
      'NOTE: a designed smoke test — assert the two elements the App Brief calls load-bearing, not a link sweep.',
    ].join('\n'),
  },
];

const BY_KEY = new Map(SCENARIO_ARCHETYPES.map((a) => [a.key, a]));

export function getArchetype(key: string): ScenarioArchetype | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * Compact catalog rendering for the PLAN prompt's static prefix (~3–4k tokens).
 * Skeletons are deliberately excluded here — the planner SELECTS patterns; only
 * the chosen entries' skeletons travel to WRITE. Ordering is fixed so the
 * provider's prompt cache keys on a stable prefix.
 */
export function renderCatalogBlock(): string {
  return SCENARIO_ARCHETYPES
    .map((a) => `- ${a.key} [${a.kind}/${a.priority}/${a.safety}] ${a.intent} REQUIRES: ${a.requires}`)
    .join('\n');
}

/* Archetype skeletons for the plan-review "planned approach" disclosure.
   Mirrors docs/specs/test-writer/catalog-v1.md — a catalog scenario's approach is
   static, known content, so showing it costs nothing and is more precise than
   asking the model to paraphrase its own pattern.
   Spec: docs/specs/test-writer/spec-generation-pipeline.md §2.2 */
export const ARCHETYPE_SKELETONS: Record<string, string> = {
  'auth.signup.happy':
    'Open the signup page, fill every required field with per-run throwaway data, submit, and check the success confirmation appears.',
  'auth.signup.negative.invalid-email':
    'Open the signup page, type a malformed email, submit, and check the validation error appears and the page did not advance.',
  'auth.login.negative.wrong-password':
    'Open the login page, enter a valid identifier with the wrong password, submit, and check the invalid-credentials error appears.',
  'auth.login.negative.empty-password':
    'Open the login page, enter an identifier with no password, submit, and check the app refuses it.',
  'auth.password-reset.request':
    'Open the forgot-password page, submit an address, and check the check-your-email confirmation appears.',
  'permissions.protected-page-requires-login':
    'Visit a page recon found behind sign-in while signed out, and check it lands on login instead of showing the content.',
  'permissions.negative.direct-admin-url':
    'Visit an admin path directly while signed out, and check the gate exists (redirect or access-denied). Never attempts to bypass it.',
  'search.find-known-entity':
    'Search for an item the crawl proved exists, and check it appears in the results.',
  'search.negative.no-results':
    'Search for a nonsense term and check the app shows an explicit no-results state.',
  'search.result-navigates':
    'Search for a known item, open its result, and check the detail page is for that item.',
  'search.edge.special-characters':
    'Search using markup characters and check the page renders normally instead of erroring.',
  'forms.negative.required-fields':
    'Submit the form completely empty and check required-field validation appears.',
  'forms.negative.invalid-format':
    'Fill the form but give one typed field a malformed value, submit, and check the format error appears.',
  'forms.contact.happy':
    'Fill every required field with throwaway data, submit, and check the confirmation appears.',
  'forms.edge.reload-clears':
    'Type into a form, reload the page, and check the input did not silently persist.',
  'commerce.cart.add-random-item':
    'Open the listing, add a randomly chosen product to the cart, open the cart, and check that exact product is there.',
  'commerce.cart.remove-item':
    'Add a product, remove it from the cart, and check it is gone.',
  'commerce.product.detail-from-listing':
    'Open a randomly chosen product from the listing and check the detail page is for that product.',
  'commerce.listing.filter-or-sort':
    'Apply a sort or filter on the listing and check the page re-renders without error.',
  'commerce.checkout.reach-payment':
    'Add a product, start checkout, fill the pre-payment steps, and check it reaches the payment step. Never presses the pay button.',
  'commerce.checkout.negative.empty-cart':
    'Open the cart with nothing in it and check the empty-cart state, or that checkout is blocked.',
  'nav.critical-journey-links':
    'Walk a verified journey hop by hop through the UI and check each destination is reached.',
  'nav.negative.not-found':
    'Visit a path that does not exist and check the app shows a designed 404 rather than crashing.',
  'nav.footer-legal-pages':
    'Open a legal/footer link and check the right document loads.',
  'nav.header-reveals-menu':
    'Open a navigation menu and check its links become visible.',
  'dialog.open-and-close':
    'Open a modal, check its content is visible, close it, and check it is gone.',
  'content.pagination.next':
    'Page a listing forward and check the next page of results loads.',
  'content.language-or-currency-switch':
    'Switch locale or currency and check the page reflects the change.',
  'newsletter.subscribe.happy':
    'Subscribe with a throwaway address and check the confirmation appears.',
  'newsletter.subscribe.negative.invalid-email':
    'Subscribe with a malformed address and check the validation error appears.',
  'home.smoke':
    'Open the landing page and check its headline and primary navigation are present.',
};

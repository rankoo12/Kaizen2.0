/**
 * Benchmark fixtures — the standing "QA test plan" for Kaizen's resolver.
 *
 * A mix of end-to-end business flows, small single-feature checks, and adversarial
 * negatives (which MUST fail), across e-commerce grids, data tables, forms, and content
 * lists. `mustLearn` is set only on cacheable INTERACTION steps — state-assertions
 * (assert_checked/enabled/attribute/…) resolve via the no-cache resolver by design and
 * are not expected to cache.
 *
 * Sites are purpose-built, stable, anti-bot-free demo/QA apps.
 */
import type { BenchmarkTest } from '../lib/types';
import { INTERNET_TESTS } from './the-internet';
import { SAUCEDEMO_TESTS } from './saucedemo';
import { TOSCRAPE_TESTS } from './toscrape';
import { FORMY_TESTS } from './formy';
import { INTERNET2_TESTS } from './the-internet-2';
import { INTERNET3_TESTS } from './the-internet-3';
import { MORE_TESTS } from './more';
import { EXTRAS_TESTS } from './extras';
import { REAL_SITE_TESTS } from './real-sites';
import { LONG_FLOW_TESTS } from './long-flows';

const SD = 'https://www.saucedemo.com';
const IN = 'https://the-internet.herokuapp.com';
const QUOTES = 'https://quotes.toscrape.com';

const sdLogin = [
  `navigate to ${SD}/`,
  'type "standard_user" in the Username field',
  'type "secret_sauce" in the Password field',
  'click the Login button',
];

export const ALL_TESTS: BenchmarkTest[] = [
  // ── e2e flows ────────────────────────────────────────────────────────────────
  {
    id: 'saucedemo-checkout-bikelight', name: 'saucedemo: login → add-to-cart → verify → count',
    baseUrl: SD, category: 'e2e-flow',
    steps: [
      ...sdLogin,
      'verify the page contains "Products"',
      'click the Add to cart button for Sauce Labs Bike Light',
      'click the shopping cart link',
      'verify the page contains "Sauce Labs Bike Light"',
      'verify there is 1 item in the cart',
    ],
    oracle: {
      verdict: 'passed',
      steps: [
        { index: 1, mustLearn: true }, { index: 2, mustLearn: true }, { index: 3, mustLearn: true },
        { index: 5, mustLearn: true, expectSelectorIncludes: 'bike-light', expectSelectorExcludes: 'data-kaizen-id' },
        { index: 6, mustLearn: true },
      ],
    },
    tags: ['ecommerce', 'assert_count'],
  },
  {
    id: 'saucedemo-random-capture', name: 'saucedemo: pick random product → cross-step assert {{selectedItem}}',
    baseUrl: SD, category: 'e2e-flow',
    steps: [
      ...sdLogin,
      'select a random product and add it to the cart',
      'click the shopping cart link',
      'verify the cart contains {{selectedItem}}',
    ],
    oracle: {
      verdict: 'passed',
      steps: [
        { index: 1, mustLearn: true }, { index: 2, mustLearn: true }, { index: 3, mustLearn: true },
        { index: 4, expectCapture: { name: 'selectedItem', nonEmpty: true } },
        { index: 5, mustLearn: true },
      ],
    },
    tags: ['ecommerce', 'click_random', 'capture'],
  },
  {
    id: 'internet-secure-login', name: 'the-internet: form auth (unique/archetype control)',
    baseUrl: `${IN}/login`, category: 'e2e-flow',
    steps: [
      `navigate to ${IN}/login`,
      'type "tomsmith" in the username field',
      'type "SuperSecretPassword!" in the password field',
      'click the Login button',
      'verify the page contains "You logged into a secure area"',
    ],
    oracle: { verdict: 'passed', steps: [{ index: 1, mustLearn: true }, { index: 2, mustLearn: true }, { index: 3, mustLearn: true }] },
    tags: ['forms', 'control'],
  },
  {
    id: 'internet-multi-window', name: 'the-internet: open window → switch_tab → close_tab',
    baseUrl: `${IN}/windows`, category: 'e2e-flow',
    steps: [
      `navigate to ${IN}/windows`,
      'click the Click Here link',
      'switch to the new tab',
      'verify the page contains "New Window"',
      'close the current tab',
      'switch to the first tab',
    ],
    oracle: { verdict: 'passed', steps: [{ index: 1, mustLearn: true }] },
    tags: ['multi-tab'],
  },

  // ── small-feature checks ─────────────────────────────────────────────────────
  {
    id: 'internet-checkbox', name: 'the-internet: check → assert_checked (ordinal, no id)',
    baseUrl: `${IN}/checkboxes`, category: 'small-feature',
    steps: [`navigate to ${IN}/checkboxes`, 'check the second checkbox', 'verify the second checkbox is checked'],
    oracle: { verdict: 'passed', maxWarmResolutionTokens: 300, steps: [{ index: 1, expectSelectorExcludes: 'data-kaizen-id' }] },
    knownLimitation: 'class-A-scoped-selector',
    tags: ['forms', 'assert_checked', 'blind-spot'],
  },
  {
    id: 'internet-add-remove-count', name: 'the-internet: add element → assert_count Delete==1',
    baseUrl: `${IN}/add_remove_elements/`, category: 'small-feature',
    steps: [`navigate to ${IN}/add_remove_elements/`, 'click the Add Element button', 'verify there is 1 Delete button'],
    oracle: { verdict: 'passed', steps: [{ index: 1, mustLearn: true }] },
    tags: ['assert_count'],
  },
  {
    id: 'internet-inputs-attr', name: 'the-internet: type number → assert_attribute (unlabeled input)',
    baseUrl: `${IN}/inputs`, category: 'small-feature',
    steps: [`navigate to ${IN}/inputs`, 'type "42" in the number field', 'verify the number field has value 42'],
    oracle: { verdict: 'passed', maxWarmResolutionTokens: 300, steps: [{ index: 1, expectSelectorExcludes: 'data-kaizen-id' }] },
    knownLimitation: 'class-A-scoped-selector',
    tags: ['forms', 'assert_attribute', 'blind-spot'],
  },
  {
    id: 'saucedemo-backpack-anomaly', name: 'saucedemo: add Backpack (Class B anomaly probe)',
    baseUrl: SD, category: 'small-feature',
    steps: [...sdLogin, 'click the Add to cart button for Sauce Labs Backpack', 'verify there is 1 item in the cart'],
    oracle: {
      // Intermittent: the first add-to-cart after login sometimes heals to a transient
      // marker (timing), sometimes cleanly caches the #id. Tracked, not gated on learning.
      verdict: 'passed', maxWarmResolutionTokens: 450,
      steps: [{ index: 4 }],
    },
    knownLimitation: 'class-B-anomaly',
    tags: ['ecommerce', 'known-issue'],
  },

  // ── known blind spots (Class A: contextual controls, no unique id) ────────────
  {
    id: 'internet-tables-edit-conway', name: 'the-internet: Edit link in Conway\'s row (row-scoped)',
    baseUrl: `${IN}/tables`, category: 'small-feature',
    steps: [`navigate to ${IN}/tables`, 'click the Edit link in the row for Conway', 'verify the URL contains "#edit"'],
    oracle: {
      verdict: 'passed', maxWarmResolutionTokens: 300,
      steps: [{ index: 1, expectSelectorExcludes: 'data-kaizen-id' }],
    },
    knownLimitation: 'class-A-scoped-selector',
    tags: ['tables', 'blind-spot'],
  },
  {
    id: 'quotes-about-einstein', name: 'quotes: about link for Albert Einstein (sibling-disambig)',
    baseUrl: QUOTES, category: 'small-feature',
    steps: [`navigate to ${QUOTES}/`, 'click the about link for Albert Einstein', 'verify the URL contains "/author/Albert-Einstein"'],
    oracle: {
      verdict: 'passed', maxWarmResolutionTokens: 300,
      steps: [{ index: 1, expectSelectorExcludes: 'data-kaizen-id' }],
    },
    knownLimitation: 'class-A-scoped-selector',
    tags: ['content-list', 'blind-spot'],
  },

  // ── contextual correctness (non-first target → wrong pick is OBSERVABLE) ──────
  {
    id: 'quotes-about-rowling', name: 'quotes: about link for J.K. Rowling (2nd quote — not first)',
    baseUrl: QUOTES, category: 'small-feature',
    steps: [`navigate to ${QUOTES}/`, 'click the about link for J.K. Rowling', 'verify the URL contains "/author/J-K-Rowling"'],
    oracle: {
      verdict: 'passed', maxWarmResolutionTokens: 300,
      steps: [{ index: 1, expectSelectorExcludes: 'data-kaizen-id' }],
    },
    knownLimitation: 'class-A-scoped-selector',
    tags: ['content-list', 'contextual-correctness'],
  },

  // ── expansion batch: new patterns (find the next blind spot) ─────────────────
  {
    id: 'internet-dropdown-select', name: 'the-internet: <select> dropdown → assert value',
    baseUrl: `${IN}/dropdown`, category: 'small-feature',
    steps: [`navigate to ${IN}/dropdown`, 'select "Option 2" from the dropdown', 'verify the dropdown has value 2'],
    oracle: { verdict: 'passed', steps: [{ index: 1, mustLearn: true }] },
    tags: ['forms', 'select'],
  },
  {
    id: 'quotes-tag-love', name: 'quotes: click a tag link → assert_url',
    baseUrl: QUOTES, category: 'small-feature',
    steps: [`navigate to ${QUOTES}/`, 'click the love tag', 'verify the URL contains "/tag/love"'],
    oracle: { verdict: 'passed', steps: [{ index: 1, mustLearn: true }] },
    tags: ['content-list', 'links'],
  },
  {
    id: 'saucedemo-sort-count', name: 'saucedemo: sort dropdown → assert_count products',
    baseUrl: SD, category: 'e2e-flow',
    steps: [...sdLogin, 'select "Price (low to high)" from the sort dropdown', 'verify there are 6 items'],
    oracle: {
      verdict: 'passed',
      steps: [{ index: 1, mustLearn: true }, { index: 2, mustLearn: true }, { index: 3, mustLearn: true }, { index: 4, mustLearn: true }],
    },
    tags: ['ecommerce', 'select', 'assert_count'],
  },
  {
    id: 'books-nav-travel', name: 'books.toscrape: sidebar category nav → assert_url',
    baseUrl: 'https://books.toscrape.com/', category: 'small-feature',
    steps: ['navigate to https://books.toscrape.com/', 'click the Travel category', 'verify the URL contains "travel"'],
    oracle: { verdict: 'passed', steps: [{ index: 1, mustLearn: true }] },
    tags: ['content-list', 'nav'],
  },

  // ── adversarial negatives (MUST fail — no false-pass) ─────────────────────────
  {
    id: 'saucedemo-false-price', name: 'saucedemo: assert a wrong price (must fail)',
    baseUrl: SD, category: 'adversarial-negative',
    steps: [...sdLogin, 'verify the page contains "$999.99"'],
    oracle: { verdict: 'failed', steps: [{ index: 4, mustFail: true }] },
    tags: ['negative', 'false-text'],
  },
  {
    id: 'internet-negative-polarity', name: 'the-internet: assert_not_text on present text (must fail)',
    baseUrl: `${IN}/login`, category: 'adversarial-negative',
    steps: [
      `navigate to ${IN}/login`,
      'type "tomsmith" in the username field',
      'type "SuperSecretPassword!" in the password field',
      'click the Login button',
      'verify the page does not contain "You logged into a secure area"',
    ],
    oracle: { verdict: 'failed', steps: [{ index: 4, mustFail: true }] },
    tags: ['negative', 'polarity'],
  },
  ...INTERNET_TESTS,
  ...INTERNET2_TESTS,
  ...INTERNET3_TESTS,
  ...SAUCEDEMO_TESTS,
  ...TOSCRAPE_TESTS,
  ...FORMY_TESTS,
  ...MORE_TESTS,
  ...EXTRAS_TESTS,
  ...REAL_SITE_TESTS,
  ...LONG_FLOW_TESTS,
];

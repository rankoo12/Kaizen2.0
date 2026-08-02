/**
 * Additional high-confidence variants across the stable sites, toward the 100-test target.
 */
import type { BenchmarkTest } from '../lib/types';

const SD = 'https://www.saucedemo.com';
const Q = 'https://quotes.toscrape.com';
const B = 'https://books.toscrape.com';
const IN = 'https://the-internet.herokuapp.com';
const login = [
  `navigate to ${SD}/`,
  'type "standard_user" in the Username field',
  'type "secret_sauce" in the Password field',
  'click the Login button',
];
const learn = (...i: number[]) => i.map((index) => ({ index, mustLearn: true }));

export const MORE_TESTS: BenchmarkTest[] = [
  {
    id: 'sd-continue-shopping', name: 'saucedemo: cart → continue shopping → back on products', baseUrl: SD, category: 'e2e-flow',
    steps: [...login, 'click the Add to cart button for Sauce Labs Backpack', 'click the shopping cart link', 'click the Continue Shopping button', 'verify the page contains "Products"'],
    oracle: { verdict: 'passed', steps: learn(1, 2) }, tags: ['ecommerce', 'nav'],
  },
  {
    id: 'sd-two-count', name: 'saucedemo: add two products → count 2', baseUrl: SD, category: 'e2e-flow',
    steps: [...login, 'click the Add to cart button for Sauce Labs Backpack', 'click the Add to cart button for Sauce Labs Onesie', 'click the shopping cart link', 'verify there are 2 items in the cart'],
    oracle: { verdict: 'passed', steps: learn(1, 2, 3) }, tags: ['ecommerce', 'assert_count'],
  },
  {
    id: 'sd-checkout-overview', name: 'saucedemo: reach payment overview (mid)', baseUrl: SD, category: 'mid',
    steps: [...login, 'click the Add to cart button for Sauce Labs Bolt T-Shirt', 'click the shopping cart link', 'click the Checkout button', 'type "Ann" in the First Name field', 'type "Lee" in the Last Name field', 'type "90210" in the Zip/Postal Code field', 'click the Continue button', 'verify the page contains "Sauce Labs Bolt T-Shirt"'],
    oracle: { verdict: 'passed', steps: learn(1, 2, 4, 5, 6) }, tags: ['ecommerce', 'checkout'],
  },
  {
    id: 'q-tag-humor', name: 'quotes: humor tag', baseUrl: `${Q}/`, category: 'small-feature',
    steps: [`navigate to ${Q}/`, 'click the humor tag', 'verify the URL contains "/tag/humor"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['content-list', 'links'],
  },
  {
    id: 'q-quote-text', name: 'quotes: a known quote is present', baseUrl: `${Q}/`, category: 'small-feature',
    steps: [`navigate to ${Q}/`, 'verify the page contains "The world as we have created it"'],
    oracle: { verdict: 'passed' }, tags: ['text'],
  },
  {
    id: 'b-home-title', name: 'books: home title present', baseUrl: `${B}/`, category: 'small-feature',
    steps: [`navigate to ${B}/`, 'verify the page contains "Books to Scrape"'],
    oracle: { verdict: 'passed' }, tags: ['text'],
  },
  {
    id: 'b-book-price', name: 'books: open a book → price shown', baseUrl: `${B}/`, category: 'mid',
    steps: [`navigate to ${B}/`, 'click the A Light in the Attic book title', 'verify the page contains "£"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['content-list', 'detail'],
  },
  {
    id: 'formy-checkbox-female', name: 'formy: check Female', baseUrl: 'https://formy-project.herokuapp.com/form', category: 'small-feature',
    steps: ['navigate to https://formy-project.herokuapp.com/form', 'check the Female checkbox', 'verify the Female checkbox is checked'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['forms'],
  },
  {
    id: 'in-drag-and-drop', name: 'the-internet: drag A onto B', baseUrl: `${IN}/drag_and_drop`, category: 'small-feature',
    steps: [`navigate to ${IN}/drag_and_drop`, 'drag column A onto column B', 'verify the page contains "A"'],
    oracle: { verdict: 'passed', maxWarmResolutionTokens: 400 }, knownLimitation: 'html5-dnd', tags: ['drag'],
  },
  {
    id: 'in-inputs-clear', name: 'the-internet: type, clear, re-type the number field', baseUrl: `${IN}/inputs`, category: 'small-feature',
    steps: [`navigate to ${IN}/inputs`, 'type "999" in the number field', 'clear the number field', 'type "42" in the number field', 'verify the number field has value 42'],
    oracle: { verdict: 'passed', maxWarmResolutionTokens: 300 }, knownLimitation: 'class-A-scoped-selector', tags: ['forms'],
  },
];

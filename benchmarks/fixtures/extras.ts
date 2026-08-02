/**
 * Final batch to clear 100 — confident variants across the stable sites.
 */
import type { BenchmarkTest } from '../lib/types';

const SD = 'https://www.saucedemo.com';
const Q = 'https://quotes.toscrape.com';
const B = 'https://books.toscrape.com';
const IN = 'https://the-internet.herokuapp.com';
const F = 'https://formy-project.herokuapp.com';
const login = [
  `navigate to ${SD}/`,
  'type "standard_user" in the Username field',
  'type "secret_sauce" in the Password field',
  'click the Login button',
];
const learn = (...i: number[]) => i.map((index) => ({ index, mustLearn: true }));

export const EXTRAS_TESTS: BenchmarkTest[] = [
  {
    id: 'sd-inventory-count', name: 'saucedemo: 6 items on inventory', baseUrl: SD, category: 'small-feature',
    steps: [...login, 'verify there are 6 items'],
    oracle: { verdict: 'passed', steps: learn(1, 2, 3) }, tags: ['ecommerce', 'assert_count'],
  },
  {
    id: 'sd-menu-logout-visible', name: 'saucedemo: open menu → Logout visible', baseUrl: SD, category: 'small-feature',
    steps: [...login, 'click the Open Menu button', 'verify the Logout link is visible'],
    oracle: { verdict: 'passed', steps: learn(1, 2, 3) }, tags: ['menu'],
  },
  {
    id: 'q-tag-life', name: 'quotes: life tag', baseUrl: `${Q}/`, category: 'small-feature',
    steps: [`navigate to ${Q}/`, 'click the life tag', 'verify the URL contains "/tag/life"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['content-list', 'links'],
  },
  {
    id: 'q-author-present', name: 'quotes: Albert Einstein present', baseUrl: `${Q}/`, category: 'small-feature',
    steps: [`navigate to ${Q}/`, 'verify the page contains "Albert Einstein"'],
    oracle: { verdict: 'passed' }, tags: ['text'],
  },
  {
    id: 'in-checkbox-count', name: 'the-internet: 2 checkboxes present', baseUrl: `${IN}/checkboxes`, category: 'small-feature',
    steps: [`navigate to ${IN}/checkboxes`, 'verify there are 2 checkboxes'],
    oracle: { verdict: 'passed' }, tags: ['assert_count'],
  },
  {
    id: 'in-secure-area-heading', name: 'the-internet: login → Secure Area heading', baseUrl: `${IN}/login`, category: 'e2e-flow',
    steps: [`navigate to ${IN}/login`, 'type "tomsmith" in the username field', 'type "SuperSecretPassword!" in the password field', 'click the Login button', 'verify the page contains "Secure Area"'],
    oracle: { verdict: 'passed', steps: learn(1, 2, 3) }, tags: ['auth'],
  },
  {
    id: 'formy-firstname-value', name: 'formy: first name round trip', baseUrl: `${F}/form`, category: 'small-feature',
    steps: [`navigate to ${F}/form`, 'type "Kaizen" in the First Name field', 'verify the First Name field has value "Kaizen"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['forms'],
  },
  {
    id: 'formy-jobtitle-value', name: 'formy: job title round trip', baseUrl: `${F}/form`, category: 'small-feature',
    steps: [`navigate to ${F}/form`, 'type "SDET" in the Job Title field', 'verify the Job Title field has value "SDET"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['forms'],
  },
  {
    id: 'b-book-instock', name: 'books: open a book → In stock', baseUrl: `${B}/`, category: 'mid',
    steps: [`navigate to ${B}/`, 'click the A Light in the Attic book title', 'verify the page contains "In stock"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['content-list', 'detail'],
  },
  {
    id: 'q-pagination-back', name: 'quotes: next then previous', baseUrl: `${Q}/`, category: 'mid',
    steps: [`navigate to ${Q}/`, 'click the Next page link', 'verify the URL contains "/page/2"', 'click the Previous page link', 'verify the URL contains "/page/1"'],
    oracle: { verdict: 'passed', steps: learn(1, 3) }, tags: ['nav'],
  },
];

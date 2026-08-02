/**
 * quotes.toscrape.com + books.toscrape.com — content lists: login, pagination, tag/
 * category navigation, counts. Stable, purpose-built scraping-practice sites.
 */
import type { BenchmarkTest } from '../lib/types';

const Q = 'https://quotes.toscrape.com';
const B = 'https://books.toscrape.com';
const learn = (...i: number[]) => i.map((index) => ({ index, mustLearn: true }));

export const TOSCRAPE_TESTS: BenchmarkTest[] = [
  {
    id: 'q-login', name: 'quotes: login → Logout visible', baseUrl: `${Q}/login`, category: 'e2e-flow',
    steps: [`navigate to ${Q}/login`, 'type "admin" in the Username field', 'type "admin" in the Password field', 'click the Login button', 'verify the Logout link is visible'],
    oracle: { verdict: 'passed', steps: learn(1, 2, 3) }, tags: ['forms', 'auth'],
  },
  {
    id: 'q-pagination', name: 'quotes: Next → page 2', baseUrl: `${Q}/`, category: 'small-feature',
    steps: [`navigate to ${Q}/`, 'click the Next page link', 'verify the URL contains "/page/2"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['nav'],
  },
  {
    id: 'q-tag-inspirational', name: 'quotes: sidebar tag "inspirational"', baseUrl: `${Q}/`, category: 'small-feature',
    steps: [`navigate to ${Q}/`, 'click the inspirational tag', 'verify the URL contains "/tag/inspirational"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['content-list', 'links'],
  },
  {
    id: 'q-count', name: 'quotes: 10 quotes on the page', baseUrl: `${Q}/`, category: 'small-feature',
    steps: [`navigate to ${Q}/`, 'verify there are 10 quotes'],
    oracle: { verdict: 'passed' }, tags: ['assert_count'],
  },
  {
    id: 'q-author-dickens', name: 'quotes: page 3 has a specific author (nav + text)', baseUrl: `${Q}/`, category: 'mid',
    steps: [`navigate to ${Q}/`, 'click the Next page link', 'click the Next page link', 'verify the URL contains "/page/3"'],
    oracle: { verdict: 'passed', steps: learn(1, 2) }, tags: ['nav'],
  },
  {
    id: 'b-category-mystery', name: 'books: sidebar category Mystery', baseUrl: `${B}/`, category: 'small-feature',
    steps: [`navigate to ${B}/`, 'click the Mystery category', 'verify the URL contains "mystery"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['content-list', 'nav'],
  },
  {
    id: 'b-count-products', name: 'books: 20 products on the catalog page', baseUrl: `${B}/`, category: 'small-feature',
    steps: [`navigate to ${B}/`, 'verify there are 20 products'],
    oracle: { verdict: 'passed' }, tags: ['assert_count'],
  },
  {
    id: 'b-product-detail', name: 'books: open a book → detail title', baseUrl: `${B}/`, category: 'mid',
    steps: [`navigate to ${B}/`, 'click the A Light in the Attic book title', 'verify the page contains "A Light in the Attic"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['content-list', 'detail'],
  },
  {
    id: 'b-book-upc', name: 'books: open a book → product info (UPC)', baseUrl: `${B}/`, category: 'mid',
    steps: [`navigate to ${B}/`, 'click the A Light in the Attic book title', 'verify the page contains "UPC"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['content-list', 'detail'],
  },
  {
    id: 'b-category-then-book', name: 'books: category → open a book (e2e nav)', baseUrl: `${B}/`, category: 'mid',
    steps: [`navigate to ${B}/`, 'click the Travel category', 'verify the URL contains "travel"', 'click the It\'s Only the Himalayas book title', 'verify the page contains "Himalayas"'],
    oracle: { verdict: 'passed', steps: learn(1, 3) }, tags: ['content-list', 'nav'],
  },
];

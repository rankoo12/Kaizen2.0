/**
 * saucedemo.com — e-commerce flows: full checkout (20+ steps), cart edits, sorting,
 * product detail, error/edge states. Product names are exact.
 */
import type { BenchmarkTest } from '../lib/types';

const SD = 'https://www.saucedemo.com';
const login = [
  `navigate to ${SD}/`,
  'type "standard_user" in the Username field',
  'type "secret_sauce" in the Password field',
  'click the Login button',
];
const learn = (...i: number[]) => i.map((index) => ({ index, mustLearn: true }));

export const SAUCEDEMO_TESTS: BenchmarkTest[] = [
  {
    id: 'sd-full-checkout', name: 'saucedemo: full checkout, 6 products (e2e, 22 steps)',
    baseUrl: SD, category: 'e2e-flow',
    steps: [
      ...login,
      'verify the page contains "Products"',
      'click the Add to cart button for Sauce Labs Bike Light',
      'click the Add to cart button for Sauce Labs Bolt T-Shirt',
      'click the Add to cart button for Sauce Labs Fleece Jacket',
      'click the Add to cart button for Sauce Labs Onesie',
      'click the Add to cart button for Test.allTheThings() T-Shirt (Red)',
      `navigate to ${SD}/cart.html`,
      'verify the page contains "Sauce Labs Bike Light"',
      'verify the page contains "Sauce Labs Fleece Jacket"',
      'verify there are 5 items in the cart',
      'click the Checkout button',
      'type "Jane" in the First Name field',
      'type "Doe" in the Last Name field',
      'type "12345" in the Zip/Postal Code field',
      'click the Continue button',
      'verify the page contains "Payment Information"',
      'click the Finish button',
      'verify the page contains "Thank you for your order!"',
    ],
    oracle: { verdict: 'passed', steps: learn(1, 2, 3) },
    tags: ['ecommerce', 'e2e', 'checkout'],
  },
  {
    id: 'sd-remove-from-cart', name: 'saucedemo: add 2, remove 1, assert count',
    baseUrl: SD, category: 'e2e-flow',
    steps: [
      ...login,
      'verify the page contains "Products"',
      'click the Add to cart button for Sauce Labs Bike Light',
      'click the Add to cart button for Sauce Labs Bolt T-Shirt',
      'click the shopping cart link',
      'click the Remove button for Sauce Labs Bike Light',
      'verify there is 1 item in the cart',
      'verify the page contains "Sauce Labs Bolt T-Shirt"',
    ],
    oracle: { verdict: 'passed', steps: learn(1, 2, 3) },
    tags: ['ecommerce', 'assert_count'],
  },
  {
    id: 'sd-checkout-missing-name', name: 'saucedemo: checkout without first name → error (positive assert on error)',
    baseUrl: SD, category: 'small-feature',
    steps: [
      ...login,
      'verify the page contains "Products"',
      'click the Add to cart button for Sauce Labs Backpack',
      'click the shopping cart link',
      'click the Checkout button',
      'click the Continue button',
      'verify the page contains "First Name is required"',
    ],
    oracle: { verdict: 'passed', steps: learn(1, 2, 3) },
    tags: ['ecommerce', 'validation'],
  },
  {
    id: 'sd-locked-user', name: 'saucedemo: locked-out user → error message',
    baseUrl: SD, category: 'small-feature',
    steps: [
      `navigate to ${SD}/`,
      'type "locked_out_user" in the Username field',
      'type "secret_sauce" in the Password field',
      'click the Login button',
      'verify the page contains "this user has been locked out"',
    ],
    oracle: { verdict: 'passed', steps: learn(1, 2, 3) },
    tags: ['auth', 'error'],
  },
  {
    id: 'sd-logout', name: 'saucedemo: open menu → logout → back on login',
    baseUrl: SD, category: 'e2e-flow',
    steps: [
      ...login,
      'click the Open Menu button',
      'click the Logout link',
      'verify the Login button is visible',
    ],
    oracle: { verdict: 'passed', steps: learn(1, 2, 3) },
    tags: ['nav', 'menu'],
  },
  {
    id: 'sd-product-detail-add', name: 'saucedemo: open product detail → add to cart → verify in cart',
    baseUrl: SD, category: 'e2e-flow',
    steps: [
      ...login,
      'click the Sauce Labs Bike Light product title',
      'verify the page contains "Sauce Labs Bike Light"',
      'click the Add to cart button',
      // Verify in the cart itself (where the item lives), as a QA would — the detail page
      // has no cart line-items to count, only the badge number.
      `navigate to ${SD}/cart.html`,
      'verify the page contains "Sauce Labs Bike Light"',
      'verify there is 1 item in the cart',
    ],
    oracle: { verdict: 'passed', steps: learn(1, 2, 3) },
    tags: ['ecommerce', 'detail'],
  },
  {
    id: 'sd-sort-name-za', name: 'saucedemo: sort Name Z→A → first item',
    baseUrl: SD, category: 'small-feature',
    steps: [
      ...login,
      'select "Name (Z to A)" from the sort dropdown',
      'verify the page contains "Test.allTheThings()"',
    ],
    oracle: { verdict: 'passed', steps: learn(1, 2, 3) },
    tags: ['ecommerce', 'select'],
  },
  {
    id: 'sd-wrong-password', name: 'saucedemo: wrong password → error',
    baseUrl: SD, category: 'small-feature',
    steps: [
      `navigate to ${SD}/`,
      'type "standard_user" in the Username field',
      'type "wrong_password" in the Password field',
      'click the Login button',
      'verify the page contains "Username and password do not match"',
    ],
    oracle: { verdict: 'passed', steps: learn(1, 2, 3) },
    tags: ['auth', 'error'],
  },
];

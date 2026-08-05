/**
 * the-internet.herokuapp.com — second batch. More feature pages, incl. iframe / modal /
 * key-press candidates that may surface new blind spots. Safe oracles.
 */
import type { BenchmarkTest } from '../lib/types';

const IN = 'https://the-internet.herokuapp.com';
const learn = (...i: number[]) => i.map((index) => ({ index, mustLearn: true }));

export const INTERNET2_TESTS: BenchmarkTest[] = [
  {
    id: 'in2-abtest', name: 'A/B test page text', baseUrl: `${IN}/abtest`, category: 'small-feature',
    steps: [`navigate to ${IN}/abtest`, 'verify the page contains "A/B Test"'],
    oracle: { verdict: 'passed' }, tags: ['text'],
  },
  {
    id: 'in2-dynamic-content', name: 'dynamic content page loads', baseUrl: `${IN}/dynamic_content`, category: 'small-feature',
    steps: [`navigate to ${IN}/dynamic_content`, 'verify the page contains "dynamic content"'],
    oracle: { verdict: 'passed' }, tags: ['text'],
  },
  {
    id: 'in2-disappearing', name: 'disappearing elements: Home visible', baseUrl: `${IN}/disappearing_elements`, category: 'small-feature',
    steps: [`navigate to ${IN}/disappearing_elements`, 'verify the Home menu link is visible'],
    oracle: { verdict: 'passed' }, tags: ['assert_visible'],
  },
  {
    id: 'in2-jqueryui-menu', name: 'jQuery UI menu: Enabled visible', baseUrl: `${IN}/jqueryui/menu`, category: 'small-feature',
    steps: [`navigate to ${IN}/jqueryui/menu`, 'verify the Enabled menu item is visible'],
    oracle: { verdict: 'passed' }, tags: ['assert_visible'],
  },
  {
    id: 'in2-sortable-tables', name: 'data tables: a known name is present', baseUrl: `${IN}/tables`, category: 'small-feature',
    steps: [`navigate to ${IN}/tables`, 'verify the page contains "Conway"'],
    oracle: { verdict: 'passed' }, tags: ['tables'],
  },
  {
    id: 'in2-entry-ad', name: 'entry ad: close the modal', baseUrl: `${IN}/entry_ad`, category: 'small-feature',
    steps: [`navigate to ${IN}/entry_ad`, 'click the Close link in the modal', 'verify the page contains "closed"'],
    oracle: { verdict: 'passed', maxWarmResolutionTokens: 300, steps: [{ index: 1, expectSelectorExcludes: 'data-kaizen-id' }] },
    knownLimitation: 'class-A-scoped-selector', tags: ['modal'],
  },
  {
    id: 'in2-notification', name: 'notification message: click here', baseUrl: `${IN}/notification_message_rendered`, category: 'small-feature',
    steps: [`navigate to ${IN}/notification_message_rendered`, 'click the "Click here" link', 'verify the page contains "Action"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['nav'],
  },
  {
    id: 'in2-status-404', name: 'status codes: click 404', baseUrl: `${IN}/status_codes`, category: 'small-feature',
    steps: [`navigate to ${IN}/status_codes`, 'click the "404" link', 'verify the URL contains "/status_codes/404"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['links'],
  },
  {
    id: 'in2-inputs-heading', name: 'inputs page loads', baseUrl: `${IN}/inputs`, category: 'small-feature',
    steps: [`navigate to ${IN}/inputs`, 'verify the page contains "Inputs"'],
    oracle: { verdict: 'passed' }, tags: ['text'],
  },
  {
    id: 'in2-download-page', name: 'file download page loads', baseUrl: `${IN}/download`, category: 'small-feature',
    steps: [`navigate to ${IN}/download`, 'verify the page contains "File Downloader"'],
    oracle: { verdict: 'passed' }, tags: ['text'],
  },
  {
    id: 'in2-home-nav-login', name: 'home → Form Authentication link → login page', baseUrl: `${IN}/`, category: 'small-feature',
    steps: [`navigate to ${IN}/`, 'click the Form Authentication link', 'verify the page contains "Login Page"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['nav', 'links'],
  },
  {
    id: 'in2-home-listing', name: 'the-internet home lists examples', baseUrl: `${IN}/`, category: 'small-feature',
    steps: [`navigate to ${IN}/`, 'verify the page contains "Available Examples"'],
    oracle: { verdict: 'passed' }, tags: ['text'],
  },
  {
    id: 'in2-shifting-menu', name: 'shifting content menu visible', baseUrl: `${IN}/shifting_content/menu`, category: 'small-feature',
    steps: [`navigate to ${IN}/shifting_content/menu`, 'verify the Home menu link is visible'],
    oracle: { verdict: 'passed' }, tags: ['assert_visible'],
  },
];

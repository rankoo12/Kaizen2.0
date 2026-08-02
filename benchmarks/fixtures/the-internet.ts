/**
 * the-internet.herokuapp.com — one fixture per feature page. Stable, anti-bot-free,
 * purpose-built for automation. Safe oracles (known messages / url / count / state).
 */
import type { BenchmarkTest } from '../lib/types';

const IN = 'https://the-internet.herokuapp.com';
const learn = (...i: number[]) => ({ steps: i.map((index) => ({ index, mustLearn: true })) });

export const INTERNET_TESTS: BenchmarkTest[] = [
  {
    id: 'in-login-invalid-user', name: 'login: invalid username → error message', baseUrl: `${IN}/login`, category: 'small-feature',
    steps: [`navigate to ${IN}/login`, 'type "wronguser" in the username field', 'type "wrongpass" in the password field', 'click the Login button', 'verify the page contains "Your username is invalid!"'],
    oracle: { verdict: 'passed', ...learn(1, 2, 3) }, tags: ['forms'],
  },
  {
    id: 'in-checkbox-first', name: 'checkboxes: check the first box', baseUrl: `${IN}/checkboxes`, category: 'small-feature',
    steps: [`navigate to ${IN}/checkboxes`, 'check the first checkbox', 'verify the first checkbox is checked'],
    oracle: { verdict: 'passed', maxWarmResolutionTokens: 300, steps: [{ index: 1, expectSelectorExcludes: 'data-kaizen-id' }] }, knownLimitation: 'class-A-scoped-selector', tags: ['forms'],
  },
  {
    id: 'in-dropdown-opt1', name: 'dropdown: select Option 1', baseUrl: `${IN}/dropdown`, category: 'small-feature',
    steps: [`navigate to ${IN}/dropdown`, 'select "Option 1" from the dropdown', 'verify the dropdown has value 1'],
    oracle: { verdict: 'passed', ...learn(1) }, tags: ['forms', 'select'],
  },
  {
    id: 'in-add-remove-3', name: 'add/remove: add 3 elements → count', baseUrl: `${IN}/add_remove_elements/`, category: 'small-feature',
    steps: [`navigate to ${IN}/add_remove_elements/`, 'click the Add Element button', 'click the Add Element button', 'click the Add Element button', 'verify there are 3 Delete buttons'],
    oracle: { verdict: 'passed', ...learn(1) }, tags: ['assert_count'],
  },
  {
    id: 'in-dynamic-loading-1', name: 'dynamic loading 1: start → Hello World', baseUrl: `${IN}/dynamic_loading/1`, category: 'small-feature',
    steps: [`navigate to ${IN}/dynamic_loading/1`, 'click the Start button', 'verify the page contains "Hello World!"'],
    oracle: { verdict: 'passed', ...learn(1) }, tags: ['async'],
  },
  {
    id: 'in-dynamic-loading-2', name: 'dynamic loading 2: start → Hello World (hidden then rendered)', baseUrl: `${IN}/dynamic_loading/2`, category: 'small-feature',
    steps: [`navigate to ${IN}/dynamic_loading/2`, 'click the Start button', 'verify the page contains "Hello World!"'],
    oracle: { verdict: 'passed', ...learn(1) }, tags: ['async'],
  },
  {
    id: 'in-dynamic-controls-enable', name: 'dynamic controls: enable input (async) → completion message', baseUrl: `${IN}/dynamic_controls`, category: 'small-feature',
    steps: [`navigate to ${IN}/dynamic_controls`, 'click the Enable button', 'verify the page contains "It\'s enabled!"'],
    oracle: { verdict: 'passed', ...learn(1) }, tags: ['async', 'state'],
  },
  {
    id: 'in-js-alert', name: 'js alerts: click alert → success message', baseUrl: `${IN}/javascript_alerts`, category: 'small-feature',
    steps: [`navigate to ${IN}/javascript_alerts`, 'click the "Click for JS Alert" button', 'verify the page contains "You successfully clicked an alert"'],
    oracle: { verdict: 'passed', ...learn(1) }, tags: ['dialog'],
  },
  {
    id: 'in-js-confirm', name: 'js alerts: confirm → You clicked: Ok', baseUrl: `${IN}/javascript_alerts`, category: 'small-feature',
    steps: [`navigate to ${IN}/javascript_alerts`, 'click the "Click for JS Confirm" button', 'verify the page contains "You clicked: Ok"'],
    oracle: { verdict: 'passed', ...learn(1) }, tags: ['dialog'],
  },
  {
    id: 'in-redirect', name: 'redirector: here → status_codes', baseUrl: `${IN}/redirector`, category: 'small-feature',
    steps: [`navigate to ${IN}/redirector`, 'click the "here" link', 'verify the URL contains "/status_codes"'],
    oracle: { verdict: 'passed', ...learn(1) }, tags: ['nav'],
  },
  {
    id: 'in-status-200', name: 'status codes: click 200', baseUrl: `${IN}/status_codes`, category: 'small-feature',
    steps: [`navigate to ${IN}/status_codes`, 'click the "200" link', 'verify the URL contains "/status_codes/200"'],
    oracle: { verdict: 'passed', ...learn(1) }, tags: ['nav', 'links'],
  },
  {
    id: 'in-nested-frames', name: 'nested frames: assert MIDDLE (frame scan)', baseUrl: `${IN}/nested_frames`, category: 'small-feature',
    steps: [`navigate to ${IN}/nested_frames`, 'verify the page contains "MIDDLE"'],
    oracle: { verdict: 'passed' }, tags: ['iframe'],
  },
  {
    id: 'in-broken-images', name: 'broken images: count images', baseUrl: `${IN}/broken_images`, category: 'small-feature',
    steps: [`navigate to ${IN}/broken_images`, 'verify there are 3 images'],
    oracle: { verdict: 'passed' }, tags: ['assert_count'],
  },
  {
    id: 'in-floating-menu', name: 'floating menu: Home link visible', baseUrl: `${IN}/floating_menu`, category: 'small-feature',
    steps: [`navigate to ${IN}/floating_menu`, 'verify the Home menu link is visible'],
    oracle: { verdict: 'passed' }, tags: ['assert_visible'],
  },
  {
    id: 'in-large-table', name: 'large: deep table cell', baseUrl: `${IN}/large`, category: 'small-feature',
    steps: [`navigate to ${IN}/large`, 'verify the page contains "50.50"'],
    oracle: { verdict: 'passed' }, tags: ['tables'],
  },
  {
    id: 'in-context-menu', name: 'context menu: right-click hotspot (alert auto-accepted)', baseUrl: `${IN}/context_menu`, category: 'small-feature',
    steps: [`navigate to ${IN}/context_menu`, 'right click the hot spot box', 'verify the page contains "Context Menu"'],
    oracle: { verdict: 'passed', ...learn(1) }, tags: ['right_click', 'dialog'],
  },
  {
    id: 'in-typos', name: 'typos: expected sentence present', baseUrl: `${IN}/typos`, category: 'small-feature',
    steps: [`navigate to ${IN}/typos`, 'verify the page contains "Typos"'],
    oracle: { verdict: 'passed' }, tags: ['text'],
  },
];

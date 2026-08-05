/**
 * the-internet.herokuapp.com — third batch. Interactive-but-reliable: login/logout,
 * counts, status links, form value round-trips, more checkbox/dropdown variants.
 */
import type { BenchmarkTest } from '../lib/types';

const IN = 'https://the-internet.herokuapp.com';
const learn = (...i: number[]) => i.map((index) => ({ index, mustLearn: true }));

export const INTERNET3_TESTS: BenchmarkTest[] = [
  {
    id: 'in3-login-logout', name: 'login → logout round trip (e2e)', baseUrl: `${IN}/login`, category: 'e2e-flow',
    steps: [`navigate to ${IN}/login`, 'type "tomsmith" in the username field', 'type "SuperSecretPassword!" in the password field', 'click the Login button', 'click the Logout button', 'verify the page contains "You logged out of the secure area!"'],
    oracle: { verdict: 'passed', steps: learn(1, 2, 3) }, tags: ['auth', 'e2e'],
  },
  {
    id: 'in3-add-remove-5', name: 'add 5 elements → count 5', baseUrl: `${IN}/add_remove_elements/`, category: 'small-feature',
    steps: [`navigate to ${IN}/add_remove_elements/`, 'click the Add Element button', 'click the Add Element button', 'click the Add Element button', 'click the Add Element button', 'click the Add Element button', 'verify there are 5 Delete buttons'],
    oracle: { verdict: 'passed', ...learn(1) }, tags: ['assert_count'],
  },
  {
    id: 'in3-add-then-remove', name: 'add 2, delete 1 → count 1', baseUrl: `${IN}/add_remove_elements/`, category: 'small-feature',
    steps: [`navigate to ${IN}/add_remove_elements/`, 'click the Add Element button', 'click the Add Element button', 'click the first Delete button', 'verify there is 1 Delete button'],
    oracle: { verdict: 'passed', maxWarmResolutionTokens: 300 }, knownLimitation: 'class-A-scoped-selector', tags: ['assert_count'],
  },
  {
    id: 'in3-status-500', name: 'status codes: click 500', baseUrl: `${IN}/status_codes`, category: 'small-feature',
    steps: [`navigate to ${IN}/status_codes`, 'click the "500" link', 'verify the URL contains "/status_codes/500"'],
    oracle: { verdict: 'passed', ...learn(1) }, tags: ['links'],
  },
  {
    id: 'in3-status-301', name: 'status codes: click 301', baseUrl: `${IN}/status_codes`, category: 'small-feature',
    steps: [`navigate to ${IN}/status_codes`, 'click the "301" link', 'verify the URL contains "/status_codes/301"'],
    oracle: { verdict: 'passed', ...learn(1) }, tags: ['links'],
  },
  {
    id: 'in3-forgot-password-type', name: 'forgot password: type email (form value)', baseUrl: `${IN}/forgot_password`, category: 'small-feature',
    steps: [`navigate to ${IN}/forgot_password`, 'type "qa@kaizen.dev" in the email field', 'verify the email field has value "qa@kaizen.dev"'],
    oracle: { verdict: 'passed', ...learn(1) }, tags: ['forms'],
  },
  {
    id: 'in3-inputs-negative', name: 'inputs: type a negative number', baseUrl: `${IN}/inputs`, category: 'small-feature',
    steps: [`navigate to ${IN}/inputs`, 'type "-7" in the number field', 'verify the number field has value "-7"'],
    oracle: { verdict: 'passed', maxWarmResolutionTokens: 300 }, knownLimitation: 'class-A-scoped-selector', tags: ['forms'],
  },
  {
    id: 'in3-challenging-dom-count', name: 'challenging dom: table row count', baseUrl: `${IN}/challenging_dom`, category: 'small-feature',
    steps: [`navigate to ${IN}/challenging_dom`, 'verify there are 10 rows'],
    oracle: { verdict: 'passed' }, tags: ['assert_count', 'tables'],
  },
  {
    id: 'in3-upload-page', name: 'file upload page loads', baseUrl: `${IN}/upload`, category: 'small-feature',
    steps: [`navigate to ${IN}/upload`, 'verify the page contains "File Uploader"'],
    oracle: { verdict: 'passed' }, tags: ['text'],
  },
  {
    id: 'in3-horizontal-slider', name: 'horizontal slider page loads', baseUrl: `${IN}/horizontal_slider`, category: 'small-feature',
    steps: [`navigate to ${IN}/horizontal_slider`, 'verify the page contains "Horizontal Slider"'],
    oracle: { verdict: 'passed' }, tags: ['text'],
  },
  {
    id: 'in3-wysiwyg-load', name: 'wysiwyg editor page loads', baseUrl: `${IN}/tinymce`, category: 'small-feature',
    steps: [`navigate to ${IN}/tinymce`, 'verify the page contains "An iFrame containing the TinyMCE WYSIWYG Editor"'],
    oracle: { verdict: 'passed' }, tags: ['iframe', 'text'],
  },
  {
    id: 'in3-dropdown-opt2', name: 'dropdown: select Option 2', baseUrl: `${IN}/dropdown`, category: 'small-feature',
    steps: [`navigate to ${IN}/dropdown`, 'select "Option 2" from the dropdown', 'verify the dropdown has value 2'],
    oracle: { verdict: 'passed', ...learn(1) }, tags: ['forms', 'select'],
  },
];

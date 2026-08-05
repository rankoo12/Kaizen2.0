/**
 * formy-project.herokuapp.com — classic form-automation practice site: a full form,
 * radios, checkboxes, selects, a modal, buttons.
 */
import type { BenchmarkTest } from '../lib/types';

const F = 'https://formy-project.herokuapp.com';
const learn = (...i: number[]) => i.map((index) => ({ index, mustLearn: true }));

export const FORMY_TESTS: BenchmarkTest[] = [
  {
    id: 'formy-form-submit', name: 'formy: fill the whole form → submit (e2e)', baseUrl: `${F}/form`, category: 'e2e-flow',
    steps: [
      `navigate to ${F}/form`,
      'type "Jane" in the First Name field',
      'type "Doe" in the Last Name field',
      'type "QA Engineer" in the Job Title field',
      'click the College radio button',
      'check the Male checkbox',
      'select "5-9" from the years of experience dropdown',
      'type "01/15/2020" in the Date field',
      'click the Submit button',
      'verify the page contains "successfully submitted"',
    ],
    oracle: { verdict: 'passed', steps: learn(1, 2, 3, 4, 5, 6, 7, 8) },
    tags: ['forms', 'e2e'],
  },
  {
    id: 'formy-radio-college', name: 'formy: select College radio', baseUrl: `${F}/form`, category: 'small-feature',
    steps: [`navigate to ${F}/form`, 'click the College radio button', 'verify the College radio button is checked'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['forms'],
  },
  {
    id: 'formy-select-experience', name: 'formy: select years of experience', baseUrl: `${F}/form`, category: 'small-feature',
    steps: [`navigate to ${F}/form`, 'select "2-4" from the years of experience dropdown', 'verify the dropdown shows "2-4"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['forms', 'select'],
  },
  {
    id: 'formy-modal', name: 'formy: open modal → assert visible', baseUrl: `${F}/modal`, category: 'small-feature',
    steps: [`navigate to ${F}/modal`, 'click the Open Modal button', 'verify the page contains "Modal title"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['modal'],
  },
  {
    id: 'formy-buttons', name: 'formy: buttons page loads and a button is visible', baseUrl: `${F}/buttons`, category: 'small-feature',
    steps: [`navigate to ${F}/buttons`, 'verify the "Button" link is visible'],
    oracle: { verdict: 'passed' }, tags: ['assert_visible'],
  },
  {
    id: 'formy-datepicker', name: 'formy: type a date', baseUrl: `${F}/datepicker`, category: 'small-feature',
    steps: [`navigate to ${F}/datepicker`, 'type "01/15/2020" in the date field', 'verify the date field has value "01/15/2020"'],
    oracle: { verdict: 'passed', steps: learn(1) }, tags: ['forms'],
  },
];

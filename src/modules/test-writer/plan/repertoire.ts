import type { PageDossier, PlannedScenario, TenantBrief } from '../../../types/test-writer';

/**
 * The shape repertoire — tests a QA engineer writes without reading a word.
 * Spec: docs/specs/test-writer/spec-planner-per-page.md §1.3
 *
 * A checkbox gets toggled both ways. A dropdown gets an option chosen and read
 * back. A link that opens a new tab gets followed and its destination checked.
 * These fire on ELEMENT SHAPE alone — zero tokens, and each carries a fixed
 * expected outcome so WRITE has an oracle to aim at instead of inventing one.
 *
 * Deliberately small. The catalog remains the LLM-visible menu of richer
 * patterns; this is the half of the engineer's repertoire that needs no reading
 * at all, and it is what turns "40 demo pages" into a floor rather than a hope.
 */

type Rule = {
  key: string;
  applies: (page: PageDossier) => boolean;
  scenarios: (page: PageDossier, brief: TenantBrief | null) => Array<Omit<PlannedScenario, 'targetPages' | 'source' | 'journey'>>;
};

const has = (page: PageDossier, role: string): boolean => page.elements.some((e) => e.role === role);
/** "Forgot Password: E-mail [Retrieve password]" → "E-mail" — the fields, not the label or the button. */
const fieldsOf = (summary: string): string => summary.split('[')[0].split(':').slice(1).join(':');
const first = (page: PageDossier, role: string) => page.elements.find((e) => e.role === role);
const short = (url: string): string => {
  try { return new URL(url).pathname.replace(/\/$/, '') || '/'; } catch { return url; }
};

const RULES: Rule[] = [
  {
    key: 'shape.checkbox-toggle',
    applies: (p) => has(p, 'checkbox'),
    scenarios: (p) => {
      const box = first(p, 'checkbox')!;
      return [{
        name: `Toggle the "${box.name}" checkbox on ${short(p.url)}`,
        kind: 'happy', priority: 'high',
        rationale: 'A checkbox that does not hold its state is the most basic form defect there is.',
        outline: `check the "${box.name}" checkbox and verify it is checked, then uncheck it and verify it is not checked`,
        expectedOutcome: `the "${box.name}" checkbox reads as checked after checking and as not checked after unchecking`,
      }];
    },
  },
  {
    key: 'shape.select-option',
    applies: (p) => has(p, 'combobox') || has(p, 'listbox'),
    scenarios: (p) => {
      const sel = first(p, 'combobox') ?? first(p, 'listbox')!;
      return [{
        name: `Choose an option from the "${sel.name}" dropdown on ${short(p.url)}`,
        kind: 'happy', priority: 'high',
        rationale: 'Selecting must change what the control shows; a dropdown that ignores the choice is broken.',
        outline: `select an option from the "${sel.name}" dropdown and verify the chosen option is now the displayed selection`,
        expectedOutcome: `the dropdown shows the option that was chosen`,
      }];
    },
  },
  {
    key: 'shape.new-tab-link',
    applies: (p) => p.elements.some((e) => e.role === 'link' && e.opensNewTab),
    scenarios: (p) => {
      const link = p.elements.find((e) => e.role === 'link' && e.opensNewTab)!;
      return [{
        name: `"${link.name}" opens in a new tab from ${short(p.url)}`,
        kind: 'happy', priority: 'normal',
        rationale: 'A link marked to open a new window must actually open one, and land on the right page.',
        outline: `click the "${link.name}" link, switch to the new tab, and verify the new tab's title or url is the destination`,
        expectedOutcome: `a new tab is open and its title or url is the linked destination`,
      }];
    },
  },
  {
    key: 'shape.table-sort',
    applies: (p) => has(p, 'columnheader') || p.elements.filter((e) => e.role === 'link' && /^(last name|first name|due|email|web site|name|date|price|amount)$/i.test(e.name)).length >= 2,
    scenarios: (p) => {
      const header = first(p, 'columnheader')
        ?? p.elements.find((e) => e.role === 'link' && /^(last name|first name|due|email|web site|name|date|price|amount)$/i.test(e.name))!;
      return [{
        name: `Sort the table by "${header.name}" on ${short(p.url)}`,
        kind: 'happy', priority: 'normal',
        rationale: 'A sortable header that does not reorder the rows is a silent data-presentation bug.',
        outline: `click the "${header.name}" column header and verify the first row of the table is no longer what it was`,
        expectedOutcome: `the table's first row changes after clicking the "${header.name}" header`,
      }];
    },
  },
  {
    key: 'shape.login-form',
    // A password FIELD, not the word "password" anywhere: /forgot_password's
    // form is "E-mail, [Retrieve password]" and is not a login form.
    applies: (p) => p.forms.some((f) => /password/i.test(fieldsOf(f))) && p.elements.some((e) => e.role === 'button'),
    scenarios: (p, brief) => {
      const cred = /username\s+"([^"]+)".{0,40}?password\s+"([^"]+)"/i.exec((brief?.roles ?? []).concat(brief?.criticalFlows ?? []).join(' '));
      const out: Array<Omit<PlannedScenario, 'targetPages' | 'source' | 'journey'>> = [
        {
          name: `Sign-in rejects a wrong username on ${short(p.url)}`,
          kind: 'negative', priority: 'high',
          rationale: 'The one negative every login form must pass: an unknown user is told so, not let in.',
          outline: 'type an unknown username and any password, submit, and verify the error message that appears',
          expectedOutcome: 'an error message appears saying the username is invalid, and the url is still the login page',
        },
        {
          name: `Sign-in rejects a wrong password on ${short(p.url)}`,
          kind: 'negative', priority: 'high',
          rationale: 'A known user with the wrong password must be refused with a message that names the password.',
          outline: 'type the known username and a wrong password, submit, and verify the error message that appears',
          expectedOutcome: 'an error message appears saying the password is invalid, and the url is still the login page',
        },
      ];
      if (cred) {
        out.unshift({
          name: `Sign in with valid credentials on ${short(p.url)}`,
          kind: 'happy', priority: 'critical',
          rationale: 'The happy path of the login form, using the credentials the brief supplied.',
          outline: `type "${cred[1]}" as the username and the supplied password, submit, and verify the signed-in landing page`,
          expectedOutcome: 'the browser leaves the login page and the signed-in page shows its success message',
        });
      }
      return out;
    },
  },
];

/**
 * Apply every rule to every page. Excluded pages (§1.4) never reach here.
 * Returns full PlannedScenarios with `source: { kind: 'repertoire', ruleKey }`
 * so the report can say where each came from.
 */
export function repertoireScenarios(pages: PageDossier[], brief: TenantBrief | null): PlannedScenario[] {
  const out: PlannedScenario[] = [];
  for (const page of pages) {
    if (page.excludedBy) continue;
    for (const rule of RULES) {
      if (!rule.applies(page)) continue;
      for (const s of rule.scenarios(page, brief)) {
        out.push({
          ...s,
          journey: null,
          targetPages: [page.urlNormalized],
          source: { kind: 'repertoire', ruleKey: rule.key },
          requiresSyntheticData: false,
        });
      }
    }
  }
  return out;
}

export const REPERTOIRE_KEYS = RULES.map((r) => r.key);

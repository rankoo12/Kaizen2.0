/**
 * Generated form data for test runs.
 *
 * Produces a fresh set of realistic-but-fake form values per run so tests that
 * register accounts don't collide ("user already exists"). The values are seeded
 * into the run-scoped variable store and referenced from steps via {{token}}
 * tokens, reusing the same interpolation as captured variables.
 *
 * Spec: docs/specs/tests-ux/spec-duplicate-case-and-generated-data.md §2
 */

/** The catalogue of tokens the UI tools menu offers and this module produces. */
export const FORM_DATA_TOKENS = [
  'firstName',
  'lastName',
  'email',
  'password',
  'phone',
  'company',
  'username',
] as const;

export type FormDataToken = (typeof FORM_DATA_TOKENS)[number];

const FIRST_NAMES = [
  'Jordan', 'Riley', 'Casey', 'Avery', 'Quinn', 'Morgan', 'Taylor', 'Jamie',
  'Drew', 'Skyler', 'Reese', 'Rowan', 'Sawyer', 'Emerson', 'Finley', 'Hayden',
];
const LAST_NAMES = [
  'Tester', 'Walker', 'Hayes', 'Brooks', 'Reed', 'Cole', 'Bishop', 'Frost',
  'Lane', 'Cross', 'Hart', 'Vance', 'Sloan', 'Knox', 'Pierce', 'Quill',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Short alphanumeric suffix that guarantees per-run uniqueness for email/username. */
function uniqueSuffix(): string {
  return Math.random().toString(36).slice(2, 8); // 6 base-36 chars
}

/**
 * Build a password that satisfies the common "upper + lower + digit + symbol,
 * min length" rule used by most registration forms (incl. demowebshop).
 */
function makePassword(suffix: string): string {
  return `Aa1!${suffix}Q`;
}

/**
 * Generate one consistent set of form values. `email`/`username` share the same
 * random suffix so they line up within a run; `email` is unique across runs.
 *
 * @param emailDomain  domain for the generated email (default "example.com").
 */
export function generateFormData(emailDomain = 'example.com'): Record<FormDataToken, string> {
  const firstName = pick(FIRST_NAMES);
  const lastName = pick(LAST_NAMES);
  const suffix = uniqueSuffix();
  const username = `${firstName}.${lastName}.${suffix}`.toLowerCase();

  return {
    firstName,
    lastName,
    email: `${username}@${emailDomain}`,
    password: makePassword(suffix),
    phone: `+1 555 ${String(Math.floor(Math.random() * 900) + 100)} ${String(Math.floor(Math.random() * 9000) + 1000)}`,
    company: `${lastName} LLC`,
    username,
  };
}

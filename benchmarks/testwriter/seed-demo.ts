/**
 * Seed the LOCAL demo workspace with a realistic suite so an analysis of the
 * Kaizen dashboard has tests and runs to work with. Idempotent by suite name.
 *
 *   npx tsx benchmarks/testwriter/seed-demo.ts
 *
 * Signs in as the demo account (test@test.com locally), creates the suite
 * "Checkout smoke" with a handful of the-internet tests — one of them meant to
 * fail — and runs each once. Local only; never points at prod.
 */
const API = process.env.KAIZEN_API ?? 'http://localhost:3000';
const EMAIL = process.env.KAIZEN_DEMO_EMAIL ?? 'test@test.com';
const PASSWORD = process.env.KAIZEN_DEMO_PASSWORD ?? 'test1234';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.url}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function main() {
  const login = await json<{ sessionToken: string; tenants: Array<{ id: string }> }>(
    await fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }));
  const pair = await json<{ accessToken: string }>(await fetch(`${API}/auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionToken: login.sessionToken, tenantId: login.tenants[0].id }),
  }));
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${pair.accessToken}` };

  const suites = await json<{ suites: Array<{ id: string; name: string }> }>(await fetch(`${API}/suites`, { headers }));
  let suite = suites.suites.find((s) => s.name === 'Checkout smoke');
  if (!suite) {
    suite = (await json<{ suite: { id: string; name: string } }>(await fetch(`${API}/suites`, {
      method: 'POST', headers, body: JSON.stringify({ name: 'Checkout smoke' }),
    }))).suite;
    process.stdout.write(`created suite ${suite.id}\n`);
  }

  const BASE = 'https://the-internet.herokuapp.com';
  const tests: Array<{ name: string; steps: string[] }> = [
    { name: 'Sign in with valid credentials', steps: [
      `navigate to ${BASE}/login`, 'type "tomsmith" in the Username field',
      'type "SuperSecretPassword!" in the Password field', 'click the "Login" button',
      'verify the text "You logged into a secure area!" is shown'] },
    { name: 'Sign in with a wrong password shows an error', steps: [
      `navigate to ${BASE}/login`, 'type "tomsmith" in the Username field',
      'type "wrong" in the Password field', 'click the "Login" button',
      'verify the text "Your password is invalid!" is shown'] },
    { name: 'Checkbox can be checked', steps: [
      `navigate to ${BASE}/checkboxes`, 'check the first checkbox', 'verify the first checkbox is checked'] },
    { name: 'Dropdown selection is kept', steps: [
      `navigate to ${BASE}/dropdown`, 'select "Option 2" from the dropdown', 'verify the dropdown has value "Option 2"'] },
    { name: 'Add element shows a Delete button', steps: [
      `navigate to ${BASE}/add_remove_elements/`, 'click the "Add Element" button', 'verify the "Delete" button is visible'] },
    // Meant to fail: the page never says this.
    { name: 'Secure area greets by name (expected to fail)', steps: [
      `navigate to ${BASE}/login`, 'type "tomsmith" in the Username field',
      'type "SuperSecretPassword!" in the Password field', 'click the "Login" button',
      'verify the text "Welcome back, Tom" is shown'] },
  ];

  const existing = await json<{ cases: Array<{ id: string; name: string }> }>(
    await fetch(`${API}/suites/${suite.id}/cases`, { headers }));
  for (const t of tests) {
    let c = existing.cases.find((x) => x.name === t.name);
    if (!c) {
      c = (await json<{ case: { id: string; name: string } }>(await fetch(`${API}/suites/${suite.id}/cases`, {
        method: 'POST', headers, body: JSON.stringify({ name: t.name, baseUrl: BASE, steps: t.steps }),
      }))).case;
      process.stdout.write(`created test ${t.name}\n`);
    }
    const run = await json<{ run?: { id: string }; runId?: string }>(await fetch(`${API}/cases/${c.id}/run`, {
      method: 'POST', headers, body: '{}',
    })).catch((e) => { process.stdout.write(`run failed for ${t.name}: ${String(e).slice(0, 160)}\n`); return null; });
    if (run) process.stdout.write(`queued run for ${t.name}\n`);
  }
  process.stdout.write('done\n');
}

main().catch((e) => { console.error(e); process.exit(1); });

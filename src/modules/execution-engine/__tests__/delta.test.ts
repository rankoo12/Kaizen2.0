import {
  walk, pickDeltaMatch, summariseDelta, isDeltaScoped, captureDelta, captureDeltaBaseline,
  STATE_CHANGING_ACTIONS, DELTA_CLEARING_ACTIONS, NOOP_DETECTABLE_ACTIONS,
  readControlState, actionLeftControlUnchanged, type DeltaElement,
} from '../delta';

/**
 * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §1
 *
 * `walk` is browser code, so the DOM it needs is stubbed rather than mocked:
 * these tests are about the DIFF — what counts as changed and what does not —
 * which is the part that decides whether a discover oracle is honest.
 */

type FakeEl = {
  tagName: string;
  attrs: Record<string, string>;
  own: string;
  hidden?: boolean;
  value?: string;
  childNodes: Array<{ nodeType: number; nodeValue: string }>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): { width: number; height: number };
};

function el(tagName: string, own = '', attrs: Record<string, string> = {}, opts: { hidden?: boolean; value?: string } = {}): FakeEl {
  return {
    tagName: tagName.toUpperCase(),
    attrs,
    own,
    hidden: opts.hidden,
    value: opts.value,
    childNodes: own ? [{ nodeType: 3, nodeValue: own }] : [],
    getAttribute(name) { return this.attrs[name] ?? null; },
    setAttribute(name, value) { this.attrs[name] = value; },
    hasAttribute(name) { return name in this.attrs; },
    getBoundingClientRect() { return this.hidden ? { width: 0, height: 0 } : { width: 100, height: 20 }; },
  };
}

/** Installs a document/window whose body contains exactly these elements. */
function mountPage(elements: FakeEl[]): void {
  const list = {
    length: elements.length,
    forEach(fn: (e: FakeEl) => void) { elements.forEach(fn); },
  } as unknown as NodeListOf<Element>;
  Object.assign(list, elements);

  (global as unknown as { document: unknown }).document = {
    body: { querySelectorAll: () => list },
    querySelectorAll: (sel: string) => ({
      forEach: (fn: (e: FakeEl) => void) => {
        elements.filter((e) => sel === '[data-kz-delta]' && 'data-kz-delta' in e.attrs).forEach(fn);
      },
    }),
  };
  (global as unknown as { window: unknown }).window = {
    getComputedStyle: (e: FakeEl) => ({
      display: e.hidden ? 'none' : 'block',
      visibility: 'visible',
      opacity: '1',
    }),
  };
}

afterEach(() => {
  delete (global as unknown as { document?: unknown }).document;
  delete (global as unknown as { window?: unknown }).window;
});

/** the-internet's /login before submitting, and after an invalid submit. */
const loginPage = (): FakeEl[] => [
  el('h2', 'Login Page'),
  el('form', '', { id: 'login' }),
  el('input', '', { name: 'username', type: 'text' }),
  el('input', '', { name: 'password', type: 'password' }),
  el('button', 'Login', { type: 'submit' }),
  el('a', 'Elemental Selenium', { href: 'http://elementalselenium.com/' }),
];

describe('walk — the diff that defines a delta', () => {
  it('reports nothing changed when the page is identical (a native dialog was accepted)', () => {
    mountPage(loginPage());
    const { keys } = walk({ baseline: null, cap: 0 });
    expect(keys.length).toBeGreaterThan(0);

    mountPage(loginPage());
    const { elements } = walk({ baseline: keys, cap: 40 });
    expect(elements).toEqual([]);
  });

  it('finds only the flash message after a failed sign-in, not the page it re-rendered', () => {
    mountPage(loginPage());
    const { keys } = walk({ baseline: null, cap: 0 });

    // Same page, re-rendered by the POST, plus the flash and its close control.
    const after = loginPage();
    after.unshift(
      el('div', 'Your username is invalid!', { id: 'flash', class: 'flash error' }),
      el('a', '×', { href: '#', class: 'close' }),
    );
    mountPage(after);
    const { elements } = walk({ baseline: keys, cap: 40 });

    expect(elements.map((e) => e.text)).toEqual(['Your username is invalid!', '×']);
    // Marked in the live DOM so the assertion can be scoped to it by selector.
    expect(after[0].attrs['data-kz-delta']).toBe('kz-d-0');
  });

  it('a filter that only HIDES rows is a change (removed), not "nothing changed"', () => {
    const before = [el('button', 'All', { 'aria-pressed': 'true' }), el('button', 'Failed', { 'aria-pressed': 'false' }),
      el('div', 'run 1 passed'), el('div', 'run 2 failed'), el('div', 'run 3 passed')];
    mountPage(before);
    const { keys } = walk({ baseline: null, cap: 0 });

    // Kaizen's Runs view after "Failed": the passed rows are gone, and the
    // Failed button is now the pressed one — that button is the delta.
    const after = [el('button', 'All', { 'aria-pressed': 'false' }), el('button', 'Failed', { 'aria-pressed': 'true' }),
      el('div', 'run 2 failed')];
    mountPage(after);
    const r = walk({ baseline: keys, cap: 40 });
    expect(r.removed).toBe(4);       // two rows + the two buttons in their old states
    expect(r.elements.map((e) => e.text)).toEqual(['All', 'Failed']);
  });

  it('a Save button that becomes enabled is the delta', () => {
    const before = [el('input', '', { name: 'title' }), el('button', 'Save', { 'aria-disabled': 'true' })];
    mountPage(before);
    const { keys } = walk({ baseline: null, cap: 0 });
    const after = [el('input', '', { name: 'title' }, { value: 'x' }), el('button', 'Save', { 'aria-disabled': 'false' })];
    mountPage(after);
    const r = walk({ baseline: keys, cap: 40 });
    expect(r.elements.map((e) => e.text || e.name)).toEqual(['x', 'Save']);
  });

  it('counts text that changed in place — the result line an alert wrote', () => {
    const before = [el('button', 'Click for JS Alert'), el('p', '', { id: 'result' })];
    mountPage(before);
    const { keys } = walk({ baseline: null, cap: 0 });

    const after = [el('button', 'Click for JS Alert'), el('p', 'You successfully clicked an alert', { id: 'result' })];
    mountPage(after);
    const { elements } = walk({ baseline: keys, cap: 40 });

    expect(elements).toHaveLength(1);
    expect(elements[0].text).toBe('You successfully clicked an alert');
  });

  it('counts an element that was hidden and is now visible', () => {
    mountPage([el('button', 'Open'), el('div', 'Logout', {}, { hidden: true })]);
    const { keys } = walk({ baseline: null, cap: 0 });

    mountPage([el('button', 'Open'), el('div', 'Logout')]);
    const { elements } = walk({ baseline: keys, cap: 40 });
    expect(elements.map((e) => e.text)).toEqual(['Logout']);
  });

  it('does not drag ancestors into the delta (own text, never innerText)', () => {
    // A wrapper with no own text stays out even though its subtree changed.
    mountPage([el('div', '', { id: 'wrap' }), el('span', 'one')]);
    const { keys } = walk({ baseline: null, cap: 0 });

    mountPage([el('div', '', { id: 'wrap' }), el('span', 'one'), el('span', 'two')]);
    const { elements } = walk({ baseline: keys, cap: 40 });
    expect(elements.map((e) => e.text)).toEqual(['two']);
  });

  // the-internet /tables, run 3: "Sort table by column → nothing changed". A
  // sort that works leaves the multiset of keys identical; the ORDER changed.
  it('sees a reorder — the rows that moved are the delta', () => {
    mountPage([el('a', 'Last Name'), el('td', 'Smith'), el('td', 'Bach'), el('td', 'Doe')]);
    const { keys } = walk({ baseline: null, cap: 0 });

    mountPage([el('a', 'Last Name'), el('td', 'Bach'), el('td', 'Doe'), el('td', 'Smith')]);
    const { elements } = walk({ baseline: keys, cap: 40 });
    expect(elements.map((e) => e.text)).toEqual(['Bach', 'Doe', 'Smith']);
  });

  it('treats a second identical row as new (multiset, not membership)', () => {
    mountPage([el('li', 'Delete')]);
    const { keys } = walk({ baseline: null, cap: 0 });

    mountPage([el('li', 'Delete'), el('li', 'Delete')]);
    const { elements } = walk({ baseline: keys, cap: 40 });
    expect(elements).toHaveLength(1);
  });
});

describe('pickDeltaMatch', () => {
  const flash: DeltaElement = { marker: 'kz-d-0', role: 'div', name: 'Your username is invalid!', text: 'Your username is invalid!', interactive: false };
  const close: DeltaElement = { marker: 'kz-d-1', role: 'a', name: '×', text: '×', interactive: true };

  it('prefers the message over its close button', () => {
    expect(pickDeltaMatch('the error message', [flash, close])?.marker).toBe('kz-d-0');
  });

  it('matches on the words the assertion actually used', () => {
    const gone: DeltaElement = { marker: 'kz-d-2', role: 'p', name: "It's gone!", text: "It's gone!", interactive: false };
    expect(pickDeltaMatch('the message "It\'s gone!"', [close, gone])?.marker).toBe('kz-d-2');
  });

  it('honours the role the sentence asked for', () => {
    const button: DeltaElement = { marker: 'kz-d-3', role: 'button', name: 'Delete', text: 'Delete', interactive: true };
    const text: DeltaElement = { marker: 'kz-d-4', role: 'p', name: 'Adding element', text: 'Adding element', interactive: false };
    expect(pickDeltaMatch('the "Delete" button', [text, button])?.marker).toBe('kz-d-3');
  });

  it('returns null for an empty delta — there is nothing to bind to', () => {
    expect(pickDeltaMatch('anything', [])).toBeNull();
  });

  it('refuses a delta that is not ABOUT the description — a menu that opened by mistake', () => {
    const menu = [
      { marker: 'kz-d-0', role: 'button', name: 'New Suite', text: 'New Suite', interactive: true },
      { marker: 'kz-d-1', role: 'button', name: 'Analyze an app…', text: 'Analyze an app…', interactive: true },
      { marker: 'kz-d-2', role: 'button', name: 'Keyboard shortcuts', text: 'Keyboard shortcuts', interactive: true },
    ];
    expect(pickDeltaMatch('the running status indicator on the row that was just run', menu)).toBeNull();
    // …but a genuine indicator in the delta is found.
    const badge = { marker: 'kz-d-3', role: 'span', name: 'running', text: 'running', interactive: false };
    expect(pickDeltaMatch('the running status indicator on the row that was just run', [...menu, badge])?.marker).toBe('kz-d-3');
  });

  it('never picks the control the action itself targeted — its state change is not its effect', () => {
    const chip = { marker: 'kz-d-0', role: 'button', name: 'Needs review', text: 'Needs review', interactive: true };
    const row = { marker: 'kz-d-1', role: 'div', name: '', text: 'login button — needs review', interactive: false };
    // run 9: the clicked chip satisfied "a row flagged as needing review".
    expect(pickDeltaMatch('a learned element row flagged as needing review', [chip], 'Needs review')).toBeNull();
    expect(pickDeltaMatch('a learned element row flagged as needing review', [chip, row], 'Needs review')?.marker).toBe('kz-d-1');
  });

  it('refuses unrelated prose for a record-like description', () => {
    // run 9: "Target URL needs to start with http://" proved "the newly saved
    // test's row now listed in the suite" — a validated test that created nothing.
    const refusal = { marker: 'kz-d-0', role: 'div', name: '', text: 'Target URL needs to start with http:// or https://', interactive: false };
    expect(pickDeltaMatch("the newly saved test's row now listed in the suite", [refusal])).toBeNull();
  });

  it('still accepts free prose for a message-like description', () => {
    const flash2 = { marker: 'kz-d-0', role: 'div', name: '', text: 'Your username is invalid!', interactive: false };
    expect(pickDeltaMatch('the error message', [flash2])?.marker).toBe('kz-d-0');
  });

  it('matches on stems — a no-matching-results message finds "Nothing matches"', () => {
    const empty = { marker: 'kz-d-0', role: 'div', name: '', text: 'Nothing matches', interactive: false };
    expect(pickDeltaMatch('a no-matching-results message shown in place of the learned elements', [empty])?.marker).toBe('kz-d-0');
  });

  it('the FIRST noun decides prose vs record — a trailing "message" mention is not the subject', () => {
    const refusal = { marker: 'kz-d-0', role: 'div', name: '', text: 'Target URL needs to start with http:// or https://', interactive: false };
    // run 10: "…replacing the empty-state message" re-armed the prose pass and
    // validated a create-test flow that created nothing.
    expect(pickDeltaMatch('a test row now listed in the Demo suite, replacing the empty-state message, after the New Test form closed', [refusal])).toBeNull();
    // …while a description ABOUT a message still takes prose freely.
    expect(pickDeltaMatch('an empty-state message indicating no healed runs are found', [refusal])?.marker).toBe('kz-d-0');
  });
});

describe('isDeltaScoped', () => {
  it('is on for a description-target assertion the writer marked', () => {
    expect(isDeltaScoped({ action: 'assert_visible', oracleScope: 'delta', targetDescription: 'the message' })).toBe(true);
  });

  it('is off for a grounded assertion and for absence assertions', () => {
    expect(isDeltaScoped({ action: 'assert_visible', targetDescription: 'the "Login" button' })).toBe(false);
    expect(isDeltaScoped({ action: 'assert_not_visible', oracleScope: 'delta', targetDescription: 'the row' })).toBe(false);
  });

  it('is off for survivor assertions — what did not change is not in the delta', () => {
    // run 11: every paired filter assertion ("a failed run row still shown")
    // died delta-scoped, because the surviving row never changed.
    expect(isDeltaScoped({ action: 'assert_visible', oracleScope: 'delta', targetDescription: 'a failed run row still shown in the list' })).toBe(false);
    expect(isDeltaScoped({ action: 'assert_visible', oracleScope: 'delta', targetDescription: 'the banner that remains after dismissal' })).toBe(false);
    expect(isDeltaScoped({ action: 'assert_visible', oracleScope: 'delta', targetDescription: 'the success message' })).toBe(true);
  });
});

describe('action sets', () => {
  it('treats hover as state-changing — it reveals captions and menus', () => {
    expect(STATE_CHANGING_ACTIONS.has('hover')).toBe(true);
  });

  it('throws the delta away on a deliberate page change', () => {
    expect(DELTA_CLEARING_ACTIONS.has('navigate')).toBe(true);
    expect(DELTA_CLEARING_ACTIONS.has('reload')).toBe(true);
  });
});

describe('summariseDelta', () => {
  it('says nothing changed when nothing did', () => {
    expect(summariseDelta([])).toBe('nothing changed');
  });

  it('reads like a sentence a person can check', () => {
    expect(summariseDelta([
      { marker: 'kz-d-0', role: 'div', name: 'x', text: "It's gone!", interactive: false },
    ])).toBe('div "It\'s gone!"');
  });
});

describe('page capture', () => {
  it('degrades to an empty baseline rather than throwing when the page is gone', async () => {
    const page = { evaluate: jest.fn().mockRejectedValue(new Error('Target closed')) };
    await expect(captureDeltaBaseline(page)).resolves.toEqual([]);
    await expect(captureDelta(page, ['a'])).resolves.toEqual([]);
  });
});

// Finding #17 — an action that left the control it targeted exactly as it found it
// did NOTHING, and must not be credited with whatever else the page did while it
// ran. Found by the stress site's vacuous-clear must-fail guard: "clear a box that
// is already empty, then assert the list is visible" passed in one round of three,
// because the page was rendering its own list at that moment and the delta
// (baseline before the render, diff after) credited the rows to the clear.
describe('no-op action detection (finding #17)', () => {
  it('can read back the effect of clear / check / uncheck / select — and deliberately not type', () => {
    expect([...NOOP_DETECTABLE_ACTIONS].sort()).toEqual(['check', 'clear', 'select', 'uncheck']);
    // Re-typing identical text still fires `input`, and apps react to it (re-run a
    // search, re-validate): it can be a no-op on the value and not on the page.
    expect(NOOP_DETECTABLE_ACTIONS.has('type')).toBe(false);
    // …and every one of them is an action the delta machinery already tracks.
    for (const a of NOOP_DETECTABLE_ACTIONS) expect(STATE_CHANGING_ACTIONS.has(a)).toBe(true);
  });

  describe('actionLeftControlUnchanged', () => {
    const empty = JSON.stringify({ v: '', c: null, s: null });
    const filled = JSON.stringify({ v: 'DHL', c: null, s: null });

    it('clear on an already-empty field is a no-op', () => {
      expect(actionLeftControlUnchanged('clear', empty, empty)).toBe(true);
    });

    it('clear on a field that HAD text is not — the delta is real evidence', () => {
      expect(actionLeftControlUnchanged('clear', filled, empty)).toBe(false);
    });

    it('check on an already-ticked box, and select of the already-selected option, are no-ops', () => {
      const ticked = JSON.stringify({ v: 'on', c: true, s: null });
      expect(actionLeftControlUnchanged('check', ticked, ticked)).toBe(true);
      const sel = JSON.stringify({ v: 'b', c: null, s: 1 });
      expect(actionLeftControlUnchanged('select', sel, sel)).toBe(true);
    });

    it('a state that really changed is not a no-op', () => {
      const off = JSON.stringify({ v: 'on', c: false, s: null });
      const on = JSON.stringify({ v: 'on', c: true, s: null });
      expect(actionLeftControlUnchanged('check', off, on)).toBe(false);
      expect(actionLeftControlUnchanged('uncheck', on, off)).toBe(false);
    });

    it('UNKNOWN is never "unchanged" — claiming a no-op wrongly would throw real evidence away', () => {
      expect(actionLeftControlUnchanged('clear', null, empty)).toBe(false);
      expect(actionLeftControlUnchanged('clear', empty, null)).toBe(false);
      expect(actionLeftControlUnchanged('clear', null, null)).toBe(false);
    });

    it('never fires for an action that cannot be read back — a click, or a type', () => {
      expect(actionLeftControlUnchanged('click', empty, empty)).toBe(false);
      expect(actionLeftControlUnchanged('type', empty, empty)).toBe(false);
    });
  });

  describe('readControlState', () => {
    it('reads the control through $eval on the resolved selector', async () => {
      const page = { $eval: jest.fn(async () => '{"v":"","c":null,"s":null}') };
      await expect(readControlState(page, 'role=textbox[name="Search deliveries"]')).resolves.toBe('{"v":"","c":null,"s":null}');
      expect(page.$eval).toHaveBeenCalledWith('role=textbox[name="Search deliveries"]', expect.any(Function));
    });

    it('the in-page reader reports value, checked and selectedIndex', async () => {
      // Run the actual reader against stubs of the three control shapes.
      let reader!: (el: Element) => string;
      const page = { $eval: jest.fn(async (_s: string, fn: (el: Element) => string) => { reader = fn; return 'x'; }) };
      await readControlState(page, '#c');
      const read = (el: unknown) => JSON.parse(reader(el as Element));
      expect(read({ value: 'DHL' })).toEqual({ v: 'DHL', c: null, s: null });           // text input
      expect(read({ value: 'on', checked: true })).toEqual({ v: 'on', c: true, s: null }); // checkbox
      expect(read({ value: 'b', selectedIndex: 2 })).toEqual({ v: 'b', c: null, s: 2 });   // <select>
    });

    it('answers null — not a guess — when the element is missing or the page cannot $eval', async () => {
      await expect(readControlState({ $eval: jest.fn().mockRejectedValue(new Error('no element')) }, '#gone')).resolves.toBeNull();
      await expect(readControlState({}, '#x')).resolves.toBeNull();
      await expect(readControlState(null, '#x')).resolves.toBeNull();
    });
  });
});

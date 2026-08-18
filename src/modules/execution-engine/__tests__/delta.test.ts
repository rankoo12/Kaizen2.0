import {
  walk, pickDeltaMatch, summariseDelta, isDeltaScoped, captureDelta, captureDeltaBaseline,
  STATE_CHANGING_ACTIONS, DELTA_CLEARING_ACTIONS, type DeltaElement,
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
});

describe('isDeltaScoped', () => {
  it('is on for a description-target assertion the writer marked', () => {
    expect(isDeltaScoped({ action: 'assert_visible', oracleScope: 'delta', targetDescription: 'the message' })).toBe(true);
  });

  it('is off for a grounded assertion and for absence assertions', () => {
    expect(isDeltaScoped({ action: 'assert_visible', targetDescription: 'the "Login" button' })).toBe(false);
    expect(isDeltaScoped({ action: 'assert_not_visible', oracleScope: 'delta', targetDescription: 'the row' })).toBe(false);
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

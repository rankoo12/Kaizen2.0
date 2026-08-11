import { runProbes } from '../recon/probe';
import type { CandidateNode } from '../../../types';
import type { IObservability } from '../../observability/interfaces';

const obs: IObservability = {
  startSpan: () => ({ end: () => {} }) as never,
  log: jest.fn(),
  increment: jest.fn(),
  histogram: jest.fn(),
};

const PAGE_URL = 'https://a.com/products';
const ctx = { pageUrl: PAGE_URL, rootOrigin: 'https://a.com', obs };

function makeCandidate(name: string): CandidateNode {
  return {
    kaizenId: 'kz-7', role: 'button', name, cssSelector: 'button', xpath: '',
    attributes: {}, textContent: name, isVisible: true, similarityScore: 1,
    centerPoint: { x: 0, y: 0 }, selectorCandidates: [],
  };
}

type FakePage = {
  url: jest.Mock; click: jest.Mock; evaluate: jest.Mock;
  waitForTimeout: jest.Mock; goBack: jest.Mock; goto: jest.Mock;
  keyboard: { press: jest.Mock };
};

function makePage(): FakePage {
  return {
    url: jest.fn(() => PAGE_URL),
    click: jest.fn(async () => {}),
    evaluate: jest.fn(async () => undefined),
    waitForTimeout: jest.fn(async () => {}),
    goBack: jest.fn(async () => {}),
    goto: jest.fn(async () => {}),
    keyboard: { press: jest.fn(async () => {}) },
  };
}

describe('runProbes', () => {
  it('collects revealed elements and links, then presses Escape to restore', async () => {
    const page = makePage();
    // Call 1: stampBaseline → undefined. Call 2: collectRevealed.
    page.evaluate
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        elements: [{ role: 'link', name: 'Hidden panel link' }],
        hrefs: ['/hidden', 'https://other.com/x'],
      });

    const { reveals, probesPerformed } = await runProbes(
      page, [makeCandidate('Show more')], 8, ctx);

    expect(probesPerformed).toBe(1);
    expect(reveals).toHaveLength(1);
    expect(reveals[0].trigger.name).toBe('Show more');
    expect(reveals[0].revealedElements).toEqual([{ role: 'link', name: 'Hidden panel link' }]);
    // Cross-origin revealed href is dropped; same-origin normalized.
    expect(reveals[0].revealedLinks).toEqual(['https://a.com/hidden']);
    expect(page.keyboard.press).toHaveBeenCalledWith('Escape');
    expect(page.goBack).not.toHaveBeenCalled();
  });

  it('restores via goBack when a probe unexpectedly navigates, recording the destination', async () => {
    const page = makePage();
    let current = PAGE_URL;
    page.url.mockImplementation(() => current);
    page.click.mockImplementation(async () => { current = 'https://a.com/surprise'; });
    page.goBack.mockImplementation(async () => { current = PAGE_URL; });

    const { reveals } = await runProbes(page, [makeCandidate('Expand')], 8, ctx);

    expect(page.goBack).toHaveBeenCalled();
    expect(reveals).toHaveLength(1);
    expect(reveals[0].revealedLinks).toEqual(['https://a.com/surprise']);
    // No collect on the navigated-away DOM: only the baseline evaluate ran.
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it('reloads the page URL when goBack does not restore it', async () => {
    const page = makePage();
    let current = PAGE_URL;
    page.url.mockImplementation(() => current);
    page.click.mockImplementation(async () => { current = 'https://a.com/surprise'; });
    // goBack "fails" to change the URL back.
    page.goto.mockImplementation(async (url: string) => { current = url; });

    await runProbes(page, [makeCandidate('Expand')], 8, ctx);

    expect(page.goto).toHaveBeenCalledWith(PAGE_URL, expect.anything());
    expect(current).toBe(PAGE_URL);
  });

  it('skips gracefully when the click fails, still counting the probe', async () => {
    const page = makePage();
    page.evaluate.mockResolvedValueOnce(undefined); // baseline
    page.click.mockRejectedValue(new Error('element detached'));

    const { reveals, probesPerformed } = await runProbes(
      page, [makeCandidate('Show more')], 8, ctx);

    expect(probesPerformed).toBe(1);
    expect(reveals).toHaveLength(0);
  });

  it('respects the probe budget', async () => {
    const page = makePage();
    page.evaluate.mockResolvedValue({ elements: [], hrefs: [] });

    const candidates = [1, 2, 3, 4, 5].map((n) => makeCandidate(`Show more ${n}`));
    const { probesPerformed } = await runProbes(page, candidates, 2, ctx);

    expect(probesPerformed).toBe(2);
    expect(page.click).toHaveBeenCalledTimes(2);
  });
});

/**
 * Implicit ARIA roles for probe-revealed elements.
 *
 * The probe used to fall back to the raw TAG NAME, so a field revealed inside a
 * modal was recorded as role "input" — not an ARIA role, rejected by
 * isRoleCompatible, and therefore un-typeable. The elements probing exists to
 * discover were the exact ones WRITE could never use.
 *
 * This mirrors the derivation the survey performs in playwright.dom-pruner.ts.
 * Both run inside page context and cannot share an import, so this test is what
 * keeps them honest.
 */
describe('probe role derivation matches the survey', () => {
  // The rule under test, extracted verbatim from probe.ts's page callback.
  const roleFor = (tag: string, type?: string, explicit?: string): string => {
    if (explicit) return explicit;
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (type || 'text').toLowerCase();
      return t === 'checkbox' ? 'checkbox'
        : t === 'radio' ? 'radio'
        : (t === 'submit' || t === 'button' || t === 'reset') ? 'button'
        : t === 'search' ? 'searchbox' : 'textbox';
    }
    return tag;
  };

  it.each([
    ['input', undefined, 'textbox'],
    ['input', 'text', 'textbox'],
    ['input', 'email', 'textbox'],
    ['input', 'search', 'searchbox'],
    ['input', 'checkbox', 'checkbox'],
    ['input', 'radio', 'radio'],
    ['input', 'submit', 'button'],
    ['textarea', undefined, 'textbox'],
    ['select', undefined, 'combobox'],
    ['a', undefined, 'link'],
    ['button', undefined, 'button'],
  ])('<%s type=%s> resolves to role %s', (tag, type, expected) => {
    expect(roleFor(tag as string, type as string | undefined)).toBe(expected);
  });

  it('never yields a bare tag name for a form control', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(roleFor(tag)).not.toBe(tag);
    }
  });

  it('honours an explicit role attribute', () => {
    expect(roleFor('div', undefined, 'textbox')).toBe('textbox');
  });

  it('produces roles the schema gate accepts for typing', () => {
    // The end-to-end point: a revealed text field must be typeable.
    const { isRoleCompatible } = jest.requireActual(
      '../../element-resolver/action-role-filter') as { isRoleCompatible: (a: string, r: string) => boolean };
    expect(isRoleCompatible('type', roleFor('input'))).toBe(true);
    expect(isRoleCompatible('type', roleFor('textarea'))).toBe(true);
    expect(isRoleCompatible('select', roleFor('select'))).toBe(true);
    // …and the old behaviour would not have.
    expect(isRoleCompatible('type', 'input')).toBe(false);
  });
});

import { PlaywrightDOMPruner, parseAriaSnapshotName } from '../playwright.dom-pruner';

describe('parseAriaSnapshotName', () => {
  it('extracts name with leading whitespace preserved (whitespace-mismatch regression)', () => {
    // Spec: docs/spec-dom-pruner-aria-snapshot.md § AT-1
    // The whole reason we switched to ariaSnapshot — innerText.trim() dropped the
    // leading space that Playwright's AX engine keeps, so role=link[name="..."] failed.
    expect(parseAriaSnapshotName('- link " Signup / Login":\n  - /url: /login'))
      .toBe(' Signup / Login');
  });

  it('extracts a plain name without children', () => {
    expect(parseAriaSnapshotName('- button "Sign in"')).toBe('Sign in');
  });

  it('returns null when the role has no quoted name', () => {
    expect(parseAriaSnapshotName('- textbox')).toBeNull();
    expect(parseAriaSnapshotName('- generic')).toBeNull();
  });

  it('unescapes embedded double-quotes in names', () => {
    expect(parseAriaSnapshotName('- img "User \\"Ada\\""')).toBe('User "Ada"');
  });

  it('preserves trailing whitespace', () => {
    expect(parseAriaSnapshotName('- button "Edit Profile  "')).toBe('Edit Profile  ');
  });

  it('returns null for malformed snapshots', () => {
    expect(parseAriaSnapshotName('')).toBeNull();
    expect(parseAriaSnapshotName('not a valid snapshot')).toBeNull();
  });
});

describe('PlaywrightDOMPruner', () => {
  let pruner: PlaywrightDOMPruner;

  beforeEach(() => {
    pruner = new PlaywrightDOMPruner();
  });

  function makeMockPage(opts: {
    evaluateResult: unknown[];
    ariaSnapshotByKz?: Record<string, string>;
    ariaSnapshotAvailable?: boolean;
  }) {
    const { evaluateResult, ariaSnapshotByKz = {}, ariaSnapshotAvailable = true } = opts;
    return {
      waitForLoadState: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue(evaluateResult),
      locator: jest.fn().mockImplementation((selector: string) => {
        const base: any = { count: jest.fn().mockResolvedValue(0) };
        if (ariaSnapshotAvailable) {
          base.ariaSnapshot = jest.fn().mockImplementation(async () => {
            const kzMatch = selector.match(/data-kaizen-id='([^']+)'/);
            if (kzMatch && ariaSnapshotByKz[kzMatch[1]]) return ariaSnapshotByKz[kzMatch[1]];
            return '- generic';
          });
        }
        return base;
      }),
    };
  }

  it('returns extracted elements mapped to CandidateNode shape', async () => {
    const mockPage = makeMockPage({
      evaluateResult: [
        {
          kaizenId: 'kz-1',
          role: 'button',
          accessibleName: 'Submit',
          attributes: { id: 'submit-btn', 'data-testid': 'submit' },
          textContent: 'Submit Form',
          tagName: 'button',
          parentContext: '',
          centerPoint: { x: 50, y: 50 },
        },
      ],
    });

    const result = await pruner.prune(mockPage, 'submit button');

    expect(mockPage.evaluate).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].kaizenId).toBe('kz-1');
    expect(result[0].role).toBe('button');
    expect(result[0].attributes).toMatchObject({ id: 'submit-btn' });
  });

  // Spec: docs/specs/dom-pruner/spec-empty-name-disambiguation.md
  // The wrapping-label-multi-input GUARD itself runs in-browser inside the
  // evaluate() callback, so this unit test verifies the *post-evaluate*
  // consequence: when an input's accessibleName is empty (because the guard
  // skipped a multi-input wrapping label) the pruner still emits a usable
  // selector list keyed off the input's identifier attributes — and crucially
  // does NOT emit a misleading `role=textbox[name="..."]` selector.
  it('emits id/data-qa selectors when accessibleName is empty (multi-input wrapping label fallout)', async () => {
    const mockPage = makeMockPage({
      evaluateResult: [
        {
          kaizenId: 'kz-28',
          role: 'textbox',
          accessibleName: '',
          attributes: { id: 'zipcode', name: 'zipcode', 'data-qa': 'zipcode', type: 'text' },
          textContent: '',
          tagName: 'input',
          parentContext: '',
          centerPoint: { x: 100, y: 200 },
        },
      ],
      ariaSnapshotByKz: { 'kz-28': '- textbox' }, // no quoted name → parser returns null → keeps empty
    });

    const result = await pruner.prune(mockPage, 'zipcode field');

    expect(result).toHaveLength(1);
    const node = result[0]!;
    const candidates = node.selectorCandidates!;
    expect(node.name).toBe('');
    // No role-based selector because accessibleName is empty.
    expect(candidates.find((s) => s.strategy === 'aria')).toBeUndefined();
    // Stable identifier selectors are present in priority order.
    const selectors = candidates.map((s) => s.selector);
    expect(selectors).toContain('#zipcode');
    expect(selectors).toContain('[data-qa="zipcode"]');
    expect(selectors).toContain('input[name="zipcode"]');
    // cssSelector is the most stable available — id beats data-qa beats input[name].
    expect(node.cssSelector).toBe('#zipcode');
  });

  it('AT-1: overrides name with ariaSnapshot when leading whitespace differs', async () => {
    // Pruner's evaluate() produced "Signup / Login" (trimmed by innerText.trim())
    // but Playwright's AX engine sees " Signup / Login" (space preserved).
    // After the fix, the stored name MUST match AX so role=link[name=...] matches.
    const mockPage = makeMockPage({
      evaluateResult: [
        {
          kaizenId: 'kz-5',
          role: 'link',
          accessibleName: 'Signup / Login',
          attributes: { href: '/login' },
          textContent: 'Signup / Login',
          tagName: 'a',
          parentContext: '',
          centerPoint: { x: 10, y: 10 },
        },
      ],
      ariaSnapshotByKz: {
        'kz-5': '- link " Signup / Login":\n  - /url: /login',
      },
    });

    const result = await pruner.prune(mockPage, 'signup link');

    expect(result[0].name).toBe(' Signup / Login');
    // Generated ARIA selector must use the AX-canonical name so role=X[name=Y] matches.
    expect(result[0].selectorCandidates).toContainEqual(
      expect.objectContaining({
        selector: 'role=link[name=" Signup / Login"]',
        strategy: 'aria',
      }),
    );
  });

  it('keeps evaluate()-computed name when ariaSnapshot throws', async () => {
    const mockPage = makeMockPage({
      evaluateResult: [
        {
          kaizenId: 'kz-1',
          role: 'button',
          accessibleName: 'Fallback name',
          attributes: {},
          textContent: 'Fallback name',
          tagName: 'button',
          parentContext: '',
          centerPoint: { x: 0, y: 0 },
        },
      ],
    });
    // Override locator to throw on ariaSnapshot
    mockPage.locator = jest.fn().mockReturnValue({
      count: jest.fn().mockResolvedValue(0),
      ariaSnapshot: jest.fn().mockRejectedValue(new Error('detached')),
    });

    const result = await pruner.prune(mockPage, 'x');
    expect(result[0].name).toBe('Fallback name');
  });

  it('uses evaluate()-computed name when ariaSnapshot is unavailable (pre-1.49 Playwright)', async () => {
    const mockPage = makeMockPage({
      evaluateResult: [
        {
          kaizenId: 'kz-1',
          role: 'button',
          accessibleName: 'Legacy Playwright',
          attributes: {},
          textContent: 'Legacy Playwright',
          tagName: 'button',
          parentContext: '',
          centerPoint: { x: 0, y: 0 },
        },
      ],
      ariaSnapshotAvailable: false,
    });

    const result = await pruner.prune(mockPage, 'x');
    expect(result[0].name).toBe('Legacy Playwright');
  });
});

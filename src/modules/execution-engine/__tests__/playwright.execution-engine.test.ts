import { PlaywrightExecutionEngine } from '../playwright.execution-engine';
import type { IObservability } from '../../observability/interfaces';
import type { StepAST, SelectorSet } from '../../../types';

describe('PlaywrightExecutionEngine', () => {
  let engine: PlaywrightExecutionEngine;
  let mockObservability: jest.Mocked<IObservability>;
  let mockPage: any;

  beforeEach(() => {
    mockObservability = {
      startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
      log: jest.fn(),
      increment: jest.fn(),
      histogram: jest.fn(),
    };

    mockPage = {
      goto: jest.fn(),
      goBack: jest.fn(),
      goForward: jest.fn(),
      reload: jest.fn(),
      click: jest.fn(),
      dblclick: jest.fn(),
      hover: jest.fn(),
      check: jest.fn(),
      uncheck: jest.fn(),
      fill: jest.fn(),
      selectOption: jest.fn(),
      setInputFiles: jest.fn(),
      isVisible: jest.fn(),
      getAttribute: jest.fn(),
      isEnabled: jest.fn(),
      isDisabled: jest.fn(),
      isChecked: jest.fn(),
      waitForSelector: jest.fn(),
      waitForTimeout: jest.fn(),
      title: jest.fn(),
      url: jest.fn(),
      locator: jest.fn(),
      evaluate: jest.fn(),
      $eval: jest.fn(),
      keyboard: { press: jest.fn() },
    };

    engine = new PlaywrightExecutionEngine(mockObservability);
  });

  // ─── navigate ────────────────────────────────────────────────────────────────

  describe('navigate', () => {
    const navigateStep: StepAST = {
      action: 'navigate',
      url: 'https://youtube.com',
      targetDescription: null,
      value: null,
      rawText: 'open youtube',
      contentHash: 'abc',
      targetHash: 'test-target-hash',
    };

    it('passes and calls page.goto with the url from the step', async () => {
      mockPage.goto.mockResolvedValueOnce(undefined);

      const result = await engine.executeStep(navigateStep, { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null }, mockPage);

      expect(result.status).toBe('passed');
      expect(mockPage.goto).toHaveBeenCalledWith('https://youtube.com', { timeout: 30_000 });
      expect(result.selectorUsed).toBeNull();
    });

    it('fails with NavigationError when page.goto throws', async () => {
      mockPage.goto.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));

      const result = await engine.executeStep(navigateStep, { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null }, mockPage);

      expect(result.status).toBe('failed');
      expect(result.errorType).toBe('NavigationError');
      expect(result.errorMessage).toContain('ERR_NAME_NOT_RESOLVED');
    });

    it('fails with MissingUrlError when step.url is null', async () => {
      const step = { ...navigateStep, url: null };
      const result = await engine.executeStep(step, { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null }, mockPage);

      expect(result.status).toBe('failed');
      expect(result.errorType).toBe('MissingUrlError');
      expect(mockPage.goto).not.toHaveBeenCalled();
    });
  });

  // ─── press_key ───────────────────────────────────────────────────────────────

  describe('press_key', () => {
    const pressKeyStep: StepAST = {
      action: 'press_key',
      value: 'Enter',
      targetDescription: null,
      url: null,
      rawText: 'press enter',
      contentHash: 'def',
      targetHash: 'test-target-hash',
    };

    it('passes and calls keyboard.press with the key value', async () => {
      mockPage.keyboard.press.mockResolvedValueOnce(undefined);

      const result = await engine.executeStep(pressKeyStep, { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null }, mockPage);

      expect(result.status).toBe('passed');
      expect(mockPage.keyboard.press).toHaveBeenCalledWith('Enter');
    });

    it('fails with MissingValueError when step.value is null', async () => {
      const step = { ...pressKeyStep, value: null };
      const result = await engine.executeStep(step, { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null }, mockPage);

      expect(result.status).toBe('failed');
      expect(result.errorType).toBe('MissingValueError');
      expect(mockPage.keyboard.press).not.toHaveBeenCalled();
    });
  });

  // ─── wait ────────────────────────────────────────────────────────────────────

  describe('wait', () => {
    const makeWait = (value: string | null): StepAST => ({
      action: 'wait',
      value,
      targetDescription: null,
      url: null,
      rawText: `wait ${value}`,
      contentHash: 'w1',
      targetHash: 'test-target-hash',
    });
    const noSel: SelectorSet = { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };

    it('waits a fixed duration for a numeric value without needing a selector', async () => {
      mockPage.waitForTimeout.mockResolvedValueOnce(undefined);
      const result = await engine.executeStep(makeWait('6000'), noSel, mockPage);
      expect(result.status).toBe('passed');
      expect(mockPage.waitForTimeout).toHaveBeenCalledWith(6000);
    });

    it('does NOT fail a numeric wait with NoSelectorsError (regression: wait ran before the guard)', async () => {
      mockPage.waitForTimeout.mockResolvedValueOnce(undefined);
      const result = await engine.executeStep(makeWait('500'), noSel, mockPage);
      expect(result.status).toBe('passed');
      expect(result.errorType).not.toBe('NoSelectorsError');
    });

    it('waits for the resolved selector when the value is non-numeric', async () => {
      mockPage.waitForSelector.mockResolvedValueOnce(undefined);
      const withSel: SelectorSet = { ...noSel, selectors: [{ selector: '#late', strategy: 'css', confidence: 0.9 }] };
      const result = await engine.executeStep(makeWait('for the spinner to appear'), withSel, mockPage);
      expect(result.status).toBe('passed');
      expect(mockPage.waitForSelector).toHaveBeenCalledWith('#late', { timeout: 10_000 });
    });

    it('fails with WaitError (not NoSelectorsError) when there is neither a duration nor a target', async () => {
      const result = await engine.executeStep(makeWait(null), noSel, mockPage);
      expect(result.status).toBe('failed');
      expect(result.errorType).toBe('WaitError');
    });
  });

  // ─── selector-based actions ──────────────────────────────────────────────────

  describe('click', () => {
    const clickStep: StepAST = {
      action: 'click',
      targetDescription: 'search button',
      value: null,
      url: null,
      rawText: 'click the search button',
      contentHash: 'ghi',
      targetHash: 'test-target-hash',
    };

    const twoSelectors: SelectorSet = {
      selectors: [
        { selector: "[data-kaizen-id='kz-1']", strategy: 'data-testid', confidence: 0.95 },
        { selector: '#search-btn', strategy: 'css', confidence: 0.7 },
      ],
      fromCache: false,
      cacheSource: null,
      resolutionSource: null,
      similarityScore: null,
    };

    it('passes on the first selector and does not try the second', async () => {
      mockPage.click.mockResolvedValueOnce(undefined);

      const result = await engine.executeStep(clickStep, twoSelectors, mockPage);

      expect(result.status).toBe('passed');
      expect(result.selectorUsed).toBe("[data-kaizen-id='kz-1']");
      expect(mockPage.click).toHaveBeenCalledTimes(1);
    });

    it('falls back to the second selector when the first fails', async () => {
      mockPage.click
        .mockRejectedValueOnce(new Error('TimeoutError'))  // first fails
        .mockResolvedValueOnce(undefined);                 // second succeeds

      const result = await engine.executeStep(clickStep, twoSelectors, mockPage);

      expect(result.status).toBe('passed');
      expect(result.selectorUsed).toBe('#search-btn');
      expect(mockPage.click).toHaveBeenCalledTimes(2);
      expect(mockObservability.increment).toHaveBeenCalledWith('engine.selector_failed', { strategy: 'data-testid' });
    });

    it('throws the last selector error when every selector fails', async () => {
      // executeStep re-throws the real Playwright error (not a generic fallback)
      // so the worker's failure classifier picks the right healing strategy.
      mockPage.click.mockRejectedValue(new Error('ElementNotFound'));

      await expect(engine.executeStep(clickStep, twoSelectors, mockPage)).rejects.toThrow('ElementNotFound');
      expect(mockPage.click).toHaveBeenCalledTimes(2);
    });

    it('returns NoSelectorsError immediately when selectorSet is empty', async () => {
      const emptySet: SelectorSet = { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };

      const result = await engine.executeStep(clickStep, emptySet, mockPage);

      expect(result.status).toBe('failed');
      expect(result.errorType).toBe('NoSelectorsError');
      expect(mockPage.click).not.toHaveBeenCalled();
    });
  });

  // ─── type ────────────────────────────────────────────────────────────────────

  describe('type', () => {
    it('passes and calls page.fill with the selector and value', async () => {
      const step: StepAST = {
        action: 'type',
        targetDescription: 'search box',
        value: 'cats',
        url: null,
        rawText: 'type cats in search box',
        contentHash: 'jkl',
      targetHash: 'test-target-hash',
      };
      const selectorSet: SelectorSet = {
        selectors: [{ selector: 'input[name="q"]', strategy: 'css', confidence: 0.9 }],
        fromCache: false,
        cacheSource: null,
      resolutionSource: null,
      similarityScore: null,
      };
      mockPage.fill.mockResolvedValueOnce(undefined);

      const result = await engine.executeStep(step, selectorSet, mockPage);

      expect(result.status).toBe('passed');
      expect(mockPage.fill).toHaveBeenCalledWith('input[name="q"]', 'cats', { timeout: 10_000 });
    });
  });

  // ─── assert_visible ──────────────────────────────────────────────────────────

  describe('assert_visible', () => {
    const assertStep: StepAST = {
      action: 'assert_visible',
      targetDescription: 'success message',
      value: null,
      url: null,
      rawText: 'check success message is visible',
      contentHash: 'mno',
      targetHash: 'test-target-hash',
    };
    const selectorSet: SelectorSet = {
      selectors: [{ selector: '.success-msg', strategy: 'css', confidence: 0.85 }],
      fromCache: false,
      cacheSource: null,
      resolutionSource: null,
      similarityScore: null,
    };

    it('passes when the element is visible', async () => {
      mockPage.isVisible.mockResolvedValueOnce(true);

      const result = await engine.executeStep(assertStep, selectorSet, mockPage);

      expect(result.status).toBe('passed');
    });

    it('throws when the element is not visible', async () => {
      mockPage.isVisible.mockResolvedValueOnce(false);

      await expect(engine.executeStep(assertStep, selectorSet, mockPage)).rejects.toThrow('Element not visible');
    });
  });

  // ─── assert_text ───────────────────────────────────────────────────────────────

  describe('assert_text', () => {
    const makeStep = (value: string | null): StepAST => ({
      action: 'assert_text',
      targetDescription: 'the header',
      value,
      url: null,
      rawText: 'verify the header contains the email',
      contentHash: 'at1',
      targetHash: 'test-target-hash',
    });
    const selectorSet: SelectorSet = {
      selectors: [{ selector: '.header', strategy: 'css', confidence: 0.85 }],
      fromCache: false,
      cacheSource: null,
      resolutionSource: null,
      similarityScore: null,
    };

    it('passes and reports the matched element selector', async () => {
      // assert_text searches the page body in-browser and returns the innermost
      // matching element's selector + text.
      mockPage.$eval.mockResolvedValueOnce({ selector: 'td.product', text: 'Music 2' });

      const result = await engine.executeStep(makeStep('Music 2'), selectorSet, mockPage);

      expect(result.status).toBe('passed');
      // The run details page should show the matched element, not "body".
      expect(result.selectorUsed).toBe('td.product');
      expect(mockObservability.increment).toHaveBeenCalledWith('engine.assert_text_matched');
    });

    it('retries while the value has not rendered yet, then passes', async () => {
      mockPage.$eval
        .mockResolvedValueOnce(null)                                  // not rendered yet
        .mockResolvedValueOnce({ selector: 'a.product-name', text: '3rd Album' });

      const result = await engine.executeStep(makeStep('3rd Album'), selectorSet, mockPage);

      expect(result.status).toBe('passed');
      expect(result.selectorUsed).toBe('a.product-name');
    });

    it('throws when the value is nowhere on the page', async () => {
      mockPage.$eval.mockResolvedValue(null); // never matches, all retries exhausted

      await expect(
        engine.executeStep(makeStep('test@example.com'), selectorSet, mockPage),
      ).rejects.toThrow(/not found anywhere on the page/);
    });

    it('throws when value is null', async () => {
      await expect(
        engine.executeStep(makeStep(null), selectorSet, mockPage),
      ).rejects.toThrow(/requires StepAST\.value/);
    });
  });

  // ─── new capabilities (QA parity) ─────────────────────────────────────────────

  const oneSelector = (sel = '#el'): SelectorSet => ({
    selectors: [{ selector: sel, strategy: 'css', confidence: 0.9 }],
    fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null,
  });
  const emptySet: SelectorSet = { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };
  const bodySet: SelectorSet = { selectors: [{ selector: 'body', strategy: 'css', confidence: 1 }], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };
  const mkStep = (action: StepAST['action'], over: Partial<StepAST> = {}): StepAST => ({
    action, targetDescription: 'the thing', value: null, url: null,
    rawText: `${action} the thing`, contentHash: 'c', targetHash: 't', ...over,
  });

  describe('interactions', () => {
    it('double_click calls page.dblclick', async () => {
      mockPage.dblclick.mockResolvedValueOnce(undefined);
      const r = await engine.executeStep(mkStep('double_click'), oneSelector('#row'), mockPage);
      expect(r.status).toBe('passed');
      expect(mockPage.dblclick).toHaveBeenCalledWith('#row', { timeout: 10_000 });
    });

    it('right_click calls page.click with button:right', async () => {
      mockPage.click.mockResolvedValueOnce(undefined);
      const r = await engine.executeStep(mkStep('right_click'), oneSelector('#menu'), mockPage);
      expect(r.status).toBe('passed');
      expect(mockPage.click).toHaveBeenCalledWith('#menu', { button: 'right', timeout: 10_000 });
    });

    it('hover calls page.hover', async () => {
      mockPage.hover.mockResolvedValueOnce(undefined);
      const r = await engine.executeStep(mkStep('hover'), oneSelector('#avatar'), mockPage);
      expect(r.status).toBe('passed');
      expect(mockPage.hover).toHaveBeenCalledWith('#avatar', { timeout: 10_000 });
    });

    it('clear empties the field via fill("")', async () => {
      mockPage.fill.mockResolvedValueOnce(undefined);
      const r = await engine.executeStep(mkStep('clear'), oneSelector('#search'), mockPage);
      expect(r.status).toBe('passed');
      expect(mockPage.fill).toHaveBeenCalledWith('#search', '', { timeout: 10_000 });
    });

    it('check calls page.check and uncheck calls page.uncheck', async () => {
      mockPage.check.mockResolvedValueOnce(undefined);
      mockPage.uncheck.mockResolvedValueOnce(undefined);
      expect((await engine.executeStep(mkStep('check'), oneSelector('#box'), mockPage)).status).toBe('passed');
      expect(mockPage.check).toHaveBeenCalledWith('#box', { timeout: 10_000 });
      expect((await engine.executeStep(mkStep('uncheck'), oneSelector('#box'), mockPage)).status).toBe('passed');
      expect(mockPage.uncheck).toHaveBeenCalledWith('#box', { timeout: 10_000 });
    });

    it('upload sets input files from value', async () => {
      mockPage.setInputFiles.mockResolvedValueOnce(undefined);
      const r = await engine.executeStep(mkStep('upload', { value: '/tmp/x.pdf' }), oneSelector('#file'), mockPage);
      expect(r.status).toBe('passed');
      expect(mockPage.setInputFiles).toHaveBeenCalledWith('#file', '/tmp/x.pdf', { timeout: 10_000 });
    });
  });

  describe('page navigation (no selector needed)', () => {
    it('go_back / go_forward / reload call the page methods', async () => {
      mockPage.goBack.mockResolvedValueOnce(undefined);
      mockPage.goForward.mockResolvedValueOnce(undefined);
      mockPage.reload.mockResolvedValueOnce(undefined);
      expect((await engine.executeStep(mkStep('go_back'), emptySet, mockPage)).status).toBe('passed');
      expect((await engine.executeStep(mkStep('go_forward'), emptySet, mockPage)).status).toBe('passed');
      expect((await engine.executeStep(mkStep('reload'), emptySet, mockPage)).status).toBe('passed');
      expect(mockPage.goBack).toHaveBeenCalled();
      expect(mockPage.goForward).toHaveBeenCalled();
      expect(mockPage.reload).toHaveBeenCalled();
    });
  });

  describe('assert_url / assert_title', () => {
    it('assert_url passes when the current URL contains the value, throws otherwise', async () => {
      mockPage.url.mockReturnValue('https://shop.example.com/checkout/step-1');
      expect((await engine.executeStep(mkStep('assert_url', { value: '/checkout', targetDescription: null }), emptySet, mockPage)).status).toBe('passed');
      mockPage.url.mockReturnValue('https://shop.example.com/home');
      await expect(engine.executeStep(mkStep('assert_url', { value: '/checkout', targetDescription: null }), emptySet, mockPage)).rejects.toThrow(/assert_url failed/);
    });

    it('assert_title passes/fails on page-title containment', async () => {
      mockPage.title.mockResolvedValue('My Store — Checkout');
      expect((await engine.executeStep(mkStep('assert_title', { value: 'Checkout', targetDescription: null }), emptySet, mockPage)).status).toBe('passed');
      mockPage.title.mockResolvedValue('My Store — Home');
      await expect(engine.executeStep(mkStep('assert_title', { value: 'Checkout', targetDescription: null }), emptySet, mockPage)).rejects.toThrow(/assert_title failed/);
    });
  });

  describe('state assertions', () => {
    it('assert_enabled passes when enabled, throws when not', async () => {
      mockPage.isEnabled.mockResolvedValueOnce(true);
      expect((await engine.executeStep(mkStep('assert_enabled'), oneSelector(), mockPage)).status).toBe('passed');
      mockPage.isEnabled.mockResolvedValueOnce(false);
      await expect(engine.executeStep(mkStep('assert_enabled'), oneSelector(), mockPage)).rejects.toThrow(/assert_enabled failed/);
    });
    it('assert_disabled passes when disabled, throws when not', async () => {
      mockPage.isDisabled.mockResolvedValueOnce(true);
      expect((await engine.executeStep(mkStep('assert_disabled'), oneSelector(), mockPage)).status).toBe('passed');
      mockPage.isDisabled.mockResolvedValueOnce(false);
      await expect(engine.executeStep(mkStep('assert_disabled'), oneSelector(), mockPage)).rejects.toThrow(/assert_disabled failed/);
    });
    it('assert_checked passes when checked, throws when not', async () => {
      mockPage.isChecked.mockResolvedValueOnce(true);
      expect((await engine.executeStep(mkStep('assert_checked'), oneSelector(), mockPage)).status).toBe('passed');
      mockPage.isChecked.mockResolvedValueOnce(false);
      await expect(engine.executeStep(mkStep('assert_checked'), oneSelector(), mockPage)).rejects.toThrow(/assert_checked failed/);
    });

    it('assert_attribute passes when the attribute contains the expected value, throws otherwise', async () => {
      mockPage.getAttribute.mockResolvedValueOnce('/login?ref=home');
      expect((await engine.executeStep(mkStep('assert_attribute', { value: 'href=/login' }), oneSelector('a'), mockPage)).status).toBe('passed');
      expect(mockPage.getAttribute).toHaveBeenCalledWith('a', 'href', { timeout: 10_000 });
      mockPage.getAttribute.mockResolvedValueOnce('/home');
      await expect(engine.executeStep(mkStep('assert_attribute', { value: 'href=/login' }), oneSelector('a'), mockPage)).rejects.toThrow(/assert_attribute failed/);
    });

    it('assert_attribute (no "=") asserts mere presence of the attribute', async () => {
      mockPage.getAttribute.mockResolvedValueOnce('');
      expect((await engine.executeStep(mkStep('assert_attribute', { value: 'disabled' }), oneSelector('button'), mockPage)).status).toBe('passed');
      mockPage.getAttribute.mockResolvedValueOnce(null);
      await expect(engine.executeStep(mkStep('assert_attribute', { value: 'disabled' }), oneSelector('button'), mockPage)).rejects.toThrow(/assert_attribute failed/);
    });

    // Regression (dogfood defect): "verify the input has value 42" read getAttribute('value'),
    // which returns the static default, not the live typed value → false failure. The `value`
    // attribute must be read from the live control via $eval, NOT getAttribute.
    it('assert_attribute value= reads the LIVE control value (not the static attribute)', async () => {
      mockPage.$eval.mockResolvedValueOnce('42');
      expect((await engine.executeStep(mkStep('assert_attribute', { value: 'value=42' }), oneSelector('input'), mockPage)).status).toBe('passed');
      expect(mockPage.$eval).toHaveBeenCalled();
      // The static-attribute path must NOT be used for `value`.
      expect(mockPage.getAttribute).not.toHaveBeenCalled();
      mockPage.$eval.mockResolvedValueOnce('7');
      await expect(engine.executeStep(mkStep('assert_attribute', { value: 'value=42' }), oneSelector('input'), mockPage)).rejects.toThrow(/assert_attribute failed/);
    });
  });

  describe('negative assertions', () => {
    it('assert_not_visible passes when no element is resolved (absent)', async () => {
      expect((await engine.executeStep(mkStep('assert_not_visible'), emptySet, mockPage)).status).toBe('passed');
    });
    it('assert_not_visible passes when the resolved element is hidden', async () => {
      mockPage.isVisible.mockResolvedValueOnce(false);
      expect((await engine.executeStep(mkStep('assert_not_visible'), oneSelector('#gone'), mockPage)).status).toBe('passed');
    });
    it('assert_not_visible throws when a genuinely-matching element is visible', async () => {
      mockPage.isVisible.mockResolvedValueOnce(true);
      mockPage.$eval.mockResolvedValueOnce('input text the thing placeholder'); // descriptor contains "thing"
      await expect(engine.executeStep(mkStep('assert_not_visible'), oneSelector('#here'), mockPage)).rejects.toThrow(/assert_not_visible failed/);
    });

    it('assert_not_visible passes when the visible resolved element does NOT match the target (resolver stretched)', async () => {
      mockPage.isVisible.mockResolvedValueOnce(true);
      mockPage.$eval.mockResolvedValueOnce('button enable'); // no "thing" → unrelated pick → target absent
      expect((await engine.executeStep(mkStep('assert_not_visible'), oneSelector('#enable'), mockPage)).status).toBe('passed');
    });
    it('assert_not_text passes when the text is absent', async () => {
      mockPage.$eval.mockResolvedValue(false);
      expect((await engine.executeStep(mkStep('assert_not_text', { value: 'Out of stock', targetDescription: null }), bodySet, mockPage)).status).toBe('passed');
    });
    it('assert_not_text throws when the text is present', async () => {
      mockPage.$eval.mockResolvedValueOnce(true);
      await expect(engine.executeStep(mkStep('assert_not_text', { value: 'Out of stock', targetDescription: null }), bodySet, mockPage)).rejects.toThrow(/assert_not_text failed/);
    });
  });

  describe('assert_count', () => {
    // The worker's counting primitive resolves a selector matching every visible
    // member of the counted group; the engine counts it and compares to the expected N.
    const countSel = oneSelector('[data-kzc-abc123]');
    const withCount = (n: number) => mockPage.locator.mockReturnValue({ count: async () => n });

    it('passes when the live count exactly matches (value "N")', async () => {
      withCount(5);
      const r = await engine.executeStep(mkStep('assert_count', { targetDescription: 'products', value: '5' }), countSel, mockPage);
      expect(r.status).toBe('passed');
      expect(r.selectorUsed).toBe('[data-kzc-abc123]');
      expect(mockPage.locator).toHaveBeenCalledWith('[data-kzc-abc123]');
    });

    it('FAILS loudly on an off-by-one exact count — the false-pass firewall', async () => {
      withCount(4);
      const r = await engine.executeStep(mkStep('assert_count', { targetDescription: 'products', value: '5' }), countSel, mockPage);
      expect(r.status).toBe('failed');
      expect(r.errorType).toBe('AssertCountFailed');
      expect(r.errorMessage).toContain('found 4');
      expect(r.errorMessage).toContain('5');
    });

    it('supports ">=" (at least): passes at/above the threshold, fails below', async () => {
      withCount(5);
      expect((await engine.executeStep(mkStep('assert_count', { targetDescription: 'results', value: '>=3' }), countSel, mockPage)).status).toBe('passed');
      withCount(2);
      const r = await engine.executeStep(mkStep('assert_count', { targetDescription: 'results', value: '>=3' }), countSel, mockPage);
      expect(r.status).toBe('failed');
      expect(r.errorType).toBe('AssertCountFailed');
    });

    it('supports "<=" (at most): passes at/below the threshold, fails above', async () => {
      withCount(4);
      expect((await engine.executeStep(mkStep('assert_count', { targetDescription: 'rows', value: '<=4' }), countSel, mockPage)).status).toBe('passed');
      withCount(5);
      expect((await engine.executeStep(mkStep('assert_count', { targetDescription: 'rows', value: '<=4' }), countSel, mockPage)).status).toBe('failed');
    });

    it('FAILS with CountTargetUnresolved when nothing countable was resolved (empty selectors)', async () => {
      const r = await engine.executeStep(mkStep('assert_count', { targetDescription: 'widgets', value: '3' }), emptySet, mockPage);
      expect(r.status).toBe('failed');
      expect(r.errorType).toBe('CountTargetUnresolved');
      // Never counts a phantom selector — refuses before touching the page.
      expect(mockPage.locator).not.toHaveBeenCalled();
    });

    it('FAILS with AssertCountBadValue when the expected count is not numeric', async () => {
      const r = await engine.executeStep(mkStep('assert_count', { targetDescription: 'products', value: 'lots' }), countSel, mockPage);
      expect(r.status).toBe('failed');
      expect(r.errorType).toBe('AssertCountBadValue');
      expect(mockPage.locator).not.toHaveBeenCalled();
    });
  });

  // ─── result shape ────────────────────────────────────────────────────────────

  it('always returns null screenshotKey and domSnapshotKey in Phase 1', async () => {
    mockPage.goto.mockResolvedValueOnce(undefined);
    const step: StepAST = {
      action: 'navigate',
      url: 'https://example.com',
      targetDescription: null,
      value: null,
      rawText: 'go to example',
      contentHash: 'pqr',
      targetHash: 'test-target-hash',
    };

    const result = await engine.executeStep(step, { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null }, mockPage);

    expect(result.screenshotKey).toBeNull();
    expect(result.domSnapshotKey).toBeNull();
  });
});

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
      click: jest.fn(),
      fill: jest.fn(),
      selectOption: jest.fn(),
      isVisible: jest.fn(),
      waitForSelector: jest.fn(),
      waitForTimeout: jest.fn(),
      evaluate: jest.fn(),
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

    it('returns AllSelectorsFailed when every selector throws', async () => {
      mockPage.click.mockRejectedValue(new Error('ElementNotFound'));

      const result = await engine.executeStep(clickStep, twoSelectors, mockPage);

      expect(result.status).toBe('failed');
      expect(result.errorType).toBe('AllSelectorsFailed');
      expect(result.selectorUsed).toBeNull();
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

    it('fails when the element is not visible', async () => {
      mockPage.isVisible.mockResolvedValueOnce(false);

      const result = await engine.executeStep(assertStep, selectorSet, mockPage);

      expect(result.status).toBe('failed');
      expect(result.errorType).toBe('AllSelectorsFailed');
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

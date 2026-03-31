import type { IExecutionEngine } from './interfaces';
import type { StepAST, SelectorSet, StepExecutionResult } from '../../types';
import type { IObservability } from '../observability/interfaces';

/**
 * Minimal surface of the Playwright Page API used by this module.
 * Typed as unknown at the interface boundary; cast internally here only.
 */
interface PlaywrightPageLike {
  goto(url: string, options?: { timeout?: number }): Promise<unknown>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  selectOption(selector: string, value: string, options?: { timeout?: number }): Promise<unknown>;
  isVisible(selector: string): Promise<boolean>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: (arg: string) => T, arg: string): Promise<T>;
  keyboard: {
    press(key: string): Promise<void>;
  };
}

const ACTION_TIMEOUT_MS = 10_000;
const NAVIGATE_TIMEOUT_MS = 30_000;

export class PlaywrightExecutionEngine implements IExecutionEngine {
  constructor(private readonly observability: IObservability) {}

  async executeStep(
    step: StepAST,
    selectorSet: SelectorSet,
    page: unknown,
  ): Promise<StepExecutionResult> {
    const span = this.observability.startSpan('engine.executeStep', { action: step.action });
    const start = Date.now();

    try {
      const pw = page as PlaywrightPageLike;

      // navigate and press_key operate on the page globally — no selector needed
      if (step.action === 'navigate') {
        return await this.executeNavigate(step, pw, start);
      }

      if (step.action === 'press_key') {
        return await this.executePressKey(step, pw, start);
      }

      // All remaining actions require at least one selector
      if (selectorSet.selectors.length === 0) {
        this.observability.increment('engine.step_failed', { action: step.action, reason: 'no_selectors' });
        return this.failResult(
          start,
          'NoSelectorsError',
          `No selectors provided for action "${step.action}" on "${step.targetDescription}".`,
        );
      }

      // Try each selector in confidence order (already sorted by LLMElementResolver)
      for (const entry of selectorSet.selectors) {
        try {
          await this.dispatchAction(step, entry.selector, pw);

          this.observability.increment('engine.step_passed', {
            action: step.action,
            strategy: entry.strategy,
          });

          return {
            status: 'passed',
            selectorUsed: entry.selector,
            errorType: null,
            errorMessage: null,
            durationMs: Date.now() - start,
            screenshotKey: null,   // Phase 3: captured and uploaded to S3
            domSnapshotKey: null,  // Phase 3: AX tree snapshot persisted
          };
        } catch {
          // This selector failed — try the next one
          this.observability.increment('engine.selector_failed', { strategy: entry.strategy });
        }
      }

      // All selectors exhausted
      this.observability.increment('engine.step_failed', { action: step.action, reason: 'all_selectors_failed' });
      return this.failResult(
        start,
        'AllSelectorsFailed',
        `All ${selectorSet.selectors.length} selector(s) failed for action "${step.action}" on "${step.targetDescription}".`,
      );
    } finally {
      span.end();
    }
  }

  private async executeNavigate(
    step: StepAST,
    page: PlaywrightPageLike,
    start: number,
  ): Promise<StepExecutionResult> {
    if (!step.url) {
      return this.failResult(start, 'MissingUrlError', 'navigate action requires StepAST.url but it is null.');
    }

    try {
      await page.goto(step.url, { timeout: NAVIGATE_TIMEOUT_MS });
      this.observability.increment('engine.step_passed', { action: 'navigate' });
      return this.passResult(start, null);
    } catch (e: any) {
      this.observability.increment('engine.step_failed', { action: 'navigate' });
      return this.failResult(start, 'NavigationError', e.message);
    }
  }

  private async executePressKey(
    step: StepAST,
    page: PlaywrightPageLike,
    start: number,
  ): Promise<StepExecutionResult> {
    if (!step.value) {
      return this.failResult(start, 'MissingValueError', 'press_key action requires StepAST.value but it is null.');
    }

    try {
      await page.keyboard.press(step.value);
      this.observability.increment('engine.step_passed', { action: 'press_key' });
      return this.passResult(start, null);
    } catch (e: any) {
      this.observability.increment('engine.step_failed', { action: 'press_key' });
      return this.failResult(start, 'KeyPressError', e.message);
    }
  }

  /**
   * Dispatches a selector-based action against the live page.
   * Throws on failure so the caller can try the next selector.
   */
  private async dispatchAction(
    step: StepAST,
    selector: string,
    page: PlaywrightPageLike,
  ): Promise<void> {
    switch (step.action) {
      case 'click':
        await page.click(selector, { timeout: ACTION_TIMEOUT_MS });
        break;

      case 'type':
        if (!step.value) throw new Error('type action requires StepAST.value');
        await page.fill(selector, step.value, { timeout: ACTION_TIMEOUT_MS });
        break;

      case 'select':
        if (!step.value) throw new Error('select action requires StepAST.value');
        await page.selectOption(selector, step.value, { timeout: ACTION_TIMEOUT_MS });
        break;

      case 'assert_visible': {
        const visible = await page.isVisible(selector);
        if (!visible) throw new Error(`Element not visible: ${selector}`);
        break;
      }

      case 'wait':
        // Numeric value → fixed timeout; anything else → wait for selector to appear
        if (step.value && /^\d+$/.test(step.value)) {
          await page.waitForTimeout(parseInt(step.value, 10));
        } else {
          await page.waitForSelector(selector, { timeout: ACTION_TIMEOUT_MS });
        }
        break;

      case 'scroll':
        await page.evaluate(
          (sel) => document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
          selector,
        );
        break;

      default:
        throw new Error(`Unsupported action: ${(step as StepAST).action}`);
    }
  }

  private passResult(start: number, selectorUsed: string | null): StepExecutionResult {
    return {
      status: 'passed',
      selectorUsed,
      errorType: null,
      errorMessage: null,
      durationMs: Date.now() - start,
      screenshotKey: null,
      domSnapshotKey: null,
    };
  }

  private failResult(start: number, errorType: string, errorMessage: string): StepExecutionResult {
    return {
      status: 'failed',
      selectorUsed: null,
      errorType,
      errorMessage,
      durationMs: Date.now() - start,
      screenshotKey: null,
      domSnapshotKey: null,
    };
  }
}

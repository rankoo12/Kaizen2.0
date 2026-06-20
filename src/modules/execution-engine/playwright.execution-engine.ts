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
  check(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  selectOption(selector: string, value: string | { label: string } | { value: string }, options?: { timeout?: number }): Promise<unknown>;
  isVisible(selector: string): Promise<boolean>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: (arg: string) => T, arg: string): Promise<T>;
  /** Playwright-aware $eval: selector engine understands ARIA, CSS, XPath, data-* */
  $eval<T>(selector: string, fn: (el: Element) => T): Promise<T>;
  /** 3-arg form: passes `arg` into the browser-side function */
  $eval<T, A>(selector: string, fn: (el: Element, arg: A) => T, arg: A): Promise<T>;
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

      // Determine if the target element is a checkable input (radio / checkbox).
      // page.check() is purpose-built for these: it enforces the checked state and
      // throws if the element is not checkable — unlike page.click() which may fire
      // without toggling the state (especially for custom ARIA implementations).
      const CHECKABLE_ROLES = new Set(['radio', 'checkbox']);
      const DROPDOWN_ROLES = new Set(['combobox', 'listbox']);
      const pickedRole = selectorSet.llmPickedKaizenId && selectorSet.candidates
        ? selectorSet.candidates.find((c) => c.kaizenId === selectorSet.llmPickedKaizenId)?.role
        : null;
      const useCheck = step.action === 'click' && pickedRole != null && CHECKABLE_ROLES.has(pickedRole);

      // FIX B (issue_5): Post-pick action correction.
      // If the compiled action is "select" but the LLM-picked element is not
      // an actual dropdown (e.g. a radio/button/option/gridcell), calling
      // selectOption() would throw. Correct to "click" so the dispatch succeeds.
      // This is a safety net for cases where compileStep mislabels the action;
      // the primary fix is clearing the compiled_ast_cache on verdict=failed.
      const effectiveStep: typeof step =
        step.action === 'select' && pickedRole != null && !DROPDOWN_ROLES.has(pickedRole)
          ? (() => {
              this.observability.increment('engine.action_corrected', { from: 'select', to: 'click', pickedRole: pickedRole ?? 'unknown' });
              return { ...step, action: 'click' as const };
            })()
          : step;

      // Try each selector in confidence order (already sorted by LLMElementResolver)
      let lastError: Error | null = null;
      for (const entry of selectorSet.selectors) {
        try {
          const matched = await this.dispatchAction(effectiveStep, entry.selector, pw, useCheck);

          this.observability.increment('engine.step_passed', {
            action: step.action,
            strategy: entry.strategy,
          });

          return {
            status: 'passed',
            // For assertions, report the element that actually contained the
            // value (matched), not the broad query selector ("body").
            selectorUsed: matched ?? entry.selector,
            errorType: null,
            errorMessage: null,
            durationMs: Date.now() - start,
            screenshotKey: null,   // Phase 3: captured and uploaded to S3
            domSnapshotKey: null,  // Phase 3: AX tree snapshot persisted
          };
        } catch (e: any) {
          // This selector failed — try the next one, but preserve the real error
          lastError = e instanceof Error ? e : new Error(String(e));
          this.observability.increment('engine.selector_failed', { strategy: entry.strategy });
        }
      }

      // All selectors exhausted — throw the real Playwright error so the worker's
      // failure classifier receives the actual error message (e.g. "timeout exceeded")
      // rather than a generic fallback. This is critical for correct healing strategy selection.
      if (lastError) throw lastError;

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
      this.observability.log('error', 'engine.press_key_failed', { key: step.value, error: e.message });
      this.observability.increment('engine.step_failed', { action: 'press_key' });
      return this.failResult(start, 'KeyPressError', e.message);
    }
  }

  /**
   * Dispatches a selector-based action against the live page.
   * Throws on failure so the caller can try the next selector.
   */
  /**
   * Executes the step's action against `selector`. Returns a more specific
   * selector string for assertions (the element that actually contained the
   * asserted text) so the run details page shows the matched element rather than
   * the broad query selector; returns void for all other actions.
   */
  private async dispatchAction(
    step: StepAST,
    selector: string,
    page: PlaywrightPageLike,
    useCheck = false,
  ): Promise<string | void> {
    switch (step.action) {
      // click_random resolves to a concrete element in the worker (a random
      // candidate is chosen and handed to the engine as a single selector);
      // dispatch is then identical to a plain click.
      // Spec: docs/specs/workers/spec-engine-capabilities-assert-random-capture.md §2.3
      case 'click_random':
      case 'click': {
        // Prefer the caller's hint (from candidates metadata), but also inspect the
        // live DOM in case the step came from cache where llmPickedKaizenId is absent.
        // IMPORTANT: must use page.$eval, not page.evaluate + document.querySelector —
        // $eval uses Playwright's full selector engine and understands ARIA selectors
        // (e.g. role=radio[name="Mr."]) which document.querySelector cannot parse.
        let shouldCheck = useCheck;
        if (!shouldCheck) {
          try {
            const inputType = await page.$eval(
              selector,
              (el) => (el as HTMLInputElement).type?.toLowerCase() ?? null,
            );
            shouldCheck = inputType === 'radio' || inputType === 'checkbox';
          } catch { /* element not found or selector invalid — fall through to click */ }
        }
        if (shouldCheck) {
          await page.check(selector, { timeout: ACTION_TIMEOUT_MS });
        } else {
          await page.click(selector, { timeout: ACTION_TIMEOUT_MS });
        }
        break;
      }

      case 'type':
        if (!step.value) throw new Error('type action requires StepAST.value');
        await page.fill(selector, step.value, { timeout: ACTION_TIMEOUT_MS });
        break;

      case 'select': {
        if (!step.value) throw new Error('select action requires StepAST.value');
        try {
          // Fast path: exact match on value attribute or label text (Playwright's default).
          await page.selectOption(selector, step.value, { timeout: ACTION_TIMEOUT_MS });
        } catch (exactErr) {
          // Playwright's selectOption is case-sensitive. "israel" won't match
          // <option value="Israel"> even though they're the same string modulo case.
          // Walk the element's options and select the first case-insensitive match
          // on either the value attribute or the visible label text.
          const lower = step.value.toLowerCase();
          const matchedValue = await page.$eval(
            selector,
            (el: Element, search: string) => {
              const select = el as HTMLSelectElement;
              for (const opt of Array.from(select.options)) {
                if (opt.value.toLowerCase() === search || opt.text.toLowerCase() === search) {
                  return opt.value;
                }
              }
              return null;
            },
            lower,
          );
          if (matchedValue !== null) {
            this.observability.increment('engine.select_case_insensitive_fallback');
            await page.selectOption(selector, matchedValue, { timeout: ACTION_TIMEOUT_MS });
          } else {
            throw exactErr; // no match at all — surface the original error
          }
        }
        break;
      }

      case 'assert_visible': {
        const visible = await page.isVisible(selector);
        if (!visible) throw new Error(`Element not visible: ${selector}`);
        break;
      }

      case 'assert_text': {
        // Content assertion: the expected value must appear in the resolved
        // element's text. Containment (not equality) because real UI containers
        // wrap the value in surrounding chrome (labels, prices, quantities).
        // Comparison is case-insensitive and whitespace-normalised.
        //
        // WHOLE-PAGE FALLBACK: "the cart"/"the header" etc. often resolve to a
        // link or wrapper that doesn't literally contain the expected text even
        // when the value IS on the page (e.g. "verify the cart contains Music 2"
        // resolving to the "Shopping cart (1)" link). The human intent is "X is
        // shown on this page", so if the resolved element misses, we re-check the
        // whole document body before failing.
        // Spec: docs/specs/workers/spec-engine-capabilities-assert-random-capture.md §1.2
        if (step.value == null) throw new Error('assert_text action requires StepAST.value');
        const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        const needle = norm(step.value);

        // Locate the INNERMOST element whose text contains the value, anywhere on
        // the page (retried for render races after a navigation). Returning the
        // specific matched element — rather than the broad "body" query — lets the
        // run details page show exactly where the value was found (e.g. the cart
        // row link), instead of an opaque "body".
        // Spec: docs/specs/workers/spec-engine-capabilities-assert-random-capture.md §1.2
        let match: { selector: string; text: string } | null = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          match = await page.$eval(
            'body',
            (root: Element, search: string) => {
              const tidy = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
              const lc = (s: string) => tidy(s).toLowerCase();
              const all = Array.from(root.querySelectorAll<Element>('*'));
              // Innermost = the deepest element that still contains the needle.
              for (let i = all.length - 1; i >= 0; i--) {
                const el = all[i];
                if (lc(el.textContent ?? '').includes(search)) {
                  // Build a readable, unique-ish selector for the matched element.
                  let sel = el.tagName.toLowerCase();
                  if (el.id) sel = `#${el.id}`;
                  else {
                    const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean)[0];
                    if (cls) sel += `.${cls}`;
                  }
                  return { selector: sel, text: tidy(el.textContent).slice(0, 200) };
                }
              }
              return null;
            },
            needle,
          ).catch(() => null);
          if (match) break;
          await page.waitForTimeout(400);
        }

        this.observability.log('info', 'engine.assert_text_check', {
          rawValue: step.value,
          needle,
          found: match?.selector ?? null,
        });

        if (match) {
          this.observability.increment('engine.assert_text_matched');
          return match.selector; // surfaced as selectorUsed on the run details page
        }

        throw new Error(
          `assert_text failed: "${step.value}" not found anywhere on the page.`,
        );
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

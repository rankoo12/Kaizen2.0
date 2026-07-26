import type { IExecutionEngine } from './interfaces';
import type { StepAST, SelectorSet, StepExecutionResult } from '../../types';
import type { IObservability } from '../observability/interfaces';

/**
 * Minimal surface of the Playwright Page API used by this module.
 * Typed as unknown at the interface boundary; cast internally here only.
 */
interface PlaywrightPageLike {
  goto(url: string, options?: { timeout?: number }): Promise<unknown>;
  goBack(options?: { timeout?: number }): Promise<unknown>;
  goForward(options?: { timeout?: number }): Promise<unknown>;
  reload(options?: { timeout?: number }): Promise<unknown>;
  click(selector: string, options?: { timeout?: number; button?: 'left' | 'right' | 'middle' }): Promise<void>;
  dblclick(selector: string, options?: { timeout?: number }): Promise<void>;
  hover(selector: string, options?: { timeout?: number }): Promise<void>;
  check(selector: string, options?: { timeout?: number }): Promise<void>;
  uncheck(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  selectOption(selector: string, value: string | { label: string } | { value: string }, options?: { timeout?: number }): Promise<unknown>;
  setInputFiles(selector: string, files: string | string[], options?: { timeout?: number }): Promise<void>;
  isVisible(selector: string): Promise<boolean>;
  getAttribute(selector: string, name: string, options?: { timeout?: number }): Promise<string | null>;
  isEnabled(selector: string, options?: { timeout?: number }): Promise<boolean>;
  isDisabled(selector: string, options?: { timeout?: number }): Promise<boolean>;
  isChecked(selector: string, options?: { timeout?: number }): Promise<boolean>;
  waitForSelector(selector: string, options?: { timeout?: number; state?: 'attached' | 'detached' | 'visible' | 'hidden' }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  title(): Promise<string>;
  url(): string;
  locator(selector: string): { count(): Promise<number> };
  /** All frames on the page (flat, includes the main frame and nested iframes). */
  frames?(): Array<{ $eval: PlaywrightPageLike['$eval'] }>;
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

      // wait acts on the clock/page: a numeric duration needs no selector, so it
      // must be handled before the no-selectors guard below (otherwise every
      // "wait N seconds" step fails with NoSelectorsError and stop-on-fail kills
      // the rest of the run).
      if (step.action === 'wait') {
        return await this.executeWait(step, selectorSet, pw, start);
      }

      // Page-level navigation and page-global assertions act on the page/URL/title,
      // not a specific element, so they run before the no-selectors guard.
      if (step.action === 'go_back' || step.action === 'go_forward' || step.action === 'reload') {
        return await this.executePageNav(step, pw, start);
      }
      if (step.action === 'assert_url') {
        return await this.executeAssertUrl(step, pw, start);
      }
      if (step.action === 'assert_title') {
        return await this.executeAssertTitle(step, pw, start);
      }

      // assert_not_visible passes when the element is ABSENT, so an empty
      // selectorSet (resolver found nothing) is a PASS, not a NoSelectorsError.
      if (step.action === 'assert_not_visible') {
        return await this.executeAssertNotVisible(step, selectorSet, pw, start);
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
  private async executeWait(
    step: StepAST,
    selectorSet: SelectorSet,
    page: PlaywrightPageLike,
    start: number,
  ): Promise<StepExecutionResult> {
    try {
      if (step.value && /^\d+$/.test(step.value)) {
        // Numeric value is a fixed duration in milliseconds (compiler-normalised).
        await page.waitForTimeout(parseInt(step.value, 10));
      } else if (selectorSet.selectors.length > 0) {
        // Non-numeric wait ("wait for X to appear") → wait for the resolved target.
        await page.waitForSelector(selectorSet.selectors[0].selector, { timeout: ACTION_TIMEOUT_MS });
      } else {
        return this.failResult(
          start, 'WaitError',
          `wait requires a numeric duration or a target element; got value="${step.value ?? ''}".`,
        );
      }
      this.observability.increment('engine.step_passed', { action: 'wait' });
      return this.passResult(start, null);
    } catch (e: any) {
      this.observability.increment('engine.step_failed', { action: 'wait' });
      return this.failResult(start, 'WaitError', e.message);
    }
  }

  private async executeAssertNotVisible(
    step: StepAST,
    selectorSet: SelectorSet,
    page: PlaywrightPageLike,
    start: number,
  ): Promise<StepExecutionResult> {
    // No element resolved → it is not present → the "not visible" assertion holds.
    if (selectorSet.selectors.length === 0) {
      this.observability.increment('engine.assert_not_visible_absent');
      return this.passResult(start, null);
    }
    // The resolver always returns a best-effort pick, so when the real target is
    // gone it may "stretch" to an unrelated but visible element (e.g. picking an
    // "Enable" button when the described checkbox was removed). Distinguish a
    // GENUINE match from a stretch by requiring the visible element's own
    // role/type/name/text to overlap a distinctive word from the target — else
    // the described target is absent and the assertion holds.
    const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'be', 'not', 'no', 'on', 'of', 'in', 'to', 'and', 'that', 'this', 'it', 'should', 'still', 'gone', 'removed', 'disappear', 'visible', 'shown', 'present']);
    const targetWords = (step.targetDescription ?? '')
      .toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

    for (const entry of selectorSet.selectors) {
      const visible = await page.isVisible(entry.selector).catch(() => false);
      if (!visible) continue;
      const descriptor = (await page.$eval(entry.selector, (el: Element) => {
        const e = el as HTMLElement;
        return [
          e.tagName, e.getAttribute('type') ?? '', e.getAttribute('role') ?? '',
          e.getAttribute('aria-label') ?? '', e.getAttribute('name') ?? '',
          e.getAttribute('placeholder') ?? '', e.textContent ?? '',
        ].join(' ').toLowerCase();
      }).catch(() => '')) || '';
      const genuineMatch = targetWords.length === 0 || targetWords.some((w) => descriptor.includes(w));
      if (genuineMatch) {
        throw new Error(`assert_not_visible failed: element "${step.targetDescription}" is visible (${entry.selector}).`);
      }
      // Resolver stretched to an unrelated visible element → real target is absent.
      this.observability.increment('engine.assert_not_visible_stretched_pick');
    }
    this.observability.increment('engine.assert_not_visible_hidden');
    return this.passResult(start, null);
  }

  private async executePageNav(
    step: StepAST,
    page: PlaywrightPageLike,
    start: number,
  ): Promise<StepExecutionResult> {
    try {
      if (step.action === 'go_back') await page.goBack({ timeout: NAVIGATE_TIMEOUT_MS });
      else if (step.action === 'go_forward') await page.goForward({ timeout: NAVIGATE_TIMEOUT_MS });
      else await page.reload({ timeout: NAVIGATE_TIMEOUT_MS });
      this.observability.increment('engine.step_passed', { action: step.action });
      return this.passResult(start, null);
    } catch (e: any) {
      this.observability.increment('engine.step_failed', { action: step.action });
      return this.failResult(start, 'NavigationError', e.message);
    }
  }

  private async executeAssertUrl(
    step: StepAST,
    page: PlaywrightPageLike,
    start: number,
  ): Promise<StepExecutionResult> {
    if (step.value == null) return this.failResult(start, 'MissingValueError', 'assert_url requires an expected URL fragment in value.');
    const current = page.url();
    if (current.toLowerCase().includes(step.value.trim().toLowerCase())) {
      this.observability.increment('engine.assert_url_matched');
      return this.passResult(start, current);
    }
    throw new Error(`assert_url failed: current URL "${current}" does not contain "${step.value}".`);
  }

  private async executeAssertTitle(
    step: StepAST,
    page: PlaywrightPageLike,
    start: number,
  ): Promise<StepExecutionResult> {
    if (step.value == null) return this.failResult(start, 'MissingValueError', 'assert_title requires expected title text in value.');
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const title = await page.title();
    if (norm(title).includes(norm(step.value))) {
      this.observability.increment('engine.assert_title_matched');
      return this.passResult(start, title);
    }
    throw new Error(`assert_title failed: page title "${title}" does not contain "${step.value}".`);
  }

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

      case 'double_click':
        await page.dblclick(selector, { timeout: ACTION_TIMEOUT_MS });
        break;

      case 'right_click':
        await page.click(selector, { button: 'right', timeout: ACTION_TIMEOUT_MS });
        break;

      case 'hover':
        await page.hover(selector, { timeout: ACTION_TIMEOUT_MS });
        break;

      case 'check':
        // Idempotent: no-op if already checked. page.check throws if not checkable.
        await page.check(selector, { timeout: ACTION_TIMEOUT_MS });
        break;

      case 'uncheck':
        await page.uncheck(selector, { timeout: ACTION_TIMEOUT_MS });
        break;

      case 'type':
        if (!step.value) throw new Error('type action requires StepAST.value');
        await page.fill(selector, step.value, { timeout: ACTION_TIMEOUT_MS });
        break;

      case 'clear':
        // Empty the field — page.fill('') clears any existing value.
        await page.fill(selector, '', { timeout: ACTION_TIMEOUT_MS });
        break;

      case 'upload':
        if (!step.value) throw new Error('upload action requires a file path in StepAST.value');
        await page.setInputFiles(selector, step.value, { timeout: ACTION_TIMEOUT_MS });
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

      case 'assert_enabled': {
        const enabled = await page.isEnabled(selector, { timeout: ACTION_TIMEOUT_MS }).catch(() => false);
        if (!enabled) throw new Error(`assert_enabled failed: element is not enabled: ${selector}`);
        break;
      }

      case 'assert_disabled': {
        const disabled = await page.isDisabled(selector, { timeout: ACTION_TIMEOUT_MS }).catch(() => false);
        if (!disabled) throw new Error(`assert_disabled failed: element is not disabled: ${selector}`);
        break;
      }

      case 'assert_checked': {
        const checked = await page.isChecked(selector, { timeout: ACTION_TIMEOUT_MS }).catch(() => false);
        if (!checked) throw new Error(`assert_checked failed: element is not checked: ${selector}`);
        break;
      }

      case 'assert_attribute': {
        // value is "attribute=expectedValue" (e.g. "href=/login", "class=active").
        // With no "=", assert the attribute is merely present.
        if (!step.value) throw new Error('assert_attribute requires "attribute=expected" in StepAST.value');
        const eq = step.value.indexOf('=');
        const attr = (eq >= 0 ? step.value.slice(0, eq) : step.value).trim();
        const expected = (eq >= 0 ? step.value.slice(eq + 1) : '').trim();
        // The `value` *attribute* on a form control reflects only its initial
        // default — typing updates the live IDL property, not the attribute. A user
        // asserting "the field has value 42" means the current value, so read the
        // live property for form controls (getAttribute would report the stale/empty
        // default and falsely fail). Other attributes read normally.
        const actual = attr.toLowerCase() === 'value'
          ? await page.$eval(selector, (el: Element) => {
              const tag = el.tagName.toLowerCase();
              if (tag === 'input' || tag === 'textarea') return (el as HTMLInputElement).value;
              if (tag === 'select') {
                const s = el as HTMLSelectElement;
                return (s.options[s.selectedIndex] && s.options[s.selectedIndex].value) ?? s.value;
              }
              return el.getAttribute('value');
            }).catch(() => null)
          : await page.getAttribute(selector, attr, { timeout: ACTION_TIMEOUT_MS }).catch(() => null);
        const ok = expected === ''
          ? actual !== null
          : (actual ?? '').toLowerCase().includes(expected.toLowerCase());
        if (!ok) {
          throw new Error(`assert_attribute failed: ${attr}="${actual ?? '(absent)'}" does not ${expected === '' ? 'exist' : `contain "${expected}"`} on ${selector}.`);
        }
        break;
      }

      case 'assert_not_text': {
        // Negative assertion: confirm the value is ABSENT from the page — and stays
        // absent across a few checks so a slow removal isn't a false pass.
        if (step.value == null) throw new Error('assert_not_text action requires StepAST.value');
        const needleN = step.value.replace(/\s+/g, ' ').trim().toLowerCase();
        const presentAnywhere = async (): Promise<boolean> => {
          const frames = typeof page.frames === 'function' ? page.frames() : [];
          const targets: Array<{ $eval: PlaywrightPageLike['$eval'] }> = frames.length ? frames : [page];
          for (const target of targets) {
            const present = await target.$eval(
              'body',
              // Match VISIBLE text only. `textContent` includes <script>/<style>
              // source and display:none content, so it reports words the user never
              // sees (e.g. "Delete" inside an onclick handler's deleteElement() code)
              // — a false "present" that turns a correct assert_not_text into a
              // false failure. `innerText` excludes non-rendered nodes and hidden
              // elements, matching human perception. Form-control values are also
              // checked (innerText omits them) so this stays symmetric with
              // assert_text — a string is "present" here iff assert_text would find it.
              (root: Element, search: string) => {
                const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
                const visible = (root as HTMLElement).innerText ?? root.textContent;
                if (norm(visible).includes(search)) return true;
                for (const el of Array.from(root.querySelectorAll('input, textarea, select'))) {
                  const tag = el.tagName.toLowerCase();
                  let v: string | null = null;
                  if (tag === 'input' || tag === 'textarea') v = (el as HTMLInputElement).value;
                  else {
                    const s = el as HTMLSelectElement;
                    v = (s.options[s.selectedIndex] && s.options[s.selectedIndex].text) || s.value;
                  }
                  if (v != null && norm(v).includes(search)) return true;
                }
                return false;
              },
              needleN,
            ).catch(() => false);
            if (present) return true;
          }
          return false;
        };
        for (let i = 0; i < 3; i++) {
          if (await presentAnywhere()) throw new Error(`assert_not_text failed: "${step.value}" is present on the page but should be absent.`);
          await page.waitForTimeout(300);
        }
        this.observability.increment('engine.assert_not_text_ok');
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
        // Poll for up to ~8s so asynchronously-rendered content (SPA hydration,
        // "click Start → content appears after N seconds") is caught rather than
        // failing on a render race. Bounded so a genuinely-absent value still fails
        // in reasonable time.
        let match: { selector: string; text: string } | null = null;
        let evalError: string | null = null;
        // Named so it can run against the main document AND every iframe body.
        const scanBody = (root: Element, search: string) => {
          const tidy = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
          const lc = (s: string) => tidy(s).toLowerCase();
          const selFor = (el: Element) => {
            if (el.id) return `#${el.id}`;
            const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean)[0];
            return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
          };
          const all = Array.from(root.querySelectorAll<Element>('*'));
          // 1) Form-control values are NOT part of textContent — check them
          //    explicitly so "verify the field contains X" works for typed input,
          //    textarea content, and the selected <option>.
          for (const el of all) {
            const tag = el.tagName.toLowerCase();
            let v: string | null = null;
            if (tag === 'input' || tag === 'textarea') v = (el as HTMLInputElement).value;
            else if (tag === 'select') {
              const s = el as HTMLSelectElement;
              v = (s.options[s.selectedIndex] && s.options[s.selectedIndex].text) || s.value;
            }
            if (v != null && lc(v).includes(search)) return { selector: selFor(el), text: tidy(v).slice(0, 200) };
          }
          // 2) VISIBLE text only. `textContent` includes <script>/<style> source and
          //    display:none content — matching there is a false positive (e.g. the
          //    word "Delete" inside an inline deleteElement() handler). `innerText`
          //    reflects what a human actually sees. Gate on the body's visible text
          //    first so a genuinely-absent needle returns null fast (and, crucially,
          //    is reported absent — the mirror bug is a false "present").
          const rootVisible = lc((root as HTMLElement).innerText ?? root.textContent);
          if (!rootVisible.includes(search)) return null;
          // 3) Localize to the innermost element whose OWN visible text contains the
          //    needle. innerText is undefined on non-HTML nodes (e.g. SVG) — skip those.
          for (let i = all.length - 1; i >= 0; i--) {
            const el = all[i] as HTMLElement;
            const t = el.innerText;
            if (t != null && lc(t).includes(search)) return { selector: selFor(el), text: tidy(t).slice(0, 200) };
          }
          // Present in the body's visible text but not localizable to one element
          // (rare — e.g. text split across inline siblings). Report the body.
          return { selector: 'body', text: tidy((root as HTMLElement).innerText).slice(0, 200) };
        };
        // ~8s budget (20 × 400ms) for async / dynamically-rendered content. Each
        // attempt scans the main document AND every iframe — page.frames() is a flat
        // list that includes the main frame and all (nested) child frames, so text
        // rendered inside an iframe is found too.
        for (let attempt = 0; attempt < 20 && !match; attempt++) {
          const frames = typeof page.frames === 'function' ? page.frames() : [];
          const targets: Array<{ $eval: PlaywrightPageLike['$eval'] }> = frames.length ? frames : [page];
          for (const target of targets) {
            match = await target.$eval('body', scanBody, needle).catch((e: any) => { evalError = e?.message ?? String(e); return null; });
            if (match) break;
          }
          if (match) break;
          await page.waitForTimeout(400);
        }

        this.observability.log('info', 'engine.assert_text_check', {
          rawValue: step.value,
          needle,
          found: match?.selector ?? null,
          evalError,
        });

        if (match) {
          this.observability.increment('engine.assert_text_matched');
          return match.selector; // surfaced as selectorUsed on the run details page
        }

        // A page-scan error (not a genuine "absent") means a bug, not a failed
        // assertion — surface it loudly instead of masquerading as "not found".
        if (evalError) {
          this.observability.log('warn', 'engine.assert_text_eval_error', { needle, error: evalError });
        }
        throw new Error(
          `assert_text failed: "${step.value}" not found anywhere on the page.` +
          (evalError ? ` (page scan error: ${evalError})` : ''),
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
        // Use $eval (Playwright's selector engine understands ARIA/role/CSS/XPath)
        // rather than document.querySelector, which cannot parse `role=...` and
        // silently no-ops. $eval also throws on no match, so a bad target fails
        // loudly instead of passing without scrolling.
        await page.$eval(selector, (el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
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

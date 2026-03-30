import type { StepAST, SelectorSet, StepExecutionResult } from '../../types';

/**
 * Spec ref: Section 6.4 — IExecutionEngine
 *
 * Executes a single compiled test step against a live Playwright browser page.
 * Tries selectors from the SelectorSet in confidence order, stopping on first success.
 * On failure, returns the error type and captures a screenshot + DOM snapshot.
 */
export interface IExecutionEngine {
  /**
   * Execute a single step against a live browser page.
   * Returns a result including which selector worked (or the error if none did).
   *
   * @param step        - Compiled step AST
   * @param selectorSet - Ordered list of selectors from IElementResolver
   * @param page        - Live Playwright Page instance (typed as unknown to avoid
   *                      a compile-time dependency on playwright in this interface layer)
   */
  executeStep(
    step: StepAST,
    selectorSet: SelectorSet,
    page: unknown,
  ): Promise<StepExecutionResult>;
}

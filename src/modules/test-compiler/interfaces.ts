import type { StepAST } from '../../types';

/**
 * Spec ref: Section 6.1 — ITestCompiler
 *
 * Parses natural language test steps into structured ASTs.
 *
 * Registered implementations (DI container):
 *  - RuleBasedCompiler  — regex + keyword matching; handles ~70% of steps; no LLM cost
 *  - LLMCompiler        — sends ambiguous steps to LLM via ILLMGateway
 *  - CompositeCompiler  — tries RuleBasedCompiler first; falls back to LLMCompiler
 */
export interface ITestCompiler {
  /**
   * Parse a single natural language step into a structured AST.
   * Uses rule-based parsing first (fast, free); falls back to LLM for ambiguous input.
   */
  compile(rawText: string): Promise<StepAST>;

  /**
   * Batch compile. Implementations may batch LLM calls for efficiency.
   */
  compileMany(steps: string[]): Promise<StepAST[]>;
}

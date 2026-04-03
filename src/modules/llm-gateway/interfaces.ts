import type { StepAST, CandidateNode, LLMResolutionResult } from '../../types';

/**
 * Spec ref: Section 6.6 — ILLMGateway
 *
 * The ONLY place in the codebase that knows which LLM provider/model is in use.
 * All other modules call this interface — never the provider SDK directly.
 *
 * Responsibilities (Section 12):
 *  1. Prompt deduplication     — cache by SHA-256(template + contentHash + domain + candidates)
 *  2. Budget enforcement       — checks IBillingMeter.isOverBudget before every call
 *  3. DOM context management   — constructs prompt from active template_version
 *  4. Response validation      — validates JSON schema; retries once with stricter suffix on failure
 *  5. Token logging            — emits LLM_CALL billing event after every non-cached call
 *  6. Model abstraction        — provider configured via LLM_PROVIDER env var
 *
 * Rate limits (enforced in Redis):
 *  - Starter:    100 LLM calls / hour
 *  - Growth:   1,000 LLM calls / hour
 *  - Enterprise: 10,000 LLM calls / hour
 */
export interface ILLMGateway {
  /**
   * Given a step and a pruned list of candidate DOM nodes, return ranked selectors.
   * Handles prompt construction, dedup cache check, token logging, and response validation.
   */
  resolveElement(
    step: StepAST,
    candidates: CandidateNode[],
    tenantId: string,
  ): Promise<LLMResolutionResult>;

  /**
   * Parse an ambiguous natural language step into a structured StepAST.
   * Called by LLMCompiler when rule-based parsing confidence is below threshold.
   */
  compileStep(rawText: string, tenantId: string): Promise<StepAST>;

  /**
   * Generate a 1536-dimensional semantic embedding vector for the given text.
   * Uses text-embedding-3-small. Called by:
   *  - LLMElementResolver: to persist step_embedding after resolution
   *  - CachedElementResolver: to embed the incoming query before pgvector search
   * This is a separate OpenAI Embeddings API call — not a chat completion.
   */
  generateEmbedding(text: string): Promise<number[]>;
}

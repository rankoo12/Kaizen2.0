import type {
  AppBrief, AppBriefInput, GeneratedScenario, JudgeInput, JudgeVerdict,
  PageClassification, PageClassifyInput, PlanInput, PlannedScenario,
  TenantBrief, WriteInput,
} from '../../types/test-writer';

/**
 * ITestWriterGateway — the LLM seam for the Test Writer pipeline.
 *
 * Kept separate from ILLMGateway (which every resolver/compiler mocks) so the
 * execution-path interface stays small, while preserving the hard rule that
 * ALL provider calls live in the llm-gateway module.
 *
 * Tiering (model-tier.ts): synthesizeAppBrief, planScenarios and judgeScenarios
 * run on the frontier tier — they ARE the QA-engineer judgment. Classification
 * and writing are mini.
 *
 * Spec: docs/specs/test-writer/spec-generation-pipeline.md §1.3, §2, §3, §4.6
 */
export interface ITestWriterGateway {
  /**
   * Distil the tenant's free-text "describe your app" brief into structure.
   * Input is UNTRUSTED (service spec §12/§13.3) and must already be
   * secret-scrubbed by the caller.
   */
  distillBrief(rawBrief: string, tenantId: string): Promise<TenantBrief>;

  /** Per-page purpose + capabilities. Mini tier, one call per changed page. */
  classifyPage(input: PageClassifyInput, tenantId: string): Promise<PageClassification>;

  /**
   * Whole-app synthesis → App Brief with user journeys. FRONTIER tier.
   * Journeys are proposed here and VERIFIED against page_links by the caller —
   * the graph disposes of anything the crawler never observed.
   */
  synthesizeAppBrief(input: AppBriefInput, tenantId: string): Promise<AppBrief>;

  /** The test plan: catalog instantiation + app-specific gap-fill. FRONTIER tier. */
  planScenarios(input: PlanInput, tenantId: string): Promise<PlannedScenario[]>;

  /**
   * One planned scenario → structured step intents referencing real element
   * ids. Mini tier. The caller validates the schema; this method only
   * guarantees a parsed object of the right shape.
   */
  generateScenario(input: WriteInput, tenantId: string): Promise<GeneratedScenario>;

  /**
   * Batched quality judgement over rendered scenarios — the value filter that
   * VALIDATE is structurally blind to (a vacuous test passes validation
   * forever). ONE frontier call per job (mini could not apply its own rubric —
   * spec-judge-repair-loop.md §2.1).
   */
  judgeScenarios(input: JudgeInput, tenantId: string): Promise<JudgeVerdict[]>;
}

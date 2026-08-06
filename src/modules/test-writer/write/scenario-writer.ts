import type { ITestWriterGateway } from '../../llm-gateway/testwriter.interfaces';
import type { IObservability } from '../../observability/interfaces';
import type {
  GroundingElement, PlannedScenario, ScenarioExpectation, StepIntent,
} from '../../../types/test-writer';
import { getArchetype } from '../plan/catalog';
import { runSchemaGate } from './step-intent.schema';
import { renderScenario, type RenderedStep } from './canonical-templates';
import { classifyScenarioSafety } from './write-safety';
import { lintScenario } from './lints';

/**
 * WRITE — one planned scenario becomes grounded, renderable, safe steps.
 * Spec: docs/specs/test-writer/spec-generation-pipeline.md §3, §4.1–§4.4
 *
 * Gate order is cheapest-first, and each gate catches something only it can:
 *   schema/grounding → safety → render → lints (advisory) → [judge, batched later]
 * A schema failure earns exactly one repair round; the model is told precisely
 * what was wrong and given the valid id list again.
 */

export type WrittenScenario = {
  plan: PlannedScenario;
  name: string;
  kind: 'positive' | 'negative';
  intents: StepIntent[];
  steps: RenderedStep[];
  expectation: ScenarioExpectation;
  rationale: string;
  lintFindings: string[];
  /** True when validation requires the suite's synthetic-data consent. */
  needsConsent: boolean;
};

export type WriteFailure = {
  plan: PlannedScenario;
  stage: 'schema' | 'safety' | 'render';
  reason: string;
};

export type WriteOutcome =
  | { ok: true; scenario: WrittenScenario }
  | { ok: false; failure: WriteFailure };

export class ScenarioWriter {
  constructor(
    private readonly gateway: ITestWriterGateway,
    private readonly obs: IObservability,
  ) {}

  async write(params: {
    tenantId: string;
    plan: PlannedScenario;
    grounding: GroundingElement[];
    formSummaries: string[];
    pagePath: string[];
    seedTokens: string[];
    steeringNotes: string | null;
    safeMode: boolean;
    maxSteps: number;
  }): Promise<WriteOutcome> {
    const { plan } = params;
    const archetype = plan.source.kind === 'catalog' ? getArchetype(plan.source.archetypeKey) : null;
    const elements = new Map(params.grounding.map((g) => [g.id, g]));
    const validIds = new Set(params.grounding.map((g) => g.id));
    const rolesById = new Map(params.grounding.map((g) => [g.id, g.role]));

    let repairErrors: string[] | undefined;

    // One generation attempt + one repair round (spec §4).
    for (let attempt = 0; attempt < 2; attempt++) {
      const generated = await this.gateway.generateScenario({
        plan,
        grounding: params.grounding,
        formSummaries: params.formSummaries,
        pagePath: params.pagePath,
        seedTokens: params.seedTokens,
        archetype: archetype?.skeleton ?? null,
        steeringNotes: params.steeringNotes,
        maxSteps: params.maxSteps,
        repairErrors,
      }, params.tenantId);

      const gate = runSchemaGate(
        generated.steps, validIds, params.maxSteps, rolesById, params.seedTokens,
      );
      if (!gate.ok) {
        repairErrors = gate.errors;
        this.obs.increment('testwriter.write_schema_reject', { attempt: String(attempt) });
        continue;
      }

      const kind: 'positive' | 'negative' = generated.kind === 'negative' ? 'negative' : 'positive';

      // Safety: decided on intents (action + element name), not on prose.
      const safety = classifyScenarioSafety(gate.steps, elements, {
        safeMode: params.safeMode,
        stopBeforeMoney: plan.source.kind === 'catalog'
          && getArchetype(plan.source.archetypeKey)?.safety === 'stop-before-money',
      });
      if (safety.verdict === 'blocked') {
        this.obs.increment('testwriter.write_safety_block');
        return { ok: false, failure: { plan, stage: 'safety', reason: safety.reason } };
      }

      let steps: RenderedStep[];
      try {
        steps = renderScenario(gate.steps, elements);
      } catch (err) {
        return {
          ok: false,
          failure: {
            plan, stage: 'render',
            reason: err instanceof Error ? err.message : String(err),
          },
        };
      }

      const expectation: ScenarioExpectation =
        generated.expectation?.outcome === 'fail'
          ? {
              outcome: 'fail',
              failStepIndex: Number(generated.expectation.failStepIndex ?? 0),
              reason: String(generated.expectation.reason ?? ''),
            }
          : { outcome: 'pass' };

      return {
        ok: true,
        scenario: {
          plan,
          name: String(generated.name ?? plan.name).slice(0, 300),
          kind,
          intents: gate.steps,
          steps,
          expectation,
          rationale: String(generated.rationale ?? plan.rationale).slice(0, 500),
          lintFindings: lintScenario(gate.steps, kind),
          needsConsent: safety.verdict === 'needs-consent',
        },
      };
    }

    return {
      ok: false,
      failure: {
        plan, stage: 'schema',
        reason: `failed the schema gate twice: ${(repairErrors ?? []).join('; ')}`,
      },
    };
  }
}

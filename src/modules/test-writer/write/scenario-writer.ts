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
import { groundingNotes } from './grounding-notes';

/**
 * WRITE — one planned scenario becomes grounded, renderable, safe steps.
 * Spec: docs/specs/test-writer/spec-generation-pipeline.md §3, §4.1–§4.4
 *
 * Gate order is cheapest-first, and each gate catches something only it can:
 *   schema/grounding → safety → render → lints (advisory) → [judge, batched later]
 * A schema failure earns exactly one repair round; the model is told precisely
 * what was wrong and given the valid id list again.
 */

/**
 * A selector the crawler already observed, paired with the step that will look
 * for it. Seeding these into the tenant's cache is what stops the proving run
 * paying the model to rediscover an element we identified during recon.
 * Spec: spec-generation-pipeline.md §5.2
 */
export type SelectorSeed = {
  targetHash: string;
  selector: string;
};

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
  selectorSeeds: SelectorSeed[];
};

export type WriteFailure = {
  plan: PlannedScenario;
  stage: 'schema' | 'safety' | 'render';
  reason: string;
  /**
   * What was written, when anything parseable was. Kept so a rejection can be
   * read, not just counted — by the user in "Kaizen shows its work" and by us
   * when a gate looks wrong. Spec: spec-judge-repair-loop.md §2.5
   */
  steps?: string[];
};

export type WriteOutcome =
  | { ok: true; scenario: WrittenScenario }
  | { ok: false; failure: WriteFailure };

/**
 * Pair each element-targeted step's targetHash with the selector recon observed
 * for that element. Steps with no observed selector are skipped rather than
 * guessed: probe-revealed elements store none, and description targets
 * (click_random, discover oracles) name a class or a not-yet-existing element.
 */
export function collectSelectorSeeds(
  intents: StepIntent[],
  rendered: RenderedStep[],
  elements: Map<string, GroundingElement>,
): SelectorSeed[] {
  const seeds: SelectorSeed[] = [];
  const seen = new Set<string>();

  intents.forEach((intent, index) => {
    const target = 'target' in intent ? intent.target : undefined;
    if (!target || target.kind !== 'element') return;
    const element = elements.get(target.elementId);
    const targetHash = rendered[index]?.ast.targetHash;
    if (!element?.selector || !targetHash || seen.has(targetHash)) return;
    seen.add(targetHash);
    seeds.push({ targetHash, selector: element.selector });
  });

  return seeds;
}

/**
 * Archetypes whose whole premise is an entity the app already holds. A seed
 * token is the one thing that cannot satisfy them: it invents a value, so the
 * test proves only that searching for something absent behaves like searching
 * for something absent — while its oracle ("the text is shown") is satisfied by
 * the search box the test typed into.
 * Spec: docs/specs/test-writer/spec-validation-trust.md §7
 */
const KNOWN_ENTITY_ARCHETYPES = new Set([
  'search.find-known-entity',
  'search.result-opens-detail',
]);

export function checkKnownEntityBinding(
  plan: PlannedScenario,
  steps: StepIntent[],
  seedTokens: string[],
): string[] {
  if (plan.source.kind !== 'catalog' || !KNOWN_ENTITY_ARCHETYPES.has(plan.source.archetypeKey)) return [];

  const errors: string[] = [];
  steps.forEach((step, index) => {
    if (step.action !== 'type' || typeof step.value !== 'string') return;
    const token = /\{\{(\w+)\}\}/.exec(step.value);
    if (token && seedTokens.includes(token[1])) {
      errors.push(
        `step ${index + 1}: "${step.value}" is a randomly generated value, but this scenario is ` +
        'about finding an entity that already exists. Use a literal name taken from the page ' +
        'content you were given (a product, test, or item the crawl actually saw).',
      );
    }
  });
  return errors;
}

/**
 * Best-effort one-line rendering of steps that did NOT pass the schema gate —
 * the canonical renderer needs valid intents, and these by definition are not.
 * Enough for a human to see what the model tried ("type in the Cart link").
 */
export function summariseRawSteps(raw: unknown, elements: Map<string, GroundingElement>): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map((step) => {
    if (!step || typeof step !== 'object') return String(step);
    const s = step as Record<string, unknown>;
    const parts: string[] = [String(s.action ?? '?')];
    const target = s.target as Record<string, unknown> | string | undefined;
    if (typeof target === 'string') {
      const el = elements.get(target);
      parts.push(el ? `${el.role} "${el.name}"` : target);
    } else if (target && typeof target === 'object') {
      const id = typeof target.elementId === 'string' ? target.elementId : null;
      const el = id ? elements.get(id) : undefined;
      if (el) parts.push(`${el.role} "${el.name}"`);
      else if (typeof target.description === 'string') parts.push(`"${target.description}"`);
      else if (id) parts.push(`(unknown element ${id.slice(0, 8)}…)`);
    }
    if (typeof s.description === 'string') parts.push(`"${s.description}"`);
    if (typeof s.value === 'string') parts.push(`= "${s.value}"`);
    if (typeof s.url === 'string') parts.push(s.url);
    return parts.join(' ');
  });
}

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
    /** Widens the hard-block lexicon and re-reads synthetic consent (spec §6.5). */
    scope?: 'public' | 'authenticated';
  }): Promise<WriteOutcome> {
    const { plan } = params;
    const archetype = plan.source.kind === 'catalog' ? getArchetype(plan.source.archetypeKey) : null;
    const elements = new Map(params.grounding.map((g) => [g.id, g]));
    const validIds = new Set(params.grounding.map((g) => g.id));
    const rolesById = new Map(params.grounding.map((g) => [g.id, g.role]));

    let repairErrors: string[] | undefined;
    // The last thing the model produced, for the rejection record (spec §2.5).
    let lastSteps: string[] = [];
    const notes = groundingNotes(params.grounding);

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
        groundingNotes: notes,
      }, params.tenantId);

      const gate = runSchemaGate(
        generated.steps, validIds, params.maxSteps, rolesById, params.seedTokens,
      );
      if (!gate.ok) {
        repairErrors = gate.errors;
        lastSteps = summariseRawSteps(generated.steps, elements);
        this.obs.increment('testwriter.write_schema_reject', { attempt: String(attempt) });
        continue;
      }
      try {
        lastSteps = renderScenario(gate.steps, elements).map((s) => s.text);
      } catch {
        lastSteps = summariseRawSteps(generated.steps, elements);
      }

      // An archetype whose premise is "an entity that provably EXISTS" cannot be
      // satisfied by a random seed. Bound to {{firstName}} it searched for
      // 'Taylor' — a name the app had never heard of — and then asserted that
      // text was shown, which the search box itself made true. The query has to
      // be a literal the crawl actually saw.
      const entityErrors = checkKnownEntityBinding(plan, gate.steps, params.seedTokens);
      if (entityErrors.length > 0) {
        repairErrors = entityErrors;
        this.obs.increment('testwriter.write_known_entity_reject', { attempt: String(attempt) });
        continue;
      }

      const kind: 'positive' | 'negative' = generated.kind === 'negative' ? 'negative' : 'positive';

      // Safety: decided on intents (action + element name), not on prose.
      const safety = classifyScenarioSafety(gate.steps, elements, {
        safeMode: params.safeMode,
        stopBeforeMoney: plan.source.kind === 'catalog'
          && getArchetype(plan.source.archetypeKey)?.safety === 'stop-before-money',
        // Behind auth the proving run acts as a real, possibly admin, user —
        // the lexicon widens accordingly (spec §6.5).
        authenticated: params.scope === 'authenticated',
      });
      if (safety.verdict === 'blocked') {
        this.obs.increment('testwriter.write_safety_block');
        return { ok: false, failure: { plan, stage: 'safety', reason: safety.reason, steps: lastSteps } };
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
            steps: lastSteps,
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
          selectorSeeds: collectSelectorSeeds(gate.steps, steps, elements),
        },
      };
    }

    return {
      ok: false,
      failure: {
        plan, stage: 'schema',
        reason: `failed the schema gate twice: ${(repairErrors ?? []).join('; ')}`,
        steps: lastSteps,
      },
    };
  }
}

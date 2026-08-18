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
 * A scenario that only ever touches the nav bar and the footer is not a test of
 * the page it was planned for — those elements are on every page. This is how
 * "Manipulate input text and submit" shipped as a click on the site-wide
 * "Elemental Selenium" footer link and passed.
 *
 * Returned as a repair instruction rather than a rejection: the writer gets one
 * more attempt, on the frontier tier, with the page's own controls in front of
 * it. Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §2
 */
export function checkChromeOnly(
  steps: StepIntent[],
  elements: Map<string, GroundingElement>,
): string[] {
  const touched: GroundingElement[] = [];
  for (const step of steps) {
    if (step.action.startsWith('assert_')) continue;
    const target = 'target' in step ? step.target : undefined;
    if (!target || target.kind !== 'element') continue;
    const element = elements.get(target.elementId);
    if (element) touched.push(element);
  }
  if (touched.length === 0 || touched.some((el) => !el.chrome)) return [];

  const pageSpecific = [...elements.values()].filter((el) => !el.chrome).slice(0, 8);
  return [
    'every element this scenario interacts with is site-wide navigation or footer '
    + `(${touched.map((el) => `"${el.name}"`).join(', ')}), which appears on every page — so the `
    + 'scenario tests nothing about the page it was planned for. Use the controls that belong to '
    + 'that page'
    + (pageSpecific.length
      ? `, for example: ${pageSpecific.map((el) => `${el.role} "${el.name}"`).join(', ')}.`
      : '. If that page has no controls of its own, assert its text instead.'),
  ];
}

/**
 * A scenario that does not say where it starts runs wherever the previous test
 * left the browser — in practice, the site's home page. Two proving runs died
 * that way. The plan already names the page, so the step can simply be added.
 *
 * `failStepIndex` is body-relative, so a Tier-2 negative's expected failure
 * point moves with it.
 * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §2
 */
export function prependNavigate(
  steps: StepIntent[],
  plan: PlannedScenario,
  expectation: ScenarioExpectation,
): { steps: StepIntent[]; expectation: ScenarioExpectation } {
  const url = plan.targetPages[0];
  if (!url || steps[0]?.action === 'navigate') return { steps, expectation };
  return {
    steps: [{ action: 'navigate', url }, ...steps],
    expectation: expectation.outcome === 'fail'
      ? { ...expectation, failStepIndex: expectation.failStepIndex + 1 }
      : expectation,
  };
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
    /**
     * Set when this is a REWRITE after the quality judge: the judge's failed
     * dimensions and the steps it read. Every attempt of a rewrite runs on the
     * frontier tier. Spec: spec-judge-repair-loop.md §2.2
     */
    judgeFeedback?: string[];
    previousSteps?: string[];
  }): Promise<WriteOutcome> {
    const { plan } = params;
    const archetype = plan.source.kind === 'catalog' ? getArchetype(plan.source.archetypeKey) : null;
    const elements = new Map(params.grounding.map((g) => [g.id, g]));
    const validIds = new Set(params.grounding.map((g) => g.id));
    const rolesById = new Map(params.grounding.map((g) => [g.id, g.role]));
    const newTabIds = new Set(params.grounding.filter((g) => g.opensNewTab).map((g) => g.id));

    let repairErrors: string[] | undefined;
    // The last thing the model produced, for the rejection record (spec §2.5).
    let lastSteps: string[] = [];
    const notes = groundingNotes(params.grounding);

    const isRewrite = (params.judgeFeedback?.length ?? 0) > 0;

    // One generation attempt + one repair round (spec §4).
    for (let attempt = 0; attempt < 2; attempt++) {
      // The first draft is cheap; the second draft is the expensive one, because
      // it is the last. A mini model that failed a repair instruction once does
      // the same thing again (spec-judge-repair-loop.md §1.4, §2.3).
      const tier: 'mini' | 'frontier' = attempt > 0 || isRewrite ? 'frontier' : 'mini';
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
        tier,
        judgeFeedback: params.judgeFeedback,
        previousSteps: params.previousSteps,
      }, params.tenantId);

      const gate = runSchemaGate(
        generated.steps, validIds, params.maxSteps, rolesById, params.seedTokens, newTabIds,
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

      // A scenario built entirely out of the nav bar and the footer is not a
      // test of the page it was planned for. One rewrite, on the frontier tier,
      // with the page's own controls named for it.
      const chromeErrors = checkChromeOnly(gate.steps, elements);
      if (chromeErrors.length > 0) {
        repairErrors = chromeErrors;
        this.obs.increment('testwriter.write_chrome_only_reject', { attempt: String(attempt) });
        continue;
      }

      const kind: 'positive' | 'negative' = generated.kind === 'negative' ? 'negative' : 'positive';

      const rawExpectation: ScenarioExpectation =
        generated.expectation?.outcome === 'fail'
          ? {
              outcome: 'fail',
              failStepIndex: Number(generated.expectation.failStepIndex ?? 0),
              reason: String(generated.expectation.reason ?? ''),
            }
          : { outcome: 'pass' };

      // Say where the test starts. Without this the run begins wherever the
      // browser happens to be — the site's home page — and the first click
      // resolves against the wrong page.
      const { steps: intents, expectation } = prependNavigate(gate.steps, plan, rawExpectation);

      // Safety: decided on intents (action + element name), not on prose.
      const safety = classifyScenarioSafety(intents, elements, {
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
        steps = renderScenario(intents, elements);
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

      return {
        ok: true,
        scenario: {
          plan,
          name: String(generated.name ?? plan.name).slice(0, 300),
          kind,
          intents,
          steps,
          expectation,
          rationale: String(generated.rationale ?? plan.rationale).slice(0, 500),
          lintFindings: lintScenario(intents, kind),
          needsConsent: safety.verdict === 'needs-consent',
          selectorSeeds: collectSelectorSeeds(intents, steps, elements),
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

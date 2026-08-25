import type { ITestWriterGateway } from '../../llm-gateway/testwriter.interfaces';
import type { IObservability } from '../../observability/interfaces';
import type {
  FactTest, GroundingElement, PageDossier, ScenarioRejection, StepIntent, TranscribeResult,
} from '../../../types/test-writer';
import { StepIntentSchema, isAssertion } from '../write/step-intent.schema';
import { isRoleCompatible } from '../../element-resolver/action-role-filter';
import { checkContradictoryAsserts, collectSelectorSeeds, type SelectorSeed } from '../write/scenario-writer';
import { renderScenario, type RenderedStep } from '../write/canonical-templates';
import { classifyScenarioSafety } from '../write/write-safety';
import { isOpenerName } from '../recon/safety';

/**
 * TRANSCRIBE — the fact tier's authoring half.
 * Spec: docs/specs/test-writer/spec-agentic-testwriter.md §4
 *
 * One frontier call per screen returns MANY granular checks; this module gates
 * each one down to something a machine can verify with no model in the loop:
 * element-id targets only, read-only interactions, literal oracles. The gate is
 * deliberately stricter than WRITE's — a fact that needs interpretation is a
 * fact the batch verifier cannot execute, so it is refused here rather than
 * failed there.
 */

export type FactScenario = {
  name: string;
  /** urlNormalized of the screen this fact belongs to. */
  page: string;
  rationale: string;
  /** The transcriber's steps — no navigate; the verifier positions the browser. */
  bodyIntents: StepIntent[];
  /** Delivered-case intents: navigate + reach hops + body (self-contained). */
  intents: StepIntent[];
  /** Rendered full intents — the case's NL steps and ASTs. */
  steps: RenderedStep[];
  selectorSeeds: SelectorSeed[];
  /** Where the verifier opens the screen (navigable URL). */
  gotoUrl: string;
  /** Clicks that reach a URL-less screen after the goto. */
  hops: Array<{ role: string; name: string }>;
  /** True when the fact acts (click/type/…) rather than only reading. */
  interactive: boolean;
  /**
   * The screen's fixture recipe (raw, with the {{fixture}} token) when this
   * fact references the fixture; the verifier runs it once per screen with a
   * unique name, the delivered case runs it afresh with a run variable.
   */
  fixtureIntents?: StepIntent[];
  usesFixture: boolean;
};

export const FIXTURE_TOKEN = '{{fixture}}';
/** What the delivered case types: unique per run, assertable by the same literal. */
export const FIXTURE_RUN_NAME = 'Kaizen fixture {{username}}';

export function mentionsFixture(steps: StepIntent[]): boolean {
  return steps.some((s) => 'value' in s && typeof s.value === 'string' && s.value.includes(FIXTURE_TOKEN));
}

/** Replace the fixture token in every typed/asserted value. */
export function substituteFixture(steps: StepIntent[], name: string): StepIntent[] {
  return steps.map((s) => ('value' in s && typeof s.value === 'string' && s.value.includes(FIXTURE_TOKEN)
    ? { ...s, value: s.value.split(FIXTURE_TOKEN).join(name) }
    : s) as StepIntent);
}

const FIXTURE_ACTIONS = new Set(['click', 'type', 'select', 'check', 'uncheck', 'press_key']);

/**
 * The fixture recipe gate: element-id targets, creation vocabulary only, the
 * {{fixture}} token typed at least once, at most 8 steps. Safety is the
 * caller's (it needs the suite's consent flag).
 */
export function runFixtureGate(
  raw: unknown,
  elements: Map<string, GroundingElement>,
): { ok: true; steps: StepIntent[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: 'fixture has no steps' };
  if (raw.length > 8) return { ok: false, reason: `fixture has ${raw.length} steps (max 8)` };
  const steps: StepIntent[] = [];
  for (let i = 0; i < raw.length; i++) {
    const parsed = StepIntentSchema.safeParse(raw[i]);
    if (!parsed.success) return { ok: false, reason: `fixture step ${i + 1}: invalid intent` };
    const step = parsed.data;
    if (!FIXTURE_ACTIONS.has(step.action)) {
      return { ok: false, reason: `fixture step ${i + 1}: "${step.action}" is not a creation action` };
    }
    const target = 'target' in step ? step.target : undefined;
    if (target) {
      if (target.kind !== 'element') return { ok: false, reason: `fixture step ${i + 1}: description target` };
      const el = elements.get(target.elementId);
      if (!el) return { ok: false, reason: `fixture step ${i + 1}: unknown elementId` };
      if (!isRoleCompatible(step.action, el.role)) {
        return { ok: false, reason: `fixture step ${i + 1}: cannot ${step.action} a "${el.role}"` };
      }
    }
    steps.push(step);
  }
  const typesToken = steps.some((s) => s.action === 'type' && s.value.includes(FIXTURE_TOKEN));
  if (!typesToken) return { ok: false, reason: 'fixture never types the {{fixture}} token as the record name' };
  return { ok: true, steps };
}

/** The fact tier's whole vocabulary — everything else is a transcribe rejection. */
const FACT_ACTIONS = new Set([
  'click', 'hover', 'check', 'uncheck', 'type', 'select', 'press_key',
  'assert_visible', 'assert_not_visible', 'assert_enabled', 'assert_disabled',
  'assert_checked', 'assert_not_checked', 'assert_text', 'assert_url',
]);

const STATE_CHANGING = new Set(['click', 'hover', 'check', 'uncheck', 'type', 'select', 'press_key']);

const MAX_FACT_STEPS = 5;

export type FactGateResult =
  | { ok: true; steps: StepIntent[] }
  | { ok: false; reason: string };

/**
 * Fact-tier gate. Stricter than runSchemaGate on TARGETS (no descriptions at
 * all — the verifier resolves recorded selectors and nothing else) and looser
 * on SHAPE (a presence-only fact is legitimate breadth here, where WRITE's
 * "must interact" rule would refuse it).
 */
export function runFactGate(
  raw: FactTest,
  elements: Map<string, GroundingElement>,
  /** The screen defined a fixture: {{fixture}} is a legal literal here. */
  fixtureDefined = false,
): FactGateResult {
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    return { ok: false, reason: 'fact has no steps' };
  }
  if (raw.steps.length > MAX_FACT_STEPS) {
    return { ok: false, reason: `fact has ${raw.steps.length} steps (max ${MAX_FACT_STEPS})` };
  }

  const steps: StepIntent[] = [];
  for (let i = 0; i < raw.steps.length; i++) {
    const parsed = StepIntentSchema.safeParse(raw.steps[i]);
    if (!parsed.success) {
      return { ok: false, reason: `step ${i + 1}: invalid intent` };
    }
    steps.push(parsed.data);
  }

  const typed: Array<{ value: string; index: number; elementId: string | null }> = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!FACT_ACTIONS.has(step.action)) {
      return { ok: false, reason: `step ${i + 1}: "${step.action}" is not in the fact-tier vocabulary` };
    }
    const target = 'target' in step ? step.target : undefined;
    if (target) {
      if (target.kind !== 'element') {
        return {
          ok: false,
          reason: `step ${i + 1}: description target "${target.description}" — the fact tier is element-id only`,
        };
      }
      const el = elements.get(target.elementId);
      if (!el) {
        return { ok: false, reason: `step ${i + 1}: elementId ${target.elementId} was never observed on this screen` };
      }
      if (!isRoleCompatible(step.action, el.role)) {
        return { ok: false, reason: `step ${i + 1}: cannot ${step.action} a "${el.role}" element` };
      }
      // A new-tab link's destination lives in a tab this tier never switches to.
      if (step.action === 'click' && el.opensNewTab) {
        return { ok: false, reason: `step ${i + 1}: "${el.name}" opens a new tab — not verifiable in this tier` };
      }
    }
    if (step.action === 'type' && typeof step.value === 'string') {
      typed.push({
        value: step.value.trim().toLowerCase(), index: i,
        elementId: target?.kind === 'element' ? target.elementId : null,
      });
      // {{tokens}} are journey-tier machinery; the verifier types literals only —
      // except the screen's own {{fixture}}, which the verifier substitutes.
      if (/\{\{\w+\}\}/.test(step.value.split(FIXTURE_TOKEN).join(''))) {
        return { ok: false, reason: `step ${i + 1}: seed tokens are not available in the fact tier — type a literal` };
      }
      if (step.value.includes(FIXTURE_TOKEN) && !fixtureDefined) {
        return { ok: false, reason: `step ${i + 1}: references {{fixture}} but this screen defined no fixture` };
      }
    }
    // The echo trap, fact-sized: asserting the text you just typed proves typing —
    // unless a click on a DIFFERENT element came between (the save that turns the
    // typed name into a row). Same exception the writer's gate carries.
    if (step.action === 'assert_text') {
      const echoed = typed.find((t) => t.value === step.value.trim().toLowerCase());
      const submitted = echoed !== undefined && steps.slice(echoed.index + 1, i).some((s) => {
        if (s.action !== 'click') return false;
        const t = 'target' in s ? s.target : undefined;
        return t?.kind === 'element' && t.elementId !== echoed.elementId;
      });
      // Second exception: the typed element is a search/filter box. An input's
      // value never appears in body.innerText, so page text matching what was
      // typed into a search box IS a result row — the canonical filter fact
      // (run 30 refused six of these).
      const searchTyped = echoed?.elementId !== undefined && echoed.elementId !== null
        && /search|filter|find/iu.test(elements.get(echoed.elementId)?.name ?? '');
      if (echoed && !submitted && !searchTyped) {
        return { ok: false, reason: `step ${i + 1}: asserts the same text an earlier step typed` };
      }
    }
    if (step.action === 'assert_text' && step.value.includes(FIXTURE_TOKEN) && !fixtureDefined) {
      return { ok: false, reason: `step ${i + 1}: references {{fixture}} but this screen defined no fixture` };
    }
  }

  if (!isAssertion(steps[steps.length - 1].action)) {
    return { ok: false, reason: 'fact does not end with an assertion' };
  }

  // A non-event: act on X, then assert only that X is still there. "Type in
  // the search box, verify the search box is visible" proves typing happened.
  // Checked-state assertions are exempt — check X, assert X checked IS the fact.
  const acted = new Set<string>();
  const asserted: Array<{ id: string | null; action: string }> = [];
  for (const step of steps) {
    const target = 'target' in step ? step.target : undefined;
    const id = target?.kind === 'element' ? target.elementId : null;
    if (STATE_CHANGING.has(step.action) && id) acted.add(id);
    if (isAssertion(step.action)) asserted.push({ id, action: step.action });
  }
  if (acted.size > 0 && asserted.every((a) =>
    a.id !== null && acted.has(a.id) && a.action !== 'assert_checked' && a.action !== 'assert_not_checked')) {
    return { ok: false, reason: 'asserts only the control it acted on — assert what the action CHANGED' };
  }

  const contradictions = checkContradictoryAsserts(steps);
  if (contradictions.length > 0) {
    return { ok: false, reason: contradictions[0] };
  }

  return { ok: true, steps };
}

/**
 * Transcribe one screen: gateway call, per-fact gating, safety, rendering.
 * Rejections come back with reasons — the report's "declined" accounting.
 */
export async function transcribePage(params: {
  gateway: ITestWriterGateway;
  obs: IObservability;
  tenantId: string;
  dossier: PageDossier;
  grounding: GroundingElement[];
  conventions: string[];
  factsPerPage: number;
  scope: 'public' | 'authenticated';
  safeMode: boolean;
  syntheticDataConsent: boolean;
  /** normalized URL → the URL the browser can actually open. */
  navigableUrl: (url: string) => string;
}): Promise<{ facts: FactScenario[]; rejected: ScenarioRejection[] }> {
  const { dossier } = params;
  const elements = new Map(params.grounding.map((g) => [g.id, g]));
  const facts: FactScenario[] = [];
  const rejected: ScenarioRejection[] = [];

  // One screen, three focused calls — a narrow ask comes back full, a wide
  // one thin (run 29: 6 facts on a 75-control screen from one call). The
  // fixture lens runs only where the screen can create something.
  const canCreate = params.syntheticDataConsent
    && params.grounding.some((g) => isOpenerName(g.name.toLowerCase()));
  const lenses: Array<'structure' | 'interactions' | 'fixture'> = canCreate
    ? ['structure', 'interactions', 'fixture']
    : ['structure', 'interactions'];
  const raw: Array<{ fact: FactTest; lens: string }> = [];
  let fixture: StepIntent[] | null = null;

  for (const lens of lenses) {
    let result: TranscribeResult;
    try {
      result = await params.gateway.transcribeFactTests({
        page: {
          url: dossier.url,
          urlNormalized: dossier.urlNormalized,
          title: dossier.title,
          headings: dossier.headings,
          pageText: dossier.pageText,
          purpose: dossier.purpose,
          forms: dossier.forms,
          ...(dossier.reachedBy?.length ? { reachedBy: dossier.reachedBy } : {}),
        },
        grounding: params.grounding,
        conventions: params.conventions,
        factsPerPage: lens === 'fixture' ? Math.ceil(params.factsPerPage / 2) : params.factsPerPage,
        scope: params.scope,
        fixturesAllowed: lens === 'fixture',
        lens,
      }, params.tenantId);
    } catch (err) {
      // One lens's answer failed to parse or arrive: that slice of the screen
      // is declined with the reason; the other lenses and tiers are untouched.
      params.obs.increment('testwriter.transcribe_gateway_failed');
      rejected.push({
        name: `${lens} facts for ${dossier.urlNormalized}`, stage: 'transcribe',
        reason: `the transcriber's answer could not be used: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
      });
      continue;
    }
    for (const fact of result.facts) raw.push({ fact, lens });

    // The screen's fixture comes from the fixture lens alone.
    if (lens === 'fixture' && result.fixture) {
      const gate = runFixtureGate(result.fixture, elements);
      if (!gate.ok) {
        rejected.push({ name: `fixture for ${dossier.urlNormalized}`, stage: 'transcribe', reason: gate.reason });
      } else {
        const safety = classifyScenarioSafety(gate.steps, elements, {
          safeMode: params.safeMode, stopBeforeMoney: false,
          authenticated: params.scope === 'authenticated', syntheticDataConsent: true,
        });
        if (safety.verdict === 'blocked') {
          rejected.push({ name: `fixture for ${dossier.urlNormalized}`, stage: 'safety', reason: safety.reason });
        } else {
          fixture = gate.steps;
          params.obs.increment('testwriter.fact_fixture_defined');
        }
      }
    }
  }

  const seen = new Set<string>();
  const gotoUrl = params.navigableUrl(
    dossier.reachedBy?.length ? dossier.url : dossier.urlNormalized,
  );
  const hops = dossier.reachedBy ?? [];

  for (const { fact, lens } of raw) {
    const name = String(fact.name ?? '').slice(0, 300).trim();
    if (!name) continue;

    const gate = runFactGate(fact, elements, fixture !== null && lens === 'fixture');
    if (!gate.ok) {
      rejected.push({ name, stage: 'transcribe', reason: gate.reason });
      params.obs.increment('testwriter.fact_gate_reject');
      continue;
    }

    // Same safety lexicon as WRITE — "Delete", "Pay now", sign-out and friends
    // are refused on the element NAME, not trusted to the prompt. Anything that
    // would need consent is out too: this tier promised to be read-only.
    const safety = classifyScenarioSafety(gate.steps, elements, {
      safeMode: params.safeMode,
      stopBeforeMoney: false,
      authenticated: params.scope === 'authenticated',
      syntheticDataConsent: false,
    });
    if (safety.verdict !== 'allowed') {
      rejected.push({
        name, stage: 'safety',
        reason: safety.verdict === 'blocked' ? safety.reason
          : `fact tier is read-only — ${safety.reason}`,
      });
      params.obs.increment('testwriter.fact_safety_reject');
      continue;
    }

    // Duplicate behaviour inside the same screen: identical step sequences.
    const fingerprint = gate.steps.map((s) => JSON.stringify(s)).join('|');
    if (seen.has(fingerprint)) {
      rejected.push({ name, stage: 'dedup', reason: 'duplicate of another fact on this screen' });
      continue;
    }
    seen.add(fingerprint);

    // The delivered case is self-contained: navigate, reach the screen, create
    // the fixture if the fact needs one (with a per-run name), then the fact's
    // own steps — runnable by the ordinary engine later.
    const usesFixture = fixture !== null && mentionsFixture(gate.steps);
    const intents: StepIntent[] = [
      { action: 'navigate', url: gotoUrl },
      ...hops.map((h): StepIntent => ({
        action: 'click',
        target: { kind: 'description', description: `the "${h.name}" ${h.role === 'link' ? 'link' : h.role === 'tab' ? 'tab' : 'button'}` },
      })),
      ...(usesFixture ? substituteFixture(fixture!, FIXTURE_RUN_NAME) : []),
      ...(usesFixture ? substituteFixture(gate.steps, FIXTURE_RUN_NAME) : gate.steps),
    ];

    let steps: RenderedStep[];
    try {
      steps = renderScenario(intents, elements);
    } catch (err) {
      rejected.push({
        name, stage: 'render',
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    facts.push({
      name,
      page: dossier.urlNormalized,
      rationale: String(fact.rationale ?? '').slice(0, 300),
      bodyIntents: gate.steps,
      intents,
      steps,
      selectorSeeds: collectSelectorSeeds(intents, steps, elements),
      gotoUrl,
      hops,
      interactive: gate.steps.some((s) => STATE_CHANGING.has(s.action)),
      usesFixture,
      ...(usesFixture ? { fixtureIntents: fixture! } : {}),
    });
  }

  params.obs.log('info', 'testwriter.transcribe_page', {
    page: dossier.urlNormalized, raw: raw.length, kept: facts.length, rejected: rejected.length,
    lenses: lenses.length, fixture: fixture !== null,
  });
  return { facts, rejected };
}

/**
 * The conventions ledger — Stage 1 of the agentic shape, in-run only.
 *
 * Everything the calibration (journey) phase paid to learn, boiled down to
 * lines a transcriber can obey. Sources: the per-page lesson map the rounds
 * maintain, plus validation/judge rejection reasons. Memoryless by
 * construction: built from THIS run's rounds and nothing else.
 */
export function buildConventions(
  lessonsByPage: Map<string, string[]>,
  rejections: ScenarioRejection[],
  cap = 12,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (line: string): void => {
    const key = line.toLowerCase().slice(0, 120);
    if (seen.has(key) || out.length >= cap) return;
    seen.add(key);
    out.push(line.slice(0, 220));
  };

  for (const [page, lessons] of lessonsByPage) {
    for (const lesson of lessons) add(`On ${page}: ${lesson}`);
  }
  for (const r of rejections) {
    if (r.stage !== 'validation' && r.stage !== 'judge') continue;
    // Only lessons with content — same rule the round bookkeeping applies.
    if (!/produced only|refused|message|nothing on the page changed|did not offer/i.test(r.reason)) continue;
    add(`"${r.name}" failed: ${r.reason}`);
  }
  return out;
}

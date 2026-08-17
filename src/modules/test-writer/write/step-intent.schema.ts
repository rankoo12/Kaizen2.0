import { z } from 'zod';
import type { StepIntent } from '../../../types/test-writer';
import { isRoleCompatible } from '../../element-resolver/action-role-filter';

/**
 * Schema/reference gate — the cheapest gate, and the one that makes
 * hallucinated elements a structural impossibility rather than a runtime
 * surprise. Spec: docs/specs/test-writer/spec-generation-pipeline.md §4.1
 */

const elementTarget = z.object({
  kind: z.literal('element'),
  elementId: z.string().uuid(),
});

const descriptionTarget = z.object({
  kind: z.literal('description'),
  description: z.string().min(3).max(120),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Infer the missing discriminator rather than rejecting over it.
 *
 * The gate must be uncompromising about GROUNDING — an element id nobody
 * observed is a hallucination and stays fatal. But a target that names a real
 * id and merely omits `kind` is unambiguous, and failing it burns a repair
 * round on a shape question instead of a substance one. Found by calibration:
 * whole scenarios were dying to "Invalid discriminator value".
 */
const anyTarget = z.preprocess((raw) => {
  if (typeof raw === 'string') {
    return UUID_RE.test(raw)
      ? { kind: 'element', elementId: raw }
      : { kind: 'description', description: raw };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    // Re-infer whenever `kind` is missing OR is a value the union doesn't know
    // (models invent "elementId", "target", "css"). The payload says which it is.
    const known = obj.kind === 'element' || obj.kind === 'description';
    if (!known) {
      if (typeof obj.elementId === 'string') return { kind: 'element', elementId: obj.elementId };
      if (typeof obj.description === 'string') return { kind: 'description', description: obj.description };
    }
  }
  return raw;
}, z.discriminatedUnion('kind', [elementTarget, descriptionTarget]));

export const StepIntentSchema: z.ZodType<StepIntent> = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), url: z.string().url() }),
  z.object({ action: z.enum(['go_back', 'go_forward', 'reload', 'close_tab']) }),
  z.object({ action: z.literal('switch_tab'), value: z.string().min(1).max(60) }),
  z.object({
    action: z.enum(['click', 'double_click', 'right_click', 'hover', 'check', 'uncheck', 'clear']),
    target: anyTarget,
  }),
  z.object({
    action: z.enum(['type', 'select']),
    target: anyTarget,
    value: z.string().max(200),
  }),
  z.object({ action: z.literal('drag_and_drop'), target: anyTarget, destination: anyTarget }),
  z.object({
    action: z.literal('click_random'),
    description: z.string().min(3).max(120),
    // 'selectedItem' is the canonical capture name the compiler and the catalog
    // both assume — defaulting it beats failing a scenario over a field whose
    // value was never in question.
    captureAs: z.string().min(1).max(40).default('selectedItem'),
  }),
  z.object({
    action: z.enum(['assert_visible', 'assert_not_visible', 'assert_enabled', 'assert_disabled', 'assert_checked']),
    target: anyTarget,
  }),
  z.object({
    action: z.enum(['assert_text', 'assert_not_text']),
    value: z.string().min(1).max(200),
    target: anyTarget.optional(),
  }),
  z.object({ action: z.enum(['assert_url', 'assert_title']), value: z.string().min(1).max(200) }),
  z.object({
    action: z.literal('assert_attribute'),
    target: anyTarget,
    attribute: z.string().min(1).max(40),
    expected: z.string().max(200),
  }),
  z.object({ action: z.literal('press_key'), value: z.string().min(1).max(30) }),
  z.object({ action: z.literal('wait'), value: z.string().regex(/^\d{2,5}$/) }),
  z.object({ action: z.literal('scroll'), target: anyTarget.optional() }),
]) as z.ZodType<StepIntent>;

// Actions that change page state — a discover oracle is only legitimate when it
// follows one of these (there is nothing to "discover" after a mere navigation
// the crawler already surveyed).
const STATE_CHANGING = new Set([
  'click', 'double_click', 'right_click', 'type', 'select', 'check', 'uncheck',
  'clear', 'press_key', 'click_random', 'drag_and_drop', 'upload',
]);

const ASSERTIONS = new Set([
  'assert_visible', 'assert_not_visible', 'assert_enabled', 'assert_disabled',
  'assert_checked', 'assert_text', 'assert_not_text', 'assert_url',
  'assert_title', 'assert_attribute', 'assert_count',
]);

export function isAssertion(action: string): boolean {
  return ASSERTIONS.has(action);
}

/** True when the nearest non-assertion step before `index` changes page state. */
function followsStateChange(steps: StepIntent[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    if (isAssertion(steps[i].action)) continue;
    return STATE_CHANGING.has(steps[i].action);
  }
  return false;
}

export type SchemaGateResult =
  | { ok: true; steps: StepIntent[] }
  | { ok: false; errors: string[] };

/** Literal-credential patterns that must be seed tokens instead. */
const LITERAL_CREDENTIAL = /^(?:[\w.+-]+@[\w-]+\.\w{2,}|.*(?:passw|secret|api[_-]?key).*)$/i;

/**
 * Validates shape, grounding, and the description-variant exemptions.
 *
 * Description targets are permitted in exactly two places (spec §3):
 *   (a) click_random — it names a CLASS of elements by design;
 *   (b) an assertion that DIRECTLY follows a state-changing action — the
 *       discover oracle, because recon never submits forms and so can never
 *       have observed a post-submit success banner or validation error.
 * Everything else must cite a crawled page_elements id.
 */
export function runSchemaGate(
  rawSteps: unknown,
  validElementIds: Set<string>,
  maxSteps: number,
  /** page_elements.id → ARIA role, for action/role compatibility. */
  rolesById: Map<string, string> = new Map(),
  /** Seed tokens the run will actually provide ({{email}}, {{password}}, …). */
  seedTokens: string[] = [],
): SchemaGateResult {
  const errors: string[] = [];

  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { ok: false, errors: ['scenario has no steps'] };
  }
  if (rawSteps.length > maxSteps) {
    errors.push(`scenario has ${rawSteps.length} steps (max ${maxSteps})`);
  }

  const steps: StepIntent[] = [];
  rawSteps.forEach((raw, index) => {
    const parsed = StepIntentSchema.safeParse(recoverTruncatedIds(raw, validElementIds));
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      errors.push(`step ${index + 1}: invalid intent (${detail})`);
      return;
    }
    steps.push(parsed.data);
  });

  if (errors.length > 0) return { ok: false, errors };

  steps.forEach((step, index) => {
    const targets = collectTargets(step);
    for (const target of targets) {
      if (target.kind === 'element') {
        if (!validElementIds.has(target.elementId)) {
          errors.push(
            `step ${index + 1}: elementId ${target.elementId} was never observed on the target pages — ` +
            'cite an id from the supplied element list',
          );
          continue;
        }
        // Existing ≠ usable. A generator handed a page whose real input sits
        // behind a modal will otherwise "type" into the nearest link, which
        // silently no-ops at run time and fails the next assertion instead.
        const role = rolesById.get(target.elementId);
        if (role && !isRoleCompatible(step.action, role)) {
          errors.push(
            `step ${index + 1}: cannot ${step.action} a "${role}" element — ` +
            'cite an element whose role supports this action, or drop the step',
          );
        }
        continue;
      }
      // Description target — allowed only under the two exemptions.
      if (step.action === 'click_random') continue;
      // "Following a state-changing action" means the assertion BLOCK after it:
      // click Remove → verify the item is gone → verify the empty-cart message.
      // The second assertion is as much a discover oracle as the first — it
      // still describes a state only that action can produce. Requiring the
      // action to be the IMMEDIATELY previous step killed "Remove item from
      // cart" and "Empty cart prevents checkout" twice each on saucedemo, for
      // writing two assertions in a row.
      const isDiscoverOracle = isAssertion(step.action) && followsStateChange(steps, index);
      if (!isDiscoverOracle) {
        errors.push(
          `step ${index + 1}: description target "${target.description}" is only allowed for ` +
          'click_random or for an assertion following a state-changing action',
        );
      }
    }

    // Typed identity data must be a seed token, never a literal.
    if ((step.action === 'type' || step.action === 'select') && step.value) {
      const hasToken = /\{\{[\w]+\}\}/.test(step.value);
      const looksLikeCredential = LITERAL_CREDENTIAL.test(step.value.trim());
      if (!hasToken && looksLikeCredential && !isDeliberatelyInvalid(step.value)) {
        errors.push(
          `step ${index + 1}: literal credential "${step.value}" — use a seed token such as {{email}}`,
        );
      }
    }
  });

  // Unbound placeholders. A catalog skeleton speaks in {slots} and {{tokens}};
  // if one survives into a step verbatim, the test types the placeholder itself
  // and quietly asserts nothing real. Only run-provided seeds and this
  // scenario's own captures are legitimate.
  const captured = new Set(
    steps.filter((s): s is Extract<StepIntent, { action: 'click_random' }> => s.action === 'click_random')
      .map((s) => s.captureAs),
  );
  const known = new Set([...seedTokens, ...captured]);
  steps.forEach((step, index) => {
    const value = 'value' in step ? step.value : undefined;
    if (typeof value !== 'string') return;
    for (const match of value.matchAll(/\{\{(\w+)\}\}/g)) {
      if (known.size > 0 && !known.has(match[1])) {
        errors.push(
          `step ${index + 1}: "{{${match[1]}}}" is not a run variable — bind it to a real value ` +
          `or use one of: ${[...known].join(', ')}`,
        );
      }
    }
    // Unbound skeleton slots ({like_this}) never belong in a finished step.
    const slot = value.match(/\{([a-z_]+)\}/);
    if (slot && !value.includes(`{{${slot[1]}}}`)) {
      errors.push(`step ${index + 1}: unbound placeholder "${slot[0]}" — bind it to a real value`);
    }
  });

  // A scenario must end on an assertion: without one it proves nothing.
  const last = steps[steps.length - 1];
  if (last && !isAssertion(last.action)) {
    errors.push('scenario does not end with an assertion — it would prove nothing');
  }

  errors.push(...findUnfalsifiableOracles(steps));

  return errors.length > 0 ? { ok: false, errors } : { ok: true, steps };
}

/**
 * Oracles that are true by construction — rejected at authoring time.
 * Spec: docs/specs/test-writer/spec-validation-trust.md §4
 *
 * These three shapes all validated GREEN against the live product and proved
 * nothing. They are cheap to describe and impossible for a run to disprove,
 * which is exactly why the gate has to be the thing that stops them: no amount
 * of executing an unfalsifiable assertion turns it into evidence.
 */
function findUnfalsifiableOracles(steps: StepIntent[]): string[] {
  const errors: string[] = [];
  const typed: Array<{ index: number; value: string; elementId: string | null }> = [];
  let inForceUrl: string | null = null;

  steps.forEach((step, index) => {
    if (step.action === 'navigate') {
      inForceUrl = step.url;
      return;
    }
    if (step.action === 'type' || step.action === 'select') {
      const target = 'target' in step ? step.target : undefined;
      typed.push({
        index,
        value: step.value,
        elementId: target?.kind === 'element' ? target.elementId : null,
      });
      return;
    }
    if (!isAssertion(step.action)) return;

    const target = 'target' in step ? step.target : undefined;
    const value = 'value' in step ? step.value : undefined;

    // (1) Typed-value assert — asserting text this scenario just typed. The
    //     engine scans input values, so unless the assertion reads a DIFFERENT
    //     element it can only ever confirm the typing worked.
    if (typeof value === 'string' && (step.action === 'assert_text' || step.action === 'assert_visible')) {
      const echoed = typed.find((t) => t.value.trim().toLowerCase() === value.trim().toLowerCase());
      const readsElsewhere =
        target?.kind === 'element' && echoed?.elementId != null && target.elementId !== echoed.elementId;
      if (echoed && !readsElsewhere) {
        errors.push(
          `step ${index + 1}: asserts "${value}", the same text step ${echoed.index + 1} typed — ` +
          'assert the effect of the input (a result, a message, a count), not the input itself',
        );
      }
    }

    // (2) Disjunction oracle — "the results or no-results header" holds in
    //     every possible state of the page, including the broken ones.
    if (target?.kind === 'description' && /\b(?:or|either)\b/i.test(target.description)) {
      errors.push(
        `step ${index + 1}: "${target.description}" accepts either outcome, so it holds however the ` +
        'app behaves — name the single state this scenario expects',
      );
    }

    // (3) Tautological assert_url — the URL was already what it asserts,
    //     because this scenario navigated there and nothing since could move it.
    //     Only judged when a navigate established the URL; with an unknown
    //     starting URL there is nothing to compare against.
    if (step.action === 'assert_url' && inForceUrl && typeof value === 'string') {
      const movedSince = steps.slice(0, index).some((s, i) =>
        i > steps.slice(0, index).map((x) => x.action).lastIndexOf('navigate')
        && (s.action === 'click' || s.action === 'click_random' || s.action === 'press_key'
          || s.action === 'go_back' || s.action === 'go_forward' || s.action === 'double_click'));
      if (!movedSince && inForceUrl.toLowerCase().includes(value.trim().toLowerCase())) {
        errors.push(
          `step ${index + 1}: the url already contained "${value}" when this scenario navigated to ` +
          `${inForceUrl} and nothing since could have changed it — assert a url the scenario reaches`,
        );
      }
    }
  });

  return errors;
}

/**
 * A model that copies a 36-char id by hand sometimes drops a character
 * ("251524f-…" for "251524fa-…"). Grounding stays uncompromising — an id that
 * matches NOTHING is still fatal — but a value that is the unique prefix (≥ 8
 * chars) of exactly one real id is that id, and failing the whole scenario over
 * a dropped hex digit spent two writer calls on saucedemo to reject a scenario
 * whose every other step was grounded.
 */
export function recoverTruncatedIds(raw: unknown, validElementIds: Set<string>): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const step = { ...(raw as Record<string, unknown>) };
  for (const key of ['target', 'destination'] as const) {
    const t = step[key];
    if (typeof t === 'string') { step[key] = recoverOne(t, validElementIds); continue; }
    if (t && typeof t === 'object' && typeof (t as Record<string, unknown>).elementId === 'string') {
      step[key] = { ...(t as Record<string, unknown>), elementId: recoverOne((t as Record<string, string>).elementId, validElementIds) };
    }
  }
  return step;
}

function recoverOne(value: string, validElementIds: Set<string>): string {
  if (UUID_RE.test(value)) return value;
  const needle = value.trim().toLowerCase().replace(/[…\.]+$/, '');
  if (needle.length < 8) return value;
  let hit: string | null = null;
  for (const id of validElementIds) {
    if (id.toLowerCase().startsWith(needle)) {
      if (hit) return value;   // ambiguous — leave it, and let grounding fail it
      hit = id;
    }
  }
  return hit ?? value;
}

/** Negative tests legitimately type malformed values ("not-an-email"). */
function isDeliberatelyInvalid(value: string): boolean {
  return /^(not-an-email|invalid|wrong-|bad-|abc)$/i.test(value.trim()) || value.startsWith('wrong-');
}

export function collectTargets(step: StepIntent): Array<
  { kind: 'element'; elementId: string } | { kind: 'description'; description: string }
> {
  const out: ReturnType<typeof collectTargets> = [];
  if ('target' in step && step.target) out.push(step.target);
  if ('destination' in step && step.destination) out.push(step.destination);
  return out;
}

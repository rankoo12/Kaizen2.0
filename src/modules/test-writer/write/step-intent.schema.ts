import { z } from 'zod';
import type { StepIntent } from '../../../types/test-writer';

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

const anyTarget = z.discriminatedUnion('kind', [elementTarget, descriptionTarget]);

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
    captureAs: z.string().min(1).max(40),
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
    const parsed = StepIntentSchema.safeParse(raw);
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
        }
        continue;
      }
      // Description target — allowed only under the two exemptions.
      if (step.action === 'click_random') continue;
      const previous = steps[index - 1];
      const isDiscoverOracle =
        isAssertion(step.action) && previous !== undefined && STATE_CHANGING.has(previous.action);
      if (!isDiscoverOracle) {
        errors.push(
          `step ${index + 1}: description target "${target.description}" is only allowed for ` +
          'click_random or for an assertion directly following a state-changing action',
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

  // A scenario must end on an assertion: without one it proves nothing.
  const last = steps[steps.length - 1];
  if (last && !isAssertion(last.action)) {
    errors.push('scenario does not end with an assertion — it would prove nothing');
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, steps };
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

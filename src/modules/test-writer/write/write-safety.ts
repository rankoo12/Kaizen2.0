import type { GroundingElement, StepIntent } from '../../../types/test-writer';
import { describeTarget } from './canonical-templates';

/**
 * Graduated safety filter for GENERATED tests.
 * Spec: docs/specs/test-writer/spec-generation-pipeline.md §4.2
 *
 * Deliberately NOT recon's lexicon: the crawler's rules exist to keep a robot
 * from touching anything while exploring, and reusing them here would block
 * checkout / save / confirm — precisely the journeys worth testing. A generated
 * test is a considered, consented action, so the split is three-way:
 *
 *   hard-block     — irreversible or costly. Never generated, consent or not.
 *   synthetic-safe — creates throwaway records with per-run unique seed data.
 *                    Requires the suite's allow_synthetic_data consent.
 *   allowed        — everything else.
 *
 * Note the role-based rule from recon (checkbox/radio/switch = mutating) does
 * NOT apply here: "check the terms box" is a legitimate, necessary test step.
 */

/** Irreversible / costly actions. Never generated under safeMode. */
const HARD_BLOCK = [
  'pay', 'payment', 'purchase', 'buy now', 'place order', 'complete order',
  'delete', 'remove account', 'close account', 'deactivate', 'terminate',
  'transfer', 'withdraw', 'refund', 'publish', 'unpublish', 'send message',
  'cancel subscription', 'cancel order', 'downgrade', 'upgrade plan',
] as const;

/**
 * Additional blocks that apply only when the proving run will execute as a real
 * SIGNED-IN user (spec-authenticated-scope.md §6.5).
 *
 * The list above was calibrated for anonymous/throwaway scope, where "remove"
 * means "remove from cart" and nothing has an owner. Behind a login wall the
 * same words act on a real account: a step grounded on /members — click the
 * "Remove" button next to a teammate — or on /api-keys — click "Revoke" —
 * classifies as `allowed` today, not even consent-gated, and is then executed
 * for real by the validation run.
 *
 * Kept separate rather than merged so public-scope generation can still write
 * the cart and checkout journeys that make the product worth using.
 */
const HARD_BLOCK_AUTHENTICATED = [
  'remove', 'revoke', 'disable', 'reset', 'rotate', 'invite', 'archive',
  'leave', 'change password', 'change email', 'transfer ownership', 'suspend',
  'unlink', 'disconnect', 'regenerate',
] as const;

/** Creates a real record, but a disposable one keyed to per-run seed data. */
const SYNTHETIC = [
  'sign up', 'signup', 'register', 'create account', 'join',
  'add to cart', 'add to bag', 'add to basket', 'subscribe', 'newsletter',
  'submit', 'send', 'save', 'apply', 'post', 'book', 'reserve', 'contact',
] as const;

export type SafetyDecision =
  | { verdict: 'allowed' }
  | { verdict: 'blocked'; reason: string }
  | { verdict: 'needs-consent'; reason: string };

function matches(haystack: string, needles: readonly string[]): string | null {
  const text = haystack.toLowerCase();
  return needles.find((n) => text.includes(n)) ?? null;
}

/** Actions that actually DO something — assertions are always safe. */
const ACTING = new Set([
  'click', 'double_click', 'right_click', 'click_random', 'check', 'uncheck',
  'select', 'drag_and_drop', 'press_key', 'upload',
]);

/**
 * Classify one scenario's steps. The decision is taken on the ACTION plus the
 * element's accessible name — far more precise than matching a rendered
 * sentence, which mixes the verb with the element label.
 */
export function classifyScenarioSafety(
  steps: StepIntent[],
  elements: Map<string, GroundingElement>,
  opts: { safeMode: boolean; stopBeforeMoney: boolean; authenticated?: boolean },
): SafetyDecision {
  let needsConsent: string | null = null;
  const hardBlock = opts.authenticated
    ? [...HARD_BLOCK, ...HARD_BLOCK_AUTHENTICATED]
    : HARD_BLOCK;

  for (const step of steps) {
    if (!ACTING.has(step.action)) continue;

    // What the step is about to activate, in the user's words.
    const label = 'target' in step && step.target
      ? describeTarget(step.target, elements)
      : step.action === 'click_random'
        ? step.description
        : '';
    const subject = `${label} ${'value' in step ? step.value ?? '' : ''}`;

    const blocked = matches(subject, hardBlock);
    if (blocked && opts.safeMode) {
      return {
        verdict: 'blocked',
        reason: `step activates "${blocked}" — irreversible or costly actions are never generated`,
      };
    }
    // A checkout scenario may walk TO payment; it may never press the button.
    if (blocked && opts.stopBeforeMoney) {
      return {
        verdict: 'blocked',
        reason: `checkout scenarios must stop before the payment step (matched "${blocked}")`,
      };
    }

    const synthetic = matches(subject, SYNTHETIC);
    if (synthetic) needsConsent ??= synthetic;
  }

  if (needsConsent) {
    // Behind auth, SYNTHETIC changes meaning. `allow_synthetic_data` was
    // consented to as "may create throwaway records"; signed in, submit/save/
    // apply overwrite the account's REAL settings. P3 does not silently
    // reinterpret that grant — these are proposed unvalidated regardless of the
    // suite flag, and lifting it needs its own consent (spec §6.5, §7).
    if (opts.authenticated) {
      return {
        verdict: 'needs-consent',
        reason: `would submit or save as the signed-in user via "${needsConsent}"`,
      };
    }
    return {
      verdict: 'needs-consent',
      reason: `creates throwaway data via "${needsConsent}"`,
    };
  }
  return { verdict: 'allowed' };
}

export { HARD_BLOCK, HARD_BLOCK_AUTHENTICATED, SYNTHETIC };

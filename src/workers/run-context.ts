import type { RunContext, StepAST } from '../types';

/**
 * Run-scoped variable capture + interpolation.
 *
 * Steps are otherwise stateless: each compiles and executes independently. This
 * module gives a run a small key/value memory so one step can capture a value
 * (e.g. the name of a randomly-chosen product) and a later step can assert
 * against it via a `{{name}}` token.
 *
 * Spec: docs/specs/workers/spec-engine-capabilities-assert-random-capture.md §3
 */

const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

export function createRunContext(): RunContext {
  return { variables: {} };
}

/**
 * Replace `{{name}}` tokens in a string with values from the run context.
 * Unknown variables pass through literally (e.g. `{{missing}}`) so a downstream
 * assertion fails loudly with a readable message rather than silently matching
 * an empty string.
 */
export function interpolate(s: string | null, ctx: RunContext): string | null {
  if (s == null) return s;
  return s.replace(TOKEN_RE, (_match, name: string) =>
    Object.prototype.hasOwnProperty.call(ctx.variables, name)
      ? ctx.variables[name]
      : `{{${name}}}`,
  );
}

/**
 * Return a copy of the step with `{{var}}` tokens in value and targetDescription
 * resolved against the run context. Other fields are untouched. Returns the same
 * reference when neither field contains a token (no allocation in the common case).
 */
export function interpolateStep(step: StepAST, ctx: RunContext): StepAST {
  const value = interpolate(step.value, ctx);
  const targetDescription = interpolate(step.targetDescription, ctx);
  if (value === step.value && targetDescription === step.targetDescription) {
    return step;
  }
  return { ...step, value, targetDescription };
}

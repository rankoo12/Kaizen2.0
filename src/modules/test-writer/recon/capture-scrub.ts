import type { CandidateNode } from '../../../types';
import type { FormCapture, PageCapture } from '../interfaces';
import { scrubSecrets } from '../brief-intake';

/**
 * Redacts secrets and personal data out of a captured page before it is stored
 * or reaches any prompt.
 * Spec: docs/specs/test-writer/spec-authenticated-scope.md §5.2 (Tier B)
 *
 * The product already owns a scrubber — `scrubSecrets`, built for the Init
 * Brief because people paste credentials into free-text boxes. Crawled content
 * was never run through it, which was fine while the crawler only ever saw
 * public marketing pages. Signed in, a settings or members page renders real
 * names, emails and tokens, and ordinary capture writes those into
 * `page_elements`, into `ax_outline`, and then into the classifier prompt.
 *
 * Tier A pages avoid this entirely by not being captured. Tier B pages are
 * captured — their structure is genuinely useful to COMPREHEND — but scrubbed
 * first. What survives is shape ("a table of members with a Remove button"),
 * not content ("ada@example.com").
 */

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Phone-ish and card-ish runs: 9+ digits with optional separators. Deliberately
// broad — an over-redacted order number costs nothing, a leaked card does not.
const LONG_DIGITS = /\b(?:\d[ -]?){9,}\d\b/g;
const REDACTED = '[redacted]';

/** Scrubs one free-text string: known secret patterns, then emails and digit runs. */
export function scrubText(input: string): string {
  if (!input) return input;
  const { text } = scrubSecrets(input);
  return text.replace(EMAIL, REDACTED).replace(LONG_DIGITS, REDACTED);
}

function scrubNode(node: CandidateNode): CandidateNode {
  return {
    ...node,
    name: scrubText(node.name ?? ''),
    textContent: scrubText(node.textContent ?? ''),
    // Attribute VALUES can carry the same data (placeholder="ada@example.com",
    // value="4111 1111 1111 1111"); keys are structural and stay.
    attributes: Object.fromEntries(
      Object.entries(node.attributes ?? {}).map(([k, v]) => [
        k, typeof v === 'string' ? scrubText(v) : v,
      ]),
    ),
  };
}

function scrubForm(form: FormCapture): FormCapture {
  return {
    ...form,
    label: scrubText(form.label ?? ''),
    submitLabel: scrubText(form.submitLabel ?? ''),
    fields: (form.fields ?? []).map((f) => ({
      ...f,
      label: scrubText(f.label ?? ''),
      // Placeholders are the classic leak: "ada@example.com" as example text.
      placeholder: scrubText(f.placeholder ?? ''),
    })),
  };
}

/**
 * Returns a scrubbed copy of a capture. Structure, roles, selectors and link
 * targets are untouched — only human-readable content is redacted.
 */
export function scrubCapture(
  capture: PageCapture & { axOutline?: Record<string, unknown> },
): PageCapture & { axOutline?: Record<string, unknown> } {
  const scrubbed: PageCapture & { axOutline?: Record<string, unknown> } = {
    ...capture,
    title: scrubText(capture.title ?? ''),
    headings: (capture.headings ?? []).map(scrubText),
    survey: (capture.survey ?? []).map(scrubNode),
    forms: (capture.forms ?? []).map(scrubForm),
  };
  if (capture.axOutline) {
    // The outline is the exact structure sent to the classifier — scrub it by
    // round-tripping, so a shape change here can never silently unredact it.
    scrubbed.axOutline = JSON.parse(
      JSON.stringify(capture.axOutline, (key, value) =>
        typeof value === 'string' && key !== 'type' ? scrubText(value) : value),
    );
  }
  return scrubbed;
}

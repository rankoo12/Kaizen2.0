import type { FailureClass, AXNode } from '../../types';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/**
 * FailureClassifier — Spec ref: Section 11
 *
 * Three-signal classification system:
 *   Signal A — Playwright error subtype
 *   Signal B — AX tree diff (before vs after failure)
 *   Signal C — Screenshot pixel diff (failure vs last-known-good)
 *
 * The three signals are combined using the decision table from the spec to
 * produce a single FailureClass that drives which healing strategy is applied.
 */

// ─── Signal A ─────────────────────────────────────────────────────────────────

export type ErrorSignal =
  | 'ElementNotFoundError'
  | 'StaleElementError'
  | 'TimeoutError'
  | 'NavigationError'
  | 'AssertionError'
  | 'Unknown';

export function classifyErrorSignal(error: Error): ErrorSignal {
  const msg = error.message.toLowerCase();
  const name = error.name?.toLowerCase() ?? '';

  if (name.includes('timeout') || msg.includes('timeout')) return 'TimeoutError';
  if (name.includes('navigation') || msg.includes('navigation')) return 'NavigationError';
  if (name.includes('assertion') || msg.includes('assert')) return 'AssertionError';
  // Playwright uses "locator.xxx: Error: strict mode violation" or "waiting for locator"
  if (msg.includes('strict mode') || msg.includes('waiting for locator') || msg.includes('not found')) {
    return 'ElementNotFoundError';
  }
  if (msg.includes('stale') || msg.includes('detached')) return 'StaleElementError';
  return 'Unknown';
}

// ─── Signal B ─────────────────────────────────────────────────────────────────

export type DOMSignal =
  | 'SelectorGone'
  | 'AttrsChanged'
  | 'SelectorPresent'
  | 'SparsePage';


/**
 * Compares AX tree snapshots taken before the step and immediately after failure.
 * Returns a DOM signal describing how the tree changed relative to the failing selector.
 */
export function classifyDOMSignal(
  axBefore: AXNode | null,
  axAfter: AXNode | null,
  previousSelector: string,
): DOMSignal {
  // page.accessibility.snapshot() is deprecated in Playwright 1.44+ and can
  // return null even on fully loaded pages. Only treat a null/sparse axAfter as
  // SparsePage when axBefore was also populated — meaning the tree was readable
  // before the step but vanished after, which is a genuine page-unload signal.
  // If both are null the AX API is simply unavailable; fall through to other signals.
  if (axBefore !== null && (!axAfter || countNodes(axAfter) < 5)) return 'SparsePage';

  const beforeNames = collectNames(axBefore);
  const afterNames = collectNames(axAfter);

  // Use selector or a heuristic derived from it as the target identifier
  const targetName = selectorToName(previousSelector);

  if (targetName && !afterNames.has(targetName)) return 'SelectorGone';

  // If the selector's associated node changed (different attributes/roles visible)
  if (beforeNames.size > 0 && afterNames.size > 0) {
    const disappeared = [...beforeNames].filter((n) => !afterNames.has(n)).length;
    const ratio = disappeared / beforeNames.size;
    if (ratio > 0.3) return 'AttrsChanged';
  }

  return 'SelectorPresent';
}

function countNodes(node: AXNode): number {
  return 1 + (node.children ?? []).reduce((sum, c) => sum + countNodes(c), 0);
}

function collectNames(node: AXNode | null): Set<string> {
  const names = new Set<string>();
  if (!node) return names;
  const visit = (n: AXNode) => {
    if (n.name) names.add(n.name.trim().toLowerCase());
    (n.children ?? []).forEach(visit);
  };
  visit(node);
  return names;
}

/** Derive a fuzzy name hint from a CSS/XPath selector for DOM presence checks. */
function selectorToName(selector: string): string | null {
  // aria-label="Submit" → "submit"
  const ariaMatch = selector.match(/aria-label="([^"]+)"/i);
  if (ariaMatch) return ariaMatch[1].toLowerCase();
  // text="Add to Cart" → "add to cart"
  const textMatch = selector.match(/text="([^"]+)"/i);
  if (textMatch) return textMatch[1].toLowerCase();
  return null;
}

// ─── Signal C ─────────────────────────────────────────────────────────────────

export type ScreenshotSignal = 'HighSimilarity' | 'PartialChange' | 'LowSimilarity' | 'Unavailable';

/**
 * Compares two PNG screenshots and returns a similarity signal.
 * Uses pixelmatch for pixel-level diff — runs locally, no LLM cost.
 *
 * Thresholds (per spec Section 11):
 *   > 95% similar → HighSimilarity  (TIMING / ELEMENT_OBSCURED)
 *   60–95%        → PartialChange   (ELEMENT_MUTATED / ELEMENT_REMOVED)
 *   < 60%         → LowSimilarity   (PAGE_NOT_LOADED / LOGIC_FAILURE)
 */
export function classifyScreenshotSignal(
  failurePng: Buffer | null,
  lastGoodPng: Buffer | null,
): ScreenshotSignal {
  if (!failurePng || !lastGoodPng) return 'Unavailable';

  try {
    const imgA = PNG.sync.read(failurePng);
    const imgB = PNG.sync.read(lastGoodPng);

    // If dimensions differ the page layout changed significantly
    if (imgA.width !== imgB.width || imgA.height !== imgB.height) return 'LowSimilarity';

    const totalPixels = imgA.width * imgA.height;
    const diffPixels = pixelmatch(imgA.data, imgB.data, null, imgA.width, imgA.height, {
      threshold: 0.1,
    });

    const similarity = 1 - diffPixels / totalPixels;

    if (similarity > 0.95) return 'HighSimilarity';
    if (similarity >= 0.6) return 'PartialChange';
    return 'LowSimilarity';
  } catch {
    return 'Unavailable';
  }
}

// ─── Decision table ───────────────────────────────────────────────────────────

/**
 * Combines all three signals into a FailureClass per the spec decision table (Section 11).
 */
export function classify(
  error: Error,
  axBefore: AXNode | null,
  axAfter: AXNode | null,
  previousSelector: string,
  failurePng: Buffer | null,
  lastGoodPng: Buffer | null,
): FailureClass {
  const sigA = classifyErrorSignal(error);
  const sigB = classifyDOMSignal(axBefore, axAfter, previousSelector);
  const sigC = classifyScreenshotSignal(failurePng, lastGoodPng);

  // AssertionError always → LOGIC_FAILURE regardless of other signals
  if (sigA === 'AssertionError') return 'LOGIC_FAILURE';

  // Sparse AX tree → page didn't load
  if (sigB === 'SparsePage') return 'PAGE_NOT_LOADED';

  // NavigationError + sparse visual → PAGE_NOT_LOADED
  if (sigA === 'NavigationError') return 'PAGE_NOT_LOADED';

  // Selector gone → ELEMENT_REMOVED
  if (sigB === 'SelectorGone') return 'ELEMENT_REMOVED';

  // Attributes changed → ELEMENT_MUTATED
  if (sigB === 'AttrsChanged') return 'ELEMENT_MUTATED';

  // Selector still present — distinguish TIMING vs ELEMENT_OBSCURED via screenshot
  if (sigB === 'SelectorPresent') {
    if (sigC === 'HighSimilarity' || sigC === 'Unavailable') return 'TIMING';
    if (sigC === 'PartialChange') return 'ELEMENT_OBSCURED';
    return 'TIMING';
  }

  // Partial screenshot change without clear DOM signal → ELEMENT_MUTATED
  if (sigC === 'PartialChange') return 'ELEMENT_MUTATED';
  if (sigC === 'LowSimilarity') return 'PAGE_NOT_LOADED';

  // Default
  return 'TIMING';
}

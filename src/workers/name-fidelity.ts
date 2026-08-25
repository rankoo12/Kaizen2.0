/**
 * A step that NAMES its target in quotes is explicit; the resolved element must
 * carry that name. Split from worker.ts (which starts its BullMQ consumer at
 * import) so the rules are unit-testable.
 * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md
 */

/** The double-quoted name in a step's target, if any: `the "Save" button` → Save. */
export function quotedName(target: string | null | undefined): string | null {
  if (!target) return null;
  const m = /["“”]([^"“”]{1,80})["“”]/.exec(target);
  return m ? m[1].trim() : null;
}

/**
 * Whether a resolved element's descriptor agrees with the quoted name. One shared
 * word is NOT agreement: "Demo 0" resolved to the account button "DU Demo user"
 * and "Suite Checkout smoke Demo" to the "New suite" button, each through a single
 * common word, and run 9 lost four reference-plan criticals to it. The MAJORITY of
 * the quoted name's words (single characters included — the "0" is what separates
 * "Demo 0" from "Demo user") must appear in the descriptor.
 */
export function nameOverlaps(quoted: string, descriptor: string): boolean {
  const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'button', 'link', 'field']);
  const words = quoted.toLowerCase().split(/[^a-z0-9]+/).filter((w) => (w.length > 1 || /[0-9]/.test(w)) && !STOP.has(w));
  if (words.length === 0) return true;             // "⌘R" alone — nothing to check against
  const hay = descriptor.toLowerCase();
  const found = words.filter((w) => hay.includes(w)).length;
  return found / words.length > 0.5;
}

/**
 * A trailing standalone number on a control's name is usually a LIVE COUNT
 * badge ("Demo 5" = the Demo suite with 5 tests), and the run's own earlier
 * tests change it — six clicks died across runs 23–24 because the count moved
 * between crawl and validation. Drift is tolerated ONLY when BOTH names carry
 * a trailing count in the same position and the non-numeric residue matches:
 * "Demo 5" ↔ "Demo 6" agrees; "Demo 0" ↔ "DU Demo user" still does not (that
 * was run 9's false resolution, and it stays dead).
 * Interactions only — assertions keep strict matching, where false-pass risk lives.
 */
export function countDriftMatch(quoted: string, descriptor: string): boolean {
  const m = /^(.{2,}?)\s+\d+$/.exec(quoted.trim());
  if (!m) return false;
  const residue = m[1].trim();
  if (!residue || /\d$/.test(residue)) return false;
  const esc = residue
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return new RegExp(`${esc}\\s+\\d+`, 'i').test(descriptor);
}


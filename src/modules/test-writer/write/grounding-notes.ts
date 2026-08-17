import type { GroundingElement } from '../../../types/test-writer';

/**
 * What the target pages do NOT offer, said out loud.
 * Spec: docs/specs/test-writer/spec-judge-repair-loop.md §2.4
 *
 * The writer is handed a list of citable elements and a hard rule about role
 * compatibility (type → textbox, select → combobox, …). When the plan calls for
 * an input the pages simply don't have — a search test on an app with no search
 * box — a mini model does not conclude "there is no field"; it types into the
 * nearest link, fails the schema gate, is told why, and does it again. Six
 * writer calls on saucedemo went exactly this way.
 *
 * Telling it up front which action families are impossible on these pages is
 * free, deterministic, and turns "find something to type into" into "write the
 * closest scenario that does not type".
 */

const TYPEABLE = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
const SELECTABLE = new Set(['combobox', 'listbox']);
const CHECKABLE = new Set(['checkbox', 'radio', 'switch']);

export function groundingNotes(grounding: readonly GroundingElement[]): string[] {
  const roles = new Set(grounding.map((g) => g.role));
  const has = (set: Set<string>) => [...set].some((r) => roles.has(r));
  const notes: string[] = [];
  if (!has(TYPEABLE)) {
    notes.push(
      'There is NO typeable field (textbox, searchbox, combobox, spinbutton) on these pages. '
      + 'Do not include a type or clear step. If the scenario needs one it cannot be written as planned — '
      + 'write the closest scenario that does not type, or return fewer steps.',
    );
  }
  if (!has(SELECTABLE)) {
    notes.push('There is NO dropdown (combobox, listbox) on these pages. Do not include a select step.');
  }
  if (!has(CHECKABLE)) {
    notes.push('There is NO checkbox, radio or switch on these pages. Do not include a check or uncheck step.');
  }
  return notes;
}

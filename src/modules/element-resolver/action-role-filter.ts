/**
 * Action-Role Compatibility Filter
 *
 * Removes DOM candidates whose ARIA role is structurally incompatible with
 * the requested action, before those candidates are sent to the LLM or
 * scored for archetype matching.
 *
 * Why this matters:
 *   The DOM pruner returns every visible interactive element — buttons, links,
 *   inputs, checkboxes, etc. Without filtering, the LLM may pick an element
 *   whose role is semantically wrong for the action (e.g. role=link for a
 *   `type` action), producing a selector that validates against the live DOM
 *   but fails at execution time, or succeeds via a misidentified element.
 *
 * Filter behaviour:
 *   - For actions with a defined compatible role set, only candidates whose
 *     role is in that set are returned.
 *   - If filtering would leave zero candidates, the ORIGINAL list is returned
 *     unchanged so that custom components without standard ARIA roles are not
 *     silently discarded (the LLM's broader knowledge can still identify them).
 *   - For actions with no defined role constraint (click, navigate, wait, …)
 *     the list is returned as-is.
 */

import type { CandidateNode } from '../../types';

// ─── Role sets per action ─────────────────────────────────────────────────────

/**
 * Roles that support freeform text input via keyboard entry.
 * Includes standard form inputs, search inputs, and composite widgets.
 */
const TYPE_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',    // <input type="number">
]);

/**
 * Roles that represent binary toggle controls.
 */
const CHECK_ROLES = new Set([
  'checkbox',
  'radio',
  'switch',
  'menuitemcheckbox',
  'menuitemradio',
]);

/**
 * Roles that represent single-selection list controls.
 */
const SELECT_ROLES = new Set(['combobox', 'listbox']);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return the subset of `candidates` whose ARIA role is compatible with
 * `action`, falling back to the full list if no compatible candidate exists.
 */
export function filterCandidatesByAction(
  candidates: CandidateNode[],
  action: string,
): CandidateNode[] {
  const compatibleRoles = getRolesForAction(action);

  // No constraint defined for this action — pass everything through unchanged.
  if (compatibleRoles === null) return candidates;

  const filtered = candidates.filter((c) => compatibleRoles.has(c.role));

  // If filtering removes every candidate, fall back to the full list so the
  // resolver can still attempt to identify custom widgets (e.g. a rich-text
  // editor rendered as <div role="application"> with no explicit input role).
  if (filtered.length === 0) {
    return candidates;
  }

  return filtered;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRolesForAction(action: string): Set<string> | null {
  switch (action) {
    case 'type':
    case 'fill':
    case 'clear':
      return TYPE_ROLES;

    case 'check':
    case 'uncheck':
      return CHECK_ROLES;

    case 'select':
      return SELECT_ROLES;

    // click, navigate, press_key, wait, hover, scroll — any role is valid
    default:
      return null;
  }
}

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

/**
 * Well-known standard roles that are STRUCTURALLY incompatible with a text-entry
 * action — an element with one of these roles is never a freeform text field.
 * Used only in the fallback path (below) to refuse categorically-wrong targets
 * while still preserving custom/unknown-role widgets.
 *
 * Dogfood origin: on sites where the real search input is hidden behind a
 * responsive toggle (e.g. MDN), the type-role filter finds no textbox and falls
 * back to the full list — the LLM then "types" into a "Skip to search" LINK,
 * which silently no-ops and cascades into a failed assertion. Dropping these
 * roles turns that into a clean resolution failure instead of a phantom success.
 */
const TYPE_INCOMPATIBLE_ROLES = new Set([
  'link', 'button', 'checkbox', 'radio', 'switch', 'tab',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
  'heading', 'img', 'listbox', 'list', 'listitem',
]);

/**
 * Role compatibility, exposed for the Test Writer's schema gate so a generated
 * step can be refused at WRITE time rather than discovered at run time.
 *
 * Same defect class as the dogfood note above, one layer earlier: a generator
 * handed a page whose real input is hidden behind a modal will happily "type"
 * into the nearest link unless something says no.
 */
export function isRoleCompatible(action: string, role: string): boolean {
  switch (action) {
    case 'type':
    case 'clear':
      // Strict at generation time (unlike the resolver's permissive fallback):
      // the writer can see every element on the page, so "no text field here"
      // means omit the step, never approximate it with a form or a link.
      return TYPE_ROLES.has(role);
    case 'select':
      return SELECT_ROLES.has(role);
    case 'check':
    case 'uncheck':
      return CHECK_ROLES.has(role);
    case 'assert_checked':
    case 'assert_not_checked':
      return CHECK_ROLES.has(role);
    default:
      return true;   // pointer/assertion actions work against any role
  }
}

export { TYPE_ROLES, CHECK_ROLES, SELECT_ROLES, TYPE_INCOMPATIBLE_ROLES };

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
  if (filtered.length > 0) return filtered;

  // No role-compatible candidate — likely a custom widget without a standard
  // input role. Fall back so the resolver can still identify it (e.g. a rich-text
  // editor rendered as <div role="application">). But for text-entry actions,
  // still drop roles that categorically cannot accept typing (link/button/…) so
  // we never type into a link; keep the full list only if that would remove
  // everything (pure last-resort — no regression for all-incompatible pages).
  const incompatible = getIncompatibleRoles(action);
  if (incompatible) {
    const trimmed = candidates.filter((c) => !incompatible.has(c.role));
    if (trimmed.length > 0) return trimmed;
  }

  return candidates;
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

/**
 * Standard roles that are categorically wrong for `action`, applied only in the
 * fallback path to avoid handing the resolver an impossible target. Returns null
 * for actions where no such hard exclusion is warranted.
 */
function getIncompatibleRoles(action: string): Set<string> | null {
  switch (action) {
    case 'type':
    case 'fill':
    case 'clear':
      return TYPE_INCOMPATIBLE_ROLES;
    default:
      return null;
  }
}

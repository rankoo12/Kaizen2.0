/**
 * The delta oracle — "what did this action change?"
 * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §1
 *
 * A *discover oracle* is an assertion whose target the crawl never saw: the
 * message that appears after a click, the row that appears after a submit. The
 * resolver has no grounded element for it, so it searches the whole page — and
 * the whole page contains the button that was clicked. Five of ten proposed
 * tests on the-internet passed because "verify the confirmation is visible"
 * resolved to the *button that produced it*, which was there all along.
 *
 * So the answer has to come from what CHANGED. Before a state-changing step the
 * worker records a key per visible element; after it settles, anything whose key
 * is new is the delta, and it is marked in the live DOM with `data-kz-delta`.
 * A delta-scoped assertion resolves within that set and nowhere else — an empty
 * delta fails the step rather than falling back to the page, because falling
 * back to the page is exactly how it found the button.
 *
 * Zero LLM cost: two `page.evaluate` calls per state-changing step, and the
 * assertion that follows resolves deterministically instead of paying for a
 * prune + model call.
 */

/** One element that appeared (or whose text changed) after the action. */
export type DeltaElement = {
  /** `data-kz-delta` value — the selector handle, unique within this snapshot. */
  marker: string;
  /** ARIA role or tag name. */
  role: string;
  /** Accessible-ish name: aria-label / placeholder / title / own text. */
  name: string;
  /** The element's OWN text (direct text children only), capped. */
  text: string;
  /** Anchors, buttons and form controls — the things "click the X" names. */
  interactive: boolean;
};

export type DeltaSnapshot = {
  elements: DeltaElement[];
  /** The step whose action produced this delta — quoted in failure messages. */
  afterStep: string;
  /**
   * The action opened a native dialog, which the worker answers automatically.
   * Then "nothing changed" is Kaizen's own doing, not the app's: the alert said
   * something and we dismissed it before any assertion could read it. The
   * assertion still fails — it proved nothing — but this is not an app defect.
   */
  dialogAccepted: boolean;
};

/** Actions that can change the page, and therefore open a new delta. */
export const STATE_CHANGING_ACTIONS = new Set([
  'click', 'click_random', 'double_click', 'right_click', 'hover',
  'type', 'clear', 'select', 'check', 'uncheck', 'upload',
  'press_key', 'drag_and_drop',
]);

/** Actions that replace the page outright, so the previous delta is meaningless. */
export const DELTA_CLEARING_ACTIONS = new Set([
  'navigate', 'go_back', 'go_forward', 'reload', 'switch_tab', 'close_tab',
]);

/**
 * Assertions a delta can answer: "something matching this description is now
 * here". Absence assertions are deliberately excluded — what disappeared is not
 * in the delta, and `assert_not_visible` already has its own stretch guard.
 */
const DELTA_SCOPED_ASSERTIONS = new Set([
  'assert_visible', 'assert_text', 'assert_enabled', 'assert_disabled',
  'assert_checked', 'assert_attribute',
]);

export function isDeltaScoped(
  step: { action: string; oracleScope?: string | null; targetDescription: string | null },
): boolean {
  return step.oracleScope === 'delta'
    && step.targetDescription != null
    && DELTA_SCOPED_ASSERTIONS.has(step.action);
}

/** Minimal Playwright surface, so this module never imports playwright. */
type EvaluatingPage = {
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
};

export type WalkArg = {
  /** null → baseline pass (collect keys). Otherwise → diff pass. */
  baseline: string[] | null;
  cap: number;
};

export type WalkResult = { keys: string[]; elements: DeltaElement[] };

/**
 * The single browser-side pass, run twice: once to record the page, once to
 * diff against that record. One function rather than two so the keys are
 * computed identically by construction — and no `new Function`, which a page
 * with a strict CSP would refuse.
 *
 * A key is `tag|role|ownText|href|value`. Two decisions matter:
 *  - OWN text, not innerText: with innerText every ancestor of a new node also
 *    "changes", and the delta grows up the tree until it contains <body> — at
 *    which point restricting resolution to it means nothing.
 *  - Identity is CONTENT, not node identity, so the diff survives a navigation:
 *    submitting a login form re-renders the same page plus a flash message, and
 *    only the flash comes back as new.
 *
 * Exported for tests only: it runs in the BROWSER, so it must never reference
 * anything outside its own argument.
 */
export function walk(arg: WalkArg): WalkResult {
  const keys: string[] = [];
  const elements: DeltaElement[] = [];
  const root = document.body;
  if (!root) return { keys, elements };

  const before: Record<string, number> = {};
  if (arg.baseline) for (const key of arg.baseline) before[key] = (before[key] ?? 0) + 1;
  else document.querySelectorAll('[data-kz-delta]').forEach((el) => el.removeAttribute('data-kz-delta'));

  const seen: Record<string, number> = {};
  const all = root.querySelectorAll('*');
  const limit = Math.min(all.length, 2500);
  let index = 0;

  for (let i = 0; i < limit; i++) {
    const el = all[i] as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    let own = '';
    for (let c = 0; c < el.childNodes.length; c++) {
      const node = el.childNodes[c];
      if (node.nodeType === 3) own += ' ' + (node.nodeValue ?? '');
    }
    own = own.replace(/\s+/g, ' ').trim().slice(0, 160);

    const interactive = /^(a|button|input|select|textarea|summary|option|label)$/.test(tag)
      || el.hasAttribute('role');
    if (!own && !interactive) continue;

    const value = tag === 'input' || tag === 'textarea'
      ? ((el as HTMLInputElement).value ?? '') : '';
    const key = `${tag}|${el.getAttribute('role') ?? ''}|${own}|${el.getAttribute('href') ?? ''}|${value}`;

    if (!arg.baseline) { keys.push(key); continue; }

    seen[key] = (seen[key] ?? 0) + 1;
    if (seen[key] <= (before[key] ?? 0)) continue;

    const marker = `kz-d-${index++}`;
    el.setAttribute('data-kz-delta', marker);
    if (elements.length >= arg.cap) continue;
    const name = el.getAttribute('aria-label') || el.getAttribute('placeholder')
      || el.getAttribute('title') || own || value || el.getAttribute('name') || '';
    elements.push({
      marker,
      role: el.getAttribute('role') ?? tag,
      name: String(name).replace(/\s+/g, ' ').trim().slice(0, 120),
      text: own,
      interactive,
    });
  }

  return { keys, elements };
}

/**
 * Pass 1 — the keys of everything visible right now. Returned to Node rather
 * than stashed on `window` precisely so the comparison survives a navigation.
 */
export async function captureDeltaBaseline(page: unknown): Promise<string[]> {
  try {
    const result = await (page as EvaluatingPage).evaluate<WalkResult, WalkArg>(
      walk, { baseline: null, cap: 0 },
    );
    return result.keys;
  } catch {
    return [];
  }
}

/**
 * Pass 2 — diff against the baseline, mark the survivors in the DOM, and hand
 * back a readable set. An element counts as delta when its key occurs more
 * often now than it did before: new nodes, changed text, and a control that
 * became visible all land here; unchanged structure does not.
 */
export async function captureDelta(
  page: unknown, baseline: string[], cap = 40,
): Promise<DeltaElement[]> {
  try {
    const result = await (page as EvaluatingPage).evaluate<WalkResult, WalkArg>(
      walk, { baseline, cap },
    );
    return result.elements;
  } catch {
    return [];
  }
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'be', 'was', 'that', 'this', 'it', 'its', 'and', 'or',
  'of', 'in', 'on', 'to', 'for', 'with', 'shown', 'visible', 'displayed', 'appears',
  'appear', 'shows', 'show', 'new', 'now', 'page', 'element',
]);

/** Nouns a rendered step uses for a role — see `describeElement` in the writer. */
const NOUN_ROLE: Record<string, string[]> = {
  button: ['button'],
  link: ['a', 'link'],
  field: ['input', 'textbox', 'textarea'],
  dropdown: ['select', 'combobox', 'listbox'],
  checkbox: ['checkbox', 'input'],
  heading: ['h1', 'h2', 'h3', 'h4', 'heading'],
  image: ['img', 'image'],
};

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9']+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Which delta element does "the confirmation message" mean?
 *
 * Deterministic on purpose. The delta is a handful of elements, and asking a
 * model to pick among them would reintroduce the per-step LLM call this whole
 * mechanism removes. Word overlap decides when the description names its target
 * (`verify the text "It's gone!" is shown`); otherwise the tie-breaks encode
 * what a person means by "the message" — prose over a one-character close
 * button, and the role the sentence actually asked for.
 */
export function pickDeltaMatch(description: string, elements: DeltaElement[]): DeltaElement | null {
  if (elements.length === 0) return null;

  const want = tokens(description);
  const lower = description.toLowerCase();
  const wantedRoles = Object.entries(NOUN_ROLE)
    .filter(([noun]) => new RegExp(`\\b${noun}s?\\b`).test(lower))
    .flatMap(([, roles]) => roles);

  let best: DeltaElement | null = null;
  let bestScore = -Infinity;
  for (const element of elements) {
    const hay = new Set(tokens(`${element.name} ${element.text} ${element.role}`));
    const overlap = want.length > 0 ? want.filter((w) => hay.has(w)).length / want.length : 0;
    let score = overlap * 3;
    if (wantedRoles.length > 0 && wantedRoles.includes(element.role)) score += 0.6;
    // Prose is what "message", "confirmation", "result" mean; the "×" close
    // control is in the delta too and must not win by accident.
    if (element.text.length >= 8) score += 0.4;
    if (element.text.length > 0 && element.text.length <= 2) score -= 0.5;
    if (!element.interactive && element.text.length > 0) score += 0.2;
    if (score > bestScore) { bestScore = score; best = element; }
  }
  return best;
}

/** "What changed", as one line for the run timeline. */
export function summariseDelta(elements: DeltaElement[], max = 4): string {
  if (elements.length === 0) return 'nothing changed';
  const parts = elements.slice(0, max).map((el) => {
    const label = el.text || el.name;
    return label ? `${el.role} "${label.slice(0, 60)}"` : el.role;
  });
  const rest = elements.length - parts.length;
  return parts.join(', ') + (rest > 0 ? ` (+${rest} more)` : '');
}

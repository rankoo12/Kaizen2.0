/**
 * General "how many <things> are on the page" counting for assert_count.
 *
 * Unlike the single-element resolver (which returns ONE selector — e.g. an #id — and
 * would therefore always count 1), this finds the repeated GROUP the user is counting
 * and returns a selector matching every visible member, plus that member count.
 *
 * Two strategies, tried in order of precision:
 *   1. A GROUNDED repeated-sibling group — a set of sibling elements sharing a
 *      tag+class signature whose class/id/container/text relates to the target noun
 *      (e.g. "products" → the repeated `div.product-item` grid). Scoped to a real list.
 *   2. A semantic role/tag sweep for countable kinds the DOM models natively
 *      (rows, links, buttons, images, headings, list items, …).
 *
 * If NEITHER confidently identifies what to count, it returns null — the worker then
 * hands the engine an empty selector set and the assertion FAILS LOUDLY. A count
 * assertion must never pass on a guess: a wrong count that happens to equal N is a
 * false pass, the one outcome a QA tool must never produce.
 *
 * Design note: the decision logic (matchRole / countNounStems / pickCountable) is pure
 * and unit-tested directly; only the raw DOM walk lives in the in-browser closure,
 * which — like random-target.ts — is exercised by live dogfood.
 *
 * Spec: docs/specs/workers/spec-engine-capabilities-assert-count.md
 */

export interface CountablePageLike {
  /** Playwright 3-arg $eval: runs `fn(bodyElement, arg)` in-browser. */
  $eval<T, A>(selector: string, fn: (el: Element, arg: A) => T, arg: A): Promise<T>;
}

/** One countable candidate gathered from the live DOM. */
export type CountCandidate = {
  kind: 'role' | 'group';
  /** Members carry attribute `data-kzc-<token>`; `[data-kzc-<token>]` re-locates exactly them. */
  token: string;
  /** Number of VISIBLE members tagged. */
  count: number;
  /** Lowercased class/id/container/sample-text blob — grounds a group to the target noun. */
  haystack: string;
  /** For role hits: length of the matched keyword (longer = more specific). */
  roleKwLen?: number;
};

export type CountResolution = { selector: string; count: number; method: 'role' | 'group' };

/** Raw payload the in-browser gather step returns. */
type GatherResult = {
  role: { token: string; count: number } | null;
  groups: Array<{ token: string; count: number; haystack: string }>;
};

// ── Pure decision logic (unit-tested directly) ───────────────────────────────

const STOPWORDS = new Set([
  'the', 'are', 'there', 'should', 'have', 'has', 'many', 'count', 'number', 'exactly',
  'least', 'most', 'more', 'than', 'fewer', 'less', 'verify', 'check', 'that', 'and', 'with',
  'list', 'page', 'shown', 'displayed', 'visible', 'see', 'total', 'all', 'of', 'at', 'be',
  'is', 'on', 'in', 'an', 'to', 'it', 'its', 'this', 'these', 'those',
]);

/** Distinctive singular-ish noun stems from the target, used to ground a group match. */
export function countNounStems(target: string): string[] {
  return (target || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map((w) =>
      w
        .replace(/ies$/, 'y')
        .replace(/(ses|xes|zes|ches|shes)$/, (m) => m.slice(0, -2))
        .replace(/s$/, ''),
    )
    .filter(Boolean);
}

const ROLE_MAP: Array<{ kws: string[]; sel: string }> = [
  { kws: ['row', 'rows'], sel: 'tr, [role="row"]' },
  { kws: ['cell', 'cells'], sel: 'td, [role="cell"], [role="gridcell"]' },
  { kws: ['column header', 'column headers'], sel: 'th, [role="columnheader"]' },
  { kws: ['list item', 'list items', 'listitem', 'listitems'], sel: 'li, [role="listitem"]' },
  { kws: ['link', 'links'], sel: 'a[href], [role="link"]' },
  { kws: ['button', 'buttons'], sel: 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]' },
  { kws: ['image', 'images', 'photo', 'photos', 'picture', 'pictures'], sel: 'img, [role="img"]' },
  { kws: ['heading', 'headings'], sel: 'h1, h2, h3, h4, h5, h6, [role="heading"]' },
  { kws: ['checkbox', 'checkboxes'], sel: 'input[type="checkbox"], [role="checkbox"]' },
  { kws: ['radio', 'radios', 'radio button', 'radio buttons'], sel: 'input[type="radio"], [role="radio"]' },
  { kws: ['option', 'options'], sel: 'option, [role="option"]' },
  { kws: ['tab', 'tabs'], sel: '[role="tab"]' },
  { kws: ['paragraph', 'paragraphs'], sel: 'p' },
];

/** Map a target to a native semantic role/tag CSS selector, or null. Most specific keyword wins. */
export function matchRole(target: string): { sel: string; kwLen: number } | null {
  const t = (target || '').toLowerCase();
  let best: { sel: string; kwLen: number } | null = null;
  for (const { kws, sel } of ROLE_MAP) {
    for (const kw of kws) {
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (re.test(t) && (!best || kw.length > best.kwLen)) best = { sel, kwLen: kw.length };
    }
  }
  return best;
}

/**
 * Choose which gathered candidate the user is counting, or null to refuse.
 *   1. Prefer a semantic ROLE sweep — a role candidate only exists when the target
 *      named a native countable kind (rows, links, buttons, …), and that literal intent
 *      wins over a class coincidence (e.g. "rows" must be <tr>, not Bootstrap `.row` divs).
 *   2. Else a GROUNDED repeated group (scoped to an actual list); pick the largest.
 *   3. Else null — never guess an ungrounded "biggest group on the page".
 */
export function pickCountable(cands: CountCandidate[], target: string): CountCandidate | null {
  const roles = cands
    .filter((c) => c.kind === 'role' && c.count > 0)
    .sort((a, b) => (b.roleKwLen ?? 0) - (a.roleKwLen ?? 0) || b.count - a.count);
  if (roles.length) return roles[0];

  const stems = countNounStems(target);
  const grounded = cands
    .filter((c) => c.kind === 'group' && c.count >= 2 && stems.some((s) => s && c.haystack.includes(s)))
    .sort((a, b) => b.count - a.count);
  if (grounded.length) return grounded[0];

  return null;
}

// ── In-browser DOM gather (serialized to the page; browser globals only) ──────

// Serialization-safe by design: this closure uses NO named inner functions. Under
// tsx/esbuild `keepNames`, `const f = () => …` becomes `__name(() => …, 'f')`, and
// Playwright serializes only the function body — so `__name` must exist in the page.
// The worker injects a `__name` identity shim (worker.ts addInitScript), which is what
// lets random-target.ts's named-helper closures run under tsx. This closure is kept
// shim-INDEPENDENT so it also works when driven from a context that doesn't inject the
// shim (e.g. a standalone Playwright harness — how it was live-verified). Inline
// ANONYMOUS arrows (filter/forEach) are never wrapped, so the visibility predicate is
// inlined at both use sites on purpose — do not "DRY" it back into a named helper.
const GATHER_FN = (_body: Element, roleSel: string): GatherResult => {
  let role: { token: string; count: number } | null = null;
  if (roleSel) {
    const vis = Array.from(document.querySelectorAll(roleSel)).filter((el) => {
      if ((el as HTMLElement).hidden) return false;
      const s = getComputedStyle(el);
      if (!s || s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (vis.length > 0) {
      const token = Math.random().toString(36).slice(2, 10);
      vis.forEach((el) => el.setAttribute(`data-kzc-${token}`, '1'));
      role = { token, count: vis.length };
    }
  }

  const groups: Array<{ token: string; count: number; haystack: string }> = [];
  for (const parent of Array.from(document.querySelectorAll('*'))) {
    const kids = Array.from(parent.children);
    if (kids.length < 2) continue;
    const bySig = new Map<string, Element[]>();
    for (const k of kids) {
      const cls = Array.from(k.classList).sort().join('.');
      const sig = k.tagName.toLowerCase() + (cls ? `.${cls}` : '');
      const arr = bySig.get(sig);
      if (arr) arr.push(k);
      else bySig.set(sig, [k]);
    }
    for (const [sig, group] of Array.from(bySig.entries())) {
      if (group.length < 2) continue;
      const vis = group.filter((el) => {
        if ((el as HTMLElement).hidden) return false;
        const s = getComputedStyle(el);
        if (!s || s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (vis.length < 2) continue;
      // Each candidate gets its OWN attribute (data-kzc-<token>) so overlapping role/group
      // membership never clobbers another candidate's marker.
      const p = parent as HTMLElement;
      const first = vis[0] as HTMLElement;
      const firstText = (first.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
      // Grounding also scans the counted element's DESCENDANT class tokens: the repeated
      // unit is often a layout wrapper (e.g. <li class="col-md-3">) whose semantic class
      // (product_pod, quote, result-item) lives one level down. Without this, "products"
      // would not ground to a grid of <li> wrappers around <article class="product_pod">.
      const descClasses = Array.from(first.querySelectorAll('[class]'))
        .slice(0, 25)
        .map((e) => (typeof (e as HTMLElement).className === 'string' ? (e as HTMLElement).className : ''))
        .join(' ');
      const pClass = typeof p.className === 'string' ? p.className : '';
      const firstClass = typeof first.className === 'string' ? first.className : '';
      const haystack = `${sig} ${p.id || ''} ${pClass} ${first.id || ''} ${firstClass} ${descClasses} ${firstText}`
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const token = Math.random().toString(36).slice(2, 10);
      vis.forEach((el) => el.setAttribute(`data-kzc-${token}`, '1'));
      groups.push({ token, count: vis.length, haystack });
    }
  }

  return { role, groups };
};

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Resolve a selector that matches every visible member of the group the target
 * describes, plus that count. Returns null when nothing is confidently countable
 * (→ the assertion fails loudly rather than passing on a guess).
 */
export async function resolveCountSelector(
  page: CountablePageLike,
  target: string,
): Promise<CountResolution | null> {
  const role = matchRole(target);
  const gathered = await page
    .$eval('body', GATHER_FN, role?.sel ?? '')
    .catch(() => null as GatherResult | null);
  if (!gathered) return null;

  const cands: CountCandidate[] = [];
  if (gathered.role && gathered.role.count > 0) {
    cands.push({ kind: 'role', token: gathered.role.token, count: gathered.role.count, haystack: '', roleKwLen: role?.kwLen ?? 0 });
  }
  for (const g of gathered.groups) {
    cands.push({ kind: 'group', token: g.token, count: g.count, haystack: g.haystack });
  }

  const chosen = pickCountable(cands, target);
  if (!chosen) return null;
  return { selector: `[data-kzc-${chosen.token}]`, count: chosen.count, method: chosen.kind };
}

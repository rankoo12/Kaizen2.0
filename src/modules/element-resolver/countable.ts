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
  kind: 'role' | 'group' | 'classgroup';
  /** Members carry attribute `data-kzc-<token>`; `[data-kzc-<token>]` re-locates exactly them. */
  token: string;
  /** Number of VISIBLE members tagged. */
  count: number;
  /** Lowercased class/id/container/sample-text blob — grounds a group to the target noun. */
  haystack: string;
  /** For role hits: length of the matched keyword (longer = more specific). */
  roleKwLen?: number;
};

export type CountResolution = { selector: string; count: number; method: 'role' | 'group' | 'classgroup' };

/** Raw payload the in-browser gather step returns. */
type GatherResult = {
  role: { token: string; count: number } | null;
  groups: Array<{ token: string; count: number; haystack: string }>;
  /**
   * Head-noun units grounded by their OWN class/id (not descendant text), optionally
   * scoped to a container noun, and de-nested to the OUTERMOST match per subtree — so a
   * single `.cart_item` inside `.cart_list` counts as one "item in the cart". This is what
   * lets assert_count handle EXACTLY ONE (a role sweep counts singles fine, but a plain
   * repeated-sibling group needs ≥2 and so cannot express "1 item").
   */
  classGroups: Array<{ token: string; count: number; haystack: string }>;
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

/**
 * Split a count target into the HEAD noun(s) to count and an optional CONTAINER noun
 * that scopes them: "items in the cart" → count "item" units scoped to "cart";
 * "6 items" → count "item" units, unscoped. The container comes from an "in [the] X"
 * phrase. Scoping is what disambiguates "items in the cart" (the `.cart_item` lines)
 * from a coincidental `.inventory_item` grid that also stems to "item".
 */
export function parseCountTarget(target: string): { headStems: string[]; containerStem: string | null } {
  const t = (target || '').toLowerCase();
  const stems = countNounStems(t);
  let containerStem: string | null = null;
  const m = t.match(/\bin(?:side)?\s+(?:the\s+|a\s+|an\s+|your\s+|my\s+)?([a-z][a-z0-9]+)/);
  if (m) {
    const cs = countNounStems(m[1])[0];
    if (cs) containerStem = cs;
  }
  const headStems = containerStem ? stems.filter((s) => s !== containerStem) : stems;
  return { headStems: headStems.length ? headStems : stems, containerStem };
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
 *   2. Else a CLASSGROUP — head-noun units grounded by their own class/id and scoped to
 *      the container noun, de-nested to the outermost match. Counts down to EXACTLY ONE
 *      (a plain repeated-sibling group can't: a single `.cart_item` isn't a "group").
 *   3. Else a GROUNDED repeated group (≥2, noun in the class/text blob) — the fallback for
 *      units whose noun lives only in descendant text (e.g. "products" → `col-md-3` wrappers).
 *   4. Else null — never guess an ungrounded "biggest group on the page".
 */
export function pickCountable(cands: CountCandidate[], target: string): CountCandidate | null {
  const roles = cands
    .filter((c) => c.kind === 'role' && c.count > 0)
    .sort((a, b) => (b.roleKwLen ?? 0) - (a.roleKwLen ?? 0) || b.count - a.count);
  if (roles.length) return roles[0];

  // Classgroups are already head-grounded + container-scoped + de-nested in-browser, so any
  // survivor is a legitimate unit. Prefer the largest count (the dominant repeated unit).
  const classGroups = cands.filter((c) => c.kind === 'classgroup' && c.count >= 1).sort((a, b) => b.count - a.count);
  if (classGroups.length) return classGroups[0];

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
const GATHER_FN = (
  _body: Element,
  arg: { roleSel: string; headStems: string[]; containerStem: string | null },
): GatherResult => {
  const roleSel = arg.roleSel;
  const headStems = arg.headStems || [];
  const containerStem = arg.containerStem;

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

  // ── classgroups: head-noun units grounded by their OWN class/id, scoped to the container
  // noun, and de-nested to the outermost match — so ONE `.cart_item` in `.cart_list` counts
  // as one "item in the cart" (a plain sibling group needs ≥2 and cannot express "1"). ──
  const classGroups: Array<{ token: string; count: number; haystack: string }> = [];
  if (headStems.length) {
    const bySig = new Map<string, Element[]>();
    for (const el of Array.from(document.querySelectorAll('[class], [id]'))) {
      const clsName = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : '';
      const ownToks = `${clsName} ${el.id || ''}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      if (!headStems.some((s) => ownToks.indexOf(s) >= 0)) continue;

      // container scope: own tokens OR some ancestor's tokens include the container noun
      if (containerStem) {
        let scoped = ownToks.indexOf(containerStem) >= 0;
        let p = el.parentElement;
        let hops = 0;
        while (!scoped && p && hops < 10) {
          const pc = typeof (p as HTMLElement).className === 'string' ? (p as HTMLElement).className : '';
          if (`${pc} ${p.id || ''}`.toLowerCase().split(/[^a-z0-9]+/).indexOf(containerStem) >= 0) scoped = true;
          p = p.parentElement;
          hops++;
        }
        if (!scoped) continue;
      }

      // de-nest: skip if an ancestor ALSO matches a head noun (that ancestor is the real unit)
      let anc = el.parentElement;
      let nested = false;
      let hops2 = 0;
      while (anc && hops2 < 12) {
        const ac = typeof (anc as HTMLElement).className === 'string' ? (anc as HTMLElement).className : '';
        const atoks = `${ac} ${anc.id || ''}`.toLowerCase().split(/[^a-z0-9]+/);
        if (headStems.some((s) => atoks.indexOf(s) >= 0)) { nested = true; break; }
        anc = anc.parentElement;
        hops2++;
      }
      if (nested) continue;

      if ((el as HTMLElement).hidden) continue;
      const st = getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      const clsSig = Array.from(el.classList).sort().join('.');
      const sig = el.tagName.toLowerCase() + (clsSig ? `.${clsSig}` : '');
      const arr = bySig.get(sig);
      if (arr) arr.push(el);
      else bySig.set(sig, [el]);
    }
    for (const [sig, els] of Array.from(bySig.entries())) {
      const token = Math.random().toString(36).slice(2, 10);
      els.forEach((el) => el.setAttribute(`data-kzc-${token}`, '1'));
      classGroups.push({ token, count: els.length, haystack: sig.toLowerCase() });
    }
  }

  return { role, groups, classGroups };
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
  const { headStems, containerStem } = parseCountTarget(target);
  const gathered = await page
    .$eval('body', GATHER_FN, { roleSel: role?.sel ?? '', headStems, containerStem })
    .catch(() => null as GatherResult | null);
  if (!gathered) return null;

  const cands: CountCandidate[] = [];
  if (gathered.role && gathered.role.count > 0) {
    cands.push({ kind: 'role', token: gathered.role.token, count: gathered.role.count, haystack: '', roleKwLen: role?.kwLen ?? 0 });
  }
  for (const g of gathered.classGroups ?? []) {
    cands.push({ kind: 'classgroup', token: g.token, count: g.count, haystack: g.haystack });
  }
  for (const g of gathered.groups) {
    cands.push({ kind: 'group', token: g.token, count: g.count, haystack: g.haystack });
  }

  const chosen = pickCountable(cands, target);
  if (!chosen) return null;
  return { selector: `[data-kzc-${chosen.token}]`, count: chosen.count, method: chosen.kind };
}

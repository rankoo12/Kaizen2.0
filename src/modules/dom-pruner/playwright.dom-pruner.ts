/// <reference lib="dom" />
import type { IDOMPruner, IPageSurveyor } from './interfaces';
import type { CandidateNode, SelectorEntry } from '../../types';

/**
 * PlaywrightDOMPruner — Spec ref: Section 5
 *
 * Extracts visible, interactive elements from the live page and generates a
 * ranked list of selectors per element from most stable to least stable:
 *
 *   1. role=ROLE[name="..."]   — Playwright ARIA selector (survives DOM restructuring)
 *   2. #id                     — CSS id (very stable)
 *   3. [data-testid="..."]     — test-id (stable, purpose-built)
 *   4. tag[name="..."]         — form element name attribute
 *   5. tag[aria-label="..."]   — explicit aria-label
 *   6. tag[placeholder="..."]  — placeholder (fragile but common)
 *   7. [data-kaizen-id='kz-N'] — transient session ID (last resort)
 *
 * data-kaizen-id is still injected for per-session disambiguation (the LLM
 * uses it to map its choice back to a physical element) but is NEVER the
 * primary selector stored in cache or used by the execution engine.
 */
export class PlaywrightDOMPruner implements IDOMPruner, IPageSurveyor {
  /**
   * RECON survey mode — the whole interactive surface of the page, capped.
   * prune() already performs full Pass-1 extraction (the target description is
   * only used by downstream similarity ranking, not here), so survey() is the
   * same extraction with an explicit cap.
   * Spec: docs/specs/test-writer/spec-recon-crawler.md §3
   */
  async survey(page: unknown, cap = 60): Promise<CandidateNode[]> {
    const all = await this.prune(page, '');
    return all.slice(0, cap);
  }

  async prune(page: unknown, _targetDescription: string): Promise<CandidateNode[]> {
    const pwPage = page as any;

    // Wait for the page to finish network activity so post-load JS (React
    // hydration, Turbo frames, etc.) has settled before we inspect the DOM.
    await pwPage.waitForLoadState('networkidle').catch(() => {});

    const rawCandidates: Array<{
      kaizenId: string;
      role: string;
      accessibleName: string;
      attributes: Record<string, string>;
      textContent: string;
      centerPoint: { x: number; y: number };
      // Raw ingredients for selector generation
      tagName: string;
      parentContext: string;
    }> = await pwPage.evaluate(() => {
      // ── 1. Query semantic interactive elements ────────────────────────────
      const elements = Array.from(document.querySelectorAll(
        'button, a, input, textarea, select, ' +
        '[role="button"], [role="link"], [role="checkbox"], ' +
        '[role="combobox"], [role="searchbox"], [role="tab"], [role="menuitem"], [role="textbox"], ' +
        // Drag-and-drop targets: HTML5 draggable elements and common DnD-library
        // hooks (jQuery UI, generic aria-grabbed). These are usually plain <div>s
        // that the interactive-role query above never surfaces, so drag_and_drop
        // resolution otherwise falls back to the nearest link. Rare on non-drag
        // pages, so this adds negligible candidate noise elsewhere.
        '[draggable="true"], [aria-grabbed], .ui-draggable, .ui-droppable, .ui-sortable, .ui-sortable > *, ' +
        // Figure images: the one kind of image a test hovers or clicks ON PURPOSE
        // (a gallery tile, an avatar with a caption underneath). Narrow on
        // purpose — every logo on the web is an <img>, and those are noise.
        // the-internet's /hovers page had nothing citable without this.
        'figure > img, .figure > img, figure > a > img',
      )) as HTMLElement[];

      const results: any[] = [];
      let kaizenIndex = 1;

      for (const el of elements) {
        // ── 2. Visibility gate ────────────────────────────────────────────
        const style = window.getComputedStyle(el);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0'
        ) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        // ── 3. Inject session-scoped kaizen ID ────────────────────────────
        const kaizenId = `kz-${kaizenIndex++}`;
        el.setAttribute('data-kaizen-id', kaizenId);

        // ── 4. Extract attributes ─────────────────────────────────────────
        const attributes: Record<string, string> = {};
        // aria-expanded / aria-haspopup / aria-controls / download feed the
        // Test Writer's interaction safety classifier (safe-reveal detection).
        // Spec: docs/specs/test-writer/spec-recon-crawler.md §4.1
        for (const attr of [
          'id', 'name', 'placeholder', 'aria-label', 'aria-labelledby',
          'type', 'href', 'title', 'data-testid', 'data-qa', 'data-test', 'role', 'draggable', 'target',
          'aria-expanded', 'aria-haspopup', 'aria-controls', 'download',
        ]) {
          const val = el.getAttribute(attr);
          if (val) attributes[attr] = val;
        }

        // ── 5. Compute ARIA role ──────────────────────────────────────────
        const tagName = el.tagName.toLowerCase();
        let role = el.getAttribute('role') || '';
        if (!role) {
          if (tagName === 'button') role = 'button';
          else if (tagName === 'a') role = 'link';
          else if (tagName === 'select') role = 'combobox';
          else if (tagName === 'img') role = 'img';
          else if (tagName === 'textarea') role = 'textbox';
          else if (tagName === 'input') {
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            if (t === 'checkbox') role = 'checkbox';
            else if (t === 'radio') role = 'radio';
            else if (t === 'submit' || t === 'button' || t === 'reset') role = 'button';
            else if (t === 'search') role = 'searchbox';
            else role = 'textbox';
          }
        }

        // ── 6. Compute accessible name ────────────────────────────────────
        // Priority: aria-label > aria-labelledby > <label for> > placeholder > title > visible text
        let accessibleName = el.getAttribute('aria-label') || '';

        if (!accessibleName) {
          const labelledById = el.getAttribute('aria-labelledby');
          if (labelledById) {
            // aria-labelledby may reference multiple IDs
            accessibleName = labelledById
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
              .filter(Boolean)
              .join(' ');
          }
        }

        if (!accessibleName && el.id) {
          const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (label) {
            accessibleName = (label.textContent || '').trim().replace(/\s+/g, ' ');
          }
        }

        if (!accessibleName) {
          // Check for wrapping label.
          // Guard: if the wrapping label contains MORE than one form control,
          // its visible text is shared between siblings and would produce a
          // misleading merged accessible name (e.g. two inputs both named
          // "City * Zipcode *"). Skip the assignment and let the input fall
          // through to its identifier attributes — the LLM gateway will
          // surface those when displayName is empty.
          // Spec: docs/specs/dom-pruner/spec-empty-name-disambiguation.md
          const wrappingLabel = el.closest('label');
          if (wrappingLabel) {
            const wrappedControls = wrappingLabel.querySelectorAll('input, textarea, select');
            if (wrappedControls.length <= 1) {
              const clone = wrappingLabel.cloneNode(true) as HTMLElement;
              clone.querySelectorAll('input, textarea, select').forEach((n) => n.remove());
              accessibleName = (clone.textContent || '').trim().replace(/\s+/g, ' ');
            } else {
              // Mark on the element so the Node-side observability can detect
              // that this candidate intentionally has no accessible name due
              // to a multi-input wrapping label, not because of a bug.
              el.setAttribute('data-kaizen-wrapping-label-skipped', String(wrappedControls.length));
            }
          }
        }

        if (!accessibleName) {
          accessibleName = el.getAttribute('placeholder') || el.getAttribute('title') || '';
        }

        // input[type=submit] and input[type=button] expose their accessible name
        // via the value attribute — not innerText (void elements have no children).
        // Without this, role=button[name="Sign in"] is never built for submit inputs.
        if (!accessibleName && tagName === 'input') {
          const t = (el.getAttribute('type') || '').toLowerCase();
          if (t === 'submit' || t === 'button') {
            accessibleName = el.getAttribute('value') || '';
          }
        }

        // ── 7. Clean text content ─────────────────────────────────────────
        const textContent = (el.innerText || el.textContent || '')
          .trim()
          .replace(/\s+/g, ' ')
          .substring(0, 100);

        // For buttons and links, fall back to visible text as accessible name.
        // Also for drag targets (draggable divs / jQuery-UI items), which have no
        // intrinsic accessible name — their visible text (e.g. a column header "A")
        // is what a drag step's targetDescription refers to.
        const isDragEl =
          el.getAttribute('draggable') === 'true' ||
          el.hasAttribute('aria-grabbed') ||
          el.classList.contains('ui-draggable') ||
          el.classList.contains('ui-droppable') ||
          el.classList.contains('ui-sortable');
        // An image's name is its alt text — and when several figures share one
        // alt ("User Avatar" ×3), the caption beside it tells them apart.
        if (!accessibleName && tagName === 'img') {
          const alt = (el.getAttribute('alt') || '').trim();
          const caption = (el.parentElement?.querySelector('figcaption, .figcaption')?.textContent || '').replace(/\s+/g, ' ').trim();
          accessibleName = caption ? `${alt || 'image'}: ${caption.slice(0, 40)}` : alt;
        }
        if (!accessibleName && (tagName === 'button' || tagName === 'a' || isDragEl)) {
          accessibleName = textContent.substring(0, 80);
        }

        // ── 7b. The text a person reads next to it ────────────────────────
        // A control with no label, no id and no placeholder is not nameless to
        // a human: the-internet's checkboxes are `<input type="checkbox">
        // checkbox 1`, and every sighted user calls that one "checkbox 1".
        // Captured as an ATTRIBUTE, never as the accessible name — a screen
        // reader still announces nothing here, so the accessibility finding
        // must keep counting it. deriveName turns it into something citable.
        // Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §3
        if (!accessibleName) {
          const readText = (from: Node | null, forward: boolean): string => {
            let node = from;
            let hops = 0;
            while (node && hops++ < 3) {
              if (node.nodeType === 3) {
                const t = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
                if (t) return t.slice(0, 40);
              } else if (node.nodeType === 1) {
                const tag = (node as HTMLElement).tagName.toLowerCase();
                // Another control means we have walked into its label, not ours.
                if (['input', 'select', 'textarea', 'button', 'a'].includes(tag)) return '';
                // Inline separators are stepped over; a heading immediately
                // before a control is what the page calls it ("Number").
                if (!['br', 'span', 'label', 'small', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) return '';
                const t = ((node as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim();
                if (t) return t.slice(0, 40);
              }
              node = forward ? node.nextSibling : node.previousSibling;
            }
            return '';
          };
          const nearby = readText(el.nextSibling, true) || readText(el.previousSibling, false);
          if (nearby) attributes['nearby-text'] = nearby;
        }

        // ── 8. Parent context for disambiguation ──────────────────────────
        // Walk up the DOM to find the nearest semantic ancestor label so the
        // LLM can tell apart elements that share an identical accessible name
        // (e.g. two "Email" inputs — one for login, one for newsletter).
        let parentContext = '';
        let node: HTMLElement | null = el.parentElement;
        while (node && node !== document.body) {
          const nodeTag = node.tagName.toLowerCase();
          if (nodeTag === 'form') {
            parentContext = node.getAttribute('aria-label') || node.getAttribute('title') || '';
            if (parentContext) break;
          }
          if (nodeTag === 'fieldset') {
            const legend = node.querySelector(':scope > legend');
            if (legend) { parentContext = (legend.textContent || '').trim(); break; }
          }
          if (['section', 'main', 'aside', 'article'].includes(nodeTag)) {
            parentContext = node.getAttribute('aria-label') || '';
            if (parentContext) break;
          }
          node = node.parentElement;
        }

        // ── 8b. Repeated-item context (row / card / list-item) ────────────────
        // The walk above only finds form/fieldset/section/heading labels. For the
        // Class-A blind spot — "the Edit link in the row for Conway", "the about link
        // for J.K. Rowling" — the disambiguator lives in the element's REPEATED CONTAINER
        // (its <tr>, <li>, or repeated card), which none of those cover. Without it, the
        // LLM sees N identical "Edit"/"(about)" candidates and picks the first. Capture
        // the nearest item-container's text (minus the element's own short label) so the
        // gateway can render `(in: "Conway Tim …")` and the LLM matches the right one.
        if (!parentContext) {
          const ownText = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const SKIP_TAGS = new Set(['td', 'th', 'span', 'a', 'button', 'label', 'small', 'strong', 'em', 'b', 'i']);
          let itemNode: HTMLElement | null = el.parentElement;
          let hops = 0;
          while (itemNode && itemNode !== document.body && hops < 12) {
            hops++;
            const itemTag = itemNode.tagName.toLowerCase();
            const itemParent = itemNode.parentElement;
            // A real repeated ITEM shares BOTH tag AND first class with ≥1 sibling (a grid
            // of `.inventory_item` / `.quote` / `.product_pod`). Requiring the class skips
            // layout wrappers like `.pricebar` (whose sibling is a differently-classed div),
            // which would otherwise capture just "$29.99" instead of the product card.
            const itemCls = (typeof itemNode.className === 'string' ? itemNode.className : '').trim().split(' ')[0];
            const repeated = !!itemParent && Array.from(itemParent.children).filter((c) => {
              const cc = (typeof (c as HTMLElement).className === 'string' ? (c as HTMLElement).className : '').trim().split(' ')[0];
              return c.tagName === itemNode!.tagName && cc === itemCls;
            }).length >= 2;
            // A distinguishing item container: a table row, a list item, or a same-class
            // repeated block (card) — never an inline element or a table cell.
            if (itemTag === 'tr' || itemTag === 'li' || (repeated && !SKIP_TAGS.has(itemTag))) {
              let ctx = (itemNode.textContent || '').replace(/\s+/g, ' ').trim();
              if (ownText && ownText.length < 30) {
                const idx = ctx.toLowerCase().indexOf(ownText);
                if (idx >= 0) ctx = (ctx.slice(0, idx) + ' ' + ctx.slice(idx + ownText.length)).replace(/\s+/g, ' ').trim();
              }
              parentContext = ctx.substring(0, 120);
              if (parentContext) break;
            }
            itemNode = itemNode.parentElement;
          }
        }

        results.push({
          kaizenId,
          role,
          accessibleName,
          attributes,
          textContent,
          tagName,
          parentContext,
          centerPoint: {
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          },
        });
      }

      return results;
    });

    // ── Patch accessible names using locator.ariaSnapshot() ──────────────────
    // Our evaluate() computes names from innerText/aria-label/etc., but Playwright's
    // role= selectors match against the AX tree's full accessible-name computation,
    // which: (a) includes CSS ::before/::after content, (b) preserves whitespace from
    // inline siblings that innerText.trim() would strip. When the stored name differs
    // from Playwright's AX name — even by one space — role=X[name="Y"] returns 0
    // matches on pages with multiple same-role elements, silently defeating caching.
    //
    // Spec: docs/spec-dom-pruner-aria-snapshot.md
    const supportsAriaSnapshot = (() => {
      try {
        const probe = pwPage.locator('body');
        return typeof probe.ariaSnapshot === 'function';
      } catch { return false; }
    })();

    if (supportsAriaSnapshot) {
      for (const raw of rawCandidates) {
        try {
          const snapshot: string = await pwPage
            .locator(`[data-kaizen-id='${raw.kaizenId}']`)
            .ariaSnapshot();
          const parsed = parseAriaSnapshotName(snapshot);
          if (parsed !== null) {
            raw.accessibleName = parsed;
          }
        } catch { /* keep the evaluate()-computed name as fallback */ }
      }
    }

    // ── Build ranked selector lists in Node.js ────────────────────────────────
    // (CSS.escape is a browser API; we use a simple escape helper here instead)
    const buildCandidate = (raw: any, frameUrl?: string): CandidateNode => {
      const { kaizenId, role, accessibleName, attributes, tagName } = raw;
      const id = attributes['id'];
      const name = attributes['name'];
      const testId = attributes['data-testid'];
      const qaId = attributes['data-qa'];
      const testAttr = attributes['data-test'];
      const ariaLabel = attributes['aria-label'];
      const placeholder = attributes['placeholder'];

      const selectors: SelectorEntry[] = [];

      // ── Priority 1: Playwright ARIA role selector ─────────────────────────
      // role=ROLE[name="accessible name"] — resolves against the AX tree,
      // completely immune to CSS class / DOM structure changes.
      if (role && role !== 'generic' && accessibleName) {
        selectors.push({
          selector: `role=${role}[name="${escapeAttr(accessibleName)}"]`,
          strategy: 'aria',
          confidence: 0.97,
        });
      }

      // ── Priority 2: CSS id ─────────────────────────────────────────────────
      if (id) {
        selectors.push({
          selector: `#${cssEscapeId(id)}`,
          strategy: 'css',
          confidence: 0.93,
        });
      }

      // ── Priority 3: data-testid / data-qa / data-test ────────────────────
      // All three are purpose-built test identifiers: unique, stable, and not
      // affected by label/accessible-name mismatches in the surrounding HTML.
      if (testId) {
        selectors.push({
          selector: `[data-testid="${escapeAttr(testId)}"]`,
          strategy: 'data-testid',
          confidence: 0.91,
        });
      }
      if (qaId) {
        selectors.push({
          selector: `[data-qa="${escapeAttr(qaId)}"]`,
          strategy: 'data-testid',   // same stability class as data-testid
          confidence: 0.91,
        });
      }
      if (testAttr) {
        selectors.push({
          selector: `[data-test="${escapeAttr(testAttr)}"]`,
          strategy: 'data-testid',
          confidence: 0.91,
        });
      }

      // ── Priority 4: tag + name attribute (form elements) ─────────────────
      if (name && (tagName === 'input' || tagName === 'textarea' || tagName === 'select')) {
        selectors.push({
          selector: `${tagName}[name="${escapeAttr(name)}"]`,
          strategy: 'css',
          confidence: 0.85,
        });
      }

      // ── Priority 5: tag + aria-label ──────────────────────────────────────
      if (ariaLabel && !selectors.some((s) => s.strategy === 'aria')) {
        selectors.push({
          selector: `${tagName}[aria-label="${escapeAttr(ariaLabel)}"]`,
          strategy: 'aria',
          confidence: 0.80,
        });
      }

      // ── Priority 6: tag + placeholder ────────────────────────────────────
      if (placeholder) {
        selectors.push({
          selector: `${tagName}[placeholder="${escapeAttr(placeholder)}"]`,
          strategy: 'css',
          confidence: 0.70,
        });
      }

      // NOTE: data-kaizen-id is intentionally NOT added to selectorCandidates.
      // It is only injected into the live DOM so the LLM can reference elements by
      // a short ID within a single session prompt. It evaporates when the browser
      // session ends and would produce selector-not-found failures on every cached run.

      // Primary cssSelector = most stable one available.
      // Falls back to the session-scoped kz-id for DISPLAY ONLY (dom_candidates table
      // in the trace UI) when no stable selector was generated (e.g. icon-only links
      // with empty accessible name). The kz-id fallback is never in selectorCandidates
      // so it can never reach the cache or the execution engine.
      const cssSelector = selectors.length > 0
        ? selectors[0].selector
        : `[data-kaizen-id='${kaizenId}']`;

      return {
        kaizenId,
        role,
        name: accessibleName,
        cssSelector,
        xpath: '',
        attributes: raw.attributes,
        textContent: raw.textContent,
        isVisible: true,
        similarityScore: 1.0,
        centerPoint: raw.centerPoint,
        selectorCandidates: selectors,
        parentContext: raw.parentContext || undefined,
        frameUrl,
      } satisfies CandidateNode;
    };

    const mainCandidates = rawCandidates.map((raw) => buildCandidate(raw));

    // ── Child-frame candidates (cookie-consent CMPs, embedded widgets) ───────────
    // The main-document evaluate never sees inside iframes. Gather interactive elements
    // from each accessible child frame, tagged with the frame URL so the engine acts
    // WITHIN that frame. Bounded (≤6 frames) to avoid ad-iframe noise; failures per
    // frame are swallowed (cross-origin/detached frames simply contribute nothing).
    const frameCandidates: CandidateNode[] = [];
    try {
      const frames: any[] = typeof pwPage.frames === 'function' ? pwPage.frames() : [];
      const mainFrame = typeof pwPage.mainFrame === 'function' ? pwPage.mainFrame() : null;
      let fi = 0;
      for (const frame of frames.filter((f) => f && f !== mainFrame).slice(0, 6)) {
        fi++;
        try {
          const furl: string = typeof frame.url === 'function' ? frame.url() : '';
          if (!furl || furl === 'about:blank') continue;
          const raws: any[] = await frame.evaluate(IFRAME_GATHER, `f${fi}-`);
          for (const raw of raws) frameCandidates.push(buildCandidate(raw, furl));
        } catch { /* cross-origin / detached frame — skip */ }
      }
    } catch { /* no frame support — skip */ }

    return [...mainCandidates, ...frameCandidates];
  }
}

/**
 * Small, self-contained interactive-element gatherer run INSIDE a child frame via
 * `frame.evaluate(IFRAME_GATHER, prefix)`. Returns the SAME raw shape the main-document
 * gather produces, so the same Node-side `buildCandidate` selector builder applies.
 * Kept minimal and shim-INDEPENDENT (only inline anonymous arrows, no named inner
 * functions) so it serializes safely into any frame, including cross-origin ones where
 * the worker's `__name` addInitScript shim may not have run. `prefix` keeps kaizenIds
 * unique across frames so the LLM can tell candidates from different frames apart.
 */
const IFRAME_GATHER = (prefix: string) => {
  const els = Array.from(document.querySelectorAll(
    'button, a, input, textarea, select, [role="button"], [role="link"], ' +
    '[role="checkbox"], [role="radio"], [role="textbox"], [role="tab"], [role="menuitem"]',
  )) as unknown as Element[];
  const out: any[] = [];
  let i = 1;
  for (const el of els) {
    const he = el as unknown as HTMLElement;
    const st = getComputedStyle(el);
    if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const kaizenId = `${prefix}kz-${i++}`;
    el.setAttribute('data-kaizen-id', kaizenId);
    const tag = el.tagName.toLowerCase();
    let role = el.getAttribute('role') || '';
    if (!role) {
      if (tag === 'button') role = 'button';
      else if (tag === 'a') role = 'link';
      else if (tag === 'select') role = 'combobox';
      else if (tag === 'textarea') role = 'textbox';
      else if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        role = t === 'checkbox' ? 'checkbox'
          : t === 'radio' ? 'radio'
          : (t === 'submit' || t === 'button' || t === 'reset') ? 'button'
          : t === 'search' ? 'searchbox' : 'textbox';
      }
    }
    let name = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
    if (!name && tag === 'input') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'submit' || t === 'button') name = el.getAttribute('value') || '';
    }
    if (!name) name = (he.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const attributes: Record<string, string> = {};
    for (const a of ['id', 'name', 'placeholder', 'aria-label', 'type', 'href', 'title', 'data-testid', 'data-qa', 'data-test', 'role']) {
      const v = el.getAttribute(a);
      if (v) attributes[a] = v;
    }
    out.push({
      kaizenId, role, accessibleName: name, attributes,
      textContent: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100),
      tagName: tag, parentContext: '',
      centerPoint: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
    });
  }
  return out;
};

// ── Selector escaping helpers ─────────────────────────────────────────────────

/** Escape a value for use inside a CSS attribute selector: [attr="VALUE"] */
function escapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Minimal CSS identifier escape for use in an id selector: #VALUE
 * Handles leading digits and special characters common in real-world ids.
 */
function cssEscapeId(id: string): string {
  // If the id starts with a digit, prefix with a unicode escape
  return id.replace(/([^\w-])/g, '\\$1').replace(/^(\d)/, '\\3$1 ');
}

/**
 * Extracts the accessible name from the first line of a Playwright locator.ariaSnapshot().
 * Format examples:
 *   `- link " Signup / Login":\n  - /url: /login`
 *   `- button "Sign in"`
 *   `- textbox`                                            (no name → returns null)
 *   `- img "User avatar \"Ada Lovelace\""`                 (escaped quotes inside)
 *
 * Returns null when no quoted name is present so the evaluate()-computed name
 * is retained as the fallback.
 */
export function parseAriaSnapshotName(snapshot: string): string | null {
  const firstLine = snapshot.split('\n', 1)[0] ?? '';
  // Match: "- <role> "<name>"" — captures everything between the first opening
  // quote and its matching closing quote, allowing \" escapes. Leading whitespace
  // INSIDE the quotes is preserved on purpose (this is the whole reason we switched).
  const match = firstLine.match(/^-\s+[\w-]+\s+"((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  return match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

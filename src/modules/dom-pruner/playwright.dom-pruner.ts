/// <reference lib="dom" />
import type { IDOMPruner } from './interfaces';
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
export class PlaywrightDOMPruner implements IDOMPruner {
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
    }> = await pwPage.evaluate(() => {
      // ── 1. Query semantic interactive elements ────────────────────────────
      const elements = Array.from(document.querySelectorAll(
        'button, a, input, textarea, select, ' +
        '[role="button"], [role="link"], [role="checkbox"], ' +
        '[role="searchbox"], [role="tab"], [role="menuitem"], [role="textbox"]',
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
        for (const attr of [
          'id', 'name', 'placeholder', 'aria-label', 'aria-labelledby',
          'type', 'href', 'title', 'data-testid', 'role',
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
          else if (tagName === 'textarea') role = 'textbox';
          else if (tagName === 'input') {
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            if (t === 'checkbox') role = 'checkbox';
            else if (t === 'radio') role = 'radio';
            else if (t === 'submit' || t === 'button' || t === 'reset') role = 'button';
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
          // Check for wrapping label
          const wrappingLabel = el.closest('label');
          if (wrappingLabel) {
            // Clone to remove the input text (the input itself has no text)
            const clone = wrappingLabel.cloneNode(true) as HTMLElement;
            clone.querySelectorAll('input, textarea, select').forEach((n) => n.remove());
            accessibleName = (clone.textContent || '').trim().replace(/\s+/g, ' ');
          }
        }

        if (!accessibleName) {
          accessibleName = el.getAttribute('placeholder') || el.getAttribute('title') || '';
        }

        // ── 7. Clean text content ─────────────────────────────────────────
        const textContent = (el.innerText || el.textContent || '')
          .trim()
          .replace(/\s+/g, ' ')
          .substring(0, 100);

        // For buttons and links, fall back to visible text as accessible name
        if (!accessibleName && (tagName === 'button' || tagName === 'a')) {
          accessibleName = textContent.substring(0, 80);
        }

        results.push({
          kaizenId,
          role,
          accessibleName,
          attributes,
          textContent,
          tagName,
          centerPoint: {
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          },
        });
      }

      return results;
    });

    // ── Patch accessible names using Playwright's own AX tree ─────────────────
    // Our evaluate() computes names from innerText/aria-label/etc., but Playwright's
    // role= selectors use the browser's FULL accessible name computation which
    // includes CSS ::before/::after pseudo-element content (e.g. Font Awesome icons).
    // Using page.accessibility.snapshot({ root }) per element gives us the exact
    // name Playwright will match against, so our ARIA selectors are always correct.
    const axPage = pwPage as any;
    if (axPage.accessibility?.snapshot) {
      for (const raw of rawCandidates) {
        try {
          const handle = await pwPage.$(`[data-kaizen-id='${raw.kaizenId}']`);
          if (handle) {
            const snapshot = await axPage.accessibility.snapshot({ root: handle });
            if (snapshot?.name) {
              raw.accessibleName = snapshot.name;
            }
          }
        } catch { /* keep the evaluate()-computed name as fallback */ }
      }
    }

    // ── Build ranked selector lists in Node.js ────────────────────────────────
    // (CSS.escape is a browser API; we use a simple escape helper here instead)
    return rawCandidates.map((raw) => {
      const { kaizenId, role, accessibleName, attributes, tagName } = raw;
      const id = attributes['id'];
      const name = attributes['name'];
      const testId = attributes['data-testid'];
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

      // ── Priority 3: data-testid ────────────────────────────────────────────
      if (testId) {
        selectors.push({
          selector: `[data-testid="${escapeAttr(testId)}"]`,
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
      } satisfies CandidateNode;
    });
  }
}

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

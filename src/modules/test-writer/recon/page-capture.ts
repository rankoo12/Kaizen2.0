/// <reference lib="dom" />
import { createHash } from 'crypto';
import type { CandidateNode } from '../../../types';
import type { FormCapture, LinkCapture } from '../interfaces';
import { normalizeHref, isSameOrigin } from './url-normalizer';

/**
 * Static page capture helpers for the RECON crawler — everything that can be
 * read from the page without interacting with it.
 * Spec ref: docs/specs/test-writer/spec-recon-crawler.md §3
 */

export type PageMeta = {
  title: string;
  headings: string[];
  hasVisiblePasswordInput: boolean;
};

export async function capturePageMeta(page: unknown): Promise<PageMeta> {
  const pwPage = page as any;
  try {
    return await pwPage.evaluate((): PageMeta => {
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .map((h) => ((h as HTMLElement).innerText || '').trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .slice(0, 20);

      const pw = Array.from(document.querySelectorAll('input[type="password"]')).some((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      return {
        title: (document.title ?? '').trim(),
        headings,
        hasVisiblePasswordInput: pw,
      };
    });
  } catch {
    return { title: '', headings: [], hasVisiblePasswordInput: false };
  }
}

/**
 * Read-only form structure capture. Forms are READ, never submitted — the
 * crawler never interacts with them at all.
 */
export async function captureForms(page: unknown): Promise<FormCapture[]> {
  const pwPage = page as any;
  try {
    return await pwPage.evaluate((): FormCapture[] => {
      const labelFor = (el: Element): string => {
        const aria = el.getAttribute('aria-label');
        if (aria) return aria;
        const id = el.getAttribute('id');
        if (id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lbl) return (lbl.textContent || '').trim().replace(/\s+/g, ' ');
        }
        const wrapping = el.closest('label');
        if (wrapping) return (wrapping.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        return el.getAttribute('placeholder') || el.getAttribute('name') || '';
      };

      return Array.from(document.querySelectorAll('form')).slice(0, 10).map((form) => {
        const fields = Array.from(form.querySelectorAll('input, textarea, select'))
          .filter((el) => (el.getAttribute('type') || '').toLowerCase() !== 'hidden')
          .slice(0, 20)
          .map((el) => ({
            label: labelFor(el),
            name: el.getAttribute('name') || '',
            type: el.tagName.toLowerCase() === 'input'
              ? (el.getAttribute('type') || 'text').toLowerCase()
              : el.tagName.toLowerCase(),
            required: el.hasAttribute('required'),
            placeholder: el.getAttribute('placeholder') || '',
          }));

        const submit = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
        const submitLabel = submit
          ? ((submit as HTMLElement).innerText || submit.getAttribute('value') || '').trim().replace(/\s+/g, ' ')
          : '';

        const label = form.getAttribute('aria-label')
          || form.getAttribute('name')
          || form.getAttribute('id')
          || fields.map((f) => f.label || f.name).filter(Boolean).slice(0, 3).join(', ');

        return { label, fields, submitLabel };
      });
    });
  } catch {
    return [];
  }
}

/**
 * All visible same-origin anchors on the page — link discovery is deliberately
 * NOT limited to the surveyed (capped) candidates so the nav graph stays
 * complete on link-heavy pages.
 */
export async function captureLinks(
  page: unknown,
  pageUrl: string,
  rootOrigin: string,
): Promise<LinkCapture[]> {
  const pwPage = page as any;
  let anchors: Array<{ href: string; text: string }> = [];
  try {
    anchors = await pwPage.evaluate((): Array<{ href: string; text: string }> =>
      Array.from(document.querySelectorAll('a[href]'))
        .filter((a) => {
          const rect = (a as HTMLElement).getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .slice(0, 300)
        .map((a) => ({
          href: a.getAttribute('href') || '',
          text: ((a as HTMLElement).innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        })));
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const links: LinkCapture[] = [];
  for (const a of anchors) {
    const normalized = normalizeHref(a.href, pageUrl);
    if (!normalized || !isSameOrigin(normalized, rootOrigin)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    links.push({ toUrlNormalized: normalized, viaElementName: a.text });
  }
  return links;
}

/**
 * Condensed AX outline + its content hash. The outline is what gets stored in
 * site_pages.ax_outline; the hash powers re-crawl diffing, so it must be
 * deterministic: sorted role/name pairs + form shapes, no volatile data.
 */
export function condenseOutline(
  survey: CandidateNode[],
  forms: FormCapture[],
  title: string,
  headings: string[],
): { outline: Record<string, unknown>; contentHash: string } {
  const elements = survey
    .map((c) => ({ role: c.role, name: c.name }))
    .sort((a, b) => (a.role + a.name).localeCompare(b.role + b.name));
  const formShapes = forms.map((f) => ({
    label: f.label,
    submitLabel: f.submitLabel,
    fields: f.fields.map((fd) => ({ label: fd.label, type: fd.type, required: fd.required })),
  }));
  const outline = { title, headings, elements, forms: formShapes };
  const contentHash = createHash('sha256').update(JSON.stringify(outline)).digest('hex');
  return { outline, contentHash };
}

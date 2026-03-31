/// <reference lib="dom" />
import type { IDOMPruner } from './interfaces';
import type { CandidateNode } from '../../types';

export class PlaywrightDOMPruner implements IDOMPruner {
  
  /**
   * Prunes the live browser DOM to extract only semantic, visible, interactive elements.
   * Modifies the live DOM to inject `data-kaizen-id` for instant location later.
   * 
   * @param page - live Playwright `Page` instance (passed as unknown to prevent strictly bounding to PW types)
   */
  async prune(page: unknown, targetDescription: string): Promise<CandidateNode[]> {
    const pwPage = page as any;
    
    // The script passed to evaluate() executes entirely within the browser context.
    const candidates = await pwPage.evaluate((desc: string) => {
      
      // 1. Querying Semantic Elements
      const elements = Array.from(document.querySelectorAll(
        'button, a, input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="searchbox"], [role="tab"], [role="menuitem"]'
      )) as HTMLElement[];

      const results: any[] = [];
      let kazienIndex = 1;

      for (const el of elements) {
        // 2. Visibility Check
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          continue;
        }

        const rect = el.getBoundingClientRect();
        // Skip elements with effectively 0 size (e.g., hidden tracking pixels)
        if (rect.width === 0 || rect.height === 0) {
          continue;
        }

        // 3. ID Assignment
        const kaizenId = `kz-${kazienIndex++}`;
        el.setAttribute('data-kaizen-id', kaizenId);

        // 4. Data Extraction
        const attributes: Record<string, string> = {};
        for (const attr of ['id', 'name', 'placeholder', 'aria-label', 'type', 'href', 'title', 'data-testid']) {
          const val = el.getAttribute(attr);
          if (val) attributes[attr] = val;
        }

        const tagName = el.tagName.toLowerCase();
        let role = el.getAttribute('role');
        if (!role) {
          if (tagName === 'button') role = 'button';
          if (tagName === 'a') role = 'link';
          if (tagName === 'input') {
            const t = el.getAttribute('type');
            role = (t === 'checkbox' || t === 'radio') ? t : 'textbox';
          }
          if (tagName === 'textarea') role = 'textbox';
          if (tagName === 'select') role = 'combobox';
        }

        // Extract a clean subset of text
        let text = (el.innerText || el.textContent || '').trim();
        // Clean excessive whitespace/newlines
        text = text.replace(/\s+/g, ' ').substring(0, 100);

        results.push({
          kaizenId,
          role: role || 'generic',
          name: el.getAttribute('aria-label') || el.getAttribute('title') || '',
          cssSelector: '',
          xpath: '',
          attributes,
          textContent: text,
          isVisible: true,
          similarityScore: 1.0,
          centerPoint: {
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2)
          }
        });
      }
      
      return results;
    }, targetDescription); // Pass the targetDescription as an argument to the browser script

    return candidates as CandidateNode[];
  }
}

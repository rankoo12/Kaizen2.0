import * as fs from 'fs';
import * as path from 'path';
import { classifyInteraction, DESTRUCTIVE_VERBS } from '../recon/safety';
import type { CandidateNode } from '../../../types';

/**
 * Adversarial classification table — spec-recon-crawler.md §8.
 * The invariant under test: nothing that mutates real state can ever be
 * classified 'safe-reveal', and ambiguity resolves DOWNWARD.
 */

const ctx = { rootOrigin: 'https://app.example.com', pageUrl: 'https://app.example.com/settings' };

function makeNode(partial: Partial<CandidateNode>): CandidateNode {
  return {
    kaizenId: 'kz-1',
    role: 'button',
    name: '',
    cssSelector: 'button',
    xpath: '',
    attributes: {},
    textContent: '',
    isVisible: true,
    similarityScore: 1,
    centerPoint: { x: 0, y: 0 },
    selectorCandidates: [],
    ...partial,
  };
}

describe('classifyInteraction — adversarial table', () => {
  it('classifies a "Delete account" button as mutating', () => {
    expect(classifyInteraction(makeNode({ name: 'Delete account' }), ctx)).toBe('mutating');
  });

  it('classifies a "Log out" link as session-ending (even though it is an anchor)', () => {
    const node = makeNode({ role: 'link', name: 'Log out', attributes: { href: '/logout' } });
    expect(classifyInteraction(node, ctx)).toBe('session-ending');
  });

  it.each(['Logout', 'Sign out', 'Log off', 'End session'])(
    'classifies "%s" as session-ending', (name) => {
      expect(classifyInteraction(makeNode({ name }), ctx)).toBe('session-ending');
    });

  it('classifies a search-form submit control as mutating', () => {
    const node = makeNode({ name: 'Search', attributes: { type: 'submit' } });
    expect(classifyInteraction(node, ctx)).toBe('mutating');
  });

  it('classifies a file upload input as mutating', () => {
    const node = makeNode({ role: 'button', name: 'Choose file', attributes: { type: 'file' } });
    expect(classifyInteraction(node, ctx)).toBe('mutating');
  });

  it('classifies a settings switch as mutating', () => {
    const node = makeNode({ role: 'switch', name: 'Email notifications' });
    expect(classifyInteraction(node, ctx)).toBe('mutating');
  });

  it('classifies an ambiguous unnamed button as mutating (default-down)', () => {
    expect(classifyInteraction(makeNode({ name: '' }), ctx)).toBe('mutating');
  });

  it('classifies a menu item with an action name as mutating, not safe-reveal', () => {
    const node = makeNode({ role: 'menuitem', name: 'Publish post' });
    expect(classifyInteraction(node, ctx)).toBe('mutating');
  });

  it.each(['Add to cart', 'Buy now', 'Checkout', 'Confirm order', 'Pay', 'Unsubscribe'])(
    'classifies "%s" as mutating via the destructive lexicon', (name) => {
      expect(classifyInteraction(makeNode({ name }), ctx)).toBe('mutating');
    });

  it('classifies a tab as safe-reveal', () => {
    expect(classifyInteraction(makeNode({ role: 'tab', name: 'Reviews' }), ctx)).toBe('safe-reveal');
  });

  it('classifies an aria-expanded disclosure toggle as safe-reveal', () => {
    const node = makeNode({ name: 'Filters', attributes: { 'aria-expanded': 'false' } });
    expect(classifyInteraction(node, ctx)).toBe('safe-reveal');
  });

  it('classifies an aria-haspopup menu opener as safe-reveal', () => {
    const node = makeNode({ name: 'Options', attributes: { 'aria-haspopup': 'menu' } });
    expect(classifyInteraction(node, ctx)).toBe('safe-reveal');
  });

  it.each(['Show more', 'View all', 'Expand', 'Read more'])(
    'classifies "%s" as safe-reveal via the reveal lexicon', (name) => {
      expect(classifyInteraction(makeNode({ name }), ctx)).toBe('safe-reveal');
    });

  it('a destructive name wins over a reveal signal (aria-expanded "Delete history")', () => {
    const node = makeNode({ name: 'Delete history', attributes: { 'aria-expanded': 'false' } });
    expect(classifyInteraction(node, ctx)).toBe('mutating');
  });
});

describe('classifyInteraction — anchors', () => {
  it('classifies a same-origin anchor as navigation', () => {
    const node = makeNode({ role: 'link', name: 'Pricing', attributes: { href: '/pricing' } });
    expect(classifyInteraction(node, ctx)).toBe('navigation');
  });

  it('classifies a fragment-only anchor as safe-reveal (the modal-opener pattern)', () => {
    // Calibration finding: modal openers are <a href="#">. Classifying them as
    // navigation made the BFS re-enqueue the current page and the modal never
    // opened, so its fields never entered the site model.
    const node = makeNode({ role: 'link', name: 'Log in', attributes: { href: '#' } });
    expect(classifyInteraction(node, ctx)).toBe('safe-reveal');
    const hashed = makeNode({ role: 'link', name: 'Sign up', attributes: { href: '#signupModal' } });
    expect(classifyInteraction(hashed, ctx)).toBe('safe-reveal');
  });

  it('refuses to follow a destructive anchor even though it is a GET link', () => {
    const node = makeNode({ role: 'link', name: 'Delete account', attributes: { href: '/account/delete' } });
    expect(classifyInteraction(node, ctx)).toBe('mutating');
  });

  it('still follows a signup link — visiting a page is not the same as submitting it', () => {
    const node = makeNode({ role: 'link', name: 'Sign up', attributes: { href: '/register' } });
    expect(classifyInteraction(node, ctx)).toBe('navigation');
  });

  it('classifies a cross-origin anchor as external', () => {
    const node = makeNode({ role: 'link', name: 'Docs', attributes: { href: 'https://docs.other.com/x' } });
    expect(classifyInteraction(node, ctx)).toBe('external');
  });

  it.each(['mailto:x@y.com', 'tel:+123456'])('classifies %s as external', (href) => {
    const node = makeNode({ role: 'link', name: 'Contact', attributes: { href } });
    expect(classifyInteraction(node, ctx)).toBe('external');
  });

  it('classifies a javascript: href as mutating (unknowable side effects)', () => {
    const node = makeNode({ role: 'link', name: 'More', attributes: { href: 'javascript:void(0)' } });
    expect(classifyInteraction(node, ctx)).toBe('mutating');
  });

  it('classifies a download link as external', () => {
    const node = makeNode({ role: 'link', name: 'Report', attributes: { href: '/report.pdf', download: '' } });
    expect(classifyInteraction(node, ctx)).toBe('external');
  });
});

describe('module isolation — test-writer never touches the shared pool', () => {
  // Spec-recon-crawler.md §7: no code path from the test-writer module graph
  // may write selector_cache or import the shared-pool seeding path.
  it('no test-writer source file references selector_cache or the seeding script', () => {
    const root = path.join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__') continue;
          walk(full);
        } else if (entry.name.endsWith('.ts')) {
          // Strip comments first — the invariant may legitimately be DOCUMENTED
          // in a module; what must never exist is CODE touching the shared pool.
          const source = fs.readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
          if (/selector_cache|seed-global-brain|is_shared/.test(source)) offenders.push(full);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('exports the destructive lexicon for the WRITE-phase safe-mode filter', () => {
    expect(DESTRUCTIVE_VERBS.length).toBeGreaterThan(10);
    expect(DESTRUCTIVE_VERBS).toContain('delete');
    expect(DESTRUCTIVE_VERBS).toContain('purchase');
  });
});

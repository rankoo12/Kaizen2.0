/**
 * Phase B — genuinely HARD, REAL websites (not purpose-built QA demos).
 *
 * These stress what real apps throw at a QA tool and demo sites don't: cookie-consent
 * overlays (often third-party / iframed), very large DOMs, dense non-semantic table
 * layouts, heavy client-side React nav, and real dynamic content. Assertions are chosen
 * to be STABLE across time (site chrome, URL paths) rather than volatile article text.
 *
 * Expect some of these to break on first contact — that is the point. What breaks tells
 * us the next real robustness fix.
 */
import type { BenchmarkTest } from '../lib/types';

export const REAL_SITE_TESTS: BenchmarkTest[] = [
  {
    // Cookie-consent wall (third-party overlay) that BLOCKS the page until dismissed,
    // then a nav on a heavy, ad-laden news site. The hard part is the overlay.
    id: 'real-guardian-consent', name: 'guardian: dismiss cookie consent → open Sport',
    baseUrl: 'https://www.theguardian.com/international', category: 'e2e-flow',
    steps: [
      'navigate to https://www.theguardian.com/international',
      'click the "Yes, I accept" button',
      'click the Sport link',
      'verify the URL contains "/sport"',
    ],
    oracle: { verdict: 'passed' },
    tags: ['real-site', 'cookie-consent', 'overlay'],
  },
  {
    // Very large DOM + a search box with a live autocomplete dropdown, then navigation
    // to an exact-title article. type is fill-based (no Enter), so submit via the button.
    id: 'real-wikipedia-search', name: 'wikipedia: search "Web browser" → open article',
    baseUrl: 'https://en.wikipedia.org', category: 'e2e-flow',
    steps: [
      'navigate to https://en.wikipedia.org',
      'type "Web browser" in the search field',
      'click the Search button',
      'verify the page contains "web browser"',
    ],
    oracle: { verdict: 'passed' },
    tags: ['real-site', 'search', 'large-dom'],
  },
  {
    // Dense, non-semantic table layout with tiny text links — the resolver must pick a
    // specific low-prominence nav link out of a crowded page.
    id: 'real-hackernews-new', name: 'hacker news: open the "new" listing',
    baseUrl: 'https://news.ycombinator.com', category: 'small-feature',
    steps: [
      'navigate to https://news.ycombinator.com',
      'click the new link',
      'verify the URL contains "newest"',
    ],
    oracle: { verdict: 'passed' },
    tags: ['real-site', 'dense-table', 'nav'],
  },
  {
    // Heavy client-side React marketing site with a mega-nav.
    id: 'real-github-pricing', name: 'github: open Pricing from the top nav',
    baseUrl: 'https://github.com', category: 'small-feature',
    steps: [
      'navigate to https://github.com',
      'click the Pricing link',
      'verify the URL contains "pricing"',
    ],
    oracle: { verdict: 'passed' },
    tags: ['real-site', 'react', 'nav'],
  },

  // ── heavy real sites (anti-bot-adjacent, huge DOMs, consent/overlays) ─────────
  {
    // Huge e-commerce DOM + a "Deliver to <country>" popup near the search bar. type is
    // fill-based (no Enter), so submit with the "Go" button.
    id: 'real-amazon-search', name: 'amazon: search for a product',
    baseUrl: 'https://www.amazon.com', category: 'e2e-flow',
    steps: [
      'navigate to https://www.amazon.com',
      'type "wireless mouse" in the search field',
      'click the Go button',
      'verify the page contains "mouse"',
    ],
    oracle: { verdict: 'passed' },
    tags: ['real-site', 'heavy', 'ecommerce', 'search'],
  },
  {
    // Heavy client-side SPA with a custom search box + magnifying-glass Search button.
    id: 'real-youtube-search', name: 'youtube: search',
    baseUrl: 'https://www.youtube.com', category: 'e2e-flow',
    steps: [
      'navigate to https://www.youtube.com',
      'type "lofi hip hop" in the search field',
      'click the Search button',
      'verify the page contains "lofi"',
    ],
    oracle: { verdict: 'passed' },
    tags: ['real-site', 'heavy', 'spa', 'search'],
  },
  // NOTE: `real-stackoverflow-consent` (intermittent Cloudflare bot-challenge —
  // sometimes serves a "checking your browser" interstitial where the consent button
  // does not exist) and `real-nytimes-nav` (no top-level "Politics" link on the home
  // page; sections live behind a menu) were removed. Both measured the environment, not
  // the brain, so they only added noise to the scorecard. See long-flows.ts for the
  // stable heavy targets that replaced them.
];

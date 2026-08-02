/**
 * Longer, ~10-step real-site flows — stress the brain across many resolutions,
 * cross-page navigation, and cache/heal continuity within a single session.
 *
 * Every target here is deterministic and NOT anti-bot-walled (verified by probe):
 * stable site chrome and URL paths, no volatile article text in the assertions.
 * These are the "genuinely hard real targets" — big DOMs, consent overlays,
 * dense non-semantic layouts, and heavy client-side rendering.
 */
import type { BenchmarkTest } from '../lib/types';

export const LONG_FLOW_TESTS: BenchmarkTest[] = [
  {
    // Encyclopedia: search, jump to a namespaced tab, then re-search. Exercises the
    // header search twice + a low-prominence tab link on a very large DOM.
    id: 'long-wikipedia-research',
    name: 'wikipedia: search → talk page → search again',
    baseUrl: 'https://en.wikipedia.org',
    category: 'e2e-flow',
    steps: [
      'navigate to https://en.wikipedia.org',
      'type "Alan Turing" in the search field',
      'click the Search button',
      'verify the page contains "Turing"',
      'click the Talk link',
      'verify the URL contains "Talk:Alan_Turing"',
      'type "Web browser" in the search field',
      'click the Search button',
      'verify the page contains "browser"',
      'verify the page contains "Web browser"',
    ],
    oracle: { verdict: 'passed' },
    tags: ['real-site', 'long-flow', 'large-dom', 'search', 'nav'],
  },
  {
    // Heavy, ad-laden news site with a cross-origin consent overlay, then four
    // section hops. "Football" is a single-word nav link that competes with article
    // headlines — a real test of the exact-name-match ranker.
    id: 'long-guardian-sections',
    name: 'guardian: consent → Sport → Football → Culture → Lifestyle',
    baseUrl: 'https://www.theguardian.com/international',
    category: 'e2e-flow',
    steps: [
      'navigate to https://www.theguardian.com/international',
      'click the "Yes, I accept" button',
      'click the Sport link',
      'verify the URL contains "/sport"',
      'click the Football link',
      'verify the URL contains "/football"',
      'click the Culture link',
      'verify the URL contains "/culture"',
      'click the Lifestyle link',
      'verify the URL contains "/lifeandstyle"',
    ],
    oracle: { verdict: 'passed' },
    tags: ['real-site', 'long-flow', 'cookie-consent', 'overlay', 'nav'],
  },
  {
    // Enormous e-commerce DOM plus a "Deliver to <country>" popup near the search
    // bar. Three sequential searches: the search field + Go button must stay
    // resolvable (and cached) across full-page result reloads.
    id: 'long-amazon-multi-search',
    name: 'amazon: three sequential product searches',
    baseUrl: 'https://www.amazon.com',
    category: 'e2e-flow',
    steps: [
      'navigate to https://www.amazon.com',
      'type "wireless mouse" in the search field',
      'click the Go button',
      'verify the page contains "mouse"',
      'type "mechanical keyboard" in the search field',
      'click the Go button',
      'verify the page contains "keyboard"',
      'type "usb-c cable" in the search field',
      'click the Go button',
      'verify the page contains "cable"',
    ],
    oracle: { verdict: 'passed' },
    tags: ['real-site', 'long-flow', 'heavy', 'ecommerce', 'search'],
  },
  {
    // Dense, non-semantic table layout with tiny single-word nav links. Each hop is
    // a low-prominence link that must be told apart from story titles.
    id: 'long-hackernews-nav',
    name: 'hacker news: new → comments → ask → show',
    baseUrl: 'https://news.ycombinator.com',
    category: 'e2e-flow',
    steps: [
      'navigate to https://news.ycombinator.com',
      'click the new link',
      'verify the URL contains "newest"',
      'click the comments link',
      'verify the URL contains "newcomments"',
      'click the ask link',
      'verify the URL contains "ask"',
      'click the show link',
      'verify the URL contains "show"',
      'verify the page contains "Hacker News"',
    ],
    oracle: { verdict: 'passed' },
    tags: ['real-site', 'long-flow', 'dense-table', 'nav'],
  },
];

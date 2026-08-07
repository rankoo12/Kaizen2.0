import type { CandidateNode } from '../../types';

/**
 * Test Writer — shared types for the RECON phase.
 * Spec refs:
 *   docs/specs/test-writer/spec-test-writer-service.md   (§3 layout, §8 lifecycle)
 *   docs/specs/test-writer/spec-recon-crawler.md         (§1 PageCapture, §4 safety)
 */

// ─── Interaction safety classification ───────────────────────────────────────

/**
 * Verdict for a candidate interaction during crawling. Only 'safe-reveal' is
 * ever performed; everything else is recorded but never touched. Ambiguity
 * resolves DOWNWARD (to 'mutating') — a missed reveal costs coverage, a false
 * "safe" costs a customer's production data.
 */
export type InteractionClass =
  | 'safe-reveal'      // tab / accordion / menu / modal-open / expand toggles
  | 'navigation'       // same-origin <a href> — followed via the BFS queue only
  | 'mutating'         // submits, destructive verbs, settings toggles, uploads
  | 'session-ending'   // logout — blocklisted (authenticated-crawler suicide)
  | 'external';        // cross-origin / mailto / tel / downloads — recorded only

// ─── Page capture (crawler output, comprehension input) ──────────────────────

export type FormCapture = {
  /** Accessible label for the form, or a synthesized one from its fields. */
  label: string;
  fields: Array<{
    label: string;
    name: string;
    type: string;
    required: boolean;
    placeholder: string;
  }>;
  submitLabel: string;
};

export type LinkCapture = {
  toUrlNormalized: string;
  /** Accessible name of the anchor that leads there (for page_links.via_element_id). */
  viaElementName: string;
};

export type RevealCapture = {
  /** The safe-reveal element that was probed. */
  trigger: { role: string; name: string };
  /** Elements that became visible only after the probe. */
  revealedElements: Array<{ role: string; name: string }>;
  /** Same-origin links that became visible only after the probe. */
  revealedLinks: string[];
};

export type PageCapture = {
  urlNormalized: string;
  title: string;
  headings: string[];
  survey: CandidateNode[];
  forms: FormCapture[];
  outgoingLinks: LinkCapture[];
  revealedStates: RevealCapture[];
  /** SHA-256 of the condensed AX outline — re-crawl diffing. */
  contentHash: string;
  screenshotKey: string | null;
  requiresAuth: boolean;
  blocked: 'challenge' | 'robots' | null;
};

// ─── Crawl result (pipeline-level) ───────────────────────────────────────────

export type CrawlReport = {
  pagesCrawled: number;
  pagesBlocked: number;
  probesPerformed: number;
  authScope: 'public' | 'authenticated';
  /** URLs discovered but not visited because the page budget was exhausted. */
  urlsSkippedByBudget: number;
};

// ─── Crawl budgets ───────────────────────────────────────────────────────────

export type CrawlBudgets = {
  maxPages: number;         // hard cap 50 (spec §4.3)
  maxDepth: number;         // default 5
  probesPerPage: number;    // default 8
  pageTimeoutMs: number;    // default 30_000
  jobTimeoutMs: number;     // default 20 * 60_000
  minPageIntervalMs: number; // rate limit, default 1_000
};

export const DEFAULT_BUDGETS: CrawlBudgets = {
  maxPages: 30,
  maxDepth: 5,
  probesPerPage: 8,
  pageTimeoutMs: 30_000,
  jobTimeoutMs: 20 * 60_000,
  minPageIntervalMs: 1_000,
};

export const HARD_MAX_PAGES = 50;

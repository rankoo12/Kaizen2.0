import { chromium, type Browser } from 'playwright';

/**
 * Shared-browser pool — Phase 3 (context-pool concurrency).
 *
 * With execution concurrency N, each concurrent run gets its own isolated
 * BrowserContext + page, but they all share ONE Chromium process — contexts
 * are ~free while browser launches cost seconds and hundreds of MB. The pool
 * owns the browser lifecycle:
 *
 *  - lazy launch on first use, deduped (concurrent callers during launch
 *    share one in-flight launch, never race a second browser into existence);
 *  - relaunch on next use after a crash/disconnect (a dead browser strands
 *    every subsequent run otherwise — this is the recovery path for OOM kills
 *    and Chromium crashes);
 *  - close() for graceful shutdown.
 *
 * The step loop remains the single sequential owner of each run's page — the
 * pool parallelises RUNS, never steps. Spec: spec-service-decomposition.md §7
 */

export type BrowserLauncher = () => Promise<Browser>;

const defaultLauncher: BrowserLauncher = () =>
  // Docker environments absolutely require headless: true without xvfb.
  chromium.launch({ headless: true });

export class BrowserPool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;

  constructor(private readonly launcher: BrowserLauncher = defaultLauncher) {}

  /** The shared browser, launching (or relaunching after a crash) if needed. */
  async get(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = null;

    // Dedupe concurrent launches: every caller that arrives while a launch is
    // in flight awaits the same promise.
    this.launching ??= this.launcher()
      .then((b) => {
        this.browser = b;
        return b;
      })
      .finally(() => {
        this.launching = null;
      });

    return this.launching;
  }

  async close(): Promise<void> {
    const b = this.browser ?? (this.launching ? await this.launching.catch(() => null) : null);
    this.browser = null;
    await b?.close().catch(() => { /* already gone */ });
  }
}

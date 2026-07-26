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
  private activeRuns = 0;
  private runsSinceLaunch = 0;

  constructor(
    private readonly launcher: BrowserLauncher = defaultLauncher,
    /**
     * Recycle the browser once this many runs have used it — a long-lived
     * Chromium slowly accumulates memory even with disposable contexts.
     * Recycling only happens at idle (no active runs), so it never kills a
     * concurrent run; the next acquire() relaunches.
     */
    private readonly maxRunsPerBrowser = Math.max(1, Number(process.env.BROWSER_MAX_RUNS ?? 50) || 50),
  ) {}

  /** The shared browser, launching (or relaunching after a crash) if needed. */
  async get(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = null;

    // Dedupe concurrent launches: every caller that arrives while a launch is
    // in flight awaits the same promise.
    this.launching ??= this.launcher()
      .then((b) => {
        this.browser = b;
        this.runsSinceLaunch = 0;
        return b;
      })
      .finally(() => {
        this.launching = null;
      });

    return this.launching;
  }

  /** get() + run accounting. Pair every acquire() with a release() in a finally. */
  async acquire(): Promise<Browser> {
    const b = await this.get();
    this.activeRuns++;
    this.runsSinceLaunch++;
    return b;
  }

  /** Marks a run finished; recycles the browser at idle once past the run budget. */
  async release(): Promise<void> {
    this.activeRuns = Math.max(0, this.activeRuns - 1);
    if (this.activeRuns === 0 && this.runsSinceLaunch >= this.maxRunsPerBrowser && this.browser) {
      const old = this.browser;
      this.browser = null;
      this.runsSinceLaunch = 0;
      await old.close().catch(() => { /* already gone */ });
    }
  }

  async close(): Promise<void> {
    const b = this.browser ?? (this.launching ? await this.launching.catch(() => null) : null);
    this.browser = null;
    await b?.close().catch(() => { /* already gone */ });
  }
}

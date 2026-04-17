/**
 * Challenge Detector
 *
 * Detects anti-bot challenge pages (Cloudflare Turnstile/IUAM, generic CAPTCHA)
 * that intercept the target URL before the real page content is served.
 *
 * Responsibilities (SRP):
 *  - Inspect the current Playwright page state via a single evaluate() call.
 *  - Return a structured ChallengeDetection on a positive match, null otherwise.
 *  - Never throw — callers treat a detection failure as "no challenge detected".
 *
 * The worker calls detect() at the start of each step, before element resolution.
 * On a positive result the step is immediately failed with error_type = the
 * challenge type string, and the healing engine is NOT invoked (there is nothing
 * to heal — the block must be resolved at the infrastructure level).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The kind of anti-bot challenge that was detected.
 *
 * 'cloudflare'      — Cloudflare IUAM ("Just a moment…") or Turnstile challenge.
 * 'generic_captcha' — Any other CAPTCHA page (hCaptcha, reCAPTCHA, etc.) that
 *                     was not specifically identified as Cloudflare.
 */
export type ChallengeType = 'cloudflare' | 'generic_captcha';

export type ChallengeDetection = {
  /** Specific challenge variant. */
  type: ChallengeType;
  /** Human-readable description for the step_results.error_type column and the UI. */
  message: string;
};

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IChallengeDetector {
  /**
   * Inspect the current page state and return a ChallengeDetection if an
   * anti-bot challenge is blocking the page, or null if the page appears normal.
   *
   * @param page - Live Playwright Page (typed as unknown to avoid a compile-time
   *               dependency on playwright in this interface layer).
   */
  detect(page: unknown): Promise<ChallengeDetection | null>;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class PageChallengeDetector implements IChallengeDetector {
  async detect(page: unknown): Promise<ChallengeDetection | null> {
    try {
      const result = await (page as any).evaluate((): {
        isCloudflare: boolean;
        isGenericCaptcha: boolean;
      } => {
        const title = document.title ?? '';
        const body  = document.body?.innerHTML ?? '';

        // ── Cloudflare IUAM / Turnstile signals ───────────────────────────────
        //
        // Cloudflare's challenge pages share a small, stable set of fingerprints:
        //
        // 1. Title: "Just a moment…" — the canonical IUAM spinner title.
        // 2. #challenge-running / #cf-challenge-running — injected by CF's JS
        //    while the challenge is being evaluated client-side.
        // 3. cf-chl-widget / cf_chl_f_tk — Turnstile widget container IDs.
        // 4. cf-spinner — the loading spinner element CF renders.
        // 5. The <meta name="cf-visiting-challenge"> tag CF injects when a
        //    browser challenge is in progress.
        //
        // We match at least one signal to avoid false-positives on pages that
        // legitimately contain the string "cloudflare" in their content.
        const iuamTitle      = /^just a moment/i.test(title);
        const cfRunning      = !!(
          document.getElementById('challenge-running') ||
          document.getElementById('cf-challenge-running')
        );
        const cfTurnstile    = !!(
          document.getElementById('cf-chl-widget') ||
          document.querySelector('[id^="cf-chl-widget-"]') ||
          document.querySelector('input[name="cf_captcha_kind"]') ||
          document.querySelector('meta[name="cf-visiting-challenge"]')
        );
        const cfSpinner      = !!document.getElementById('cf-spinner');
        const cfInBody       = /cloudflare/i.test(body) && iuamTitle;

        const isCloudflare = iuamTitle || cfRunning || cfTurnstile || cfSpinner || cfInBody;

        // ── Generic CAPTCHA signals ───────────────────────────────────────────
        //
        // Catch hCaptcha, reCAPTCHA, DataDome, PerimeterX, and similar pages
        // that were not specifically identified as Cloudflare above.
        const isHCaptcha      = !!document.querySelector('iframe[src*="hcaptcha.com"]');
        const isReCaptcha     = !!document.querySelector('iframe[src*="recaptcha"]');
        const isPerimeterX    = /perimeterx|px-captcha/i.test(body);
        const isDataDome      = /datadome/i.test(body) && /captcha/i.test(title);

        const isGenericCaptcha = !isCloudflare && (
          isHCaptcha || isReCaptcha || isPerimeterX || isDataDome
        );

        return { isCloudflare, isGenericCaptcha };
      });

      if (result.isCloudflare) {
        return {
          type: 'cloudflare',
          message: 'Cloudflare anti-bot challenge intercepted the page. ' +
                   'The test cannot proceed until the challenge is resolved at the ' +
                   'infrastructure level (e.g. use a residential proxy or authenticated origin).',
        };
      }

      if (result.isGenericCaptcha) {
        return {
          type: 'generic_captcha',
          message: 'A CAPTCHA challenge is blocking the page. ' +
                   'The test cannot proceed until the CAPTCHA is bypassed.',
        };
      }

      return null;
    } catch {
      // evaluate() can fail if the page is in an error state (net::ERR_*, etc.).
      // Treat as no challenge detected — the step will fail for the real reason.
      return null;
    }
  }
}

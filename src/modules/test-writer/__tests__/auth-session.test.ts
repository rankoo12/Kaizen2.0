import { acquireSession, isSessionLoss, type LoginStep } from '../recon/auth-session';
import { blockedDestinationReason } from '../recon/destination-guard';
import type { StepAST } from '../../../types';

/**
 * Session acquisition — spec-authenticated-scope.md §4.
 *
 * The invariants: a login that cannot be PROVEN fails closed (a false "verified"
 * spends the whole crawl budget producing a public crawl mislabeled
 * authenticated); the recipe can never navigate off-origin or into Kaizen's own
 * infrastructure; and nothing here heals, screenshots, or logs a value.
 */

const ORIGIN = 'https://app.example.com';

function ast(partial: Partial<StepAST>): StepAST {
  return {
    action: 'click',
    targetDescription: 'the sign in button',
    value: null,
    url: null,
    rawText: 'click the sign in button',
    contentHash: 'ch',
    targetHash: 'th',
    ...partial,
  } as StepAST;
}

function step(partial: Partial<StepAST>): LoginStep {
  const a = ast(partial);
  return { rawText: a.rawText, ast: a };
}

/** A page whose URL advances through a scripted list as steps execute. */
function makePage(opts: {
  urls: string[];
  passwordVisible?: boolean | boolean[];
}) {
  let idx = 0;
  const passwordAt = (i: number) =>
    Array.isArray(opts.passwordVisible) ? !!opts.passwordVisible[i] : !!opts.passwordVisible;
  return {
    handlers: {} as Record<string, (arg: unknown) => void>,
    url: () => opts.urls[Math.min(idx, opts.urls.length - 1)],
    advance: () => { idx++; },
    on(evt: string, fn: (arg: unknown) => void) { this.handlers[evt] = fn; },
    off(evt: string) { delete this.handlers[evt]; },
    // Shaped like capturePageMeta's return — auth-session reuses that probe
    // rather than running its own.
    evaluate: async () => ({
      title: 'page',
      headings: [],
      hasVisiblePasswordInput: passwordAt(Math.min(idx, opts.urls.length - 1)),
    }),
  };
}

function makeDeps(overrides: Partial<{
  execute: jest.Mock;
  resolve: jest.Mock;
  detect: jest.Mock;
}> = {}) {
  const obs = {
    startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
    log: jest.fn(), increment: jest.fn(), histogram: jest.fn(),
  };
  return {
    engine: { executeStep: overrides.execute ?? jest.fn().mockResolvedValue({ status: 'passed' }) } as any,
    resolver: {
      resolve: overrides.resolve ?? jest.fn().mockResolvedValue({
        selectors: [{ selector: '#x', strategy: 'css', confidence: 1 }],
        resolutionSource: 'redis', tokensUsed: 0,
      }),
      recordSuccess: jest.fn(), recordFailure: jest.fn(),
    } as any,
    challenges: { detect: overrides.detect ?? jest.fn().mockResolvedValue(null) } as any,
    obs: obs as any,
  };
}

const params = {
  tenantId: 't1', rootOrigin: ORIGIN, domain: 'app.example.com',
  pageTimeoutMs: 30_000, steps: [] as LoginStep[],
};

describe('acquireSession — verification decision table (§4.3)', () => {
  it('fails closed when the password form is still visible', async () => {
    const page = makePage({ urls: [`${ORIGIN}/login`], passwordVisible: true });
    const deps = makeDeps();
    const res = await acquireSession(page, {
      ...params,
      steps: [step({ action: 'navigate', url: `${ORIGIN}/login` }), step({})],
    }, deps);

    expect(res.verified).toBe(false);
    if (!res.verified) {
      expect(res.reason).toBe('login_failed');
      expect(res.detail).toMatch(/still on screen/);
    }
  });

  it('verifies via heuristic when the URL changed and there is no terminal assertion', async () => {
    const page = makePage({ urls: [`${ORIGIN}/login`, `${ORIGIN}/dashboard`] });
    const deps = makeDeps({
      // The navigate LANDS on the sign-in page; it is the submit that moves on.
      execute: jest.fn().mockImplementation(async (a: StepAST) => {
        if (a.action !== 'navigate') page.advance();
        return { status: 'passed' };
      }),
    });
    const res = await acquireSession(page, {
      ...params,
      steps: [step({ action: 'navigate', url: `${ORIGIN}/login` }), step({})],
    }, deps);

    expect(res.verified).toBe(true);
    if (res.verified) expect(res.sessionVerification).toBe('heuristic');
  });

  it('verifies as assertion+heuristic when the recipe ends on a passing assertion', async () => {
    const page = makePage({ urls: [`${ORIGIN}/login`, `${ORIGIN}/dashboard`] });
    const deps = makeDeps({
      // The navigate LANDS on the sign-in page; it is the submit that moves on.
      execute: jest.fn().mockImplementation(async (a: StepAST) => {
        if (a.action !== 'navigate') page.advance();
        return { status: 'passed' };
      }),
    });
    const res = await acquireSession(page, {
      ...params,
      steps: [
        step({ action: 'navigate', url: `${ORIGIN}/login` }),
        step({ action: 'assert_visible', targetDescription: 'the dashboard' }),
      ],
    }, deps);

    expect(res.verified).toBe(true);
    if (res.verified) expect(res.sessionVerification).toBe('assertion+heuristic');
  });

  it('verifies an SPA login that never changes URL but asserts a signed-in state', async () => {
    const page = makePage({ urls: [`${ORIGIN}/login`] });
    const deps = makeDeps();
    const res = await acquireSession(page, {
      ...params,
      steps: [
        step({ action: 'navigate', url: `${ORIGIN}/login` }),
        step({ action: 'assert_visible', targetDescription: 'the dashboard' }),
      ],
    }, deps);

    expect(res.verified).toBe(true);
  });

  it('fails closed on an SPA login with neither a URL change nor an assertion', async () => {
    const page = makePage({ urls: [`${ORIGIN}/login`] });
    const deps = makeDeps();
    const res = await acquireSession(page, {
      ...params,
      steps: [step({ action: 'navigate', url: `${ORIGIN}/login` }), step({})],
    }, deps);

    expect(res.verified).toBe(false);
    if (!res.verified) expect(res.detail).toMatch(/add an assertion/);
  });
});

describe('acquireSession — credential-free recipes (the recommended pattern)', () => {
  // The demo sign-in button types nothing, so "the URL where the password was
  // typed" is undefined for it — the fallback anchor must cover this.
  it('verifies a button-only recipe and anchors loginPageUrl to the landed URL', async () => {
    const page = makePage({ urls: [`${ORIGIN}/login`, `${ORIGIN}/tests`] });
    const deps = makeDeps({
      // The navigate LANDS on the sign-in page; it is the submit that moves on.
      execute: jest.fn().mockImplementation(async (a: StepAST) => {
        if (a.action !== 'navigate') page.advance();
        return { status: 'passed' };
      }),
    });
    const res = await acquireSession(page, {
      ...params,
      steps: [
        step({ action: 'navigate', url: `${ORIGIN}/login`, rawText: 'go to the login page' }),
        step({ targetDescription: 'the demo sign-in button' }),
      ],
    }, deps);

    expect(res.verified).toBe(true);
    if (res.verified) {
      expect(res.loginPageUrl).toBe(`${ORIGIN}/login`);
      expect(res.landedUrl).toBe(`${ORIGIN}/tests`);
    }
  });
});

describe('acquireSession — navigation guards (§3.1)', () => {
  it('refuses a recipe that navigates off-origin', async () => {
    const page = makePage({ urls: [`${ORIGIN}/`] });
    const res = await acquireSession(page, {
      ...params,
      steps: [step({ action: 'navigate', url: 'https://evil.example.net/login' })],
    }, makeDeps());

    expect(res.verified).toBe(false);
    if (!res.verified) expect(res.detail).toMatch(/not the site being analyzed/);
  });

  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'link-local / cloud metadata'],
    ['http://127.0.0.1:6379/', 'loopback'],
    ['http://localhost:5432/', 'loopback'],
    ['http://10.0.0.5/admin', 'private network'],
    ['http://192.168.1.1/', 'private network'],
    ['http://172.16.0.9/', 'private network'],
    ['http://redis.internal/', 'internal hostname'],
  ])('refuses %s', async (url) => {
    const page = makePage({ urls: [`${ORIGIN}/`] });
    const res = await acquireSession(page, {
      ...params,
      steps: [step({ action: 'navigate', url })],
    }, makeDeps());

    expect(res.verified).toBe(false);
    if (!res.verified) expect(res.reason).toBe('login_failed');
  });

  it('classifies blocked destinations correctly', () => {
    expect(blockedDestinationReason('http://169.254.169.254/')).toBe('link-local / cloud metadata');
    expect(blockedDestinationReason('https://app.example.com/login')).toBeNull();
  });
});

describe('acquireSession — failure modes', () => {
  it('blocks on a challenge during the sign-in flow rather than bypassing it', async () => {
    const page = makePage({ urls: [`${ORIGIN}/login`] });
    const deps = makeDeps({ detect: jest.fn().mockResolvedValue({ type: 'recaptcha' }) });
    const res = await acquireSession(page, {
      ...params,
      steps: [step({ action: 'navigate', url: `${ORIGIN}/login` })],
    }, deps);

    expect(res.verified).toBe(false);
    if (!res.verified) {
      expect(res.reason).toBe('login_challenge');
      expect(res.detail).toMatch(/bot check/);
    }
  });

  it('names the failing step and does NOT heal', async () => {
    const page = makePage({ urls: [`${ORIGIN}/login`] });
    const execute = jest.fn()
      .mockResolvedValueOnce({ status: 'passed' })
      .mockResolvedValueOnce({ status: 'failed', errorMessage: 'element not found' });
    const deps = makeDeps({ execute });

    const res = await acquireSession(page, {
      ...params,
      steps: [step({ action: 'navigate', url: `${ORIGIN}/login` }), step({})],
    }, deps);

    expect(res.verified).toBe(false);
    if (!res.verified) {
      expect(res.detail).toContain('step 2 of the sign-in test');
      expect(res.stepsPassed).toBe(1);
    }
    // Exactly two attempts: no retry, no healing round.
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('fails when an element cannot be resolved', async () => {
    const page = makePage({ urls: [`${ORIGIN}/login`] });
    const deps = makeDeps({
      resolve: jest.fn().mockResolvedValue({ selectors: [], resolutionSource: 'redis', tokensUsed: 0 }),
    });
    const res = await acquireSession(page, { ...params, steps: [step({})] }, deps);

    expect(res.verified).toBe(false);
    if (!res.verified) expect(res.detail).toMatch(/could not find/);
  });
});

describe('acquireSession — isolation', () => {
  it('resolves every element with behindAuth set, so nothing reaches the shared pool', async () => {
    const page = makePage({ urls: [`${ORIGIN}/login`, `${ORIGIN}/dashboard`] });
    const resolve = jest.fn().mockResolvedValue({
      selectors: [{ selector: '#x', strategy: 'css', confidence: 1 }],
      resolutionSource: 'redis', tokensUsed: 0,
    });
    const deps = makeDeps({
      resolve,
      // The navigate LANDS on the sign-in page; it is the submit that moves on.
      execute: jest.fn().mockImplementation(async (a: StepAST) => {
        if (a.action !== 'navigate') page.advance();
        return { status: 'passed' };
      }),
    });

    await acquireSession(page, {
      ...params,
      steps: [step({ action: 'navigate', url: `${ORIGIN}/login` }), step({}), step({ action: 'type', targetDescription: 'the password field', value: 'pw' })],
    }, deps);

    expect(resolve).toHaveBeenCalled();
    for (const call of resolve.mock.calls) {
      expect(call[1].behindAuth).toBe(true);
    }
  });
});

describe('isSessionLoss (§5.1)', () => {
  const LOGIN = `${ORIGIN}/login`;

  it('fires on a redirect to a page with a password input', () => {
    expect(isSessionLoss(LOGIN, `${ORIGIN}/orders`, LOGIN, true)).toBe(true);
  });

  it('fires when landing on the recorded login URL even with no password field yet', () => {
    // Some apps render the form lazily; by the time we looked it did not exist.
    expect(isSessionLoss(LOGIN, `${ORIGIN}/orders`, LOGIN, false)).toBe(true);
  });

  it('does not fire on an ordinary navigation', () => {
    expect(isSessionLoss(`${ORIGIN}/orders`, `${ORIGIN}/orders`, LOGIN, false)).toBe(false);
  });

  it('does not fire when the login page is itself the requested URL', () => {
    expect(isSessionLoss(LOGIN, LOGIN, LOGIN, false)).toBe(false);
  });
});

import { LLMElementResolver } from '../llm.element-resolver';
import type { IDOMPruner } from '../../dom-pruner/interfaces';
import type { ILLMGateway } from '../../llm-gateway/interfaces';
import type { IObservability } from '../../observability/interfaces';

jest.mock('../../../db/pool', () => ({
  getPool: jest.fn().mockReturnValue({ query: jest.fn() }),
}));

import { getPool } from '../../../db/pool';

/**
 * B9 — iframe-resolved elements never reached the cache, so every run re-paid the model
 * to dismiss the same consent banner. Spec: spec-iframe-selector-caching.md §4.2.
 *
 * These tests drive resolveInFrame directly. Driving it through resolve() would mean
 * standing up the pruner, the LLM gateway's candidate ranking and the page-validation
 * path, none of which this behaviour depends on.
 */

const CONSENT_LIVE = 'https://cdn.privacy-mgmt.com/index.html?consentUUID=8f3c&_sp=x';
const CONSENT_CANONICAL = 'https://cdn.privacy-mgmt.com/index.html';

const ACCEPT = { selector: 'button[title="Accept all"]', strategy: 'css' as const, confidence: 0.9 };
const KZ = { selector: "[data-kaizen-id='kz-7']", strategy: 'css' as const, confidence: 0.5 };

const step = {
  action: 'click' as const,
  targetDescription: 'accept cookies',
  value: null,
  url: null,
  rawText: 'click accept cookies',
  contentHash: 'ch-consent',
  targetHash: 'th-consent',
};

const context = (page: unknown) => ({
  tenantId: 'tenant-1',
  domain: 'example.com',
  page,
  pageUrl: 'https://example.com/',
});

const candidate = (overrides: Record<string, unknown> = {}) => ({
  kaizenId: 'kz-7',
  role: 'button',
  name: 'Accept all',
  cssSelector: ACCEPT.selector,
  xpath: '',
  frameUrl: CONSENT_LIVE,
  selectorCandidates: [ACCEPT],
  ...overrides,
});

/**
 * A page with one consent frame. `counts` maps a selector to how many elements it
 * matches inside the frame; anything unlisted matches nothing.
 */
const pageWithConsentFrame = (
  counts: Record<string, number>,
  opts: { frameUrl?: string; synthesize?: string | null } = {},
) => {
  const frameUrl = opts.frameUrl ?? CONSENT_LIVE;
  const locator = (s: string) => ({
    count: async () => counts[s] ?? 0,
    first: () => ({ evaluate: async () => opts.synthesize ?? null }),
  });
  const frame = {
    url: () => frameUrl,
    locator,
    // synthesizeUniqueSelector verifies uniqueness through $$ after building the path.
    $$: async (s: string) => new Array(counts[s] ?? 0).fill({}),
    $: async (s: string) => ((counts[s] ?? 0) > 0 ? {} : null),
  };
  return { frames: () => [frame] };
};

describe('LLMElementResolver — resolving inside a child frame', () => {
  let resolver: LLMElementResolver;
  let obs: jest.Mocked<IObservability>;
  let mockQuery: jest.Mock;
  let gateway: jest.Mocked<ILLMGateway>;

  const build = (options?: { cacheWrites?: boolean }) => {
    const pruner: jest.Mocked<IDOMPruner> = { prune: jest.fn() };
    return new LLMElementResolver(pruner, gateway, obs, undefined, {
      scan: jest.fn().mockResolvedValue(['0', []]),
      del: jest.fn().mockResolvedValue(0),
    } as any, options);
  };

  beforeEach(() => {
    obs = {
      startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
      log: jest.fn(),
      increment: jest.fn(),
      histogram: jest.fn(),
    } as unknown as jest.Mocked<IObservability>;
    mockQuery = jest.fn().mockResolvedValue({ rows: [] });
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });
    gateway = {
      compileStep: jest.fn(),
      resolveElement: jest.fn(),
      generateEmbedding: jest.fn().mockResolvedValue(Array(1536).fill(0.1)),
    } as unknown as jest.Mocked<ILLMGateway>;
    resolver = build();
  });

  afterEach(() => jest.clearAllMocks());

  const resolveInFrame = (r: LLMElementResolver, cand: unknown, llmResult: unknown, page: unknown) =>
    (r as any).resolveInFrame(cand, llmResult, [cand], context(page), step);

  /** The INSERT the cache write ends in, or undefined if nothing was written. */
  const cacheInsert = () =>
    mockQuery.mock.calls.find((c) => /INSERT INTO selector_cache/.test(c[0]));

  // Give persistToCache's two awaited embedding calls a turn to settle — it is
  // launched fire-and-forget (`void`) so the resolve path is never blocked on I/O.
  const settle = () => new Promise((r) => setImmediate(r));

  it('caches a stable in-frame selector under the CANONICAL frame url', async () => {
    const set = await resolveInFrame(
      resolver,
      candidate(),
      { selectors: [ACCEPT], llmPickedKaizenId: 'kz-7', promptTokens: 90, completionTokens: 20 },
      pageWithConsentFrame({ [ACCEPT.selector]: 1 }),
    );
    await settle();

    expect(set.selectors).toEqual([ACCEPT]);
    // The returned set carries the LIVE url so the engine acts on this exact frame now.
    expect(set.frameUrl).toBe(CONSENT_LIVE);

    const insert = cacheInsert();
    expect(insert).toBeDefined();
    expect(JSON.parse(insert![1][3])).toEqual([ACCEPT]);
    // ...while the cache stores the canonical form, which is what survives the session.
    expect(insert![1][6]).toBe(CONSENT_CANONICAL);
  });

  it('never caches a data-kaizen-id, which does not exist on the next page load', async () => {
    const set = await resolveInFrame(
      resolver,
      candidate({ selectorCandidates: [] }),
      { selectors: [], llmPickedKaizenId: 'kz-7' },
      // Only the kz-id resolves, and synthesis finds nothing structural either.
      pageWithConsentFrame({ [KZ.selector]: 1 }, { synthesize: null }),
    );
    await settle();

    expect(set.selectors).toEqual([KZ]);         // still acts, this run
    expect(cacheInsert()).toBeUndefined();       // but writes nothing
    expect(obs.increment).toHaveBeenCalledWith('resolver.frame_uncacheable');
  });

  it('synthesizes a structural selector inside the frame when only the kz-id resolves', async () => {
    const set = await resolveInFrame(
      resolver,
      candidate({ selectorCandidates: [] }),
      { selectors: [], llmPickedKaizenId: 'kz-7' },
      pageWithConsentFrame(
        { [KZ.selector]: 1, 'div > button:nth-of-type(2)': 1 },
        { synthesize: 'div > button:nth-of-type(2)' },
      ),
    );
    await settle();

    expect(set.selectors).toEqual([KZ]);   // execution uses what worked this run
    const insert = cacheInsert();
    expect(JSON.parse(insert![1][3])).toEqual([
      { selector: 'div > button:nth-of-type(2)', strategy: 'css', confidence: 0.85 },
    ]);
    expect(obs.increment).toHaveBeenCalledWith('resolver.frame_synthesized_selector');
  });

  it('does not cache an AMBIGUOUS in-frame selector — it would target the wrong element', async () => {
    const set = await resolveInFrame(
      resolver,
      candidate(),
      { selectors: [ACCEPT], llmPickedKaizenId: 'kz-7' },
      // Two buttons share the selector, and nothing structural is available.
      pageWithConsentFrame({ [ACCEPT.selector]: 2 }, { synthesize: null }),
    );
    await settle();

    expect(set.selectors).toEqual([ACCEPT]);  // acts on it this run, as before
    expect(cacheInsert()).toBeUndefined();
  });

  it('does not cache a frame with no durable identity (about:blank)', async () => {
    await resolveInFrame(
      resolver,
      candidate({ frameUrl: 'about:blank' }),
      { selectors: [ACCEPT], llmPickedKaizenId: 'kz-7' },
      pageWithConsentFrame({ [ACCEPT.selector]: 1 }, { frameUrl: 'about:blank' }),
    );
    await settle();

    expect(cacheInsert()).toBeUndefined();
  });

  it('writes nothing when the resolver was built with cacheWrites off', async () => {
    const noWrites = build({ cacheWrites: false });
    const set = await resolveInFrame(
      noWrites,
      candidate(),
      { selectors: [ACCEPT], llmPickedKaizenId: 'kz-7' },
      pageWithConsentFrame({ [ACCEPT.selector]: 1 }),
    );
    await settle();

    expect(set.selectors).toEqual([ACCEPT]);
    expect(cacheInsert()).toBeUndefined();
  });

  it('returns null when the frame is gone, so resolution falls through to the page path', async () => {
    const set = await resolveInFrame(
      resolver,
      candidate(),
      { selectors: [ACCEPT], llmPickedKaizenId: 'kz-7' },
      { frames: () => [] },
    );
    expect(set).toBeNull();
  });

  it('zeroes tokens on a prompt-cache replay, in the frame path too', async () => {
    const set = await resolveInFrame(
      resolver,
      candidate(),
      { selectors: [ACCEPT], llmPickedKaizenId: 'kz-7', promptTokens: 90, completionTokens: 20, fromCache: true },
      pageWithConsentFrame({ [ACCEPT.selector]: 1 }),
    );
    expect(set.tokensUsed).toBe(0);
  });
});

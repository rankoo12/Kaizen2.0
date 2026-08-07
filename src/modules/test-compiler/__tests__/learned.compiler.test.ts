import { LearnedCompiler } from '../learned.compiler';
import type { ILLMGateway } from '../../llm-gateway/interfaces';
import type { IObservability } from '../../observability/interfaces';
import type { StepAST } from '../../../types';

// Mock the DB pool so tests run without a real Postgres connection
jest.mock('../../../db/pool', () => ({
  getPool: jest.fn().mockReturnValue({
    query: jest.fn(),
  }),
}));

import { getPool } from '../../../db/pool';

describe('LearnedCompiler', () => {
  let mockLLMGateway: jest.Mocked<ILLMGateway>;
  let mockObservability: jest.Mocked<IObservability>;
  let mockQuery: jest.Mock;
  let compiler: LearnedCompiler;

  beforeEach(() => {
    mockLLMGateway = {
      compileStep: jest.fn(),
      resolveElement: jest.fn(),
      generateEmbedding: jest.fn(),
    };

    mockObservability = {
      startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
      log: jest.fn(),
      increment: jest.fn(),
      histogram: jest.fn(),
    };

    // Reset the DB mock before each test
    mockQuery = jest.fn();
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });

    compiler = new LearnedCompiler(mockLLMGateway, mockObservability);
  });

  // ─── L2: DB cache hit ──────────────────────────────────────────────────────

  it('returns from DB cache and skips LLM when compiled_ast_cache has the entry', async () => {
    const rawText = 'click the submit button';
    const storedAst = { action: 'click', targetDescription: 'submit button', value: null, url: null };

    // Simulate DB returning a seeded entry
    mockQuery.mockResolvedValueOnce({ rows: [{ ast_json: storedAst }] });

    const result = await compiler.compile(rawText);

    expect(result.action).toBe('click');
    expect(result.targetDescription).toBe('submit button');
    expect(result.rawText).toBe(rawText);
    expect(result.contentHash).toBeDefined();
    expect(mockLLMGateway.compileStep).not.toHaveBeenCalled();
    expect(mockObservability.increment).toHaveBeenCalledWith('compiler.cache_hit', { source: 'db' });
  });

  // ─── L1: memory cache hit (second call) ───────────────────────────────────

  it('serves from memory cache on the second call — no DB or LLM hit', async () => {
    const rawText = 'click the submit button';
    const storedAst = { action: 'click', targetDescription: 'submit button', value: null, url: null };

    // First call hits DB
    mockQuery.mockResolvedValueOnce({ rows: [{ ast_json: storedAst }] });
    await compiler.compile(rawText);

    // Second call — DB query should NOT be called again
    const result = await compiler.compile(rawText);

    expect(result.action).toBe('click');
    expect(mockQuery).toHaveBeenCalledTimes(1); // only the first call queries DB
    expect(mockObservability.increment).toHaveBeenLastCalledWith('compiler.cache_hit', { source: 'memory' });
  });

  // ─── L3: LLM fallback on full miss ────────────────────────────────────────

  it('calls LLM when both memory and DB miss, then persists the result', async () => {
    const rawText = 'smash the subscribe button';
    const llmAst: StepAST = {
      action: 'click',
      targetDescription: 'subscribe button',
      value: null,
      url: null,
      rawText,
      contentHash: 'stub',
      targetHash: 'test-target-hash',
    };

    // DB returns empty (cache miss)
    mockQuery
      .mockResolvedValueOnce({ rows: [] })   // lookupFromDB
      .mockResolvedValueOnce({ rows: [] });  // persistToDB

    mockLLMGateway.compileStep.mockResolvedValueOnce(llmAst);

    const result = await compiler.compile(rawText);

    expect(result.action).toBe('click');
    expect(result.targetDescription).toBe('subscribe button');
    expect(mockLLMGateway.compileStep).toHaveBeenCalledTimes(1);
    expect(mockObservability.increment).toHaveBeenCalledWith('compiler.cache_miss');

    // Verify it persisted to DB
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const persistCall = mockQuery.mock.calls[1];
    expect(persistCall[0]).toContain('INSERT INTO compiled_ast_cache');
  });

  // ─── DB failure resilience ─────────────────────────────────────────────────

  it('falls back to LLM gracefully when DB is unavailable', async () => {
    const rawText = 'click the buy now button';
    const llmAst: StepAST = {
      action: 'click',
      targetDescription: 'buy now button',
      value: null,
      url: null,
      rawText,
      contentHash: 'stub',
      targetHash: 'test-target-hash',
    };

    // DB throws (connection refused)
    mockQuery.mockRejectedValue(new Error('ECONNREFUSED'));
    mockLLMGateway.compileStep.mockResolvedValueOnce(llmAst);

    const result = await compiler.compile(rawText);

    expect(result.action).toBe('click');
    expect(mockLLMGateway.compileStep).toHaveBeenCalledTimes(1);
    expect(mockObservability.log).toHaveBeenCalledWith('warn', 'compiler.db_lookup_failed', expect.any(Object));
  });

  // ─── Credentials must never reach the GLOBAL compile cache ─────────────────
  // compiled_ast_cache is keyed on content_hash alone: no tenant_id, no RLS
  // (002_seed_compiled_ast_cache.sql). Its ast_json stores `value`, so persisting
  // a compiled password step published that password to every tenant, forever,
  // outside any offboarding purge. Spec: spec-authenticated-scope.md §12.3.

  it('does NOT write a password step to the global compiled_ast_cache', async () => {
    const rawText = 'type "Hunter2!" into the password field';
    mockQuery.mockResolvedValueOnce({ rows: [] }); // lookupFromDB — miss
    mockLLMGateway.compileStep.mockResolvedValueOnce({
      action: 'type', targetDescription: 'the password field', value: 'Hunter2!',
      url: null, rawText, contentHash: 'stub', targetHash: 'th',
    } as StepAST);

    const result = await compiler.compile(rawText);

    // The step still compiles correctly — it just isn't published.
    expect(result.value).toBe('Hunter2!');
    const inserts = mockQuery.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO compiled_ast_cache'));
    expect(inserts).toHaveLength(0);
    expect(mockObservability.increment).toHaveBeenCalledWith('compiler.global_cache_write_skipped');
  });

  it('does NOT write any literal-valued type step to the global cache', async () => {
    // Even a non-secret-named field: a literal typed value is tenant data, and
    // the global cache is the wrong home for it.
    const rawText = 'type "acme-internal-code" into the access field';
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockLLMGateway.compileStep.mockResolvedValueOnce({
      action: 'type', targetDescription: 'the access field', value: 'acme-internal-code',
      url: null, rawText, contentHash: 'stub', targetHash: 'th',
    } as StepAST);

    await compiler.compile(rawText);

    const inserts = mockQuery.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO compiled_ast_cache'));
    expect(inserts).toHaveLength(0);
  });

  it('still caches a token-valued type step — {{email}} is not a secret', async () => {
    const rawText = 'type {{email}} into the email field';
    mockQuery
      .mockResolvedValueOnce({ rows: [] })   // lookupFromDB
      .mockResolvedValueOnce({ rows: [] });  // persistToDB
    mockLLMGateway.compileStep.mockResolvedValueOnce({
      action: 'type', targetDescription: 'the email field', value: '{{email}}',
      url: null, rawText, contentHash: 'stub', targetHash: 'th',
    } as StepAST);

    await compiler.compile(rawText);

    const inserts = mockQuery.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO compiled_ast_cache'));
    expect(inserts).toHaveLength(1);
  });

  // ─── Billing tenant ────────────────────────────────────────────────────────
  // P2 promised this parameterization (spec-generation-pipeline.md §3) and never
  // shipped it, so Test Writer fallback compiles billed the system tenant.

  it('bills the system tenant by default', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    mockLLMGateway.compileStep.mockResolvedValueOnce({
      action: 'click', targetDescription: 'x', value: null, url: null,
      rawText: 'click x', contentHash: 'stub', targetHash: 'th',
    } as StepAST);

    await compiler.compile('click x');

    expect(mockLLMGateway.compileStep).toHaveBeenCalledWith('click x', 'system_global');
  });

  it('bills the tenant it was constructed with', async () => {
    const tenantCompiler = new LearnedCompiler(mockLLMGateway, mockObservability, 'tenant-abc');
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    mockLLMGateway.compileStep.mockResolvedValueOnce({
      action: 'click', targetDescription: 'x', value: null, url: null,
      rawText: 'click x', contentHash: 'stub', targetHash: 'th',
    } as StepAST);

    await tenantCompiler.compile('click x');

    expect(mockLLMGateway.compileStep).toHaveBeenCalledWith('click x', 'tenant-abc');
  });

  // ─── compileMany ───────────────────────────────────────────────────────────

  it('compiles multiple steps and returns them in order', async () => {
    const steps = ['press enter', 'scroll down'];

    mockQuery
      .mockResolvedValueOnce({ rows: [{ ast_json: { action: 'press_key', value: 'Enter', targetDescription: null, url: null } }] })
      .mockResolvedValueOnce({ rows: [{ ast_json: { action: 'scroll', targetDescription: 'bottom of page', value: null, url: null } }] });

    const results = await compiler.compileMany(steps);

    expect(results).toHaveLength(2);
    expect(results[0].action).toBe('press_key');
    expect(results[1].action).toBe('scroll');
  });
});

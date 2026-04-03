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
    };

    // DB throws (connection refused)
    mockQuery.mockRejectedValue(new Error('ECONNREFUSED'));
    mockLLMGateway.compileStep.mockResolvedValueOnce(llmAst);

    const result = await compiler.compile(rawText);

    expect(result.action).toBe('click');
    expect(mockLLMGateway.compileStep).toHaveBeenCalledTimes(1);
    expect(mockObservability.log).toHaveBeenCalledWith('warn', 'compiler.db_lookup_failed', expect.any(Object));
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

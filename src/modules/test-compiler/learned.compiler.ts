import { createHash } from 'crypto';
import type { ITestCompiler } from './interfaces';
import type { StepAST } from '../../types';
import type { ILLMGateway } from '../llm-gateway/interfaces';
import type { IObservability } from '../observability/interfaces';
import { getPool } from '../../db/pool';

/**
 * Phase 1 Implementation of ITestCompiler — Pure LearnedCompiler.
 *
 * Three-level lookup (fast → persistent → intelligent):
 *   L1 — In-memory Map   : process-local hot cache, zero latency
 *   L2 — Postgres        : compiled_ast_cache table, pre-seeded with structural
 *                          patterns (see 002_seed_compiled_ast_cache.sql)
 *   L3 — LLM fallback    : ILLMGateway.compileStep(), result written back to L2+L1
 *
 * No hardcoded linguistic mappings anywhere in application code.
 * The seed SQL is the canonical list of pre-known patterns.
 */
export class LearnedCompiler implements ITestCompiler {
  // L1: process-local hot cache — avoids repeated DB reads within a run
  private readonly cache = new Map<string, StepAST>();

  constructor(
    private readonly llmGateway: ILLMGateway,
    private readonly observability: IObservability,
  ) {}

  private hash(text: string): string {
    return createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
  }

  async compile(rawText: string): Promise<StepAST> {
    const span = this.observability.startSpan('compiler.compile', { rawText });

    try {
      const contentHash = this.hash(rawText);

      // L1 — in-memory
      if (this.cache.has(contentHash)) {
        this.observability.increment('compiler.cache_hit', { source: 'memory' });
        return this.cache.get(contentHash)!;
      }

      // L2 — Postgres compiled_ast_cache (includes pre-seeded structural patterns)
      const dbAst = await this.lookupFromDB(contentHash);
      if (dbAst) {
        this.observability.increment('compiler.cache_hit', { source: 'db' });
        const ast: StepAST = { ...dbAst, rawText, contentHash };
        this.cache.set(contentHash, ast);
        return ast;
      }

      // L3 — LLM fallback
      this.observability.increment('compiler.cache_miss');
      const llmAst = await this.llmGateway.compileStep(rawText, 'system_global');
      const ast: StepAST = { ...llmAst, rawText, contentHash };

      // Write back to L2 and L1
      await this.persistToDB(contentHash, ast);
      this.cache.set(contentHash, ast);

      return ast;
    } finally {
      span.end();
    }
  }

  async compileMany(steps: string[]): Promise<StepAST[]> {
    // Phase 1: sequential. Phase 2: batch LLM calls for misses.
    const results: StepAST[] = [];
    for (const step of steps) {
      results.push(await this.compile(step));
    }
    return results;
  }

  // ─── Private DB helpers ────────────────────────────────────────────────────

  private async lookupFromDB(
    contentHash: string,
  ): Promise<Omit<StepAST, 'rawText' | 'contentHash'> | null> {
    try {
      const { rows } = await getPool().query<{ ast_json: Omit<StepAST, 'rawText' | 'contentHash'> }>(
        'SELECT ast_json FROM compiled_ast_cache WHERE content_hash = $1',
        [contentHash],
      );
      return rows.length > 0 ? rows[0].ast_json : null;
    } catch (e: any) {
      // DB unavailable must not block compilation — fall through to LLM
      this.observability.log('warn', 'compiler.db_lookup_failed', { error: e.message });
      return null;
    }
  }

  private async persistToDB(contentHash: string, ast: StepAST): Promise<void> {
    try {
      const astJson = {
        action: ast.action,
        targetDescription: ast.targetDescription,
        value: ast.value,
        url: ast.url,
      };
      await getPool().query(
        `INSERT INTO compiled_ast_cache (content_hash, ast_json)
         VALUES ($1, $2)
         ON CONFLICT (content_hash) DO NOTHING`,
        [contentHash, JSON.stringify(astJson)],
      );
    } catch (e: any) {
      // Fire-and-forget — a failed persist does not break compilation
      this.observability.log('warn', 'compiler.db_persist_failed', { error: e.message });
    }
  }
}

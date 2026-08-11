import { createHash } from 'crypto';
import type { ITestCompiler } from './interfaces';
import type { StepAST } from '../../types';
import type { ILLMGateway } from '../llm-gateway/interfaces';
import type { IObservability } from '../observability/interfaces';
import { getPool } from '../../db/pool';
import { isSecretStep, isTokenValue } from '../test-writer/secret-steps';

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
/** Billing tenant ID used for LLM calls during compilation (not tied to any user tenant). */
const SYSTEM_TENANT_ID = 'system_global';

/**
 * Normalise raw step text before hashing so surface variants that carry
 * identical intent share the same contentHash:
 *   - lowercase + trim
 *   - strip surrounding and embedded straight/curly quotes from values
 *     so `type "hello" in username` === `type hello in username`
 *   - collapse internal whitespace
 *
 * Exported because the Test Writer's canonical renderer constructs ASTs
 * directly and must produce byte-identical hashes to a compile of the same
 * sentence (spec-generation-pipeline.md §3).
 */
export function normaliseStepText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[""'']/g, '')   // strip curly quotes
    .replace(/"/g, '')        // strip straight double quotes
    .replace(/'/g, '')        // strip straight single quotes
    .replace(/\s+/g, ' ')
    .trim();
}

/** SHA-256 of the normalised step text — the compiled_ast_cache key. */
export function stepContentHash(text: string): string {
  return createHash('sha256').update(normaliseStepText(text)).digest('hex');
}

/** SHA-256(action + ':' + targetDescription) — the selector-cache key. */
export function stepTargetHash(action: string, targetDescription: string | null): string {
  return createHash('sha256')
    .update(`${action}:${(targetDescription ?? '').trim().toLowerCase()}`)
    .digest('hex');
}

export class LearnedCompiler implements ITestCompiler {
  // L1: process-local hot cache — avoids repeated DB reads within a run
  private readonly cache = new Map<string, StepAST>();

  /**
   * Tenant billed for L3 fallback compiles. Defaults to the system tenant so
   * every existing caller is unchanged; the Test Writer passes the job's tenant
   * so its fallback compiles bill the customer who caused them
   * (spec-generation-pipeline.md §3 promised this in P2 and it never shipped —
   * spec-authenticated-scope.md §10.5).
   */
  private readonly billingTenantId: string;

  constructor(
    private readonly llmGateway: ILLMGateway,
    private readonly observability: IObservability,
    billingTenantId: string = SYSTEM_TENANT_ID,
  ) {
    this.billingTenantId = billingTenantId;
  }

  private hash(text: string): string {
    return stepContentHash(text);
  }

  private targetHash(action: string, targetDescription: string | null): string {
    return stepTargetHash(action, targetDescription);
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
        const ast: StepAST = {
          ...dbAst,
          rawText,
          contentHash,
          targetHash: this.targetHash(dbAst.action, dbAst.targetDescription),
        };
        this.cache.set(contentHash, ast);
        return ast;
      }

      // L3 — LLM fallback
      this.observability.increment('compiler.cache_miss');
      const llmAst = await this.llmGateway.compileStep(rawText, this.billingTenantId);
      const ast: StepAST = {
        ...llmAst,
        rawText,
        contentHash,
        targetHash: this.targetHash(llmAst.action, llmAst.targetDescription),
      };

      // Write back to L2 and L1 — EXCEPT for credentials.
      //
      // compiled_ast_cache is global: content_hash is its only key, there is no
      // tenant_id and no RLS (002_seed_compiled_ast_cache.sql). Its ast_json
      // stores `value`, so persisting a compiled "type <literal> into the
      // password field" publishes that password to every tenant, permanently,
      // outside any offboarding purge. The step recompiles next time instead;
      // that is a handful of sentences per tenant, and login steps normally
      // arrive with a stored compiled_ast anyway.
      if (isSecretStep(ast) || (ast.action === 'type' && ast.value && !isTokenValue(ast.value))) {
        this.observability.increment('compiler.global_cache_write_skipped');
      } else {
        await this.persistToDB(contentHash, ast);
      }
      this.cache.set(contentHash, ast);

      return ast;
    } finally {
      span.end();
    }
  }

  async compileMany(steps: string[]): Promise<StepAST[]> {
    return Promise.all(steps.map((s) => this.compile(s)));
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

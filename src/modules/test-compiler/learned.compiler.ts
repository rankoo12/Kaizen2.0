import { createHash } from 'crypto';
import type { ITestCompiler } from './interfaces';
import type { StepAST } from '../../types';
import type { ILLMGateway } from '../llm-gateway/interfaces';
import type { IObservability } from '../observability/interfaces';

/**
 * Phase 1 Implementation of ITestCompiler (The "Pure LearnedCompiler")
 * Maps raw English intent strictly using LLMs + a Hash Cache, completely eliminating
 * brittle Regex maintenance. Cache is pre-seeded with milestone standards for cold-start 0ms latency.
 */
export class LearnedCompiler implements ITestCompiler {
  // In-memory exact-match string mapping cache
  private cache = new Map<string, StepAST>();

  constructor(
    private readonly llmGateway: ILLMGateway,
    private readonly observability: IObservability
  ) {
    this.seedCache();
  }

  private hash(text: string): string {
    return createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
  }

  /**
   * Pre-seeds the exact string hashes to avoid Cold Start LLM costs for standard phrases.
   */
  private seedCache() {
    const seeds = [
      { rawText: "open youtube", ast: { action: 'navigate', url: 'youtube', targetDescription: null, value: null } },
      { rawText: "search for cats", ast: { action: 'type', targetDescription: 'search box', value: 'cats', url: null } },
      { rawText: "press enter", ast: { action: 'press_key', value: 'enter', targetDescription: null, url: null } }
    ] as const;

    for (const seed of seeds) {
      const h = this.hash(seed.rawText);
      this.cache.set(h, { ...seed.ast, rawText: seed.rawText, contentHash: h });
    }
  }

  async compile(rawText: string): Promise<StepAST> {
    const span = this.observability.startSpan('compiler.compile', { rawText });
    
    try {
      const normalized = rawText.trim().toLowerCase();
      const contentHash = this.hash(normalized);

      // Phase 1 - 1. Cache Check (Instant Return)
      if (this.cache.has(contentHash)) {
        this.observability.increment('compiler.cache_hit');
        return this.cache.get(contentHash)!;
      }

      // Phase 1 - 2. Cache Miss -> LLM Fallback
      this.observability.increment('compiler.cache_miss');
      
      // Global semantic mappings have no tenant PII, so we pass a generic system tenant.
      // (ILLMGateway routes it correctly and charges the tenant or skips if unbillable).
      const ast = await this.llmGateway.compileStep(rawText, 'system_global');
      
      const compiledAst: StepAST = {
        ...ast,
        rawText,
        contentHash
      };

      // Phase 1 - 3. Save to Local Memory Map
      this.cache.set(contentHash, compiledAst);
      
      return compiledAst;
    } finally {
      span.end();
    }
  }

  async compileMany(steps: string[]): Promise<StepAST[]> {
    // For Phase 1 we compile them eagerly in a sequence. 
    // In Phase 2, this can `Promise.all` or pass batch arrays to LLMGateway.compileMany
    const results: StepAST[] = [];
    for (const step of steps) {
      results.push(await this.compile(step));
    }
    return results;
  }
}

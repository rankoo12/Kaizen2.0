import type { IHealingStrategy } from '../interfaces';
import type { ClassifiedFailure, HealingContext, HealingAttempt, AXNode } from '../../../types';
import type { ILLMGateway } from '../../llm-gateway/interfaces';
import type { IObservability } from '../../observability/interfaces';
import { getPool } from '../../../db/pool';
import { toVectorSQL } from '../../../utils/vector';

type PageLike = {
  $(selector: string): Promise<unknown | null>;
  accessibility: {
    snapshot(): Promise<AXNode | null>;
  };
};


const COSINE_THRESHOLD = 0.85;

/**
 * ElementSimilarityStrategy — Priority 3
 * Spec ref: Section 10
 *
 * On ELEMENT_MUTATED: extracts the current AX tree from Playwright,
 * embeds each leaf candidate via the LLM gateway, and queries pgvector
 * for the nearest stored element_embedding (cosine > 0.85).
 *
 * Heals without any LLM selector resolution — pure vector math.
 * Falls back to null if no candidate crosses the threshold.
 */
export class ElementSimilarityStrategy implements IHealingStrategy {
  readonly name = 'ElementSimilarityStrategy';

  constructor(
    private readonly llmGateway: ILLMGateway,
    private readonly observability: IObservability,
  ) {}

  canHandle(failure: ClassifiedFailure): boolean {
    return failure.failureClass === 'ELEMENT_MUTATED';
  }

  async heal(failure: ClassifiedFailure, context: HealingContext): Promise<HealingAttempt> {
    const start = Date.now();
    const page = context.page as PageLike;

    try {
      const axTree = await page.accessibility.snapshot();
      if (!axTree) {
        return { succeeded: false, newSelector: null, durationMs: Date.now() - start };
      }

      const leaves = collectLeaves(axTree);
      if (leaves.length === 0) {
        return { succeeded: false, newSelector: null, durationMs: Date.now() - start };
      }

      // Try each candidate: embed → vector search → validate in DOM
      for (const leaf of leaves) {
        const text = `${leaf.role}: ${leaf.name ?? ''}`.trim();
        if (!text || text === `${leaf.role}:`) continue;

        const embedding = await this.llmGateway.generateEmbedding(text);
        const embeddingSQL = toVectorSQL(embedding);

        const { rows } = await getPool().query<{
          selectors: string;
          similarity: number;
        }>(
          `SELECT selectors, 1 - (element_embedding <=> $1::vector) AS similarity
           FROM selector_cache
           WHERE tenant_id = $2
             AND element_embedding IS NOT NULL
             AND 1 - (element_embedding <=> $1::vector) > $3
           ORDER BY element_embedding <=> $1::vector
           LIMIT 1`,
          [embeddingSQL, context.tenantId, COSINE_THRESHOLD],
        );

        if (rows.length === 0) continue;

        const selectorEntries: Array<{ selector: string }> = JSON.parse(rows[0].selectors);
        for (const entry of selectorEntries) {
          try {
            const handle = await page.$(entry.selector);
            if (handle !== null) {
              this.observability.increment('healing.element_similarity_hit', {
                tenantId: context.tenantId,
              });
              return {
                succeeded: true,
                newSelector: entry.selector,
                durationMs: Date.now() - start,
              };
            }
          } catch {
            // try next selector in this entry's set
          }
        }
      }
    } catch (e: any) {
      this.observability.log('warn', 'healing.element_similarity_error', { error: e.message });
    }

    return { succeeded: false, newSelector: null, durationMs: Date.now() - start };
  }
}

/** Collect all leaf nodes from an AX tree (nodes with no children or only empty children). */
function collectLeaves(node: AXNode): AXNode[] {
  const children = node.children ?? [];
  if (children.length === 0) return [node];
  return children.flatMap(collectLeaves);
}

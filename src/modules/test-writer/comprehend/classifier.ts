import type { ITestWriterGateway } from '../../llm-gateway/testwriter.interfaces';
import type { IObservability } from '../../observability/interfaces';
import type { PagePurposeTag } from '../../../types/test-writer';
import {
  SiteModelRepository, elementDigestLines, formSummaryLines,
} from '../site-model.repository';

/**
 * COMPREHEND step 1 — per-page classification.
 * Spec: docs/specs/test-writer/spec-comprehension-knowledge-model.md §2
 *
 * Turns raw crawl capture into "what is this page FOR and what can a user DO
 * here". Only pages whose content_hash changed (or that were never classified)
 * reach the LLM — the repository nulls `purpose` on a content change, which IS
 * the classification cache.
 */

const VALID_TAGS: PagePurposeTag[] = [
  'landing', 'auth', 'listing', 'detail', 'form', 'checkout',
  'dashboard', 'settings', 'search', 'content', 'error', 'other',
];

export type ClassifyResult = {
  classified: number;
  skipped: number;      // cache hits — unchanged since last classification
  failed: number;
};

export class PageClassifier {
  constructor(
    private readonly gateway: ITestWriterGateway,
    private readonly repository: SiteModelRepository,
    private readonly obs: IObservability,
    private readonly concurrency = 4,
  ) {}

  async classifySuite(
    tenantId: string, suiteId: string, totalPages: number,
  ): Promise<ClassifyResult> {
    const pending = await this.repository.listPagesNeedingClassification(tenantId, suiteId);
    const result: ClassifyResult = {
      classified: 0,
      skipped: Math.max(0, totalPages - pending.length),
      failed: 0,
    };
    if (pending.length === 0) return result;

    // Bounded concurrency: N workers draining a shared cursor.
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const page = pending[cursor++];
        if (!page) return;
        try {
          const classification = await this.gateway.classifyPage({
            urlNormalized: page.urlNormalized,
            title: page.title,
            headings: page.headings,
            formSummaries: formSummaryLines(page.axOutline),
            elementDigest: elementDigestLines(page.axOutline),
            revealedDigest: [],
          }, tenantId);

          await this.repository.saveClassification(tenantId, page.id, {
            purpose: String(classification.purpose ?? '').slice(0, 200) || 'unknown',
            purposeTag: VALID_TAGS.includes(classification.purposeTag) ? classification.purposeTag : 'other',
            capabilities: (classification.capabilities ?? []).slice(0, 8).map(String),
            entities: (classification.entities ?? []).slice(0, 8).map(String),
          });
          result.classified++;
        } catch (err) {
          // A page that won't classify is not fatal — the App Brief is built
          // from whatever classified successfully.
          result.failed++;
          this.obs.log('warn', 'testwriter.classify_page_failed', {
            url: page.urlNormalized,
            error: err instanceof Error ? err.message : String(err),
          });
          this.obs.increment('testwriter.classify_failed');
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.concurrency, pending.length) }, worker));
    this.obs.log('info', 'testwriter.classification_done', { suiteId, ...result });
    return result;
  }
}

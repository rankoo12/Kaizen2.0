import type { ITestWriterGateway } from '../../llm-gateway/testwriter.interfaces';
import type { IObservability } from '../../observability/interfaces';
import type { AppBrief, Journey, TenantBrief } from '../../../types/test-writer';
import type { SiteModelRepository } from '../site-model.repository';

/**
 * COMPREHEND step 2 — whole-app synthesis (the App Brief).
 * Spec: docs/specs/test-writer/spec-comprehension-knowledge-model.md §3
 *
 * The LLM proposes journeys; the observed link graph disposes of them. Kaizen
 * never "knows" a journey the crawler did not actually walk — that is the same
 * false-pass discipline the execution engine applies to assertions, moved up to
 * the knowledge layer.
 */

export type SynthesisResult = {
  brief: AppBrief;
  version: number;
  journeysProposed: number;
  journeysDropped: Array<{ name: string; reason: string }>;
  /** Flows the tenant's Init Brief described that no observed page supports. */
  coverageGaps: string[];
};

/**
 * A journey hop is valid when the graph has a direct edge, or the two pages are
 * joined through exactly one intermediate page (the LLM commonly omits an
 * obvious waypoint like the cart). Anything looser stops being evidence.
 */
function hopExists(graph: Record<string, string[]>, from: string, to: string): boolean {
  const direct = graph[from] ?? [];
  if (direct.includes(to)) return true;
  return direct.some((mid) => (graph[mid] ?? []).includes(to));
}

export class AppBriefSynthesizer {
  constructor(
    private readonly gateway: ITestWriterGateway,
    private readonly repository: SiteModelRepository,
    private readonly obs: IObservability,
  ) {}

  async synthesize(
    tenantId: string,
    suiteId: string,
    generationJobId: string,
    tenantBrief: TenantBrief | null,
  ): Promise<SynthesisResult> {
    const pages = await this.repository.listClassifiedPages(tenantId, suiteId);
    if (pages.length === 0) {
      throw new Error('No classified pages — cannot synthesize an App Brief.');
    }
    const links = await this.repository.getLinkGraph(tenantId, suiteId);

    const raw = await this.gateway.synthesizeAppBrief({
      pages: pages.map((p) => ({
        urlNormalized: p.urlNormalized,
        title: p.title,
        purpose: p.purpose,
        purposeTag: p.purposeTag as never,
        capabilities: p.capabilities,
        requiresAuth: p.requiresAuth,
      })),
      links,
      tenantBrief,
    }, tenantId);

    const knownUrls = new Set(pages.map((p) => p.urlNormalized));
    const proposed = Array.isArray(raw.journeys) ? raw.journeys : [];
    const dropped: SynthesisResult['journeysDropped'] = [];

    const verified: Journey[] = proposed.filter((journey) => {
      const path = Array.isArray(journey.pagePath) ? journey.pagePath : [];
      if (path.length === 0) {
        dropped.push({ name: journey.name, reason: 'empty page path' });
        return false;
      }
      const unknown = path.find((url) => !knownUrls.has(url));
      if (unknown) {
        dropped.push({ name: journey.name, reason: `page not observed: ${unknown}` });
        return false;
      }
      for (let i = 0; i < path.length - 1; i++) {
        if (!hopExists(links, path[i], path[i + 1])) {
          dropped.push({ name: journey.name, reason: `no observed link ${path[i]} -> ${path[i + 1]}` });
          return false;
        }
      }
      return true;
    });

    if (dropped.length > 0) {
      this.obs.log('warn', 'testwriter.journeys_dropped', { suiteId, dropped });
      this.obs.increment('testwriter.journeys_dropped', { count: String(dropped.length) });
    }

    const brief: AppBrief = {
      appType: raw.appType ?? 'unknown',
      summary: raw.summary ?? '',
      coreEntities: raw.coreEntities ?? [],
      journeys: verified.slice(0, 6),
    };

    const version = await this.repository.saveAppBrief(tenantId, suiteId, brief, generationJobId);

    return {
      brief,
      version,
      journeysProposed: proposed.length,
      journeysDropped: dropped,
      coverageGaps: findCoverageGaps(tenantBrief, pages, brief),
    };
  }
}

/**
 * Flows the tenant said matter that no observed page/journey covers. This is a
 * QA deliverable in itself: "you told us about checkout, we never reached it —
 * is it behind auth?"
 */
export function findCoverageGaps(
  tenantBrief: TenantBrief | null,
  pages: Array<{ purpose: string; urlNormalized: string }>,
  brief: AppBrief,
): string[] {
  if (!tenantBrief?.criticalFlows?.length) return [];
  const haystack = [
    ...pages.map((p) => `${p.purpose} ${p.urlNormalized}`),
    ...brief.journeys.map((j) => `${j.name} ${j.description}`),
  ].join(' ').toLowerCase();

  return tenantBrief.criticalFlows.filter((flow) => {
    const words = flow.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (words.length === 0) return false;
    // Gap when NONE of the flow's distinctive words appear anywhere in what we observed.
    return !words.some((w) => haystack.includes(w));
  });
}

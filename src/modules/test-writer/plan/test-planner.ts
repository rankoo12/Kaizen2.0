import type { ITestWriterGateway } from '../../llm-gateway/testwriter.interfaces';
import type { IObservability } from '../../observability/interfaces';
import type { AppBrief, PlannedScenario, TenantBrief } from '../../../types/test-writer';
import type { ClassifiedPage } from '../site-model.repository';
import { getArchetype, renderCatalogBlock } from './catalog';

/**
 * PLAN — the test plan a QA lead would review before anyone writes a test.
 * Spec: docs/specs/test-writer/spec-generation-pipeline.md §2
 *
 * The LLM proposes; observed reality disposes. Every planned scenario is
 * normalised against the crawled page set, the auth scope, and the catalog:
 * a plan entry that references a page nobody visited never reaches WRITE.
 */

export type PlanResult = {
  scenarios: PlannedScenario[];
  dropped: Array<{ name: string; reason: string }>;
  catalogCount: number;
  llmCount: number;
};

export class TestPlanner {
  constructor(
    private readonly gateway: ITestWriterGateway,
    private readonly obs: IObservability,
  ) {}

  async plan(params: {
    tenantId: string;
    appBrief: AppBrief;
    tenantBrief: TenantBrief | null;
    pages: ClassifiedPage[];
    existingCaseNames: string[];
    scope: 'public' | 'authenticated';
    syntheticDataConsent: boolean;
    maxScenarios: number;
  }): Promise<PlanResult> {
    const capabilitiesByPage: Record<string, string[]> = {};
    for (const page of params.pages) {
      if (page.capabilities.length > 0) capabilitiesByPage[page.urlNormalized] = page.capabilities;
    }

    const raw = await this.gateway.planScenarios({
      appBrief: params.appBrief,
      tenantBrief: params.tenantBrief,
      capabilitiesByPage,
      existingCaseNames: params.existingCaseNames,
      scope: params.scope,
      syntheticDataConsent: params.syntheticDataConsent,
      maxScenarios: params.maxScenarios,
      catalogBlock: renderCatalogBlock(),
    }, params.tenantId);

    const knownUrls = new Map(params.pages.map((p) => [p.urlNormalized, p]));
    const dropped: PlanResult['dropped'] = [];
    const seenNames = new Set<string>();
    const accepted: PlannedScenario[] = [];

    for (const scenario of raw) {
      const name = String(scenario?.name ?? '').trim();
      if (!name) {
        dropped.push({ name: '(unnamed)', reason: 'missing name' });
        continue;
      }
      if (seenNames.has(name.toLowerCase())) {
        dropped.push({ name, reason: 'duplicate plan entry' });
        continue;
      }

      const targetPages = (scenario.targetPages ?? []).filter((u) => knownUrls.has(u));
      if (targetPages.length === 0) {
        // The planner referenced pages the crawler never observed — the graph
        // disposes of it rather than letting WRITE invent grounding.
        dropped.push({ name, reason: 'no observed target pages' });
        continue;
      }

      // Auth scope: a public job never plans against pages that redirect to login.
      if (params.scope === 'public' && targetPages.some((u) => knownUrls.get(u)?.requiresAuth)) {
        dropped.push({ name, reason: 'targets an authenticated page (public scope)' });
        continue;
      }

      // …and the inverse: an authenticated job cannot plan scenarios whose
      // premise is being SIGNED OUT. Every scenario there carries the login
      // prefix, so "navigate to a protected page and expect the login redirect"
      // can never pass. Dropping them here saves a write, a validation run and
      // a confusing red rejection for the archetype class P3 most showcases.
      if (params.scope === 'authenticated' && scenario.source?.kind === 'catalog') {
        const entry = getArchetype(scenario.source.archetypeKey);
        if (entry?.requiresSignedOut) {
          dropped.push({ name, reason: 'covered by public scope (needs a signed-out visitor)' });
          continue;
        }
      }

      // Catalog provenance must reference a real entry; unknown keys degrade to
      // 'llm' rather than sending WRITE hunting for a skeleton that doesn't exist.
      let source = scenario.source ?? { kind: 'llm' as const };
      if (source.kind === 'catalog' && !getArchetype(source.archetypeKey)) {
        this.obs.increment('testwriter.plan_unknown_archetype');
        source = { kind: 'llm' };
      }

      const archetype = source.kind === 'catalog' ? getArchetype(source.archetypeKey) : null;
      const requiresSyntheticData = archetype
        ? archetype.safety !== 'read-safe'
        : Boolean(scenario.requiresSyntheticData);

      seenNames.add(name.toLowerCase());
      accepted.push({
        name,
        journey: scenario.journey ?? null,
        kind: (['happy', 'negative', 'edge'] as const).includes(scenario.kind) ? scenario.kind : 'happy',
        priority: (['critical', 'high', 'normal'] as const).includes(scenario.priority)
          ? scenario.priority : 'normal',
        rationale: String(scenario.rationale ?? '').slice(0, 500),
        // Catalog scenarios need no outline — the UI renders the archetype's
        // own skeleton, which is more precise than a paraphrase of it.
        outline: archetype ? '' : String(scenario.outline ?? '').slice(0, 300),
        targetPages,
        source,
        requiresSyntheticData,
      });

      if (accepted.length >= params.maxScenarios) break;
    }

    // Critical first — if the budget or the reviewer trims the tail, the most
    // valuable scenarios are the ones that survive.
    const rank = { critical: 0, high: 1, normal: 2 };
    accepted.sort((a, b) => rank[a.priority] - rank[b.priority]);

    const result: PlanResult = {
      scenarios: accepted,
      dropped,
      catalogCount: accepted.filter((s) => s.source.kind === 'catalog').length,
      llmCount: accepted.filter((s) => s.source.kind === 'llm').length,
    };

    this.obs.log('info', 'testwriter.plan_ready', {
      accepted: accepted.length, dropped: dropped.length,
      catalog: result.catalogCount, llm: result.llmCount,
    });
    return result;
  }
}

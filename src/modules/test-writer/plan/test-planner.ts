import type { ITestWriterGateway } from '../../llm-gateway/testwriter.interfaces';
import type { IObservability } from '../../observability/interfaces';
import type { AppBrief, PageDossier, PlannedScenario, TenantBrief } from '../../../types/test-writer';
import type { ClassifiedPage } from '../site-model.repository';
import { getArchetype, renderCatalogBlock } from './catalog';
import { repertoireScenarios } from './repertoire';
import { applyBriefExclusions, batchDossiers, isIndexPage } from './dossier';

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
  /** Per-page planning (spec-planner-per-page): how many fired on shape alone. */
  repertoireCount?: number;
  pagesPlannedFor?: number;
  pagesExcludedByBrief?: string[];
  pagesSkippedAsIndex?: string[];
};

/** What has already happened per page — the fill round's memory. Spec §1.5 */
export type PlanLedger = Array<{
  page: string;
  delivered: string[];
  rejected: Array<{ name: string; reason: string }>;
}>;

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
    /** Scoped Suggest: every scenario must target this page. Spec: spec-scoped-suggest.md §4 */
    focusUrl?: string;
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
      focusUrl: params.focusUrl,
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

      // Scoped Suggest is enforced here, not merely requested in the prompt: a
      // plan that wandered off the page the user asked about would spend their
      // budget answering a question they didn't ask.
      if (params.focusUrl && !targetPages.includes(params.focusUrl)) {
        dropped.push({ name, reason: 'not about the page this suggestion is scoped to' });
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

  /**
   * PLAN, per page — the engineer's way. Every page arrives as a dossier (its
   * elements, its text, its forms); the shape repertoire fires first, for free;
   * the model then plans each batch of pages with the repertoire's picks in
   * front of it. On a fill round the ledger tells it what already exists and
   * what already failed, and only the pages with unspent material are sent.
   * Spec: docs/specs/test-writer/spec-planner-per-page.md §1.1–§1.5
   */
  async planPages(params: {
    tenantId: string;
    appSummary: string;
    tenantBrief: TenantBrief | null;
    pages: PageDossier[];
    existingCaseNames: string[];
    scope: 'public' | 'authenticated';
    syntheticDataConsent: boolean;
    maxScenarios: number;
    /** Fill round: only these pages, with what already happened on them. */
    ledger?: PlanLedger;
    perPage?: number;
    batchSize?: number;
  }): Promise<PlanResult> {
    const perPage = params.perPage ?? 3;
    const dossiers = applyBriefExclusions(params.pages, params.tenantBrief)
      .map((p) => (isIndexPage(p) ? { ...p, isIndex: true } : p));
    const plannable = dossiers.filter((p) => !p.excludedBy && !p.isIndex);
    const excluded = dossiers.filter((p) => p.excludedBy).map((p) => p.urlNormalized);
    const index = dossiers.filter((p) => p.isIndex).map((p) => p.urlNormalized);

    // 1. Shape repertoire — zero tokens. Skipped on a fill round: everything it
    //    could say, it already said in round one.
    const fromShape = params.ledger ? [] : repertoireScenarios(plannable, params.tenantBrief);
    const repertoireHints = fromShape.map((s) => ({ page: s.targetPages[0], name: s.name, outline: s.outline }));

    // 2. The model, per batch of dossiers. Index and excluded pages ride along
    //    as context but are flagged, and anything planned for them is dropped
    //    below regardless.
    const known = new Map(dossiers.map((p) => [p.urlNormalized, p]));
    const byNavigable = new Map(dossiers.map((p) => [p.url, p]));
    const fromModel: PlannedScenario[] = [];
    for (const batch of batchDossiers(dossiers, params.batchSize ?? 6)) {
      if (!batch.some((p) => !p.excludedBy && !p.isIndex)) continue;
      const raw = await this.gateway.planPageBatch({
        pages: batch,
        tenantBrief: params.tenantBrief,
        appSummary: params.appSummary,
        repertoire: repertoireHints,
        ledger: params.ledger,
        perPage,
        scope: params.scope,
        syntheticDataConsent: params.syntheticDataConsent,
        existingCaseNames: params.existingCaseNames,
      }, params.tenantId).catch((e: unknown) => {
        this.obs.log('warn', 'testwriter.plan_batch_failed', { error: e instanceof Error ? e.message : String(e) });
        return [] as PlannedScenario[];
      });
      fromModel.push(...raw);
    }

    // 3. Normalise — the same disposal rules as plan(): observed pages only,
    //    scope respected, names unique. Plus: nothing on an index or excluded page.
    const dropped: PlanResult['dropped'] = [];
    const seen = new Set<string>();
    const accepted: PlannedScenario[] = [];
    const rank = { critical: 0, high: 1, normal: 2 };

    for (const scenario of [...fromShape, ...fromModel]) {
      const name = String(scenario?.name ?? '').trim();
      if (!name) { dropped.push({ name: '(unnamed)', reason: 'missing name' }); continue; }
      if (seen.has(name.toLowerCase())) { dropped.push({ name, reason: 'duplicate plan entry' }); continue; }

      // The model quotes the NAVIGABLE url from the page header; identity is normalized.
      const targetPages = (scenario.targetPages ?? [])
        .map((u) => (known.has(u) ? u : byNavigable.get(u)?.urlNormalized ?? null))
        .filter((u): u is string => u !== null);
      if (targetPages.length === 0) { dropped.push({ name, reason: 'no observed target pages' }); continue; }

      const page = known.get(targetPages[0])!;
      if (page.excludedBy) { dropped.push({ name, reason: `excluded by your brief: ${page.excludedBy}` }); continue; }
      if (page.isIndex) { dropped.push({ name, reason: 'planned against an index page (navigation, not a subject)' }); continue; }
      if (params.scope === 'public' && page.requiresAuth) {
        dropped.push({ name, reason: 'targets an authenticated page (public scope)' }); continue;
      }
      if (params.ledger && !params.ledger.some((l) => l.page === targetPages[0])) {
        dropped.push({ name, reason: 'fill round planned outside the pages that still had material' }); continue;
      }
      if (params.ledger?.some((l) => l.delivered.some((d) => d.toLowerCase() === name.toLowerCase()))) {
        dropped.push({ name, reason: 'already delivered in an earlier round' }); continue;
      }

      seen.add(name.toLowerCase());
      accepted.push({
        name,
        journey: null,
        kind: (['happy', 'negative', 'edge'] as const).includes(scenario.kind) ? scenario.kind : 'happy',
        priority: (['critical', 'high', 'normal'] as const).includes(scenario.priority) ? scenario.priority : 'normal',
        rationale: String(scenario.rationale ?? '').slice(0, 500),
        outline: String(scenario.outline ?? '').slice(0, 300),
        expectedOutcome: String(scenario.expectedOutcome ?? '').slice(0, 300) || undefined,
        targetPages,
        source: scenario.source?.kind === 'repertoire' ? scenario.source : { kind: 'llm' },
        requiresSyntheticData: Boolean(scenario.requiresSyntheticData),
      });
    }

    // 4. Spread the budget across pages: round-robin by page, priority within
    //    a page. A 30-test budget on 40 pages must not be spent 4-deep on the
    //    first eight pages the model happened to like.
    const perPageQueues = new Map<string, PlannedScenario[]>();
    for (const s of accepted) {
      const q = perPageQueues.get(s.targetPages[0]) ?? [];
      q.push(s);
      perPageQueues.set(s.targetPages[0], q);
    }
    for (const q of perPageQueues.values()) q.sort((a, b) => rank[a.priority] - rank[b.priority]);
    const chosen: PlannedScenario[] = [];
    let progressed = true;
    while (chosen.length < params.maxScenarios && progressed) {
      progressed = false;
      for (const q of perPageQueues.values()) {
        const next = q.shift();
        if (!next) continue;
        chosen.push(next);
        progressed = true;
        if (chosen.length >= params.maxScenarios) break;
      }
    }
    for (const q of perPageQueues.values()) for (const s of q) dropped.push({ name: s.name, reason: 'over the requested budget' });

    const result: PlanResult = {
      scenarios: chosen,
      dropped,
      catalogCount: 0,
      llmCount: chosen.filter((s) => s.source.kind === 'llm').length,
      repertoireCount: chosen.filter((s) => s.source.kind === 'repertoire').length,
      pagesPlannedFor: new Set(chosen.map((s) => s.targetPages[0])).size,
      pagesExcludedByBrief: excluded,
      pagesSkippedAsIndex: index,
    };
    this.obs.log('info', 'testwriter.plan_pages_ready', {
      accepted: chosen.length, dropped: dropped.length, repertoire: result.repertoireCount,
      llm: result.llmCount, pages: result.pagesPlannedFor, excluded: excluded.length, fill: !!params.ledger,
    });
    return result;
  }
}

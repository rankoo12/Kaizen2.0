import { getPool } from '../../db/pool';
import type { TestWriterJobPayload } from '../../queue';
import type { IObservability } from '../observability/interfaces';
import type { CrawlReport, PageCapture } from './interfaces';
import { DEFAULT_BUDGETS, HARD_MAX_PAGES } from './interfaces';
import { ReconCrawler } from './recon/crawler';
import { SiteModelRepository } from './site-model.repository';

/**
 * Test Writer pipeline — per-job orchestration.
 * Spec ref: docs/specs/test-writer/spec-test-writer-service.md §8
 *
 * P1 scope: RECON only. The job runs the crawler, persists the site model
 * incrementally, and finishes with a recon report. COMPREHEND → VALIDATE
 * phases attach here in P2.
 */

export type TestWriterPipelineDeps = {
  crawler: ReconCrawler;
  repository: SiteModelRepository;
  obs: IObservability;
};

export async function runTestWriterJob(
  payload: TestWriterJobPayload,
  deps: TestWriterPipelineDeps,
): Promise<void> {
  const { crawler, repository, obs } = deps;
  const pool = getPool();

  const { rows } = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM generation_jobs WHERE id = $1 AND tenant_id = $2`,
    [payload.jobId, payload.tenantId],
  );
  if (rows.length === 0) {
    obs.log('warn', 'testwriter.job_row_missing', { jobId: payload.jobId });
    return;
  }

  // P3 gate: the authenticated login-recipe flow is not built yet. The API
  // rejects this too — belt and braces, since consent handling must never
  // silently degrade into an unauthenticated crawl that LOOKS authenticated.
  if (payload.scope === 'authenticated') {
    await finishJob(payload.jobId, 'blocked', null,
      'Authenticated scope is not yet supported (planned: P3).');
    return;
  }

  await pool.query(
    `UPDATE generation_jobs SET status = 'running', started_at = now() WHERE id = $1`,
    [payload.jobId],
  );

  const budgets = {
    ...DEFAULT_BUDGETS,
    maxPages: Math.min(payload.options.maxPages || DEFAULT_BUDGETS.maxPages, HARD_MAX_PAGES),
  };

  // Edges accumulate across page sinks; they resolve to page_links only after
  // the crawl, when both endpoints exist as site_pages rows.
  const edges: Array<{ fromUrl: string; toUrl: string; viaElementName: string }> = [];

  try {
    const report = await crawler.crawl(
      {
        tenantId: payload.tenantId,
        jobId: payload.jobId,
        targetUrl: payload.targetUrl,
        budgets,
      },
      async (capture: PageCapture) => {
        await repository.upsertPage(payload.tenantId, payload.suiteId, capture);
        for (const link of capture.outgoingLinks) {
          edges.push({
            fromUrl: capture.urlNormalized,
            toUrl: link.toUrlNormalized,
            viaElementName: link.viaElementName,
          });
        }
      },
    );

    const linksInserted = await repository.insertLinks(payload.tenantId, payload.suiteId, edges);

    obs.log('info', 'testwriter.recon_completed', {
      jobId: payload.jobId, ...report, linksInserted,
    });
    obs.increment('testwriter.jobs_completed');

    // A crawl that captured nothing but blocks is a blocked job, not a
    // completed one — the user needs to know recon could not see the site.
    const status = report.pagesCrawled === 0 && report.pagesBlocked > 0 ? 'blocked' : 'completed';
    await finishJob(payload.jobId, status, { recon: { ...report, linksInserted } },
      status === 'blocked' ? 'All reachable pages were blocked (challenge/robots).' : null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    obs.log('error', 'testwriter.job_failed', { jobId: payload.jobId, error: message });
    obs.increment('testwriter.jobs_failed');
    await finishJob(payload.jobId, 'failed', null, message);
  }
}

async function finishJob(
  jobId: string,
  status: 'completed' | 'failed' | 'blocked',
  report: { recon: CrawlReport & { linksInserted: number } } | null,
  error: string | null,
): Promise<void> {
  await getPool().query(
    `UPDATE generation_jobs
     SET status = $2, report = COALESCE($3, report), error = $4, finished_at = now()
     WHERE id = $1`,
    [jobId, status, report ? JSON.stringify(report) : null, error],
  );
}

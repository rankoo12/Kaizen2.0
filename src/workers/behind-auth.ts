/**
 * Does this run execute behind a login wall? Decided by the WORKER, from the
 * case, not only from whoever queued it.
 * Spec: docs/specs/bench/spec-changing-sites.md §12 finding #14;
 *       docs/specs/test-writer/spec-authenticated-scope.md §4.1;
 *       docs/specs/roadmap/spec-research-adoption-2026-11.md §S4.
 *
 * `behindAuth` is the privacy boundary: nothing learned on a signed-in page may
 * leave the tenant — no shared-pool contribution, no global archetype learning
 * (`element_archetypes` is global and tenant-free, so a customer's private UI
 * vocabulary would be published to everyone). Migration 045 made authenticated
 * scope a property of the CASE and the one case-run enqueue site now sends it —
 * but a protection that depends on every producer remembering to attach a flag
 * is one forgotten enqueue site (CI integration, a scheduler, an importer) away
 * from leaking. So the consumer re-derives it.
 *
 * Split from worker.ts (which starts its BullMQ consumer at import) so the rules
 * are unit-testable, like name-fidelity.ts and deferred-heals.ts.
 */
import { tenantQuery } from '../db/transaction';

export type BehindAuthSource = 'payload' | 'case' | 'none' | 'lookup_failed';

export type BehindAuthDecision = { behindAuth: boolean; source: BehindAuthSource };

/**
 * Protected if EITHER the payload says so OR the run's case is authenticated.
 * OR, never override: a payload that omits the flag — or one day sets it false —
 * must not be able to switch the protection off for an authenticated case.
 *
 * Fails CLOSED. If the case lookup throws, the run is treated as protected: the
 * cost is that one run contributes nothing to the shared brain, the alternative
 * is a potential leak of a customer's private UI vocabulary. A run with no case
 * (the direct `POST /runs` path) simply has nothing to look up.
 */
export async function resolveBehindAuth(opts: {
  tenantId: string;
  runId: string;
  payloadFlag: boolean;
}): Promise<BehindAuthDecision> {
  if (opts.payloadFlag) return { behindAuth: true, source: 'payload' };
  try {
    const { rows } = await tenantQuery<{ authenticated: boolean }>(
      opts.tenantId,
      `SELECT tc.authenticated
         FROM runs r
         JOIN test_cases tc ON tc.id = r.case_id AND tc.tenant_id = r.tenant_id
        WHERE r.id = $1 AND r.tenant_id = $2`,
      [opts.runId, opts.tenantId],
    );
    return rows[0]?.authenticated === true
      ? { behindAuth: true, source: 'case' }
      : { behindAuth: false, source: 'none' };
  } catch {
    return { behindAuth: true, source: 'lookup_failed' };
  }
}

/**
 * Spec ref: Phase 4 — Global Brain Seeding
 * kaizen-phase4-spec.md §2
 *
 * Governs writing to and reading metadata from the shared selector pool.
 * The read path (L4 lookup) lives in CachedElementResolver — do not duplicate it here.
 *
 * Quality gate: only entries with confidence_score >= QUALITY_THRESHOLD are eligible
 * for promotion. This prevents low-quality or flaky selectors from poisoning the pool.
 */

import type { SelectorEntry } from '../../types';

export interface ISharedPoolService {
  /**
   * Attempt to contribute a freshly-resolved tenant entry to the shared pool.
   * Silently skips if:
   *   - tenant's global_brain_opt_in = false
   *   - entry confidence_score < QUALITY_THRESHOLD (0.8)
   *   - a shared entry for the same (content_hash, domain) already exists
   *
   * On success: inserts a new is_shared=true row with tenant_id=NULL and attribution JSONB.
   * Fire-and-forget safe: caller should `void contribute(...)`.
   */
  contribute(params: ContributeParams): Promise<void>;

  /**
   * Returns true if the tenant is opted in and the shared pool should be written to.
   * Cached in Redis (TTL 5 min) to avoid per-resolution DB hits.
   */
  isOptedIn(tenantId: string): Promise<boolean>;

  /**
   * Toggle opt-in for a tenant. Called by PATCH /auth/brain-opt-in.
   * Invalidates the Redis cache for the tenant.
   */
  setOptIn(tenantId: string, value: boolean): Promise<void>;
}

export type ContributeParams = {
  tenantId: string;
  contentHash: string;
  domain: string;
  selectors: SelectorEntry[];
  stepEmbedding: number[];
  elementEmbedding: number[] | null;
  confidenceScore: number;
};

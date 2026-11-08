/**
 * Changing-sites bench — DB/Redis evidence, collected via `docker exec`.
 * Spec: docs/specs/bench/spec-changing-sites.md §7
 *
 * Shelling into the containers instead of connecting from the host is a
 * deliberate robustness choice: host→localhost:5432 has produced ECONNRESETs
 * on this dev box (seen 2026-08-25 during migrations) while in-container
 * clients never have. The bench must not flake on host networking.
 */
import { execFile } from 'node:child_process';

const PG_CONTAINER = process.env.KAIZEN_PG_CONTAINER ?? 'kaizen20-postgres-1';
const REDIS_CONTAINER = process.env.KAIZEN_REDIS_CONTAINER ?? 'kaizen20-redis-1';

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.slice(0, 4).join(' ')}…: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

/** Run one SELECT and return rows as JSON (empty array for no rows). */
export async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const wrapped = `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${query.replace(/;\s*$/, '')}) t`;
  const out = await exec('docker', ['exec', PG_CONTAINER, 'psql', '-U', 'kaizen', '-d', 'kaizen', '-tA', '-c', wrapped]);
  return JSON.parse(out.trim() || '[]') as T[];
}

/** Run one DML statement (no result rows — psql's own output is returned raw). */
export async function sqlExec(statement: string): Promise<string> {
  return exec('docker', ['exec', PG_CONTAINER, 'psql', '-U', 'kaizen', '-d', 'kaizen', '-tA', '-c', statement]);
}

export type CacheRow = {
  content_hash: string;
  domain: string;
  selectors: Array<{ selector: string; strategy?: string; confidence?: number }>;
  confidence_score: number | string;
  outcome_window: unknown;
  last_verified_at: string | null;
  pinned_at: string | null;
};

/** Snapshot the tenant's selector-cache rows for one site hostname. */
export function selectorCacheSnapshot(tenantId: string, domain: string): Promise<CacheRow[]> {
  return sql<CacheRow>(
    `SELECT content_hash, domain, selectors, confidence_score, outcome_window, last_verified_at, pinned_at
       FROM selector_cache
      WHERE tenant_id = '${tenantId}' AND domain = '${domain}'`,
  );
}

/** Grant the bench tenant an LLM budget (fresh tenants may start at zero). */
export async function grantBudget(tenantId: string, tokens = 50_000_000): Promise<void> {
  await sqlExec(`UPDATE tenants SET llm_budget_tokens_monthly = ${tokens} WHERE id = '${tenantId}'`);
}

async function redisDelPattern(pattern: string): Promise<number> {
  const keys = (await exec('docker', ['exec', REDIS_CONTAINER, 'redis-cli', '--scan', '--pattern', pattern]))
    .split('\n').map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) return 0;
  await exec('docker', ['exec', REDIS_CONTAINER, 'redis-cli', 'del', ...keys]);
  return keys.length;
}

/**
 * Between mutation and rerun: clear the resolve-retry hourly budget and the
 * LLM dedup cache — and NOTHING else. selector_cache and sel:* stay, because
 * the stale cache is the exact thing the rerun must recover from.
 */
export async function clearHealingBudget(): Promise<{ healing: number; dedup: number }> {
  return {
    healing: await redisDelPattern('healing:*'),
    dedup: await redisDelPattern('llm:dedup:*'),
  };
}

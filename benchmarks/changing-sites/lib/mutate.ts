/**
 * Changing-sites bench — docroot mutation.
 * Spec: docs/specs/bench/spec-changing-sites.md §6 (phase: mutate)
 *
 * A "mutation" is swapping benchmarks/sites/<id>/live/ to another committed
 * version dir — SAME hostname, new content, which is exactly what keeps the
 * domain-keyed selector cache stale and forces the healing path.
 *
 * The swap is not atomic on Windows bind mounts, so it is only ever invoked
 * between suite runs, and it REFUSES to return until nginx demonstrably serves
 * the new version: __version.txt must match AND the version's marker must
 * appear in its page. Without the probe, a run could race stale bytes and the
 * whole bench would measure Docker Desktop instead of the engine.
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import type { SiteDef } from '../fleet';

const SITES_ROOT = join(__dirname, '..', '..', 'sites');
/** Host-side published port of the compose `sites` nginx. */
const SITES_PORT = Number(process.env.KAIZEN_SITES_PORT ?? 8089);

/** GET through the host-published port with a Host header (fetch/undici forbids setting Host). */
export function siteGet(host: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: SITES_PORT, path, method: 'GET', headers: { Host: host } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export async function setVersion(site: SiteDef, version: string): Promise<void> {
  if (!site.versions.includes(version)) throw new Error(`${site.id} has no version '${version}'`);
  const live = join(SITES_ROOT, site.id, 'live');
  const src = join(SITES_ROOT, site.id, version);

  rmSync(live, { recursive: true, force: true });
  mkdirSync(live, { recursive: true });
  cpSync(src, live, { recursive: true });

  // Refuse to proceed until the swap is demonstrably served.
  const probe = site.probes[version];
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const v = await siteGet(site.host, '/__version.txt');
      const marker = probe ? await siteGet(site.host, probe.path) : null;
      const versionOk = v.status === 200 && v.body.trim() === version;
      const markerOk = !probe || (marker!.status === 200 && marker!.body.includes(probe.contains));
      if (versionOk && markerOk) break;
    } catch { /* nginx mid-reload or bind mount catching up */ }
    if (Date.now() > deadline) throw new Error(`${site.id}: nginx never served ${version} (bind-mount stale?)`);
    await new Promise((r) => setTimeout(r, 500));
  }
  // Small settle for Docker Desktop bind-mount propagation across files the
  // probes did not touch (css/js siblings of the probed page).
  await new Promise((r) => setTimeout(r, 700));
}

# Kaizen 2.0 — Deployment Spec (Free Tier Demo)

**Goal:** Deploy Kaizen to the public internet for testing and demos using only free-tier services. Preserve all learned data (archetypes, selector cache, shared pool) and make it available in the deployed environment.

**Status:** Draft
**Date:** 2026-04-17

---

## 1. Target Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        INTERNET                              │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────┐   │
│  │  Vercel       │    │  Render       │    │  Render       │   │
│  │  Next.js      │───▶│  API Server   │◀──▶│  Worker       │   │
│  │  (Frontend)   │    │  (Fastify)    │    │  (Playwright) │   │
│  └──────────────┘    └──────┬───────┘    └───────┬───────┘   │
│                             │                     │           │
│                      ┌──────┴─────────────────────┴──────┐   │
│                      │                                    │   │
│                ┌─────▼─────┐                ┌─────▼─────┐ │   │
│                │ Supabase   │                │ Upstash    │ │   │
│                │ Postgres   │                │ Redis      │ │   │
│                │ (pgvector) │                │ (serverless)│ │   │
│                └───────────┘                └───────────┘ │   │
│                                                           │   │
└───────────────────────────────────────────────────────────────┘
```

### Service Selection

| Component       | Service   | Tier        | Why                                                          |
|-----------------|-----------|-------------|--------------------------------------------------------------|
| Frontend        | Vercel    | Free (Hobby)| Next.js native, zero-config, automatic SSL                   |
| API Server      | Render    | Free        | Docker support, push-to-deploy, auto-sleep on idle           |
| Worker          | Render    | Free        | Same Docker flow; Playwright image supported                 |
| Postgres        | Supabase  | Free        | pgvector built-in, 500 MB storage, connection pooling        |
| Redis           | Upstash   | Free        | 10K commands/day, serverless, REST + native Redis protocol   |

### Free Tier Limits to Know

| Service  | Key Limits                                                      |
|----------|-----------------------------------------------------------------|
| Vercel   | 100 GB bandwidth/mo, 6000 build-minutes/mo, serverless timeouts 10s |
| Render   | Services spin down after 15 min idle, 750 free hours/mo total, 512 MB RAM |
| Supabase | 500 MB DB, 1 GB file storage, 2 GB bandwidth, pgvector enabled |
| Upstash  | 10K commands/day, 256 MB max, 1 database                       |

### Known Tradeoffs (Free Tier)

- **Render cold starts**: Free services sleep after 15 min. First request after idle takes ~30s to spin up the API server, ~60s for the worker (Playwright image is large). This is acceptable for a demo.
- **Upstash 10K/day limit**: With Redis hot-cache on every resolution, a heavy test session could hit this. Mitigation: the system gracefully falls back to Postgres on Redis miss — it's slower but still works.
- **Supabase connection limits**: Free tier allows 60 concurrent connections. The pool size in `src/db/pool.ts` should be set to `max: 5` per service (API + Worker = 10 total).

---

## 2. Data Migration — Preserving Learned Data

The system has data in three categories:

### 2.1 Schema + Static Seeds (already in Git)

- `db/migrations/001–018_*.sql` — table schema, indexes, enum types
- `db/seeds/element_archetypes.sql` — pre-seeded archetype patterns
- `db/seeds/001_shared_pool_seed.sql` — shared selector pool scaffolding

These deploy automatically via `npm run db:migrate` + `npm run archetypes:seed`.

### 2.2 Runtime Data (local Postgres only — NOT in Git)

This is the critical data to export:

| Table              | What it holds                                    | Priority |
|--------------------|--------------------------------------------------|----------|
| `selector_cache`   | Learned selectors, outcome windows, embeddings   | HIGH     |
| `element_archetypes` | Archetypes (seeded + dynamically learned)       | HIGH     |
| `shared_selectors` | Global brain verified selectors (if populated)   | MEDIUM   |
| `tenants`          | Your test tenant(s)                              | HIGH     |
| `users`            | Your test user(s)                                | HIGH     |
| `test_suites`      | Test suite definitions                           | HIGH     |
| `test_cases`       | Test case definitions                            | HIGH     |
| `test_case_steps`  | Step ordering within cases                       | HIGH     |
| `steps`            | Individual NL step definitions + compiled ASTs    | HIGH     |
| `test_runs`        | Historical run data                              | LOW      |
| `step_results`     | Historical step-level results                    | LOW      |

### 2.3 Export Strategy

**Approach: `pg_dump` data-only export → checked into `db/seeds/` → run on deploy.**

```bash
# Step 1: Export core data (schema-independent, data-only)
pg_dump -U kaizen -d kaizen \
  --data-only \
  --no-owner \
  --no-privileges \
  --disable-triggers \
  --table=tenants \
  --table=users \
  --table=test_suites \
  --table=test_cases \
  --table=test_case_steps \
  --table=steps \
  --table=selector_cache \
  --table=element_archetypes \
  > db/seeds/002_runtime_data_export.sql

# Step 2: Export historical runs (optional, for demo data)
pg_dump -U kaizen -d kaizen \
  --data-only \
  --no-owner \
  --no-privileges \
  --disable-triggers \
  --table=test_runs \
  --table=step_results \
  > db/seeds/003_historical_runs_export.sql
```

**Important:** Before exporting, scrub any real secrets:
- `tenants.api_key_hash` — replace with a known test hash or NULL
- `users` password hashes — replace with a known test password hash
- Any real email addresses — replace with test@kaizen.dev

### 2.4 Seed Execution Order

Create a unified `npm run db:seed:all` script that runs in order:

```
1. npm run db:migrate          — schema up to date
2. db/seeds/002_runtime_data_export.sql  — core learned data
3. npm run archetypes:seed     — archetype patterns (ON CONFLICT DO NOTHING)
4. db/seeds/001_shared_pool_seed.sql     — shared pool scaffolding
```

The export file should use `ON CONFLICT DO NOTHING` or `INSERT ... ON CONFLICT DO UPDATE` to be idempotent.

---

## 3. Code Changes Required

### 3.1 Frontend — Vercel Deployment

| File | Change | Why |
|------|--------|-----|
| `packages/web/next.config.ts` | Add `output: 'standalone'` | Vercel uses standalone output for optimal deployment |
| `packages/web/next.config.ts` | Remove `outputFileTracingRoot` | Not needed on Vercel; causes issues outside monorepo root |
| `packages/web/.env.production` (new) | `KAIZEN_API_URL=https://<render-api-url>` | Points proxy routes at the deployed API |

The frontend already uses a server-side proxy pattern (`/api/proxy/[...path]/route.ts`) — this is perfect for Vercel because:
- API calls go through Vercel's serverless functions → no CORS issues
- The `KAIZEN_API_URL` env var controls where the proxy forwards to
- Auth cookies are httpOnly server-side — secure by default

**No client-side env vars needed** — everything goes through the proxy.

### 3.2 API Server — Render Deployment

| File | Change | Why |
|------|--------|-----|
| `Dockerfile.api` | Add proper build step + production CMD | Current Dockerfile runs dev mode |
| `src/api/server.ts` | Ensure `CORS_ORIGIN` is set in production | Currently defaults to `*` |
| `render.yaml` (new) | Render Blueprint for API + Worker | Infrastructure-as-code, one-click deploy |

**Updated `Dockerfile.api`:**
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --production=false
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/db ./db
COPY --from=builder /app/scripts ./scripts
EXPOSE 3000
CMD ["node", "dist/api/server.js"]
```

### 3.3 Worker — Render Deployment

| File | Change | Why |
|------|--------|-----|
| `Dockerfile.worker` | Add build step, keep Playwright base image | Needs browser binaries |

**Updated `Dockerfile.worker`:**
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --production=false
COPY . .
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.58.2-noble
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/db ./db
COPY --from=builder /app/scripts ./scripts
CMD ["sh", "-c", "node scripts/migrate.js && node dist/workers/worker.js"]
```

> **Note:** The migrate script is TypeScript (`scripts/migrate.ts`). In the production image we only have compiled JS. Either:
> (a) Include `tsx` as a production dependency and run `npx tsx scripts/migrate.ts`, or
> (b) Add `scripts/migrate.ts` to the build output. Option (b) is cleaner — ensure `tsconfig.build.json` includes `scripts/`.

### 3.4 Database Connection — Supabase

| File | Change | Why |
|------|--------|-----|
| `src/db/pool.ts` | Add `ssl: { rejectUnauthorized: false }` when `DATABASE_URL` contains `supabase` or when `DB_SSL=true` | Supabase requires SSL |
| `src/db/pool.ts` | Set `max: 5` pool size for free tier | Supabase free = 60 connections |

### 3.5 Redis Connection — Upstash

Upstash provides a standard Redis connection string (`rediss://...`). The `ioredis` client Kaizen already uses supports this natively — just set `REDIS_URL` to the Upstash URL. The `rediss://` scheme enables TLS automatically.

No code changes needed for Redis.

### 3.6 Render Blueprint (`render.yaml`)

```yaml
services:
  - type: web
    name: kaizen-api
    runtime: docker
    dockerfilePath: ./Dockerfile.api
    plan: free
    healthCheckPath: /health
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        fromGroup: kaizen-secrets
      - key: REDIS_URL
        fromGroup: kaizen-secrets
      - key: OPENAI_API_KEY
        fromGroup: kaizen-secrets
      - key: JWT_PRIVATE_KEY
        fromGroup: kaizen-secrets
      - key: JWT_PUBLIC_KEY
        fromGroup: kaizen-secrets
      - key: CORS_ORIGIN
        value: https://<your-vercel-domain>
      - key: LLM_PROVIDER
        value: openai
      - key: PORT
        value: "3000"

  - type: worker
    name: kaizen-worker
    runtime: docker
    dockerfilePath: ./Dockerfile.worker
    plan: free
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        fromGroup: kaizen-secrets
      - key: REDIS_URL
        fromGroup: kaizen-secrets
      - key: OPENAI_API_KEY
        fromGroup: kaizen-secrets
      - key: WORKER_CONCURRENCY
        value: "2"

envVarGroups:
  - name: kaizen-secrets
    envVars:
      - key: DATABASE_URL
        sync: false
      - key: REDIS_URL
        sync: false
      - key: OPENAI_API_KEY
        sync: false
      - key: JWT_PRIVATE_KEY
        sync: false
      - key: JWT_PUBLIC_KEY
        sync: false
```

---

## 4. Environment Variables Matrix

| Variable | Vercel (Frontend) | Render API | Render Worker |
|----------|------------------|------------|---------------|
| `NODE_ENV` | `production` (auto) | `production` | `production` |
| `KAIZEN_API_URL` | `https://kaizen-api.onrender.com` | — | — |
| `DATABASE_URL` | — | Supabase connection string | Supabase connection string |
| `REDIS_URL` | — | Upstash connection string | Upstash connection string |
| `OPENAI_API_KEY` | — | Your key | Your key |
| `LLM_PROVIDER` | — | `openai` | `openai` |
| `JWT_PRIVATE_KEY` | — | Generated RSA PEM | — |
| `JWT_PUBLIC_KEY` | — | Matching public PEM | — |
| `CORS_ORIGIN` | — | `https://<vercel-domain>` | — |
| `PORT` | — | `3000` | — |
| `WORKER_CONCURRENCY` | — | — | `2` |
| `DB_SSL` | — | `true` | `true` |

---

## 5. Deployment Steps (Ordered)

### Phase A: Provision Infrastructure

1. **Supabase** — Create project, enable pgvector extension (`CREATE EXTENSION IF NOT EXISTS vector;`), copy connection string
2. **Upstash** — Create Redis database, copy connection string (`rediss://...`)
3. **Generate JWT keypair** — `openssl genrsa -out private.pem 2048 && openssl rsa -in private.pem -pubout -out public.pem`

### Phase B: Migrate Data

4. **Run migrations against Supabase** — `DATABASE_URL=<supabase_url> npm run db:migrate`
5. **Export local runtime data** — `pg_dump` as described in §2.3
6. **Scrub secrets from export** — Replace real credentials with test values
7. **Import into Supabase** — `psql <supabase_url> -f db/seeds/002_runtime_data_export.sql`
8. **Run archetype seed** — `DATABASE_URL=<supabase_url> npm run archetypes:seed`
9. **Run shared pool seed** — `psql <supabase_url> -f db/seeds/001_shared_pool_seed.sql`

### Phase C: Deploy Backend (Render)

10. **Push code changes** to GitHub (updated Dockerfiles, render.yaml, pool.ts)
11. **Connect Render to GitHub repo** — Render auto-detects `render.yaml`
12. **Set environment variables** in Render dashboard (or via env var group)
13. **Deploy API** — Verify `/health` returns `{ status: "ok" }`
14. **Deploy Worker** — Verify it connects to Redis queue and starts polling

### Phase D: Deploy Frontend (Vercel)

15. **Connect Vercel to GitHub repo** — Set root directory to `packages/web`
16. **Set `KAIZEN_API_URL`** in Vercel env vars → `https://kaizen-api.onrender.com`
17. **Deploy** — Verify login page loads, proxy routes forward to API

### Phase E: Smoke Test

18. **Register a test user** via the UI
19. **Create a test suite + test case** with a simple NL step (e.g., "Navigate to google.com and search for 'hello'")
20. **Run the test** — Verify the worker picks it up, Playwright executes, results appear in the dashboard
21. **Check archetype resolution** — Monitor logs for `archetype_hit` vs `llm_resolve`

---

## 6. Scripts to Create

### `scripts/seed-all.ts`

Unified seed runner: migrations → runtime export → archetypes → shared pool.

```typescript
// Runs in order:
// 1. db:migrate
// 2. db/seeds/002_runtime_data_export.sql (if exists)
// 3. archetypes:seed
// 4. db/seeds/001_shared_pool_seed.sql
```

Add to `package.json`:
```json
"db:seed:all": "npm run db:migrate && tsx scripts/seed-all.ts"
```

### `scripts/export-runtime-data.ts`

Node.js wrapper around `pg_dump` that:
1. Dumps the right tables
2. Scrubs sensitive fields automatically
3. Wraps INSERTs in `ON CONFLICT DO NOTHING`
4. Writes to `db/seeds/002_runtime_data_export.sql`

---

## 7. Security Checklist

- [ ] `.env` is in `.gitignore` (already is)
- [ ] No real API keys in committed files
- [ ] Exported SQL has no real passwords or API key hashes
- [ ] `CORS_ORIGIN` is set to exact Vercel domain (not `*`)
- [ ] JWT keys are generated fresh for production, not copied from dev
- [ ] Supabase connection string uses SSL (`?sslmode=require`)
- [ ] Upstash connection uses TLS (`rediss://`)

---

## 8. Post-Deploy Monitoring

With free tiers, monitor:
- **Upstash dashboard** — daily command count (10K limit)
- **Render dashboard** — memory usage (512 MB limit), cold start frequency
- **Supabase dashboard** — storage usage (500 MB limit), connection count
- **Vercel dashboard** — function invocation count, bandwidth

---

## 9. Future Upgrade Path

When ready to move beyond demo:
- Render Starter ($7/mo each) — always-on, no cold starts, 2 GB RAM
- Supabase Pro ($25/mo) — 8 GB storage, more connections, point-in-time recovery
- Upstash Pay-as-you-go ($0.2/100K commands) — scales automatically
- Custom domain + Cloudflare for CDN/DDoS protection

# Kaizen 2.0 — Claude Code Orientation

---

## Pre-Implementation Protocol

Run this before writing any code. No exceptions.

1. **Read `docs/summaries/00-index.md`** — get the full list of spec and reference files for the system's architecture.
2. **Scan the related summary spec** for the module you are about to touch. Open and read it fully.
3. **If no spec covers the layer you are about to touch** — stop. Ask the user for clarification before writing implementation code.
4. **Before writing any error message string** — check existing error enums and structures.
5. **If a project-specific term is unfamiliar** — check the summaries or ask for context.
6. **Confirm the target file path** against the Layer Map below and ensure you are in the correct monorepo package workspace (`packages/web` vs `src/`).
7. **Check `package.json`** — confirm every package you will import is listed. Add missing packages via `npm install` before writing any import.
8. **Locate the test file** — check the module's `__tests__` directory. Update or create it before declaring the task finished.
9. **After implementation** — run `npm run typecheck` and `npm run lint` before reporting done.

---

## What This Project Is

AI-powered self-healing UI test automation platform.
Sources: Natural language English test steps compiled by LLMs.
Process: Playwright executes a generated AST against a target web application. If a selector breaks, a chain of recovery strategies (LLM DOM analysis, pgvector similarity, fallback) kicks in to heal it.
Stack: Next.js 15 (Frontend) + Fastify (Backend) + BullMQ/Redis (Jobs) + PostgreSQL `pgvector` (Database) + Playwright (Browser execution).

---

## Layer Map

| Directory | Role |
|---|---|
| `packages/web/src/app` | Next.js App Router. Pages, layouts, and the API Proxy interceptor (`/api/proxy`). |
| `packages/web/src/components` | Atomic Design frontend components (Atoms, Molecules, Organisms). |
| `packages/web/src/hooks` | React data fetching and business logic hooks decoupling state from UI. |
| `src/api/` | Fastify API application, route handlers, and server entrypoint. |
| `src/workers/` | BullMQ worker consuming test execution jobs. Instantiates Playwright and the Healing Engine. |
| `src/modules/test-compiler/` | Compiles English to JSON ASTs using L1/L2 caches and LLM fallbacks. |
| `src/modules/execution-engine/` | Playwright automation wrappers interacting with the browser based on AST outputs. |
| `src/modules/healing-engine/` | Chain of Responsibility failure recovery matrix for broken selectors. |
| `src/modules/element-resolver/` | Maps natural language targets into concrete, ranked robust DOM selectors. |
| `src/modules/llm-gateway/` | Abstraction layers over OpenAI/Anthropic APIs, handling token billing via `PostgresBillingMeter`. |
| `src/modules/identity/` | Strict multi-tenant authentication, user, and workspace RBAC structures. |
| `src/db/` | Database connection pools and pg abstractions. |
| `src/types/` | Global shared TypeScript interfaces and schemas. |

---

## Execution Pipeline Order

Instead of fixed rigid stage files, tests execution flows dynamically:
1. **Compilation (`test-compiler`)** — Converts text to steps.
2. **Job Queue (`BullMQ`)** — Backend API inserts run job into Redis.
3. **Worker Processing (`exec-engine`)** — Worker claims job, boots Playwright browser, executes steps sequentially.
4. **Healing Trigger (`healing-engine`)** — If `page.click()` fails, worker intercepts the error, runs `FailureClassifier`, and triggers `HealingEngine.heal()`.
5. **Persistence** — Successful, failed, and healed results sink into the Postgres `step_results` table.

---

## Never Generate

Absolute prohibitions — never produce these regardless of context:

- `.js` files — Use strict TypeScript (`.ts` / `.tsx`) under all circumstances.
- Direct database calls from Next.js server components — All requests must flow through the API proxy.
- Hardcoded CSS outside of Tailwind utility classes.
- Standard `fetch` without authorization headers when communicating with the backend API.
- Committing the `.env` file or hardcoded secrets.
- `any` types in TypeScript without a justification comment bypassing strict TS configurations.
- Unsandboxed `eval()` calls.

---

## Hard Constraints

### Dependency Management

- `package.json` is the single source of truth for dependencies. Note this is a monorepo structure.
- During development: PostgreSQL and Redis run as bare Docker containers.

### Architecture

- **Strict Multi-Tenancy**: Almost all Postgres queries must include a `tenant_id` filter to prevent cross-contamination.
- **Frontend/Backend Separation**: The Fastify API code (`src/`) never imports Next.js code (`packages/web`).
- **Caching limits latency**: The test-compiler and element resolver must use DB or Memory cache aggressively before making expensive LLM calls.

### Tools and Libraries

- Headless Browser: **Playwright** only. Do not use Puppeteer or Selenium.
- UI library: **Tailwind CSS**, strictly following atomic layout structures. No inline styles.
- Analytics/Logging: **Pino** for logging, OpenTelemetry for tracing.
- LLM Providers: OpenAI and Anthropic integrations through Gateway only.

### Code Style

- Typescript 5.x.
- Follow ESLint (`npm run lint`).
- DRY, SOLID, KISS by default.

---

## Local Development Setup

```bash
# Install all required workspaces packages
npm install

# Bare infrastructure containers
docker-compose up -d

# Migrate database
npm run db:migrate

# Setup Env
cp .env.example .env
```

---

## Running Locally

```bash
# Terminal 1: Run the backend Fastify API
npm run dev

# Terminal 2: Run the Playwright worker process
npm run dev:worker

# Terminal 3: Run the Next.js frontend
cd packages/web && npm run dev
```

---

## Tests

```bash
npm run test                   # Jest unit testing
npm run test:watch             # Fast iteration testing
npm run test:coverage          # Measure output thresholds
npm run test:integration       # Playwright / DB driven tests
```

---

## Lint and Format

```bash
npm run typecheck
npm run lint
```

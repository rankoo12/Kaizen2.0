# Backend Architecture (`src/`)

## Infrastructure
- **API Server**: Fastify + Node.js (`src/api/server.ts`).
- **Worker**: BullMQ job processor (`src/workers/worker.ts`), consuming tasks from Redis.
- **Database**: PostgreSQL (connected via `pg` pool), heavily using `pgvector` for similarity matching.
- **Cache**: Redis.

## Modules Structure
The backend is deeply componentized into modules, loosely coupled via interfaces.
- `execution-engine`: Playwright-driven test steps.
- `healing-engine`: The self-healing loop for broken UI selectors.
- `identity`: Multi-tenant users, roles, and platform admin logic.
- `llm-gateway`: Wrapping OpenAI/Anthropic SDKs.
- `test-compiler`: "Learned" compilation of english to AST.
- `dom-pruner`: Reducing DOM size before sending context to LLMs.
- `element-resolver`: Maps natural language target strings to valid DOM selectors.

**Related Specs:**
- [Shared Pool & Worker](./07-shared-pool-worker.md)
- [Identity & Auth](./05-identity-auth.md)

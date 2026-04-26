# Kaizen 2.0 Engineering Spec Index

Welcome to the **Kaizen 2.0** architecture reference. This project is an AI-powered self-healing UI test automation platform.

> **New here?** Start with [`docs/CLAUDE.md`](../CLAUDE.md) for the orientation + pre-implementation protocol, then come back here for the full spec map.

Use these documents to rapidly understand the components.
All specs are modular; follow the links to learn more about specific sub-systems.

## Table of Contents

### Frontend (`packages/web`)
- [01 Architecture Overview](./frontend/01-architecture-overview.md): Core Next.js + Tailwind + SSR vs CSR patterns.
- [02 API & Routing](./frontend/02-api-routing.md): Next.js App router, middleware, and Next.js backend proxy.
- [03 Atomic Design Components](./frontend/03-atomic-design.md): Reusable component hierarchy (Atoms, Molecules, Organisms).
- [04 Data & Hooks](./frontend/04-data-hooks.md): Context APIs and React query hooks.
- [05 UI & UX Enhancements](./frontend/05-ui-ux-enhancements.md): Interactive element updates, 3D aesthetics, and persistent music player.

### Backend (`src/`)
- [01 Architecture Overview](./backend/01-architecture-overview.md): Fastify API, BullMQ workers.
- [02 Learned Compiler](./backend/02-learned-compiler.md): Natural language to AST generation via caching/LLM.
- [03 Execution Engine](./backend/03-execution-engine.md): Playwright integration.
- [04 Healing Engine](./backend/04-healing-engine.md): Strategy matrix for resolving broken selectors.
- [05 Identity & Auth](./backend/05-identity-auth.md): Multi-tenancy and standard JWT patterns.
- [06 LLM Gateway](./backend/06-llm-gateway.md): Integration layer for OpenAI/Anthropic.

### Specs (`docs/specs/`)

Full specifications live under `docs/specs/`, grouped by domain:

- **core** — Master spec versions and phase plans: [core/](../specs/core/)
- **ui** — Frontend design system and UX: [ui/](../specs/ui/)
- **identity** — Tenants, users, memberships, auth: [identity/](../specs/identity/)
- **integration** — Backend ↔ frontend contracts: [integration/](../specs/integration/)
- **smart-brain** — Element archetypes, shared pool, archetype disambiguation: [smart-brain/](../specs/smart-brain/)
- **dom-pruner** — DOM candidate extraction and accessible-name resolution: [dom-pruner/](../specs/dom-pruner/)
- **reliability** — Feedback loop, cache coverage, resilience tiers: [reliability/](../specs/reliability/)
- **tests-ux** — Tests dashboard feature specs (comparison mode, etc.): [tests-ux/](../specs/tests-ux/)
- **workers** — Distributed worker architecture: [workers/](../specs/workers/)
- **deployment** — Deployment and ops: [deployment/](../specs/deployment/)

### Other reference

- **Known issues** — [docs/known-issues/](../known-issues/) catalogues accepted limitations and unresolved bugs. Read before re-investigating.
- **UI prototype** — [docs/design/UI/](../design/UI/) is the static HTML/JSX reference that defined the current visual language. Read-only; production code never imports from it.
- **Recent specs of note**:
  - UI: [spec-prototype-port.md](../specs/ui/spec-prototype-port.md) — current visual design + token system; [spec-design-fixes-batch.md](../specs/ui/spec-design-fixes-batch.md) — post-port polish.
  - Identity: [spec-token-limit-enforcement.md](../specs/identity/spec-token-limit-enforcement.md) — tenant token quota enforcement at run-enqueue.
  - Smart-brain: [spec-archetype-verdict-cooldown.md](../specs/smart-brain/spec-archetype-verdict-cooldown.md), [spec-element-resolver-ambiguous-cache-write.md](../specs/smart-brain/spec-element-resolver-ambiguous-cache-write.md), [spec-element-resolver-cache-semantic-guard.md](../specs/smart-brain/spec-element-resolver-cache-semantic-guard.md) — cache + verdict correctness fixes.

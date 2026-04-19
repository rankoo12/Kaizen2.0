# Kaizen 2.0 Engineering Spec Index

Welcome to the **Kaizen 2.0** architecture reference. This project is an AI-powered self-healing UI test automation platform.

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

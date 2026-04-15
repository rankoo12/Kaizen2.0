# Frontend State & Hooks

## Hook Patterns
The UI completely decouples logic from visual UI components by placing business logic inside `src/hooks/`. These hooks encapsulate Next.js `fetch` queries against the API proxy (`/api/proxy`).

### Key Hooks
- `useSuites.ts` / `useCases.ts`: Poll or fetch test suite hierarchies and individual test case metadata.
- `useCaseDetail.ts`: Deep fetches case specifics (steps, results).
- `useRunPoller.ts` / `useRunDetail.ts`: Crucial for the Execution Engine. Since test execution takes time, `useRunPoller` sets up intervals to fetch execution status until completion, updating local UI states dynamically.

## Authentication Context
- `AuthContext` (`src/context/auth-context.tsx`): Exposes login, registration, logout, and current user state.
- Wraps the entire Next.js app inside `providers.tsx`.
- Interfaces with Next.js `/api/auth/*` local API routes (which then map to the proxy or perform direct session mutation).

**Related Specs:**
- [API & Proxy](./02-api-routing.md)

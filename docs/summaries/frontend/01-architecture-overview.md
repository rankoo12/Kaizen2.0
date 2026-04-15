# Frontend Architecture (packages/web)

## Tech Stack
- **Framework:** Next.js 15 (App Router).
- **Language:** TypeScript.
- **Styling:** Tailwind CSS (configured in `tailwind.config.ts`, global CSS in `globals.css`).
- **Icons:** Custom SVGs (social-icons.tsx) & lucide-react.

## Directory Structure
- `src/app`: Page routing and Server-Side API logic. Next.js App router conventions (`layout.tsx`, `page.tsx`).
- `src/components`: UI components organized by **Atomic Design** principles (Atoms, Molecules, Organisms).
- `src/hooks`: Custom React hooks for data fetching and state encapsulation.
- `src/context`: React Context providers (e.g., AuthContext).
- `src/lib`: Utilities (e.g., `cn.ts` clx merger, `cookies.ts` cookie handlers).
- `src/types`: Frontend-specific typings (often reflecting API shapes).

## Global Rules for LLMs
1. Use **Server Components** for basic layouts and pass configuration downwards.
2. Use `"use client"` explicit boundaries on interactive islands.
3. Import styles using Tailwind utilities only; avoid ad-hoc CSS modules unless completely necessary.

**Related Specs:**
- [Routing & Proxies](./02-api-routing.md)
- [Component Design](./03-atomic-design.md)

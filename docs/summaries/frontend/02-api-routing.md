# Frontend Routing & API Proxy

## App Router
- Next.js 15 App router controls navigation.
- Main routes: `/login`, `/signup`, `/tests`, `/tests/new`, `/tests/[id]`.

## Middleware (`src/middleware.ts`)
- Restricts unauthenticated access to `PROTECTED_PREFIXES` (e.g., `/tests`).
- Redirects authenticated sessions away from `AUTH_ONLY_PREFIXES` (e.g., `/login`).
- Session validation relies solely on the presence of the `ACCESS_COOKIE`.

## API Proxy (`src/app/api/proxy/[...path]/route.ts`)
Instead of direct frontend-to-API calls, all frontend data requests flow through the Next.js API Proxy (`/api/proxy/*`).
- **Purpose**: Hides backend service IPs, securely handles JWT token exchange, and sets HttpOnly cookies.
- **Refresh Flow**: The proxy intercepts 401s from the backend, triggers a refresh using the backend `/auth/refresh` endpoint, automatically sets new cookies in the Next.js response, and replays the original backend request with the new access token.
- **Binary Data**: Explicitly handles non-JSON responses (like images) using `.arrayBuffer()` conversions to allow the UI to fetch screenshots from the backend securely.

**Related Specs:**
- [Hooks & Data Fetching](./04-data-hooks.md)

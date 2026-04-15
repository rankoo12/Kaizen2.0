# Identity & Authentication (`src/modules/identity`)

Manages User lifecycles, Session Management, and **Strict Multi-Tenancy**.

## Core Concepts
- Users authenticate via standard local logic (email/password) or potentially social SSO.
- JWT tokens are issued and managed. The Frontend Next.js proxy handles storing these securely as HttpOnly cookies.
- **Tenant Isolation**: Kaizen heavily segments data. A User belongs to a Tenant Workspace. Almost all SQL queries in the system enforce `tenant_id = $1` to prevent cross-contamination.

## Structure
- `auth.service.ts`: JWT Generation, Refresh tokens.
- `user.service.ts`: CRUD for User profiles.
- `tenant.service.ts`: Workspaces.
- `membership.service.ts`: Links users to tenants with Role Based Access Control (RBAC).

**Related Specs:**
- [Frontend Routing & Proxy](../frontend/02-api-routing.md)

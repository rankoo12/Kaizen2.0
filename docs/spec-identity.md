# Kaizen — Identity & Multi-Tenancy Specification
### Version 1.0 | Tenants, Users, Memberships, and Platform Administration

*This spec governs how identities are created, authenticated, and authorized within Kaizen. It defines the full surface of the identity domain: the platform admin layer (Kaizen itself), tenant organizations, individual users, and the membership relationship that connects them. All other specs reference this document for auth and tenant-scoping contracts.*

---

## Table of Contents

1. [Domain Model](#1-domain-model)
2. [Invariants](#2-invariants)
3. [Roles & Permissions Matrix](#3-roles--permissions-matrix)
4. [Platform Admin Layer](#4-platform-admin-layer)
5. [Data Model](#5-data-model)
6. [Service Interfaces](#6-service-interfaces)
   - 6.1 [IAuthService](#61-iauthservice)
   - 6.2 [ITenantService](#62-itenantservice)
   - 6.3 [IUserService](#63-iuserservice)
   - 6.4 [IMembershipService](#64-imembershipservice)
   - 6.5 [IPlatformAdminService](#65-iplatformadminservice)
7. [API Contracts](#7-api-contracts)
8. [Auth Flow](#8-auth-flow)
9. [Registration Flow](#9-registration-flow)
10. [Invite Flow](#10-invite-flow)
11. [JWT Contract](#11-jwt-contract)
12. [Tenant Resolution](#12-tenant-resolution)
13. [Row-Level Security](#13-row-level-security)
14. [Security Considerations](#14-security-considerations)
15. [Migration Plan](#15-migration-plan)

---

## 1. Domain Model

### Entities

```
Platform
  └── [1..*] Tenants
                └── [1..*] Memberships ←→ Users
                └── [1..*] Test Suites, Runs, Selector Cache, ...
```

**User**
An individual human identity. Has credentials (email + hashed password). Belongs to one or more tenants through a `Membership`. Has no meaningful existence outside of a membership — a user with zero memberships is in an invalid state and must not occur (enforced by the registration transaction).

**Tenant**
An isolated organizational unit. The billing entity. All product data (test suites, runs, selector cache, healing events) is scoped to a tenant. A tenant has a `slug` used for display and future subdomain support. Every tenant has exactly one `owner` membership at all times.

**Membership**
The join between a User and a Tenant. Carries a `role` that governs what the user can do within that tenant. A user can hold memberships in multiple tenants (workspace switching). The role is per-membership, not global.

**Personal Tenant**
A tenant automatically created during user registration. The user is its `owner`. It is indistinguishable from any other tenant in the data model — the label "personal" is purely a display hint (`is_personal = true`). This ensures zero special-casing in all downstream code.

**Platform Admin**
A Kaizen-operated identity that sits above the tenant layer. It is not a user with a special role inside a tenant — it is a separate identity stored in a separate table. Platform admins can read across all tenants, manage plans, and impersonate users for support purposes.

### Relationships

| Relationship | Cardinality | Notes |
|---|---|---|
| User ↔ Tenant | M:M via `memberships` | A user can belong to many tenants; a tenant can have many users |
| Tenant → Membership | 1:M | Tenant always has at least one membership (the owner) |
| User → Membership | 1:M | User always has at least one membership (their personal tenant) |
| Platform Admin → Tenants | 1:M (read/write) | Via platform admin service; no membership row required |

---

## 2. Invariants

These are hard constraints the system must enforce at all times. Any code path that would violate an invariant must be rejected at the service layer before touching the database.

| # | Invariant |
|---|---|
| I-1 | Every user has at least one membership. |
| I-2 | Every tenant has exactly one `owner` membership at all times. |
| I-3 | A tenant's owner cannot be removed unless ownership is transferred first. |
| I-4 | A user cannot leave a tenant if they are the sole owner. |
| I-5 | Membership role changes for an `owner` require explicit ownership transfer, not a role update. |
| I-6 | Registration is atomic: user + personal tenant + owner membership are created in one transaction. If any step fails, all are rolled back. |
| I-7 | A `platform_admin` identity cannot hold a tenant membership (no cross-layer contamination). |
| I-8 | Deleted users have their memberships soft-deleted; tenant data is not affected. |
| I-9 | Deleted tenants have their memberships soft-deleted and their product data archived, not hard-deleted. |

---

## 3. Roles & Permissions Matrix

Roles are per-membership. A user who is an `admin` in Tenant A may be a `viewer` in Tenant B.

| Permission | owner | admin | member | viewer |
|---|:---:|:---:|:---:|:---:|
| Run test suites | ✓ | ✓ | ✓ | — |
| View runs & results | ✓ | ✓ | ✓ | ✓ |
| Create / edit test suites | ✓ | ✓ | ✓ | — |
| Delete test suites | ✓ | ✓ | — | — |
| Invite users | ✓ | ✓ | — | — |
| Remove users | ✓ | ✓ | — | — |
| Change member roles | ✓ | ✓ | — | — |
| View billing & usage | ✓ | ✓ | — | — |
| Update billing plan | ✓ | — | — | — |
| Update tenant settings | ✓ | ✓ | — | — |
| Transfer ownership | ✓ | — | — | — |
| Delete tenant | ✓ | — | — | — |
| Opt in to global brain | ✓ | ✓ | — | — |
| Generate API keys | ✓ | ✓ | — | — |

**Platform admin** can perform all of the above across any tenant, plus:
- List all tenants
- Override plan limits
- Impersonate any user (audit-logged)
- Suspend / unsuspend tenants
- View platform-wide billing rollups

---

## 4. Platform Admin Layer

The platform admin layer is separate from the tenant layer. It is not a special role inside any tenant — it is a distinct identity plane.

### Why separate

If `platform_admin` were a role inside a tenant, it would require either:
(a) A fictional "Kaizen" tenant that owns everything — creating a privileged tenant with special-cased logic everywhere, or
(b) A global role column on `users` — breaking the per-membership role model and leaking platform concerns into tenant-scoped auth.

A separate `platform_admins` table keeps the tenant data model clean and makes platform access auditable without touching tenant auth paths.

### Capabilities

```
IPlatformAdminService
  listTenants(filters)       → paginated tenant list with usage stats
  getTenant(tenantId)        → full tenant detail
  suspendTenant(tenantId)    → blocks all logins and runs for tenant
  unsuspendTenant(tenantId)  → restores access
  overridePlan(tenantId, plan, limits)
  impersonateUser(userId)    → issues a time-limited impersonation JWT (TTL: 1 hour)
                               every impersonation is written to platform_audit_log
  listPlatformAuditLog(filters)
```

### Impersonation

Impersonation issues a separate JWT with claim `"impersonated_by": "<admin_id>"`. All writes performed under an impersonation token are tagged with `impersonated_by` in the audit log. Impersonation tokens cannot be refreshed — they expire after 1 hour and require a new impersonation action.

---

## 5. Data Model

### `users`

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                    -- bcrypt, min cost 12
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  email_verified_at  TIMESTAMPTZ,
  last_login_at      TIMESTAMPTZ,
  deleted_at         TIMESTAMPTZ,                 -- soft delete
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX users_email_idx ON users (email) WHERE deleted_at IS NULL;
```

### `tenants`

```sql
CREATE TABLE tenants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT NOT NULL UNIQUE,              -- url-safe, e.g. "acme-corp"
  display_name TEXT NOT NULL,
  plan         TEXT NOT NULL DEFAULT 'free'
                 CHECK (plan IN ('free', 'pro', 'enterprise')),
  is_personal  BOOLEAN NOT NULL DEFAULT false,    -- display hint only; no logic branches on this
  brain_opt_in BOOLEAN NOT NULL DEFAULT false,
  suspended_at TIMESTAMPTZ,
  deleted_at   TIMESTAMPTZ,                       -- soft delete; cascades to memberships
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tenants_slug_idx ON tenants (slug) WHERE deleted_at IS NULL;
```

### `memberships`

```sql
CREATE TABLE memberships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  user_id    UUID NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL
               CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  invited_by UUID REFERENCES users(id),           -- null for the founding owner
  accepted_at  TIMESTAMPTZ,                       -- null = invite pending
  deleted_at   TIMESTAMPTZ,                       -- soft delete
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, user_id)                     -- one membership per (tenant, user) pair
);

CREATE INDEX memberships_user_idx   ON memberships (user_id)   WHERE deleted_at IS NULL;
CREATE INDEX memberships_tenant_idx ON memberships (tenant_id) WHERE deleted_at IS NULL;
```

### `invites`

```sql
-- Separate from memberships to allow re-invitation without polluting the membership table.
-- A pending invite is not a membership until accepted.
CREATE TABLE invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  invited_by  UUID NOT NULL REFERENCES users(id),
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  token       TEXT NOT NULL UNIQUE,               -- securely random, used in the invite link
  expires_at  TIMESTAMPTZ NOT NULL,               -- 7 days from creation
  accepted_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, email)                       -- one pending invite per (tenant, email)
);
```

### `refresh_tokens`

```sql
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  token_hash  TEXT NOT NULL UNIQUE,               -- SHA-256 of the raw token; raw token is in JWT only
  expires_at  TIMESTAMPTZ NOT NULL,               -- 30 days
  revoked_at  TIMESTAMPTZ,
  user_agent  TEXT,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
```

### `platform_admins`

```sql
CREATE TABLE platform_admins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `platform_audit_log`

```sql
CREATE TABLE platform_audit_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id       UUID NOT NULL REFERENCES platform_admins(id),
  action         TEXT NOT NULL,                   -- e.g. 'impersonate_user', 'suspend_tenant'
  target_type    TEXT NOT NULL,                   -- 'user' | 'tenant'
  target_id      UUID NOT NULL,
  impersonated_as UUID REFERENCES users(id),      -- set during impersonation sessions
  metadata       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 6. Service Interfaces

All interfaces follow the SDD contract: the interface is the source of truth. Implementations, tests, and database queries are all derived from it.

### 6.1 `IAuthService`

```typescript
interface IAuthService {
  /**
   * Validates credentials and issues an access + refresh token pair for the
   * given (user, tenant) context. Returns null on invalid credentials.
   * Tenant context is required — a user must select which workspace they are
   * logging into (defaults to their personal tenant if only one exists).
   */
  login(email: string, password: string, tenantId: string): Promise<TokenPair | null>;

  /**
   * Issues a new access token from a valid, unexpired refresh token.
   * Rotates the refresh token (old token is revoked, new token is issued).
   * Returns null if the refresh token is invalid, expired, or revoked.
   */
  refresh(refreshToken: string): Promise<TokenPair | null>;

  /**
   * Revokes a specific refresh token (logout from one device).
   */
  logout(refreshToken: string): Promise<void>;

  /**
   * Revokes all refresh tokens for the user (logout from all devices).
   */
  logoutAll(userId: string): Promise<void>;

  /**
   * Verifies and decodes an access token. Returns null if invalid or expired.
   * Does NOT hit the database — JWT verification only.
   */
  verifyAccessToken(token: string): Promise<AccessTokenClaims | null>;

  /**
   * Returns the list of tenants the user has active memberships in.
   * Used to populate the workspace switcher on login when user belongs to multiple tenants.
   */
  listUserTenants(userId: string): Promise<TenantSummary[]>;
}

type TokenPair = {
  accessToken: string;    // JWT, TTL: 15 minutes
  refreshToken: string;   // opaque random token, TTL: 30 days
  expiresIn: number;      // seconds
};

type AccessTokenClaims = {
  sub: string;            // user_id
  tenantId: string;
  role: MembershipRole;
  email: string;
  impersonatedBy?: string; // platform_admin_id — present only on impersonation tokens
};
```

### 6.2 `ITenantService`

```typescript
interface ITenantService {
  /**
   * Creates a new tenant and assigns the given user as its owner.
   * Used for team workspace creation (not registration — registration uses IUserService).
   */
  create(params: CreateTenantParams): Promise<Tenant>;

  getById(tenantId: string): Promise<Tenant | null>;

  getBySlug(slug: string): Promise<Tenant | null>;

  /**
   * Updates display name, slug, or settings. Only callable by owner or admin.
   */
  update(tenantId: string, params: UpdateTenantParams): Promise<Tenant>;

  /**
   * Soft-deletes the tenant and all its memberships.
   * Product data (runs, selector cache) is archived, not deleted.
   * Only callable by owner.
   */
  delete(tenantId: string, requestingUserId: string): Promise<void>;

  /**
   * Returns current usage counters for billing display.
   */
  getUsage(tenantId: string): Promise<TenantUsage>;

  /**
   * Generates a new API key for the tenant. Returns the raw key once —
   * only the SHA-256 hash is stored. The caller is responsible for
   * displaying it to the user immediately.
   */
  rotateApiKey(tenantId: string, requestingUserId: string): Promise<string>;
}
```

### 6.3 `IUserService`

```typescript
interface IUserService {
  /**
   * Atomic registration: creates user + personal tenant + owner membership
   * in a single transaction. Sends email verification.
   * Throws if email already exists.
   */
  register(params: RegisterParams): Promise<{ user: User; personalTenant: Tenant }>;

  getById(userId: string): Promise<User | null>;

  /**
   * Updates profile fields. Email changes require re-verification.
   */
  updateProfile(userId: string, params: UpdateProfileParams): Promise<User>;

  /**
   * Changes password. Requires current password for verification.
   * Rotates all refresh tokens on success (forces re-login on all devices).
   */
  changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void>;

  /**
   * Sends a password reset link. Always returns void to prevent
   * email enumeration — the caller cannot distinguish known vs unknown emails.
   */
  requestPasswordReset(email: string): Promise<void>;

  resetPassword(token: string, newPassword: string): Promise<void>;

  verifyEmail(token: string): Promise<void>;

  /**
   * Soft-deletes the user. Revokes all sessions. Soft-deletes all memberships.
   * If the user is the sole owner of any tenant, this throws — ownership must
   * be transferred first (invariant I-4).
   */
  delete(userId: string): Promise<void>;
}

type RegisterParams = {
  email: string;
  password: string;
  displayName: string;
  personalTenantName?: string;  // defaults to "{displayName}'s workspace"
};
```

### 6.4 `IMembershipService`

```typescript
interface IMembershipService {
  /**
   * Returns all active memberships for a tenant, including pending invites.
   */
  listMembers(tenantId: string): Promise<MembershipDetail[]>;

  /**
   * Creates and sends an email invite. Throws if the email already holds
   * an active membership or a pending invite for this tenant.
   * Only callable by owner or admin (enforced at service layer).
   */
  invite(tenantId: string, invitedBy: string, params: InviteParams): Promise<Invite>;

  /**
   * Accepts an invite by token. Creates the membership row and marks
   * the invite as accepted. If the invitee has no account, registration
   * must happen first (the invite token is consumed as part of that flow).
   */
  acceptInvite(token: string, userId: string): Promise<Membership>;

  /**
   * Revokes a pending invite. The invite token becomes invalid immediately.
   */
  revokeInvite(inviteId: string, requestingUserId: string): Promise<void>;

  /**
   * Changes a member's role. Cannot be used to change the `owner` role —
   * use transferOwnership instead (invariant I-5).
   */
  changeRole(membershipId: string, newRole: MembershipRole, requestingUserId: string): Promise<Membership>;

  /**
   * Transfers ownership from the current owner to another existing member.
   * The current owner's role becomes `admin`. Atomic — both role changes happen
   * in one transaction.
   */
  transferOwnership(tenantId: string, newOwnerUserId: string, currentOwnerUserId: string): Promise<void>;

  /**
   * Removes a member from the tenant. Cannot remove the owner (invariant I-3).
   * A member can remove themselves (leave); an admin/owner can remove others.
   */
  removeMember(membershipId: string, requestingUserId: string): Promise<void>;
}

type MembershipRole = 'owner' | 'admin' | 'member' | 'viewer';
```

### 6.5 `IPlatformAdminService`

```typescript
interface IPlatformAdminService {
  listTenants(filters: TenantFilters, pagination: Pagination): Promise<PaginatedResult<TenantAdminView>>;

  getTenant(tenantId: string): Promise<TenantAdminView>;

  suspendTenant(tenantId: string, adminId: string, reason: string): Promise<void>;

  unsuspendTenant(tenantId: string, adminId: string): Promise<void>;

  overridePlan(tenantId: string, adminId: string, plan: string, limits: PlanLimits): Promise<void>;

  /**
   * Issues a time-limited (1 hour) impersonation JWT for the given user.
   * Every call is written to platform_audit_log — there is no silent impersonation.
   * The impersonation token carries the target user's tenant context.
   */
  impersonateUser(userId: string, adminId: string): Promise<string>;

  listAuditLog(filters: AuditLogFilters, pagination: Pagination): Promise<PaginatedResult<AuditLogEntry>>;
}
```

---

## 7. API Contracts

All routes are under `/api/v1`. Routes marked 🔒 require a valid access token. Routes marked 👑 require a platform admin token.

### Auth

| Method | Route | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Register + create personal tenant |
| POST | `/auth/login` | — | Login; returns token pair |
| POST | `/auth/refresh` | — | Rotate refresh token |
| POST | `/auth/logout` | 🔒 | Revoke current refresh token |
| POST | `/auth/logout-all` | 🔒 | Revoke all refresh tokens |
| GET  | `/auth/tenants` | 🔒 | List tenants the user belongs to (for workspace switcher) |
| POST | `/auth/password-reset/request` | — | Request reset email |
| POST | `/auth/password-reset/confirm` | — | Confirm reset with token |
| POST | `/auth/verify-email` | — | Confirm email with token |

### Users

| Method | Route | Auth | Description |
|---|---|---|---|
| GET    | `/users/me` | 🔒 | Get own profile |
| PATCH  | `/users/me` | 🔒 | Update display name, avatar |
| POST   | `/users/me/password` | 🔒 | Change password |
| DELETE | `/users/me` | 🔒 | Delete own account |

### Tenants

| Method | Route | Auth | Description |
|---|---|---|---|
| POST   | `/tenants` | 🔒 | Create a new team tenant |
| GET    | `/tenants/:tenantId` | 🔒 | Get tenant details |
| PATCH  | `/tenants/:tenantId` | 🔒 | Update name / slug / settings |
| DELETE | `/tenants/:tenantId` | 🔒 | Delete tenant (owner only) |
| GET    | `/tenants/:tenantId/usage` | 🔒 | Get usage stats |
| POST   | `/tenants/:tenantId/api-key` | 🔒 | Rotate API key |

### Memberships

| Method | Route | Auth | Description |
|---|---|---|---|
| GET    | `/tenants/:tenantId/members` | 🔒 | List members + pending invites |
| POST   | `/tenants/:tenantId/invites` | 🔒 | Send invite |
| DELETE | `/tenants/:tenantId/invites/:inviteId` | 🔒 | Revoke invite |
| POST   | `/invites/:token/accept` | 🔒 | Accept invite |
| PATCH  | `/tenants/:tenantId/members/:membershipId/role` | 🔒 | Change role |
| POST   | `/tenants/:tenantId/ownership` | 🔒 | Transfer ownership |
| DELETE | `/tenants/:tenantId/members/:membershipId` | 🔒 | Remove member / leave |

### Platform Admin

| Method | Route | Auth | Description |
|---|---|---|---|
| POST   | `/platform/auth/login` | — | Platform admin login |
| GET    | `/platform/tenants` | 👑 | List all tenants |
| GET    | `/platform/tenants/:tenantId` | 👑 | Get tenant detail |
| POST   | `/platform/tenants/:tenantId/suspend` | 👑 | Suspend tenant |
| POST   | `/platform/tenants/:tenantId/unsuspend` | 👑 | Unsuspend tenant |
| PATCH  | `/platform/tenants/:tenantId/plan` | 👑 | Override plan/limits |
| POST   | `/platform/users/:userId/impersonate` | 👑 | Issue impersonation token |
| GET    | `/platform/audit-log` | 👑 | Platform audit log |

---

## 8. Auth Flow

```
User submits email + password + tenantId
  → IAuthService.login()
    → Fetch user by email WHERE deleted_at IS NULL
    → Compare password against bcrypt hash
    → Fetch membership WHERE user_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
    → If tenant is suspended → reject with 403 TENANT_SUSPENDED
    → If membership.accepted_at IS NULL → reject with 403 INVITE_NOT_ACCEPTED
    → Issue access token (JWT, 15 min) with claims: { sub, tenantId, role, email }
    → Generate refresh token (random 32 bytes → hex), store SHA-256(token) in refresh_tokens
    → Return { accessToken, refreshToken, expiresIn }
```

```
Subsequent requests
  → Middleware reads Authorization: Bearer <accessToken>
  → IAuthService.verifyAccessToken() — pure JWT verification, no DB call
  → Attach { userId, tenantId, role } to request context
  → All downstream queries automatically receive tenantId from context
```

```
Token refresh
  → POST /auth/refresh with { refreshToken }
  → Compute SHA-256(refreshToken), look up in refresh_tokens
  → Verify not expired, not revoked
  → Revoke old token, insert new token (rotation)
  → Issue new access token + refresh token pair
```

---

## 9. Registration Flow

Registration is a single atomic transaction. There is no partial state.

```
POST /auth/register { email, password, displayName, personalTenantName? }

Transaction:
  1. Validate email not already in use
  2. Hash password (bcrypt, cost 12)
  3. INSERT users → userId
  4. Generate slug from displayName (e.g. "John Doe" → "john-doe", dedup with suffix if taken)
  5. INSERT tenants { slug, display_name: personalTenantName ?? "{displayName}'s Workspace", is_personal: true } → tenantId
  6. INSERT memberships { tenant_id, user_id, role: 'owner', accepted_at: now() }

On commit:
  → Send email verification link (async, outside transaction)
  → Issue token pair for (userId, tenantId, role: 'owner')
  → Return { user, tenant, accessToken, refreshToken }
```

The client receives a fully authenticated session immediately — email verification is required before certain sensitive operations (e.g. inviting others, changing billing) but does not block login.

---

## 10. Invite Flow

```
Admin invites email@example.com to tenant T with role 'member'

  → IMembershipService.invite()
    → Check email has no existing active membership in T
    → Check no pending invite already exists for (T, email)
    → Generate secure random token (32 bytes → hex)
    → INSERT invites { tenant_id, invited_by, email, role, token, expires_at: now() + 7 days }
    → Send invite email with link: /invites/{token}/accept

Recipient clicks link:
  → If not registered: redirect to /register?invite={token}
      → Registration flow runs, then automatically calls acceptInvite(token, userId)
  → If registered and logged in: POST /invites/{token}/accept
      → Verify token is valid, not expired, not revoked
      → INSERT memberships { tenant_id, user_id, role, accepted_at: now(), invited_by }
      → UPDATE invites SET accepted_at = now()
      → Return new membership + updated token pair for the new tenant context
```

---

## 11. JWT Contract

### Access Token Claims

```json
{
  "sub": "<user_id>",
  "tenantId": "<tenant_id>",
  "role": "member",
  "email": "user@example.com",
  "iat": 1712345678,
  "exp": 1712346578,
  "iss": "kaizen",
  "impersonatedBy": "<platform_admin_id>"  // only on impersonation tokens
}
```

### Signing

- Algorithm: `RS256` (asymmetric — public key can be distributed to workers without exposing the signing key)
- Key rotation: private key is rotated every 90 days; old public keys are retained for the duration of the maximum token TTL (15 min + grace period) to avoid rejecting valid in-flight tokens
- Workers verify tokens using the public key — no database call required per request

### API Key Auth

API keys (for CI/CD use) follow the same contract but with a different issuance path:

- `POST /tenants/:tenantId/api-key` generates a key with prefix `kz_live_`
- The raw key is returned once; only `SHA-256(key)` is stored
- Requests using an API key receive a synthetic token with `role: member` and the tenant's context
- API keys do not expire but can be rotated (old key is revoked on rotation)

---

## 12. Tenant Resolution

Every authenticated request has a `tenantId` injected into its context by the auth middleware. All product-layer queries receive this `tenantId` and must scope every SQL statement to it. There is no global query that operates across tenants.

```typescript
// Middleware attaches to every request
interface RequestContext {
  userId: string;
  tenantId: string;
  role: MembershipRole;
  isImpersonation: boolean;
}
```

The product layer never resolves tenant context itself — it only consumes what the auth middleware provides. This is a hard boundary: no module outside of `IAuthService` reads or interprets auth headers.

---

## 13. Row-Level Security

All product tables (`runs`, `test_suites`, `selector_cache`, `healing_events`, etc.) have a `tenant_id` column and a corresponding RLS policy. The application sets the runtime parameter `app.current_tenant_id` at connection checkout; Postgres enforces row-level isolation automatically as a second line of defense.

```sql
-- Applied to all product tables
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON runs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

The identity tables themselves (`users`, `tenants`, `memberships`) are not RLS-protected — they are accessed only through the identity service layer which enforces isolation in application code.

---

## 14. Security Considerations

| Concern | Mitigation |
|---|---|
| Password storage | bcrypt cost 12 minimum; never logged or returned in any API response |
| Email enumeration | `requestPasswordReset` always returns 200 regardless of whether email exists |
| Brute force login | Rate limit: 5 failed attempts per (email, IP) per 15 minutes → 429 |
| Token leakage | Refresh tokens stored as SHA-256 hash only; raw token never touches the DB |
| Invite token abuse | Tokens expire after 7 days; one-time use (accepted_at set on consumption) |
| Impersonation audit | Every impersonation action written to `platform_audit_log`; no silent access |
| Cross-tenant data access | RLS as DB-level enforcement; `tenantId` injected by auth middleware, never from request body |
| API key exposure | Raw key shown once at creation; only SHA-256 stored; rotation immediately revokes old key |
| Suspended tenant bypass | Suspension checked at login; existing tokens for suspended tenants are rejected at middleware |

---

## 15. Migration Plan

The existing codebase already uses `tenant_id` as a UUID foreign reference on all product tables. The identity spec formalises what that column points to.

### Steps

1. **Run migrations in order:**
   - `011_users.sql` — creates `users` table
   - `012_tenants.sql` — creates `tenants` table (replaces any existing stub)
   - `013_memberships.sql` — creates `memberships`, `invites`, `refresh_tokens`
   - `014_platform_admins.sql` — creates `platform_admins`, `platform_audit_log`
   - `015_fk_backfill.sql` — adds FK constraint `product_tables.tenant_id → tenants.id`

2. **Backfill:** If any existing tenants exist in a stub table, migrate them to the new `tenants` table and create an `owner` membership for the associated user.

3. **Add auth middleware** to all existing product routes — routes currently read `tenant_id` from request body or headers; after this migration they read it exclusively from the verified JWT claims.

4. **Remove `tenant_id` from all request bodies** — it must never be client-supplied after this migration.

### Constraint: Step 4 is a breaking change for any existing API consumers (CI/CD clients using hardcoded tenant IDs in request bodies). Issue a deprecation notice with one release cycle before enforcing.

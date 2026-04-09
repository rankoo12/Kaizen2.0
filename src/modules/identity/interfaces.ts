/**
 * Spec ref: docs/spec-identity.md §6 — Service Interfaces
 *
 * All interfaces in the identity domain. Implementations, routes, and tests
 * are derived from these contracts — never the other way around.
 */

// ─── Domain types ─────────────────────────────────────────────────────────────

export type MembershipRole = 'owner' | 'admin' | 'member' | 'viewer';

export type User = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type Tenant = {
  id: string;
  slug: string;
  displayName: string;
  plan: string;
  isPersonal: boolean;
  brainOptIn: boolean;
  suspendedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TenantSummary = {
  id: string;
  slug: string;
  displayName: string;
  isPersonal: boolean;
  role: MembershipRole;
};

export type Membership = {
  id: string;
  tenantId: string;
  userId: string;
  role: MembershipRole;
  invitedBy: string | null;
  acceptedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
};

export type MembershipDetail = Membership & {
  user: Pick<User, 'id' | 'email' | 'displayName' | 'avatarUrl'>;
};

export type Invite = {
  id: string;
  tenantId: string;
  invitedBy: string;
  email: string;
  role: MembershipRole;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export type TenantUsage = {
  runsThisMonth: number;
  llmTokensThisMonth: number;
  memberCount: number;
};

// ─── Auth types ───────────────────────────────────────────────────────────────

export type LoginResult = {
  /** Short-lived (5 min), single-use. Used only for issueToken(). */
  sessionToken: string;
  tenants: TenantSummary[];
};

export type TokenPair = {
  accessToken: string;   // JWT RS256, TTL 15 min
  refreshToken: string;  // opaque random token, TTL 30 days
  expiresIn: number;     // seconds
};

export type AccessTokenClaims = {
  sub: string;           // user_id
  tenantId: string;
  role: MembershipRole;
  email: string;
  impersonatedBy?: string; // platform_admin_id — only on impersonation tokens
};

// ─── Platform admin types ─────────────────────────────────────────────────────

export type PlatformAdmin = {
  id: string;
  email: string;
  displayName: string;
  createdAt: Date;
};

export type TenantAdminView = Tenant & {
  memberCount: number;
  ownerEmail: string;
};

export type AuditLogEntry = {
  id: string;
  adminId: string;
  action: string;
  targetType: string;
  targetId: string;
  impersonatedAs: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

export type Pagination = {
  page: number;
  limit: number;
};

export type PaginatedResult<T> = {
  items: T[];
  total: number;
  page: number;
  limit: number;
};

export type TenantFilters = {
  plan?: string;
  suspended?: boolean;
  search?: string;
};

export type AuditLogFilters = {
  adminId?: string;
  targetType?: string;
  targetId?: string;
};

// ─── 6.1 IAuthService ────────────────────────────────────────────────────────

export interface IAuthService {
  /**
   * Step 1 of login: validates credentials only.
   * Returns null on invalid credentials.
   * On success returns the user's tenant list and a short-lived session token.
   * If the user has exactly one tenant, the client should call issueToken() immediately.
   */
  login(email: string, password: string): Promise<LoginResult | null>;

  /**
   * Step 2 of login: exchanges session token + tenant selection for a full JWT pair.
   * Session token is single-use, expires after 5 minutes.
   * Returns null if session token invalid/expired or user has no membership in tenant.
   */
  issueToken(sessionToken: string, tenantId: string): Promise<TokenPair | null>;

  /**
   * Direct token issuance — used after registration where a session token is
   * not needed (user just created their account and personal tenant).
   */
  issueTokenDirect(userId: string, tenantId: string): Promise<TokenPair>;

  /**
   * Rotates the refresh token (old revoked, new issued).
   * Returns null if token is invalid, expired, or already revoked.
   */
  refresh(refreshToken: string): Promise<TokenPair | null>;

  /** Revokes a specific refresh token (logout from one device). */
  logout(refreshToken: string): Promise<void>;

  /** Revokes all refresh tokens for the user (logout from all devices). */
  logoutAll(userId: string): Promise<void>;

  /**
   * Verifies and decodes an access token.
   * Returns null if invalid or expired. Does NOT hit the database.
   */
  verifyAccessToken(token: string): Promise<AccessTokenClaims | null>;
}

// ─── 6.2 ITenantService ──────────────────────────────────────────────────────

export interface ITenantService {
  /**
   * Creates a new team tenant and assigns the given user as owner.
   * Does NOT create a personal tenant — use IUserService.register() for that.
   */
  create(params: CreateTenantParams): Promise<Tenant>;

  getById(tenantId: string): Promise<Tenant | null>;

  getBySlug(slug: string): Promise<Tenant | null>;

  update(tenantId: string, params: UpdateTenantParams): Promise<Tenant>;

  /**
   * Soft-deletes the tenant and all its memberships.
   * Throws SOLE_MEMBERLESS_USER if any member would be left with zero active memberships (I-10).
   * Only callable by the owner.
   */
  delete(tenantId: string, requestingUserId: string): Promise<void>;

  getUsage(tenantId: string): Promise<TenantUsage>;

  /**
   * Rotates the tenant API key. Returns the raw key once — only SHA-256 is stored.
   */
  rotateApiKey(tenantId: string, requestingUserId: string): Promise<string>;
}

export type CreateTenantParams = {
  displayName: string;
  slug?: string; // auto-generated from displayName if omitted
  ownerUserId: string;
  isPersonal?: boolean;
};

export type UpdateTenantParams = {
  displayName?: string;
  slug?: string;
  brainOptIn?: boolean;
};

// ─── 6.3 IUserService ────────────────────────────────────────────────────────

export interface IUserService {
  /**
   * Atomic registration: creates user + personal tenant + owner membership in
   * one transaction. Sends email verification (stubbed in v1).
   * Throws EMAIL_TAKEN if the email is already registered.
   */
  register(params: RegisterParams): Promise<{ user: User; personalTenant: Tenant }>;

  getById(userId: string): Promise<User | null>;

  updateProfile(userId: string, params: UpdateProfileParams): Promise<User>;

  /**
   * Changes password. Requires current password for verification.
   * Rotates all refresh tokens on success (forces re-login everywhere).
   */
  changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void>;

  /**
   * Always returns void to prevent email enumeration.
   */
  requestPasswordReset(email: string): Promise<void>;

  resetPassword(token: string, newPassword: string): Promise<void>;

  verifyEmail(token: string): Promise<void>;

  /**
   * Soft-deletes the user. Throws SOLE_OWNER if the user is the sole owner
   * of any tenant — ownership must be transferred first (invariant I-4).
   */
  delete(userId: string): Promise<void>;
}

export type RegisterParams = {
  email: string;
  password: string;
  displayName: string;
  personalTenantName?: string; // defaults to "{displayName}'s Workspace"
};

export type UpdateProfileParams = {
  displayName?: string;
  avatarUrl?: string | null;
};

// ─── 6.4 IMembershipService ──────────────────────────────────────────────────

export interface IMembershipService {
  /** Returns all active memberships for a tenant including pending invite details. */
  listMembers(tenantId: string): Promise<MembershipDetail[]>;

  listPendingInvites(tenantId: string): Promise<Invite[]>;

  /**
   * Creates and sends an invite email (stubbed in v1).
   * Throws ALREADY_MEMBER if the email already has an active membership.
   * Throws INVITE_EXISTS if a pending invite already exists for (tenant, email).
   */
  invite(tenantId: string, invitedBy: string, params: InviteParams): Promise<Invite>;

  /**
   * Accepts an invite by raw token. Creates the membership row.
   * Throws INVITE_NOT_FOUND / INVITE_EXPIRED / INVITE_REVOKED as appropriate.
   */
  acceptInvite(rawToken: string, userId: string): Promise<Membership>;

  /**
   * Revokes a pending invite. Token becomes invalid immediately.
   */
  revokeInvite(inviteId: string, requestingUserId: string): Promise<void>;

  /**
   * Changes a member's role.
   * Throws CANNOT_CHANGE_OWNER_ROLE if the target is an owner — use transferOwnership (I-5).
   */
  changeRole(membershipId: string, newRole: MembershipRole, requestingUserId: string): Promise<Membership>;

  /**
   * Transfers ownership atomically: current owner → admin, new owner → owner.
   * Both changes happen in one transaction (I-3).
   */
  transferOwnership(tenantId: string, newOwnerUserId: string, currentOwnerUserId: string): Promise<void>;

  /**
   * Removes a member from the tenant.
   * Throws CANNOT_REMOVE_OWNER if the target is the owner (I-3).
   * A member may remove themselves (leave); an admin/owner may remove others.
   */
  removeMember(membershipId: string, requestingUserId: string): Promise<void>;
}

export type InviteParams = {
  email: string;
  role: Exclude<MembershipRole, 'owner'>;
};

// ─── 6.5 IPlatformAdminService ───────────────────────────────────────────────

export interface IPlatformAdminService {
  /** Validates platform admin credentials. Returns null on failure. */
  login(email: string, password: string): Promise<string | null>; // returns signed JWT

  listTenants(filters: TenantFilters, pagination: Pagination): Promise<PaginatedResult<TenantAdminView>>;

  getTenant(tenantId: string): Promise<TenantAdminView | null>;

  suspendTenant(tenantId: string, adminId: string, reason: string): Promise<void>;

  unsuspendTenant(tenantId: string, adminId: string): Promise<void>;

  /** Updates the plan label. No limit enforcement in v1. */
  overridePlan(tenantId: string, adminId: string, plan: string): Promise<void>;

  /**
   * Issues a 1-hour impersonation JWT for the given user.
   * Every call is written to platform_audit_log — no silent access.
   */
  impersonateUser(userId: string, adminId: string): Promise<string>;

  listAuditLog(filters: AuditLogFilters, pagination: Pagination): Promise<PaginatedResult<AuditLogEntry>>;
}

// ─── IEmailService (stub) ─────────────────────────────────────────────────────

export interface IEmailService {
  sendEmailVerification(to: string, token: string): Promise<void>;
  sendPasswordReset(to: string, token: string): Promise<void>;
  sendInvite(to: string, tenantName: string, invitedBy: string, token: string, role: MembershipRole): Promise<void>;
}

// ─── Identity errors ─────────────────────────────────────────────────────────

export class IdentityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

export const IdentityErrors = {
  EMAIL_TAKEN:            () => new IdentityError('EMAIL_TAKEN', 'Email is already registered.', 409),
  SOLE_OWNER:             () => new IdentityError('SOLE_OWNER', 'Transfer ownership before leaving or deleting.', 409),
  SOLE_MEMBERLESS_USER:   (emails: string[]) => new IdentityError('SOLE_MEMBERLESS_USER', `These users would have no workspace: ${emails.join(', ')}`, 409),
  CANNOT_REMOVE_OWNER:    () => new IdentityError('CANNOT_REMOVE_OWNER', 'Transfer ownership before removing the owner.', 409),
  CANNOT_CHANGE_OWNER_ROLE: () => new IdentityError('CANNOT_CHANGE_OWNER_ROLE', 'Use transferOwnership to change the owner role.', 409),
  ALREADY_MEMBER:         () => new IdentityError('ALREADY_MEMBER', 'This user is already a member.', 409),
  INVITE_EXISTS:          () => new IdentityError('INVITE_EXISTS', 'A pending invite for this email already exists.', 409),
  INVITE_NOT_FOUND:       () => new IdentityError('INVITE_NOT_FOUND', 'Invite not found.', 404),
  INVITE_EXPIRED:         () => new IdentityError('INVITE_EXPIRED', 'This invite has expired.', 410),
  INVITE_REVOKED:         () => new IdentityError('INVITE_REVOKED', 'This invite has been revoked.', 410),
  TENANT_SUSPENDED:       () => new IdentityError('TENANT_SUSPENDED', 'This workspace has been suspended.', 403),
  INVALID_RESET_TOKEN:    () => new IdentityError('INVALID_RESET_TOKEN', 'Password reset token is invalid or expired.', 400),
  WRONG_PASSWORD:         () => new IdentityError('WRONG_PASSWORD', 'Current password is incorrect.', 400),
  NOT_FOUND:              (entity: string) => new IdentityError('NOT_FOUND', `${entity} not found.`, 404),
} as const;

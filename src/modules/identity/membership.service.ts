/**
 * Spec ref: docs/spec-identity.md §6.4 — IMembershipService, §10 — Invite Flow
 */

import { createHash, randomBytes } from 'crypto';
import { getPool } from '../../db/pool';
import type {
  IMembershipService,
  IEmailService,
  InviteParams,
  Invite,
  Membership,
  MembershipDetail,
  MembershipRole,
} from './interfaces';
import { IdentityErrors } from './interfaces';

const INVITE_TTL_DAYS = 7;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export class MembershipService implements IMembershipService {
  constructor(private readonly emailService: IEmailService) {}

  // ─── Read ──────────────────────────────────────────────────────────────────

  async listMembers(tenantId: string): Promise<MembershipDetail[]> {
    const { rows } = await getPool().query<{
      id: string; tenant_id: string; user_id: string; role: MembershipRole;
      invited_by: string | null; accepted_at: Date | null;
      deleted_at: Date | null; created_at: Date;
      u_id: string; u_email: string; u_display_name: string; u_avatar_url: string | null;
    }>(
      `SELECT m.id, m.tenant_id, m.user_id, m.role, m.invited_by, m.accepted_at,
              m.deleted_at, m.created_at,
              u.id AS u_id, u.email AS u_email,
              u.display_name AS u_display_name, u.avatar_url AS u_avatar_url
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id   = $1
         AND m.deleted_at  IS NULL
         AND m.accepted_at IS NOT NULL
         AND u.deleted_at  IS NULL
       ORDER BY m.created_at ASC`,
      [tenantId],
    );

    return rows.map((r) => ({
      id: r.id, tenantId: r.tenant_id, userId: r.user_id, role: r.role,
      invitedBy: r.invited_by, acceptedAt: r.accepted_at,
      deletedAt: r.deleted_at, createdAt: r.created_at,
      user: { id: r.u_id, email: r.u_email, displayName: r.u_display_name, avatarUrl: r.u_avatar_url },
    }));
  }

  async listPendingInvites(tenantId: string): Promise<Invite[]> {
    const { rows } = await getPool().query(
      `SELECT id, tenant_id, invited_by, email, role, expires_at, accepted_at, revoked_at, created_at
       FROM invites
       WHERE tenant_id    = $1
         AND accepted_at  IS NULL
         AND revoked_at   IS NULL
         AND expires_at   > now()
       ORDER BY created_at DESC`,
      [tenantId],
    );
    return rows.map(this.mapInvite);
  }

  // ─── Invite ────────────────────────────────────────────────────────────────

  async invite(tenantId: string, invitedBy: string, params: InviteParams): Promise<Invite> {
    const email = params.email.toLowerCase().trim();

    // Check no active membership already exists for this email
    const { rows: existing } = await getPool().query(
      `SELECT 1 FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id   = $1
         AND u.email       = $2
         AND m.deleted_at  IS NULL`,
      [tenantId, email],
    );
    if (existing.length > 0) throw IdentityErrors.ALREADY_MEMBER();

    // Check no pending invite exists
    const { rows: pendingInvite } = await getPool().query(
      `SELECT 1 FROM invites
       WHERE tenant_id  = $1
         AND email      = $2
         AND accepted_at IS NULL
         AND revoked_at  IS NULL
         AND expires_at  > now()`,
      [tenantId, email],
    );
    if (pendingInvite.length > 0) throw IdentityErrors.INVITE_EXISTS();

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);

    const { rows } = await getPool().query(
      `INSERT INTO invites (tenant_id, invited_by, email, role, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, email) DO UPDATE
         SET token_hash = EXCLUDED.token_hash,
             role       = EXCLUDED.role,
             expires_at = EXCLUDED.expires_at,
             revoked_at = NULL,
             accepted_at = NULL,
             created_at = now()
       RETURNING id, tenant_id, invited_by, email, role, expires_at, accepted_at, revoked_at, created_at`,
      [tenantId, invitedBy, email, params.role, tokenHash, expiresAt],
    );

    // Fetch tenant display_name for the email (fire-and-forget)
    const { rows: tenantRows } = await getPool().query<{ display_name: string }>(
      `SELECT display_name FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const { rows: inviterRows } = await getPool().query<{ display_name: string }>(
      `SELECT display_name FROM users WHERE id = $1`,
      [invitedBy],
    );

    void this.emailService
      .sendInvite(
        email,
        tenantRows[0]?.display_name ?? '',
        inviterRows[0]?.display_name ?? '',
        rawToken,
        params.role,
      )
      .catch(() => {});

    return this.mapInvite(rows[0]);
  }

  async acceptInvite(rawToken: string, userId: string): Promise<Membership> {
    const tokenHash = hashToken(rawToken);

    const { rows } = await getPool().query<{
      id: string; tenant_id: string; email: string; role: MembershipRole;
      expires_at: Date; accepted_at: Date | null; revoked_at: Date | null;
    }>(
      `SELECT id, tenant_id, email, role, expires_at, accepted_at, revoked_at
       FROM invites WHERE token_hash = $1`,
      [tokenHash],
    );

    if (rows.length === 0) throw IdentityErrors.INVITE_NOT_FOUND();
    const invite = rows[0];
    if (invite.revoked_at) throw IdentityErrors.INVITE_REVOKED();
    if (invite.expires_at < new Date()) throw IdentityErrors.INVITE_EXPIRED();
    if (invite.accepted_at) throw IdentityErrors.INVITE_NOT_FOUND(); // already consumed

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');

      // Mark invite accepted
      await client.query(
        `UPDATE invites SET accepted_at = now() WHERE id = $1`,
        [invite.id],
      );

      // Create membership (upsert in case of a re-invite after soft-delete)
      const { rows: memberRows } = await client.query<{
        id: string; tenant_id: string; user_id: string; role: MembershipRole;
        invited_by: string | null; accepted_at: Date | null;
        deleted_at: Date | null; created_at: Date;
      }>(
        `INSERT INTO memberships (tenant_id, user_id, role, accepted_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (tenant_id, user_id) DO UPDATE
           SET role = EXCLUDED.role, accepted_at = now(), deleted_at = NULL, updated_at = now()
         RETURNING id, tenant_id, user_id, role, invited_by, accepted_at, deleted_at, created_at`,
        [invite.tenant_id, userId, invite.role],
      );

      await client.query('COMMIT');
      return this.mapMembership(memberRows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async revokeInvite(inviteId: string, requestingUserId: string): Promise<void> {
    // Caller must be admin/owner of the tenant
    const { rows } = await getPool().query(
      `SELECT i.tenant_id FROM invites i
       JOIN memberships m ON m.tenant_id = i.tenant_id
         AND m.user_id = $2 AND m.role IN ('owner', 'admin') AND m.deleted_at IS NULL
       WHERE i.id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL`,
      [inviteId, requestingUserId],
    );
    if (rows.length === 0) throw IdentityErrors.INVITE_NOT_FOUND();

    await getPool().query(
      `UPDATE invites SET revoked_at = now() WHERE id = $1`,
      [inviteId],
    );
  }

  // ─── Role management ───────────────────────────────────────────────────────

  async changeRole(
    membershipId: string,
    newRole: MembershipRole,
    requestingUserId: string,
  ): Promise<Membership> {
    const { rows } = await getPool().query<{
      id: string; tenant_id: string; user_id: string; role: MembershipRole;
      invited_by: string | null; accepted_at: Date | null;
      deleted_at: Date | null; created_at: Date;
    }>(
      `SELECT id, tenant_id, user_id, role, invited_by, accepted_at, deleted_at, created_at
       FROM memberships WHERE id = $1 AND deleted_at IS NULL`,
      [membershipId],
    );
    if (rows.length === 0) throw IdentityErrors.NOT_FOUND('Membership');
    const target = rows[0];

    // I-5: cannot change the owner role via changeRole
    if (target.role === 'owner') throw IdentityErrors.CANNOT_CHANGE_OWNER_ROLE();
    if (newRole === 'owner') throw IdentityErrors.CANNOT_CHANGE_OWNER_ROLE();

    // Caller must be owner or admin of the tenant
    await this.assertCallerCanManage(target.tenant_id, requestingUserId);

    const { rows: updated } = await getPool().query<{
      id: string; tenant_id: string; user_id: string; role: MembershipRole;
      invited_by: string | null; accepted_at: Date | null;
      deleted_at: Date | null; created_at: Date;
    }>(
      `UPDATE memberships SET role = $1, updated_at = now()
       WHERE id = $2
       RETURNING id, tenant_id, user_id, role, invited_by, accepted_at, deleted_at, created_at`,
      [newRole, membershipId],
    );
    return this.mapMembership(updated[0]);
  }

  async transferOwnership(
    tenantId: string,
    newOwnerUserId: string,
    currentOwnerUserId: string,
  ): Promise<void> {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');

      // Verify current owner
      const { rows: ownerRows } = await client.query(
        `SELECT id FROM memberships
         WHERE tenant_id = $1 AND user_id = $2 AND role = 'owner' AND deleted_at IS NULL`,
        [tenantId, currentOwnerUserId],
      );
      if (ownerRows.length === 0) throw IdentityErrors.NOT_FOUND('Owner membership');

      // Verify new owner has an active membership
      const { rows: newOwnerRows } = await client.query(
        `SELECT id FROM memberships
         WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NULL AND accepted_at IS NOT NULL`,
        [tenantId, newOwnerUserId],
      );
      if (newOwnerRows.length === 0) throw IdentityErrors.NOT_FOUND('New owner membership');

      // Demote current owner → admin
      await client.query(
        `UPDATE memberships SET role = 'admin', updated_at = now()
         WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, currentOwnerUserId],
      );

      // Promote new owner
      await client.query(
        `UPDATE memberships SET role = 'owner', updated_at = now()
         WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, newOwnerUserId],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async removeMember(membershipId: string, requestingUserId: string): Promise<void> {
    const { rows } = await getPool().query<{
      tenant_id: string; user_id: string; role: MembershipRole;
    }>(
      `SELECT tenant_id, user_id, role FROM memberships
       WHERE id = $1 AND deleted_at IS NULL`,
      [membershipId],
    );
    if (rows.length === 0) throw IdentityErrors.NOT_FOUND('Membership');
    const target = rows[0];

    // I-3: cannot remove the owner
    if (target.role === 'owner') throw IdentityErrors.CANNOT_REMOVE_OWNER();

    // Self-removal always allowed; otherwise caller must be owner/admin
    if (target.user_id !== requestingUserId) {
      await this.assertCallerCanManage(target.tenant_id, requestingUserId);
    }

    await getPool().query(
      `UPDATE memberships SET deleted_at = now(), updated_at = now() WHERE id = $1`,
      [membershipId],
    );
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async assertCallerCanManage(tenantId: string, callerUserId: string): Promise<void> {
    const { rows } = await getPool().query(
      `SELECT 1 FROM memberships
       WHERE tenant_id = $1 AND user_id = $2
         AND role IN ('owner', 'admin') AND deleted_at IS NULL`,
      [tenantId, callerUserId],
    );
    if (rows.length === 0) throw IdentityErrors.NOT_FOUND('Membership');
  }

  private mapMembership(row: {
    id: string; tenant_id: string; user_id: string; role: MembershipRole;
    invited_by: string | null; accepted_at: Date | null;
    deleted_at: Date | null; created_at: Date;
  }): Membership {
    return {
      id: row.id, tenantId: row.tenant_id, userId: row.user_id, role: row.role,
      invitedBy: row.invited_by, acceptedAt: row.accepted_at,
      deletedAt: row.deleted_at, createdAt: row.created_at,
    };
  }

  private mapInvite(row: {
    id: string; tenant_id: string; invited_by: string; email: string; role: string;
    expires_at: Date; accepted_at: Date | null; revoked_at: Date | null; created_at: Date;
  }): Invite {
    return {
      id: row.id, tenantId: row.tenant_id, invitedBy: row.invited_by,
      email: row.email, role: row.role as MembershipRole,
      expiresAt: row.expires_at, acceptedAt: row.accepted_at,
      revokedAt: row.revoked_at, createdAt: row.created_at,
    };
  }
}

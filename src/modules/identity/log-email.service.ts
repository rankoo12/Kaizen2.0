/**
 * Log-only email service stub for v1.
 * Replace with a real transport (Resend, SES, etc.) in v2.
 *
 * Spec ref: docs/spec-identity.md — IEmailService (stub note in §9, §10)
 */

import type { IEmailService, MembershipRole } from './interfaces';

export class LogEmailService implements IEmailService {
  async sendEmailVerification(to: string, token: string): Promise<void> {
    console.info(JSON.stringify({
      event: 'email.verify',
      to,
      link: `/auth/verify-email?token=${token}`,
    }));
  }

  async sendPasswordReset(to: string, token: string): Promise<void> {
    console.info(JSON.stringify({
      event: 'email.password_reset',
      to,
      link: `/auth/password-reset/confirm?token=${token}`,
    }));
  }

  async sendInvite(
    to: string,
    tenantName: string,
    invitedBy: string,
    token: string,
    role: MembershipRole,
  ): Promise<void> {
    console.info(JSON.stringify({
      event: 'email.invite',
      to,
      tenantName,
      invitedBy,
      role,
      link: `/invites/${token}/accept`,
    }));
  }
}

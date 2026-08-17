/**
 * Reads the tenant and role the API already stamped into the access token.
 *
 * The token is not verified here, and must never be trusted as a gate: the API
 * validated it before issuing it, and re-checks it on every request. What the
 * browser does with these claims is presentation only — greying out a control
 * the caller cannot use, so they meet an explanation instead of a 403. Every
 * rule they influence is enforced server-side.
 *
 * Extracted because the same base64url decode was written three times across
 * the session routes, and a fourth copy was about to be added for `role`.
 */
export type SessionClaims = {
  tenantId: string | null;
  role: string | null;
};

const EMPTY: SessionClaims = { tenantId: null, role: null };

export function claimsFromAccessToken(accessToken: string | undefined): SessionClaims {
  if (!accessToken) return EMPTY;
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'),
    );
    return {
      tenantId: typeof payload.tenantId === 'string' ? payload.tenantId : null,
      role: typeof payload.role === 'string' ? payload.role : null,
    };
  } catch {
    // A malformed token is the API's problem, not a reason to fail the page.
    // The caller renders as if it knew nothing, which is the safe reading.
    return EMPTY;
  }
}

/**
 * Tests: interfaces.ts — IdentityError & IdentityErrors factory
 * Spec ref: docs/spec-identity.md §6 — error codes used throughout services
 */

import { IdentityError, IdentityErrors } from '../interfaces';

describe('IdentityError', () => {
  it('is an instance of Error', () => {
    const err = new IdentityError('SOME_CODE', 'some message');
    expect(err).toBeInstanceOf(Error);
  });

  it('exposes code, message, and statusCode', () => {
    const err = new IdentityError('EMAIL_TAKEN', 'Email taken.', 409);
    expect(err.code).toBe('EMAIL_TAKEN');
    expect(err.message).toBe('Email taken.');
    expect(err.statusCode).toBe(409);
    expect(err.name).toBe('IdentityError');
  });

  it('defaults statusCode to 400', () => {
    const err = new IdentityError('X', 'msg');
    expect(err.statusCode).toBe(400);
  });
});

describe('IdentityErrors factories', () => {
  const cases: Array<[keyof typeof IdentityErrors, unknown[], string, number]> = [
    ['EMAIL_TAKEN',            [],               'EMAIL_TAKEN',            409],
    ['SOLE_OWNER',             [],               'SOLE_OWNER',             409],
    ['SOLE_MEMBERLESS_USER',   [['a@b.com']],    'SOLE_MEMBERLESS_USER',   409],
    ['CANNOT_REMOVE_OWNER',    [],               'CANNOT_REMOVE_OWNER',    409],
    ['CANNOT_CHANGE_OWNER_ROLE', [],             'CANNOT_CHANGE_OWNER_ROLE', 409],
    ['ALREADY_MEMBER',         [],               'ALREADY_MEMBER',         409],
    ['INVITE_EXISTS',          [],               'INVITE_EXISTS',          409],
    ['INVITE_NOT_FOUND',       [],               'INVITE_NOT_FOUND',       404],
    ['INVITE_EXPIRED',         [],               'INVITE_EXPIRED',         410],
    ['INVITE_REVOKED',         [],               'INVITE_REVOKED',         410],
    ['TENANT_SUSPENDED',       [],               'TENANT_SUSPENDED',       403],
    ['INVALID_RESET_TOKEN',    [],               'INVALID_RESET_TOKEN',    400],
    ['WRONG_PASSWORD',         [],               'WRONG_PASSWORD',         400],
    ['NOT_FOUND',              ['User'],         'NOT_FOUND',              404],
  ];

  test.each(cases)('%s → correct code & statusCode', (factoryKey, args, code, status) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = (IdentityErrors[factoryKey] as any)(...args);
    expect(err).toBeInstanceOf(IdentityError);
    expect(err.code).toBe(code);
    expect(err.statusCode).toBe(status);
  });

  it('SOLE_MEMBERLESS_USER includes affected emails in message', () => {
    const err = IdentityErrors.SOLE_MEMBERLESS_USER(['a@x.com', 'b@x.com']);
    expect(err.message).toContain('a@x.com');
    expect(err.message).toContain('b@x.com');
  });

  it('NOT_FOUND includes entity name in message', () => {
    const err = IdentityErrors.NOT_FOUND('Tenant');
    expect(err.message).toContain('Tenant');
  });
});

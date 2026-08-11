import { blockedDestinationReason, privateTargetsAllowed } from '../recon/destination-guard';

/**
 * SSRF boundary — spec-authenticated-scope.md §3.1.
 *
 * Kaizen fetches customer-chosen URLs from inside our network and returns what
 * it saw. Found by the P3 dogfood, which also showed the check had been missing
 * from the analyze TARGET entirely, so the public crawler carried the same
 * exposure from P1 onward.
 */

const ORIGINAL = process.env.KAIZEN_ALLOW_PRIVATE_TARGETS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.KAIZEN_ALLOW_PRIVATE_TARGETS;
  else process.env.KAIZEN_ALLOW_PRIVATE_TARGETS = ORIGINAL;
});

describe('blockedDestinationReason — hosted default (private targets denied)', () => {
  beforeEach(() => { delete process.env.KAIZEN_ALLOW_PRIVATE_TARGETS; });

  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'link-local / cloud metadata'],
    ['http://127.0.0.1:6379/', 'loopback'],
    ['http://localhost:3001/', 'loopback'],
    ['http://10.0.0.5/admin', 'private network'],
    ['http://172.16.0.9/', 'private network'],
    ['http://192.168.1.1/', 'private network'],
    ['http://redis.internal/', 'internal hostname'],
    ['http://printer.local/', 'internal hostname'],
    ['http://[::1]:5432/', 'IPv6 loopback'],
    ['http://[fd00::1]/', 'private network'],
    ['http://0.0.0.0/', 'unspecified address'],
  ])('refuses %s', (url, reason) => {
    expect(blockedDestinationReason(url)).toBe(reason);
  });

  it.each([
    'https://app.example.com/login',
    'http://shop.test/products',
    'https://sub.domain.co.uk/a/b?c=d',
  ])('allows the ordinary public URL %s', (url) => {
    expect(blockedDestinationReason(url)).toBeNull();
  });

  it('refuses non-http schemes outright', () => {
    expect(blockedDestinationReason('file:///etc/passwd')).toMatch(/unsupported scheme/);
    expect(blockedDestinationReason('gopher://evil/')).toMatch(/unsupported scheme/);
  });

  it('refuses an unparseable URL rather than passing it through', () => {
    expect(blockedDestinationReason('not a url')).toBe('unparseable URL');
  });

  it('resolves a relative target against its base before judging it', () => {
    expect(blockedDestinationReason('/login', 'http://127.0.0.1:3001/')).toBe('loopback');
    expect(blockedDestinationReason('/login', 'https://app.example.com/')).toBeNull();
  });
});

describe('blockedDestinationReason — self-hosted / local opt-in', () => {
  // Kaizen is developed against localhost:3001 and self-hosted on private
  // networks; a blanket ban makes those deployments untestable. The opt-in is
  // explicit so a hosted deployment simply never sets it.
  beforeEach(() => { process.env.KAIZEN_ALLOW_PRIVATE_TARGETS = '1'; });

  it.each([
    'http://localhost:3001/',
    'http://127.0.0.1:3000/health',
    'http://192.168.1.50:8080/',
  ])('allows %s when the deployment opts in', (url) => {
    expect(blockedDestinationReason(url)).toBeNull();
  });

  it('still refuses non-http schemes — the opt-in is about ADDRESSES, not protocols', () => {
    expect(blockedDestinationReason('file:///etc/passwd')).toMatch(/unsupported scheme/);
  });
});

describe('privateTargetsAllowed', () => {
  it.each(['1', 'true', 'yes', 'TRUE'])('reads %s as enabled', (v) => {
    process.env.KAIZEN_ALLOW_PRIVATE_TARGETS = v;
    expect(privateTargetsAllowed()).toBe(true);
  });

  it.each(['0', 'false', 'off', ''])('reads %s as disabled', (v) => {
    process.env.KAIZEN_ALLOW_PRIVATE_TARGETS = v;
    expect(privateTargetsAllowed()).toBe(false);
  });

  it('defaults to disabled when unset — hosted safety is the default', () => {
    delete process.env.KAIZEN_ALLOW_PRIVATE_TARGETS;
    expect(privateTargetsAllowed()).toBe(false);
  });
});

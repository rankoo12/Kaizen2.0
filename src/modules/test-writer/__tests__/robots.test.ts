import { parseRobots, isAllowed, ALLOW_ALL } from '../recon/robots';

describe('parseRobots', () => {
  it('reads Disallow/Allow rules from the * group only', () => {
    const rules = parseRobots([
      'User-agent: Googlebot',
      'Disallow: /google-only',
      '',
      'User-agent: *',
      'Disallow: /admin',
      'Allow: /admin/public',
      '',
      'User-agent: OtherBot',
      'Disallow: /',
    ].join('\n'));
    expect(rules.disallows).toEqual(['/admin']);
    expect(rules.allows).toEqual(['/admin/public']);
  });

  it('handles a multi-agent group that includes *', () => {
    const rules = parseRobots([
      'User-agent: SomeBot',
      'User-agent: *',
      'Disallow: /private',
    ].join('\n'));
    expect(rules.disallows).toEqual(['/private']);
  });

  it('ignores comments and blank lines', () => {
    const rules = parseRobots('User-agent: * # everyone\n# note\nDisallow: /tmp # scratch\n');
    expect(rules.disallows).toEqual(['/tmp']);
  });
});

describe('isAllowed', () => {
  const rules = { allows: ['/admin/public'], disallows: ['/admin', '/checkout'] };

  it('blocks disallowed prefixes', () => {
    expect(isAllowed(rules, '/admin/users')).toBe(false);
    expect(isAllowed(rules, '/checkout/step-2')).toBe(false);
  });

  it('longer Allow beats shorter Disallow', () => {
    expect(isAllowed(rules, '/admin/public/docs')).toBe(true);
  });

  it('allows everything else', () => {
    expect(isAllowed(rules, '/products')).toBe(true);
    expect(isAllowed(ALLOW_ALL, '/anything')).toBe(true);
  });

  it('respects a full Disallow: /', () => {
    expect(isAllowed({ allows: [], disallows: ['/'] }, '/any/page')).toBe(false);
  });
});

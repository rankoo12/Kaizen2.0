import { ValidationRunner } from '../validate/validation-runner';
import type { StepAST } from '../../../types';
import type { IObservability } from '../../observability/interfaces';

/**
 * Spec: spec-validation-trust.md §5 (amended 2026-08-18) — the executed
 * sign-in proof. The recipe's terminal assertion is run signed out; failing
 * there is what makes every green proving run evidence of a session.
 */

jest.mock('../../../db/transaction', () => ({
  tenantPool: jest.fn(() => ({ query: jest.fn(async () => ({ rows: [{ id: 'probe-run' }] })) })),
  tenantQuery: jest.fn(async () => ({ rows: [] })),
  withTenantTransaction: jest.fn(),
}));
jest.mock('../../../db/case-writer', () => ({ createCase: jest.fn() }));

const obs = {
  log: jest.fn(), increment: jest.fn(), histogram: jest.fn(), gauge: jest.fn(),
} as unknown as IObservability;

const ast = (action: StepAST['action'], extra: Partial<StepAST> = {}): StepAST => ({
  action, targetDescription: null, value: null, url: null, rawText: action,
  contentHash: 'c', targetHash: 't', ...extra,
});

const prefix = [
  { rawText: 'navigate to https://www.saucedemo.com/', ast: ast('navigate', { url: 'https://www.saucedemo.com/' }) },
  { rawText: 'type "{{email}}" in the username field', ast: ast('type', { value: '{{email}}', targetDescription: 'the username field' }) },
  { rawText: 'click the "Login" button', ast: ast('click', { targetDescription: 'the "Login" button' }) },
  { rawText: 'verify the url contains "inventory"', ast: ast('assert_url', { value: 'inventory' }) },
];

function runnerWith(probeStatus: string) {
  const add = jest.fn(async (_name: string, _payload: unknown) => undefined);
  const runner = new ValidationRunner({ add } as never, obs);
  jest.spyOn(runner as never, 'pollToTerminal').mockResolvedValue(probeStatus as never);
  return { runner, add };
}

describe('probeSigninAssertionIsPrivate', () => {
  it('runs only the navigate steps + terminal assertion, signed out, and reads a FAIL as private', async () => {
    const { runner, add } = runnerWith('failed');
    const out = await (runner as never as { probeSigninAssertionIsPrivate: (p: unknown, pre: unknown) => Promise<string> })
      .probeSigninAssertionIsPrivate({ tenantId: 't1', suiteId: 's1', baseUrl: 'https://www.saucedemo.com/' }, prefix);
    expect(out).toBe('private');
    const payload = add.mock.calls[0][1] as unknown as { compiledSteps: StepAST[]; behindAuth: boolean };
    expect(payload.compiledSteps.map((s) => s.action)).toEqual(['navigate', 'assert_url']); // no credentials
    expect(payload.behindAuth).toBe(false);
  });

  it('reads a PASS signed out as public — the assertion proves nothing about a session', async () => {
    const { runner } = runnerWith('passed');
    const out = await (runner as never as { probeSigninAssertionIsPrivate: (p: unknown, pre: unknown) => Promise<string> })
      .probeSigninAssertionIsPrivate({ tenantId: 't1', suiteId: 's1', baseUrl: 'x' }, prefix);
    expect(out).toBe('public');
  });

  it('is inconclusive when the recipe has no terminal assertion, or the run never finishes', async () => {
    const noAssert = prefix.slice(0, 3);
    const a = runnerWith('failed');
    expect(await (a.runner as never as { probeSigninAssertionIsPrivate: (p: unknown, pre: unknown) => Promise<string> })
      .probeSigninAssertionIsPrivate({ tenantId: 't1', suiteId: 's1', baseUrl: 'x' }, noAssert)).toBe('inconclusive');
    const b = runnerWith('timeout');
    expect(await (b.runner as never as { probeSigninAssertionIsPrivate: (p: unknown, pre: unknown) => Promise<string> })
      .probeSigninAssertionIsPrivate({ tenantId: 't1', suiteId: 's1', baseUrl: 'x' }, prefix)).toBe('inconclusive');
  });
});

import { createRunContext, interpolate, interpolateStep } from '../run-context';
import type { RunContext, StepAST } from '../../types';

const makeStep = (over: Partial<StepAST> = {}): StepAST => ({
  action: 'assert_text',
  targetDescription: null,
  value: null,
  url: null,
  rawText: 'raw',
  contentHash: 'c',
  targetHash: 't',
  ...over,
});

describe('createRunContext', () => {
  it('starts with an empty variable map', () => {
    expect(createRunContext()).toEqual({ variables: {} });
  });
});

describe('interpolate', () => {
  const ctx: RunContext = { variables: { selectedItem: 'Blue Widget', count: '3' } };

  it('returns null and empty strings untouched', () => {
    expect(interpolate(null, ctx)).toBeNull();
    expect(interpolate('', ctx)).toBe('');
  });

  it('substitutes a known variable', () => {
    expect(interpolate('{{selectedItem}}', ctx)).toBe('Blue Widget');
  });

  it('substitutes within surrounding text and tolerates inner whitespace', () => {
    expect(interpolate('cart shows {{ selectedItem }} x{{count}}', ctx)).toBe('cart shows Blue Widget x3');
  });

  it('passes unknown variables through literally so assertions fail loudly', () => {
    expect(interpolate('{{missing}}', ctx)).toBe('{{missing}}');
  });

  it('replaces multiple occurrences of the same variable', () => {
    expect(interpolate('{{count}}-{{count}}', ctx)).toBe('3-3');
  });
});

describe('interpolateStep', () => {
  const ctx: RunContext = { variables: { selectedItem: 'Blue Widget' } };

  it('resolves tokens in value and targetDescription', () => {
    const step = makeStep({ value: '{{selectedItem}}', targetDescription: 'name of {{selectedItem}}' });
    const out = interpolateStep(step, ctx);
    expect(out.value).toBe('Blue Widget');
    expect(out.targetDescription).toBe('name of Blue Widget');
  });

  it('returns the same reference when no tokens are present (no needless copy)', () => {
    const step = makeStep({ value: 'static', targetDescription: 'header' });
    expect(interpolateStep(step, ctx)).toBe(step);
  });

  it('leaves other fields untouched', () => {
    const step = makeStep({ value: '{{selectedItem}}', action: 'assert_text', captureAs: 'x' });
    const out = interpolateStep(step, ctx);
    expect(out.action).toBe('assert_text');
    expect(out.captureAs).toBe('x');
    expect(out.contentHash).toBe(step.contentHash);
  });
});

import {
  classifyErrorSignal,
  classifyDOMSignal,
  classifyScreenshotSignal,
  classify,
} from '../failure-classifier';
import type { AXNode } from '../../../types';

// ─── Signal A ─────────────────────────────────────────────────────────────────

describe('classifyErrorSignal', () => {
  it('classifies TimeoutError', () => {
    expect(classifyErrorSignal(new Error('Timeout exceeded'))).toBe('TimeoutError');
  });

  it('classifies NavigationError', () => {
    expect(classifyErrorSignal(new Error('Navigation failed'))).toBe('NavigationError');
  });

  it('classifies AssertionError', () => {
    const e = new Error('Expected value'); e.name = 'AssertionError';
    expect(classifyErrorSignal(e)).toBe('AssertionError');
  });

  it('classifies ElementNotFoundError', () => {
    expect(classifyErrorSignal(new Error('waiting for locator to be visible'))).toBe('ElementNotFoundError');
  });

  it('classifies StaleElementError', () => {
    expect(classifyErrorSignal(new Error('element is detached from the DOM'))).toBe('StaleElementError');
  });

  it('returns Unknown for unrecognised errors', () => {
    expect(classifyErrorSignal(new Error('something weird happened'))).toBe('Unknown');
  });
});

// ─── Signal B ─────────────────────────────────────────────────────────────────

describe('classifyDOMSignal', () => {
  const leaf = (name: string): AXNode => ({ role: 'button', name });

  it('returns SparsePage when axAfter is null', () => {
    expect(classifyDOMSignal(null, null, 'button')).toBe('SparsePage');
  });

  it('returns SparsePage when fewer than 5 nodes', () => {
    const sparse: AXNode = { role: 'root', children: [leaf('a'), leaf('b')] };
    expect(classifyDOMSignal(null, sparse, 'button')).toBe('SparsePage');
  });

  it('returns SelectorGone when aria-label target not in after tree', () => {
    const after: AXNode = {
      role: 'root',
      children: [leaf('a'), leaf('b'), leaf('c'), leaf('d'), leaf('e')],
    };
    const sel = '[aria-label="Submit"]';
    expect(classifyDOMSignal(null, after, sel)).toBe('SelectorGone');
  });

  it('returns SelectorPresent when no significant change', () => {
    const tree: AXNode = {
      role: 'root',
      children: [leaf('a'), leaf('b'), leaf('c'), leaf('d'), leaf('e')],
    };
    expect(classifyDOMSignal(tree, tree, '#some-id')).toBe('SelectorPresent');
  });
});

// ─── Signal C ─────────────────────────────────────────────────────────────────

describe('classifyScreenshotSignal', () => {
  it('returns Unavailable when either buffer is null', () => {
    expect(classifyScreenshotSignal(null, null)).toBe('Unavailable');
    expect(classifyScreenshotSignal(Buffer.from('x'), null)).toBe('Unavailable');
  });

  it('returns Unavailable when buffers are not valid PNGs', () => {
    expect(classifyScreenshotSignal(Buffer.from('not-png'), Buffer.from('not-png'))).toBe('Unavailable');
  });
});

// ─── Decision table ───────────────────────────────────────────────────────────

describe('classify (decision table)', () => {
  const richTree = (): AXNode => ({
    role: 'root',
    children: Array.from({ length: 10 }, (_, i) => ({ role: 'button', name: `btn-${i}` })),
  });

  it('returns LOGIC_FAILURE for AssertionError regardless of DOM', () => {
    const e = new Error('assert'); e.name = 'AssertionError';
    expect(classify(e, richTree(), richTree(), '', null, null)).toBe('LOGIC_FAILURE');
  });

  it('returns PAGE_NOT_LOADED for null axAfter', () => {
    expect(classify(new Error('timeout'), richTree(), null, '', null, null)).toBe('PAGE_NOT_LOADED');
  });

  it('returns PAGE_NOT_LOADED for NavigationError', () => {
    expect(classify(new Error('Navigation failed'), richTree(), richTree(), '', null, null)).toBe('PAGE_NOT_LOADED');
  });

  it('returns TIMING for selector-present + unavailable screenshot', () => {
    const tree = richTree();
    expect(classify(new Error('timeout'), tree, tree, '#unknown', null, null)).toBe('TIMING');
  });
});

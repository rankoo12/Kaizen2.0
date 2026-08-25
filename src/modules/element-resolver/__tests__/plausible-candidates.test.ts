import { plausibleCandidates } from '../llm.element-resolver';
import type { CandidateNode } from '../../../types';

const c = (role: string, name: string, textContent = ''): CandidateNode => ({
  role, name, textContent, cssSelector: '', xpath: '', attributes: {}, isVisible: true, similarityScore: 0,
});

/**
 * When the model says "no candidate matches", the resolver may fall back only
 * to a candidate that plausibly IS the target — never to the first thing in DOM
 * order. Kaizen's own dashboard proved why: "File" for "Runs".
 */
describe('plausibleCandidates', () => {
  const menubar = [c('button', 'File'), c('button', 'View'), c('button', 'Account'), c('button', 'Help')];

  it('returns nothing when no candidate shares a word with the target', () => {
    expect(plausibleCandidates(menubar, 'the "Runs" button')).toEqual([]);
    expect(plausibleCandidates(menubar, 'the "Checkout smoke 6" button')).toEqual([]);
  });

  it('keeps candidates that carry the named word, in DOM order', () => {
    const all = [...menubar, c('button', 'Runs 3'), c('button', 'Run suite')];
    expect(plausibleCandidates(all, 'the "Runs" button').map((x) => x.name)).toEqual(['Runs 3']);
    expect(plausibleCandidates(all, 'the "Run suite" button').map((x) => x.name)).toEqual(['Runs 3', 'Run suite']);
  });

  it('role nouns alone are not a match', () => {
    expect(plausibleCandidates(menubar, 'the button')).toEqual([]);
  });
});

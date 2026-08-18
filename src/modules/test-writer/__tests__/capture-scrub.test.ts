import { scrubText, scrubCapture } from '../recon/capture-scrub';
import type { PageCapture } from '../interfaces';
import type { CandidateNode } from '../../../types';

/**
 * Tier B scrubbing — spec-authenticated-scope.md §5.2.
 * A signed-in /members or /profile page renders real people's data, and ordinary
 * capture writes it into page_elements, into ax_outline, and from there into the
 * classifier prompt. What must survive is SHAPE, not content.
 */

describe('scrubText', () => {
  it('redacts emails', () => {
    expect(scrubText('Signed in as ada@example.com')).toBe('Signed in as [redacted]');
  });

  it('redacts long digit runs (cards, phone numbers, account ids)', () => {
    expect(scrubText('Card 4111 1111 1111 1111')).toBe('Card [redacted]');
    expect(scrubText('Call +1 555 010 9999')).toContain('[redacted]');
  });

  it('reuses the Init Brief scrubber for known secret shapes', () => {
    expect(scrubText('token: sk-abcdefghijklmnopqrst')).toContain('[REDACTED]');
  });

  it('leaves ordinary UI text intact — shape must survive', () => {
    expect(scrubText('Remove member')).toBe('Remove member');
    expect(scrubText('Team settings')).toBe('Team settings');
  });

  it('handles empty input', () => {
    expect(scrubText('')).toBe('');
  });
});

function node(partial: Partial<CandidateNode>): CandidateNode {
  return {
    kaizenId: 'kz-1', role: 'link', name: '', cssSelector: 'a', xpath: '',
    attributes: {}, textContent: '', isVisible: true, similarityScore: 1,
    centerPoint: { x: 0, y: 0 }, selectorCandidates: [],
    ...partial,
  };
}

describe('scrubCapture', () => {
  const capture = {
    urlNormalized: 'https://app.example.com/members',
    title: 'Members — ada@example.com',
    headings: ['Team', 'ada@example.com'],
    survey: [
      node({ name: 'ada@example.com', textContent: 'ada@example.com (owner)' }),
      node({ name: 'Remove', textContent: 'Remove' }),
      node({ name: 'Email', attributes: { placeholder: 'ada@example.com', type: 'email' } }),
    ],
    forms: [{
      label: 'Invite ada@example.com',
      submitLabel: 'Send invite',
      fields: [{ label: 'Email', name: 'email', type: 'email', required: true, placeholder: 'ada@example.com' }],
    }],
    outgoingLinks: [],
    revealedStates: [],
    contentHash: 'h',
    screenshotKey: null,
    requiresAuth: true,
    blocked: null,
    axOutline: { elements: [{ role: 'link', name: 'ada@example.com' }] },
  } as PageCapture & { axOutline?: Record<string, unknown> };

  it('redacts content everywhere it hides', () => {
    const s = scrubCapture(capture);

    expect(s.title).toBe('Members — [redacted]');
    expect(s.headings).toEqual(['Team', '[redacted]']);
    expect(s.survey[0].name).toBe('[redacted]');
    expect(s.survey[0].textContent).toBe('[redacted] (owner)');
    expect(s.survey[2].attributes.placeholder).toBe('[redacted]');
    expect(s.forms[0].label).toBe('Invite [redacted]');
    expect(s.forms[0].fields[0].placeholder).toBe('[redacted]');
    // The outline is what actually reaches the prompt.
    expect(JSON.stringify(s.axOutline)).not.toContain('ada@example.com');
  });

  it('preserves structure — roles, selectors and non-PII labels are untouched', () => {
    const s = scrubCapture(capture);

    expect(s.survey[1].name).toBe('Remove');
    expect(s.survey[0].role).toBe('link');
    expect(s.survey[0].cssSelector).toBe('a');
    expect(s.forms[0].submitLabel).toBe('Send invite');
    expect(s.forms[0].fields[0].required).toBe(true);
    expect(s.survey[2].attributes.type).toBe('email');
    expect(s.urlNormalized).toBe('https://app.example.com/members');
  });

  it('does not mutate the original capture', () => {
    scrubCapture(capture);
    expect(capture.title).toBe('Members — ada@example.com');
  });
});

describe('page text is scrubbed like every other captured string', () => {
  /**
   * page_text is the one captured field that is raw prose rather than
   * structure, and it travels furthest: into storage, and then into the WRITE
   * prompt. Spec: spec-authenticated-scope.md §5.2
   */
  it('redacts an address and a long digit run out of the page body', () => {
    const scrubbed = scrubCapture({
      urlNormalized: 'https://app.test/members', title: 'Members', headings: [],
      survey: [], forms: [], outgoingLinks: [], revealedStates: [],
      contentHash: 'h', screenshotKey: null, requiresAuth: true, blocked: null,
      pageText: 'Members: Ada Lovelace ada@example.com, card 4111 1111 1111 1111, joined 2024.',
    });

    expect(scrubbed.pageText).not.toContain('ada@example.com');
    expect(scrubbed.pageText).not.toContain('4111 1111 1111 1111');
    // Shape survives — that is the part COMPREHEND and WRITE actually need.
    expect(scrubbed.pageText).toContain('Members: Ada Lovelace');
  });

  it('leaves a capture with no page text alone', () => {
    const scrubbed = scrubCapture({
      urlNormalized: 'https://app.test/', title: 'Home', headings: [],
      survey: [], forms: [], outgoingLinks: [], revealedStates: [],
      contentHash: 'h', screenshotKey: null, requiresAuth: false, blocked: null,
    });
    expect(scrubbed.pageText).toBe('');
  });
});

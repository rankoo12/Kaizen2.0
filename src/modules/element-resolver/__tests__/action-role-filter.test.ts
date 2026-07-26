import { filterCandidatesByAction } from '../action-role-filter';
import type { CandidateNode } from '../../../types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCandidate(role: string, name = 'element'): CandidateNode {
  return {
    role,
    name,
    textContent: '',
    cssSelector: `[role="${role}"]`,
    xpath: '',
    attributes: {},
    isVisible: true,
    similarityScore: 1,
  };
}

const textbox  = makeCandidate('textbox',  'Email');
const searchbox = makeCandidate('searchbox', 'Search');
const combobox = makeCandidate('combobox', 'Search Wikipedia');
const button   = makeCandidate('button',   'Submit');
const link     = makeCandidate('link',     'Skip to search');
const checkbox = makeCandidate('checkbox', 'Remember me');
const radio    = makeCandidate('radio',    'Option A');
const listbox  = makeCandidate('listbox',  'Country');

// ─── type action ─────────────────────────────────────────────────────────────

describe('filterCandidatesByAction — type', () => {
  it('keeps textbox, searchbox, combobox and removes link and button', () => {
    const result = filterCandidatesByAction(
      [link, button, textbox, searchbox, combobox],
      'type',
    );
    expect(result).toEqual([textbox, searchbox, combobox]);
  });

  it('in fallback, drops link/button when a non-incompatible candidate remains (MDN "Skip to search" fix)', () => {
    // A custom widget with a non-standard role + a "Skip to search" link and a
    // button. No textbox/searchbox/combobox → fallback. We must NOT hand the
    // resolver the link/button; keep only the custom-role widget.
    const customWidget = makeCandidate('application', 'Rich search');
    const result = filterCandidatesByAction([link, button, customWidget], 'type');
    expect(result).toEqual([customWidget]);
  });

  it('falls back to the full list only when EVERY candidate is incompatible (last-resort safety net)', () => {
    // link + button are both type-incompatible; trimming would empty the list, so
    // we keep the original rather than resolve against nothing.
    const result = filterCandidatesByAction([link, button], 'type');
    expect(result).toEqual([link, button]);
  });

  it('treats "fill" the same as "type"', () => {
    const result = filterCandidatesByAction([link, textbox], 'fill');
    expect(result).toEqual([textbox]);
  });

  it('treats "clear" the same as "type"', () => {
    const result = filterCandidatesByAction([button, combobox], 'clear');
    expect(result).toEqual([combobox]);
  });
});

// ─── check / uncheck action ──────────────────────────────────────────────────

describe('filterCandidatesByAction — check/uncheck', () => {
  it('keeps checkbox and radio, removes button and link', () => {
    const result = filterCandidatesByAction([link, button, checkbox, radio], 'check');
    expect(result).toEqual([checkbox, radio]);
  });

  it('treats "uncheck" the same as "check"', () => {
    const result = filterCandidatesByAction([link, checkbox], 'uncheck');
    expect(result).toEqual([checkbox]);
  });
});

// ─── select action ───────────────────────────────────────────────────────────

describe('filterCandidatesByAction — select', () => {
  it('keeps combobox and listbox, removes button and link', () => {
    const result = filterCandidatesByAction([link, button, combobox, listbox], 'select');
    expect(result).toEqual([combobox, listbox]);
  });
});

// ─── unconstrained actions ───────────────────────────────────────────────────

describe('filterCandidatesByAction — unconstrained actions', () => {
  const all = [link, button, textbox, checkbox];

  it('returns all candidates unchanged for "click"', () => {
    expect(filterCandidatesByAction(all, 'click')).toBe(all);
  });

  it('returns all candidates unchanged for "navigate"', () => {
    expect(filterCandidatesByAction(all, 'navigate')).toBe(all);
  });

  it('returns all candidates unchanged for "press_key"', () => {
    expect(filterCandidatesByAction(all, 'press_key')).toBe(all);
  });

  it('returns all candidates unchanged for "wait"', () => {
    expect(filterCandidatesByAction(all, 'wait')).toBe(all);
  });

  it('returns all candidates unchanged for an unknown action', () => {
    expect(filterCandidatesByAction(all, 'some_future_action')).toBe(all);
  });
});

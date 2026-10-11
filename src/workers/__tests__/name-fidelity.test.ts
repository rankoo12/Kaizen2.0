import { quotedName, nameOverlaps, countDriftMatch, nameAbsent, salientWords } from '../name-fidelity';

describe('salientWords — the shared tokenizer behind the name gates', () => {
  it('drops stopwords and single letters, keeps digits', () => {
    expect(salientWords('the "Block user" menu item')).toEqual(['block', 'user', 'menu', 'item']);
    expect(salientWords('the Demo 0 suite')).toEqual(['demo', '0', 'suite']);
    expect(salientWords('the button')).toEqual([]); // stopwords only → nothing to gate on
  });
});

describe('nameAbsent — the suspect-wrong-pick-under-latency trigger (finding #6)', () => {
  it('flags the real latency mis-picks the bench caught (zero shared word)', () => {
    expect(nameAbsent('the Add friend button', 'Notifications')).toBe(true);
    expect(nameAbsent('the "Play" button for Ridge traverse', 'Notifications')).toBe(true);
    expect(nameAbsent('the Create event button', 'Notifications')).toBe(true);
    expect(nameAbsent('the "Write a comment…" field', "What's buzzing?")).toBe(true);
  });

  it('does NOT flag a resolution that shares any salient word', () => {
    expect(nameAbsent('the Add friend button', 'Add friend')).toBe(false);
    expect(nameAbsent('the message field', 'Messages')).toBe(false); // "message" ⊂ "messages"
    expect(nameAbsent('the Pro plan button', 'Choose Pro')).toBe(false); // shares "pro"
    expect(nameAbsent('the search box', 'Search Buzzly')).toBe(false);
  });

  it('never flags when there is nothing to check', () => {
    expect(nameAbsent('the button', 'Notifications')).toBe(false); // only stopwords
    expect(nameAbsent(null, 'x')).toBe(false);
    expect(nameAbsent('x', null)).toBe(false);
  });

  it('is stricter than nameOverlaps: a half-match is absent=false but overlaps=false', () => {
    // "Pro plan" vs "Choose Pro": 1 of 2 words → overlaps false (<=50%), absent false (one matched).
    expect(nameOverlaps('Pro plan', 'Choose Pro')).toBe(false);
    expect(nameAbsent('Pro plan', 'Choose Pro')).toBe(false);
  });
});

describe('quotedName', () => {
  it('extracts the double-quoted name', () => {
    expect(quotedName('the "Save" button')).toBe('Save');
    expect(quotedName('the plain description')).toBeNull();
    expect(quotedName(null)).toBeNull();
  });
});

describe('nameOverlaps — the majority of the quoted words must be on the element', () => {
  it('accepts the element that carries the name', () => {
    expect(nameOverlaps('Checkout smoke 8', 'Checkout smoke 8 suite button')).toBe(true);
    expect(nameOverlaps('Run now', 'Run now (⌘R)')).toBe(true);
    expect(nameOverlaps('Demo user', 'DU Demo user account')).toBe(true);
  });

  it('refuses a single shared common word — run 9 lost four criticals to this', () => {
    // "Demo 0" resolved to the account button "DU Demo user": only "demo" shared.
    expect(nameOverlaps('Demo 0', 'DU Demo user')).toBe(false);
    // "Suite Checkout smoke Demo" resolved to the "New suite" button.
    expect(nameOverlaps('Suite Checkout smoke Demo', 'New suite')).toBe(false);
  });

  it('accepts a recon-noised name when the element carries most of it', () => {
    // recon named the select by its options; the combobox descriptor holds them.
    expect(nameOverlaps('Suite Checkout smoke Demo', 'Suite Checkout smoke Demo select')).toBe(true);
  });

  it('has nothing to check against symbols-only names', () => {
    expect(nameOverlaps('⌘R', 'anything')).toBe(true);
  });

  it('still refuses the run-8 poster child', () => {
    expect(nameOverlaps('Checkout smoke 6', 'File')).toBe(false);
  });
});

describe('countDriftMatch — a trailing count is a live badge, not identity', () => {
  it('accepts the same control whose count moved (runs 23–24 lost six clicks to this)', () => {
    expect(countDriftMatch('Demo 5', 'button Demo 6')).toBe(true);
    expect(countDriftMatch('Checkout smoke 8', 'Checkout smoke 12 suite button')).toBe(true);
  });

  it('keeps the run-9 false resolution dead: no count on the other side, no match', () => {
    expect(countDriftMatch('Demo 0', 'DU Demo user')).toBe(false);
  });

  it('does nothing for names without a trailing count', () => {
    expect(countDriftMatch('Run now', 'Run later')).toBe(false);
    expect(countDriftMatch('Save', 'Save & Run')).toBe(false);
  });

  it('demands the residue verbatim, not word soup', () => {
    expect(countDriftMatch('Checkout smoke 8', 'smoke checkout 9')).toBe(false);
  });
});

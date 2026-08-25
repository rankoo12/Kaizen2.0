import { quotedName, nameOverlaps, countDriftMatch } from '../name-fidelity';

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

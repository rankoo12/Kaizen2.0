import { selectorsForTarget, findRepeatedTargets, type RepeatedMatch } from '../random-target';

describe('selectorsForTarget', () => {
  it('returns add-to-cart selectors for cart-button targets', () => {
    for (const t of ['add to cart button', 'an add to cart button', 'the add-to-cart button']) {
      const sels = selectorsForTarget(t);
      expect(sels[0]).toBe('input.product-box-add-to-cart-button');
      expect(sels.some((s) => /add to cart/i.test(s))).toBe(true);
    }
  });

  it('returns product-link selectors for product targets', () => {
    const sels = selectorsForTarget('a product link');
    expect(sels.some((s) => s.includes('product-title'))).toBe(true);
    expect(sels).not.toContain('input.product-box-add-to-cart-button');
  });
});

describe('findRepeatedTargets', () => {
  it('returns the first selector group that matches anything', async () => {
    const result: RepeatedMatch[] = [
      { selector: '[data-kz-rand="a"]', title: '3rd Album' },
      { selector: '[data-kz-rand="b"]', title: 'Health Book' },
    ];
    let calls = 0;
    const page = {
      $$eval: async <T,>(_sel: string, _fn: (els: Element[]) => T): Promise<T> => {
        calls += 1;
        // First selector matches; return our canned result.
        return result as unknown as T;
      },
    };
    const out = await findRepeatedTargets(page, 'add to cart button');
    expect(out).toHaveLength(2);
    expect(calls).toBe(1); // stopped at the first matching selector
  });

  it('skips selectors that match nothing and tries the next', async () => {
    const seq: RepeatedMatch[][] = [[], [{ selector: '#x', title: 'Found' }]];
    let i = 0;
    const page = {
      $$eval: async <T,>(): Promise<T> => (seq[i++] as unknown as T),
    };
    const out = await findRepeatedTargets(page, 'add to cart button');
    expect(out.map((m) => m.title)).toEqual(['Found']);
  });

  it('returns [] and swallows errors when no selector matches', async () => {
    const page = { $$eval: async () => { throw new Error('bad selector'); } };
    expect(await findRepeatedTargets(page, 'add to cart button')).toEqual([]);
  });
});

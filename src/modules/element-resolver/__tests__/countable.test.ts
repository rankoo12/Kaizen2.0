import {
  countNounStems,
  matchRole,
  parseCountTarget,
  pickCountable,
  resolveCountSelector,
  type CountCandidate,
} from '../countable';

describe('countNounStems', () => {
  it('extracts distinctive singular-ish noun stems, dropping stopwords', () => {
    expect(countNounStems('there should be at least 3 search results')).toEqual(['search', 'result']);
    expect(countNounStems('the products')).toEqual(['product']);
    expect(countNounStems('cart items')).toEqual(['cart', 'item']);
    expect(countNounStems('categories')).toEqual(['category']);
  });

  it('returns [] for count-only phrasing with no noun', () => {
    expect(countNounStems('there are exactly')).toEqual([]);
    expect(countNounStems('')).toEqual([]);
  });
});

describe('matchRole', () => {
  it('maps native countable kinds to a role/tag selector', () => {
    expect(matchRole('rows')?.sel).toContain('tr');
    expect(matchRole('the links in the footer')?.sel).toContain('a[href]');
    expect(matchRole('images')?.sel).toContain('img');
  });

  it('prefers the MOST specific keyword (radio button over button)', () => {
    expect(matchRole('radio buttons')?.sel).toContain('input[type="radio"]');
    expect(matchRole('list items')?.sel).toContain('li');
  });

  it('returns null for domain nouns with no native role (products, results)', () => {
    expect(matchRole('products')).toBeNull();
    expect(matchRole('search results')).toBeNull();
  });
});

describe('pickCountable', () => {
  const group = (haystack: string, count: number): CountCandidate => ({ kind: 'group', token: `g${count}`, count, haystack });
  const role = (count: number, roleKwLen = 6): CountCandidate => ({ kind: 'role', token: 'r', count, haystack: '', roleKwLen });

  it('prefers the semantic ROLE sweep for a native kind over a class-coincidence group', () => {
    // "rows" must count <tr> (role), not a Bootstrap `.row` div group that merely
    // grounds on the token "row".
    const chosen = pickCountable([group('div.row', 3), role(10, 4)], 'rows');
    expect(chosen?.kind).toBe('role');
    expect(chosen?.count).toBe(10);
  });

  it('uses a grounded group when there is NO role candidate (products)', () => {
    const chosen = pickCountable([group('li.col article.product_pod products', 20)], 'products');
    expect(chosen?.kind).toBe('group');
    expect(chosen?.count).toBe(20);
  });

  it('picks the LARGEST grounded group when several are grounded and no role matched', () => {
    const chosen = pickCountable(
      [group('ul.related products', 4), group('div.product-grid products', 24)],
      'the products',
    );
    expect(chosen?.count).toBe(24);
  });

  it('REFUSES (returns null) rather than guess an ungrounded biggest group', () => {
    // A repeated group exists but nothing ties it to "products", and there is no role
    // hit — picking it could silently miscount → false pass. Refuse instead.
    expect(pickCountable([group('nav ul.menu', 9)], 'products')).toBeNull();
  });

  it('ignores group candidates with fewer than 2 members', () => {
    expect(pickCountable([{ kind: 'group', token: 'x', count: 1, haystack: 'product' }], 'products')).toBeNull();
  });
});

describe('parseCountTarget', () => {
  it('splits the head noun from an "in the <container>" qualifier', () => {
    expect(parseCountTarget('items in the cart')).toEqual({ headStems: ['item'], containerStem: 'cart' });
    expect(parseCountTarget('1 item in the cart')).toEqual({ headStems: ['item'], containerStem: 'cart' });
  });

  it('has no container when there is no "in" phrase', () => {
    expect(parseCountTarget('6 items')).toEqual({ headStems: ['item'], containerStem: null });
    expect(parseCountTarget('products')).toEqual({ headStems: ['product'], containerStem: null });
  });
});

describe('pickCountable — classgroup tier (counts exactly 1)', () => {
  const role = (count: number, roleKwLen = 6): CountCandidate => ({ kind: 'role', token: 'r', count, haystack: '', roleKwLen });
  const group = (haystack: string, count: number): CountCandidate => ({ kind: 'group', token: `g${count}`, count, haystack });
  const classgroup = (count: number, token = 'cg'): CountCandidate => ({ kind: 'classgroup', token, count, haystack: 'div.cart_item' });

  it('counts a single grounded classgroup member — "1 item in the cart"', () => {
    const chosen = pickCountable([classgroup(1)], 'items in the cart');
    expect(chosen?.kind).toBe('classgroup');
    expect(chosen?.count).toBe(1);
  });

  it('still prefers a native ROLE sweep over a classgroup', () => {
    const chosen = pickCountable([role(2, 8), classgroup(1)], 'checkboxes');
    expect(chosen?.kind).toBe('role');
  });

  it('prefers a classgroup over a loose grounded group (cart_item beats inventory_item)', () => {
    const chosen = pickCountable(
      [group('div.inventory_item item', 6), classgroup(5, 'c')],
      'items in the cart',
    );
    expect(chosen?.kind).toBe('classgroup');
    expect(chosen?.count).toBe(5);
  });

  it('picks the largest classgroup when several survive', () => {
    const chosen = pickCountable([classgroup(1, 'a'), classgroup(5, 'b')], 'items in the cart');
    expect(chosen?.count).toBe(5);
  });
});

describe('resolveCountSelector', () => {
  const pageReturning = (payload: unknown) => ({
    $eval: async <T,>(): Promise<T> => payload as T,
  });

  it('returns a group selector + count when a grounded group is gathered', async () => {
    const page = pageReturning({
      role: null,
      groups: [{ token: 'abc123', count: 12, haystack: 'div.product-item products' }],
    });
    const out = await resolveCountSelector(page, 'products');
    expect(out).toEqual({ selector: '[data-kzc-abc123]', count: 12, method: 'group' });
  });

  it('returns a role selector + count for a native kind (rows) with no grounded group', async () => {
    const page = pageReturning({ role: { token: 'r9', count: 3 }, groups: [] });
    const out = await resolveCountSelector(page, 'rows');
    expect(out).toEqual({ selector: '[data-kzc-r9]', count: 3, method: 'role' });
  });

  it('returns a classgroup selector + count for exactly ONE grounded unit (1 item in the cart)', async () => {
    const page = pageReturning({ role: null, groups: [], classGroups: [{ token: 'k1', count: 1, haystack: 'div.cart_item' }] });
    const out = await resolveCountSelector(page, 'items in the cart');
    expect(out).toEqual({ selector: '[data-kzc-k1]', count: 1, method: 'classgroup' });
  });

  it('returns null when nothing is confidently countable (→ assertion fails loudly)', async () => {
    const page = pageReturning({ role: null, groups: [{ token: 'z', count: 9, haystack: 'nav ul.menu' }] });
    expect(await resolveCountSelector(page, 'products')).toBeNull();
  });

  it('returns null and swallows errors when the page scan throws', async () => {
    const page = { $eval: async () => { throw new Error('bad selector'); } };
    expect(await resolveCountSelector(page, 'products')).toBeNull();
  });
});

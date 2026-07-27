import { handleTabAction, ordinalToIndex, type TabPage, type TabContext } from '../tab-manager';
import type { StepAST } from '../../types';

// ─── Fakes ─────────────────────────────────────────────────────────────────

function makePage(title: string): TabPage & { closed: boolean; broughtToFront: boolean } {
  const ctxRef: { ctx?: TabContext } = {};
  const page = {
    closed: false,
    broughtToFront: false,
    title: async () => title,
    bringToFront: async () => { page.broughtToFront = true; },
    waitForLoadState: async () => {},
    close: async () => { page.closed = true; },
    context: () => ctxRef.ctx as TabContext,
  };
  (page as any)._bind = (c: TabContext) => { ctxRef.ctx = c; };
  return page as any;
}

function makeContext(pages: TabPage[], onWaitForEvent?: () => void): TabContext {
  const ctx: TabContext = {
    pages: () => pages,
    waitForEvent: async () => { onWaitForEvent?.(); return {}; },
  };
  pages.forEach((p) => (p as any)._bind(ctx));
  return ctx;
}

const step = (action: StepAST['action'], value: string | null = null): Pick<StepAST, 'action' | 'value' | 'targetDescription'> =>
  ({ action, value, targetDescription: null });

describe('ordinalToIndex', () => {
  it('maps ordinals, numbers, and last', () => {
    expect(ordinalToIndex('the second tab')).toBe(1);
    expect(ordinalToIndex('switch to tab 3')).toBe(2);
    expect(ordinalToIndex('the last window')).toBe(-1);
    expect(ordinalToIndex('the new tab')).toBeNull();
  });
});

describe('handleTabAction — switch_tab', () => {
  it('"new" (default) focuses the most recently opened tab', async () => {
    const a = makePage('Original'), b = makePage('New Window');
    makeContext([a, b]);
    let current: TabPage | null = null;
    const r = await handleTabAction(step('switch_tab', 'new'), a, (p) => { current = p; });
    expect(r.ok).toBe(true);
    expect(current).toBe(b);
    expect((b as any).broughtToFront).toBe(true);
  });

  it('empty hint defaults to newest', async () => {
    const a = makePage('Original'), b = makePage('Popup');
    makeContext([a, b]);
    let current: TabPage | null = null;
    await handleTabAction(step('switch_tab', null), a, (p) => { current = p; });
    expect(current).toBe(b);
  });

  it('"first"/"original" focuses the initial tab', async () => {
    const a = makePage('Original'), b = makePage('New');
    makeContext([a, b]);
    let current: TabPage | null = null;
    const r = await handleTabAction(step('switch_tab', 'original'), b, (p) => { current = p; });
    expect(r.ok).toBe(true);
    expect(current).toBe(a);
  });

  it('waits for a new tab when only one is open, then focuses it', async () => {
    const a = makePage('Original');
    const pages = [a];
    let waited = false;
    const ctx = makeContext(pages, () => { waited = true; pages.push(makePage('Late Tab')); });
    (a as any)._bind(ctx);
    let current: TabPage | null = null;
    const r = await handleTabAction(step('switch_tab', 'new'), a, (p) => { current = p; });
    expect(waited).toBe(true);
    expect(r.ok).toBe(true);
    expect(await (current as any).title()).toBe('Late Tab');
  });

  it('matches by title substring when the hint is neither new nor an ordinal', async () => {
    const a = makePage('Dashboard'), b = makePage('Invoice #42'), c = makePage('Settings');
    makeContext([a, b, c]);
    let current: TabPage | null = null;
    const r = await handleTabAction(step('switch_tab', 'invoice'), a, (p) => { current = p; });
    expect(r.ok).toBe(true);
    expect(current).toBe(b);
  });

  it('fails cleanly when no tab matches the hint', async () => {
    const a = makePage('Only');
    makeContext([a]);
    const r = await handleTabAction(step('switch_tab', 'nonexistent-title'), a);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/no tab matched/);
  });
});

describe('handleTabAction — close_tab', () => {
  it('closes the current tab and focuses the remaining one', async () => {
    const a = makePage('Original'), b = makePage('New');
    const pages = [a, b];
    const ctx = makeContext(pages);
    // simulate close removing b from the context's page list
    (b as any).close = async () => { (b as any).closed = true; pages.splice(pages.indexOf(b), 1); };
    (b as any)._bind(ctx);
    let current: TabPage | null = null;
    const r = await handleTabAction(step('close_tab'), b, (p) => { current = p; });
    expect(r.ok).toBe(true);
    expect((b as any).closed).toBe(true);
    expect(current).toBe(a);
  });

  it('refuses to close the only open tab', async () => {
    const a = makePage('Only');
    makeContext([a]);
    const r = await handleTabAction(step('close_tab'), a);
    expect(r.ok).toBe(false);
    expect((a as any).closed).toBe(false);
  });
});

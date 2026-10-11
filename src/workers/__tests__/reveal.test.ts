/**
 * Hover-to-reveal recovery driver (finding #7) — the orchestration contract:
 * scan for hidden carriers of the step's name, hover each anchor, adopt only a
 * target that actually became visible, clear the stamps on a total miss.
 * The in-browser scan itself runs live on the bench (Buzzly hover-menu seed);
 * these tests drive revealHiddenTarget against a fake page, per spec §4.
 * Spec: docs/specs/workers/spec-hover-reveal-scroll-find.md §1
 */
import { revealHiddenTarget, RevealPageLike } from '../reveal';

type Hit = { target: string; anchor: string; name: string };

/** Fake page: dispatches page.evaluate on the in-browser function's name. */
function makePage(opts: {
  hits: Hit[];
  /** targets that report visible after their anchor was hovered */
  visibleAfterHover?: string[];
  /** anchors whose hover throws (detached / covered) */
  hoverThrows?: string[];
}) {
  const hovered: string[] = [];
  let stampsCleared = false;
  let scanArg: { phrase: string | null; words: string[] } | null = null;
  const page: RevealPageLike = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    evaluate: jest.fn(async (fn: (arg: any) => unknown, arg?: unknown) => {
      const name = (fn as { name?: string }).name;
      if (name === 'scanForHidden') {
        scanArg = arg as { phrase: string | null; words: string[] };
        return opts.hits;
      }
      if (name === 'isVisibleNow') {
        const target = arg as string;
        const anchorFor = opts.hits.find((h) => h.target === target)?.anchor;
        return (
          (opts.visibleAfterHover ?? []).includes(target) &&
          anchorFor != null && hovered.includes(anchorFor)
        );
      }
      if (name === 'clearStamps') { stampsCleared = true; return true; }
      throw new Error(`unexpected evaluate: ${name}`);
    }),
    hover: jest.fn(async (selector: string) => {
      if ((opts.hoverThrows ?? []).includes(selector)) throw new Error('hover timeout');
      hovered.push(selector);
    }),
    waitForTimeout: jest.fn(async () => undefined),
  };
  return { page, hovered: () => hovered, stampsCleared: () => stampsCleared, scanArg: () => scanArg };
}

const HIT0: Hit = { target: '[data-kz-reveal="r0"]', anchor: '[data-kz-reveal-anchor="a0"]', name: 'block user' };
const HIT1: Hit = { target: '[data-kz-reveal="r1"]', anchor: '[data-kz-reveal-anchor="a1"]', name: 'block user' };

describe('revealHiddenTarget', () => {
  it('hovers the anchor and returns the stamped target once it is visible', async () => {
    const f = makePage({ hits: [HIT0], visibleAfterHover: [HIT0.target] });

    const sel = await revealHiddenTarget(f.page, 'the "Block user" menu item');

    expect(sel).toBe(HIT0.target);
    expect(f.page.hover).toHaveBeenCalledWith(HIT0.anchor, { timeout: 1500 });
    expect(f.stampsCleared()).toBe(false); // the selector must keep resolving through the action
  });

  it('passes the quoted phrase (preferred over loose words) to the scan', async () => {
    const f = makePage({ hits: [HIT0], visibleAfterHover: [HIT0.target] });

    await revealHiddenTarget(f.page, 'the "Block user" menu item');

    expect(f.scanArg()).toEqual({ phrase: 'block user', words: ['block', 'user', 'menu', 'item'] });
  });

  it('tries the next hit when the first anchor does not actually reveal the target', async () => {
    // Anchor a0 hovers fine but r0 stays hidden (wrong trigger zone); a1 works.
    const f = makePage({ hits: [HIT0, HIT1], visibleAfterHover: [HIT1.target] });

    const sel = await revealHiddenTarget(f.page, 'the Block user menu item');

    expect(sel).toBe(HIT1.target);
    expect(f.hovered()).toEqual([HIT0.anchor, HIT1.anchor]);
  });

  it('survives a hover that throws (detached anchor) and moves on', async () => {
    const f = makePage({ hits: [HIT0, HIT1], visibleAfterHover: [HIT1.target], hoverThrows: [HIT0.anchor] });

    const sel = await revealHiddenTarget(f.page, 'the Block user menu item');

    expect(sel).toBe(HIT1.target);
  });

  it('returns null and clears the stamps when no hover reveals anything', async () => {
    const f = makePage({ hits: [HIT0, HIT1] }); // nothing ever becomes visible

    const sel = await revealHiddenTarget(f.page, 'the Block user menu item');

    expect(sel).toBeNull();
    expect(f.stampsCleared()).toBe(true); // total miss leaves no marker litter behind
  });

  it('returns null without touching the page when the scan finds no carrier', async () => {
    const f = makePage({ hits: [] });

    const sel = await revealHiddenTarget(f.page, 'the Block user menu item');

    expect(sel).toBeNull();
    expect(f.page.hover).not.toHaveBeenCalled();
    expect(f.stampsCleared()).toBe(false); // nothing was stamped, nothing to clear
  });

  it('refuses to run with nothing to match on (no name, or stopwords only)', async () => {
    const f = makePage({ hits: [HIT0] });

    expect(await revealHiddenTarget(f.page, null)).toBeNull();
    expect(await revealHiddenTarget(f.page, 'the button')).toBeNull();
    expect(f.page.evaluate).not.toHaveBeenCalled(); // never scans blind — lookalike risk
  });

  it('treats a scan failure as a miss, never as a crash', async () => {
    const page: RevealPageLike = {
      evaluate: jest.fn(async () => { throw new Error('Execution context destroyed'); }),
      hover: jest.fn(),
      waitForTimeout: jest.fn(async () => undefined),
    };

    expect(await revealHiddenTarget(page, 'the Block user menu item')).toBeNull();
  });
});

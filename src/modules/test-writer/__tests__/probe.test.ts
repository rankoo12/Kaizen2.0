import { runProbes } from '../recon/probe';
import type { CandidateNode } from '../../../types';
import type { IObservability } from '../../observability/interfaces';

const obs: IObservability = {
  startSpan: () => ({ end: () => {} }) as never,
  log: jest.fn(),
  increment: jest.fn(),
  histogram: jest.fn(),
};

const PAGE_URL = 'https://a.com/products';
const ctx = { pageUrl: PAGE_URL, rootOrigin: 'https://a.com', obs };

function makeCandidate(name: string): CandidateNode {
  return {
    kaizenId: 'kz-7', role: 'button', name, cssSelector: 'button', xpath: '',
    attributes: {}, textContent: name, isVisible: true, similarityScore: 1,
    centerPoint: { x: 0, y: 0 }, selectorCandidates: [],
  };
}

type FakePage = {
  url: jest.Mock; click: jest.Mock; evaluate: jest.Mock;
  waitForTimeout: jest.Mock; goBack: jest.Mock; goto: jest.Mock;
  keyboard: { press: jest.Mock };
};

function makePage(): FakePage {
  return {
    url: jest.fn(() => PAGE_URL),
    click: jest.fn(async () => {}),
    evaluate: jest.fn(async () => undefined),
    waitForTimeout: jest.fn(async () => {}),
    goBack: jest.fn(async () => {}),
    goto: jest.fn(async () => {}),
    keyboard: { press: jest.fn(async () => {}) },
  };
}

describe('runProbes', () => {
  it('collects revealed elements and links, then presses Escape to restore', async () => {
    const page = makePage();
    // Call 1: stampBaseline → undefined. Call 2: collectRevealed.
    page.evaluate
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        elements: [{ role: 'link', name: 'Hidden panel link' }],
        hrefs: ['/hidden', 'https://other.com/x'],
      });

    const { reveals, probesPerformed } = await runProbes(
      page, [makeCandidate('Show more')], 8, ctx);

    expect(probesPerformed).toBe(1);
    expect(reveals).toHaveLength(1);
    expect(reveals[0].trigger.name).toBe('Show more');
    expect(reveals[0].revealedElements).toEqual([{ role: 'link', name: 'Hidden panel link' }]);
    // Cross-origin revealed href is dropped; same-origin normalized.
    expect(reveals[0].revealedLinks).toEqual(['https://a.com/hidden']);
    expect(page.keyboard.press).toHaveBeenCalledWith('Escape');
    expect(page.goBack).not.toHaveBeenCalled();
  });

  it('restores via goBack when a probe unexpectedly navigates, recording the destination', async () => {
    const page = makePage();
    let current = PAGE_URL;
    page.url.mockImplementation(() => current);
    page.click.mockImplementation(async () => { current = 'https://a.com/surprise'; });
    page.goBack.mockImplementation(async () => { current = PAGE_URL; });

    const { reveals } = await runProbes(page, [makeCandidate('Expand')], 8, ctx);

    expect(page.goBack).toHaveBeenCalled();
    expect(reveals).toHaveLength(1);
    expect(reveals[0].revealedLinks).toEqual(['https://a.com/surprise']);
    // No collect on the navigated-away DOM: only the baseline evaluate ran.
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it('reloads the page URL when goBack does not restore it', async () => {
    const page = makePage();
    let current = PAGE_URL;
    page.url.mockImplementation(() => current);
    page.click.mockImplementation(async () => { current = 'https://a.com/surprise'; });
    // goBack "fails" to change the URL back.
    page.goto.mockImplementation(async (url: string) => { current = url; });

    await runProbes(page, [makeCandidate('Expand')], 8, ctx);

    expect(page.goto).toHaveBeenCalledWith(PAGE_URL, expect.anything());
    expect(current).toBe(PAGE_URL);
  });

  it('skips gracefully when the click fails, still counting the probe', async () => {
    const page = makePage();
    page.evaluate.mockResolvedValueOnce(undefined); // baseline
    page.click.mockRejectedValue(new Error('element detached'));

    const { reveals, probesPerformed } = await runProbes(
      page, [makeCandidate('Show more')], 8, ctx);

    expect(probesPerformed).toBe(1);
    expect(reveals).toHaveLength(0);
  });

  it('respects the probe budget', async () => {
    const page = makePage();
    page.evaluate.mockResolvedValue({ elements: [], hrefs: [] });

    const candidates = [1, 2, 3, 4, 5].map((n) => makeCandidate(`Show more ${n}`));
    const { probesPerformed } = await runProbes(page, candidates, 2, ctx);

    expect(probesPerformed).toBe(2);
    expect(page.click).toHaveBeenCalledTimes(2);
  });
});

import { BrowserPool } from '../browser-pool';
import type { Browser } from 'playwright';

function fakeBrowser(): Browser & { _kill: () => void } {
  let connected = true;
  return {
    isConnected: () => connected,
    close: jest.fn(async () => { connected = false; }),
    _kill: () => { connected = false; },
  } as unknown as Browser & { _kill: () => void };
}

describe('BrowserPool', () => {
  it('launches lazily and reuses the same browser across calls', async () => {
    const launcher = jest.fn(async () => fakeBrowser());
    const pool = new BrowserPool(launcher);

    expect(launcher).not.toHaveBeenCalled();
    const a = await pool.get();
    const b = await pool.get();
    expect(a).toBe(b);
    expect(launcher).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent launches into one browser', async () => {
    let resolveLaunch!: (b: Browser) => void;
    const launcher = jest.fn(() => new Promise<Browser>((r) => { resolveLaunch = r; }));
    const pool = new BrowserPool(launcher);

    const p1 = pool.get();
    const p2 = pool.get();
    resolveLaunch(fakeBrowser());
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toBe(b);
    expect(launcher).toHaveBeenCalledTimes(1);
  });

  it('relaunches after the browser disconnects (crash recovery)', async () => {
    const launcher = jest.fn(async () => fakeBrowser());
    const pool = new BrowserPool(launcher);

    const first = await pool.get();
    (first as ReturnType<typeof fakeBrowser>)._kill();
    const second = await pool.get();

    expect(second).not.toBe(first);
    expect(launcher).toHaveBeenCalledTimes(2);
  });

  it('recovers from a failed launch on the next call', async () => {
    const launcher = jest.fn()
      .mockRejectedValueOnce(new Error('no chromium'))
      .mockImplementation(async () => fakeBrowser());
    const pool = new BrowserPool(launcher);

    await expect(pool.get()).rejects.toThrow('no chromium');
    await expect(pool.get()).resolves.toBeDefined();
    expect(launcher).toHaveBeenCalledTimes(2);
  });

  it('close() shuts the browser down and a later get() relaunches', async () => {
    const launcher = jest.fn(async () => fakeBrowser());
    const pool = new BrowserPool(launcher);

    const first = await pool.get();
    await pool.close();
    expect(first.close).toHaveBeenCalled();

    await pool.get();
    expect(launcher).toHaveBeenCalledTimes(2);
  });

  it('close() before any launch is a no-op', async () => {
    const launcher = jest.fn(async () => fakeBrowser());
    const pool = new BrowserPool(launcher);
    await expect(pool.close()).resolves.toBeUndefined();
    expect(launcher).not.toHaveBeenCalled();
  });

  describe('recycling (BROWSER_MAX_RUNS)', () => {
    it('recycles the browser at idle once the run budget is spent', async () => {
      const launcher = jest.fn(async () => fakeBrowser());
      const pool = new BrowserPool(launcher, 2);

      const first = await pool.acquire();
      await pool.release();
      expect(await pool.acquire()).toBe(first); // budget not spent yet
      await pool.release();                      // 2nd release → recycle
      expect(first.close).toHaveBeenCalled();

      const next = await pool.acquire();
      expect(next).not.toBe(first);
      expect(launcher).toHaveBeenCalledTimes(2);
    });

    it('never recycles while other runs are still active', async () => {
      const launcher = jest.fn(async () => fakeBrowser());
      const pool = new BrowserPool(launcher, 1); // budget spent by the FIRST run

      const b = await pool.acquire(); // run A
      await pool.acquire();           // run B (same browser)
      await pool.release();           // A done — B still active → no recycle
      expect(b.close).not.toHaveBeenCalled();

      await pool.release();           // B done — idle → recycle
      expect(b.close).toHaveBeenCalled();
    });

    it('a crash-relaunch resets the run budget', async () => {
      const launcher = jest.fn(async () => fakeBrowser());
      const pool = new BrowserPool(launcher, 2);

      const first = (await pool.acquire()) as ReturnType<typeof fakeBrowser>;
      await pool.release();
      first._kill();                  // crash after 1 run

      const second = await pool.acquire(); // relaunch → budget restarts at 1
      await pool.release();
      expect(second.close).not.toHaveBeenCalled(); // only 1 run on this browser
    });
  });
});

import { PlaywrightDOMPruner } from '../playwright.dom-pruner';

describe('PlaywrightDOMPruner', () => {
  let pruner: PlaywrightDOMPruner;

  beforeEach(() => {
    pruner = new PlaywrightDOMPruner();
  });

  it('executes evaluation script and returns extracted elements', async () => {
    // We mock the Playwright page.evaluate function to act exactly like the browser would
    // by using a primitive stub for testing the Node environment boundary.
    const mockPage = {
      evaluate: jest.fn().mockImplementation(async (scriptFn, arg) => {
        // We cannot run the actual browser JS in this Node-only unit test without JSDOM,
        // so we just return a mocked result representing the script's output from the browser.
        return [
          {
            kaizenId: 'kz-1',
            role: 'button',
            name: 'Submit',
            cssSelector: '',
            xpath: '',
            attributes: { id: 'submit-btn', 'data-testid': 'submit' },
            textContent: 'Submit Form',
            isVisible: true,
            similarityScore: 1.0,
            centerPoint: { x: 50, y: 50 }
          }
        ];
      })
    };

    const targetDesc = 'submit button';
    const result = await pruner.prune(mockPage, targetDesc);

    expect(mockPage.evaluate).toHaveBeenCalledTimes(1);
    
    // Verify it correctly returned the mapped array
    expect(result.length).toBe(1);
    expect(result[0].kaizenId).toBe('kz-1');
    expect(result[0].role).toBe('button');
    expect(result[0].attributes).toMatchObject({ id: 'submit-btn' });
  });
});

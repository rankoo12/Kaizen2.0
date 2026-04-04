import { LogNotifier } from '../notifier/log.notifier';
import type { EscalationPayload } from '../notifier/interfaces';

describe('LogNotifier', () => {
  const mockObs = { log: jest.fn(), increment: jest.fn(), startSpan: jest.fn(), histogram: jest.fn() };

  afterEach(() => jest.clearAllMocks());

  it('logs the escalation payload via observability', async () => {
    const notifier = new LogNotifier(mockObs as any);
    const payload: EscalationPayload = {
      tenantId: 't1',
      runId: 'r1',
      stepText: 'click submit',
      failureClass: 'ELEMENT_REMOVED',
      strategiesAttempted: ['FallbackSelectorStrategy', 'AdaptiveWaitStrategy'],
    };

    await notifier.notifyEscalation(payload);

    expect(mockObs.log).toHaveBeenCalledWith(
      'warn',
      'escalation.notified',
      expect.objectContaining({
        tenantId: 't1',
        runId: 'r1',
        failureClass: 'ELEMENT_REMOVED',
      }),
    );
  });

  it('does not throw on repeated calls', async () => {
    const notifier = new LogNotifier(mockObs as any);
    const payload: EscalationPayload = { tenantId: 't2', runId: 'r2', stepText: 'navigate', failureClass: 'TIMING', strategiesAttempted: [] };
    await expect(notifier.notifyEscalation(payload)).resolves.toBeUndefined();
    await expect(notifier.notifyEscalation(payload)).resolves.toBeUndefined();
  });
});

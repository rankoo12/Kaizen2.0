import type { INotifier, EscalationPayload } from './interfaces';
import type { IObservability } from '../../observability/interfaces';

/**
 * LogNotifier — stub implementation of INotifier for Phase 3.
 *
 * Logs the escalation event via IObservability. Replace or extend with a real
 * provider (Slack, email, webhook) once tenant notification settings are in the DB.
 *
 * See: src/modules/healing-engine/notifier/interfaces.ts for provider guidance.
 */
export class LogNotifier implements INotifier {
  constructor(private readonly observability: IObservability) {}

  async notifyEscalation(payload: EscalationPayload): Promise<void> {
    this.observability.log('warn', 'escalation.notified', {
      tenantId: payload.tenantId,
      runId: payload.runId,
      stepText: payload.stepText,
      failureClass: payload.failureClass,
      strategiesAttempted: payload.strategiesAttempted.join(', '),
      note: 'INotifier is a stub — configure a real provider in tenant notification settings',
    });
  }
}

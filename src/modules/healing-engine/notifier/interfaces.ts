/**
 * INotifier — abstraction for outbound tenant notifications.
 *
 * Phase 3 status: STUB — EscalationStrategy logs only.
 *
 * Where to add a real provider:
 *   Per-tenant configuration stored in the DB (a future `tenant_notification_settings`
 *   table or a JSONB column on `tenants`). Each tenant configures their own channel
 *   (Slack webhook, email, PagerDuty) via the Settings page in the UI — NOT via .env,
 *   because .env is platform-wide and tenants must not share notification credentials.
 *
 *   Suggested tenant settings shape:
 *   {
 *     "notifier": {
 *       "provider": "slack" | "email" | "webhook",
 *       "slack": { "webhookUrl": "https://hooks.slack.com/..." },
 *       "email": { "to": ["team@example.com"] },
 *       "webhook": { "url": "https://ci.example.com/kaizen-hook" }
 *     }
 *   }
 *
 *   Implement SlackNotifier, EmailNotifier, WebhookNotifier separately and inject
 *   the right one based on tenant settings at runtime.
 */
export interface INotifier {
  /**
   * Notify the tenant that a test step could not be healed automatically
   * and requires human review.
   */
  notifyEscalation(payload: EscalationPayload): Promise<void>;
}

export type EscalationPayload = {
  tenantId: string;
  runId: string;
  stepText: string;
  failureClass: string;
  strategiesAttempted: string[];
};

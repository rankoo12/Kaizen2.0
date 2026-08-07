# Spec — Run Notifications & Bug Creation (webhook + Slack)

Created: 2026-07-29
Branch: `feat/test-writer/p0-specs`
Status: Draft — design agreed; implementation not started.

> Implements and AMENDS `../core/kaizen-phase5-spec.md` §3 (webhooks) — it does
> not fork it. Amendments: migration renumbered (phase-5 says `007`, actual is
> `030`), a `kind` column for provider formatting, and an expanded event list.
> Fulfills the existing `INotifier` seam
> (`src/modules/healing-engine/notifier/interfaces.ts`), replacing the
> log-only stub. Independent of the Test Writer pillar — ships in parallel.

## 1. Motivation

A QA engineer who finds a bug files a report a developer can act on. Kaizen
today logs escalations and moves on (`LogNotifier`). This spec turns run
failures and healing escalations into delivered, enriched notifications:
generic signed webhooks and Slack messages first; Jira / GitHub Issues later
as additional formatters with zero producer changes.

## 2. Data model (migration `030_notifications.sql`)

Phase-5 §3 table, plus `kind`:

```sql
CREATE TABLE webhooks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  url        TEXT NOT NULL,
  secret     TEXT NOT NULL,               -- HMAC signature key
  kind       TEXT NOT NULL DEFAULT 'generic'
               CHECK (kind IN ('generic', 'slack')),
  events     TEXT[] NOT NULL,             -- subset of the §3 event list
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- + RLS tenant_isolation, index (tenant_id, is_active)
```

A Slack incoming webhook IS a webhook URL with a different payload format —
one table, one delivery service, per-`kind` formatters. Future Jira/GitHub =
new `kind` values (+ their config in a JSONB column added then).

## 3. Events

| Event | Producer | When |
|---|---|---|
| `run.completed` | worker (`markRunComplete` path, `src/workers/worker.ts`) | terminal status reached (any) |
| `run.failed` | worker | terminal status `failed` |
| `run.escalated` | `EscalationStrategy` via `QueueNotifier` | healing exhausted all strategies |
| `case.suggested` | Test Writer job completion | drafts proposed for review |

## 4. Queue & service

- Queue: `NOTIFICATIONS_QUEUE_NAME = process.env.KAIZEN_WEBHOOKS_QUEUE ?? 'kaizen-webhooks'`
  (phase-5's name) in `src/queue/index.ts`. Standard options; 3 attempts,
  exponential backoff.
- Payload on the wire is **thin** — producers stay fast; enrichment happens at
  delivery:

```ts
export type NotificationJobData = {
  tenantId: string;
  event: 'run.completed' | 'run.failed' | 'run.escalated' | 'case.suggested';
  runId?: string;
  caseId?: string;
  escalation?: EscalationPayload;   // existing type, healing-engine notifier
};
```

- Module `src/modules/notifications/`:
  - `interfaces.ts` — types above + `INotificationFormatter`.
  - `payload-builder.ts` — delivery-time enrichment: run + case names, the
    failing `step_results` row (step text via `step_id` join, `failure_class`,
    `error_type`, `error_message`), healing attempts from `healing_events`,
    screenshot links via the tenant-scoped `/media?key=` route pattern
    (`src/api/routes/runs.ts:712`), deep link to the run report page.
  - `webhook.notifier.ts` — generic JSON POST, signed
    `x-kaizen-signature: sha256=HMAC(body, secret)` (phase-5 contract).
  - `slack.notifier.ts` — Block Kit message: case name, status, failure class,
    failing step text, screenshot link, "View run" button.
  - `queue.notifier.ts` — an `INotifier` implementation that just enqueues;
    injected into `EscalationStrategy` in place of `LogNotifier`
    (`src/workers/worker.ts` wiring, `escalation.strategy.ts` untouched).
- Service seam: `src/services/notifications/index.ts` + Dockerfile
  `Dockerfile.notifications` (node:20-slim — no Playwright) + compose entry +
  `dev:notifications` / `start:notifications` scripts. Consumer fans out one
  delivery per active webhook row matching the event; per-delivery retry, a
  failed delivery never blocks another.

## 5. Tenant configuration API

`src/api/routes/webhooks.ts` (JWT, tenant-scoped CRUD):
- `GET /webhooks`, `POST /webhooks` (url, kind, events; secret generated
  server-side and returned ONCE), `PATCH /webhooks/:id` (events, is_active),
  `DELETE /webhooks/:id`, `POST /webhooks/:id/test` (sends a synthetic
  `run.failed` sample).
- Secrets stored like API keys (hashed/encrypted at rest per existing identity
  patterns); never returned after creation.

## 6. Delivery payload (generic `kind`)

```jsonc
{
  "event": "run.failed",
  "runId": "…", "caseId": "…", "caseName": "Checkout happy path",
  "suiteId": "…", "status": "failed", "durationMs": 41200,
  "failure": {
    "stepIndex": 3, "stepText": "click the 'Proceed to payment' button",
    "failureClass": "ELEMENT_REMOVED", "errorType": "…", "errorMessage": "…",
    "screenshotUrl": "https://…/media?key=…",
    "healingAttempted": ["fallback-selector", "adaptive-wait", "resolve-and-retry"]
  },
  "reportUrl": "https://…/tests/runs/…",
  "timestamp": "2026-07-29T12:00:00Z"
}
```

`run.escalated` adds the `EscalationPayload` fields; `case.suggested` carries
job id, suite, counts, and the review deep link.

## 7. Testing

- Unit: payload-builder against fixture rows (failed run with healing events);
  HMAC signature round-trip; Slack formatter snapshot; fan-out delivers to
  matching-event rows only; retry/backoff on 5xx, no retry on 4xx (except
  429).
- Live (P4 exit): register a webhook (e.g. local echo server + a real Slack
  test channel), force a failing run, verify delivery with valid signature and
  a Slack message containing failing step, failure class, and a working
  screenshot link.

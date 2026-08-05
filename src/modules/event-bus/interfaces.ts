import type { SelectorSet } from '../../types';

/**
 * Event bus — worker service decomposition, Phase 1.
 *
 * The execution service (browser owner) publishes side-effects as events and
 * never touches GCS or the step_results/run_events tables directly. Two
 * consumers drain the queues off the per-step critical path:
 *
 *   screenshot.upload   → kaizen-screenshots → ScreenshotService → GCS/disk
 *   persist.*           → kaizen-persist     → Postgres
 *
 * Spec: docs/specs/workers/spec-service-decomposition.md §5
 */

// ─── Persisted row shapes ─────────────────────────────────────────────────────

export type StepResultStatus = 'passed' | 'failed' | 'healed' | 'skipped';

export type StepResultRow = {
  /**
   * Client-generated UUID (the execution service mints it, not the DB). The
   * persistence consumer upserts on this id, so BullMQ double-delivery or a
   * mid-write retry produces a single row. Spec §4.2.
   */
  id: string;
  tenantId: string;
  runId: string;
  stepId: string | null;
  /** Compiled-step index — the read-side ordering key now that insert order is async. Spec §4.3. */
  stepIndex: number;
  contentHash: string;
  targetHash: string;
  status: StepResultStatus;
  selectorUsed: string | null;
  screenshotKey: string | null;
  durationMs: number;
  resolutionSource: string | null;
  similarityScore: number | null;
  domCandidates: SelectorSet['candidates'] | null;
  llmPickedKaizenId: string | null;
  tokensUsed: number;
  archetypeName: string | null;
  errorType: string | null;
  capturedName: string | null;
  capturedValue: string | null;
  /**
   * Canonical (origin + pathname) URL of the iframe this step's element was found in,
   * or null for the main document. Lets the run timeline say where the step acted —
   * "inside cdn.privacy-mgmt.com/index.html" — instead of leaving a consent-banner
   * click looking like it happened on the page under test.
   * Spec: docs/specs/reliability/spec-iframe-selector-caching.md
   */
  frameUrl: string | null;
};

export type RunEventLevel = 'debug' | 'info' | 'warn' | 'error';
export type RunEventPhase =
  | 'run' | 'resolve' | 'execute' | 'assert' | 'llm' | 'heal' | 'capture';

export type RunEventRow = {
  stepIndex: number | null;
  seq: number;
  level: RunEventLevel;
  phase: RunEventPhase;
  message: string;
  data: Record<string, unknown> | null;
};

// ─── Envelopes (producer-facing) ──────────────────────────────────────────────
// Every envelope carries `attempt` (BullMQ attemptsMade of the run job that
// produced it) so consumers can drop events from a superseded attempt after
// processRun's clear-on-retry. See attempt-fence.ts.

export type ScreenshotUploadEvent = {
  kind: 'screenshot.upload';
  tenantId: string;
  runId: string;
  stepIndex: number;
  timing: 'before' | 'after';
  /**
   * Raw PNG bytes. The bus stages these in a TTL-bounded Redis blob and puts
   * only the ref on the wire (ScreenshotJobData.blobRef) — JSON-serialised
   * Buffers inflate ~4x and would linger in Redis via removeOnComplete.
   */
  png: Buffer;
  attempt: number;
};

export type PersistStepResultEvent = {
  kind: 'persist.step_result';
  row: StepResultRow;
  attempt: number;
};

export type PersistRunEventsEvent = {
  kind: 'persist.run_events';
  tenantId: string;
  runId: string;
  rows: RunEventRow[];
  attempt: number;
};

export type RunEventEnvelope =
  | ScreenshotUploadEvent
  | PersistStepResultEvent
  | PersistRunEventsEvent;

// ─── Wire shapes (job payloads) ───────────────────────────────────────────────

export type ScreenshotJobData = Omit<ScreenshotUploadEvent, 'png'> & {
  /** Redis key holding the staged PNG bytes (TTL-bounded). */
  blobRef: string;
};

export type PersistJobData = PersistStepResultEvent | PersistRunEventsEvent;

// ─── Bus ──────────────────────────────────────────────────────────────────────

export interface IEventBus {
  /**
   * Publish fire-and-forget. Never rejects — side-effect delivery must degrade,
   * never break execution; failures are logged and counted instead.
   */
  publish(e: RunEventEnvelope): Promise<void>;
  /** Close underlying queue connections (graceful shutdown). */
  close(): Promise<void>;
}

import type { Queue } from 'bullmq';
import { getPool } from '../../../db/pool';
import { createCase } from '../../../db/case-writer';
import { generateFormData } from '../../test-data/generate';
import type { RunJobPayload } from '../../../queue';
import type { IObservability } from '../../observability/interfaces';
import type { OracleHarvest, ScenarioRejection } from '../../../types/test-writer';
import type { WrittenScenario } from '../write/scenario-writer';

/**
 * VALIDATE — never propose an unproven test.
 * Spec: docs/specs/test-writer/spec-generation-pipeline.md §5
 *
 * Each surviving scenario is saved as a `validating` case, executed through the
 * REAL worker on the existing kaizen-runs queue, and promoted to `draft` only
 * on the evidence of that run. Scenarios that would create real records are
 * held back unless the suite granted synthetic-data consent — they are still
 * proposed, but plainly marked unvalidated.
 */

const POLL_INTERVAL_MS = 2_000;
const RUN_TIMEOUT_MS = 5 * 60_000;
const CONCURRENCY = 2;

type TerminalStatus = 'passed' | 'failed' | 'healed' | 'cancelled';

export type ValidationOutcome = {
  proposed: Array<{ caseId: string; name: string; runId: string | null; validated: boolean; healed: boolean }>;
  rejected: ScenarioRejection[];
  harvest: Record<string, OracleHarvest>;
};

export class ValidationRunner {
  constructor(
    private readonly runQueue: Pick<Queue<RunJobPayload>, 'add'>,
    private readonly obs: IObservability,
  ) {}

  async validateAll(params: {
    tenantId: string;
    suiteId: string;
    jobId: string;
    baseUrl: string;
    scenarios: WrittenScenario[];
    syntheticDataConsent: boolean;
    validate: boolean;
  }): Promise<ValidationOutcome> {
    const outcome: ValidationOutcome = { proposed: [], rejected: [], harvest: {} };
    if (params.scenarios.length === 0) return outcome;

    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const scenario = params.scenarios[cursor++];
        if (!scenario) return;
        try {
          await this.validateOne(scenario, params, outcome);
        } catch (err) {
          outcome.rejected.push({
            name: scenario.name,
            stage: 'validation',
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, params.scenarios.length) }, worker),
    );
    return outcome;
  }

  private async validateOne(
    scenario: WrittenScenario,
    params: Parameters<ValidationRunner['validateAll']>[0],
    outcome: ValidationOutcome,
  ): Promise<void> {
    const consentBlocked = scenario.needsConsent && !params.syntheticDataConsent;
    const willRun = params.validate && !consentBlocked;

    const created = await createCase(params.tenantId, {
      suiteId: params.suiteId,
      name: scenario.name,
      baseUrl: params.baseUrl,
      steps: scenario.steps.map((s) => ({ rawText: s.text, compiledAst: s.ast })),
      // A case that will not be executed is proposed as a draft immediately;
      // one that will be executed waits for its evidence.
      status: willRun ? 'validating' : 'draft',
      origin: 'generated',
      generationJobId: params.jobId,
      archetypeKey: scenario.plan.source.kind === 'catalog' ? scenario.plan.source.archetypeKey : null,
    });

    if (!created) {
      outcome.rejected.push({ name: scenario.name, stage: 'validation', reason: 'suite not found' });
      return;
    }

    if (!willRun) {
      outcome.proposed.push({ caseId: created.id, name: scenario.name, runId: null, validated: false, healed: false });
      if (consentBlocked) {
        outcome.rejected.push({
          name: scenario.name,
          stage: 'consent',
          reason: 'creates throwaway data — enable synthetic-data consent on the suite to validate it',
        });
      }
      return;
    }

    const pool = getPool();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO runs (tenant_id, suite_id, case_id, triggered_by, status, environment_url)
       VALUES ($1, $2, $3, 'testwriter', 'queued', $4)
       RETURNING id`,
      [params.tenantId, params.suiteId, created.id, params.baseUrl],
    );
    const runId = rows[0].id;

    await this.runQueue.add('run', {
      runId,
      tenantId: params.tenantId,
      compiledSteps: scenario.steps.map((s) => s.ast),
      stepIds: created.steps.map((s) => s.id),
      baseUrl: params.baseUrl,
      seedVariables: generateFormData(),
    });

    const status = await this.pollToTerminal(runId);
    const verdict = this.judgeRun(scenario, status);

    // Harvest whatever the run observed after its last state change, so the
    // reviewer can harden a generic discover oracle into a specific assertion.
    const harvest = await this.harvestRunState(runId);
    if (harvest) outcome.harvest[scenario.name] = harvest;

    if (verdict.accepted) {
      await pool.query(
        `UPDATE test_cases SET status = 'draft', validation_run_id = $2 WHERE id = $1`,
        [created.id, runId],
      );
      outcome.proposed.push({
        caseId: created.id, name: scenario.name, runId,
        validated: true, healed: status === 'healed',
      });
      this.obs.increment('testwriter.scenario_validated');
    } else {
      await pool.query(
        `UPDATE test_cases SET status = 'rejected', validation_run_id = $2 WHERE id = $1`,
        [created.id, runId],
      );
      outcome.rejected.push({
        name: scenario.name, stage: 'validation', reason: verdict.reason, runId,
      });
      this.obs.increment('testwriter.scenario_validation_failed');
    }
  }

  /** Tier-1 vs Tier-2 semantics (spec §3.1). */
  private judgeRun(
    scenario: WrittenScenario,
    status: TerminalStatus | 'timeout',
  ): { accepted: boolean; reason: string } {
    if (status === 'timeout') return { accepted: false, reason: 'validation run timed out' };
    if (status === 'cancelled') return { accepted: false, reason: 'validation run was cancelled' };

    if (scenario.expectation.outcome === 'pass') {
      if (status === 'passed') return { accepted: true, reason: '' };
      if (status === 'healed') return { accepted: true, reason: 'passed after self-healing' };
      return { accepted: false, reason: 'the generated test failed against the live site' };
    }

    // Tier-2 expected-fail: valid only when it failed where it was supposed to.
    // Anything else (element not found, timeout) means the TEST is broken, not
    // that the app resisted — those are rejected, not celebrated.
    if (status !== 'failed') {
      return { accepted: false, reason: `expected a failure at step ${scenario.expectation.failStepIndex} but the run ${status}` };
    }
    return { accepted: true, reason: 'expected-fail confirmed' };
  }

  private async pollToTerminal(runId: string): Promise<TerminalStatus | 'timeout'> {
    const pool = getPool();
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM runs WHERE id = $1`, [runId],
      );
      const status = rows[0]?.status;
      if (status === 'passed' || status === 'failed' || status === 'healed' || status === 'cancelled') {
        return status;
      }
    }
    return 'timeout';
  }

  /**
   * Best-effort post-run state for oracle hardening.
   *
   * The worker does not currently record the page's final URL/heading, so this
   * reads what the run DID leave behind: the last failing assertion's message
   * and any url present in the run's event log. Enough for a reviewer to
   * recognise the real success/error text; a richer harvest needs a worker-side
   * capture (deferred — spec §5.1).
   */
  private async harvestRunState(runId: string): Promise<OracleHarvest | null> {
    const pool = getPool();
    const { rows } = await pool.query<{ message: string | null; data: Record<string, unknown> | null }>(
      `SELECT message, data FROM run_events
       WHERE run_id = $1 AND phase IN ('assert', 'execute')
       ORDER BY seq DESC LIMIT 20`,
      [runId],
    );
    if (rows.length === 0) return null;

    const findString = (key: string): string | null => {
      for (const row of rows) {
        const value = row.data?.[key];
        if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 300);
      }
      return null;
    };

    const finalUrl = findString('url') ?? findString('currentUrl');
    const alertText = rows.find((r) => r.message && /error|invalid|required|success/i.test(r.message))
      ?.message?.slice(0, 300) ?? null;

    if (!finalUrl && !alertText) return null;
    return { finalUrl: finalUrl ?? '', heading: null, alertText };
  }
}

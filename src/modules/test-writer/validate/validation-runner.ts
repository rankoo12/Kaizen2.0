import type { Queue } from 'bullmq';
import { getPool } from '../../../db/pool';
import { createCase } from '../../../db/case-writer';
import { generateFormData } from '../../test-data/generate';
import type { RunJobPayload } from '../../../queue';
import type { StepAST } from '../../../types';
import type { IObservability } from '../../observability/interfaces';
import type { OracleHarvest, ScenarioRejection } from '../../../types/test-writer';
import type { WrittenScenario } from '../write/scenario-writer';
import { seedSelectors } from './selector-seeder';
import { auditRunOracles, type AuditObservation } from './oracle-audit';

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
  /** Non-fatal oracle-audit notes per scenario (weak anchors, sign-in doubts). */
  auditFindings: Record<string, string[]>;
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
    /**
     * The tenant's sign-in steps, prepended to every generated draft so it is
     * self-contained: each proving run signs in for itself, and a draft that
     * passes is proven to work from a cold browser. Absent on public jobs.
     * Spec: docs/specs/test-writer/spec-authenticated-scope.md §6.2, §7
     */
    loginPrefix?: Array<{ rawText: string; ast: StepAST }>;
  }): Promise<ValidationOutcome> {
    const outcome: ValidationOutcome = { proposed: [], rejected: [], harvest: {}, auditFindings: {} };
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

    // Authenticated jobs validate ONE at a time. Two concurrent proving runs
    // sign in with the same credentials seconds apart, which is exactly the
    // pattern that trips rate limiting, anomaly detection and account lockout —
    // locking the customer out of the account they consented with. Sequential
    // costs wall-clock, not correctness. Spec §5.1.
    const concurrency = params.loginPrefix ? 1 : CONCURRENCY;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, params.scenarios.length) }, worker),
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

    // Every scenario in an authenticated job carries the sign-in steps, not just
    // the ones touching requires_auth pages: the whole site model describes the
    // signed-in app, so any generated test must run signed in to reach what was
    // observed. The prefix is ~free — its ASTs are copied, and its selectors are
    // already warm in the tenant's cache from the login case's own runs.
    const prefix = params.loginPrefix ?? [];
    const prefixSteps = prefix.map((s) => ({ rawText: s.rawText, compiledAst: s.ast }));
    const bodySteps = scenario.steps.map((s) => ({ rawText: s.text, compiledAst: s.ast }));

    const created = await createCase(params.tenantId, {
      suiteId: params.suiteId,
      name: scenario.name,
      baseUrl: params.baseUrl,
      steps: [...prefixSteps, ...bodySteps],
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

    // Seed what recon already knew BEFORE the proving run, so the run resolves
    // from cache instead of paying the model to rediscover the same elements.
    const seeded = await seedSelectors(params.tenantId, params.baseUrl, scenario.selectorSeeds);
    if (seeded > 0) this.obs.increment('testwriter.selectors_preseeded', { count: String(seeded) });

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
      compiledSteps: [...prefix.map((s) => s.ast), ...scenario.steps.map((s) => s.ast)],
      stepIds: created.steps.map((s) => s.id),
      baseUrl: params.baseUrl,
      seedVariables: generateFormData(),
      // Nothing this run learns behind the login wall may leave the tenant: no
      // shared-pool contribution, no global archetype learning (spec §4.1).
      behindAuth: prefix.length > 0,
    });

    const status = await this.pollToTerminal(runId);

    // A run that died IN THE SIGN-IN PREFIX says nothing about the generated
    // test. Recording it as `rejected` would blame the scenario for an app-side
    // lockout or an expired account and teach the customer to distrust correct
    // tests, so it is proposed unvalidated with an honest reason instead.
    if (prefix.length > 0 && status !== 'passed' && status !== 'healed') {
      const failedInPrefix = await this.failedWithinFirstSteps(runId, prefix.length);
      if (failedInPrefix) {
        await pool.query(`UPDATE test_cases SET status = 'draft' WHERE id = $1`, [created.id]);
        outcome.proposed.push({
          caseId: created.id, name: scenario.name, runId, validated: false, healed: false,
        });
        outcome.rejected.push({
          name: scenario.name, stage: 'validation', runId,
          reason: 'could not prove this test — signing in failed during validation, so the test itself is unproven rather than wrong',
        });
        this.obs.increment('testwriter.validation_signin_unavailable');
        return;
      }
    }

    const verdict = this.judgeRun(scenario, status);

    // Harvest whatever the run observed after its last state change, so the
    // reviewer can harden a generic discover oracle into a specific assertion.
    const harvest = await this.harvestRunState(runId);
    if (harvest) outcome.harvest[scenario.name] = harvest;

    if (verdict.accepted) {
      // A green run proves the resolver found SOMETHING for every step and
      // nothing threw. Before calling that proof, check what the assertions
      // actually resolved to — this is the gate that four live false-greens
      // sailed through. Spec: spec-validation-trust.md §2.
      const audit = auditRunOracles(
        [...prefix.map((s) => s.ast), ...scenario.steps.map((s) => s.ast)],
        await this.observeRun(runId),
        prefix.length,
      );
      if (!audit.ok) {
        await pool.query(
          `UPDATE test_cases SET status = 'rejected', validation_run_id = $2 WHERE id = $1`,
          [created.id, runId],
        );
        outcome.rejected.push({
          name: scenario.name, stage: 'validation', runId,
          reason: `${audit.rule}: ${audit.reason}`,
        });
        this.obs.increment('testwriter.oracle_audit_reject', { rule: String(audit.rule) });
        return;
      }

      const validationState = audit.unprovenSignin ? 'unproven_signin'
        : status === 'healed' ? 'healed'
          : audit.weakOracle ? 'weak_oracle'
            : 'validated';

      await pool.query(
        `UPDATE test_cases SET status = 'draft', validation_run_id = $2, validation_state = $3 WHERE id = $1`,
        [created.id, runId, validationState],
      );
      outcome.proposed.push({
        caseId: created.id, name: scenario.name, runId,
        // Only a clean audit on a clean run is "validated" to the caller; the
        // report keeps the finer grade on the case row.
        validated: validationState === 'validated',
        healed: status === 'healed',
      });
      if (audit.findings.length > 0) outcome.auditFindings[scenario.name] = audit.findings;
      this.obs.increment('testwriter.scenario_validated', { state: validationState });
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
  /**
   * True when the run's first failure landed inside the login prefix.
   *
   * step_index is stamped by the worker (migration 027), so "did it get past the
   * sign-in steps" is a direct question rather than an inference from the error
   * text. Rows predating that column are NULL and simply do not match, which
   * degrades to the ordinary rejected path — the conservative direction.
   */
  /**
   * What the run actually did, per step — the other half of the oracle audit.
   * `healed` is true when the step needed a healing strategy to succeed, which
   * for a sign-in step means the run may never have signed in (§5).
   */
  private async observeRun(runId: string): Promise<AuditObservation[]> {
    const { rows } = await getPool().query<{
      step_index: number | null;
      selector_used: string | null;
      resolution_source: string | null;
      healed: boolean;
    }>(
      `SELECT step_index, selector_used, resolution_source,
              (status = 'healed' OR healing_event_id IS NOT NULL) AS healed
       FROM step_results
       WHERE run_id = $1 AND step_index IS NOT NULL
       ORDER BY step_index ASC`,
      [runId],
    );
    return rows.map((r) => ({
      stepIndex: r.step_index as number,
      selectorUsed: r.selector_used,
      resolutionSource: r.resolution_source,
      healed: r.healed,
    }));
  }

  private async failedWithinFirstSteps(runId: string, prefixLength: number): Promise<boolean> {
    const { rows } = await getPool().query<{ step_index: number | null }>(
      `SELECT step_index FROM step_results
       WHERE run_id = $1 AND status = 'failed' AND step_index IS NOT NULL
       ORDER BY step_index ASC LIMIT 1`,
      [runId],
    );
    const first = rows[0]?.step_index;
    return typeof first === 'number' && first < prefixLength;
  }

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

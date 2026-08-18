import type { Queue } from 'bullmq';
import { tenantPool, tenantQuery } from '../../../db/transaction';
import { createCase } from '../../../db/case-writer';
import { generateFormData } from '../../test-data/generate';
import type { RunJobPayload } from '../../../queue';
import type { StepAST } from '../../../types';
import type { IObservability } from '../../observability/interfaces';
import type { Finding, OracleHarvest, ScenarioRejection } from '../../../types/test-writer';
import { appDefectFinding, sideChannelFinding } from '../findings';
import type { WrittenScenario } from '../write/scenario-writer';
import { seedSelectors } from './selector-seeder';
import { auditRunOracles, planVacuityProbe, type AuditObservation } from './oracle-audit';

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

/**
 * The failure classes that mean THE APP REFUSED, as opposed to the test falling
 * over on its way to finding out. Only these can confirm a Tier-2 negative:
 * LOGIC_FAILURE is "the element was there and the expectation did not hold",
 * while ELEMENT_REMOVED / OBSCURED / PAGE_NOT_LOADED / TIMING all describe a
 * test that never got far enough to observe the app's answer.
 * Spec: docs/specs/test-writer/spec-validation-trust.md §7
 */
const ASSERTION_FAILURE_CLASSES = new Set(['LOGIC_FAILURE']);

/**
 * The same judgement expressed as an error type rather than a failure class.
 * A delta-scoped oracle that failed because NOTHING CHANGED never reached the
 * classifier — the worker short-circuits before the engine — but "the click did
 * nothing" is the app declining in the plainest possible terms, and it is the
 * reading the customer needs. Spec: spec-oracle-delta-and-fidelity.md §5
 */
function isAssertionFailure(failure: { failureClass: string | null; errorType: string | null }): boolean {
  return ASSERTION_FAILURE_CLASSES.has(failure.failureClass ?? '')
    || (failure.errorType ?? '').startsWith('Assertion');
}

type TerminalStatus = 'passed' | 'failed' | 'healed' | 'cancelled';

export type ValidationOutcome = {
  proposed: Array<{ caseId: string; name: string; runId: string | null; validated: boolean; healed: boolean }>;
  rejected: ScenarioRejection[];
  harvest: Record<string, OracleHarvest>;
  /** Non-fatal oracle-audit notes per scenario (weak anchors, sign-in doubts). */
  auditFindings: Record<string, string[]>;
  /**
   * What this validation phase noticed about the APP rather than about the
   * tests. Spec: docs/specs/test-writer/spec-findings-and-coverage.md
   */
  findings: Finding[];
  /**
   * The executed sign-in proof (spec-validation-trust §5, amended 2026-08-18):
   * did the login recipe's own final assertion FAIL when run signed out?
   * 'private' = yes (a green run witnessed a session), 'public' = it held
   * signed out too, 'inconclusive' = the probe could not run. Absent on public jobs.
   */
  signinProbe?: 'private' | 'public' | 'inconclusive';
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
    /**
     * False when the login recipe's own final assertion cannot distinguish a
     * signed-in page from the login page. Every draft from this job is then
     * proposed but never labelled proven — the scenario may be fine, we simply
     * have no evidence the session existed. Spec: spec-validation-trust.md §5.
     */
    signinAssertionProves?: boolean;
  }): Promise<ValidationOutcome> {
    const outcome: ValidationOutcome = {
      proposed: [], rejected: [], harvest: {}, auditFindings: {}, findings: [],
    };
    if (params.scenarios.length === 0) return outcome;

    // Executed evidence for the sign-in premise, once per job. The static
    // lookup ("does the crawl record the asserted element as private?") is
    // blind on an authenticated-only analysis, where every page is an assumed
    // private page and a url/heading assertion names no element at all — three
    // green saucedemo drafts were labelled unproven for exactly that. Running
    // the recipe's terminal assertion signed out answers the real question.
    let signinAssertionProves = params.signinAssertionProves;
    const prefixForProbe = params.loginPrefix ?? [];
    if (prefixForProbe.length > 0 && params.validate) {
      const probe = await this.probeSigninAssertionIsPrivate(params, prefixForProbe);
      outcome.signinProbe = probe;
      if (probe === 'private') signinAssertionProves = true;
      else if (probe === 'public') signinAssertionProves = false;
      // inconclusive: the static answer stands.
      this.obs.log('info', 'testwriter.signin_probe', {
        jobId: params.jobId, probe, staticSaysPrivate: params.signinAssertionProves === true,
      });
    }
    const effective = { ...params, signinAssertionProves };

    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const scenario = params.scenarios[cursor++];
        if (!scenario) return;
        try {
          await this.validateOne(scenario, effective, outcome);
        } catch (err) {
          outcome.rejected.push({
            name: scenario.name, steps: scenario.steps.map((s) => s.text),
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
      // Say WHY it is a draft from the moment it exists, rather than leaving
      // "consent withheld" and "never run" indistinguishable until someone
      // reads the job report.
      validationState: willRun ? null : (consentBlocked ? 'consent_held' : 'unvalidated'),
      expectedOutcome: scenario.expectation.outcome,
    });

    if (!created) {
      outcome.rejected.push({ name: scenario.name, steps: scenario.steps.map((s) => s.text), stage: 'validation', reason: 'suite not found' });
      return;
    }

    if (!willRun) {
      outcome.proposed.push({ caseId: created.id, name: scenario.name, runId: null, validated: false, healed: false });
      if (consentBlocked) {
        outcome.rejected.push({
          name: scenario.name, steps: scenario.steps.map((s) => s.text),
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

    const pool = tenantPool(params.tenantId);
    // One draw of the seed variables for the whole validation, retries included:
    // "proven" has to mean proven with values we can name, and a second draw on
    // retry would make the recorded seed a lie about what actually ran.
    const seedVariables = generateFormData();

    const execute = async (): Promise<{ runId: string; status: TerminalStatus | 'timeout' }> => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO runs (tenant_id, suite_id, case_id, triggered_by, status, environment_url)
         VALUES ($1, $2, $3, 'testwriter', 'queued', $4)
         RETURNING id`,
        [params.tenantId, params.suiteId, created.id, params.baseUrl],
      );
      const id = rows[0].id;

      await this.runQueue.add('run', {
        runId: id,
        tenantId: params.tenantId,
        compiledSteps: [...prefix.map((s) => s.ast), ...scenario.steps.map((s) => s.ast)],
        stepIds: created.steps.map((s) => s.id),
        baseUrl: params.baseUrl,
        seedVariables,
        // Nothing this run learns behind the login wall may leave the tenant: no
        // shared-pool contribution, no global archetype learning (spec §4.1).
        behindAuth: prefix.length > 0,
        // A proving run must not teach the cache where an ORACLE's anchor lives,
        // and may not be certified by an assertion heal (§9).
        triggeredBy: 'testwriter',
      });

      return { runId: id, status: await this.pollToTerminal(params.tenantId, id) };
    };

    let { runId, status } = await execute();

    // Flake policy. One failure is not evidence of a bad test any more than one
    // pass is evidence of a good one — a slow page or a cold cache fails a
    // perfectly sound scenario, and rejecting it permanently on that basis
    // throws away real work. Retried exactly once, and a scenario that needed
    // the retry is proposed as `flaky` rather than quietly as proven.
    let flaky = false;
    const expectsPass = scenario.expectation.outcome === 'pass';
    if (expectsPass && (status === 'failed' || status === 'timeout')) {
      const retry = await execute();
      if (retry.status === 'passed' || retry.status === 'healed') {
        flaky = true;
        this.obs.increment('testwriter.validation_flaky');
      }
      runId = retry.runId;
      status = retry.status;
    }

    // A run that died IN THE SIGN-IN PREFIX says nothing about the generated
    // test. Recording it as `rejected` would blame the scenario for an app-side
    // lockout or an expired account and teach the customer to distrust correct
    // tests, so it is proposed unvalidated with an honest reason instead.
    if (prefix.length > 0 && status !== 'passed' && status !== 'healed') {
      const failedInPrefix = await this.failedWithinFirstSteps(params.tenantId, runId, prefix.length);
      if (failedInPrefix) {
        await pool.query(
          `UPDATE test_cases SET status = 'draft', validation_state = 'unproven_signin' WHERE id = $1`,
          [created.id],
        );
        outcome.proposed.push({
          caseId: created.id, name: scenario.name, runId, validated: false, healed: false,
        });
        outcome.rejected.push({
          name: scenario.name, steps: scenario.steps.map((s) => s.text), stage: 'validation', runId,
          reason: 'could not prove this test — signing in failed during validation, so the test itself is unproven rather than wrong',
        });
        this.obs.increment('testwriter.validation_signin_unavailable');
        return;
      }
    }

    const verdict = await this.judgeRun(params.tenantId, scenario, status, runId, prefix.length);

    // Harvest whatever the run observed after its last state change, so the
    // reviewer can harden a generic discover oracle into a specific assertion.
    const harvest = await this.harvestRunState(params.tenantId, runId);
    if (harvest) outcome.harvest[scenario.name] = harvest;

    if (verdict.accepted) {
      // A green run proves the resolver found SOMETHING for every step and
      // nothing threw. Before calling that proof, check what the assertions
      // actually resolved to — this is the gate that four live false-greens
      // sailed through. Spec: spec-validation-trust.md §2.
      const audit = auditRunOracles(
        [...prefix.map((s) => s.ast), ...scenario.steps.map((s) => s.ast)],
        await this.observeRun(params.tenantId, runId),
        prefix.length,
      );
      // A GREEN run is the user's call. The audit and the vacuity probe below
      // used to write status='rejected' on a case that had just passed — the
      // founder's rule is the opposite: if it ran green, the human decides,
      // with the honest label in front of them. Both now land as drafts under
      // "needs a decision"; the report still carries the finding.
      // Spec: spec-validation-trust.md §3/§6 (amended 2026-08-18)
      const auditFailed = !audit.ok;
      if (auditFailed) {
        this.obs.increment('testwriter.oracle_audit_flag', { rule: String(audit.rule) });
        (outcome.auditFindings[scenario.name] ??= []).push(`${audit.rule}: ${audit.reason}`);
      }

      // The audit reads what the run recorded; the probe asks the page itself.
      // An oracle can be perfectly faithful — the right element, the right
      // words — and still be true before the scenario did anything. Running the
      // assertion with the ACTIONS REMOVED is the only way to find that out.
      const vacuous = auditFailed
        ? false   // one honest label is enough; the browser-minute is not
        : await this.probeIsVacuous(scenario, params, prefix, created.steps);
      if (vacuous) {
        this.obs.increment('testwriter.oracle_vacuous_executed');
        (outcome.auditFindings[scenario.name] ??= []).push(
          'oracle_vacuous_executed: the final check already passed without the scenario’s actions',
        );
      }

      const signinUnproven = audit.unprovenSignin
        || (prefix.length > 0 && params.signinAssertionProves === false);
      const validationState = signinUnproven ? 'unproven_signin'
        : vacuous ? 'vacuous_oracle'
          : auditFailed ? 'weak_oracle'
            : status === 'healed' ? 'healed'
              : flaky ? 'flaky'
                : audit.weakOracle ? 'weak_oracle'
                  : 'validated';

      await pool.query(
        `UPDATE test_cases SET status = 'draft', validation_run_id = $2, validation_state = $3,
                validation_seed = $4
         WHERE id = $1`,
        [created.id, runId, validationState, JSON.stringify(seedVariables)],
      );
      outcome.proposed.push({
        caseId: created.id, name: scenario.name, runId,
        // Only a clean audit on a clean run is "validated" to the caller; the
        // report keeps the finer grade on the case row.
        validated: validationState === 'validated',
        healed: status === 'healed',
      });
      if (audit.findings.length > 0) {
        (outcome.auditFindings[scenario.name] ??= []).push(...audit.findings);
      }
      // The test passed. That does not mean the page was healthy while it did.
      if (harvest) {
        const sideChannel = sideChannelFinding({
          scenarioName: scenario.name,
          runId,
          caseId: created.id,
          finalUrl: harvest.finalUrl,
          consoleErrorCount: harvest.consoleErrorCount ?? 0,
          httpErrorCount: harvest.httpErrorCount ?? 0,
        });
        if (sideChannel) outcome.findings.push(sideChannel);
      }
      this.obs.increment('testwriter.scenario_validated', { state: validationState });
    } else {
      await pool.query(
        `UPDATE test_cases SET status = 'rejected', validation_run_id = $2 WHERE id = $1`,
        [created.id, runId],
      );
      outcome.rejected.push({
        name: scenario.name, steps: scenario.steps.map((s) => s.text), stage: 'validation', reason: verdict.reason, runId,
      });
      // Everything reaching validation already passed the quality judge. So a
      // red run here has two possible readings, and the pipeline has only ever
      // recorded one of them: "our test is wrong". When the failure is
      // assertion-class — the element was found and the app simply did not do
      // what the test expected — the other reading is at least as likely, and
      // it is the one the customer needs. Without this, a scenario that probes
      // for an injection and goes red BECAUSE THE APP IS VULNERABLE is filed as
      // Kaizen's mistake and deleted.
      const failure = await this.firstFailure(params.tenantId, runId);
      if (status === 'failed' && failure && isAssertionFailure(failure)) {
        outcome.findings.push(appDefectFinding({
          scenarioName: scenario.name,
          runId,
          caseId: created.id,
          steps: scenario.steps.map((st) => st.text),
          reason: failure.errorType === 'AssertionNothingChanged'
            ? `At step ${failure.stepIndex + 1} the page did not change at all after the action — `
              + 'the control responded to nothing.'
            : `It failed at step ${failure.stepIndex + 1}.`,
        }));
        this.obs.increment('testwriter.possible_app_defect');
      }
      this.obs.increment('testwriter.scenario_validation_failed');
    }
  }

  /** Tier-1 vs Tier-2 semantics (spec §3.1, hardened by spec-validation-trust §7). */
  private async judgeRun(
    tenantId: string,
    scenario: WrittenScenario,
    status: TerminalStatus | 'timeout',
    runId: string,
    prefixLength: number,
  ): Promise<{ accepted: boolean; reason: string }> {
    if (status === 'timeout') return { accepted: false, reason: 'validation run timed out' };
    if (status === 'cancelled') return { accepted: false, reason: 'validation run was cancelled' };

    if (scenario.expectation.outcome === 'pass') {
      if (status === 'passed') return { accepted: true, reason: '' };
      if (status === 'healed') return { accepted: true, reason: 'passed after self-healing' };
      // "failed against the live site" tells a reader nothing they can act on.
      // The two delta verdicts are precisely the ones worth spelling out: one
      // says the app did nothing, the other says Kaizen could not look.
      // Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §1
      const failure = await this.firstFailure(tenantId, runId);
      if (failure?.errorType === 'AssertionNothingChanged') {
        return {
          accepted: false,
          reason: `at step ${failure.stepIndex + 1} nothing on the page changed after the action, `
            + 'so the check had nothing real to find',
        };
      }
      if (failure?.errorType === 'DialogOnlyChange') {
        return {
          accepted: false,
          reason: `at step ${failure.stepIndex + 1} the only thing that happened was a browser dialog, `
            + 'which Kaizen answers automatically — its contents cannot be checked',
        };
      }
      return { accepted: false, reason: 'the generated test failed against the live site' };
    }

    // Tier-2 expected-fail. Accepting any failure at all was the bug: a negative
    // test whose FIRST step could not resolve its element "confirmed" a
    // rejection the app never performed, and shipped as proof the app defends
    // itself. The failure has to land where the scenario said it would, and be
    // the app refusing — not the test falling over on the way there.
    if (status !== 'failed') {
      return { accepted: false, reason: `expected a failure at step ${scenario.expectation.failStepIndex} but the run ${status}` };
    }

    const first = await this.firstFailure(tenantId, runId);
    if (!first) {
      return { accepted: false, reason: 'the run failed but recorded no failing step, so the expected failure cannot be confirmed' };
    }

    // failStepIndex is BODY-relative; step_results counts the sign-in prefix.
    const expectedIndex = prefixLength + scenario.expectation.failStepIndex;
    if (first.stepIndex !== expectedIndex) {
      return {
        accepted: false,
        reason: `expected the failure at step ${expectedIndex + 1} but the run first failed at step ${first.stepIndex + 1}`,
      };
    }

    // An assertion that failed is the app declining. A selector that could not
    // be found, a timeout, a navigation error — those are the test breaking, and
    // they prove nothing about the app's behaviour.
    if (!isAssertionFailure(first)) {
      return {
        accepted: false,
        reason: `the run failed at the expected step but for a ${first.failureClass ?? first.errorType ?? 'non-assertion'} reason — the test broke rather than the app refusing`,
      };
    }

    return { accepted: true, reason: 'expected-fail confirmed at the expected step' };
  }

  /**
   * Run the scenario with its ACTIONS REMOVED and see whether the oracle still
   * holds. Spec: docs/specs/test-writer/spec-validation-trust.md §3
   *
   * The probe keeps the sign-in prefix and the navigations — everything that
   * establishes WHERE the assertion looks — and drops every click, keystroke and
   * keypress, so it is read-only by construction and safe on any target, consent
   * or no consent. If the terminal assertion passes anyway, the scenario's
   * actions were never load-bearing: the test would stay green with the feature
   * removed, which is the definition of proving nothing.
   *
   * A probe that errors returns "not vacuous" — an inconclusive probe must never
   * be the reason a real test is thrown away.
   */
  private async probeIsVacuous(
    scenario: WrittenScenario,
    params: Parameters<ValidationRunner['validateAll']>[0],
    prefix: Array<{ rawText: string; ast: StepAST }>,
    createdSteps: Array<{ id: string }>,
  ): Promise<boolean> {
    const plan = planVacuityProbe(scenario.steps.map((s) => s.ast.action));
    if (!plan) return false;
    const { keptBodyIndexes: bodyKept, terminalIndex } = plan;
    const terminal = scenario.steps[terminalIndex];

    const compiledSteps = [
      ...prefix.map((s) => s.ast),
      ...bodyKept.map((i) => scenario.steps[i].ast),
      terminal.ast,
    ];
    const stepIds = [
      ...prefix.map((_, i) => createdSteps[i]?.id),
      ...bodyKept.map((i) => createdSteps[prefix.length + i]?.id),
      createdSteps[prefix.length + terminalIndex]?.id,
    ].filter((id): id is string => typeof id === 'string');

    try {
      const pool = tenantPool(params.tenantId);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO runs (tenant_id, suite_id, case_id, triggered_by, status, environment_url)
         VALUES ($1, $2, NULL, 'testwriter', 'queued', $3)
         RETURNING id`,
        [params.tenantId, params.suiteId, params.baseUrl],
      );
      const probeRunId = rows[0].id;

      await this.runQueue.add('run', {
        runId: probeRunId,
        tenantId: params.tenantId,
        compiledSteps,
        stepIds,
        baseUrl: params.baseUrl,
        seedVariables: generateFormData(),
        behindAuth: prefix.length > 0,
        triggeredBy: 'testwriter',
      });

      const status = await this.pollToTerminal(params.tenantId, probeRunId);
      this.obs.increment('testwriter.vacuity_probe', { status });
      // Passing WITHOUT the actions is the indictment. Failing is what a
      // discriminating oracle is supposed to do here.
      return status === 'passed' || status === 'healed';
    } catch (err) {
      this.obs.log('warn', 'testwriter.vacuity_probe_failed', {
        scenario: scenario.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * The login recipe's terminal assertion, run SIGNED OUT: its navigate steps
   * plus the assertion, no credentials, cold browser. If that fails, the
   * assertion cannot hold without a session, so every green proving run in this
   * job that reached it was signed in. Same construction as the vacuity probe
   * (§3), pointed at the prefix instead of the body.
   * Spec: spec-validation-trust.md §5 (amended 2026-08-18)
   */
  private async probeSigninAssertionIsPrivate(
    params: Parameters<ValidationRunner['validateAll']>[0],
    prefix: Array<{ rawText: string; ast: StepAST }>,
  ): Promise<'private' | 'public' | 'inconclusive'> {
    const plan = planVacuityProbe(prefix.map((s) => s.ast.action));
    if (!plan) return 'inconclusive';
    const compiledSteps = [
      ...plan.keptBodyIndexes.map((i) => prefix[i].ast),
      prefix[plan.terminalIndex].ast,
    ];
    try {
      const pool = tenantPool(params.tenantId);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO runs (tenant_id, suite_id, case_id, triggered_by, status, environment_url)
         VALUES ($1, $2, NULL, 'testwriter', 'queued', $3)
         RETURNING id`,
        [params.tenantId, params.suiteId, params.baseUrl],
      );
      const probeRunId = rows[0].id;
      await this.runQueue.add('run', {
        runId: probeRunId,
        tenantId: params.tenantId,
        compiledSteps,
        stepIds: [],
        baseUrl: params.baseUrl,
        seedVariables: generateFormData(),
        // Deliberately NOT behindAuth: this run must look like a signed-out visitor.
        behindAuth: false,
        triggeredBy: 'testwriter',
      });
      const status = await this.pollToTerminal(params.tenantId, probeRunId);
      this.obs.increment('testwriter.signin_probe', { status });
      if (status === 'failed') return 'private';
      if (status === 'passed' || status === 'healed') return 'public';
      return 'inconclusive';
    } catch (err) {
      this.obs.log('warn', 'testwriter.signin_probe_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 'inconclusive';
    }
  }

  /** The run's first failing step, with enough detail to tell WHY it failed. */
  private async firstFailure(
    tenantId: string,
    runId: string,
  ): Promise<{ stepIndex: number; failureClass: string | null; errorType: string | null } | null> {
    const { rows } = await tenantQuery<{
      step_index: number | null; failure_class: string | null; error_type: string | null;
    }>(
      tenantId,
      `SELECT step_index, failure_class, error_type FROM step_results
       WHERE run_id = $1 AND status = 'failed' AND step_index IS NOT NULL
       ORDER BY step_index ASC LIMIT 1`,
      [runId],
    );
    const row = rows[0];
    if (!row || typeof row.step_index !== 'number') return null;
    return { stepIndex: row.step_index, failureClass: row.failure_class, errorType: row.error_type };
  }

  private async pollToTerminal(tenantId: string, runId: string): Promise<TerminalStatus | 'timeout'> {
    const pool = tenantPool(tenantId);
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
  private async observeRun(tenantId: string, runId: string): Promise<AuditObservation[]> {
    const { rows } = await tenantQuery<{
      step_index: number | null;
      selector_used: string | null;
      resolution_source: string | null;
      healed: boolean;
    }>(
      tenantId,
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

  private async failedWithinFirstSteps(tenantId: string, runId: string, prefixLength: number): Promise<boolean> {
    const { rows } = await tenantQuery<{ step_index: number | null }>(
      tenantId,
      `SELECT step_index FROM step_results
       WHERE run_id = $1 AND status = 'failed' AND step_index IS NOT NULL
       ORDER BY step_index ASC LIMIT 1`,
      [runId],
    );
    const first = rows[0]?.step_index;
    return typeof first === 'number' && first < prefixLength;
  }

  private async harvestRunState(tenantId: string, runId: string): Promise<OracleHarvest | null> {
    const pool = tenantPool(tenantId);
    // The worker now records the page's closing state directly (§8). Before it
    // did, this method scavenged the event log for a url and an error-ish
    // message and almost always found neither — report.harvest was an empty
    // object in every job the product has ever run, so the "reviewer hardens
    // the oracle" rung of the ladder had nothing to stand on.
    const { rows } = await pool.query<{ data: Record<string, unknown> | null }>(
      `SELECT data FROM run_events
       WHERE run_id = $1 AND phase = 'capture' AND message = 'final page state'
       ORDER BY seq DESC LIMIT 1`,
      [runId],
    );
    const data = rows[0]?.data;
    if (!data) return null;

    const str = (key: string): string | null => {
      const value = data[key];
      return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null;
    };
    const num = (key: string): number => {
      const value = data[key];
      return typeof value === 'number' ? value : 0;
    };

    return {
      finalUrl: str('finalUrl') ?? '',
      heading: str('h1'),
      alertText: str('alertText'),
      consoleErrorCount: num('consoleErrorCount'),
      httpErrorCount: num('httpErrorCount'),
    };
  }
}

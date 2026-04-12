// ─── Shared API response types ────────────────────────────────────────────────
// These mirror the shapes returned by the Kaizen API routes.

export type Suite = {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  caseCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CaseSummary = {
  id: string;
  name: string;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
  lastRun: {
    id: string;
    status: RunStatus;
    completedAt: string | null;
    durationMs: number | null;
    totalTokens: number | null;
  } | null;
};

export type CaseDetail = CaseSummary & {
  suiteId: string;
  steps: CaseStep[];
  recentRuns: RunSummary[];
};

export type CaseStep = {
  id: string;
  position: number;
  rawText: string;
  contentHash: string;
};

export type RunStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'healed'
  | 'cancelled';

export type RunSummary = {
  id: string;
  caseId: string | null;
  caseName: string | null;
  suiteId: string | null;
  suiteName: string | null;
  status: RunStatus;
  triggeredBy: 'web' | 'api' | 'cli' | 'schedule';
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
  totalTokens: number | null;
};

export type StepResult = {
  id: string;
  stepId: string;
  status: RunStatus;
  screenshotKey: string | null;
  durationMs: number | null;
  tokens: number;
  errorType: string | null;
  failureClass: string | null;
  resolutionSource: string | null;
  createdAt: string;
};

export type RunDetail = RunSummary & {
  stepResults: StepResult[];
};

export const TERMINAL_RUN_STATUSES: RunStatus[] = [
  'passed',
  'failed',
  'healed',
  'cancelled',
];

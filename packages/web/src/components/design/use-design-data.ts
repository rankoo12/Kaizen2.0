'use client';
/* Real-data adapter for the native design. Composes the app's existing hooks
   (useSuites / useAllCases / useAuth) and maps the real API shapes into the shapes
   the design screens expect. Fields the API does not expose (per-case step count,
   per-case cache %) are dropped rather than faked; "from memory" is derived honestly
   from real token cost (a last run that spent 0 tokens resolved entirely from memory). */
import { useMemo } from 'react';
import { useSuites } from '@/hooks/use-suites';
import { useAllCases } from '@/hooks/use-all-cases';
import { useAuth } from '@/context/auth-context';
import type { CaseOrigin, CaseStatus, CaseSummary, Suite } from '@/types/api';

export type DesignCase = {
  id: string;
  suiteId: string;
  suiteName: string;
  name: string;
  baseUrl: string;
  status: string;
  lastCost: number | null; // tokens; null = never run
  durationMs: number | null;
  lastRun: string; // relative time; '' = never run
  runId: string | null;
  hasRun: boolean;
  /** Display name of whoever wrote the test; '' when unknown (pre-030 cases, or a case
   *  created through an API key). Empty renders as nothing, never as "Unknown". */
  author: string;
  /** % of this case's element lookups answered from memory. Null = never looked
   *  anything up, which must not render as 0%. */
  cacheHitPct: number | null;
  /** Tokens the first run spent learning; null when it has never run. */
  firstRunTokens: number | null;
  runCount: number;
  /** Draft lifecycle. Anything Kaizen proposed sits here until a human accepts it. */
  caseStatus: CaseStatus;
  origin: CaseOrigin;
  /** The run that proved a generated draft — its evidence, and the reason to trust it. */
  validationRunId: string | null;
  archetypeKey: string | null;
};

export type DesignSuite = { id: string; name: string; desc: string; icon: string; count: number };

const SUITE_ICON_CYCLE = ['keys', 'bolt', 'search', 'settings', 'globe', 'db', 'cloud', 'suites'];
function suiteIcon(name: string, i: number): string {
  const n = name.toLowerCase();
  if (/auth|login|sign|identity|account/.test(n)) return 'keys';
  if (/checkout|cart|pay|order|billing/.test(n)) return 'bolt';
  if (/search|discover|filter/.test(n)) return 'search';
  if (/smoke|platform|health|baseline/.test(n)) return 'globe';
  if (/setting|profile|admin/.test(n)) return 'settings';
  return SUITE_ICON_CYCLE[i % SUITE_ICON_CYCLE.length];
}

function initials(s: string): string {
  const parts = s.trim().split(/[\s@.]+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

function relTime(iso?: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d === 1) return 'yesterday'; if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

const IN_FLIGHT = ['queued', 'running'];

function toDesignCase(c: CaseSummary, s: Suite): DesignCase {
  const lr = c.lastRun;
  // A run still in flight has no final cost or completion time yet — say "now"
  // rather than "never", and hold the cost column until the numbers are real.
  const inFlight = !!lr && IN_FLIGHT.includes(lr.status);
  return {
    id: c.id,
    suiteId: s.id,
    suiteName: s.name,
    name: c.name,
    baseUrl: c.baseUrl,
    status: lr?.status ?? 'pending',
    lastCost: lr && !inFlight ? (lr.totalTokens ?? 0) : null,
    durationMs: lr?.durationMs ?? null,
    lastRun: inFlight ? 'now' : relTime(lr?.completedAt),
    runId: lr?.id ?? null,
    hasRun: !!lr && !inFlight,
    // Prefer the display name; fall back to the local part of the email rather than the
    // whole address, which is too long for a list row.
    author: c.createdBy ? (c.createdBy.displayName || c.createdBy.email.split('@')[0]) : '',
    cacheHitPct: c.stats?.cacheHitPct ?? null,
    firstRunTokens: c.stats?.firstRunTokens ?? null,
    runCount: c.stats?.runs ?? 0,
    // Payloads predating the draft lifecycle omit these; a case without a status
    // is one the user owns, which is the safe reading.
    caseStatus: c.status ?? 'active',
    origin: c.origin ?? 'user',
    validationRunId: c.validationRunId ?? null,
    archetypeKey: c.archetypeKey ?? null,
  };
}

export type DesignData = {
  suites: DesignSuite[];
  cases: DesignCase[];
  stats: { pass: number; healed: number; fail: number; total: number; fromMemory: number; ran: number };
  user: { name: string; initials: string; email: string } | null;
  isLoading: boolean;
  refetch: () => void;
};

export function useDesignData(): DesignData {
  const { user } = useAuth();
  const { suites, isLoading: sLoading, refetch } = useSuites();
  const { bySuite, isLoading: cLoading } = useAllCases(suites);

  const { dSuites, cases, stats } = useMemo(() => {
    const dSuites: DesignSuite[] = suites.map((s, i) => ({
      id: s.id, name: s.name, desc: s.description ?? '', icon: suiteIcon(s.name, i),
      count: (bySuite[s.id] ?? []).length,
    }));
    const cases: DesignCase[] = [];
    for (const s of suites) for (const c of (bySuite[s.id] ?? [])) cases.push(toDesignCase(c, s));

    const pass = cases.filter((c) => c.status === 'passed').length;
    const healed = cases.filter((c) => c.status === 'healed').length;
    const fail = cases.filter((c) => c.status === 'failed' || c.status === 'cancelled').length;
    const ran = cases.filter((c) => c.hasRun);
    const fromMemory = ran.length ? Math.round(ran.filter((c) => c.lastCost === 0).length / ran.length * 100) : 0;
    return { dSuites, cases, stats: { pass, healed, fail, total: cases.length, fromMemory, ran: ran.length } };
  }, [suites, bySuite]);

  const userPill = user
    ? { name: user.displayName || user.email, initials: initials(user.displayName || user.email), email: user.email }
    : null;

  return { suites: dSuites, cases, stats, user: userPill, isLoading: sLoading || cLoading, refetch };
}

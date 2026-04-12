# Spec: Comparison & Regression Mode logic

## Goal
Enable the "Comparison Mode" in the Tests Dashboard by providing a way to detect regressions and improvements between runs.

## Data Model Changes

### 1. Test Case Baseline
Add a `baseline_run_id` to the `test_cases` table. This allows users to "Pin" a specific run as the reference point.

```sql
ALTER TABLE test_cases ADD COLUMN baseline_run_id UUID REFERENCES runs(id);
```

## API Changes

### 1. GET /suites/:suiteId/cases (Update)
The endpoint should now calculate the status delta between the `lastRun` and the `baselineRun`.

Logic:
- **Regression**: `baselineRun.status === 'passed'` AND `lastRun.status === 'failed'`.
- **Improvement**: `baselineRun.status === 'failed'` AND `lastRun.status === 'passed'`.
- **Neutral**: All other combinations.

Response payload update:
```typescript
{
  id: string;
  // ...
  lastRun: {
    status: string;
    completedAt: string;
    comparison: 'regression' | 'improvement' | 'neutral';
  }
}
```

### 2. POST /cases/:id/baseline
New endpoint to mark a specific run as the baseline for a test case.

```
POST /cases/:id/baseline
Body: { runId: string }
```

## Implementation Strategy
- The metrics (tokens, duration) are already being returned in the summary.
- The `comparison` field will be calculated in the `GET /suites/:suiteId/cases` LATERAL JOIN by comparing the last two runs (or last run vs pinned baseline).

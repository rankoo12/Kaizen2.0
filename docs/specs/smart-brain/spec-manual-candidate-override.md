# Spec: Manual Candidate Override (Selecting Correct LLM Candidate)

Created: 2026-04-27
Updated: 2026-04-27

## 1. Goal

When the system (LLM or pgvector) resolves a step to the wrong element, but the correct element is present in the `dom_candidates` list generated during the run, the user should be able to click the correct candidate directly in the Step Inspector UI. This action will:
1. Override the incorrect resolution for the current run.
2. Record a human-verified "pass" verdict for the step using the newly selected candidate.
3. Purge the old, incorrect selector from all cache layers.
4. Pin the new, correct selector into the `selector_cache` so that future runs immediately use the correct element without further LLM inference.

This creates a tighter, instant feedback loop where the human acts as the oracle, directly healing the test using the LLM's own candidate list without needing to manually edit selector strings.

## 2. Design

### 2.1 Backend API Route (`PATCH /runs/:runId/steps/:stepId/candidate`)

A new endpoint will be introduced in `src/api/routes/runs.ts` to handle candidate overrides.

**Request Body:**
```json
{
  "candidateKaizenId": "kz-26"
}
```

**Flow:**
1. **Validation**: Fetch the `step_results` row for `stepId` and `runId`. Parse the `dom_candidates` array to find the candidate matching `candidateKaizenId`. If not found, return `404 Not Found`.
2. **Purge Stale Cache (Simulated Failure)**: Run the exact same failure logic currently executed when a user marks a step as "failed".
   - Purge the original `selector_used` from `selector_cache` (tenant-scoped and shared).
   - Delete the `compiled_ast_cache` entry for this step's `content_hash`.
   - Evict related Redis keys (`sel:*`, `llm:dedup:*`).
   - *Note: We will not insert into `archetype_failures` unless the original resolution was via archetype, though it's typically LLM/pgvector when candidates are present.*
3. **Pin Correct Selector**: Insert the newly selected candidate into `selector_cache` for the step's `target_hash`.
   - `selectors`: Set to `[{ type: 'aria', selector: candidate.selector }]`.
   - `element_embedding`: Set to `NULL`. Since the API route does not have access to the heavy embedding model, we insert without it. The `L2` exact hash match will still successfully resolve this step on the next run. (If the element changes in the future, the healing engine or LLM will eventually generate the embedding).
   - `pinned_at`: Set to `now()` so the system never overwrites this human-verified ground truth.
4. **Update Run State**: Update the `step_results` row:
   - `user_verdict = 'passed'`
   - `selector_used = candidate.selector`
   - `llm_picked_kaizen_id = candidate.kaizenId` (so the UI highlights the newly picked candidate).

### 2.2 Frontend UI (`packages/web/src/components/organisms/test-detail-screen.tsx`)

In `StepInspectorBlock`, update the `llm candidates` rendering logic:
1. **Interactive Candidates**: Wrap each candidate in a `<button>` element.
2. **Visual States**:
   - The currently "picked" candidate (matching `llmPickedKaizenId`) remains highlighted with the primary brand color.
   - Other candidates get hover states indicating they are clickable.
3. **Loading State**: Track `submittingCandidateId` in component state. While the API request is in flight, display a loading spinner (`Loader2`) on the selected candidate.
4. **Action**: `onClick` fires the new `PATCH` endpoint. On success, call `onVerdict()` which triggers a `refetchRun()` so the UI immediately updates to show the step as "Marked Pass" with the newly selected candidate highlighted.

## 3. Risks & Considerations

- **Missing Embeddings**: As noted in §2.1, inserting into `selector_cache` directly from the API means the `element_embedding` vector is `NULL`. This degrades `L2.5` (element similarity search) for this specific step until it's re-embedded, but `L2` (exact hash lookup) will work perfectly as long as the step text doesn't change. This is an acceptable tradeoff for the instant UX improvement.
- **Shared Pool Contamination**: We only purge the old shared selector and insert the new one into the tenant's cache. We deliberately *do not* push the user's manual override into the global `is_shared = true` L4 pool directly, as doing so requires careful validation. The L4 crawler can pick it up organically during its normal verification cycles if needed.

## 4. Test Plan

1. **Unit/Integration (`src/api/routes/__tests__/runs.test.ts`)**:
   - Verify that submitting a valid `candidateKaizenId` purges the old cache rows.
   - Verify that it inserts the new selector into `selector_cache`.
   - Verify that `step_results.llm_picked_kaizen_id` is updated.
   - Verify that submitting a non-existent `candidateKaizenId` returns `404` and does not mutate the DB.
2. **Manual UI Verification**:
   - Run a test that relies on LLM resolution.
   - Click an alternate candidate in the step inspector.
   - Verify the UI loading state.
   - Verify the "picked" badge moves to the new candidate.
   - Verify the step status visually changes to "Marked Pass".
   - Re-run the test and verify it uses the new selector instantly (cache hit) without LLM inference.

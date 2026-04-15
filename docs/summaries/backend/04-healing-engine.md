# Healing Engine (`src/modules/healing-engine`)

When Playwright (`execution-engine`) encounters an error, the Healing Engine takes over to automatically fix the broken test step.

## Pipeline
1. **Failure Classifier**: Identifies *why* it failed (e.g., Timeout, DOM Changed, Element Unclickable).
2. **Chain of Responsibility**: A series of strategies attempt to "heal" the step.
   - `FallbackSelectorStrategy`: Try simple secondary selectors.
   - `AdaptiveWaitStrategy`: If the element is animating or slow to network, simply wait longer.
   - `ElementSimilarityStrategy`: Use pgvector to find elements with similar semantic embeddings.
   - `ResolveAndRetryStrategy`: The heaviest action. Captures the current DOM via `PlaywrightDOMPruner`, ships the pruned accessibility tree to the LLM Gateway, and asks the AI to find the "new" correct element based on context.
   - `EscalationStrategy`: Emits a pager/log alert if totally unhealable.
3. **Persistence**: Writes the successful newly found selector back to the database, ensuring that the next time the test runs, it uses the fixed selector automatically without failing.

**Budget**: Strict tenant budgets enforce a limit (e.g. 3 attempts per step) to prevent infinite LLM spending loops.

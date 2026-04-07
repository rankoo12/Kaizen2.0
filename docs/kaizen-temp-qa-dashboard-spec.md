# Temporary QA Dashboard (The QA Interface)
**Branch:** `feat/frontend/temp-qa-dashboard`
**Spec ref:** `kaizen-spec-v3.md` (QA interface validation)

---

## Goal

Provide a simple, lightweight Web UI (Dashboard) designed for QA and Product users to test Kaizen's core features (Element Resolution, Vector Caching, Self-Healing) without relying on curl or terminal commands.

This interface is explicitly **temporary**. It prioritizes functional testing and quick validation over an enterprise-grade UX/UI, allowing the team to test the engine while the official product design is being finalized by the PO.

## Milestone Definition

The milestone is met when:
1. A user can navigate to the local dashboard (e.g., `http://localhost:5173`).
2. A user can input a `tenantId` (or use a default dummy one), a target `baseUrl` (e.g., `https://github.com/login`), and a list of natural language steps.
3. Clicking "Run Test" successfully triggers a `POST` request to the Kaizen API (`/runs`) and returns a `runId`.
4. The dashboard automatically polls `GET /runs/:id` to fetch the status of the run.
5. The dashboard visually displays the final results: which steps passed, which ones failed, and whether any steps triggered self-healing.

---

## Technology Stack & Design

- **Framework**: React via Vite (`packages/temp-dashboard`). Vite is chosen for its minimal footprint and quick setup for Single Page Applications (SPAs).
- **Styling**: Vanilla CSS. We will construct a visually pleasing, cleanly structured UI, but we'll avoid heavy frameworks like Tailwind to ensure maximum flexibility and simplicity for a temporary layout.
- **Visuals**: A sleek dark mode palette with simple gradients and interactive hover-states to provide a "premium" but uncomplicated feel.
- **Communication**: Standard `fetch` API for making requests to `http://localhost:3000`.

---

## 1. Project Initialization

Create a new directory `packages/temp-dashboard` and initialize the React SPA:

```bash
cd packages
npx -y create-vite@latest temp-dashboard --template react-ts
```

---

## 2. Component Structure

The frontend will be broken down into explicit, reusable functional units using Vanilla CSS for styling:

- **ConfigPanel**: A sidebar or top bar where the user can enter the `tenantId` and `API_BASE_URL` (defaulting to `:3000`).
- **TestRunnerForm**: The main input area with:
  - Input field for `target_url` (Base URL).
  - A dynamic list of text inputs for `steps` (e.g., "click the Sign in button").
  - "Run Test" primary button.
- **ResultsViewer**: A dynamic display area that shows the active run:
  - Status indicator (Queued, Running, Passed, Failed, Healed).
  - A table or list view of step results (cache hits vs LLM, self-healing events).

---

## 3. Data Flow & Polling Logic

Because Phase 5's Server-Sent Events (SSE) streaming isn't prioritized yet, the dashboard will use a polling mechanism:

1. **Submit**: Form submission triggers `fetch('http://localhost:3000/runs', { method: 'POST', body: { tenantId, steps, baseUrl } })`.
2. **Poll**: On success, extract the `runId` and start a `setInterval` loop every 1.5 seconds targeting `GET /runs/:runId`.
3. **Terminate**: If the returned status is `passed`, `failed`, or `cancelled`, clear the interval and render the final state.
4. **Display**: Update the UI with the `completed_at` time, `duration_ms` (if provided by API), and specific step-level data (if we update the API to return step-level details — currently `/runs/:id` only returns the high-level run shape).

---

## 4. Required API Enhancements (Optional but Recommended)

Currently, the `GET /runs/:id` endpoint returns high-level status but doesn't return individual `step_results` details (such as whether a cache hit occurred or if healing was attempted).

**To make this dashboard useful for testing current features, we should lightly modify `GET /runs/:id` in the API to join or fetch the `step_results` associated with the run ID and return them in the payload.** 

*(If not, the dashboard will only visualize pass/fail for the whole execution, defeating the purpose of testing individual feature resolutions).*

---

## 5. Execution Order

Follow strictly in this order:

- [ ] **Step 1:** Scaffold the Vite React app inside `packages/temp-dashboard`.
- [ ] **Step 2:** Write the Vanilla CSS design system (`index.css` / `App.css`) defining the dark mode aesthetics, colors, typography, and button dynamics.
- [ ] **Step 3:** Implement the UI components (`TestRunnerForm`, `ConfigPanel`, `ResultsViewer`).
- [ ] **Step 4:** Modify `src/api/routes/runs.ts` (API backend) to append `step_results` to the `GET /runs/:id` response for granular visualization.
- [ ] **Step 5:** Wire the frontend logic to submit runs and poll for results.
- [ ] **Step 6:** Manual testing / Verification combining the backend API, Worker, and the new Frontend dashboard.

# Spec: Run Video — "Watch video" on the run detail view

Created: 2026-08-25

## Goal

Every ordinary test run records a video of the browser while the steps execute.
The run detail view gets a **Watch video** button; clicking it opens a popup
player streaming the run's `.webm`. The user watches exactly what the engine
did — no reconstruction from per-step screenshots.

## Why this shape

- Playwright records per-context video natively (`recordVideo` on
  `browser.newContext()`); the file is a `.webm` finalized when the context
  closes. WebM plays in every modern browser via a plain `<video>` tag — no
  transcoding, no player library.
- Kaizen already has the entire artifact pipeline for screenshots: a media
  service with GCS upload + local-disk fallback, tenant-scoped keys, and an
  authorized streaming endpoint (`GET /media`). Video is the same shape with a
  different content type and one extra HTTP concern (Range, for seeking).

## §1 Capture (worker)

In `src/workers/worker.ts`, `processRun`:

- Pass `recordVideo: { dir: <run-scoped temp dir> }` to `browser.newContext()`
  when video is enabled for the run (see gating below).
- Grab `page.video()` from the **main page** before the context closes; after
  `context.close()` (which finalizes the file), read the file, upload it via
  the media service, stamp `runs.video_key`, and delete the temp dir.
- **Gating:** skip recording when `payload.triggeredBy === 'testwriter'`.
  Test Writer proving/validation runs arrive hundreds at a time per generation
  job, the drafts UI has no player, and the storage would be pure waste.
  `RUN_VIDEO=off` (env) is a global kill switch.
- **Best-effort by contract:** no part of capture/upload may affect the run's
  outcome. Any failure logs `worker.video_*` warnings and the run completes
  exactly as before, `video_key` stays NULL, and the UI simply shows no button.
- **Known limitation (accepted for v1):** video is per page. A run that opens a
  second tab records the main tab only; the clip covers the whole run from the
  first page's perspective. Per-tab or stitched video is out of scope.
- Timing: the upload happens after `context.close()` but before
  `markRunComplete`, so a terminal run row either has its final `video_key` or
  NULL — the UI never needs to re-poll a finished run for a late video.

## §2 Storage (media service)

`src/modules/media/screenshot.service.ts` grows one method:

- `uploadVideo(webm: Buffer, tenantId: string, runId: string)` → stored key
  `{tenantId}/{runId}/video.webm`, uploaded with content type `video/webm`.
  Same GCS-or-local fallback, same retry policy, same `storedKey()` canonical
  form as screenshots.
- `download()` is reused as-is — it is content-agnostic. The LRU cache bounds
  by bytes, so a multi-MB video simply occupies more of the existing budget.

## §3 Schema

Migration `db/migrations/044_run_video.sql`:

```sql
ALTER TABLE runs ADD COLUMN video_key TEXT;
```

Nullable; NULL means "no video for this run" (older runs, testwriter runs,
disabled, or capture failed). No backfill.

## §4 API (`src/api/routes/runs.ts`)

- `GET /runs/:id` — add `video_key` to the run SELECT so the detail response
  carries it.
- `GET /media` — the authorization check currently matches
  `step_results.screenshot_key`; extend it to also accept keys matching
  `runs.video_key` for the caller's tenant (checked second, only if the
  screenshot lookup missed). Everything else about the endpoint (traversal
  guard, ETag, immutable cache headers) applies unchanged.
- **Range support:** when serving a `.webm` key, respond with
  `Accept-Ranges: bytes` and honor a single `bytes=start-end` Range header
  with a `206 Partial Content` + `Content-Range` slice of the buffer. Without
  this, seeking in the player rewinds to 0:00. Malformed/unsatisfiable ranges
  → `416`. Screenshots keep their current whole-body responses.
- Content type by extension: `.webm` → `video/webm`, else `image/png`.

## §5 Web proxy (`packages/web/src/app/api/proxy/[...path]/route.ts`)

The proxy buffers upstream responses and forwards only `If-None-Match`. Add:

- Forward the client's `Range` header upstream.
- Propagate `Content-Range` and `Accept-Ranges` (and the `206` status, which
  already passes through via `res.status`) back to the client.

## §6 UI (`packages/web/src/components/design/screen-run.tsx`)

- `useRunDetail` maps `video_key` → `run.videoKey`.
- When `run.videoKey` is set, the run header shows a **Watch video** button.
- Clicking opens a portal modal (same scrim pattern as the screenshot zoom):
  `<video controls autoPlay src={/api/proxy/media?key=…}>`, Escape/scrim-click
  to close.
- No button when `videoKey` is null — old runs and testwriter runs degrade
  silently.

## Non-goals (v1)

- Per-step deep links into the video (needs step-start timestamp offsets; the
  step loop already records durations, so this is a cheap follow-up).
- Playwright traces / trace-viewer embedding.
- Retention/cleanup policy for stored videos (revisit when storage numbers say
  so; keys are deterministic so a sweeper is trivial later).
- Multi-tab stitched video.

## Acceptance

1. A suite/case run via the app produces `runs.video_key`, and the run detail
   view shows **Watch video**; the popup plays and seeks correctly.
2. A Test Writer generation job's proving runs produce NO videos.
3. A run whose video upload fails still completes with its normal status.
4. `GET /media` refuses a video key belonging to another tenant (404).
5. Existing screenshot serving is byte-identical to before (ETag/cache
   behavior unchanged).

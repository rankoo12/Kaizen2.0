# Spec: Tasks & Actors — reusable composite steps and run-as personas

Created: 2026-11-01
Status: Roadmap (designed, not scheduled)

## 1. Provenance and the judgment behind the scope

Both concepts are lifted from the Screenplay pattern (Actors → Abilities →
Tasks → Interactions → Questions). The pattern itself is an authoring
abstraction for humans maintaining test **code**; Kaizen's NL steps + learned
compiler already replace that layer, so adopting Screenplay wholesale would
reintroduce exactly the code we exist to remove. Two of its concepts survive
the translation into **product features**:

- **Tasks** → a tenant-level library of named, parameterized NL macros.
- **Actors** → named credential/persona sets a suite can run **as**.

Interactions and Questions need nothing: they are our step actions and our
assertion/oracle family, already separated.

## 2. Tasks — reusable composite steps

**Problem.** Every test today is a flat step list. "Log in", "add an item to
the cart", "open the admin panel" are re-written (and re-compiled, re-learned)
in every test that needs them. Editing a shared flow means editing N tests.

**Design.**
- `tenant_tasks` table: `id`, `tenant_id`, `name` ("Log in as {user}"),
  `params` (jsonb list), `steps` (NL lines with `{param}` tokens), versioned
  like `test_steps`.
- A test step may be a task invocation: `do "Log in" with user={{email}}`.
  The compiler expands the task to its NL lines (param-substituted) BEFORE
  compilation, so the AST, resolver, cache and healing see ordinary steps —
  zero engine changes, the expansion is purely upstream.
- Cache identity: expanded steps hash on their expanded text, so two tests
  invoking the same task share every learned selector automatically. That is
  the quiet payoff: a task is a cache-sharing contract, not just sugar.
- UI: a Tasks screen (list, edit, versions, "used by N tests"), and the author
  screen offers task insertion.

**Acceptance.** Edit one task; every test using it runs the new flow on next
run with no re-learning for unchanged lines; the Tests screen shows the blast
radius before saving.

## 3. Actors — personas a suite runs as

**Problem.** "Does this flow work for a Viewer, not just the Admin?" is a
rerun-with-different-credentials question Kaizen cannot express today —
credentials are a per-case `behindAuth` detail.

**Design.**
- `tenant_actors` table: `id`, `tenant_id`, `name` ("Admin", "Viewer"),
  `credentials` (encrypted at rest), optional `description` of intent.
- A run request takes `actorId`; the worker injects the actor's credentials
  wherever the steps reference `{{actor.email}}` / `{{actor.password}}` (run
  context seeding — the mechanism already exists for seedVariables).
- Suite-level matrix: "run this suite as [Admin, Viewer]" enqueues one run per
  actor and the run list groups them; diverging verdicts between actors are
  the headline, not a failure.
- Learning scope: actor runs are `behindAuth` by definition → tenant-scoped
  learning only, no shared-pool contribution (existing rule, unchanged).

**Acceptance.** One suite, two actors, one click: two runs whose verdicts are
shown side by side; a Viewer-blocked screen fails honestly for Viewer while
passing for Admin, and nobody wrote two tests.

## 4. Sequencing

After the site-portfolio campaign and the CI wedge (B11). Tasks before Actors
(Tasks has no schema coupling to auth posture and pays for itself in cache
sharing immediately). Backlog entries: B20 (Tasks), B21 (Actors).

# Spec: Site-Portfolio Campaign — breadth, multi-tenant brain, weak-LLM floor

Created: 2026-11-01
Status: Active (campaign branch `feat/bench/site-portfolio`, stacked on the
unmerged `feat/bench/changing-sites` — the engine under test includes findings
#2–#10 fixed)

## 1. Goal

Three questions the changing-sites gauntlet did not answer:

1. **Breadth** — does the sealed engine hold on software we did not write
   (real local apps: messy DOMs, real auth, real latency), and on a site built
   to be nastier than Buzzly?
2. **Multi-tenant brain** — are verdicts REPRODUCIBLE across tenants (parity),
   does tenant B get MEASURABLY cheaper runs because tenant A learned first
   (helping, via the shared pool + global archetypes), and does behindAuth
   learning provably NOT leak (isolation — judged as a negative control, not
   assumed)?
3. **Weak-LLM floor** — with a deliberately stupid answerer (Haiku), how much
   does the engine's memory compensate? A Sonnet control on a subset prices
   the gap.

Zero OpenAI spend (inbox + subscription answerers), everything served
locally, no mutation of production code during the campaign — the engine is
frozen at `d5902d0` so results attribute to sites and tenants, not drift.

## 2. The site gate — master judgment before a site enters

Every candidate gets a written verdict BEFORE any run:

- **Runnable locally + deterministic enough to judge?** (seeded data, no
  external calls that change verdicts between runs)
- **New coverage?** Name what it probes that the current portfolio does not.
  A site that reproduces a known finding family adds nothing.
- **Judgeable with no-false-pass guarantees?** Expectations writable with the
  changing-sites verdict rules (PASS / GAP / FAIL / FALSE-PASS, negative
  controls intact).
- Verdict: ADMIT / REJECT, one paragraph of why, recorded in §7.

## 3. Candidates

| # | Site | Kind | Loop | New coverage claimed |
|---|---|---|---|---|
| 1–7 | fleet (vanilla, react-spa, angular-forms, vue-cart, jquery-classic, stress, social) | ours, mutating | mutation | baseline + regression floor |
| 8 | the-internet (`gprestes/the-internet`) | real, docker | learning | 40+ widget pages: auth, dynamic loading, frames, drag, hovers — breadth probe |
| 9 | OWASP Juice Shop (`bkimminich/juice-shop`) | real, docker | learning | heavy Angular SPA, real login/registration, search, basket — closest to a SaaS customer |
| 10 | WordPress admin (`wordpress` + `mariadb`) | real, docker | learning + behindAuth | real messy CMS admin DOM, genuine auth wall — THE isolation testbed |
| 11 | site-nightmare | ours, new build | mutation | §6 charter — everything Buzzly lacked |

(Conduit/RealWorld held in reserve if a candidate fails its gate.)

## 4. Loop flavors

**Mutation loop** (our sites): the changing-sites loop unchanged — r1 v1
baseline → mutate → r2 → r3 learned-proof → judge.

**Learning loop** (real apps, which do not mutate): per tenant,
- **cold**: analyze (test-writer, Haiku answerer) → accept → run; record
  tokens, LLM calls, sources.
- **warm**: immediate rerun; expect cache tiers to carry it.
- **hot**: worker restarted (L1 flushed by TTL/eviction realities), rerun;
  expect db_exact/redis to serve, tokens → 0 for resolution.
- Judge: pass/fail honesty per expectations + **cache honesty** (no
  false-pass from staleness; token trajectory cold ≫ warm ≥ hot → 0).

## 5. The tenant matrix

Tenants T1, T2, T3 (seeded like demo tenants, creds in TEMP only).

| Experiment | Design | Judged claim |
|---|---|---|
| **Parity** | Same suite, same site, cold per tenant (shared pool DISABLED for the parity leg via a public-but-fresh site or shared-pool OFF toggle if available; otherwise order-controlled) | Verdicts converge; no tenant-specific flakiness class |
| **Helping** | T1 cold on a public site → T2 cold after → T3 after both | tokens(T2) < tokens(T1), tokens(T3) ≤ tokens(T2), with sources showing `pgvector_element`/`archetype` doing the work; the helping is VISIBLE in resolution sources, not inferred |
| **Isolation** | T1 learns WordPress admin (behindAuth) → T2 cold-runs the same | T2's run shows ZERO resolutions sourced from T1's learning (no shared rows exist for the behindAuth domain; RLS denies tenant rows) — a judged NEGATIVE control; any leak is a campaign-stopping security finding |

## 6. site-nightmare charter

Worse than Buzzly, every trap judged with an expectation (no unfalsifiable
chaos): per-element randomized latency jitter (seeded, reproducible),
skeleton screens that mimic final layout, nested iframes (2 deep), open AND
closed shadow DOM (closed = must-fail probe), div-soup fake buttons (ARIA
misuse — resolver must still find the real control), a cookie-banner overlay
that appears mid-run, volatile list re-render churn, portal-rendered modals,
infinite scroll + virtualization, a fake captcha gate (must-fail, honest).
Seeded RNG so mutation runs are reproducible.

## 7. Site gate verdicts

(filled as judged; no site runs before its row exists)

| Site | Verdict | Why |
|---|---|---|
| fleet ×7 | ADMIT | Known baselines with sealed scoreboards (47/0/3/0 at `d5902d0`); they are the regression floor, and any portfolio-era drift on them is a finding by itself. |
| the-internet | ADMIT | Live at `site-internet:5000` (probed from the worker). 40+ isolated widget pages — broad, deterministic, no accumulating state. Coverage: breadth of primitive patterns under a WEAK answerer, and the 292-test writer bar's home turf rerun under Haiku. |
| juice-shop | ADMIT, with a rule | Live at `site-juice:3000`. Heavy Angular SPA, real registration/login/search/basket — the closest analogue to a SaaS customer. Caveat judged, not ignored: its challenge/score state accumulates server-side, so **the container is recreated per tenant leg** to keep cold runs cold; expectations avoid score-dependent surfaces. |
| wordpress-admin | ADMIT | Live at `site-wp`, installed headlessly (creds in TEMP only). Real messy CMS admin DOM behind a genuine auth wall — THE behindAuth isolation testbed (§5), plus front-of-site public flows for the helping leg. Deterministic with our seeded content. |
| site-nightmare | ADMIT | Built to the §6 charter (htm+React, fleet conventions), serving at `site-nightmare` as `benchmarks/sites/nightmare/`. Deterministic by construction: seeded RNG (mulberry32, seed 20261101) makes every latency byte-identical across loads — verified by a 26/26 headless smoke incl. closed-shadow unpierceability, churn node detachment, ≤14 DOM rows at 400 loaded, cookie-wall click interception. Every trap has an assertable visible outcome; two built-in must-fail probes (closed vault, fake captcha). New coverage vs Buzzly: nested iframes 2-deep, closed shadow DOM, ARIA-misuse decoy soup, mid-run overlay, portal modal, seeded jitter up to 8s. v1-only until the v2 mutation set lands (r1 baseline first). |

## 8. Model tiers

- Floor: every loop on **Haiku** answerers (N parallel for throughput).
- Control: **Sonnet** on 3 sites (one fleet site, Juice Shop, nightmare);
  compare pass rates + token spend + heal rates. The delta is the "engine
  memory compensates for a weak model" number.

Nightmare × haiku result (2026-11-01, after seed fixes + the M1 id
amendment): **6 PASS / 0 GAP / 3 FAIL / 0 FALSE-PASS** — every must-fail
honest at the correct locus (captcha at its assert, vault at the unreachable
closed root), about/ledger/pin/portal expectations all judged PASS. The 3
FAILs are the floor itself: reactor's heal re-resolved onto a wrong (non-
decoy) element and the OUTCOME ASSERT caught it — honesty held under a weak
model; cookie-rating and subscribe died on finding #13 (watchdog × haiku
latency). Sonnet control reruns this site for the delta.

Floor observations so far (2026-11-01): on the-internet the Haiku writer
produced 2 accepted cases in a 43-minute analyze (thin but viable — and the
engine's memory then ran the suite at 0 tokens warm/hot); on nightmare it
produced ZERO (plan phase emitted nothing writable). Haiku resolution calls
on nightmare's heavy DOM run 30–100s, which interacts with the 60s step
watchdog — logged as engine finding #13 in spec-changing-sites §12. The
engine stays frozen; the Sonnet control prices all of this.

## 9. Deliverables

- §7 verdicts, per-site judged scoreboards, tenant-matrix findings (parity /
  helping / isolation) with evidence queries, weak-vs-control model delta,
  new named findings in the changing-sites §12 log convention, daily report.
- **The judge-everything dashboard**: a single page where the owner can judge
  the whole campaign — per-site scoreboards, tenant parity/helping/isolation
  evidence, token trajectories (cold→warm→hot), model-tier deltas, findings
  log, drill-down to per-run detail. Built at campaign end FROM the §9a
  records, never hand-assembled.

### 9a. Logging contract (written before the first run, so the dashboard is
derivable, not reconstructed)

Every loop phase appends one record to
`benchmarks/site-portfolio/results/campaign.jsonl`:

```
{ at, site, siteKind: "fleet"|"real"|"nightmare", loop: "mutation"|"learning",
  phase: "r1"|"r2"|"r3"|"cold"|"warm"|"hot", tenant, model: "haiku"|"sonnet",
  runIds: [], cases: {passed, failed, healed},
  tokens: {total, perCase}, llmCalls, sourceHistogram: {archetype, redis,
  db_exact, pgvector_step, pgvector_element, llm, delta, reveal},
  heals: {attempted, succeeded, byStrategy}, durationMs,
  judge: {pass, gap, fail, falsePass, negCtrl} | null,
  notes }
```

Plus `campaign-manifest.json` (sites, gate verdicts, tenants, model
assignments, engine commit `d5902d0`) and the existing per-site evidence
JSONs. Nothing the dashboard shows may lack a record behind it.

## 10. Verification bar

Inherited unchanged from changing-sites: no false-passes, negative controls
hard-fail the bench, every red is named or it is not done. Standing
run-quality audit applies to every generated suite.

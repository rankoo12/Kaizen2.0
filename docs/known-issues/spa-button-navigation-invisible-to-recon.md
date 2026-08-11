# RECON sees one page on SPAs that navigate by button

**Status:** known limitation, not yet fixed
**Found:** 2026-08-07, P3 authenticated-scope dogfood against Kaizen's own web app
**Affects:** `src/modules/test-writer/recon/crawler.ts` (all scopes — public and authenticated)

## What happens

The crawler's BFS frontier is built from `<a href>` anchors (`captureLinks`, plus
links revealed by safe-reveal probes). An application that navigates by calling
a click handler and swapping state — no anchor, no URL change, or a URL change
driven by the History API from a button — exposes **no links to follow**, so the
crawl captures the landing page and stops.

Measured on Kaizen's own app (the P3 dogfood, job `9b48948b`):

```
pagesCrawled:      1        (http://localhost:3001/tests)
linksInserted:     0
probesPerformed:   4
```

The nav is `<button className="side-item" onClick={() => onNav(n.id)}>`
(`packages/web/src/components/design/chrome.tsx:143`), and the authenticated
surface is the single route `/tests/**` with screens swapped in React state.
Recon behaved correctly; there was genuinely nothing to enqueue.

## Why it matters

Everything downstream is proportional to pages crawled. In the same job, the one
captured page yielded 41 elements, and all three planned scenarios were rejected
at the schema gate for citing elements that did not exist in that small
grounding set. **A thin crawl does not produce a few weaker tests — it produces
none**, because the grounding invariant is absolute.

This is not a P3 defect. Authenticated scope worked exactly as designed in the
same run (3/3 login steps, `sessionVerification: assertion+heuristic`, session
survived, `requires_auth` marked, zero cross-tenant writes). But it does mean
**Kaizen's own app is close to a worst case for measuring crawl breadth**, and
any single-route SPA target will behave the same way.

## Why probing does not already cover it

Safe-reveal probing exists to discover hidden STATE (menus, accordions, modals)
and deliberately restores the page afterwards so the BFS stays coherent
(`probe.ts`: Escape → goBack → goto). A nav button is not classified
`safe-reveal` in the general case, and even when probed, its effect is undone —
which is correct for a modal and wrong for a route change.

## Options when this is picked up

1. **Detect URL changes during probing.** If a probe changes `page.url()`, treat
   the destination as a discovered page and enqueue it rather than restoring.
   Cheapest fix; covers History-API routers.
2. **Client-route extraction.** Read the router's route table where the framework
   exposes one (`__NEXT_DATA__`, `window.__remixManifest`). Precise but
   framework-specific — and the routes manifest from the B11 repo integration
   (see the 2026-08-07 cross-note in `COORDINATION.md`) is the same information
   from a more reliable source.
3. **Classify nav-shaped buttons as navigation.** Risky: the safety classifier
   resolves ambiguity DOWNWARD by design, and loosening it to chase coverage is
   the exact trade that rule exists to prevent.

Option 1 is the smallest honest step; option 2 is what the repo integration
gives us for free if a tenant grants it.

## Workaround today

Point an analyze at a multi-page target, or run several analyses at different
entry URLs. The job report already exposes the signal — `pagesCrawled: 1` with
`linksInserted: 0` means the crawler found nothing to follow.

import type { SiteExpectations } from '../lib/types';

/**
 * nightmare v2 — mutation set M1–M10 (spec-site-portfolio §6; mutation
 * semantics defined 2026-11-01 when v2 was commissioned):
 *   M1 reactor renamed "Activate reactor"→"Engage reactor" + decoys 4→6
 *   M2 cookie button renamed "Accept the inevitable"→"Fine. Proceed."
 *   M3 rating nested one open-shadow level deeper
 *   M4 pin outcome text format changed ("Pinned:" gone site-wide)
 *   M5 ledger row 333 text changed
 *   M6 modal sealing now needs a second "Really seal" click
 *   M7 subscribe iframe 2-deep → 3-deep
 *   M8 latency reseeded, two widgets >8s
 *   M9 about byte-identical (control)
 *   M10 vault + captcha byte-identical (honest-fail stability)
 *
 * NOTE ON M2: the cookie rename sits UNDER half the flows (anything below the
 * fold needs the banner gone first), so its expectation matches by the banner
 * step, and every flow that merely TRAVERSES it is matched by its own
 * expectation further down — order matters, first match wins.
 */
const expected: SiteExpectations = {
  site: 'nightmare',
  defaultOutcome: 'pass-or-heal',
  expectations: [
    {
      id: 'nightmare.vault.closed',
      match: { namePattern: 'closed vault' },
      mutation: 'feature-removed',
      outcome: 'must-fail',
      notes: 'M10: the outcome text lives only inside a CLOSED shadow root, v1 and v2 alike — permanently unreachable, permanently honest',
    },
    {
      id: 'nightmare.captcha.honest',
      match: { namePattern: 'captcha' },
      mutation: 'assertion-changed',
      outcome: 'must-fail',
      notes: 'M10: verification always fails by design; asserting "Verification passed" must stay red forever',
    },
    {
      id: 'nightmare.pin.text-changed',
      match: { stepPattern: 'pin this|pinned' },
      mutation: 'assertion-changed',
      outcome: 'must-fail',
      notes: 'M4: "Pinned:" does not exist anywhere in v2 — the assert must fail honestly, not heal onto the new phrasing',
    },
    {
      id: 'nightmare.ledger.text-changed',
      match: { stepPattern: 'hidden ledger line' },
      mutation: 'assertion-changed',
      outcome: 'must-fail',
      notes: 'M5: row 333 reads "relocated archive line" in v2',
    },
    {
      id: 'nightmare.modal.flow-extended',
      match: { stepPattern: 'summon modal|seal it' },
      mutation: 'feature-removed',
      outcome: 'must-fail',
      notes: 'M6: sealing now requires a second click the old flow never performs — no Sealed text can render; a green here means the engine invented an outcome',
    },
    {
      id: 'nightmare.reactor.rename',
      match: { stepPattern: 'activate reactor|reactor online' },
      mutation: 'label-rename',
      outcome: 'heal-any',
      decoyMarkers: ['soup-decoy'],
      notes: 'M1: renamed to "Engage reactor" among 6 inert decoys; the heal must land on the one real role=button and never a decoy',
    },
    {
      id: 'nightmare.cookie.rename',
      match: { stepPattern: 'accept the inevitable' },
      mutation: 'label-rename',
      outcome: 'heal-any',
      notes: 'M2: the banner button renamed; any flow that explicitly clicks it must heal onto "Fine. Proceed."',
    },
    {
      id: 'nightmare.rating.nested',
      match: { stepPattern: 'star rating|rated' },
      mutation: 'dom-restructure',
      outcome: 'pass-or-heal',
      notes: 'M3: one more open shadow level; name + outcome unchanged',
    },
    {
      id: 'nightmare.subscribe.deepened',
      match: { stepPattern: 'subscribe' },
      mutation: 'dom-restructure',
      outcome: 'pass-or-heal',
      notes: 'M7: three iframe hops instead of two; form + outcome unchanged',
    },
    {
      id: 'nightmare.about.control',
      match: { stepPattern: 'built to break the brave' },
      mutation: 'unrelated-content',
      outcome: 'pass-unchanged',
      notes: 'M9: byte-identical page — zero heals, cache-only, zero tokens',
    },
  ],
};

export default expected;

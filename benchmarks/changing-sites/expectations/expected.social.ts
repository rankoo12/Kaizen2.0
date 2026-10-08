import type { SiteExpectations } from '../lib/types';

/**
 * social (Buzzly) v2 — the flagship complexity site. Mutation inventory:
 *   label-rename   "Post" → "Publish" (id churned with it)
 *   decoy-added    "Posting guidelines" lookalike beside the real submit
 *   feature-removed Stories strip gone (MUST-FAIL)
 *   assertion-changed share copy "Post shared to your timeline." → "Shared!" (MUST-FAIL)
 *   label-rename   friend-request "Accept" → "Confirm"
 *   element-moved  "Add friend" from profile header to a Connect card
 *   dom-restructure feed posts wrapped in .card-shell, article lost .card
 *   cosmetic-churn messages view ids renamed (labels identical)
 *   delayed-render notifications content 6s late; feed batch 2 at 4s
 *   unrelated-content "Suggested for you" rail (no-op control)
 */
const expected: SiteExpectations = {
  site: 'social',
  defaultOutcome: 'pass-unchanged',
  expectations: [
    // ── MUST-FAILS first (narrowest matchers win by order) ──────────────────
    {
      id: 'social.story.removed',
      match: { stepPattern: 'story|shipped the thing' },
      mutation: 'feature-removed',
      outcome: 'must-fail',
      notes: 'Stories were cut from the product; a green story test healed onto something else',
    },
    {
      id: 'social.share.assertion-changed',
      match: { stepPattern: 'shared to your timeline|"Share"' },
      mutation: 'assertion-changed',
      outcome: 'must-fail',
      notes: 'the confirmation copy no longer exists; the click still works — only the assert may fail, honestly',
    },
    // ── Renames: heal or adapt, and the decoy must not be grabbed ───────────
    {
      id: 'social.composer.rename-decoy',
      match: { stepPattern: 'click the "Post" button' },
      mutation: 'label-rename',
      // heal-any, not heal-learned: ResolveAndRetry DOES heal and re-click
      // "Publish" (verified by the live-post outcome), but the persisted row
      // re-heals on r3 instead of serving clean — the documented
      // healed-not-learned gap. The decoy guard below is the real assertion.
      outcome: 'heal-any',
      decoyMarkers: ['data-decoy', 'decoy-post-guidelines', 'Posting guidelines'],
      notes: 'OBSERVED 2026-10-08: healed to role=button[name="Publish"], decoy untouched — correct. GAP on learned-persistence.',
    },
    {
      id: 'social.requests.rename',
      match: { stepPattern: 'click the "Accept" button|now friends with' },
      mutation: 'label-rename',
      outcome: 'heal-any',
      notes: '"Accept" became "Confirm". OBSERVED 2026-10-08: healed to role=button[name="Confirm"] and the click re-fired — the r2 heal is correct; r3 re-heals (healed-not-learned gap).',
    },
    // ── Late-rendered outcome text / inputs (ENGINE FINDINGS, kept red) ─────
    // ORDER: these specific outcome-text matchers MUST precede the broad
    // structural ones below, or first-match-wins mislabels the finding.
    // The failure is that the engine does not wait for content that renders
    // AFTER an async action (assert scans `body` once, Escalation can't heal
    // an assertion → fail) or types into the nearest already-existing
    // same-named element when the real input is still loading. Same
    // volatile/late-render class the stress site flagged. pass-or-heal so a
    // FAIL is reported honestly and a future wait-for-content fix turns them
    // green with no edit here.
    {
      id: 'social.reply.late-outcome',
      match: { stepPattern: 'you: great point|adds the comment' },
      mutation: 'delayed-render',
      outcome: 'pass-or-heal',
      notes: 'FINDING 2026-10-08: comment outcome renders after the 250ms action latency; assert scans body too early and Escalation cannot heal an assertion.',
    },
    {
      id: 'social.addfriend.late-outcome',
      match: { stepPattern: 'friend request sent to' },
      mutation: 'delayed-render',
      outcome: 'pass-or-heal',
      notes: 'FINDING 2026-10-08: same late-outcome class as reply; the moved Add friend button clicked fine, the late confirmation is what fails.',
    },
    {
      id: 'social.message.late-input',
      match: { stepPattern: 'message field|shows delivered|the message input' },
      mutation: 'delayed-render',
      outcome: 'pass-or-heal',
      notes: 'FINDING 2026-10-08: thread input loads ~900ms late; `type` resolved onto role=link[name="Messages"] — wrong element under latency.',
    },

    // ── Structure/placement: role+name selectors should mostly survive ──────
    {
      id: 'social.addfriend.moved',
      match: { stepPattern: 'add friend' },
      mutation: 'element-moved',
      outcome: 'pass-or-heal',
    },
    {
      id: 'social.feed.restructure',
      match: { stepPattern: '"Like"|"Comment"|flips the button|liked' },
      mutation: 'dom-restructure',
      outcome: 'pass-or-heal',
      notes: 'posts wrapped in .card-shell; accessible names unchanged',
    },
    {
      id: 'social.messages.churn',
      match: { stepPattern: 'conversation|message' },
      mutation: 'cosmetic-churn',
      outcome: 'pass-or-heal',
      notes: 'chat ids renamed under identical labels',
    },

    // ── Timing hostility ────────────────────────────────────────────────────
    {
      id: 'social.notifications.delayed',
      match: { stepPattern: 'notifications|all caught up|mark all as read' },
      mutation: 'delayed-render',
      outcome: 'pass-or-heal',
      notes: 'dropdown contents arrive 6s after opening; must never FAIL',
    },
    {
      id: 'social.feed.slow-batch',
      match: { stepPattern: 'posts in your feed|12 posts' },
      mutation: 'delayed-render',
      outcome: 'pass-or-heal',
      notes: 'batch 2 now lands at 4s; the count line is only final after it',
    },
  ],
};

export default expected;

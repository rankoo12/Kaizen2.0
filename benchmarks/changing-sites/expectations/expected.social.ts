import type { SiteExpectations } from '../lib/types';

/**
 * REBUILT 2026-10-08 as a modern, component-based, far larger and weirder site.
 * social (Buzzly) — the flagship complexity site. A 7-view React SPA built
 * with htm components, a tiny store, custom hooks, per-endpoint tunable
 * latency, and a battery of adversarial patterns: a shadow-DOM poll, an iframe
 * widget, a canvas chart, an infinite-spinner live tile, a virtualized 500-row
 * feed, auto-dismissing toasts, optimistic-rollback likes, lazy tab panels, a
 * hover menu, a native <dialog>, a modal stack, drag-to-reorder, and duplicate
 * accessible names across every post.
 *
 * v2 mutations (all named in the component source):
 *   label-rename + decoy  "Post" → "Publish" beside "Posting guidelines"
 *   feature-removed        Stories strip (MUST-FAIL)
 *   assertion-changed      share copy → "Shared!" (MUST-FAIL)
 *   dom-restructure        posts wrapped in .card-shell
 *   element-moved          "Add friend" → Connect card
 *   label-rename           "Accept" → "Confirm"
 *   element-swap           group Join <button> → <a role=button>
 *   cosmetic-churn         messages ids renamed
 *   delayed-render         notifications 6s, feed batch-2 4s
 *   unrelated-content      "Suggested for you" rail (no-op control)
 *
 * The reach probes (shadow DOM, iframe, canvas, infinite spinner, drag,
 * virtualization) are baseline v1 difficulty — their outcomes are findings
 * about how far the engine can see, calibrated from the first run.
 */
const expected: SiteExpectations = {
  site: 'social',
  defaultOutcome: 'pass-unchanged',
  expectations: [
    // ── MUST-FAILS (narrowest matchers first) ───────────────────────────────
    {
      id: 'social.story.removed',
      match: { stepPattern: 'story|shipped the thing|you voted' },
      mutation: 'feature-removed',
      outcome: 'must-fail',
      notes: 'Stories cut from the product; a green story test healed onto something else. (The shadow-poll "You voted" seed also lives on the feed and shares the matcher.)',
    },
    {
      id: 'social.share.assertion-changed',
      match: { stepPattern: 'shared to your timeline' },
      mutation: 'assertion-changed',
      outcome: 'must-fail',
      notes: 'share copy became "Shared!"; asserting the old text must fail honestly',
    },

    // ── Reach probes: engine-can-it findings (calibrated) ────────────────────
    {
      id: 'social.canvas.unreadable',
      match: { stepPattern: '#gardening' },
      mutation: 'unrelated-content',
      outcome: 'must-fail',
      notes: 'CONFIRMED 2026-10-08: the trend tag is drawn on <canvas>, invisible to the DOM — the engine correctly cannot read it and fails honestly (assert→body→Escalation, no false pass). Honest failure is the correct outcome, hence must-fail.',
    },
    {
      id: 'social.live.infinite-spinner',
      match: { stepPattern: 'LIVE:' },
      mutation: 'delayed-render',
      outcome: 'must-fail',
      notes: 'CONFIRMED 2026-10-08: the live tile never resolves (latency Infinity); the engine times out honestly and never invents a pass. Correct behavior → must-fail.',
    },
    {
      id: 'social.virtual.deep-row',
      match: { stepPattern: '\\(#120\\)' },
      mutation: 'unrelated-content',
      outcome: 'pass-or-heal',
      notes: 'FINDING if FAIL: post #120 is not in the DOM until the virtualized feed is scrolled to it — tests the engine’s scroll-to-find reach.',
    },
    {
      id: 'social.shadow.poll',
      match: { stepPattern: 'ramen' },
      mutation: 'unrelated-content',
      outcome: 'pass-or-heal',
      notes: 'open shadow DOM — Playwright can pierce it; whether Kaizen’s pruner surfaces the inner button is the probe.',
    },
    {
      id: 'social.iframe.signup',
      match: { stepPattern: 'sign up|thanks for signing up' },
      mutation: 'unrelated-content',
      outcome: 'pass-or-heal',
      notes: 'interaction inside an iframe — resolution must enter the frame.',
    },

    // ── Renames / decoy ──────────────────────────────────────────────────────
    {
      id: 'social.composer.rename-decoy',
      match: { stepPattern: 'click the "Post" button' },
      mutation: 'label-rename',
      outcome: 'heal-any',
      decoyMarkers: ['data-decoy', 'decoy-post-guidelines', 'Posting guidelines'],
      notes: '"Post" → "Publish" with a decoy alongside; green must come from the real submit, proven by the live-post outcome.',
    },
    {
      id: 'social.requests.rename',
      match: { stepPattern: 'accept|now friends with' },
      mutation: 'label-rename',
      outcome: 'heal-any',
      notes: '"Accept" → "Confirm"; outcome copy unchanged.',
    },

    // ── Late-rendered outcome / input (finding #6 family) ────────────────────
    {
      id: 'social.reply.late-outcome',
      match: { stepPattern: 'you: great point|adds the comment' },
      mutation: 'delayed-render',
      outcome: 'pass-or-heal',
      notes: 'FINDING: comment outcome renders after the action latency; also exercises the vector-cache precision issue (type can land in the composer).',
    },
    {
      id: 'social.message.late-input',
      match: { stepPattern: 'message field|shows delivered|the message input|on my way' },
      mutation: 'cosmetic-churn',
      outcome: 'pass-or-heal',
      notes: 'thread input loads ~900ms late AND its id churned; wrong-element-under-latency finding.',
    },

    // ── Structure / placement (role+name should mostly survive) ──────────────
    {
      id: 'social.addfriend.moved',
      match: { stepPattern: 'add friend|friend request sent' },
      mutation: 'element-moved',
      outcome: 'pass-or-heal',
    },
    {
      id: 'social.feed.restructure',
      match: { stepPattern: '"Like"|flips the button|liked|"Comment"' },
      mutation: 'dom-restructure',
      outcome: 'pass-or-heal',
      notes: 'posts wrapped in .card-shell; accessible names unchanged',
    },
    {
      id: 'social.groups.swap',
      match: { stepPattern: 'join|joined' },
      mutation: 'element-swap',
      outcome: 'pass-or-heal',
      notes: 'group Join button became <a role=button>; role selectors survive',
    },
    {
      id: 'social.messages.churn',
      match: { stepPattern: 'conversation|message|delivered' },
      mutation: 'cosmetic-churn',
      outcome: 'pass-or-heal',
      notes: 'messages view ids renamed under identical labels',
    },

    // ── Timing hostility ──────────────────────────────────────────────────────
    {
      id: 'social.notifications.delayed',
      match: { stepPattern: 'notifications|all caught up|mark all as read' },
      mutation: 'delayed-render',
      outcome: 'pass-or-heal',
      notes: 'dropdown contents arrive 6s after opening; must never FAIL',
    },
    {
      id: 'social.feed.slow-batch',
      match: { stepPattern: 'posts in your feed' },
      mutation: 'delayed-render',
      outcome: 'pass-or-heal',
      notes: 'batch 2 lands at 4s; count line only final after it',
    },
    // ── Complex-interaction late outcomes (finding #6 family, kept red) ──────
    // Block (hover menu → dialog), Create event (stacked modals), Play (watch)
    // all COMPLETE their interactions, then the final outcome-text assert fails
    // on body via Escalation — the async outcome renders after the action and
    // the engine's assert does not catch it. Reachable flows the engine misses
    // → red findings (not pass-unchanged violations).
    {
      id: 'social.block.late-outcome',
      match: { stepPattern: 'is blocked' },
      mutation: 'delayed-render',
      outcome: 'pass-or-heal',
      notes: 'FINDING: hover-menu → native <dialog> confirm succeeds; "… is blocked." outcome not caught by the assert.',
    },
    {
      id: 'social.event.late-outcome',
      match: { stepPattern: 'event created with' },
      mutation: 'delayed-render',
      outcome: 'pass-or-heal',
      notes: 'FINDING: stacked-modal flow completes; "Event created with N guests." outcome not caught.',
    },
    {
      id: 'social.watch.late-outcome',
      match: { stepPattern: 'now playing' },
      mutation: 'delayed-render',
      outcome: 'pass-or-heal',
      notes: 'FINDING: Play click succeeds; "Now playing:" outcome not caught (same late-outcome shape).',
    },
    // Search, modal cancel, etc. default to pass-unchanged.
  ],
};

export default expected;

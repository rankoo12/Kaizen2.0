/**
 * Changing-sites bench — the site fleet registry.
 * Spec: docs/specs/bench/spec-changing-sites.md
 *
 * Each site is served by the compose `sites` nginx under its own hostname
 * alias; the harness swaps benchmarks/sites/<dir>/live/ between versions.
 * `probes` lets the mutator verify a version is ACTUALLY being served before
 * any run starts: __version.txt plus one marker that only that version's
 * content contains.
 */

export type VersionProbe = {
  /** Path to fetch, e.g. '/login.html'. */
  path: string;
  /** Substring that must appear in the response body for this version. */
  contains: string;
};

export type SeedCase = { name: string; path: string; steps: string[] };

export type SiteDef = {
  /** Fleet id — also the directory name under benchmarks/sites/. */
  id: string;
  /** Hostname alias on the compose network (and the selector-cache domain). */
  host: string;
  /** Version dirs in mutation order; live/ starts as versions[0]. */
  versions: string[];
  /** Per-version marker probe (beyond __version.txt). */
  probes: Record<string, VersionProbe>;
  /** Brief file fed to analyze, relative to benchmarks/changing-sites/. */
  brief: string;
  /**
   * Hand-authored coverage-floor cases (bench tests the ENGINE, not the
   * writer): created active before r1 when the generated suite under-covers a
   * mutation. Names are prefixed "SEED:" so reports distinguish them.
   */
  seedCases?: SeedCase[];
  /** Per-site analyze budget (defaults: maxPages 6 / maxScenarios 8). */
  analyze?: { maxPages?: number; maxScenarios?: number };
};

export const FLEET: SiteDef[] = [
  {
    id: 'vanilla',
    host: 'site-vanilla',
    versions: ['v1', 'v2'],
    probes: {
      v1: { path: '/login.html', contains: 'id="login-submit"' },
      v2: { path: '/login.html', contains: 'id="btn-signin"' },
    },
    brief: 'briefs/brief.vanilla.txt',
  },
  {
    id: 'react-spa',
    host: 'site-react',
    versions: ['v1', 'v2'],
    probes: {
      v1: { path: '/app.js', contains: "'Sign in'" },
      v2: { path: '/app.js', contains: "'Log in'" },
    },
    brief: 'briefs/brief.react-spa.txt',
    seedCases: [
      {
        name: 'SEED: Account sign-in confirms identity',
        path: '/#/account',
        steps: [
          'navigate to http://site-react/#/account',
          'type "ada@example.com" in the "Email address" field',
          'click the "Sign in" button',
          'verify the text "Signed in as ada@example.com." is shown',
        ],
      },
    ],
  },
  {
    id: 'angular-forms',
    host: 'site-angular',
    versions: ['v1', 'v2'],
    probes: {
      v1: { path: '/register.html', contains: 'id="reg-submit"' },
      v2: { path: '/register.html', contains: 'id="reg-submit-link"' },
    },
    brief: 'briefs/brief.angular-forms.txt',
  },
  {
    id: 'vue-cart',
    host: 'site-vue',
    versions: ['v1', 'v2'],
    probes: {
      v1: { path: '/index.html', contains: 'verdant build v1' },
      v2: { path: '/index.html', contains: 'data-decoy' },
    },
    brief: 'briefs/brief.vue-cart.txt',
    seedCases: [
      {
        name: 'SEED: Checkout places the order',
        path: '/',
        steps: [
          'navigate to http://site-vue/',
          'click the first "Add to cart" button',
          'click the "Cart" link',
          'click the "Checkout" button',
          'verify the text "Order placed — thank you!" is shown',
        ],
      },
    ],
  },
  {
    id: 'jquery-classic',
    host: 'site-jquery',
    versions: ['v1', 'v2'],
    probes: {
      v1: { path: '/index.html', contains: 'id="tab-reports"' },
      v2: { path: '/index.html', contains: 'id="faq-accordion"' },
    },
    brief: 'briefs/brief.jquery-classic.txt',
    seedCases: [
      {
        name: 'SEED: Weekly report loads from the Reports tab',
        path: '/',
        steps: [
          'navigate to http://site-jquery/',
          'click the "Reports" tab',
          'click the "Load weekly report" button',
          'verify the text "Weekly report ready" is shown',
        ],
      },
      {
        name: 'SEED: Refund policy answer opens',
        path: '/',
        steps: [
          'navigate to http://site-jquery/',
          'click the "Refund policy" button',
          'verify the text "Full refund inside 30 days" is shown',
        ],
      },
      {
        name: 'SEED: Announcement modal opens and closes',
        path: '/',
        steps: [
          'navigate to http://site-jquery/',
          'click the "Open announcement" button',
          'verify the text "Scheduled maintenance" is shown',
          'click the "Got it" button',
        ],
      },
    ],
  },
  {
    id: 'stress',
    host: 'site-stress',
    versions: ['v1', 'v2'],
    probes: {
      v1: { path: '/app.js', contains: 'id="refresh-stats"' },
      v2: { path: '/app.js', contains: 'btn-refresh-kpis' },
    },
    brief: 'briefs/brief.stress.txt',
    seedCases: [
      {
        name: 'SEED: Refresh stats confirms',
        path: '/',
        steps: [
          'navigate to http://site-stress/',
          'click the "Refresh stats" button',
          'verify the text "Stats refreshed just now." is shown',
        ],
      },
    ],
  },
  {
    id: 'social',
    host: 'site-social',
    versions: ['v1', 'v2'],
    probes: {
      v1: { path: '/views.js', contains: 'id="composer-post"' },
      v2: { path: '/views.js', contains: 'id="composer-publish"' },
    },
    brief: 'briefs/brief.social.txt',
    analyze: { maxPages: 8, maxScenarios: 24 },
    seedCases: [
      {
        name: 'SEED: Publishing a post confirms it is live',
        path: '/',
        steps: [
          'navigate to http://site-social/',
          'type "Hello from the bench" in the "What\'s buzzing?" field',
          'click the "Post" button',
          'verify the text "Your post is live." is shown',
        ],
      },
      // (Removed "Empty post shows the validation error": the composer now uses
      // a disabled-until-valid Post button instead of an error message, so that
      // seed tested UX this site no longer has. The disabled-button guard is
      // covered implicitly by the successful-publish seed.)
      {
        name: 'SEED: Liking a post flips the button to Liked',
        path: '/',
        steps: [
          'navigate to http://site-social/',
          'click the first "Like" button',
          'verify the text "Liked" is shown',
        ],
      },
      {
        name: 'SEED: Replying to a post adds the comment',
        path: '/',
        steps: [
          'navigate to http://site-social/',
          'click the first "Comment" button',
          'type "Great point" in the "Write a comment…" field',
          'click the "Reply" button',
          'verify the text "You: Great point" is shown',
        ],
      },
      {
        name: 'SEED: Sharing a post confirms to the timeline',
        path: '/',
        steps: [
          'navigate to http://site-social/',
          'click the first "Share" button',
          'verify the text "Post shared to your timeline." is shown',
        ],
      },
      {
        name: 'SEED: Opening a story shows its text',
        path: '/',
        steps: [
          'navigate to http://site-social/',
          'click the "Jon Park" story',
          'verify the text "Shipped the thing!" is shown',
        ],
      },
      {
        name: 'SEED: Search counts results for a topic',
        path: '/#/explore',
        steps: [
          'navigate to http://site-social/#/explore',
          'type "coffee" in the "Search Buzzly" field',
          'verify the text "results for \\"coffee\\"" is shown',
        ],
      },
      {
        name: 'SEED: Adding a friend from a profile confirms the request',
        path: '/#/profile-dev',
        steps: [
          'navigate to http://site-social/#/profile-dev',
          'click the "Add friend" button',
          'verify the text "Friend request sent to Dev Narang." is shown',
        ],
      },
      {
        name: 'SEED: Accepting a friend request confirms the friendship',
        path: '/#/friends',
        steps: [
          'navigate to http://site-social/#/friends',
          'click the "Accept" button for "Sam Idowu"',
          'verify the text "You are now friends with Sam Idowu." is shown',
        ],
      },
      {
        name: 'SEED: Sending a message shows Delivered',
        path: '/#/messages',
        steps: [
          'navigate to http://site-social/#/messages',
          'click the "Mira Chen" conversation',
          'type "On my way" in the message field',
          'click the "Send" button',
          'verify the text "Delivered" is shown',
        ],
      },
      {
        name: 'SEED: Joining a group confirms membership',
        path: '/#/groups',
        steps: [
          'navigate to http://site-social/#/groups',
          'click the "Join" button for "Book Nook"',
          'verify the text "Joined Book Nook." is shown',
        ],
      },
      {
        name: 'SEED: Notifications open and clear',
        path: '/',
        steps: [
          'navigate to http://site-social/',
          'click the "Notifications" button',
          'verify the text "Hiking Buddies posted a new route." is shown',
          'click the "Mark all as read" button',
          'verify the text "All caught up." is shown',
        ],
      },
      // ── Reach probes: the weird patterns. Several are EXPECTED to fail —
      //    those failures are findings about how far the engine can see.
      {
        name: 'SEED: Vote in the shadow-DOM poll',
        path: '/',
        steps: [
          'navigate to http://site-social/',
          'click the "Ramen" button',
          'verify the text "You voted Ramen." is shown',
        ],
      },
      {
        name: 'SEED: Sign up in the sponsored iframe widget',
        path: '/',
        steps: [
          'navigate to http://site-social/',
          'click the "Sign up" button',
          'verify the text "Thanks for signing up!" is shown',
        ],
      },
      {
        name: 'SEED: Trends chart shows a tag (canvas — unreadable)',
        path: '/',
        steps: [
          'navigate to http://site-social/',
          'verify the text "#gardening" is shown',
        ],
      },
      {
        name: 'SEED: Live tile shows a viewer count (infinite spinner)',
        path: '/',
        steps: [
          'navigate to http://site-social/',
          'verify the text "LIVE:" is shown',
        ],
      },
      {
        name: 'SEED: Block a user through the hover menu and dialog',
        path: '/#/profile-jon',
        steps: [
          'navigate to http://site-social/#/profile-jon',
          'click the "Block" button',
          'click the "Block" button',
          'verify the text "Jon Park is blocked." is shown',
        ],
      },
      {
        name: 'SEED: Create an event through the stacked modals',
        path: '/#/groups',
        steps: [
          'navigate to http://site-social/#/groups',
          'click the "Create event" button',
          'click the "Add guests" button',
          'click the "Invite Mira" button',
          'click the "Done" button',
          'click the "Save event" button',
          'verify the text "Event created with 1 guests." is shown',
        ],
      },
      {
        name: 'SEED: Play a video on the Watch page',
        path: '/#/watch',
        steps: [
          'navigate to http://site-social/#/watch',
          'click the "Play" button for "Ridge traverse, start to summit"',
          'verify the text "Now playing:" is shown',
        ],
      },
      {
        name: 'SEED: Scroll to a deep post in the virtualized feed',
        path: '/',
        steps: [
          'navigate to http://site-social/',
          'verify the text "(#120)" is shown',
        ],
      },
    ],
  },
  {
    // The portfolio campaign's §6 nightmare: every trap judged, nothing
    // unfalsifiable. v1-only until the v2 mutation set lands (the run loop
    // stops after r1 when versions[1] is absent — that IS the baseline run).
    // Spec: docs/specs/bench/spec-site-portfolio.md §6
    id: 'nightmare',
    host: 'site-nightmare',
    versions: ['v1', 'v2'],
    probes: {
      v1: { path: '/__version.txt', contains: 'v1' },
      v2: { path: '/index.html', contains: 'nightmare-v2-marker' },
    },
    brief: 'briefs/brief.nightmare.txt',
    analyze: { maxPages: 4, maxScenarios: 8 },
    seedCases: [
      {
        name: 'SEED: Reactor activates despite four decoys',
        path: '/',
        steps: [
          'navigate to http://site-nightmare/',
          'click the "Activate reactor" button',
          'verify the text "Reactor online." is shown',
        ],
      },
      {
        name: 'SEED: Cookie wall accepted, then the rating works',
        path: '/',
        steps: [
          'navigate to http://site-nightmare/',
          'click the "Accept the inevitable" button',
          'click the 4 star rating',
          'verify the text "Rated 4 stars" is shown',
        ],
      },
      {
        name: 'SEED: Subscribe inside the nested iframe',
        path: '/',
        steps: [
          'navigate to http://site-nightmare/',
          'type "bench@kaizen.local" in the email field of the subscribe form',
          'click the "Subscribe" button',
          'verify the text "Subscribed to the void." is shown',
        ],
      },
      {
        name: 'SEED: Pin a row in the churning live feed',
        path: '/',
        steps: [
          'navigate to http://site-nightmare/',
          'click the first "Pin this" button',
          'verify the text "Pinned:" is shown',
        ],
      },
      {
        name: 'SEED: Portal modal seals the typed text',
        path: '/',
        steps: [
          'navigate to http://site-nightmare/',
          'click the "Summon modal" button',
          'type "kaizen was here" in the modal text field',
          'click the "Seal it" button',
          'verify the text "Sealed: kaizen was here" is shown',
        ],
      },
      {
        name: 'SEED: Deep ledger row renders after scroll',
        path: '/#/ledger',
        steps: [
          'navigate to http://site-nightmare/#/ledger',
          'verify the text "Entry #333 — the hidden ledger line" is shown',
        ],
      },
      {
        name: 'SEED: About page is boring on purpose',
        path: '/#/about',
        steps: [
          'navigate to http://site-nightmare/#/about',
          'verify the text "Built to break the brave." is shown',
        ],
      },
      {
        name: 'SEED: Captcha fails honestly (must-fail)',
        path: '/',
        steps: [
          'navigate to http://site-nightmare/',
          'check the "I am not a robot" checkbox',
          'verify the text "Verification passed" is shown',
        ],
      },
      {
        name: 'SEED: Closed vault stays closed (must-fail)',
        path: '/',
        steps: [
          'navigate to http://site-nightmare/',
          'click the "Secret vault" button',
          'verify the text "The vault opens. It is empty." is shown',
        ],
      },
    ],
  },
];

export function siteById(id: string): SiteDef {
  const site = FLEET.find((s) => s.id === id);
  if (!site) throw new Error(`unknown site '${id}' — known: ${FLEET.map((s) => s.id).join(', ')}`);
  return site;
}

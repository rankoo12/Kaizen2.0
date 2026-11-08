/* Nightmare adversarial widgets — one component per charter trap. Every trap
   is reachable from the home view and every outcome is visible text a test
   can assert on (or, for the two must-fail probes, deliberately is NOT).
   Each widget loads through nightmareApi so trap 1's seeded latency table
   governs it, and each renders a trap-2 skeleton that mimics its final
   layout until the content swaps in. */
(function () {
  var B = window.Nightmare;
  var html = B.html;
  var React = B.React;
  var ReactDOM = window.ReactDOM;
  var A = B.atoms;
  var D = window.NIGHTMARE_DATA;

  // ── Trap 3: nested iframes, 2 deep ─────────────────────────────────────────
  // An outer srcdoc iframe contains an inner srcdoc iframe; the subscribe
  // form lives in the INNER one and shows "Subscribed to the void." on
  // submit. The engine must enter two frame boundaries to act and assert.
  var innerDoc =
    '<!doctype html><meta charset="utf-8"><body style="font:13px system-ui;margin:10px;color:#2a2438">' +
    '<p id="void-status">Join the void newsletter.</p>' +
    '<form id="void-form" onsubmit="event.preventDefault();document.getElementById(\'void-status\').textContent=\'Subscribed to the void.\'">' +
    '<input id="void-email" type="email" placeholder="you@nowhere.example" required style="padding:6px 8px;border:1px solid #bbb;border-radius:6px"> ' +
    '<button id="void-subscribe" type="submit" style="padding:6px 12px;border:0;border-radius:6px;background:#5b3df0;color:#fff;cursor:pointer">Subscribe</button>' +
    '</form></body>';
  function escAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
  var outerDoc =
    '<!doctype html><meta charset="utf-8"><body style="font:13px system-ui;margin:10px;color:#2a2438">' +
    '<p id="relay-note">Transmission relay — hop 1 of 2. The form is one layer deeper.</p>' +
    '<iframe id="nest-inner" title="Void newsletter" style="width:100%;height:120px;border:1px dashed #999;border-radius:6px" srcdoc="' + escAttr(innerDoc) + '"></iframe>' +
    '</body>';
  function NestedFrames() {
    var a = B.useAsync(function () { return B.load('nest', true); }, []);
    return html`<${A.Card} id="nest-card">
      <h2>Void newsletter</h2>
      ${a.loading
        ? html`<${React.Fragment}><${A.ShimmerLine} w="80%" /><${A.ShimmerBlock} h=${190} /></${React.Fragment}>`
        : html`<${React.Fragment}>
            <p class="muted">Sponsored, from somewhere far away.</p>
            <iframe id="nest-outer" title="Transmission relay" srcdoc=${outerDoc} style=${{ width: '100%', height: '190px', border: '0' }}></iframe>
          </${React.Fragment}>`}
    </${A.Card}>`;
  }

  // ── Trap 4a: OPEN shadow DOM rating control ────────────────────────────────
  // Stars live inside an open shadow root (piercable); the outcome "Rated N
  // stars" is written to the LIGHT DOM, so the click is verifiable.
  if (!customElements.get('nightmare-rating')) {
    customElements.define('nightmare-rating', class extends HTMLElement {
      connectedCallback() {
        var self = this;
        var root = this.attachShadow({ mode: 'open' });
        var stars = [1, 2, 3, 4, 5];
        root.innerHTML =
          '<style>button{font:20px system-ui;background:none;border:1px solid #4a4266;border-radius:7px;color:#f0c437;padding:6px 11px;margin-right:6px;cursor:pointer}button:hover{background:#2a2440}</style>' +
          stars.map(function (n) { return '<button class="star" data-n="' + n + '" aria-label="Rate ' + n + '">★</button>'; }).join('');
        Array.prototype.forEach.call(root.querySelectorAll('.star'), function (b) {
          b.onclick = function () {
            self.dispatchEvent(new CustomEvent('rated', { detail: Number(b.getAttribute('data-n')) }));
          };
        });
      }
    });
  }
  function ShadowRating() {
    var a = B.useAsync(function () { return B.load('rating', true); }, []);
    var n = React.useState(0);
    var ref = React.useRef(null);
    React.useEffect(function () {
      var el = ref.current; if (!el) return;
      var h = function (e) { n[1](e.detail); };
      el.addEventListener('rated', h);
      return function () { el.removeEventListener('rated', h); };
    }, [a.loading]);
    return html`<${A.Card} id="rating-card">
      <h2>Rate your stay</h2>
      ${a.loading
        ? html`<div class="pill-row"><${A.ShimmerPill} w=${44} /><${A.ShimmerPill} w=${44} /><${A.ShimmerPill} w=${44} /><${A.ShimmerPill} w=${44} /><${A.ShimmerPill} w=${44} /></div>`
        : html`<${React.Fragment}>
            <nightmare-rating ref=${ref}></nightmare-rating>
            ${n[0] > 0
              // Always "N stars" (even for 1) so the assertable format is uniform.
              ? html`<p class="ok-line" id="rating-outcome" role="status">Rated ${n[0]} stars</p>`
              : html`<p class="muted" id="rating-hint">Pick a star. They are inside an open shadow root.</p>`}
          </${React.Fragment}>`}
    </${A.Card}>`;
  }

  // ── Trap 4b: CLOSED shadow DOM vault — deliberate MUST-FAIL probe ──────────
  // The "Secret vault" button AND its click outcome live inside a closed
  // shadow root. The outcome text never appears in light DOM, so any test
  // asserting the vault's outcome must fail honestly; a pass is a false-pass.
  if (!customElements.get('nightmare-vault')) {
    customElements.define('nightmare-vault', class extends HTMLElement {
      connectedCallback() {
        var root = this.attachShadow({ mode: 'closed' }); // root ref exists only in this closure
        root.innerHTML =
          '<style>button{font:14px system-ui;background:#3a2e5c;border:0;border-radius:7px;color:#efeaff;padding:9px 16px;cursor:pointer}button:hover{background:#4a3c73}p{font:13px system-ui;color:#9ae6a0;margin:10px 0 0}</style>' +
          '<button id="vault-btn">Secret vault</button><p id="vault-status"></p>';
        root.querySelector('#vault-btn').onclick = function () {
          root.querySelector('#vault-status').textContent = 'The vault opens. It is empty.';
        };
      }
    });
  }
  function ClosedVault() {
    var a = B.useAsync(function () { return B.load('vault', true); }, []);
    return html`<${A.Card} id="vault-card">
      <h2>The vault</h2>
      ${a.loading
        ? html`<${React.Fragment}><${A.ShimmerPill} w=${110} /><${A.ShimmerLine} w="70%" /></${React.Fragment}>`
        : html`<${React.Fragment}>
            <nightmare-vault></nightmare-vault>
            <p class="muted" id="vault-note">Whatever happens in the vault stays in the vault.</p>
          </${React.Fragment}>`}
    </${A.Card}>`;
  }

  // ── Trap 5: div-soup ARIA misuse — 1 real control among 4 decoys ───────────
  // Five visually identical "buttons". Four are bare <div>s with
  // cursor:pointer, NO role, NO tabindex and no handler — they do nothing.
  // Only the one with role="button" tabindex="0" aria-label="Activate
  // reactor" works, and shows "Reactor online."
  function ReactorSoup() {
    var a = B.useAsync(function () { return B.load('reactor', true); }, []);
    var on = React.useState(false);
    var fire = function () { on[1](true); };
    var key = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); } };
    var slots = [];
    for (var i = 0; i < D.reactorSlots; i++) slots.push(i);
    return html`<${A.Card} id="reactor-card">
      <h2>Reactor controls</h2>
      ${a.loading
        ? html`<div class="pill-row">${slots.map(function (i) { return html`<${A.ShimmerPill} w=${88} key=${i} />`; })}</div>`
        : html`<${React.Fragment}>
            <p class="muted">One of these actually does something.</p>
            <div class="pill-row" id="reactor-row">
              ${slots.map(function (i) {
                return i === D.reactorRealIndex
                  ? html`<div class="soup-btn" id="reactor-real" role="button" tabindex="0" aria-label="Activate reactor"
                       onClick=${fire} onKeyDown=${key} key=${i}>Activate</div>`
                  : html`<div class="soup-btn" key=${i}>Activate</div>`; // decoy: inert on purpose
              })}
            </div>
            ${on[0] ? html`<p class="ok-line" id="reactor-outcome" role="status">Reactor online.</p>` : null}
          </${React.Fragment}>`}
    </${A.Card}>`;
  }

  // ── Trap 6: cookie-banner overlay, 3s AFTER load ───────────────────────────
  // Covers the bottom third (fixed, opaque, high z-index) and so intercepts
  // clicks on anything under it until "Accept the inevitable" is clicked.
  // Dismissal is remembered in sessionStorage — it never returns. The 3s
  // timer is armed by app.js from NIGHTMARE_LATENCY_MS.cookie.
  function CookieBanner() {
    var s = B.store.use();
    if (s.cookie !== 'shown') return null;
    var accept = function () {
      try { sessionStorage.setItem('nightmareCookieAccepted', '1'); } catch (e) { /* storage may be blocked; the store still remembers for this page */ }
      B.store.set({ cookie: 'gone' });
    };
    return html`<div class="cookie-wall" id="cookie-wall" role="dialog" aria-label="Cookie consent">
      <div class="cookie-inner">
        <h3 id="cookie-title">We use cookies. All of them.</h3>
        <p class="muted">This banner is covering the bottom third of the page and it knows it.</p>
        <${A.Btn} id="cookie-accept" onClick=${accept}>Accept the inevitable</${A.Btn}>
      </div>
    </div>`;
  }

  // ── Trap 7: volatile list churn ────────────────────────────────────────────
  // The feed re-renders every NIGHTMARE_LATENCY_MS.churn ms with the SAME
  // content but new React keys, so every DOM node is REPLACED each tick.
  // Any handle grabbed on a row goes stale within 900ms. "Pin this" works;
  // its outcome renders OUTSIDE the churning container so it survives.
  function ChurnFeed() {
    var a = B.useAsync(function () { return B.load('liveFeed', D.liveFeed); }, []);
    var tick = React.useState(0);
    var pinned = React.useState('');
    React.useEffect(function () {
      if (a.loading) return;
      var t = setInterval(function () { tick[1](function (x) { return x + 1; }); }, window.NIGHTMARE_LATENCY_MS.churn);
      return function () { clearInterval(t); };
    }, [a.loading]);
    var pin = function (title) {
      B.load('pin', title).then(function (t) { pinned[1](t); });
    };
    return html`<${A.Card} id="live-card">
      <h2>Live feed</h2>
      ${a.loading
        ? html`<${React.Fragment}><${A.ShimmerRow} /><${A.ShimmerRow} /><${A.ShimmerRow} /><${A.ShimmerRow} /><${A.ShimmerRow} /></${React.Fragment}>`
        : html`<${React.Fragment}>
            <div id="live-rows">
              ${a.data.map(function (r) {
                // key includes the tick → full node replacement every churn
                return html`<div class="feed-row" key=${r.id + ':' + tick[0]}>
                  <div><strong>${r.title}</strong><span class="muted"> · ${r.meta}</span></div>
                  <${A.Btn} variant="ghost" onClick=${function () { pin(r.title); }}>Pin this</${A.Btn}>
                </div>`;
              })}
            </div>
            ${pinned[0] ? html`<p class="ok-line" id="pin-outcome" role="status">Pinned: ${pinned[0]}</p>` : null}
          </${React.Fragment}>`}
    </${A.Card}>`;
  }

  // ── Trap 8: portal-rendered modal ──────────────────────────────────────────
  // "Summon modal" renders the modal through a React portal into a div
  // appended at the END of document.body — nowhere near the summoning
  // button in the tree. Typing into it and clicking "Seal it" shows
  // "Sealed: <typed text>" back in the page section.
  function portalHost() {
    var el = document.getElementById('nightmare-portal');
    if (!el) { el = document.createElement('div'); el.id = 'nightmare-portal'; document.body.appendChild(el); }
    return el;
  }
  function PortalWell() {
    var a = B.useAsync(function () { return B.load('portal', true); }, []);
    var open = React.useState(false);
    var txt = React.useState('');
    var sealed = React.useState('');
    var doSeal = function () {
      var t = txt[0];
      B.load('seal', t).then(function () { sealed[1](t); open[1](false); txt[1]('');});
    };
    var modal = open[0] ? ReactDOM.createPortal(
      html`<div class="scrim" id="seal-scrim">
        <div class="modal" id="seal-modal" role="dialog" aria-label="The sealing">
          <h3>The sealing</h3>
          <p class="muted">Whatever you type will be sealed. Probably forever.</p>
          <input id="seal-input" placeholder="Words to seal" value=${txt[0]} onInput=${function (e) { txt[1](e.target.value); }} />
          <div class="modal-actions">
            <${A.Btn} id="seal-btn" onClick=${doSeal}>Seal it</${A.Btn}>
          </div>
        </div>
      </div>`, portalHost()) : null;
    return html`<${A.Card} id="portal-card">
      <h2>The summoning circle</h2>
      ${a.loading
        ? html`<${React.Fragment}><${A.ShimmerLine} w="75%" /><${A.ShimmerPill} w=${140} /></${React.Fragment}>`
        : html`<${React.Fragment}>
            <p class="muted">The modal does not render here. It renders at the end of the body.</p>
            <${A.Btn} id="summon-modal" onClick=${function () { open[1](true); }}>Summon modal</${A.Btn}>
            ${sealed[0] ? html`<p class="ok-line" id="seal-outcome" role="status">Sealed: ${sealed[0]}</p>` : null}
            ${modal}
          </${React.Fragment}>`}
    </${A.Card}>`;
  }

  // ── Trap 10: fake captcha gate — honest MUST-FAIL probe ────────────────────
  // The checkbox can be checked; verification then ALWAYS lands on
  // "Verification failed. Try again." There is no success state in the code.
  // A test expecting verification to succeed must fail honestly.
  function FakeCaptcha() {
    var a = B.useAsync(function () { return B.load('captcha', true); }, []);
    var phase = React.useState('idle'); // idle | checking | failed
    var onToggle = function (e) {
      if (!e.target.checked || phase[0] === 'checking') return;
      phase[1]('checking');
      B.load('verify', true).then(function () { phase[1]('failed'); });
    };
    return html`<${A.Card} id="captcha-card">
      <h2>Robot checkpoint</h2>
      ${a.loading
        ? html`<${React.Fragment}><${A.ShimmerLine} w="55%" /><${A.ShimmerLine} w="80%" /></${React.Fragment}>`
        : html`<${React.Fragment}>
            <label class="captcha-row" id="captcha-label">
              <input type="checkbox" id="captcha-box" checked=${phase[0] === 'checking'} onChange=${onToggle} />
              I am not a robot
            </label>
            ${phase[0] === 'checking' ? html`<p class="muted" id="captcha-checking">Verifying…</p>` : null}
            ${phase[0] === 'failed' ? html`<p class="err-line" id="captcha-outcome" role="alert">Verification failed. Try again.</p>` : null}
          </${React.Fragment}>`}
    </${A.Card}>`;
  }

  B.widgets = {
    NestedFrames: NestedFrames,
    ShadowRating: ShadowRating,
    ClosedVault: ClosedVault,
    ReactorSoup: ReactorSoup,
    CookieBanner: CookieBanner,
    ChurnFeed: ChurnFeed,
    PortalWell: PortalWell,
    FakeCaptcha: FakeCaptcha,
  };
})();

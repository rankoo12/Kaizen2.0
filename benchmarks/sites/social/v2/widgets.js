/* Buzzly adversarial widgets — the patterns that make real-world automation
   hard. Each is DIAGNOSTIC: either the engine handles it (a win) or it can't
   and a seed test fails honestly (a finding about the engine's reach). */
(function () {
  var B = window.Buzzly;
  var html = B.html;
  var React = B.React;
  var D = window.BUZZLY_DATA;

  // ── 1. Shadow DOM web component: a poll inside an OPEN shadow root ──────────
  // Playwright CAN pierce open shadow roots; whether Kaizen's pruner/AX surfaces
  // the inner button is the test. Rendered once, imperatively, as a custom
  // element so React never sees its internals.
  if (!customElements.get('buzzly-poll')) {
    customElements.define('buzzly-poll', class extends HTMLElement {
      connectedCallback() {
        var poll = D.poll;
        var root = this.attachShadow({ mode: 'open' });
        var voted = -1;
        var render = function () {
          root.innerHTML =
            '<style>.p{font:14px system-ui}.o{display:block;margin:6px 0;padding:8px 12px;border:1px solid #c4d0e0;border-radius:7px;background:#fff;cursor:pointer;width:100%;text-align:left}.ok{margin-top:8px;color:#1d7a2c;font-weight:600}</style>' +
            '<div class="p"><strong>' + poll.q + '</strong>' +
            poll.options.map(function (o, i) { return '<button class="o" data-i="' + i + '">' + o + '</button>'; }).join('') +
            (voted >= 0 ? '<div class="ok" id="poll-result">You voted ' + poll.options[voted] + '.</div>' : '') +
            '</div>';
          Array.prototype.forEach.call(root.querySelectorAll('.o'), function (b) {
            b.onclick = function () { voted = Number(b.getAttribute('data-i')); render(); };
          });
        };
        render();
      }
    });
  }
  function ShadowPoll() { return html`<div class="card" id="poll-card"><buzzly-poll></buzzly-poll></div>`; }

  // ── 2. iframe widget (srcdoc) — a "sponsored" card with a button inside ─────
  // Interacting requires the engine to enter the frame. assert_text already
  // scans frames; a CLICK inside one is the harder ask.
  function IframeWidget() {
    var src = '<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;margin:10px">' +
      '<p id="promo">Trail Collective is hosting a cleanup Saturday.</p>' +
      '<button id="promo-join" onclick="document.getElementById(\'promo\').textContent=\'Thanks for signing up!\'">Sign up</button>' +
      '</body>';
    return html`<div class="card" id="iframe-card">
      <span class="muted">Sponsored</span>
      <iframe id="promo-frame" title="Sponsored widget" srcdoc=${src} style=${{ width: '100%', height: '90px', border: '0' }}></iframe>
    </div>`;
  }

  // ── 3. Canvas trends chart — text drawn on <canvas>, invisible to the DOM ───
  // A seed asserting a value shown ONLY on the canvas must fail honestly: the
  // engine cannot read pixels. That failure is the finding.
  function CanvasTrends() {
    var ref = React.useRef(null);
    React.useEffect(function () {
      var cv = ref.current; if (!cv) return;
      var ctx = cv.getContext('2d'); if (!ctx) return;
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.font = '13px system-ui'; ctx.fillStyle = '#1b3a6b';
      ctx.fillText('Trends this week', 10, 18);
      D.trends.forEach(function (t, i) {
        var y = 40 + i * 20;
        ctx.fillStyle = '#1d6ae5'; ctx.fillRect(10, y - 10, Math.min(t.posts / 8, 180), 12);
        ctx.fillStyle = '#15202b'; ctx.fillText('#' + t.tag + ' · ' + t.posts, 200, y);
      });
    }, []);
    return html`<div class="card" id="trends-card">
      <h2>Trends</h2>
      <canvas id="trends-canvas" ref=${ref} width="420" height="170" aria-label="Trends chart"></canvas>
    </div>`;
  }

  // ── 4. Infinite-spinner "live" tile — never resolves (liveWidget latency ∞) ─
  // A seed asserting its content must time out honestly — the engine must not
  // invent a pass for content that never arrives.
  function LiveTile() {
    var a = B.useAsync(function () { return window.buzzlyApi('liveWidget', 'LIVE: 42 watching'); }, []);
    return html`<div class="card" id="live-card">
      <h2>Live now</h2>
      ${a.loading ? html`<${B.atoms.Spinner} id="live-spinner" label="Connecting to live…" />`
        : html`<p id="live-text">${a.data}</p>`}
    </div>`;
  }

  // ── 5. Virtualized list hook — only the visible window is in the DOM ────────
  // Renders ~`win` of N rows; scrolling the container swaps which rows exist.
  // A target far down the list is NOT in the DOM until scrolled into view.
  function useVirtual(total, rowH, win) {
    var st = React.useState(0);
    var onScroll = function (e) {
      var start = Math.max(0, Math.floor(e.target.scrollTop / rowH) - 2);
      if (start !== st[0]) st[1](start);
    };
    var start = st[0];
    var end = Math.min(total, start + win);
    return { start: start, end: end, onScroll: onScroll, padTop: start * rowH, padBottom: (total - end) * rowH };
  }

  B.widgets = { ShadowPoll: ShadowPoll, IframeWidget: IframeWidget, CanvasTrends: CanvasTrends, LiveTile: LiveTile, useVirtual: useVirtual };
})();

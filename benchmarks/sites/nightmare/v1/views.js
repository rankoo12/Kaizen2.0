/* Nightmare views — three hash routes. Home (#/) stacks every trap widget;
   Ledger (#/ledger) is trap 9 (infinite scroll + virtualization); About
   (#/about) is trap 11's untouched control flow: plain, static, instant. */
(function () {
  var B = window.Nightmare;
  var html = B.html;
  var React = B.React;
  var A = B.atoms;
  var W = B.widgets;
  var D = window.NIGHTMARE_DATA;

  // ── Home: every trap on one page, each on its own seeded delay ─────────────
  function Home() {
    return html`<div class="layout" id="home">
      <main class="col-main">
        <${W.ReactorSoup} />
        <${W.ChurnFeed} />
        <${W.PortalWell} />
        <${W.FakeCaptcha} />
      </main>
      <aside class="col-side">
        <${W.ShadowRating} />
        <${W.ClosedVault} />
        <${W.NestedFrames} />
      </aside>
    </div>`;
  }

  // ── Trap 9: the ledger — infinite scroll + virtualization ──────────────────
  // 400 rows total, served in batches of 100 as you scroll near the loaded
  // end; of the loaded rows, only the ~14 visible exist in the DOM (the
  // rest are padding divs). Row #333 — "Entry #333 — the hidden ledger
  // line" — therefore requires three load-mores AND scrolling it into view
  // before it exists anywhere in the document.
  var ROW_H = 44;
  var WIN = 14;
  function Ledger() {
    var loaded = React.useState(0);
    var more = React.useState(false);
    React.useEffect(function () {
      var alive = true;
      B.load('ledger', D.ledgerBatch).then(function (n) { if (alive) loaded[1](n); });
      return function () { alive = false; };
    }, []);
    var v = B.useVirtual(loaded[0], ROW_H, WIN);
    var onScroll = function (e) {
      v.onScroll(e);
      var el = e.target;
      // Infinite scroll: approaching the bottom of what is loaded fetches
      // the next batch (on its own seeded ledgerMore delay).
      if (!more[0] && loaded[0] < D.ledgerTotal && el.scrollTop + el.clientHeight > loaded[0] * ROW_H - 260) {
        more[1](true);
        B.load('ledgerMore', D.ledgerBatch).then(function (n) {
          loaded[1](function (x) { return Math.min(D.ledgerTotal, x + n); });
          more[1](false);
        });
      }
    };
    var rows = [];
    for (var i = v.start; i < v.end; i++) {
      var n = i + 1;
      rows.push(html`<div class="ledger-row" id=${'ledger-row-' + n} key=${n}>${window.nightmareLedgerText(n)}</div>`);
    }
    return html`<div class="layout one-col">
      <main class="col-main">
        <${A.Card} id="ledger-card">
          <h1>The Ledger</h1>
          <p class="muted" id="ledger-state">
            ${loaded[0] === 0 ? 'Opening the ledger…'
              : loaded[0] + ' of ' + D.ledgerTotal + ' entries loaded' + (more[0] ? ' — summoning more…' : '')}
          </p>
          ${loaded[0] === 0
            // Trap 2: the skeleton mimics the final layout — same scroll box,
            // same row height, shimmer where the entries will be.
            ? html`<div class="ledger-scroll">${[0, 1, 2, 3, 4, 5, 6, 7].map(function (k) { return html`<div class="sk sk-ledger" key=${k}></div>`; })}</div>`
            : html`<div class="ledger-scroll" id="ledger-scroll" onScroll=${onScroll}>
                <div style=${{ height: v.padTop + 'px' }}></div>
                ${rows}
                <div style=${{ height: v.padBottom + 'px' }}></div>
              </div>`}
        </${A.Card}>
      </main>
    </div>`;
  }

  // ── Trap 11: the untouched control flow — plain, static, instant ───────────
  function About() {
    return html`<div class="layout one-col">
      <main class="col-main">
        <${A.Card} id="about-card">
          <h1>About</h1>
          <p id="about-text">Built to break the brave.</p>
          <p class="muted">No delays, no shadows, no frames. This page is the control group.</p>
        </${A.Card}>
      </main>
    </div>`;
  }

  B.views = { Home: Home, Ledger: Ledger, About: About };
})();

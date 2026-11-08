/* Nightmare foundation — same "modern, no build step" core as Buzzly:
   htm binds JSX-like tagged templates to React.createElement; everything
   hangs off window.Nightmare. Holds the tiny store, the hooks, the latency
   helper wrapper, and the skeleton atoms (charter trap 2: skeletons must
   MIMIC the final layout — same boxes, shimmer — so each widget's loading
   state is shaped like its loaded state, not a generic card). */
(function () {
  var React = window.React;
  var html = window.htm.bind(React.createElement);
  var h = React.createElement;

  // ── Tiny global store ──────────────────────────────────────────────────────
  function createStore(initial) {
    var state = initial;
    var listeners = new Set();
    return {
      get: function () { return state; },
      set: function (patch) {
        state = Object.assign({}, state, typeof patch === 'function' ? patch(state) : patch);
        listeners.forEach(function (l) { l(state); });
      },
      use: function () {
        var ref = React.useState(state);
        React.useEffect(function () {
          var l = function (s) { ref[1](s); };
          listeners.add(l);
          return function () { listeners.delete(l); };
        }, []);
        return state;
      },
    };
  }

  var store = createStore({
    route: readRoute(),
    cookie: 'pending', // trap 6 lifecycle: pending → shown → gone
  });

  function readRoute() {
    return (window.location.hash.replace(/^#\/?/, '') || 'home');
  }

  // ── Hooks ──────────────────────────────────────────────────────────────────
  function useRoute() {
    var s = store.use();
    React.useEffect(function () {
      var onHash = function () { store.set({ route: readRoute() }); };
      window.addEventListener('hashchange', onHash);
      return function () { window.removeEventListener('hashchange', onHash); };
    }, []);
    return s.route;
  }

  function useAsync(fn, deps) {
    var st = React.useState({ data: null, loading: true });
    React.useEffect(function () {
      var alive = true;
      st[1]({ data: null, loading: true });
      Promise.resolve(fn()).then(function (d) { if (alive) st[1]({ data: d, loading: false }); });
      return function () { alive = false; };
    }, deps || []);
    return st[0];
  }

  // The latency helper every widget loads through: name → seeded delay from
  // NIGHTMARE_LATENCY_MS (trap 1), resolved with the payload.
  function load(name, payload) { return window.nightmareApi(name, payload); }

  // Trap 9 — virtualization hook: only ~`win` of `total` rows exist in the
  // DOM; scrolling swaps which rows exist. A row far down the list is NOT in
  // the DOM until scrolled into view.
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

  // ── UI atoms ───────────────────────────────────────────────────────────────
  function Btn(props) {
    var rest = Object.assign({}, props);
    delete rest.variant; delete rest.children;
    return html`<button class=${'btn ' + (props.variant || '')} ...${rest}>${props.children}</button>`;
  }
  function Card(props) { return html`<section class=${'card ' + (props.class || '')} id=${props.id}>${props.children}</section>`; }

  // Trap 2 skeleton atoms. ShimmerLine/ShimmerBlock/ShimmerPill are sized by
  // the caller to the SAME dimensions as the content they stand in for, so
  // the skeleton screen mimics the final layout box for box.
  function ShimmerLine(props) { return html`<div class="sk sk-line" style=${{ width: props.w || '60%' }}></div>`; }
  function ShimmerBlock(props) { return html`<div class="sk sk-block" style=${{ height: (props.h || 80) + 'px' }}></div>`; }
  function ShimmerPill(props) { return html`<div class="sk sk-pill" style=${{ width: (props.w || 88) + 'px', height: (props.h || 38) + 'px' }}></div>`; }
  function ShimmerRow() { return html`<div class="sk sk-row"></div>`; }

  window.Nightmare = {
    React: React, h: h, html: html,
    store: store, useRoute: useRoute, useAsync: useAsync, useVirtual: useVirtual, load: load,
    atoms: {
      Btn: Btn, Card: Card,
      ShimmerLine: ShimmerLine, ShimmerBlock: ShimmerBlock, ShimmerPill: ShimmerPill, ShimmerRow: ShimmerRow,
    },
    views: {},    // filled by views.js
    widgets: {},  // filled by widgets.js
  };
})();

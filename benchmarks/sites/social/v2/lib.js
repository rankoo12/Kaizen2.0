/* Buzzly foundation — the "modern, no build step" core.
   htm binds JSX-like tagged templates to React.createElement, so components
   read like real JSX without a bundler. Everything hangs off window.Buzzly:
   a tiny global store with a useStore hook, a handful of custom hooks, and the
   shared UI atoms every view composes from. */
(function () {
  var React = window.React;
  var html = window.htm.bind(React.createElement);
  var h = React.createElement;

  // ── Tiny global store (modern "signals-ish" pattern, no dependency) ────────
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
    toasts: [],
    unread: window.BUZZLY_DATA.notifications.length,
    lang: 'en',
  });

  function readRoute() {
    return (window.location.hash.replace(/^#\/?/, '') || 'feed');
  }

  // ── Custom hooks ───────────────────────────────────────────────────────────
  function useRoute() {
    var s = store.use();
    React.useEffect(function () {
      var onHash = function () { store.set({ route: readRoute() }); };
      window.addEventListener('hashchange', onHash);
      return function () { window.removeEventListener('hashchange', onHash); };
    }, []);
    return s.route;
  }

  // Loads `fn()` (a promise) on mount / when deps change; returns {data,loading}.
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

  // Toast system: push() shows a toast that AUTO-DISMISSES after 2.5s — an
  // assertion must catch it before it vanishes (a real race).
  function pushToast(text) {
    var id = 't' + Date.now() + Math.random();
    store.set(function (s) { return { toasts: s.toasts.concat([{ id: id, text: text }]) }; });
    setTimeout(function () {
      store.set(function (s) { return { toasts: s.toasts.filter(function (t) { return t.id !== id; }) }; });
    }, 2500);
  }

  // ── UI atoms (the design system) ───────────────────────────────────────────
  function Btn(props) {
    var rest = Object.assign({}, props);
    delete rest.variant; delete rest.children;
    return html`<button class=${'btn ' + (props.variant || '')} ...${rest}>${props.children}</button>`;
  }
  function Card(props) { return html`<section class=${'card ' + (props.class || '')} id=${props.id}>${props.children}</section>`; }
  function Skeleton(props) { return html`<div class="skeleton-card" id=${props.id}></div>`; }
  function Spinner(props) { return html`<div class="spinner" id=${props.id} role="status">${props.label || 'Loading…'}</div>`; }

  function ToastHost() {
    var s = store.use();
    return html`<div class="toast-host" id="toast-host">
      ${s.toasts.map(function (t) { return html`<div class="toast" id=${t.id} role="status" key=${t.id}>${t.text}</div>`; })}
    </div>`;
  }

  window.Buzzly = {
    React: React, h: h, html: html,
    store: store, useRoute: useRoute, useAsync: useAsync, pushToast: pushToast,
    atoms: { Btn: Btn, Card: Card, Skeleton: Skeleton, Spinner: Spinner, ToastHost: ToastHost },
    views: {},    // filled by views.js
    widgets: {},  // filled by widgets.js
  };
})();

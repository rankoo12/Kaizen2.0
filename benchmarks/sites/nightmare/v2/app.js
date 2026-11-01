/* Nightmare app shell — the boring, fast header nav (trap 11), the hash
   router, the trap-6 cookie-banner timer, and the mount. Composed entirely
   from the component modules on window.Nightmare. */
(function () {
  var B = window.Nightmare;
  var html = B.html;
  var React = B.React;
  var ReactDOM = window.ReactDOM;
  var V = B.views;
  var W = B.widgets;

  // Trap 11 — plain, instant nav. No delays, no tricks: the control flow.
  function Nav() {
    return html`<header class="topbar" id="topbar">
      <a class="brand" id="brand" href="#/">Nightmare</a>
      <nav aria-label="Main">
        <a href="#/" id="nav-home">Home</a>
        <a href="#/ledger" id="nav-ledger">Ledger</a>
        <a href="#/about" id="nav-about">About</a>
      </nav>
    </header>`;
  }

  function App() {
    var route = B.useRoute();

    // Trap 6 — arm the cookie banner: it appears NIGHTMARE_LATENCY_MS.cookie
    // (3s) after load, mid-run, unless this session already accepted it.
    // After "Fine. Proceed." (M2) it never returns (sessionStorage).
    React.useEffect(function () {
      var accepted = false;
      try { accepted = sessionStorage.getItem('nightmareCookieAccepted') === '1'; } catch (e) { /* blocked storage = banner every load */ }
      if (accepted) { B.store.set({ cookie: 'gone' }); return; }
      var t = setTimeout(function () {
        if (B.store.get().cookie === 'pending') B.store.set({ cookie: 'shown' });
      }, window.NIGHTMARE_LATENCY_MS.cookie);
      return function () { clearTimeout(t); };
    }, []);

    var view;
    if (route === 'ledger') view = html`<${V.Ledger} />`;
    else if (route === 'about') view = html`<${V.About} />`;
    else view = html`<${V.Home} />`;
    return html`<${React.Fragment}>
      <${Nav} />
      ${view}
      <${W.CookieBanner} />
      <footer id="footer">Nightmare is a synthetic site for the Kaizen engine bench. Nothing here is safe.</footer>
    </${React.Fragment}>`;
  }

  setTimeout(function () {
    ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
  }, window.NIGHTMARE_LATENCY_MS.boot);
})();

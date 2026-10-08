/* Buzzly app shell — chrome (nav + notifications dropdown), the hash router,
   and mount. Composed entirely from the component modules on window.Buzzly. */
(function () {
  var B = window.Buzzly;
  var html = B.html;
  var React = B.React;
  var ReactDOM = window.ReactDOM;
  var D = window.BUZZLY_DATA;
  var V = B.views;

  function NotificationsPanel() {
    var a = B.useAsync(function () { return window.buzzlyApi('notifications', D.notifications); }, []);
    var cleared = React.useState(false);
    return html`<div class="dropdown" id="notifications-panel">
      <h3>Notifications</h3>
      ${a.loading ? html`<p class="muted" id="notifications-loading">Loading notifications…</p>`
        : cleared[0] ? html`<p class="ok-line" id="notifications-done" role="status">All caught up.</p>`
          : html`<${React.Fragment}>
              <ul id="notifications-list">${a.data.map(function (n) { return html`<li id=${n.id} key=${n.id}>${n.text}</li>`; })}</ul>
              <button class="btn ghost" id="mark-read" onClick=${function () { cleared[1](true); B.store.set({ unread: 0 }); }}>Mark all as read</button>
            </${React.Fragment}>`}
    </div>`;
  }

  function Nav() {
    var s = B.store.use();
    var bellOpen = React.useState(false);
    return html`<header class="topbar" id="topbar">
      <a class="brand" id="brand" href="#/">Buzzly</a>
      <nav aria-label="Main">
        <a href="#/" id="nav-home">Home</a>
        <a href="#/explore" id="nav-explore">Explore</a>
        <a href="#/friends" id="nav-friends">Friends</a>
        <a href="#/messages" id="nav-messages">Messages</a>
        <a href="#/groups" id="nav-groups">Groups</a>
        <a href="#/watch" id="nav-watch">Watch</a>
      </nav>
      <button class="bell" id="bell" aria-label="Notifications" onClick=${function () { bellOpen[1](!bellOpen[0]); }}>
        Notifications${s.unread > 0 ? html`<span class="badge" id="bell-badge">${s.unread}</span>` : null}
      </button>
      ${bellOpen[0] ? html`<${NotificationsPanel} />` : null}
    </header>`;
  }

  function App() {
    var route = B.useRoute();
    var view;
    if (route.indexOf('profile-') === 0) view = html`<${V.Profile} personId=${route.slice('profile-'.length)} />`;
    else if (route === 'explore') view = html`<${V.Explore} />`;
    else if (route === 'friends') view = html`<${V.Friends} />`;
    else if (route === 'messages') view = html`<${V.Messages} />`;
    else if (route === 'groups') view = html`<${V.Groups} />`;
    else if (route === 'watch') view = html`<${V.Watch} />`;
    else view = html`<${V.Feed} />`;
    return html`<${React.Fragment}>
      <${Nav} />
      ${view}
      <${B.atoms.ToastHost} />
      <footer id="footer">Buzzly is a synthetic site for the Kaizen engine bench.</footer>
    </${React.Fragment}>`;
  }

  setTimeout(function () {
    ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
  }, window.BUZZLY_LATENCY_MS.boot);
})();

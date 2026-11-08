/* Buzzly views, part 2 — friends (drag-reorder favorites), messages (late
   thread + typing indicator), groups (modal-stack event creation), watch
   (video list + the infinite-spinner live tile reused), notifications. */
(function () {
  var B = window.Buzzly;
  var html = B.html;
  var React = B.React;
  var D = window.BUZZLY_DATA;
  var A = B.atoms;

  // ── Friends: accept requests + DRAG-TO-REORDER favorites (HTML5 DnD) ────────
  function Friends() {
    var loaded = B.useAsync(function () { return window.buzzlyApi('friends', true); }, []);
    var requests = React.useState(D.requests);
    var friends = React.useState(D.friends);
    var favorites = React.useState(D.favorites.slice());
    var accepted = React.useState(null);
    var dragIndex = React.useRef(null);
    if (loaded.loading) return html`<main class="col-main"><${A.Skeleton} id="friends-loading" /></main>`;
    var accept = function (rq) {
      window.buzzlyApi('action', true).then(function () {
        requests[1](requests[0].filter(function (r) { return r.id !== rq.id; }));
        friends[1]([rq.name].concat(friends[0]));
        accepted[1](rq.name);
      });
    };
    var drop = function (to) {
      var from = dragIndex.current; if (from == null || from === to) return;
      var next = favorites[0].slice(); var moved = next.splice(from, 1)[0]; next.splice(to, 0, moved);
      favorites[1](next); dragIndex.current = null;
    };
    return html`<main class="col-main">
      <h1 id="friends-title">Friends</h1>
      <${A.Card} id="friend-requests">
        <h2>Requests</h2>
        ${requests[0].length === 0 ? html`<p class="muted" id="no-requests">No pending requests.</p>` : null}
        ${requests[0].map(function (rq) { return html`<div class="request-row" id=${rq.id} key=${rq.id}>
          <span>${rq.name}<span class="muted"> · ${rq.mutual} mutual</span></span>
          <${A.Btn} id=${'accept-' + rq.id} onClick=${function () { accept(rq); }}>Accept<//>
        </div>`; })}
        ${accepted[0] ? html`<p class="ok-line" id="accepted-line" role="status">You are now friends with ${accepted[0]}.</p>` : null}
      </${A.Card}>
      <${A.Card} id="favorites-card">
        <h2>Favorites <span class="muted">(drag to reorder)</span></h2>
        <ul class="fav-list" id="fav-list">
          ${favorites[0].map(function (f, i) { return html`<li class="fav" id=${'fav-' + i} key=${f} draggable=${true}
              onDragStart=${function () { dragIndex.current = i; }}
              onDragOver=${function (e) { e.preventDefault(); }}
              onDrop=${function () { drop(i); }}>⠿ ${f}</li>`; })}
        </ul>
        <p class="muted" id="fav-order">Order: ${favorites[0].join(' → ')}</p>
      </${A.Card}>
      <${A.Card} id="friends-list">
        <h2>Your friends</h2>
        <p class="muted" id="friends-count">${friends[0].length} friends</p>
        ${friends[0].map(function (f) { return html`<div class="friend-row" key=${f}><span>${f}</span><a class="btn ghost" href="#/messages">Message</a></div>`; })}
      </${A.Card}>
    </main>`;
  }

  // ── Messages: conversation list; late thread; typing indicator before send ─
  function Messages() {
    var convos = B.useAsync(function () { return window.buzzlyApi('conversations', D.conversations); }, []);
    var active = React.useState(null);
    var thread = React.useState(null);
    var draft = React.useState('');
    var delivered = React.useState(false);
    var open = function (c) {
      active[1](c); thread[1](null); delivered[1](false);
      window.buzzlyApi('thread', c.thread).then(function (t) { thread[1](t); });
    };
    var send = function () {
      if (!draft[0].trim()) return;
      window.buzzlyApi('action', draft[0].trim()).then(function (t) { thread[1]((thread[0] || []).concat(['You: ' + t])); draft[1](''); delivered[1](true); });
    };
    return html`<main class="col-main messages" id="messages">
      <h1 id="messages-title">Messages</h1>
      ${convos.loading ? html`<${A.Skeleton} id="messages-loading" />` : html`<div class="messages-split">
        <div class="card convo-list" id="convo-list">
          ${convos.data.map(function (c) { return html`<button class=${'convo' + (active[0] && active[0].id === c.id ? ' active' : '')} id=${c.id} key=${c.id} onClick=${function () { open(c); }}>
            <strong>${c.who}</strong><span class="muted"> — ${c.preview}</span></button>`; })}
        </div>
        <div class="card thread-pane" id="thread-pane">
          ${!active[0] ? html`<p class="muted" id="thread-hint">Pick a conversation.</p>`
            : thread[0] === null ? html`<p class="muted" id="thread-loading">Loading conversation…</p>`
              : html`<${React.Fragment}>
                  <ul class="thread" id="thread">${thread[0].map(function (m, i) { return html`<li key=${i}>${m}</li>`; })}</ul>
                  ${delivered[0] ? html`<p class="muted" id="delivered" role="status">Delivered</p>` : null}
                  <div class="send-row">
                    <input id="message-input" placeholder=${'Message ' + active[0].who + '…'} value=${draft[0]} onInput=${function (e) { draft[1](e.target.value); }} />
                    <${A.Btn} id="message-send" onClick=${send}>Send<//>
                  </div>
                </${React.Fragment}>`}
        </div>
      </div>`}
    </main>`;
  }

  // ── Groups: join + MODAL STACK (Create event → Add guests sub-modal) ───────
  function Groups() {
    var loaded = B.useAsync(function () { return window.buzzlyApi('groups', true); }, []);
    var joined = React.useState({});
    var last = React.useState(null);
    var eventModal = React.useState(false);
    var guestModal = React.useState(false);
    var guests = React.useState(0);
    var created = React.useState(false);
    if (loaded.loading) return html`<main class="col-main"><${A.Skeleton} id="groups-loading" /></main>`;
    var join = function (g) { window.buzzlyApi('action', true).then(function () { var s = {}; s[g.id] = true; joined[1](Object.assign({}, joined[0], s)); last[1](g.name); }); };
    return html`<main class="col-main">
      <h1 id="groups-title">Groups</h1>
      <${A.Btn} id="create-event" onClick=${function () { eventModal[1](true); created[1](false); }}>Create event<//>
      ${last[0] ? html`<p class="ok-line" id="joined-line" role="status">Joined ${last[0]}.</p>` : null}
      ${created[0] ? html`<p class="ok-line" id="event-created" role="status">Event created with ${guests[0]} guests.</p>` : null}
      <div class="cards">${D.groups.map(function (g) { return html`<div class="card group" id=${g.id} key=${g.id}>
        <h3>${g.name}</h3><p class="muted">${g.members} members — ${g.blurb}</p>
        ${joined[0][g.id] ? html`<span class="joined-flag" id=${'joined-' + g.id}>Joined</span>` : html`<${A.Btn} id=${'join-' + g.id} onClick=${function () { join(g); }}>Join<//>`}
      </div>`; })}</div>
      ${eventModal[0] ? html`<div class="scrim" id="event-scrim">
        <div class="modal" role="dialog" id="event-modal">
          <h2>Create event</h2>
          <p class="muted">A ridge cleanup, a book night — your call.</p>
          <${A.Btn} variant="ghost" id="add-guests" onClick=${function () { guestModal[1](true); }}>Add guests<//>
          <p class="muted" id="guest-count">${guests[0]} guests added</p>
          <div class="modal-actions">
            <${A.Btn} variant="ghost" id="event-cancel" onClick=${function () { eventModal[1](false); }}>Cancel<//>
            <${A.Btn} id="event-save" onClick=${function () { eventModal[1](false); created[1](true); }}>Save event<//>
          </div>
          ${guestModal[0] ? html`<div class="scrim nested" id="guest-scrim">
            <div class="modal" role="dialog" id="guest-modal">
              <h2>Add guests</h2>
              ${['Mira Chen', 'Dev Narang', 'Amara Osei'].map(function (p) { return html`<button class="guest" id=${'guest-' + p.split(' ')[0].toLowerCase()} key=${p} onClick=${function () { guests[1](guests[0] + 1); }}>Invite ${p}</button>`; })}
              <${A.Btn} id="guests-done" onClick=${function () { guestModal[1](false); }}>Done<//>
            </div>
          </div>` : null}
        </div>
      </div>` : null}
    </main>`;
  }

  // ── Watch: video list + the infinite-spinner live tile ─────────────────────
  function Watch() {
    var loaded = B.useAsync(function () { return window.buzzlyApi('watch', D.videos); }, []);
    var playing = React.useState(null);
    if (loaded.loading) return html`<main class="col-main"><${A.Skeleton} id="watch-loading" /></main>`;
    return html`<main class="col-main">
      <h1 id="watch-title">Watch</h1>
      <${B.widgets.LiveTile} />
      <div class="cards">${loaded.data.map(function (v) { return html`<div class="card video" id=${v.id} key=${v.id}>
        <div class="thumb">▶</div>
        <h3>${v.title}</h3><p class="muted">${v.who} · ${v.len}</p>
        <${A.Btn} id=${'play-' + v.id} onClick=${function () { window.buzzlyApi('action', true).then(function () { playing[1](v.title); }); }}>Play<//>
      </div>`; })}</div>
      ${playing[0] ? html`<p class="ok-line" id="now-playing" role="status">Now playing: ${playing[0]}</p>` : null}
    </main>`;
  }

  B.views.Friends = Friends;
  B.views.Messages = Messages;
  B.views.Groups = Groups;
  B.views.Watch = Watch;
})();

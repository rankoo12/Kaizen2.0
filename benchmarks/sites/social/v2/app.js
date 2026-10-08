/* Buzzly — a deliberately complicated social app, frontend only.
   React 18 UMD, hash routes, every network interaction goes through the fake
   API (data.js) so every loading time is tunable in one table. Every
   interaction ends in a visible, assertable outcome text — complexity stays
   DIAGNOSTIC: when a test fails here, the failure point has a name. */
/* global React, ReactDOM, BUZZLY_DATA, buzzlyApi */
(function () {
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;
  const D = BUZZLY_DATA;

  function useRoute() {
    const read = () => window.location.hash.replace(/^#\/?/, '') || 'feed';
    const [route, setRoute] = useState(read);
    useEffect(() => {
      const onHash = () => setRoute(read());
      window.addEventListener('hashchange', onHash);
      return () => window.removeEventListener('hashchange', onHash);
    }, []);
    return route;
  }

  // ── Chrome ─────────────────────────────────────────────────────────────────
  function Nav({ unread, onBell, bellOpen }) {
    return h('header', { className: 'topbar', id: 'topbar' },
      h('a', { className: 'brand', id: 'brand', href: '#/' }, 'Buzzly'),
      h('nav', { 'aria-label': 'Main' },
        h('a', { href: '#/', id: 'nav-home' }, 'Home'),
        h('a', { href: '#/explore', id: 'nav-explore' }, 'Explore'),
        h('a', { href: '#/friends', id: 'nav-friends' }, 'Friends'),
        h('a', { href: '#/messages', id: 'nav-messages' }, 'Messages'),
        h('a', { href: '#/groups', id: 'nav-groups' }, 'Groups'),
      ),
      h('button', { className: 'bell', id: 'bell', onClick: onBell, 'aria-label': 'Notifications' },
        'Notifications', unread > 0 ? h('span', { className: 'badge', id: 'bell-badge' }, unread) : null),
      bellOpen ? h(NotificationsPanel) : null,
    );
  }

  function NotificationsPanel() {
    const [items, setItems] = useState(null);
    const [cleared, setCleared] = useState(false);
    useEffect(() => { buzzlyApi('notifications', D.notifications).then(setItems); }, []);
    return h('div', { className: 'dropdown', id: 'notifications-panel' },
      h('h3', null, 'Notifications'),
      items === null
        ? h('p', { className: 'muted', id: 'notifications-loading' }, 'Loading notifications…')
        : cleared
          ? h('p', { className: 'ok-line', id: 'notifications-done', role: 'status' }, 'All caught up.')
          : h(React.Fragment, null,
              h('ul', { id: 'notifications-list' }, items.map((n) => h('li', { key: n.id, id: n.id }, n.text))),
              h('button', { className: 'btn ghost', id: 'mark-read', onClick: () => { setCleared(true); window.dispatchEvent(new Event('buzzly:read')); } }, 'Mark all as read')),
    );
  }

  // ── Feed pieces ────────────────────────────────────────────────────────────
  // v2 mutation: feature-removed (MUST-FAIL). Stories were cut from the
  // product; any v1 test that opens a story must fail honestly.

  function Composer({ onPosted }) {
    const [text, setText] = useState('');
    const [state, setState] = useState(null); // 'ok' | 'err'
    const submit = () => {
      if (!text.trim()) { setState('err'); return; }
      buzzlyApi('action', text.trim()).then((t) => { onPosted(t); setText(''); setState('ok'); });
    };
    return h('section', { className: 'card composer', id: 'composer' },
      h('label', { htmlFor: 'composer-text' }, "What's buzzing?"),
      h('textarea', { id: 'composer-text', placeholder: 'Tell your people something…', value: text, onChange: (e) => setText(e.target.value) }),
      h('div', { className: 'composer-row' },
        // v2 mutation: decoy-added. "Posting guidelines" is a lookalike next to
        // the real submit — a heal that clicks it is a wrong-element grab.
        h('button', { className: 'btn ghost', id: 'decoy-post-guidelines', 'data-decoy': 'true', onClick: () => setState(state === 'tips' ? null : 'tips') }, 'Posting guidelines'),
        // v2 mutation: label-rename. "Post" became "Publish" (id churned with it).
        h('button', { className: 'btn', id: 'composer-publish', onClick: submit }, 'Publish')),
      state === 'tips' ? h('p', { className: 'muted', id: 'posting-tips' }, 'Be kind, be concise, no spoilers. (Just a help note.)') : null,
      state === 'ok' ? h('p', { className: 'ok-line', id: 'composer-ok', role: 'status' }, 'Your post is live.') : null,
      state === 'err' ? h('p', { className: 'err-line', id: 'composer-err', role: 'alert' }, 'Write something first.') : null,
    );
  }

  function PostCard({ post }) {
    const [liked, setLiked] = useState(false);
    const [likes, setLikes] = useState(post.likes);
    const [comments, setComments] = useState(post.comments);
    const [commenting, setCommenting] = useState(false);
    const [draft, setDraft] = useState('');
    const [shared, setShared] = useState(false);
    const like = () => buzzlyApi('action', null).then(() => { setLiked(!liked); setLikes(likes + (liked ? -1 : 1)); });
    const reply = () => {
      if (!draft.trim()) return;
      buzzlyApi('action', draft.trim()).then((t) => { setComments(comments.concat(['You: ' + t])); setDraft(''); });
    };
    // v2 mutation: dom-restructure. Posts now render inside a .card-shell
    // wrapper and the article itself lost the .card class — same content,
    // same accessible names, new DOM shape.
    return h('div', { className: 'card-shell' }, h('article', { className: 'post', id: 'post-' + post.id },
      h('header', { className: 'post-head' }, h('strong', null, post.who), h('span', { className: 'muted' }, ' · ' + post.when)),
      h('p', { className: 'post-text' }, post.text),
      h('div', { className: 'post-actions' },
        h('button', { className: 'btn ghost', id: 'like-' + post.id, onClick: like }, liked ? 'Liked' : 'Like'),
        h('span', { className: 'muted count', id: 'likes-' + post.id }, likes + ' likes'),
        h('button', { className: 'btn ghost', id: 'comment-' + post.id, onClick: () => setCommenting(!commenting) }, 'Comment'),
        h('span', { className: 'muted count', id: 'comments-' + post.id }, comments.length + ' comments'),
        h('button', { className: 'btn ghost', id: 'share-' + post.id, onClick: () => buzzlyApi('action', null).then(() => setShared(true)) }, 'Share')),
      shared ? h('p', { className: 'ok-line', id: 'shared-' + post.id, role: 'status' }, 'Shared!' /* v2 mutation: assertion-changed (MUST-FAIL) — the old copy is gone */) : null,
      comments.length ? h('ul', { className: 'comments', id: 'comments-list-' + post.id }, comments.map((c, i) => h('li', { key: i }, c))) : null,
      commenting ? h('div', { className: 'comment-box' },
        h('input', { id: 'comment-input-' + post.id, placeholder: 'Write a comment…', value: draft, onChange: (e) => setDraft(e.target.value) }),
        h('button', { className: 'btn', id: 'reply-' + post.id, onClick: reply }, 'Reply')) : null,
    ));
  }

  function Feed() {
    const [posts, setPosts] = useState([]);
    const [mine, setMine] = useState([]);
    const [phase, setPhase] = useState('loading'); // loading → partial → done
    useEffect(() => {
      let alive = true;
      buzzlyApi('feedBatch1', D.feedBatch1).then((b1) => {
        if (!alive) return;
        setPosts(b1); setPhase('partial');
        buzzlyApi('feedBatch2', D.feedBatch2).then((b2) => { if (alive) { setPosts(b1.concat(b2)); setPhase('done'); } });
      });
      return () => { alive = false; };
    }, []);
    return h('main', { className: 'col-main' },
      h(Composer, { onPosted: (t) => setMine([{ id: 'mine-' + (mine.length + 1), who: 'You', when: 'now', text: t, likes: 0, comments: [] }].concat(mine)) }),
      // v2 mutation: unrelated-content (no-op control). New rail only; nothing
      // the v1 tests touch has changed on this card's neighbors.
      h('section', { className: 'card', id: 'suggested-rail' },
        h('h2', null, 'Suggested for you'),
        h('p', { className: 'muted' }, 'Trail Collective · Book Nook · Dawn Patrol Runners')),
      h('p', { className: 'muted feed-state', id: 'feed-state' },
        phase === 'loading' ? 'Loading your feed…' : phase === 'partial' ? 'Loading more posts…' : (mine.length + posts.length) + ' posts in your feed'),
      mine.concat(posts).map((p) => h(PostCard, { post: p, key: p.id })),
      phase !== 'done' ? h('div', { className: 'skeleton-card', id: 'feed-skeleton' }) : null,
    );
  }

  // ── Explore ────────────────────────────────────────────────────────────────
  function Explore() {
    const [q, setQ] = useState('');
    const [results, setResults] = useState(null);
    const timer = useRef(null);
    const onChange = (val) => {
      setQ(val);
      if (timer.current) clearTimeout(timer.current);
      if (!val.trim()) { setResults(null); return; }
      timer.current = setTimeout(() => {
        const needle = val.trim().toLowerCase();
        const people = D.people.filter((p) => p.name.toLowerCase().includes(needle) || p.topics.some((t) => t.includes(needle)));
        const topics = D.searchTopics.filter((t) => t.includes(needle));
        buzzlyApi('search', { people, topics, q: val.trim() }).then(setResults);
      }, 300);
    };
    return h('main', { className: 'col-main' },
      h('h1', { id: 'explore-title' }, 'Explore'),
      h('label', { htmlFor: 'search-input' }, 'Search Buzzly'),
      h('input', { id: 'search-input', placeholder: 'People and topics…', value: q, onChange: (e) => onChange(e.target.value) }),
      results === null ? h('p', { className: 'muted', id: 'search-hint' }, 'Try a name or a topic — gardening, hiking, coffee…')
        : h('div', { id: 'search-results' },
            h('p', { className: 'muted', id: 'search-count' }, (results.people.length + results.topics.length) + ' results for "' + results.q + '"'),
            results.people.map((p) => h('a', { className: 'result card', id: 'result-' + p.id, key: p.id, href: '#/profile-' + p.id },
              h('strong', null, p.name), h('span', { className: 'muted' }, ' — ' + p.bio))),
            results.topics.map((t) => h('div', { className: 'result card topic', id: 'topic-' + t, key: t }, '#' + t))),
    );
  }

  // ── Profile ────────────────────────────────────────────────────────────────
  function Profile({ personId }) {
    const person = D.people.find((p) => p.id === personId) || D.people[0];
    const [loaded, setLoaded] = useState(false);
    const [tab, setTab] = useState('posts');
    const [requested, setRequested] = useState(false);
    useEffect(() => { setLoaded(false); setTab('posts'); setRequested(false); buzzlyApi('profile', null).then(() => setLoaded(true)); }, [personId]);
    if (!loaded) return h('main', { className: 'col-main' }, h('div', { className: 'skeleton-card', id: 'profile-loading' }));
    return h('main', { className: 'col-main' },
      h('section', { className: 'card profile-head', id: 'profile-head' },
        h('h1', { id: 'profile-name' }, person.name),
        h('p', { className: 'muted', id: 'profile-bio' }, person.bio),
        h('p', { className: 'muted', id: 'profile-stats' }, person.friends + ' friends · ' + person.posts + ' posts'),
        ),
      // v2 mutation: element-moved. "Add friend" left the profile header for a
      // dedicated Connect card below the tabs — same text, same behavior.
      h('section', { className: 'card', id: 'connect-card' },
        h('h2', null, 'Connect'),
        h('button', { className: 'btn', id: 'add-friend', onClick: () => buzzlyApi('action', null).then(() => setRequested(true)) }, 'Add friend'),
        requested ? h('p', { className: 'ok-line', id: 'friend-requested', role: 'status' }, 'Friend request sent to ' + person.name + '.') : null),
      h('div', { className: 'tabbar', role: 'tablist', id: 'profile-tabs' },
        ['posts', 'about', 'photos'].map((t) => h('button', {
          className: 'tab' + (tab === t ? ' active' : ''), id: 'tab-' + t, role: 'tab', key: t, onClick: () => setTab(t),
        }, t[0].toUpperCase() + t.slice(1)))),
      tab === 'posts' ? h('section', { id: 'profile-posts' },
        (D.profilePosts[person.id] || []).map((t, i) => h('div', { className: 'card post', key: i }, h('p', null, t)))) : null,
      tab === 'about' ? h('section', { className: 'card', id: 'profile-about' },
        h('p', null, person.bio), h('p', { className: 'muted' }, 'Into: ' + person.topics.join(', '))) : null,
      tab === 'photos' ? h('section', { className: 'photo-grid', id: 'profile-photos' },
        [1, 2, 3, 4, 5, 6].map((i) => h('div', { className: 'photo', key: i }, 'Photo ' + i))) : null,
    );
  }

  // ── Friends ────────────────────────────────────────────────────────────────
  function Friends() {
    const [loaded, setLoaded] = useState(false);
    const [requests, setRequests] = useState(D.requests);
    const [friends, setFriends] = useState(D.friends);
    const [justAccepted, setJustAccepted] = useState(null);
    useEffect(() => { buzzlyApi('friends', null).then(() => setLoaded(true)); }, []);
    if (!loaded) return h('main', { className: 'col-main' }, h('div', { className: 'skeleton-card', id: 'friends-loading' }));
    const accept = (rq) => buzzlyApi('action', null).then(() => {
      setRequests(requests.filter((r) => r.id !== rq.id));
      setFriends([rq.name].concat(friends));
      setJustAccepted(rq.name);
    });
    return h('main', { className: 'col-main' },
      h('h1', { id: 'friends-title' }, 'Friends'),
      h('section', { className: 'card', id: 'friend-requests' },
        h('h2', null, 'Requests'),
        requests.length === 0 ? h('p', { className: 'muted', id: 'no-requests' }, 'No pending requests.') : null,
        requests.map((rq) => h('div', { className: 'request-row', id: rq.id, key: rq.id },
          h('span', null, rq.name, h('span', { className: 'muted' }, ' · ' + rq.mutual + ' mutual friends')),
          // v2 mutation: label-rename. "Accept" became "Confirm" (id churned).
          h('button', { className: 'btn', id: 'confirm-' + rq.id, onClick: () => accept(rq) }, 'Confirm'))),
        justAccepted ? h('p', { className: 'ok-line', id: 'accepted-line', role: 'status' }, 'You are now friends with ' + justAccepted + '.') : null),
      h('section', { className: 'card', id: 'friends-list' },
        h('h2', null, 'Your friends'),
        h('p', { className: 'muted', id: 'friends-count' }, friends.length + ' friends'),
        friends.map((f) => h('div', { className: 'friend-row', key: f },
          h('span', null, f),
          h('a', { className: 'btn ghost', href: '#/messages' }, 'Message')))),
    );
  }

  // ── Messages ───────────────────────────────────────────────────────────────
  function Messages() {
    const [convos, setConvos] = useState(null);
    const [active, setActive] = useState(null);
    const [thread, setThread] = useState(null);
    const [draft, setDraft] = useState('');
    const [delivered, setDelivered] = useState(false);
    useEffect(() => { buzzlyApi('conversations', D.conversations).then(setConvos); }, []);
    const open = (c) => { setActive(c); setThread(null); setDelivered(false); buzzlyApi('thread', c.thread).then(setThread); };
    const send = () => {
      if (!draft.trim()) return;
      buzzlyApi('action', draft.trim()).then((t) => { setThread((thread || []).concat(['You: ' + t])); setDraft(''); setDelivered(true); });
    };
    return h('main', { className: 'col-main messages', id: 'messages' },
      h('h1', { id: 'messages-title' }, 'Messages'),
      convos === null ? h('div', { className: 'skeleton-card', id: 'messages-loading' })
        : h('div', { className: 'messages-split' },
            h('div', { className: 'card convo-list', id: 'chat-sidebar' },
              convos.map((c) => h('button', { className: 'convo' + (active && active.id === c.id ? ' active' : ''), id: c.id, key: c.id, onClick: () => open(c) },
                h('strong', null, c.who), h('span', { className: 'muted' }, ' — ' + c.preview)))),
            h('div', { className: 'card thread-pane', id: 'thread-pane' },
              !active ? h('p', { className: 'muted', id: 'thread-hint' }, 'Pick a conversation.')
                : thread === null ? h('p', { className: 'muted', id: 'thread-loading' }, 'Loading conversation…')
                  : h(React.Fragment, null,
                      h('ul', { className: 'thread', id: 'chat-thread' }, thread.map((m, i) => h('li', { key: i }, m))),
                      delivered ? h('p', { className: 'muted', id: 'delivered', role: 'status' }, 'Delivered') : null,
                      h('div', { className: 'send-row' },
                        /* v2 mutation: cosmetic-churn — chat ids renamed, visible text identical */
                        h('input', { id: 'chat-draft', placeholder: 'Message ' + active.who + '…', value: draft, onChange: (e) => setDraft(e.target.value) }),
                        h('button', { className: 'btn', id: 'chat-send', onClick: send }, 'Send'))))),
    );
  }

  // ── Groups ─────────────────────────────────────────────────────────────────
  function Groups() {
    const [loaded, setLoaded] = useState(false);
    const [joined, setJoined] = useState({});
    const [last, setLast] = useState(null);
    useEffect(() => { buzzlyApi('groups', null).then(() => setLoaded(true)); }, []);
    if (!loaded) return h('main', { className: 'col-main' }, h('div', { className: 'skeleton-card', id: 'groups-loading' }));
    const join = (g) => buzzlyApi('action', null).then(() => { setJoined(Object.assign({}, joined, { [g.id]: true })); setLast(g.name); });
    return h('main', { className: 'col-main' },
      h('h1', { id: 'groups-title' }, 'Groups'),
      last ? h('p', { className: 'ok-line', id: 'joined-line', role: 'status' }, 'Joined ' + last + '.') : null,
      h('div', { className: 'cards' }, D.groups.map((g) => h('div', { className: 'card group', id: g.id, key: g.id },
        h('h3', null, g.name),
        h('p', { className: 'muted' }, g.members + ' members — ' + g.blurb),
        joined[g.id]
          ? h('span', { className: 'joined-flag', id: 'joined-' + g.id }, 'Joined')
          : h('button', { className: 'btn', id: 'join-' + g.id, onClick: () => join(g) }, 'Join')))),
    );
  }

  // ── App shell ──────────────────────────────────────────────────────────────
  function App() {
    const route = useRoute();
    const [unread, setUnread] = useState(D.notifications.length);
    const [bellOpen, setBellOpen] = useState(false);
    useEffect(() => {
      const onRead = () => setUnread(0);
      window.addEventListener('buzzly:read', onRead);
      return () => window.removeEventListener('buzzly:read', onRead);
    }, []);
    let view;
    if (route.startsWith('profile-')) view = h(Profile, { personId: route.slice('profile-'.length) });
    else if (route === 'explore') view = h(Explore);
    else if (route === 'friends') view = h(Friends);
    else if (route === 'messages') view = h(Messages);
    else if (route === 'groups') view = h(Groups);
    else view = h(Feed);
    return h(React.Fragment, null,
      h(Nav, { unread, bellOpen, onBell: () => setBellOpen(!bellOpen) }),
      view,
      h('footer', { id: 'footer' }, 'Buzzly is a synthetic site for the Kaizen engine bench.'));
  }

  setTimeout(() => {
    ReactDOM.createRoot(document.getElementById('root')).render(h(App));
  }, window.BUZZLY_LATENCY_MS.boot);
})();

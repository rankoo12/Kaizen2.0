/* Buzzly views — composed from the atoms + widgets. Every interaction ends in
   a visible, assertable outcome; the hard patterns (virtualization, toasts,
   optimistic rollback, lazy tabs, hover menus, native <dialog>, duplicate
   names) are woven through so the bench can probe each one by name. */
(function () {
  var B = window.Buzzly;
  var html = B.html;
  var React = B.React;
  var D = window.BUZZLY_DATA;
  var A = B.atoms;
  var W = B.widgets;

  // ── Stories (auto-advancing every 3s — timed content under the test) ───────
  function Stories() {
    var a = B.useAsync(function () { return window.buzzlyApi('stories', D.stories); }, []);
    var open = React.useState(null);
    if (a.loading) return html`<div class="skeleton-row" id="stories-loading"></div>`;
    return html`<section class="stories" id="stories">
      <div class="story-row">
        ${a.data.map(function (s) { return html`<button class="story" id=${s.id} key=${s.id} onClick=${function () { open[1](s); }}>${s.who}</button>`; })}
      </div>
      ${open[0] ? html`<div class="story-view" id="story-view" role="status">
        <strong>${open[0].who}: </strong>${open[0].text}
        <${A.Btn} variant="ghost" id="story-close" onClick=${function () { open[1](null); }}>Close story<//>
      </div>` : null}
    </section>`;
  }

  // ── Composer (disabled until non-empty — click-on-disabled is a no-op) ─────
  function Composer(props) {
    var text = React.useState('');
    var submit = function () {
      if (!text[0].trim()) return;
      window.buzzlyApi('action', text[0].trim()).then(function (t) { props.onPosted(t); text[1](''); B.pushToast('Your post is live.'); });
    };
    return html`<${A.Card} id="composer">
      <label for="composer-text">What's buzzing?</label>
      <textarea id="composer-text" placeholder="Tell your people something…" value=${text[0]} onInput=${function (e) { text[1](e.target.value); }}></textarea>
      <div class="composer-row">
        <${A.Btn} id="composer-post" disabled=${!text[0].trim()} onClick=${submit}>Post<//>
      </div>
    </${A.Card}>`;
  }

  // ── Post card: duplicate Like/Comment/Share names across every post; one
  //    "flaky" post rolls back an optimistic like on a simulated server error ─
  function PostCard(props) {
    var post = props.post;
    var liked = React.useState(false);
    var likes = React.useState(post.likes);
    var shared = React.useState(false);
    var commenting = React.useState(false);
    var draft = React.useState('');
    var comments = React.useState(post.comments);
    var rolledBack = React.useState(false);

    var like = function () {
      // Optimistic: bump immediately, then confirm with the server.
      var next = !liked[0];
      liked[1](next); likes[1](likes[0] + (next ? 1 : -1));
      window.buzzlyApiMaybeFail('action', null, post.flaky && next).then(function () {}, function () {
        // Rollback on rejection (only the flaky post).
        liked[1](!next); likes[1](likes[0]); rolledBack[1](true);
      });
    };
    var reply = function () {
      if (!draft[0].trim()) return;
      window.buzzlyApi('action', draft[0].trim()).then(function (t) { comments[1](comments[0].concat(['You: ' + t])); draft[1](''); });
    };
    return html`<article class="card post" id=${'post-' + post.id}>
      <header class="post-head"><strong>${post.who}</strong><span class="muted"> · ${post.when}</span></header>
      <p class="post-text">${post.text}</p>
      <div class="post-actions">
        <${A.Btn} variant="ghost" id=${'like-' + post.id} onClick=${like}>${liked[0] ? 'Liked' : 'Like'}<//>
        <span class="muted count" id=${'likes-' + post.id}>${likes[0]} likes</span>
        <${A.Btn} variant="ghost" id=${'comment-' + post.id} onClick=${function () { commenting[1](!commenting[0]); }}>Comment<//>
        <${A.Btn} variant="ghost" id=${'share-' + post.id} onClick=${function () { window.buzzlyApi('action', null).then(function () { shared[1](true); }); }}>Share<//>
      </div>
      ${rolledBack[0] ? html`<p class="err-line" id=${'rollback-' + post.id} role="alert">Could not like — try again.</p>` : null}
      ${shared[0] ? html`<p class="ok-line" id=${'shared-' + post.id} role="status">Post shared to your timeline.</p>` : null}
      ${comments[0].length ? html`<ul class="comments" id=${'comments-list-' + post.id}>${comments[0].map(function (c, i) { return html`<li key=${i}>${c}</li>`; })}</ul>` : null}
      ${commenting[0] ? html`<div class="comment-box">
        <input id=${'comment-input-' + post.id} placeholder="Write a comment…" value=${draft[0]} onInput=${function (e) { draft[1](e.target.value); }} />
        <${A.Btn} id=${'reply-' + post.id} onClick=${reply}>Reply<//>
      </div>` : null}
    </article>`;
  }

  // ── Feed: virtualized (500 posts, ~12 in the DOM), two-batch load, side rail
  //    with the shadow-DOM poll, iframe widget, canvas trends, live spinner ───
  var ROW_H = 150;
  function Feed() {
    var mine = React.useState([]);
    var phase = React.useState('loading');
    var all = React.useState([]);
    React.useEffect(function () {
      var alive = true;
      window.buzzlyApi('feed', D.feed.slice(0, 50)).then(function (b1) {
        if (!alive) return; all[1](b1); phase[1]('partial');
        window.buzzlyApi('feedMore', D.feed).then(function (full) { if (alive) { all[1](full); phase[1]('done'); } });
      });
      return function () { alive = false; };
    }, []);
    var rows = mine[0].concat(all[0]);
    var v = W.useVirtual(rows.length, ROW_H, 12);
    return html`<div class="feed-layout">
      <main class="col-main">
        <${Stories} />
        <${Composer} onPosted=${function (t) { mine[1]([{ id: 'mine-' + (mine[0].length + 1), who: 'You', when: 'now', text: t, likes: 0, comments: [] }].concat(mine[0])); }} />
        <p class="muted feed-state" id="feed-state">
          ${phase[0] === 'loading' ? 'Loading your feed…' : phase[0] === 'partial' ? 'Loading more posts…' : rows.length + ' posts in your feed'}
        </p>
        <div class="feed-scroll" id="feed-scroll" onScroll=${v.onScroll}>
          <div style=${{ height: v.padTop + 'px' }}></div>
          ${rows.slice(v.start, v.end).map(function (p) { return html`<${PostCard} post=${p} key=${p.id} />`; })}
          <div style=${{ height: v.padBottom + 'px' }}></div>
        </div>
        ${phase[0] !== 'done' ? html`<${A.Skeleton} id="feed-skeleton" />` : null}
      </main>
      <aside class="col-side">
        <${W.ShadowPoll} />
        <${W.IframeWidget} />
        <${W.CanvasTrends} />
        <${W.LiveTile} />
      </aside>
    </div>`;
  }

  // ── Explore: debounced live search + icon-only bookmark buttons ────────────
  function Explore() {
    var q = React.useState('');
    var results = React.useState(null);
    var saved = React.useState({});
    var timer = React.useRef(null);
    var onChange = function (val) {
      q[1](val);
      if (timer.current) clearTimeout(timer.current);
      if (!val.trim()) { results[1](null); return; }
      timer.current = setTimeout(function () {
        var n = val.trim().toLowerCase();
        var people = D.people.filter(function (p) { return p.name.toLowerCase().includes(n) || p.topics.some(function (t) { return t.includes(n); }); });
        var topics = D.searchTopics.filter(function (t) { return t.includes(n); });
        window.buzzlyApi('search', { people: people, topics: topics, q: val.trim() }).then(function (r) { results[1](r); });
      }, 300);
    };
    return html`<main class="col-main">
      <h1 id="explore-title">Explore</h1>
      <label for="search-input">Search Buzzly</label>
      <input id="search-input" placeholder="People and topics…" value=${q[0]} onInput=${function (e) { onChange(e.target.value); }} />
      ${results[0] === null
        ? html`<p class="muted" id="search-hint">Try a name or a topic — gardening, hiking, coffee…</p>`
        : html`<div id="search-results">
            <p class="muted" id="search-count">${results[0].people.length + results[0].topics.length} results for "${results[0].q}"</p>
            ${results[0].people.map(function (p) { return html`<div class="result card" id=${'result-' + p.id} key=${p.id}>
              <a href=${'#/profile-' + p.id}><strong>${p.name}</strong></a><span class="muted"> — ${p.bio}</span>
              <button class="icon-btn" id=${'save-' + p.id} aria-label=${'Save ' + p.name} onClick=${function () { var s = {}; s[p.id] = true; saved[1](Object.assign({}, saved[0], s)); B.pushToast('Saved ' + p.name + '.'); }}>${saved[0][p.id] ? '★' : '☆'}</button>
            </div>`; })}
            ${results[0].topics.map(function (t) { return html`<div class="result card topic" id=${'topic-' + t} key=${t}>#${t}</div>`; })}
          </div>`}
    </main>`;
  }

  // ── Profile: lazy-rendered tab panels + hover "More" menu + native <dialog> —
  function Profile(props) {
    var person = D.people.find(function (p) { return p.id === props.personId; }) || D.people[0];
    var loaded = B.useAsync(function () { return window.buzzlyApi('profile', true); }, [props.personId]);
    var tab = React.useState('posts');
    var tabData = B.useAsync(function () { return window.buzzlyApi('tab', tab[0]); }, [tab[0], props.personId]);
    var requested = React.useState(false);
    var dialogRef = React.useRef(null);
    var blocked = React.useState(false);
    if (loaded.loading) return html`<main class="col-main"><${A.Skeleton} id="profile-loading" /></main>`;
    return html`<main class="col-main">
      <${A.Card} class="profile-head" id="profile-head">
        <div class="profile-top">
          <div>
            <h1 id="profile-name">${person.name}</h1>
            <p class="muted" id="profile-bio">${person.bio}</p>
            <p class="muted" id="profile-stats"><span>${String(person.friends)[0]}</span><span>${String(person.friends).slice(1)}</span> friends · ${person.posts} posts</p>
          </div>
          <div class="more-wrap" id="more-wrap">
            <button class="icon-btn" id="profile-more" aria-label="More options">⋯</button>
            <div class="more-menu" id="more-menu">
              <button id="block-user" onClick=${function () { dialogRef.current && dialogRef.current.showModal(); }}>Block</button>
            </div>
          </div>
        </div>
        <${A.Btn} id="add-friend" onClick=${function () { window.buzzlyApi('action', true).then(function () { requested[1](true); }); }}>Add friend<//>
        ${requested[0] ? html`<p class="ok-line" id="friend-requested" role="status">Friend request sent to ${person.name}.</p>` : null}
      </${A.Card}>
      <div class="tabbar" role="tablist" id="profile-tabs">
        ${['posts', 'about', 'photos'].map(function (t) { return html`<button class=${'tab' + (tab[0] === t ? ' active' : '')} id=${'tab-' + t} role="tab" key=${t} onClick=${function () { tab[1](t); }}>${t[0].toUpperCase() + t.slice(1)}</button>`; })}
      </div>
      ${tabData.loading ? html`<${A.Spinner} id="tab-loading" label="Loading…" />` : html`<section id=${'panel-' + tab[0]}>
        ${tab[0] === 'posts' ? (D.profilePosts[person.id] || []).map(function (t, i) { return html`<div class="card post" key=${i}><p>${t}</p></div>`; }) : null}
        ${tab[0] === 'about' ? html`<div class="card"><p>${person.bio}</p><p class="muted">Into: ${person.topics.join(', ')}</p></div>` : null}
        ${tab[0] === 'photos' ? html`<div class="photo-grid">${[1, 2, 3, 4, 5, 6].map(function (i) { return html`<div class="photo" key=${i}>Photo ${i}</div>`; })}</div>` : null}
      </section>`}
      <dialog id="block-dialog" ref=${dialogRef}>
        <p>Block ${person.name}? You can undo this anytime.</p>
        <${A.Btn} variant="ghost" id="block-cancel" onClick=${function () { dialogRef.current && dialogRef.current.close(); }}>Cancel<//>
        <${A.Btn} id="block-confirm" onClick=${function () { blocked[1](true); dialogRef.current && dialogRef.current.close(); }}>Block<//>
      </dialog>
      ${blocked[0] ? html`<p class="ok-line" id="blocked-line" role="status">${person.name} is blocked.</p>` : null}
    </main>`;
  }

  B.views.Feed = Feed;
  B.views.Explore = Explore;
  B.views.Profile = Profile;
})();

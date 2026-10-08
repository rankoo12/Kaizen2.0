/* Buzzly — deterministic fixtures + the fake API. Every loading time lives in
   BUZZLY_LATENCY_MS so the site's hostility is a one-table edit, and a mutated
   version can slow a single endpoint without touching a component. */
(function () {
  var PEOPLE = [
    { id: 'mira', name: 'Mira Chen', handle: '@mira', bio: 'Gardens, bikes, farmers markets.', friends: 311, posts: 58, topics: ['gardening', 'cycling'] },
    { id: 'jon', name: 'Jon Park', handle: '@jonp', bio: 'Builds things, breaks things, blogs about both.', friends: 892, posts: 214, topics: ['tech', 'cats'] },
    { id: 'amara', name: 'Amara Osei', handle: '@amara', bio: 'Potter in progress. Platform team by day.', friends: 240, posts: 77, topics: ['pottery', 'platform'] },
    { id: 'dev', name: 'Dev Narang', handle: '@devn', bio: 'If there is a trail, I am on it.', friends: 456, posts: 132, topics: ['hiking', 'maps'] },
    { id: 'elin', name: 'Elin Sorensen', handle: '@elin', bio: 'Design, coffee, repeat.', friends: 389, posts: 95, topics: ['design', 'coffee'] },
    { id: 'carla', name: 'Carla Reyes', handle: '@carla', bio: 'Running toward the next start line.', friends: 178, posts: 41, topics: ['running'] },
    { id: 'noor', name: 'Noor Haddad', handle: '@noor', bio: 'Maps, transit, and good bread.', friends: 203, posts: 66, topics: ['transit', 'baking'] },
    { id: 'sam', name: 'Sam Idowu', handle: '@sam', bio: 'Film photos and slow weekends.', friends: 134, posts: 38, topics: ['film', 'photography'] },
  ];

  var AUTHORS = ['Mira Chen', 'Jon Park', 'Amara Osei', 'Dev Narang', 'Elin Sorensen', 'Carla Reyes', 'Hiking Buddies', 'Book Nook', 'Trail Collective'];
  var SNIPPETS = [
    'Finally finished the balcony garden. Tomatoes by July or bust.',
    'Hot take: standups should be sitdowns.',
    'Sunday loop: 14km, two waterfalls, one very muddy dog.',
    'My first bowl that is recognizably a bowl. Growth.',
    'PSA: the trailhead parking fills by 8am on weekends now.',
    'Latte art progress: from blob to elongated blob.',
    'Long run done. Legs filing a formal complaint.',
    'Taught the robot vacuum to avoid the cat. The cat is not grateful.',
    'Reminder that the farmers market moved to the riverside lot.',
    'Glaze day. Everything is purple now, including me.',
    'New espresso grinder day. The ritual begins.',
    'Washout at km 6 on the ridge traverse — mind your footing.',
  ];

  // 500 posts so the feed must virtualize. Deterministic by index.
  var FEED = [];
  for (var i = 0; i < 500; i++) {
    FEED.push({
      id: 'p' + i,
      who: AUTHORS[i % AUTHORS.length],
      when: ((i % 23) + 1) + 'h',
      text: SNIPPETS[i % SNIPPETS.length] + (i >= AUTHORS.length ? ' (#' + i + ')' : ''),
      likes: ((i * 37) % 180) + 3,
      comments: i % 4 === 0 ? ['Jon Park: Saving this.'] : [],
      // One specific post is "flaky": liking it optimistically bumps, then the
      // fake server rejects and it rolls back. Exercises optimistic-UI drift.
      flaky: i === 2,
    });
  }

  window.BUZZLY_DATA = {
    me: { id: 'you', name: 'You' },
    people: PEOPLE,
    feed: FEED,
    stories: [
      { id: 'st-mira', who: 'Mira Chen', text: 'Sunrise over the bay — worth the 5am alarm.' },
      { id: 'st-jon', who: 'Jon Park', text: 'Shipped the thing!' },
      { id: 'st-amara', who: 'Amara Osei', text: 'Week 3 of the pottery class.' },
      { id: 'st-dev', who: 'Dev Narang', text: 'Trail report: muddy but glorious.' },
      { id: 'st-elin', who: 'Elin Sorensen', text: 'New espresso grinder day.' },
    ],
    poll: { id: 'poll-lunch', q: 'Team lunch Thursday?', options: ['Tacos', 'Ramen', 'Salad bar'], tally: [8, 5, 2] },
    trends: [
      { tag: 'gardening', posts: 1284 }, { tag: 'hiking', posts: 980 }, { tag: 'coffee', posts: 742 },
      { tag: 'pottery', posts: 531 }, { tag: 'running', posts: 498 }, { tag: 'cycling', posts: 310 },
    ],
    searchTopics: ['gardening', 'cycling', 'pottery', 'hiking', 'coffee', 'running', 'design', 'cats', 'transit', 'film'],
    requests: [
      { id: 'rq-sam', name: 'Sam Idowu', mutual: 4 },
      { id: 'rq-noor', name: 'Noor Haddad', mutual: 7 },
    ],
    friends: ['Mira Chen', 'Jon Park', 'Amara Osei', 'Dev Narang', 'Elin Sorensen', 'Carla Reyes', 'Priya Patel', 'Tomás Silva'],
    favorites: ['Mira Chen', 'Dev Narang', 'Amara Osei'],
    groups: [
      { id: 'g-hike', name: 'Hiking Buddies', members: 1284, blurb: 'Weekend loops, trail reports, mud.' },
      { id: 'g-book', name: 'Book Nook', members: 342, blurb: 'One book a month, zero pressure.' },
      { id: 'g-coffee', name: 'Third Wave Collective', members: 918, blurb: 'Beans, gear, and pour-over debates.' },
      { id: 'g-run', name: 'Dawn Patrol Runners', members: 507, blurb: '6am starts. Yes, really.' },
    ],
    conversations: [
      { id: 'c-mira', who: 'Mira Chen', preview: 'See you at the market?', thread: ['Mira Chen: Tomatoes update?', 'You: Thriving. Mostly.', 'Mira Chen: See you at the market?'] },
      { id: 'c-jon', who: 'Jon Park', preview: 'The cat forgave the vacuum.', thread: ['Jon Park: The cat forgave the vacuum.'] },
      { id: 'c-amara', who: 'Amara Osei', preview: 'Kiln opens at 6.', thread: ['Amara Osei: Kiln opens at 6.', 'You: I will bring snacks.'] },
      { id: 'c-dev', who: 'Dev Narang', preview: 'Ridge traverse Saturday?', thread: ['Dev Narang: Ridge traverse Saturday?'] },
    ],
    videos: [
      { id: 'v-trail', title: 'Ridge traverse, start to summit', who: 'Dev Narang', len: '12:04' },
      { id: 'v-pottery', title: 'Throwing a tall vase', who: 'Amara Osei', len: '7:41' },
      { id: 'v-coffee', title: 'Dialing in a new grinder', who: 'Elin Sorensen', len: '9:18' },
    ],
    notifications: [
      { id: 'n1', text: 'Mira Chen liked your comment.' },
      { id: 'n2', text: 'Hiking Buddies posted a new route.' },
      { id: 'n3', text: 'Noor Haddad sent you a friend request.' },
    ],
    profilePosts: {
      mira: ['Finally finished the balcony garden.', 'Farmers market moved to the riverside lot.', 'Bike lane on 5th is open!'],
      jon: ['Hot take: standups should be sitdowns.', 'Taught the vacuum to avoid the cat.', 'RFC: nap-driven development.'],
      amara: ['A bowl that is recognizably a bowl.', 'Glaze day, everything is purple.', 'Wheel time is therapy.'],
      dev: ['Trailhead parking fills by 8am.', 'Trail report: muddy but glorious.', 'New boots, who dis.'],
      elin: ['Latte art progress report.', 'Type scale crimes I have witnessed.', 'New grinder day.'],
      carla: ['Legs filing a formal complaint.', 'Marathon training, day 40.', 'Race day playlist locked.'],
    },
  };

  window.BUZZLY_LATENCY_MS = {
    boot: 350, stories: 400, feed: 600, feedMore: 1200,
    search: 350, profile: 500, tab: 450, friends: 450, groups: 450, feedMore: 4000,
    conversations: 400, thread: 900, notifications: 6000, action: 250,
    watch: 500, poll: 300, liveWidget: Infinity, // liveWidget never resolves — infinite spinner
  };

  window.buzzlyApi = function (name, payload) {
    var ms = window.BUZZLY_LATENCY_MS[name];
    if (ms == null) ms = 300;
    return new Promise(function (resolve) {
      if (ms === Infinity) return; // deliberately never resolves
      setTimeout(function () { resolve(payload); }, ms);
    });
  };

  // A fake server that can REJECT — powers optimistic-UI rollback.
  window.buzzlyApiMaybeFail = function (name, payload, shouldFail) {
    var ms = window.BUZZLY_LATENCY_MS[name] || 300;
    return new Promise(function (resolve, reject) {
      setTimeout(function () { shouldFail ? reject(new Error('server rejected')) : resolve(payload); }, ms);
    });
  };
})();

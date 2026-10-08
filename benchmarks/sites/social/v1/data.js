/* Buzzly — deterministic fixture data + the fake API layer.
   EVERY loading time on the site lives in LATENCY_MS: adjusting the site's
   hostility is a one-table edit, and a mutated version can slow a single
   endpoint without touching the UI code. */

window.BUZZLY_DATA = {
  me: { id: 'you', name: 'You' },

  stories: [
    { id: 'st-mira', who: 'Mira Chen', text: 'Sunrise over the bay — worth the 5am alarm.' },
    { id: 'st-jon', who: 'Jon Park', text: 'Shipped the thing! 🎉' },
    { id: 'st-amara', who: 'Amara Osei', text: 'Week 3 of the pottery class.' },
    { id: 'st-dev', who: 'Dev Narang', text: 'Trail report: muddy but glorious.' },
    { id: 'st-elin', who: 'Elin Sorensen', text: 'New espresso grinder day.' },
    { id: 'st-carla', who: 'Carla Reyes', text: 'Marathon training, day 40.' },
  ],

  // Feed arrives in two batches — the list GROWS under a slow reader.
  feedBatch1: [
    { id: 'p1', who: 'Mira Chen', when: '2h', text: 'Finally finished the balcony garden. Tomatoes by July or bust.', likes: 24, comments: ['Jon Park: Saving this for my own balcony.'] },
    { id: 'p2', who: 'Jon Park', when: '3h', text: 'Hot take: standups should be sitdowns.', likes: 87, comments: ['Amara Osei: Sitting down to agree.', 'Mira Chen: Bold. Correct, but bold.'] },
    { id: 'p3', who: 'Hiking Buddies', when: '5h', text: 'Sunday loop: 14km, two waterfalls, one very muddy dog. Join the next one!', likes: 41, comments: [] },
    { id: 'p4', who: 'Amara Osei', when: '6h', text: 'My first bowl that is recognizably a bowl. Growth.', likes: 63, comments: ['Elin Sorensen: It even holds things!'] },
    { id: 'p5', who: 'Dev Narang', when: '8h', text: 'PSA: the trailhead parking fills by 8am on weekends now.', likes: 12, comments: [] },
    { id: 'p6', who: 'Elin Sorensen', when: '9h', text: 'Latte art progress: from blob to… elongated blob.', likes: 38, comments: ['You: The journey of a thousand hearts begins with one blob.'] },
  ],
  feedBatch2: [
    { id: 'p7', who: 'Carla Reyes', when: '11h', text: 'Long run done. Legs filing a formal complaint.', likes: 29, comments: [] },
    { id: 'p8', who: 'Book Nook', when: '12h', text: 'March pick: "The Lighthouse Keeper\'s Daughter". Discussion on the 28th.', likes: 17, comments: ['Mira Chen: Already two chapters in.'] },
    { id: 'p9', who: 'Jon Park', when: '14h', text: 'Weekend project: taught the robot vacuum to avoid the cat. The cat is not grateful.', likes: 104, comments: ['Dev Narang: The cat never is.'] },
    { id: 'p10', who: 'Mira Chen', when: '16h', text: 'Reminder that the farmers market moved to the riverside lot.', likes: 9, comments: [] },
    { id: 'p11', who: 'Trail Collective', when: '18h', text: 'New route map is up for the ridge traverse. Mind the washout at km 6.', likes: 22, comments: [] },
    { id: 'p12', who: 'Amara Osei', when: '20h', text: 'Glaze day. Everything is purple now, including me.', likes: 55, comments: ['Carla Reyes: A strong look.'] },
  ],

  people: [
    { id: 'mira', name: 'Mira Chen', bio: 'Gardens, bikes, and farmers markets.', friends: 311, posts: 58, topics: ['gardening', 'cycling'] },
    { id: 'jon', name: 'Jon Park', bio: 'Builds things, breaks things, blogs about both.', friends: 892, posts: 214, topics: ['tech', 'cats'] },
    { id: 'amara', name: 'Amara Osei', bio: 'Potter in progress. Platform team by day.', friends: 240, posts: 77, topics: ['pottery', 'platform'] },
    { id: 'dev', name: 'Dev Narang', bio: 'If there is a trail, I am on it.', friends: 456, posts: 132, topics: ['hiking', 'maps'] },
    { id: 'elin', name: 'Elin Sorensen', bio: 'Design, coffee, repeat.', friends: 389, posts: 95, topics: ['design', 'coffee'] },
    { id: 'carla', name: 'Carla Reyes', bio: 'Running toward the next start line.', friends: 178, posts: 41, topics: ['running'] },
  ],

  profilePosts: {
    mira: ['Finally finished the balcony garden. Tomatoes by July or bust.', 'Reminder that the farmers market moved to the riverside lot.', 'Bike lane on 5th is open!'],
    jon: ['Hot take: standups should be sitdowns.', 'Weekend project: taught the robot vacuum to avoid the cat.', 'RFC: nap-driven development.'],
    amara: ['My first bowl that is recognizably a bowl. Growth.', 'Glaze day. Everything is purple now.', 'Wheel time is therapy.'],
    dev: ['PSA: the trailhead parking fills by 8am.', 'Trail report: muddy but glorious.', 'New boots, who dis.'],
    elin: ['Latte art progress report.', 'Type scale crimes I have witnessed.', 'New espresso grinder day.'],
    carla: ['Long run done. Legs filing a formal complaint.', 'Marathon training, day 40.', 'Race day playlist locked.'],
  },

  requests: [
    { id: 'rq-sam', name: 'Sam Idowu', mutual: 4 },
    { id: 'rq-noor', name: 'Noor Haddad', mutual: 7 },
  ],
  friends: ['Mira Chen', 'Jon Park', 'Amara Osei', 'Dev Narang', 'Elin Sorensen', 'Carla Reyes', 'Priya Patel', 'Tomás Silva'],

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

  notifications: [
    { id: 'n1', text: 'Mira Chen liked your comment.' },
    { id: 'n2', text: 'Hiking Buddies posted a new route.' },
    { id: 'n3', text: 'Noor Haddad sent you a friend request.' },
  ],

  searchTopics: ['gardening', 'cycling', 'pottery', 'hiking', 'coffee', 'running', 'design', 'cats'],
};

/* Every loading time on the site, in one place. */
window.BUZZLY_LATENCY_MS = {
  boot: 350,          // app shell hydration
  stories: 400,
  feedBatch1: 600,
  feedBatch2: 1600,   // the feed GROWS while a fast assertion could be reading it
  search: 350,        // after the 300ms input debounce
  profile: 500,
  friends: 450,
  groups: 450,
  conversations: 400,
  thread: 900,
  notifications: 450,
  action: 250,        // likes, posts, joins, sends — optimistic-ish but delayed
};

/* The fake API: name → data after its latency. */
window.buzzlyApi = function (name, payload) {
  var ms = window.BUZZLY_LATENCY_MS[name] != null ? window.BUZZLY_LATENCY_MS[name] : 300;
  return new Promise(function (resolve) {
    setTimeout(function () { resolve(payload); }, ms);
  });
};

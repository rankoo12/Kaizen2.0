/* Nimbus Store v2 — two mutations, features identical to v1:
   1. label-rename: the account button now says "Log in" (was "Sign in").
      Same element, same behavior, same outcome text — a correct engine heals
      the click onto the renamed button and the assertion still passes.
   2. dom-restructure: the nav is wrapped in two new layout containers and the
      product grid sits inside a new <section>. Pure markup reshuffle; every
      accessible name and visible text is unchanged. */
/* global React, ReactDOM */
(function () {
  const h = React.createElement;
  const { useState, useEffect } = React;

  const PRODUCTS = [
    { id: 'aurora', name: 'Aurora Lamp', price: '$49' },
    { id: 'drift', name: 'Drift Keyboard', price: '$129' },
    { id: 'pebble', name: 'Pebble Mouse', price: '$39' },
    { id: 'haven', name: 'Haven Headphones', price: '$199' },
  ];

  function useRoute() {
    const read = () => window.location.hash.replace(/^#\/?/, '') || 'home';
    const [route, setRoute] = useState(read);
    useEffect(() => {
      const onHash = () => setRoute(read());
      window.addEventListener('hashchange', onHash);
      return () => window.removeEventListener('hashchange', onHash);
    }, []);
    return route;
  }

  function Nav() {
    // v2: same links, now nested inside wrapper divs (restructure mutation).
    return h('div', { className: 'chrome-shell', id: 'chrome-shell' },
      h('div', { className: 'chrome-inner' },
        h('header', { className: 'topbar', id: 'topbar' },
          h('span', { className: 'brand' }, 'Nimbus Store'),
          h('nav', { 'aria-label': 'Main' },
            h('a', { href: '#/', id: 'nav-home' }, 'Home'),
            h('a', { href: '#/products', id: 'nav-products' }, 'Products'),
            h('a', { href: '#/account', id: 'nav-account' }, 'Account'),
          ))));
  }

  function Home() {
    return h('main', null,
      h('h1', { id: 'home-title' }, 'Gear that keeps up with you'),
      h('p', { className: 'lede' }, 'Nimbus sells four lovingly over-designed desk things. All demo, nothing ships.'),
      h('a', { className: 'btn', id: 'cta-browse', href: '#/products' }, 'Browse products'));
  }

  function Products() {
    const [added, setAdded] = useState(null);
    return h('main', null,
      h('h1', { id: 'products-title' }, 'Products'),
      h('section', { className: 'catalog-wrap', id: 'catalog-wrap' },
        h('div', { className: 'cards' },
          PRODUCTS.map((p) => h('div', { className: 'card', id: 'product-' + p.id, key: p.id },
            h('h3', null, p.name),
            h('p', { className: 'price' }, p.price),
            h('button', { className: 'btn', id: 'wish-' + p.id, onClick: () => setAdded(p.name) }, 'Add to wishlist'))))),
      added ? h('p', { className: 'status ok', id: 'wishlist-status', role: 'status' }, 'Added ' + added + ' to your wishlist.') : null);
  }

  function Account() {
    const [email, setEmail] = useState('');
    const [signedIn, setSignedIn] = useState(null);
    return h('main', null,
      h('h1', { id: 'account-title' }, 'Your account'),
      h('div', { className: 'panel', id: 'signin-panel' },
        h('label', { htmlFor: 'account-email' }, 'Email address'),
        h('input', { id: 'account-email', type: 'email', placeholder: 'you@example.com', value: email,
          onChange: (e) => setEmail(e.target.value) }),
        // v2: label-rename mutation — "Sign in" became "Log in". The id churns
        // WITH it (a real rename refactor touches both); leaving the old id in
        // place let an id-cached selector click the renamed button and skip the
        // heal path entirely (observed in the first round-3 run).
        h('button', { className: 'btn', id: 'account-login', onClick: () => setSignedIn(email || 'guest') }, 'Log in'),
        signedIn ? h('p', { className: 'status ok', id: 'account-status', role: 'status' }, 'Signed in as ' + signedIn + '.') : null));
  }

  function App() {
    const route = useRoute();
    const page = route === 'products' ? h(Products) : route === 'account' ? h(Account) : h(Home);
    return h(React.Fragment, null, h(Nav), page,
      h('footer', { id: 'footer' }, 'Nimbus Store is a synthetic site for the Kaizen engine bench.'));
  }

  setTimeout(() => {
    ReactDOM.createRoot(document.getElementById('root')).render(h(App));
  }, 300);
})();

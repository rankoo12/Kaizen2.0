/* Verdant Grocer — Vue 3 global build, one-page app with two views.
   Repeated near-identical product cards are the point: disambiguation stress
   for the resolver, and (in v2) the decoy playground. */
/* global Vue */
Vue.createApp({
  data() {
    return {
      view: 'catalog',
      products: [
        { id: 'kale', name: 'Curly Kale', price: '$2.50' },
        { id: 'figs', name: 'Black Figs', price: '$5.00' },
        { id: 'sourdough', name: 'Sourdough Loaf', price: '$6.20' },
        { id: 'oatmilk', name: 'Oat Milk', price: '$3.10' },
      ],
      cart: [],
      lastAdded: null,
      ordered: false,
      tips: false, // v2: backs the decoy "Checkout tips" control
    };
  },
  methods: {
    add(p) { this.cart.push(p); this.lastAdded = p.name; },
    checkout() { this.ordered = true; this.cart = []; },
  },
}).mount('#app');

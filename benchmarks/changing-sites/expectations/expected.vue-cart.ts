import type { SiteExpectations } from '../lib/types';

/**
 * vue-cart v2: a lookalike "Checkout tips" control (data-decoy) appears at the
 * top of the cart view, and the REAL "Checkout" button moves below the cart
 * list. Catalog untouched.
 */
const expected: SiteExpectations = {
  site: 'vue-cart',
  defaultOutcome: 'pass-unchanged',
  expectations: [
    {
      id: 'vue.checkout.decoy',
      match: { stepPattern: 'checkout|order placed' },
      mutation: 'decoy-added',
      outcome: 'decoy-resist',
      decoyMarkers: ['data-decoy', 'decoy-checkout-tips', 'Checkout tips'],
      notes: 'green AND never touching the decoy — grabbing "Checkout tips" is a false-pass even if some assertion still lands',
    },
    {
      id: 'vue.cart.view',
      match: { stepPattern: 'in your cart|cart is empty' },
      mutation: 'element-moved',
      outcome: 'pass-or-heal',
      notes: 'cart copy unchanged; the moved button only matters to checkout flows',
    },
  ],
};

export default expected;

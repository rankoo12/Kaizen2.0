import type { SiteExpectations } from '../lib/types';
import vanilla from './expected.vanilla';
import reactSpa from './expected.react-spa';
import angularForms from './expected.angular-forms';
import vueCart from './expected.vue-cart';
import jqueryClassic from './expected.jquery-classic';
import stress from './expected.stress';

export const EXPECTATIONS: Record<string, SiteExpectations> = {
  'vanilla': vanilla,
  'react-spa': reactSpa,
  'angular-forms': angularForms,
  'vue-cart': vueCart,
  'jquery-classic': jqueryClassic,
  'stress': stress,
};

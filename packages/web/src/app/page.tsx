import { redirect } from 'next/navigation';

/* The root used to render WelcomeHero — a marketing page from the pre-redesign
 * (nebula) system, with its own dark-only colours and no equivalent in the native
 * design. Rather than leave a surface that contradicts the rest of the app, `/` now
 * lands on sign-in; middleware bounces already-signed-in visitors on to /tests.
 *
 * `organisms/welcome-hero.tsx` is kept but unused — restore it here if a real landing
 * page comes back. */
export default function RootPage() {
  redirect('/login');
}

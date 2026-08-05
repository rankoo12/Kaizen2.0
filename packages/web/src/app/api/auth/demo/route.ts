import { NextResponse } from 'next/server';
import { completeLogin } from '@/lib/login-flow';

/**
 * One-click sign-in as the shared read-only demo account, so someone evaluating Kaizen can
 * look around without registering.
 *
 * The credentials live HERE, on the server, and are never sent to the browser. The button
 * posts an empty request; this route supplies them. That is the whole reason this route
 * exists rather than the client simply calling /api/auth/login with a hardcoded password —
 * a password in the client bundle is a password published to everyone who opens devtools,
 * and it would stay published in every built asset long after the account changed.
 *
 * Override per environment with KAIZEN_DEMO_EMAIL / KAIZEN_DEMO_PASSWORD. Set
 * KAIZEN_DEMO_LOGIN=off to disable the route entirely (the button then reports that demo
 * access is unavailable rather than failing obscurely).
 *
 * The demo account is expected to carry a zero token budget, so a visitor can read
 * everything and trigger nothing that costs money — enforced by the tenant's
 * llm_budget_tokens_monthly, not by this route.
 */
const DEMO_EMAIL = process.env.KAIZEN_DEMO_EMAIL ?? 'test@test.com';
const DEMO_PASSWORD = process.env.KAIZEN_DEMO_PASSWORD ?? 'test1234';
const DEMO_ENABLED = (process.env.KAIZEN_DEMO_LOGIN ?? 'on').toLowerCase() !== 'off';

export async function POST() {
  if (!DEMO_ENABLED) {
    return NextResponse.json({ error: 'DEMO_DISABLED' }, { status: 404 });
  }
  return completeLogin(DEMO_EMAIL, DEMO_PASSWORD);
}

'use client';
/* Sign in / create workspace — the design's own auth screen (`Kaizen (1)/native/
   screen-runs.jsx` → LoginScreen), wired to the real useAuth login/register.

   This replaces the pre-redesign auth components (auth-card, form-field, input, label,
   divider, social-auth-row, button). Those hardcoded `text-white` and relied on legacy
   token aliases that no longer resolve, which is what made typed text invisible on the
   white field. Everything here styles through the design's plain-CSS classes
   (`.card`, `.field`, `.btn`, `.label`), so it cannot drift out of the theme again.

   Social sign-in is not rendered: there is no OAuth provider wired on the API. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { I } from './icons';
import { useAuth } from '@/context/auth-context';

const { useState } = React;

/** Rows share the card's inset-list look: a label above a borderless input. */
function Row({ label, hint, children, last }: any) {
  return (
    <div style={{ padding: '11px 14px', borderBottom: last ? 'none' : '.5px solid var(--sep)' }}>
      <div className="label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {label}
        {hint && <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-3)' }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

const FIELD: React.CSSProperties = {
  marginTop: 4, border: 'none', boxShadow: 'none', background: 'transparent',
  height: 24, padding: 0, fontSize: 14, color: 'var(--text)', width: '100%',
};

export function AuthScreen({ mode }: { mode: 'login' | 'signup' }) {
  const signup = mode === 'signup';
  const { login, loginAsDemo, register } = useAuth();
  const router = useRouter();
  const params = useSearchParams();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);

  /* One click into a read-only account, for someone evaluating Kaizen who shouldn't have
     to register first. No credentials here on purpose — /api/auth/demo holds them
     server-side, so the demo password never reaches the browser bundle. */
  async function openDemo() {
    setError('');
    setDemoBusy(true);
    try {
      await loginAsDemo();
      router.push(params.get('next') ?? '/tests');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the demo.');
    } finally {
      setDemoBusy(false);
    }
  }

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    setError('');

    if (signup) {
      if (!name.trim()) { setError('What should we call you?'); return; }
      if (pw.length < 8) { setError('Use at least 8 characters for the password.'); return; }
      if (pw !== confirm) { setError('Those passwords don’t match.'); return; }
    }

    setBusy(true);
    try {
      if (signup) await register(email.trim(), pw, name.trim());
      else await login(email.trim(), pw);
      router.push(params.get('next') ?? '/tests');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--window)' }}>
      <form className="rise" onSubmit={submit} style={{ width: 356, textAlign: 'center' }}>
        <div style={{ width: 54, height: 54, borderRadius: 14, background: 'var(--accent)', color: '#fff', display: 'grid', placeItems: 'center', margin: '0 auto', boxShadow: '0 6px 20px -4px rgba(11,98,244,.5)' }}>
          <I.logo size={28} />
        </div>
        <h1 style={{ fontSize: 21, fontWeight: 600, letterSpacing: '-.02em', marginTop: 15, marginBottom: 0, color: 'var(--text)' }}>
          {signup ? 'Create your workspace' : 'Sign in to Kaizen'}
        </h1>
        <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 5, lineHeight: 1.5 }}>
          {signup
            ? 'Tests written in English that keep passing on their own.'
            : 'Your tests have been running while you were away.'}
        </div>

        <div className="card" style={{ marginTop: 22, textAlign: 'left', overflow: 'hidden' }}>
          {signup && (
            <Row label="Your name">
              <input className="field" style={FIELD} value={name} autoComplete="name"
                onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
            </Row>
          )}
          <Row label="Email">
            <input className="field num" style={FIELD} type="email" value={email} autoComplete="email" autoFocus={!signup}
              onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </Row>
          <Row label="Password" hint={signup ? '· 8 characters or more' : undefined} last={!signup}>
            <input className="field" style={FIELD} type="password" value={pw}
              autoComplete={signup ? 'new-password' : 'current-password'}
              onChange={(e) => setPw(e.target.value)} placeholder="••••••••" />
          </Row>
          {signup && (
            <Row label="Confirm password" last>
              <input className="field" style={FIELD} type="password" value={confirm} autoComplete="new-password"
                onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" />
            </Row>
          )}
        </div>

        {error && (
          <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'center', marginTop: 12, padding: '9px 11px', borderRadius: 8, background: 'var(--fail-soft)', color: 'var(--fail)', fontSize: 12.5, lineHeight: 1.45, textAlign: 'left' }}>
            <I.x size={13} style={{ flex: 'none' }} />{error}
          </div>
        )}

        <button className="btn pri lg" type="submit" disabled={busy}
          style={{ width: '100%', marginTop: 14, height: 34, justifyContent: 'center' }}>
          {busy && <span className="spinner" style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,.35)' }} />}
          {busy ? (signup ? 'Creating…' : 'Signing in…') : (signup ? 'Create workspace' : 'Sign in')}
        </button>

        {/* Sign-in only: someone creating a workspace has already decided, and offering a
            detour into a read-only account at that point would only confuse the flow. */}
        {!signup && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0 12px' }}>
              <span style={{ flex: 1, height: 1, background: 'var(--sep)' }} />
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>or</span>
              <span style={{ flex: 1, height: 1, background: 'var(--sep)' }} />
            </div>
            <button className="btn lg" type="button" onClick={openDemo} disabled={busy || demoBusy}
              style={{ width: '100%', height: 34, justifyContent: 'center' }}>
              {demoBusy && <span className="spinner" style={{ width: 12, height: 12 }} />}
              {demoBusy ? 'Opening the demo…' : 'Demo user'}
            </button>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 7, lineHeight: 1.5 }}>
              Look around a real workspace without signing up. Runs are disabled on the demo
              account, so nothing you click there spends tokens.
            </div>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12, fontSize: 12 }}>
          <button type="button" onClick={() => router.push(signup ? '/login' : '/signup')}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent-text)', fontSize: 12 }}>
            {signup ? 'I already have an account' : 'Create a workspace'}
          </button>
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 20, lineHeight: 1.5 }}>
          Sessions are cookie-based, so you stay signed in on this device.
        </div>
      </form>
    </div>
  );
}

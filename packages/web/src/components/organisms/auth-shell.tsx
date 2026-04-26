'use client';

import Link from 'next/link';
import { Logo } from '@/components/atoms/logo';
import { ShellBackground } from '@/components/organisms/app-shell/shell-background';

type AuthShellProps = {
  children: React.ReactNode;
};

/**
 * Backdrop for unauthenticated screens (/login, /signup).
 *
 * Uses the same animated 2D-canvas background as the (app) route group, but
 * with no side rail or top bar — there is no logged-in user yet, so there
 * are no nav targets. Just the brand mark in the corner and a centered slot
 * for the auth card.
 */
export function AuthShell({ children }: AuthShellProps) {
  return (
    <div className="relative min-h-screen w-full bg-app-bg text-text overflow-hidden">
      <ShellBackground />
      <Link
        href="/"
        className="absolute top-6 left-6 z-10"
        aria-label="Kaizen home"
      >
        <Logo size="md" />
      </Link>
      <main className="relative z-[2] flex min-h-screen items-center justify-center p-4">
        {children}
      </main>
    </div>
  );
}

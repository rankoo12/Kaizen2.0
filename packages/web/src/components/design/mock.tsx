'use client';
/* MOCK marker.
 *
 * Anything on screen that is NOT backed by live backend data must carry this badge, so
 * nobody mistakes a placeholder for a real reading. It is deliberately visible rather
 * than a dev-only flag: a fake number that looks real is worse in a demo than an ugly
 * badge.
 *
 * The rule for this codebase:
 *   - Real data            → render it.
 *   - No source for it     → omit the field, or show "—". NOT a plausible-looking value.
 *   - Placeholder anyway   → wrap it in <Mock> and say why.
 *
 * If you find yourself reaching for this badge, first check whether the field can simply
 * be dropped — that has been the right answer nearly every time (see
 * docs/specs/ui/spec-native-macos-port.md "Deliberately not faked").
 */
import * as React from 'react';

/** Inline chip: marks the value next to it as placeholder. */
export function MockBadge({ reason, style }: { reason: string; style?: React.CSSProperties }) {
  return (
    <span
      className="badge"
      title={`Placeholder — ${reason}`}
      aria-label={`Mock data: ${reason}`}
      style={{
        background: 'var(--warn-soft)',
        color: 'var(--warn)',
        fontWeight: 700,
        letterSpacing: '.08em',
        flex: 'none',
        ...style,
      }}
    >
      MOCK
    </span>
  );
}

/** Wraps placeholder content so the badge always travels with it. */
export function Mock({ reason, children, style }: {
  reason: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, ...style }}>
      {children}
      <MockBadge reason={reason} />
    </span>
  );
}

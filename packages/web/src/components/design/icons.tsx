/* Ported verbatim from `Kaizen (1)/native/icons.jsx` — design is the source of truth.
   Minimal stroke icon set. 16px grid, currentColor, 1.5 stroke. Loosely typed on
   purpose: this mirrors the design's dynamic icon-map pattern. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';

type IconProps = {
  d?: string;
  size?: number;
  fill?: boolean;
  children?: React.ReactNode;
} & Omit<React.SVGProps<SVGSVGElement>, 'd'>;

export function Icon({ d, size = 16, fill, children, ...rest }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none"
      stroke={fill ? 'none' : 'currentColor'} strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {children || <path d={d} />}
    </svg>
  );
}

export const I: Record<string, (p: any) => React.ReactElement> = {
  tests: (p) => <Icon {...p}><path d="M6 2h4M6.8 2v4.2L3.9 12a1.6 1.6 0 0 0 1.4 2.4h5.4A1.6 1.6 0 0 0 12.1 12L9.2 6.2V2" /></Icon>,
  runs: (p) => <Icon {...p}><circle cx="8" cy="8.4" r="5.4" /><path d="M8 5.8v2.6l1.9 1.2M2.2 4.4 4 2.9" /></Icon>,
  brain: (p) => <Icon {...p}><path d="M8 3.2v9.6M8 3.2a2 2 0 0 0-3.6 1.2 1.9 1.9 0 0 0-1 3.3A2 2 0 0 0 4.7 11a2 2 0 0 0 3.3 1.8M8 3.2a2 2 0 0 1 3.6 1.2 1.9 1.9 0 0 1 1 3.3A2 2 0 0 1 11.3 11 2 2 0 0 1 8 12.8" /></Icon>,
  usage: (p) => <Icon {...p}><path d="M2.4 13.2h11.2M4.4 13V9M7.4 13V5.6M10.4 13v-4M13.4 13V3.4" /></Icon>,
  keys: (p) => <Icon {...p}><circle cx="5.6" cy="10.4" r="2.6" /><path d="M7.5 8.6 13 3.1M10.6 5.9l1.5 1.5M12 4.5l1.5 1.5" /></Icon>,
  settings: (p) => <Icon {...p}><circle cx="8" cy="8" r="2.1" /><path d="M8 1.8v1.4M8 12.8v1.4M2.6 8H4M12 8h1.4M4.2 4.2l1 1M10.8 10.8l1 1M11.8 4.2l-1 1M5.2 10.8l-1 1" /></Icon>,
  suites: (p) => <Icon {...p}><path d="M8 1.9 14 5l-6 3.1L2 5l6-3.1M2 8.5l6 3.1 6-3.1M2 11.6l6 3.1 6-3.1" /></Icon>,
  plus: (p) => <Icon {...p}><path d="M8 3.4v9.2M3.4 8h9.2" /></Icon>,
  play: (p) => <Icon {...p} fill><path d="M4.6 3.2 12.6 8l-8 4.8z" fill="currentColor" /></Icon>,
  pause: (p) => <Icon {...p} fill><path d="M5 3.4h2.1v9.2H5zM8.9 3.4H11v9.2H8.9z" fill="currentColor" /></Icon>,
  check: (p) => <Icon {...p}><path d="M3.2 8.4 6.3 11.5l6.5-7" /></Icon>,
  eye: (p) => <Icon {...p}><path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8z" /><circle cx="8" cy="8" r="2" /></Icon>,
  x: (p) => <Icon {...p}><path d="M4 4l8 8M12 4l-8 8" /></Icon>,
  heal: (p) => <Icon {...p}><path d="M13.4 3.2 6.6 10l-2.9.6.6-2.9 6.8-6.8a1.4 1.4 0 0 1 2 2zM2.6 13.4h5" /></Icon>,
  skip: (p) => <Icon {...p}><path d="M4 4.4v7.2M11.4 4.4v7.2M6.2 8h4" /></Icon>,
  chevron: (p) => <Icon {...p}><path d="M6.2 3.6 10.6 8l-4.4 4.4" /></Icon>,
  chevronDown: (p) => <Icon {...p}><path d="M3.6 6.2 8 10.6l4.4-4.4" /></Icon>,
  chevronUp: (p) => <Icon {...p}><path d="M3.6 9.8 8 5.4l4.4 4.4" /></Icon>,
  back: (p) => <Icon {...p}><path d="M9.8 3.6 5.4 8l4.4 4.4" /></Icon>,
  search: (p) => <Icon {...p}><circle cx="7.2" cy="7.2" r="4.2" /><path d="M10.4 10.4 13.4 13.4" /></Icon>,
  globe: (p) => <Icon {...p}><circle cx="8" cy="8" r="5.6" /><path d="M2.5 8h11M8 2.4c1.6 1.6 2.4 3.5 2.4 5.6S9.6 12 8 13.6C6.4 12 5.6 10.1 5.6 8S6.4 4 8 2.4z" /></Icon>,
  bolt: (p) => <Icon {...p}><path d="M9.2 1.8 3.8 9h3.4l-.6 5.2L12.4 7H9l.2-5.2z" /></Icon>,
  db: (p) => <Icon {...p}><ellipse cx="8" cy="4" rx="5" ry="2.1" /><path d="M3 4v8c0 1.2 2.2 2.1 5 2.1s5-.9 5-2.1V4M3 8c0 1.2 2.2 2.1 5 2.1s5-.9 5-2.1" /></Icon>,
  sparkle: (p) => <Icon {...p}><path d="M8 2.2 9.1 6 12.9 7 9.1 8.1 8 11.9 6.9 8.1 3.1 7 6.9 6zM12.6 10.6l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" /></Icon>,
  copy: (p) => <Icon {...p}><rect x="5.6" y="5.6" width="7.8" height="7.8" rx="1.6" /><path d="M10.4 3.4a1.8 1.8 0 0 0-1.8-1.8H4.2a1.8 1.8 0 0 0-1.8 1.8v4.4a1.8 1.8 0 0 0 1.8 1.8" /></Icon>,
  trash: (p) => <Icon {...p}><path d="M2.8 4.4h10.4M6.2 4.4V2.8h3.6v1.6M4.4 4.4l.6 8.4a1.2 1.2 0 0 0 1.2 1.1h3.6a1.2 1.2 0 0 0 1.2-1.1l.6-8.4" /></Icon>,
  drag: (p) => <Icon {...p} fill><g fill="currentColor"><circle cx="6" cy="4" r="1.05" /><circle cx="10" cy="4" r="1.05" /><circle cx="6" cy="8" r="1.05" /><circle cx="10" cy="8" r="1.05" /><circle cx="6" cy="12" r="1.05" /><circle cx="10" cy="12" r="1.05" /></g></Icon>,
  more: (p) => <Icon {...p} fill><g fill="currentColor"><circle cx="3.6" cy="8" r="1.15" /><circle cx="8" cy="8" r="1.15" /><circle cx="12.4" cy="8" r="1.15" /></g></Icon>,
  sidebar: (p) => <Icon {...p}><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M6.4 3v10" /></Icon>,
  info: (p) => <Icon {...p}><circle cx="8" cy="8" r="5.8" /><path d="M8 7.3v3.5M8 5.3v.4" /></Icon>,
  clock: (p) => <Icon {...p}><circle cx="8" cy="8" r="5.8" /><path d="M8 4.9V8l2.2 1.4" /></Icon>,
  pin: (p) => <Icon {...p}><path d="M8 9.6v4.2M5.4 2.2h5.2l-.6 3.1 1.6 2.1a.8.8 0 0 1-.6 1.3H5a.8.8 0 0 1-.6-1.3L6 5.3z" /></Icon>,
  block: (p) => <Icon {...p}><circle cx="8" cy="8" r="5.6" /><path d="M4.2 11.8 11.8 4.2" /></Icon>,
  cloud: (p) => <Icon {...p}><path d="M4.6 12.4h6.9a2.9 2.9 0 0 0 .3-5.8A4 4 0 0 0 4.3 6.6a2.9 2.9 0 0 0 .3 5.8z" /></Icon>,
  frame: (p) => <Icon {...p}><rect x="2.2" y="3" width="11.6" height="8.4" rx="1.4" /><path d="M5.6 13.8h4.8" /></Icon>,
  phone: (p) => <Icon {...p}><rect x="4.4" y="1.8" width="7.2" height="12.4" rx="1.8" /><path d="M7.2 12.4h1.6" /></Icon>,
  target: (p) => <Icon {...p}><circle cx="8" cy="8" r="5.6" /><circle cx="8" cy="8" r="2.2" /></Icon>,
  arrowDown: (p) => <Icon {...p}><path d="M8 3.2v9.4M4.4 9.2 8 12.8l3.6-3.6" /></Icon>,
  arrowUp: (p) => <Icon {...p}><path d="M8 12.8V3.4M4.4 6.8 8 3.2l3.6 3.6" /></Icon>,
  logo: (p) => <Icon {...p}><path d="M4 2.6v10.8M4 8.4 11.6 2.6M7 6.2l4.9 7.2" /></Icon>,
};

export type StatusKey =
  | 'passed' | 'failed' | 'healed' | 'skipped' | 'pending' | 'queued' | 'running' | 'cancelled';

export const STATUS: Record<string, { c: string; s: string; label: string; icon: string }> = {
  passed:    { c: 'var(--pass)',   s: 'var(--pass-soft)',   label: 'Passed',    icon: 'check' },
  failed:    { c: 'var(--fail)',   s: 'var(--fail-soft)',   label: 'Failed',    icon: 'x' },
  healed:    { c: 'var(--heal)',   s: 'var(--heal-soft)',   label: 'Healed',    icon: 'heal' },
  skipped:   { c: 'var(--idle)',   s: 'var(--idle-soft)',   label: 'Skipped',   icon: 'skip' },
  pending:   { c: 'var(--idle)',   s: 'var(--idle-soft)',   label: 'Pending',   icon: 'clock' },
  queued:    { c: 'var(--idle)',   s: 'var(--idle-soft)',   label: 'Queued',    icon: 'clock' },
  running:   { c: 'var(--accent)', s: 'var(--accent-soft)', label: 'Running',   icon: 'play' },
  cancelled: { c: 'var(--idle)',   s: 'var(--idle-soft)',   label: 'Cancelled', icon: 'block' },
};

export function StatusBadge({ status, size = 'md' }: { status: string; size?: 'sm' | 'md' }) {
  const st = STATUS[status] || STATUS.pending;
  const Ico = I[st.icon];
  return (
    <span className="badge" style={{ background: st.s, color: st.c, height: size === 'sm' ? 18 : 20 }}>
      <Ico size={10} /> {st.label}
    </span>
  );
}

export function StatusDot({ status }: { status: string }) {
  const st = STATUS[status] || STATUS.pending;
  return <span className="dot" style={{ background: st.c, boxShadow: `0 0 0 3px ${st.s}` }} />;
}

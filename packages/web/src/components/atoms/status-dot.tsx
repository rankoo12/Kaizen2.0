import { cn } from '@/lib/cn';

export type StatusKind =
  | 'passed'
  | 'failed'
  | 'healed'
  | 'pending'
  | 'running'
  | 'queued';

type StatusDotProps = {
  status: StatusKind;
  size?: number;
  className?: string;
};

const colorVar: Record<StatusKind, string> = {
  passed: 'var(--color-success)',
  failed: 'var(--color-danger)',
  healed: 'var(--color-brand-accent)',
  pending: 'var(--color-text-low)',
  running: 'var(--color-brand-primary)',
  queued: 'var(--color-warning)',
};

export function StatusDot({ status, size = 6, className }: StatusDotProps) {
  const c = colorVar[status];
  return (
    <span
      aria-label={status}
      className={cn('inline-block rounded-full shrink-0', className)}
      style={{
        width: size,
        height: size,
        background: c,
        boxShadow: `0 0 ${size + 2}px ${c}`,
      }}
    />
  );
}

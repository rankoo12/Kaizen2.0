import { cn } from '@/lib/cn';

type WipProps = { className?: string; label?: string };

export function Wip({ className, label = 'WIP' }: WipProps) {
  return (
    <span
      role="note"
      title="Work in progress — backend or data source not wired yet"
      aria-label="work in progress"
      className={cn(
        'font-mono text-[10px] tracking-[0.18em] uppercase text-text-faint',
        className,
      )}
    >
      {label}
    </span>
  );
}

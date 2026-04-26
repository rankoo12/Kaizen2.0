import { cn } from '@/lib/cn';

type KbdProps = { children: React.ReactNode; className?: string };

export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center font-mono text-[10px]',
        'rounded px-1.5 py-px',
        'bg-app-bg-deep border border-border-subtle text-text-low',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

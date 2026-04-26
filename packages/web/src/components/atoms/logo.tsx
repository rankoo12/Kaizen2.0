import { cn } from '@/lib/cn';

type LogoProps = {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  collapsed?: boolean;
};

const markSize = { sm: 18, md: 22, lg: 28 } as const;
const wordSize = { sm: 13, md: 15, lg: 19 } as const;

export function Logo({ size = 'md', className, collapsed = false }: LogoProps) {
  const m = markSize[size];

  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span
        className="relative grid place-items-center shrink-0"
        style={{ width: m, height: m }}
        aria-hidden
      >
        <span
          className="absolute inset-0 rounded-[4px] rotate-45 bg-brand-primary"
          style={{ boxShadow: '0 0 14px var(--color-brand-primary-glow)' }}
        />
        <span className="absolute inset-1 rounded-[2px] rotate-45 bg-app-bg" />
        <span
          className="absolute h-1.5 w-1.5 rounded-full bg-brand-accent"
          style={{ boxShadow: '0 0 10px var(--color-brand-accent-glow)' }}
        />
      </span>
      {!collapsed && (
        <span
          className="font-display font-bold tracking-wider"
          style={{ fontSize: wordSize[size] }}
        >
          <span className="text-text-hi">KAI</span>
          <span className="text-brand-primary">ZEN</span>
        </span>
      )}
    </span>
  );
}

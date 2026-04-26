import type { ComponentType, MouseEventHandler } from 'react';
import type { LucideProps } from 'lucide-react';
import { cn } from '@/lib/cn';

type IconButtonProps = {
  icon: ComponentType<LucideProps>;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  active?: boolean;
  title?: string;
  size?: 'sm' | 'md';
  className?: string;
  'aria-label'?: string;
};

const dim = { sm: 28, md: 32 } as const;
const iconDim = { sm: 13, md: 15 } as const;

export function IconButton({
  icon: Icon,
  onClick,
  active = false,
  title,
  size = 'md',
  className,
  'aria-label': ariaLabel,
}: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel ?? title}
      className={cn(
        'grid place-items-center rounded-md transition-colors',
        'border border-transparent',
        active
          ? 'bg-surface-elevated text-brand-primary'
          : 'bg-transparent text-text-mid hover:bg-surface-elevated hover:text-text-hi',
        className,
      )}
      style={{ width: dim[size], height: dim[size] }}
    >
      <Icon size={iconDim[size]} />
    </button>
  );
}

import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/cn';

type ButtonProps = {
  variant: 'primary-orange' | 'primary-pink' | 'outline-orange' | 'ghost-pink' | 'destructive';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  disabled?: boolean;
};

const base =
  'inline-flex items-center justify-center gap-2 font-semibold rounded-lg cursor-pointer ' +
  'transition-all duration-300 ease-out active:scale-95 ' +
  'disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg';

const variants: Record<ButtonProps['variant'], string> = {
  'primary-orange':
    'bg-gradient-to-r from-brand-primary-soft to-brand-primary text-black ' +
    'hover:-translate-y-0.5 hover:shadow-[0_0_20px_color-mix(in_oklab,var(--color-brand-primary)_40%,transparent)]',
  'primary-pink':
    'bg-gradient-to-r from-brand-accent-soft to-brand-accent-mid text-black ' +
    'hover:-translate-y-0.5 hover:shadow-[0_0_20px_color-mix(in_oklab,var(--color-brand-accent)_40%,transparent)]',
  'outline-orange':
    'bg-transparent border border-brand-primary text-brand-primary hover:bg-brand-primary/10',
  'ghost-pink':
    'bg-card-bg border border-border-subtle text-brand-accent hover:bg-white/5',
  destructive:
    'bg-transparent text-brand-danger hover:bg-brand-danger/10',
};

const sizes: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'px-3 py-2 text-xs',
  md: 'px-5 py-3.5 text-sm',
  lg: 'px-6 py-4 text-base',
};

export function Button({
  variant,
  size = 'md',
  fullWidth,
  leftIcon,
  rightIcon,
  children,
  onClick,
  type = 'button',
  disabled,
}: ButtonProps) {
  const showArrow = variant === 'primary-orange' && !rightIcon;

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(base, variants[variant], sizes[size], fullWidth && 'w-full')}
    >
      {leftIcon}
      {children}
      {showArrow ? <ArrowRight className="w-4 h-4" /> : rightIcon}
    </button>
  );
}

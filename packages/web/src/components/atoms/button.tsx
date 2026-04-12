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
  'inline-flex items-center justify-center gap-2 font-semibold rounded-lg transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

const variants: Record<ButtonProps['variant'], string> = {
  'primary-orange':
    'bg-gradient-to-r from-brand-orange-light to-brand-orange text-black hover:opacity-90',
  'primary-pink':
    'bg-gradient-to-r from-brand-pink-light to-brand-pink-mid text-black hover:opacity-90',
  'outline-orange':
    'bg-transparent border border-brand-orange text-brand-orange hover:bg-brand-orange/10',
  'ghost-pink':
    'bg-card-bg border border-border-subtle text-brand-pink hover:bg-white/5',
  destructive:
    'bg-transparent text-brand-red hover:bg-brand-red/10',
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

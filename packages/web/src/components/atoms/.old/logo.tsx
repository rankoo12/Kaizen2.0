import { cn } from '@/lib/cn';

type LogoProps = { size?: 'sm' | 'md' | 'lg'; className?: string };

const sizeClass = {
  sm: 'text-lg',
  md: 'text-2xl',
  lg: 'text-4xl',
};

export function Logo({ size = 'md', className }: LogoProps) {
  return (
    <span
      className={cn(
        'font-space font-bold tracking-wider cursor-pointer',
        sizeClass[size],
        className,
      )}
    >
      <span className="text-white">KAI</span>
      <span className="text-brand-orange">ZEN</span>
    </span>
  );
}

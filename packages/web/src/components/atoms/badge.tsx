import { cn } from '@/lib/cn';

type BadgeProps = {
  icon?: React.ReactNode;
  children: React.ReactNode;
  variant?: 'pink' | 'orange';
};

const variants = {
  pink: 'border-brand-pink/30 text-brand-pink',
  orange: 'border-brand-orange/30 text-brand-orange',
};

export function Badge({ icon, children, variant = 'pink' }: BadgeProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 border rounded-full px-4 py-1.5',
        'bg-black/20 backdrop-blur-md',
        variants[variant],
      )}
    >
      {icon && <span className="flex-shrink-0">{icon}</span>}
      <span className="text-[10px] tracking-[0.2em] font-semibold uppercase">{children}</span>
    </div>
  );
}

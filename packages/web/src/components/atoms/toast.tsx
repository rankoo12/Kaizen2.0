import { AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

export type ToastKind = 'info' | 'success' | 'danger';

type ToastProps = {
  message: string;
  kind?: ToastKind;
  className?: string;
};

const palette: Record<ToastKind, { ring: string; icon: typeof AlertCircle; tone: string }> = {
  info: { ring: 'border-brand-primary/60', icon: AlertCircle, tone: 'text-brand-primary' },
  success: { ring: 'border-success/60', icon: CheckCircle2, tone: 'text-success' },
  danger: { ring: 'border-danger/60', icon: XCircle, tone: 'text-danger' },
};

export function Toast({ message, kind = 'info', className }: ToastProps) {
  const { ring, icon: Icon, tone } = palette[kind];
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'animate-toast-drop',
        'fixed top-[76px] left-1/2 z-[200]',
        'flex items-center gap-2.5',
        'rounded-full px-4 py-2',
        'bg-surface-elevated border',
        'text-xs font-medium text-text-hi',
        'shadow-2xl',
        ring,
        className,
      )}
    >
      <Icon className={cn('w-3.5 h-3.5', tone)} />
      <span>{message}</span>
    </div>
  );
}

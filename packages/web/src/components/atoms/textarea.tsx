import { cn } from '@/lib/cn';

type TextareaProps = {
  placeholder?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  rows?: number;
  codeStyle?: boolean;
  className?: string;
};

export function Textarea({
  placeholder,
  value,
  onChange,
  rows = 4,
  codeStyle,
  className,
}: TextareaProps) {
  return (
    <textarea
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      rows={rows}
      suppressHydrationWarning
      className={cn(
        'w-full bg-input-bg text-sm text-white rounded-xl px-4 py-3 outline-none',
        'border border-border-subtle focus:border-brand-accent/50 transition-colors',
        'placeholder:text-gray-700 resize-none',
        codeStyle && 'code-input font-mono text-brand-accent',
        className,
      )}
    />
  );
}

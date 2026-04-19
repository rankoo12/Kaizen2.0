import { cn } from '@/lib/cn';

type InputProps = {
  type?: 'text' | 'email' | 'password';
  placeholder?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  leftIcon?: React.ReactNode;
  rightElement?: React.ReactNode;
  /** @deprecated — kept for API compatibility; all inputs now use the accent focus ring */
  focusVariant?: 'orange' | 'pink' | 'accent';
  error?: boolean;
  className?: string;
  disabled?: boolean;
};

export function Input({
  type = 'text',
  placeholder,
  value,
  onChange,
  leftIcon,
  rightElement,
  error,
  className,
  disabled,
}: InputProps) {
  return (
    <div className="relative flex items-center group w-full">
      {leftIcon && (
        <span className="absolute left-4 text-gray-500 transition-colors group-focus-within:text-white/60 pointer-events-none">
          {leftIcon}
        </span>
      )}
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        disabled={disabled}
        suppressHydrationWarning
        className={cn(
          'w-full bg-input-bg text-sm text-white rounded-lg py-3.5 outline-none',
          'border transition-all duration-300 ease-out placeholder:text-gray-600',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          error
            ? 'border-brand-danger focus:border-brand-danger focus:ring-1 focus:ring-brand-danger/40'
            : 'border-border-subtle focus:border-brand-accent focus:ring-1 focus:ring-brand-accent/40',
          leftIcon ? 'pl-11' : 'px-4',
          rightElement ? 'pr-11' : 'pr-4',
          className,
        )}
      />
      {rightElement && (
        <span className="absolute right-4 text-gray-500 text-sm font-medium pointer-events-none">
          {rightElement}
        </span>
      )}
    </div>
  );
}

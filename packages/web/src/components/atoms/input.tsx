import { cn } from '@/lib/cn';

type InputProps = {
  type?: 'text' | 'email' | 'password';
  placeholder?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  leftIcon?: React.ReactNode;
  rightElement?: React.ReactNode;
  focusVariant?: 'orange' | 'pink' | 'accent';
  className?: string;
  disabled?: boolean;
};

const focusVariants: Record<NonNullable<InputProps['focusVariant']>, string> = {
  orange: 'focus:border-brand-orange/50',
  pink: 'focus:border-brand-pink/50',
  accent: 'focus:border-brand-accent/50',
};

export function Input({
  type = 'text',
  placeholder,
  value,
  onChange,
  leftIcon,
  rightElement,
  focusVariant = 'orange',
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
          'border border-transparent transition-colors placeholder:text-gray-600',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          focusVariants[focusVariant],
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

import { cn } from '@/lib/cn';

type InputProps = {
  type?: 'text' | 'email' | 'password';
  placeholder?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  rightElement?: React.ReactNode;
  focusVariant?: 'orange' | 'pink' | 'accent';
  className?: string;
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
  rightElement,
  focusVariant = 'orange',
  className,
}: InputProps) {
  return (
    <div className="relative flex items-center">
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        suppressHydrationWarning
        className={cn(
          'w-full bg-input-bg text-sm text-white rounded-lg px-4 py-3.5 outline-none',
          'border border-transparent transition-colors placeholder:text-gray-600',
          focusVariants[focusVariant],
          rightElement && 'pr-10',
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

import { Trash2 } from 'lucide-react';

type StepItemProps = {
  index: number;
  value: string;
  onChange: (value: string) => void;
  onRemove: () => void;
  placeholder?: string;
};

export function StepItem({ index, value, onChange, onRemove, placeholder }: StepItemProps) {
  const stepNumber = index.toString().padStart(2, '0');
  const isEmpty = value === '';

  return (
    <div className="flex items-start space-x-3 group">
      <div className="w-8 h-8 rounded-lg bg-input-bg border border-border-subtle flex items-center justify-center text-xs font-bold text-brand-pink shrink-0 mt-1">
        {stepNumber}
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? 'Describe the next action...'}
        suppressHydrationWarning
        className={`flex-1 bg-input-bg/50 hover:bg-input-bg text-sm text-gray-200 rounded-lg px-4 py-2.5 outline-none transition-colors border ${
          isEmpty
            ? 'border-border-subtle border-dashed focus:border-brand-accent/30 focus:border-solid'
            : 'border-transparent focus:border-brand-accent/30'
        }`}
      />
      <button
        type="button"
        onClick={onRemove}
        className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-brand-red transition-all p-2 mt-0.5"
        aria-label="Remove step"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}

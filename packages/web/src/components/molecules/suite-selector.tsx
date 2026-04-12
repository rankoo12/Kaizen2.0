import { Monitor, ChevronDown } from 'lucide-react';

type SuiteSelectorProps = {
  value: string;
  onChange?: (value: string) => void;
};

export function SuiteSelector({ value }: SuiteSelectorProps) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-bold tracking-widest text-gray-500 uppercase">Suite</p>
      <div className="flex items-center justify-between bg-input-bg px-4 py-2.5 rounded-lg border border-border-subtle cursor-pointer hover:border-gray-500 transition-colors">
        <div className="flex items-center space-x-2">
          <Monitor className="w-4 h-4 text-gray-400" />
          <span className="text-sm font-medium text-gray-200">{value}</span>
        </div>
        <ChevronDown className="w-4 h-4 text-gray-500" />
      </div>
    </div>
  );
}

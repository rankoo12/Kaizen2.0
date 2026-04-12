type DividerProps = { label: string };

export function Divider({ label }: DividerProps) {
  return (
    <div className="flex items-center my-8">
      <div className="flex-1 h-px bg-white/10" />
      <span className="px-4 text-sm font-medium text-white">{label}</span>
      <div className="flex-1 h-px bg-white/10" />
    </div>
  );
}

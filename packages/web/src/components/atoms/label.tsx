type LabelProps = {
  children: React.ReactNode;
  rightSlot?: React.ReactNode;
  htmlFor?: string;
};

export function Label({ children, rightSlot, htmlFor }: LabelProps) {
  return (
    <label
      htmlFor={htmlFor}
      className="flex items-center justify-between text-[11px] font-semibold text-gray-400 tracking-wider uppercase"
    >
      <span>{children}</span>
      {rightSlot && <span>{rightSlot}</span>}
    </label>
  );
}

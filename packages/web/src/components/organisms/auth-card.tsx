type AuthCardProps = {
  title: string;
  children: React.ReactNode;
};

export function AuthCard({ title, children }: AuthCardProps) {
  return (
    <div className="bg-surface border border-border-subtle w-full max-w-[480px] rounded-2xl shadow-2xl p-10 md:p-12 relative overflow-hidden">
      {/* Top highlight line */}
      <div className="absolute top-0 left-0 w-full h-[1px] bg-border-strong" />
      <h1 className="font-display text-3xl font-semibold text-text-hi tracking-tight text-center mb-10">{title}</h1>
      {children}
    </div>
  );
}

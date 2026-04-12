type AuthCardProps = {
  title: string;
  children: React.ReactNode;
};

export function AuthCard({ title, children }: AuthCardProps) {
  return (
    <div className="bg-card-bg w-full max-w-[480px] rounded-2xl shadow-2xl p-10 md:p-12 relative overflow-hidden">
      {/* Top highlight line */}
      <div className="absolute top-0 left-0 w-full h-[1px] bg-white/5" />
      <h1 className="text-3xl font-bold text-center mb-10">{title}</h1>
      {children}
    </div>
  );
}

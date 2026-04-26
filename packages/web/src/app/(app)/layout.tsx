import { SideRail } from '@/components/organisms/app-shell/side-rail';
import { ShellBackground } from '@/components/organisms/app-shell/shell-background';

export default function AppShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex h-screen w-full overflow-hidden bg-app-bg text-text">
      <ShellBackground />
      <div className="relative z-[2] flex w-full">
        <SideRail />
        <main className="relative flex-1 flex flex-col overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}

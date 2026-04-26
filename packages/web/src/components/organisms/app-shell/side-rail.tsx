'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Beaker,
  History,
  Layers,
  Globe,
  Plug,
  Settings,
  HelpCircle,
  type LucideIcon,
} from 'lucide-react';
import { Logo } from '@/components/atoms/logo';
import { StatusDot } from '@/components/atoms/status-dot';
import { Wip } from '@/components/atoms/wip';
import { useAuth } from '@/context/auth-context';
import { cn } from '@/lib/cn';

type NavItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  href: string;
  badge?: string;
  wip?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { id: 'tests',        label: 'Tests',        icon: Beaker,  href: '/tests' },
  { id: 'runs',         label: 'Runs',         icon: History, href: '/runs',         wip: true },
  { id: 'suites',       label: 'Suites',       icon: Layers,  href: '/suites',       wip: true },
  { id: 'environments', label: 'Environments', icon: Globe,   href: '/environments', wip: true },
  { id: 'integrations', label: 'Integrations', icon: Plug,    href: '/integrations', wip: true },
];

const NAV_FOOTER: NavItem[] = [
  { id: 'settings', label: 'Settings', icon: Settings,   href: '/settings', wip: true },
  { id: 'help',     label: 'Help',     icon: HelpCircle, href: '/help',     wip: true },
];

export function SideRail() {
  const pathname = usePathname();
  const { user } = useAuth();

  const isActive = (href: string) => pathname === href || pathname?.startsWith(`${href}/`);

  const initials = (user?.displayName ?? '??')
    .split(/\s+/)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2) || '??';

  return (
    <aside
      className={cn(
        'flex flex-col gap-6 shrink-0',
        'w-[232px] px-3.5 pt-5 pb-3.5',
        'bg-gradient-to-b from-app-bg-deep to-app-bg',
        'border-r border-border-subtle relative z-[5]',
      )}
    >
      {/* logo */}
      <div className="px-1.5 pt-1">
        <Logo size="lg" />
      </div>

      {/* primary nav */}
      <nav className="flex flex-col gap-0.5">
        <div className="eyebrow px-2 pb-2">workflow</div>
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.id} item={item} active={isActive(item.href)} />
        ))}
      </nav>

      {/* recent runs — WIP until a useRecentRuns hook lands */}
      <div className="flex flex-col gap-1.5">
        <div className="eyebrow px-2 flex items-center gap-2">
          <span>recent runs</span>
          <Wip />
        </div>
      </div>

      <div className="flex-1" />

      {/* engine widget — WIP */}
      <div className="bg-surface border border-border-subtle rounded-[10px] p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="eyebrow">engine</span>
          <Wip />
        </div>
        <div className="text-[11px] text-text-mid leading-relaxed flex flex-col gap-0.5">
          <Row label="Workers" />
          <Row label="Queue" />
          <Row label="Region" />
        </div>
      </div>

      {/* footer nav + profile */}
      <nav className="flex flex-col gap-0.5">
        {NAV_FOOTER.map((item) => (
          <NavLink key={item.id} item={item} active={isActive(item.href)} />
        ))}
        <div className="mt-1 flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-surface border border-border-subtle">
          <div
            className="w-[22px] h-[22px] rounded-full grid place-items-center text-[10px] font-bold text-app-bg-deep"
            style={{ background: 'linear-gradient(135deg, var(--color-brand-primary), var(--color-brand-accent))' }}
            aria-hidden
          >
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-text-hi leading-tight truncate">{user?.displayName ?? 'Signed out'}</div>
            <div className="eyebrow !text-[9px]">{user?.email ? 'signed in' : 'guest'}</div>
          </div>
        </div>
      </nav>
    </aside>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  const baseClass = cn(
    'group relative flex items-center gap-2.5 px-2.5 py-2 rounded-lg',
    'text-sm font-medium transition-colors',
  );

  if (item.wip) {
    return (
      <div
        title="Not wired yet"
        aria-disabled
        className={cn(baseClass, 'text-text-low cursor-not-allowed')}
      >
        <Icon size={15} />
        <span className="flex-1">{item.label}</span>
        <Wip />
      </div>
    );
  }

  return (
    <Link
      href={item.href}
      className={cn(
        baseClass,
        'cursor-pointer',
        active
          ? 'bg-surface-elevated text-text-hi'
          : 'text-text-mid hover:bg-surface hover:text-text-hi',
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute -left-3.5 top-1.5 bottom-1.5 w-0.5 rounded-sm bg-brand-primary"
          style={{ boxShadow: '0 0 8px var(--color-brand-primary-glow)' }}
        />
      )}
      <Icon size={15} className={active ? 'text-brand-primary' : ''} />
      <span className="flex-1">{item.label}</span>
      {item.badge && (
        <span className="font-mono tabular text-[10px] text-text-low">{item.badge}</span>
      )}
    </Link>
  );
}

function Row({ label }: { label: string }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <Wip />
    </div>
  );
}

// re-export for tests / external consumers if needed
export { StatusDot };

'use client';

import Link from 'next/link';
import { Bell, Sparkles, ChevronRight, Search as SearchIcon } from 'lucide-react';
import { IconButton } from '@/components/atoms/icon-button';
import { Kbd } from '@/components/atoms/kbd';
import { Wip } from '@/components/atoms/wip';
import { ThemeSwitcher } from '@/components/molecules/theme-switcher';
import { ProfileDropdown } from '@/components/molecules/profile-dropdown';
import { MusicPlayerToggle } from '@/components/atoms/music-player-toggle';
import { cn } from '@/lib/cn';

export type Crumb = { label: string; mono?: boolean; href?: string };

type TopBarProps = {
  crumbs: Crumb[];
  rightSlot?: React.ReactNode;
  className?: string;
};

export function TopBar({ crumbs, rightSlot, className }: TopBarProps) {
  return (
    <header
      className={cn(
        'flex items-center gap-4 px-6 min-h-[56px] relative z-[4]',
        'border-b border-border-subtle',
        'bg-app-bg-deep/55 backdrop-blur-md',
        className,
      )}
    >
      <Breadcrumbs crumbs={crumbs} />
      <div className="flex-1" />
      <SearchHint />
      {rightSlot}
      <div className="flex items-center gap-1">
        <IconButton icon={Bell} aria-label="Notifications" title="Notifications" />
        <IconButton icon={Sparkles} aria-label="What's new" title="What's new" />
      </div>
      <div className="flex items-center gap-3 pl-2 border-l border-border-subtle">
        <MusicPlayerToggle />
        <ThemeSwitcher />
        <ProfileDropdown />
      </div>
    </header>
  );
}

function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <div className="flex items-center gap-1.5 text-sm">
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        const baseClass = cn(
          last ? 'text-text-hi font-medium' : 'text-text-mid',
          c.mono && 'font-mono text-xs',
          !last && c.href && 'hover:text-text-hi cursor-pointer transition-colors',
        );
        return (
          <span key={`${c.label}-${i}`} className="flex items-center gap-1.5">
            {i > 0 && <ChevronRight size={12} className="text-text-faint" />}
            {!last && c.href ? (
              <Link href={c.href} className={baseClass}>{c.label}</Link>
            ) : (
              <span className={baseClass}>{c.label}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function SearchHint() {
  return (
    <button
      type="button"
      disabled
      title="Search — not wired yet"
      className="inline-flex items-center justify-between gap-4 min-w-[240px] px-2.5 py-1.5 rounded-md text-xs bg-surface border border-border-subtle text-text-mid cursor-not-allowed"
    >
      <span className="inline-flex items-center gap-1.5">
        <SearchIcon size={12} />
        Search tests, runs, suites…
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Wip />
        <Kbd>⌘K</Kbd>
      </span>
    </button>
  );
}

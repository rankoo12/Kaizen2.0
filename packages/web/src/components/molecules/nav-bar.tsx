import Link from 'next/link';
import { cn } from '@/lib/cn';
import { Logo } from '@/components/atoms/logo';

type NavLink = { label: string; href: string; active?: boolean };

type NavBarProps = {
  links?: NavLink[];
  rightSlot?: React.ReactNode;
  centerSlot?: React.ReactNode;
  subtitle?: string;
  sticky?: boolean;
  bordered?: boolean;
};

export function NavBar({ links, rightSlot, centerSlot, subtitle, sticky, bordered }: NavBarProps) {
  return (
    <nav
      className={cn(
        'flex items-center justify-between px-8 py-5 z-50 bg-app-bg/80 backdrop-blur-sm',
        sticky && 'sticky top-0',
        bordered && 'border-b border-border-subtle',
      )}
    >
      <div className="flex items-center space-x-8">
        <Logo size="md" />
        {subtitle && (
          <>
            <div className="h-6 w-px bg-border-subtle" />
            <span className="text-xs font-bold tracking-[0.15em] text-gray-500 uppercase hidden md:block">
              {subtitle}
            </span>
          </>
        )}
        {links && links.length > 0 && (
          <div className="hidden md:flex space-x-6 text-sm font-medium">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'relative pb-1 transition-colors',
                  link.active ? 'text-white' : 'text-gray-400 hover:text-white',
                )}
              >
                {link.label}
                {link.active && (
                  <span className="absolute left-0 bottom-0 w-full h-[2px] bg-brand-orange" />
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
      {centerSlot && (
        <div className="flex items-center space-x-3 flex-1 max-w-2xl px-8">{centerSlot}</div>
      )}
      {rightSlot && (
        <div className="flex items-center space-x-5 text-gray-400">{rightSlot}</div>
      )}
    </nav>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { Palette, Check } from 'lucide-react';
import { useTheme } from '@/context/theme-context';
import { THEMES, THEME_LABELS, type Theme } from '@/lib/theme';
import { cn } from '@/lib/cn';

const THEME_SWATCHES: Record<Theme, { from: string; to: string }> = {
  'nebula':      { from: '#d5601c', to: '#db87af' },
  'deep-space':  { from: '#38bdf8', to: '#818cf8' },
  'solar-flare': { from: '#f59e0b', to: '#ef4444' },
};

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Switch theme"
        className="w-8 h-8 rounded-full bg-card-bg border border-border-subtle flex items-center justify-center cursor-pointer transition-all duration-300 ease-out hover:border-brand-accent/40 active:scale-95"
      >
        <Palette className="w-4 h-4 text-white/70" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-12 right-0 w-52 bg-card-bg/90 backdrop-blur-md border border-border-subtle rounded-xl shadow-2xl py-2 z-50 origin-top-right"
        >
          <p className="px-4 py-2 text-[10px] uppercase tracking-wider text-white/40 font-space">
            Theme
          </p>
          {THEMES.map((name) => {
            const swatch = THEME_SWATCHES[name];
            const active = theme === name;
            return (
              <button
                key={name}
                role="menuitemradio"
                aria-checked={active}
                type="button"
                onClick={() => { setTheme(name); setOpen(false); }}
                className={cn(
                  'flex items-center gap-3 w-full px-4 py-2.5 text-sm transition-colors duration-300',
                  active ? 'text-white' : 'text-white/70 hover:text-white hover:bg-white/5',
                )}
              >
                <span
                  className="w-4 h-4 rounded-full border border-white/10"
                  style={{
                    backgroundImage: `linear-gradient(135deg, ${swatch.from}, ${swatch.to})`,
                  }}
                />
                <span className="flex-1 text-left">{THEME_LABELS[name]}</span>
                {active && <Check className="w-4 h-4 text-brand-accent" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

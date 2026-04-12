'use client';

import { useState, useEffect, useRef } from 'react';
import { User, Settings, LogOut } from 'lucide-react';

type ProfileDropdownProps = {
  onSettings?: () => void;
  onLogout?: () => void;
};

export function ProfileDropdown({ onSettings, onLogout }: ProfileDropdownProps) {
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
        className="w-8 h-8 rounded-full bg-gradient-to-tr from-brand-pink to-brand-orange p-[1px] cursor-pointer hover:scale-105 hover:shadow-[0_0_10px_rgba(219,135,175,0.4)] transition-all"
        aria-label="Profile menu"
      >
        <div className="w-full h-full bg-card-bg rounded-full flex items-center justify-center">
          <User className="w-4 h-4 text-white/80" />
        </div>
      </button>

      {open && (
        <div className="absolute top-12 right-0 w-48 bg-card-bg border border-border-subtle rounded-xl shadow-2xl py-2 z-50 origin-top-right">
          <button
            type="button"
            onClick={onSettings}
            className="flex items-center space-x-2 w-full px-4 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
          >
            <Settings className="w-4 h-4" />
            <span>Settings</span>
          </button>
          <hr className="border-border-subtle my-1" />
          <button
            type="button"
            onClick={onLogout}
            className="flex items-center space-x-2 w-full px-4 py-2.5 text-sm text-brand-red/80 hover:text-brand-red hover:bg-brand-red/10 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            <span>Logout</span>
          </button>
        </div>
      )}
    </div>
  );
}

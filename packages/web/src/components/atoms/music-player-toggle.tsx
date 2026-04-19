'use client';

import { Music } from 'lucide-react';

export function MusicPlayerToggle() {
  function reveal() {
    window.dispatchEvent(new CustomEvent('kaizen:music-player:reveal'));
  }

  return (
    <button
      type="button"
      onClick={reveal}
      aria-label="Open ambient music player"
      className="w-8 h-8 rounded-full bg-card-bg border border-border-subtle flex items-center justify-center cursor-pointer transition-all duration-300 ease-out hover:border-brand-accent/40 active:scale-95"
    >
      <Music className="w-4 h-4 text-white/70" />
    </button>
  );
}

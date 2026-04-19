'use client';

import { useEffect, useRef, useState } from 'react';
import { Play, Pause, X, Disc3 } from 'lucide-react';
import { cn } from '@/lib/cn';

const TRACK_SRC   = '/audio/ambient-01.mp3';
const TRACK_TITLE = 'Ambient · Deep Field';

const KEY_DISMISSED = 'kaizen:music-player:dismissed';
const KEY_PLAYING   = 'kaizen:music-player:playing';
const KEY_VOLUME    = 'kaizen:music-player:volume';

export function MusicPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(KEY_DISMISSED);
    setDismissed(stored === 'true' || stored === null);
    setMounted(true);

    function handleReveal() {
      window.localStorage.setItem(KEY_DISMISSED, 'false');
      setDismissed(false);
    }
    window.addEventListener('kaizen:music-player:reveal', handleReveal);
    return () => window.removeEventListener('kaizen:music-player:reveal', handleReveal);
  }, []);

  useEffect(() => {
    if (!audioRef.current) return;
    const stored = window.localStorage.getItem(KEY_VOLUME);
    audioRef.current.volume = stored ? Number(stored) : 0.35;
  }, [mounted]);

  if (!mounted || dismissed) return null;

  function toggle() {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
      window.localStorage.setItem(KEY_PLAYING, 'false');
    } else {
      el.play().then(() => {
        setPlaying(true);
        window.localStorage.setItem(KEY_PLAYING, 'true');
      }).catch(() => {
        setPlaying(false);
      });
    }
  }

  function close() {
    audioRef.current?.pause();
    setPlaying(false);
    setDismissed(true);
    window.localStorage.setItem(KEY_DISMISSED, 'true');
    window.localStorage.setItem(KEY_PLAYING, 'false');
  }

  return (
    <div
      className={cn(
        'fixed bottom-6 right-6 z-40 flex items-center gap-3',
        'bg-card-bg/80 backdrop-blur-md border border-border-subtle',
        'rounded-full pl-2 pr-3 py-2 shadow-[0_4px_24px_rgba(0,0,0,0.4)]',
      )}
      aria-label="Ambient music player"
    >
      <audio ref={audioRef} src={TRACK_SRC} preload="none" loop />

      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause music' : 'Play music'}
        className="w-8 h-8 rounded-full flex items-center justify-center cursor-pointer transition-all duration-300 ease-out active:scale-95 hover:bg-white/5"
      >
        {playing ? (
          <Pause className="w-4 h-4 text-brand-accent" />
        ) : (
          <Play className="w-4 h-4 text-brand-accent" />
        )}
      </button>

      <Disc3
        className={cn(
          'w-4 h-4 text-brand-accent/60 transition-transform',
          playing && 'animate-spin',
        )}
        style={playing ? { animationDuration: '3s' } : undefined}
      />

      <span className="text-[10px] uppercase tracking-wider text-white/60 font-space pr-1 hidden sm:inline">
        {TRACK_TITLE}
      </span>

      <button
        type="button"
        onClick={close}
        aria-label="Close music player"
        className="w-6 h-6 rounded-full flex items-center justify-center cursor-pointer transition-all duration-300 ease-out active:scale-95 text-white/40 hover:text-white/80 hover:bg-white/5"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

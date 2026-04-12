'use client';

import { useState, useRef, useEffect } from 'react';
import { Monitor, ChevronDown, Plus, Check, X, Loader2, Sparkles } from 'lucide-react';
import { useSuites } from '@/hooks/use-suites';
import { cn } from '@/lib/cn';
import { Input } from '@/components/atoms/input';

type SuiteSelectorProps = {
  value: string; // suiteId
  onChange?: (suiteId: string) => void;
};

export function SuiteSelector({ value, onChange }: SuiteSelectorProps) {
  const { suites, isLoading, refetch } = useSuites();
  const [open, setOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        if (!isSaving) setIsCreating(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isSaving]);

  // Focus input when creation mode starts
  useEffect(() => {
    if (isCreating) {
      inputRef.current?.focus();
    }
  }, [isCreating]);

  const selectedSuite = suites.find(s => s.id === value);

  async function handleCreate() {
    if (!newName.trim() || isSaving) return;
    setIsSaving(true);
    try {
      const res = await fetch('/api/proxy/suites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (!res.ok) throw new Error('Failed to create suite');
      const data = await res.json();
      
      // Refresh suites and select the new one
      refetch();
      onChange?.(data.suite.id);
      setIsCreating(false);
      setNewName('');
      setOpen(false);
    } catch (err) {
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  }

  if (isCreating) {
    return (
      <div className="space-y-2">
        <p className="text-[10px] font-bold tracking-widest text-gray-500 uppercase">New Suite Name</p>
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            placeholder="e.g. Production UI"
            className="w-full bg-input-bg text-sm text-white rounded-lg px-4 py-2.5 outline-none border border-brand-orange/50 transition-colors placeholder:text-gray-600"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate();
              if (e.key === 'Escape') setIsCreating(false);
            }}
            disabled={isSaving}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            <button
              onClick={handleCreate}
              disabled={isSaving}
              className="p-1 hover:bg-white/10 rounded transition-colors text-green-400 disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin text-gray-400" /> : <Check className="w-4 h-4" />}
            </button>
            <button
              onClick={() => setIsCreating(false)}
              disabled={isSaving}
              className="p-1 hover:bg-white/10 rounded transition-colors text-gray-400 disabled:opacity-50"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2" ref={ref}>
      <p className="text-[10px] font-bold tracking-widest text-gray-500 uppercase">Suite</p>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={cn(
            "w-full flex items-center justify-between bg-input-bg px-4 py-2.5 rounded-lg border transition-colors",
            open ? "border-brand-orange/50" : "border-border-subtle hover:border-gray-500"
          )}
        >
          <div className="flex items-center space-x-2">
            <Monitor className="w-4 h-4 text-gray-400" />
            <span className="text-sm font-medium text-gray-200">
              {isLoading ? 'Loading...' : (selectedSuite?.name || 'Select a suite')}
            </span>
          </div>
          <ChevronDown className={cn("w-4 h-4 text-gray-500 transition-transform", open && "rotate-180")} />
        </button>

        {open && (
          <div className="absolute top-full left-0 right-0 mt-2 bg-card-bg border border-border-subtle rounded-xl shadow-2xl py-2 z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="max-h-60 overflow-y-auto custom-scrollbar">
              {suites.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    onChange?.(s.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors",
                    s.id === value ? "bg-brand-orange/10 text-brand-orange" : "text-gray-300 hover:bg-white/5"
                  )}
                >
                  <Monitor className={cn("w-4 h-4", s.id === value ? "text-brand-orange" : "text-gray-500")} />
                  <span className="flex-1 truncate">{s.name}</span>
                  {s.id === value && <Check className="w-4 h-4" />}
                </button>
              ))}
              
              {suites.length === 0 && !isLoading && (
                <div className="px-4 py-3 text-xs text-gray-500 text-center italic">
                  No suites found
                </div>
              )}
            </div>

            <hr className="border-border-subtle my-1" />
            
            <button
              type="button"
              onClick={() => {
                setIsCreating(true);
                setOpen(false);
              }}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left text-brand-orange hover:bg-brand-orange/10 transition-colors font-medium border-t border-border-subtle/50 mt-1"
            >
              <Sparkles className="w-4 h-4" />
              <span>Create new suite...</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

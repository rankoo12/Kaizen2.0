'use client';

import { useRouter } from 'next/navigation';
import { Plus, FlaskConical } from 'lucide-react';
import { Button } from '@/components/atoms/button';

export function TestsPanel() {
  const router = useRouter();

  return (
    <div className="flex-1 flex flex-col">
      {/* ── Toolbar ── */}
      <div className="border-b border-border-subtle px-6 py-4 flex items-center justify-between gap-4">
        <p className="text-sm text-gray-400">
          No test suites yet.
        </p>
        <Button
          variant="primary-orange"
          size="sm"
          onClick={() => router.push('/tests/new')}
        >
          <Plus className="w-4 h-4 mr-1.5" />
          New Test
        </Button>
      </div>

      {/* ── Empty State ── */}
      <div className="flex-1 flex flex-col items-center justify-center gap-6 px-4 py-24 text-center">
        <div className="w-16 h-16 rounded-2xl bg-white/5 border border-border-subtle flex items-center justify-center">
          <FlaskConical className="w-8 h-8 text-gray-500" />
        </div>

        <div className="space-y-2 max-w-sm">
          <h2 className="text-lg font-semibold text-white">No tests yet</h2>
          <p className="text-sm text-gray-400 leading-relaxed">
            Create your first test to start running autonomous QA on your application.
          </p>
        </div>

        <Button
          variant="primary-orange"
          size="md"
          onClick={() => router.push('/tests/new')}
        >
          <Plus className="w-4 h-4 mr-1.5" />
          Create your first test
        </Button>
      </div>
    </div>
  );
}

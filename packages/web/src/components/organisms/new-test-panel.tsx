'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ListOrdered, Zap, Plus, Save, Play, Loader2, Globe } from 'lucide-react';
import { Label } from '@/components/atoms/label';
import { Input } from '@/components/atoms/input';
import { Textarea } from '@/components/atoms/textarea';
import { StepItem } from '@/components/molecules/step-item';
import { SuiteSelector } from '@/components/molecules/suite-selector';

type NewTestData = {
  name: string;
  baseUrl: string;
  steps: string[];
  suiteId: string;
};

type NewTestPanelProps = {
  initialSteps?: string[];
  testId?: string;
};

export function NewTestPanel({
  initialSteps = ['', '', ''],
  testId = '#1001',
}: NewTestPanelProps) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<string[]>(initialSteps);
  const [expectedResults, setExpectedResults] = useState('');
  const [suiteId, setSuiteId] = useState('');
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  function addStep() {
    setSteps((prev) => [...prev, '']);
  }

  function updateStep(index: number, value: string) {
    setSteps((prev) => prev.map((s, i) => (i === index ? value : s)));
  }

  function removeStep(index: number) {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit() {
    if (!name.trim()) return setError('Test name is required');
    if (!baseUrl.trim()) return setError('Base URL is required');
    if (!suiteId) return setError('Please select a suite');
    const activeSteps = steps.filter(s => s.trim() !== '');
    if (activeSteps.length === 0) return setError('At least one step is required');

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/proxy/suites/${suiteId}/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          steps: activeSteps,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create test case');
      }

      showToast('Test created successfully!');
      setTimeout(() => router.push('/tests'), 1000);
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex-1 p-4 md:p-8 max-w-[1200px] mx-auto w-full flex flex-col gap-6 md:gap-8 relative">
      {/* Toast */}
      {toast && (
        <div className="fixed top-8 left-1/2 -translate-x-1/2 bg-green-500 text-white px-6 py-3 rounded-xl shadow-2xl z-[100] animate-in fade-in slide-in-from-top-4">
          {toast}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 border-b border-border-subtle pb-6">
        <div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-2">Design Test</h1>
          <p className="text-brand-pink/80 text-lg">
            Define semantic logic, execution steps, and validation criteria.
          </p>
        </div>
      </div>

      {error && (
        <div className="bg-brand-red/10 border border-brand-red/30 text-brand-red px-4 py-3 rounded-xl text-sm font-medium">
          {error}
        </div>
      )}

      {/* Grid layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left column */}
        <div className="lg:col-span-8 space-y-6">
          {/* Test Identity */}
          <div className="bg-card-bg p-6 rounded-2xl border border-border-subtle space-y-5">
            <div className="space-y-2">
              <Label
                rightSlot={
                  <span className="text-brand-pink opacity-70 hover:opacity-100 transition-opacity cursor-pointer text-xs uppercase tracking-widest font-bold">
                    {testId}
                  </span>
                }
              >
                Test Name
              </Label>
              <Input
                type="text"
                placeholder="e.g., Validate checkout flow with empty cart"
                value={name}
                onChange={(e) => setName(e.target.value)}
                focusVariant="accent"
              />
            </div>

            <div className="space-y-2">
              <Label>Base URL</Label>
              <Input
                type="text"
                placeholder="https://app.example.com"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                leftIcon={<Globe className="w-4 h-4 text-gray-500" />}
                focusVariant="orange"
              />
              <p className="text-[10px] text-gray-500 px-1">
                The environment URL where this test should execute.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Description (Optional)</Label>
              <Textarea
                placeholder="Describe what this test is supposed to achieve..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>
          </div>

          {/* Execution Steps */}
          <div className="bg-card-bg p-6 rounded-2xl border border-border-subtle">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold tracking-widest text-brand-accent uppercase flex items-center space-x-2">
                <ListOrdered className="w-4 h-4" />
                <span>Execution Steps</span>
              </h2>
              <span className="text-xs font-semibold text-gray-400 bg-[#1e1525] px-3 py-1.5 rounded-lg border border-border-subtle">
                {steps.length} {steps.length === 1 ? 'Step' : 'Steps'}
              </span>
            </div>

            <div className="space-y-3">
              {steps.map((step, i) => (
                <StepItem
                  key={i}
                  index={i + 1}
                  value={step}
                  onChange={(val) => updateStep(i, val)}
                  onRemove={() => removeStep(i)}
                />
              ))}
            </div>

            <div className="mt-4 flex gap-3">
              <button
                type="button"
                onClick={addStep}
                className="flex-1 py-3 border border-dashed border-border-subtle text-gray-400 text-xs font-bold tracking-widest uppercase rounded-xl hover:bg-white/5 hover:text-white transition-colors flex items-center justify-center space-x-2"
              >
                <Plus className="w-4 h-4" />
                <span>Add Neural Step</span>
              </button>
            </div>
          </div>
        </div>

        {/* Right column */}
        <div className="lg:col-span-4 space-y-6">
          {/* Suite selector */}
          <div className="bg-card-bg p-5 rounded-2xl border border-border-subtle">
            <SuiteSelector value={suiteId} onChange={setSuiteId} />
          </div>

          {/* Expected Results (UI Only for now) */}
          <div className="bg-card-bg p-6 rounded-2xl border border-border-subtle flex flex-col h-full max-h-[350px]">
            <h2 className="text-sm font-bold tracking-widest text-brand-pink uppercase flex items-center space-x-2 mb-4">
              <Zap className="w-4 h-4" />
              <span>Expected Results</span>
            </h2>
            <p className="text-[11px] text-gray-500 mb-3 leading-relaxed">
              Define the criteria the engine must focus on. (Coming Soon)
            </p>
            <Textarea
              placeholder={`1. Ensure 'Login' button is visible.\n2. Verify cart counter is 0.\n3. Check for error message on invalid input...`}
              value={expectedResults}
              onChange={(e) => setExpectedResults(e.target.value)}
              codeStyle
              className="flex-1 opacity-50 cursor-not-allowed"
              disabled
            />
          </div>
        </div>
      </div>

      {/* Footer Actions */}
      <div className="mt-2 bg-card-bg p-6 lg:p-8 rounded-2xl border border-border-subtle flex shadow-2xl relative overflow-hidden group">
        <div className="absolute inset-0 bg-gradient-to-r from-brand-orange/10 to-brand-yellow/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
        <div className="flex flex-col sm:flex-row gap-4 w-full relative z-10">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="flex-1 py-5 bg-gradient-to-r from-brand-orange to-brand-yellow text-black text-base font-bold tracking-widest uppercase rounded-xl hover:opacity-90 transition-all flex items-center justify-center space-x-3 shadow-[0_0_20px_rgba(213,96,28,0.2)] hover:shadow-[0_0_30px_rgba(213,96,28,0.4)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <>
                <Save className="w-5 h-5" />
                <span>Save Test Case</span>
              </>
            )}
          </button>
          
          <button
            type="button"
            className="flex-1 py-5 border border-border-subtle bg-white/5 text-white text-base font-bold tracking-widest uppercase rounded-xl hover:bg-white/10 transition-all flex items-center justify-center space-x-3 disabled:opacity-50"
            disabled={isSubmitting}
          >
            <Play className="w-5 h-5 fill-current" />
            <span>Dry Run</span>
          </button>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { ListOrdered, Zap, Plus, Save, Play } from 'lucide-react';
import { Label } from '@/components/atoms/label';
import { Input } from '@/components/atoms/input';
import { Textarea } from '@/components/atoms/textarea';
import { StepItem } from '@/components/molecules/step-item';
import { SuiteSelector } from '@/components/molecules/suite-selector';

type NewTestData = {
  name: string;
  description: string;
  steps: string[];
  expectedResults: string;
  suite: string;
};

type NewTestPanelProps = {
  initialSteps?: string[];
  onRun?: (data: NewTestData) => void;
  onSave?: (data: NewTestData) => void;
  onBack?: () => void;
  testId?: string;
};

export function NewTestPanel({
  initialSteps = ['', '', ''],
  onRun,
  onSave,
  testId = '#1001',
}: NewTestPanelProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<string[]>(initialSteps);
  const [expectedResults, setExpectedResults] = useState('');
  const [suite, setSuite] = useState('Production UI');

  function addStep() {
    setSteps((prev) => [...prev, '']);
  }

  function updateStep(index: number, value: string) {
    setSteps((prev) => prev.map((s, i) => (i === index ? value : s)));
  }

  function removeStep(index: number) {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  }

  function collectData(): NewTestData {
    return { name, description, steps, expectedResults, suite };
  }

  return (
    <div className="flex-1 p-4 md:p-8 max-w-[1200px] mx-auto w-full flex flex-col gap-6 md:gap-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 border-b border-border-subtle pb-6">
        <div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-2">Design Test</h1>
          <p className="text-brand-pink/80 text-lg">
            Define semantic logic, execution steps, and validation criteria.
          </p>
        </div>
      </div>

      {/* Grid layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left column */}
        <div className="lg:col-span-8 space-y-6">
          {/* Test Name & Description */}
          <div className="bg-card-bg p-6 rounded-2xl border border-border-subtle space-y-5 shadow-lg">
            <div className="space-y-2">
              <Label
                rightSlot={
                  <span className="text-brand-pink opacity-70 hover:opacity-100 transition-opacity cursor-pointer">
                    {testId}
                  </span>
                }
              >
                New Test Name
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
              <Label>New Test Description</Label>
              <Textarea
                placeholder="Describe what this test is supposed to achieve..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>
          </div>

          {/* Execution Steps */}
          <div className="bg-card-bg p-6 rounded-2xl border border-border-subtle shadow-lg">
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
                className="flex-[2] py-3 border border-dashed border-border-subtle text-gray-400 text-xs font-bold tracking-widest uppercase rounded-xl hover:bg-white/5 hover:text-white transition-colors flex items-center justify-center space-x-2"
              >
                <Plus className="w-4 h-4" />
                <span>Add Neural Step</span>
              </button>
              <button
                type="button"
                onClick={() => onSave?.(collectData())}
                className="flex-1 py-3 border border-border-subtle bg-card-bg text-brand-pink/80 text-xs font-bold tracking-widest uppercase rounded-xl hover:text-brand-pink hover:bg-white/5 transition-colors flex items-center justify-center space-x-2"
              >
                <Save className="w-4 h-4" />
                <span>Save Test</span>
              </button>
            </div>
          </div>
        </div>

        {/* Right column */}
        <div className="lg:col-span-4 space-y-6">
          {/* Expected Results */}
          <div className="bg-card-bg p-6 rounded-2xl border border-border-subtle shadow-lg flex flex-col h-full max-h-[350px]">
            <h2 className="text-sm font-bold tracking-widest text-brand-pink uppercase flex items-center space-x-2 mb-4">
              <Zap className="w-4 h-4" />
              <span>Expected Results</span>
            </h2>
            <p className="text-base text-gray-400 mb-3 leading-relaxed">
              Define the expected outcomes or elements the engine must focus on during execution.
            </p>
            <Textarea
              placeholder={`1. Ensure 'Login' button is visible.\n2. Verify cart counter is 0.\n3. Check for error message on invalid input...`}
              value={expectedResults}
              onChange={(e) => setExpectedResults(e.target.value)}
              codeStyle
              className="flex-1"
            />
          </div>

          {/* Suite selector */}
          <div className="bg-card-bg p-5 rounded-2xl border border-border-subtle shadow-lg">
            <SuiteSelector value={suite} onChange={setSuite} />
          </div>
        </div>
      </div>

      {/* Run Test button */}
      <div className="mt-2 bg-card-bg p-6 lg:p-8 rounded-2xl border border-border-subtle flex shadow-2xl relative overflow-hidden group">
        <div className="absolute inset-0 bg-gradient-to-r from-brand-orange/10 to-brand-yellow/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
        <button
          type="button"
          onClick={() => onRun?.(collectData())}
          className="w-full py-5 bg-gradient-to-r from-brand-orange to-brand-yellow text-black text-base font-bold tracking-widest uppercase rounded-xl hover:opacity-90 transition-all flex items-center justify-center space-x-3 shadow-[0_0_20px_rgba(213,96,28,0.2)] hover:shadow-[0_0_30px_rgba(213,96,28,0.4)] relative z-10"
        >
          <Play className="w-5 h-5 fill-current" />
          <span>Run Test</span>
        </button>
      </div>
    </div>
  );
}

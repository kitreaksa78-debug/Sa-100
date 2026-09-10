import React from 'react';import {
  Upload,
  ScanSearch,
  Clapperboard,
  Check,
  Lock,
} from 'lucide-react';
import { UILang, UI_TEXT } from '../data/translations';

export type WorkflowStepId = 1 | 2 | 3;

export const WORKFLOW_STEPS: Array<{
  id: WorkflowStepId;
  icon: React.ComponentType<{ className?: string }>;
  titleKey: 'wfUpload' | 'wfAnalyze' | 'wfRender';
  longKey: 'wfUploadLong' | 'wfAnalyzeLong' | 'wfRenderLong';
}> = [
  { id: 1, icon: Upload, titleKey: 'wfUpload', longKey: 'wfUploadLong' },
  { id: 2, icon: ScanSearch, titleKey: 'wfAnalyze', longKey: 'wfAnalyzeLong' },
  { id: 3, icon: Clapperboard, titleKey: 'wfRender', longKey: 'wfRenderLong' },
];

interface WorkflowStepsProps {
  uiLang: UILang;
  active: WorkflowStepId;
  maxReached: WorkflowStepId;
  onSelect: (step: WorkflowStepId) => void;
}

export const WorkflowSteps: React.FC<WorkflowStepsProps> = ({
  uiLang,
  active,
  maxReached,
  onSelect,
}) => {
  const t = UI_TEXT[uiLang];

  return (
    <nav
      aria-label="AI Video Editor workflow"
      className="bg-white rounded-2xl border border-stone-200/80 shadow-sm shadow-stone-200/50 px-3 sm:px-5 py-3.5"
    >
      <ol className="flex items-stretch gap-1 sm:gap-2">
        {WORKFLOW_STEPS.map((step, idx) => {
          const Icon = step.icon;
          const isActive = active === step.id;
          const isDone = step.id < active;
          const unlocked = step.id <= maxReached;
          const clickable = unlocked && !isActive;

          return (
            <li key={step.id} className="flex items-center flex-1 min-w-0">
              <button
                id={`workflow-step-${step.id}`}
                type="button"
                disabled={!clickable}
                onClick={() => clickable && onSelect(step.id)}
                title={t[step.longKey]}
                className={`group flex flex-1 flex-col items-center gap-1.5 rounded-xl px-2 sm:px-3 py-2 transition-all text-center ${
                  isActive
                    ? 'bg-gradient-to-b from-stone-900 to-stone-800 text-white shadow-md shadow-stone-900/20'
                    : isDone
                    ? 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100 cursor-pointer border border-emerald-200/70'
                    : unlocked
                    ? 'text-stone-600 hover:bg-stone-100 cursor-pointer border border-transparent'
                    : 'text-stone-300 cursor-not-allowed border border-transparent'
                }`}
              >
                <span
                  className={`relative flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold transition-all ${
                    isActive
                      ? 'bg-white/15 ring-1 ring-white/25'
                      : isDone
                      ? 'bg-emerald-100 text-emerald-700'
                      : unlocked
                      ? 'bg-stone-100 text-stone-500 group-hover:bg-stone-200'
                      : 'bg-stone-50 text-stone-300'
                  }`}
                >
                  {isDone ? (
                    <Check className="w-4 h-4" />
                  ) : (
                    <Icon className="w-4 h-4" />
                  )}
                  {!unlocked && (
                    <Lock className="w-2.5 h-2.5 absolute -bottom-1 -right-1 text-stone-300" />
                  )}
                </span>
                <span
                  className={`hidden sm:block text-[11px] font-bold leading-tight whitespace-nowrap ${
                    isActive ? 'text-white' : ''
                  }`}
                >
                  {t[step.titleKey]}
                </span>
                <span className="sm:hidden text-[9px] font-bold whitespace-nowrap">
                  {t[step.titleKey]}
                </span>
                {isActive && (
                  <span className="hidden sm:block text-[9px] text-white/70 font-medium -mt-1">
                    {t.stepCurrent}
                  </span>
                )}
              </button>
              {idx < WORKFLOW_STEPS.length - 1 && (
                <div
                  aria-hidden
                  className={`h-px w-2 sm:w-4 shrink-0 ${
                    step.id < active ? 'bg-emerald-300' : 'bg-stone-200'
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};
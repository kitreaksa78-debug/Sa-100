import React from 'react';
import {
  Mic2,
  Music,
  Waves,
  Volume2,
  VolumeX,
  Info,
} from 'lucide-react';
import { UILang, UI_TEXT } from '../data/translations';

export type DuckDepth = 'light' | 'normal' | 'deep';

interface MixPanelProps {
  uiLang: UILang;
  voiceVolume: number; // 0..2
  bgVolume: number; // 0..1
  duckDepth: DuckDepth;
  removeVocals: boolean;
  hasDubbedAudio: boolean;
  onChangeVoiceVolume: (v: number) => void;
  onChangeBgVolume: (v: number) => void;
  onChangeDuckDepth: (d: DuckDepth) => void;
  onChangeRemoveVocals: (v: boolean) => void;
}

export const MixPanel: React.FC<MixPanelProps> = ({
  uiLang,
  voiceVolume,
  bgVolume,
  duckDepth,
  removeVocals,
  hasDubbedAudio,
  onChangeVoiceVolume,
  onChangeBgVolume,
  onChangeDuckDepth,
  onChangeRemoveVocals,
}) => {
  const t = UI_TEXT[uiLang];
  const duckOptions: Array<{ value: DuckDepth; label: string }> = [
    { value: 'light', label: t.duckLight },
    { value: 'normal', label: t.duckNormal },
    { value: 'deep', label: t.duckDeep },
  ];

  return (
    <div className="bg-white rounded-2xl border border-stone-200/80 shadow-sm shadow-stone-200/50 p-4 sm:p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-100 to-violet-100 text-indigo-600 flex items-center justify-center shrink-0">
            <Waves className="w-5 h-5" />
          </span>
          <div>
            <h3 className="text-sm font-bold text-stone-900">{t.mixTitle}</h3>
            <p className="text-[11px] text-stone-500">{t.previewHint}</p>
          </div>
        </div>
        <span className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 text-[10px] font-semibold border border-indigo-100">
          <Info className="w-3 h-3" />
          {t.mixAppliedToRender}
        </span>
      </div>

      {!hasDubbedAudio ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 leading-relaxed">
          {t.noDubbedYet}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* AI voice volume */}
          <div className="rounded-xl border border-stone-200 bg-stone-50/60 p-3.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-stone-800">
                <Mic2 className="w-3.5 h-3.5 text-indigo-600" />
                {t.voiceVolumeLbl}
              </span>
              <span className="text-xs font-mono font-semibold text-indigo-700">
                {Math.round(voiceVolume * 100)}%
              </span>
            </div>
            <input
              id="mix-voice-volume"
              type="range"
              min="0"
              max="200"
              value={Math.round(voiceVolume * 100)}
              onChange={(e) => onChangeVoiceVolume(parseInt(e.target.value, 10) / 100)}
              className="w-full accent-indigo-600"
            />
            <div className="flex justify-between text-[9px] text-stone-400 font-medium">
              <span>0%</span>
              <span>100%</span>
              <span>200%</span>
            </div>
          </div>

          {/* Background volume */}
          <div className="rounded-xl border border-stone-200 bg-stone-50/60 p-3.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-stone-800">
                <Music className="w-3.5 h-3.5 text-violet-600" />
                {t.bgVolumeLbl}
              </span>
              <span className="text-xs font-mono font-semibold text-violet-700">
                {Math.round(bgVolume * 100)}%
              </span>
            </div>
            <input
              id="mix-bg-volume"
              type="range"
              min="0"
              max="100"
              value={Math.round(bgVolume * 100)}
              onChange={(e) => onChangeBgVolume(parseInt(e.target.value, 10) / 100)}
              className="w-full accent-violet-600"
            />
            <div className="flex justify-between text-[9px] text-stone-400 font-medium">
              <span>0%</span>
              <span>100%</span>
            </div>
          </div>
        </div>
      )}

      {/* Ducking depth */}
      <div className="rounded-xl border border-stone-200 bg-stone-50/60 p-3.5 space-y-2.5">
        <div className="flex items-center gap-1.5 text-xs font-bold text-stone-800">
          <Volume2 className="w-3.5 h-3.5 text-emerald-600" />
          {t.duckingLbl}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {duckOptions.map((opt) => (
            <button
              key={opt.value}
              id={`duck-depth-${opt.value}`}
              type="button"
              onClick={() => onChangeDuckDepth(opt.value)}
              className={`px-2 py-2 rounded-lg text-xs font-semibold border transition-all ${
                duckDepth === opt.value
                  ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                  : 'bg-white text-stone-600 border-stone-200 hover:border-emerald-300 hover:text-emerald-700'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-stone-400 leading-relaxed">
          {duckDepth === 'light' && 'Music dips gently under the AI voice.'}
          {duckDepth === 'normal' && 'Standard auto-ducking — balanced and natural.'}
          {duckDepth === 'deep' && 'Music ducks hard so the AI voice is always clear.'}
        </p>
      </div>

      {/* Remove original voice toggle */}
      <label
        id="mix-remove-vocals"
        className="flex items-center gap-3 rounded-xl border border-stone-200 bg-stone-50/60 px-3.5 py-3 cursor-pointer select-none"
        title={t.keepMusicToggleHint}
      >
        <input
          type="checkbox"
          checked={removeVocals}
          onChange={(e) => onChangeRemoveVocals(e.target.checked)}
          className="w-4 h-4 accent-indigo-600 cursor-pointer shrink-0"
        />
        <span className="text-xs font-semibold text-stone-700 leading-snug">
          {t.keepMusicToggle}
        </span>
        <span className="ml-auto hidden sm:inline text-[10px] text-stone-400 font-medium">
          {t.keepMusicToggleHint}
        </span>
        {removeVocals ? (
          <VolumeX className="w-4 h-4 text-rose-500 shrink-0" />
        ) : (
          <Volume2 className="w-4 h-4 text-emerald-600 shrink-0" />
        )}
      </label>
    </div>
  );
};
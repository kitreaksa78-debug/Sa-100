import React, { useState } from 'react';
import {
  Copy,
  Check,
  RefreshCw,
  Layers,
  Mic,
  Music,
  Loader2,
} from 'lucide-react';
import { SubtitleSegment, TranscriptionResult } from '../types';
import { UILang, UI_TEXT } from '../data/translations';
import { LANGUAGES } from '../data/languages';

interface ExportToolbarProps {
  result: TranscriptionResult;
  onRetranslate: (targetLang: string, targetLangName: string) => void;
  isRetranslating: boolean;
  uiLang: UILang;
  mediaType?: 'video' | 'audio' | null;
  onGenerateDubbing: () => void;
  isGeneratingDubbing: boolean;
  dubbingProgress: number;
  dubbingTotal: number;
  onExportDubbed: () => void;
  isExportingDubbed: boolean;
  exportProgress: number; // 0..1
  /** Translated phase label while the server renders the MP4. */
  exportStep?: string | null;
  /** Smart export: strip original voice, keep only music + translated voice. */
  removeVocalsOnExport: boolean;
  setRemoveVocalsOnExport: (v: boolean) => void;
  /** 'edit' = show only the AI-voice tools; 'render' = full export console. */
  mode?: 'edit' | 'render';
}

export const ExportToolbar: React.FC<ExportToolbarProps> = ({
  result,
  onRetranslate,
  isRetranslating,
  uiLang,
  mediaType,
  onGenerateDubbing,
  isGeneratingDubbing,
  dubbingProgress,
  dubbingTotal,
  onExportDubbed,
  isExportingDubbed,
  exportProgress,
  exportStep,
  removeVocalsOnExport,
  setRemoveVocalsOnExport,
  mode = 'render',
}) => {
  const isEditMode = mode === 'edit';
  const t = UI_TEXT[uiLang];
  const [copied, setCopied] = useState(false);
  const [quickTargetLang, setQuickTargetLang] = useState(result.targetLanguage || 'en');

  const handleCopyText = () => {
    navigator.clipboard.writeText(result.fullTranslatedText || result.fullOriginalText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleTriggerRetranslate = () => {
    const langObj = LANGUAGES.find((l) => l.code === quickTargetLang);
    if (langObj) {
      onRetranslate(langObj.code, langObj.name);
    }
  };

  const hasDubbedAudio = result.segments.some((s) => s.dubbedAudioBase64);
  // Audio-only uploads (songs, voice notes, MP3/WAV...) export a dubbed AUDIO
  // file instead of a video, so the button label/hint must say so.
  const isAudioMode = mediaType === 'audio';
  const exportLabel = isAudioMode ? t.exportDubbedAudio : t.exportDubbedVideo;
  const exportingLabel = isAudioMode ? t.exportingDubbedAudio : t.exportingDubbed;
  const exportHint = isAudioMode ? t.exportDubbedAudioHint : t.exportDubbedHint;

  return (
    <div className="bg-white rounded-2xl border border-stone-200/80 shadow-sm shadow-stone-200/50 p-4 sm:p-5 space-y-4">
      {/* Statistics & Badges */}
      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-stone-100 text-stone-700 text-xs font-semibold">
          {t.detectedLangBadge}:{' '}
          <strong className="text-stone-900 uppercase">{result.detectedLanguage}</strong>
        </span>

        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-orange-100 text-orange-800 text-xs font-semibold">
          {t.targetLangLabel}:{' '}
          <strong className="text-orange-950">{result.targetLanguageName || result.targetLanguage}</strong>
        </span>

        {result.duration > 0 && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-stone-100 text-stone-600 text-xs font-mono">
            {t.durationBadge}: {result.duration.toFixed(1)}s
          </span>
        )}

        {result.processingTimeMs > 0 && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 text-xs font-mono border border-emerald-200">
            ⚡ {(result.processingTimeMs / 1000).toFixed(2)}s
          </span>
        )}
      </div>

      {/* Primary Actions: AI Voice + Export Video */}
      <div className={isEditMode ? 'grid grid-cols-1 gap-2' : 'grid grid-cols-1 sm:grid-cols-2 gap-2'}>
        {/* Generate AI Voice Dubbing Button */}
        <button
          id="generate-ai-dubbing-btn"
          type="button"
          onClick={onGenerateDubbing}
          disabled={isGeneratingDubbing}
          className={`inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-semibold border transition-all ${
            isGeneratingDubbing
              ? 'bg-orange-50 text-orange-700 border-orange-200 cursor-wait'
              : hasDubbedAudio
              ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
              : 'bg-gradient-to-r from-orange-600 to-amber-600 text-white border-orange-500 hover:from-orange-700 hover:to-amber-700 shadow-sm'
          }`}
        >
          {isGeneratingDubbing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : hasDubbedAudio ? (
            <Check className="w-4 h-4" />
          ) : (
            <Mic className="w-4 h-4" />
          )}
          <span>
            {isGeneratingDubbing
              ? `${t.generatingAiVoice} ${dubbingProgress}/${dubbingTotal}`
              : hasDubbedAudio
              ? t.aiVoiceReady
              : t.generateAiVoice}
          </span>
        </button>

        {/* Export Dubbed Media Button — records the media + AI voice mix in real-time */}
        {!isEditMode && (
        <button
          id="export-dubbed-video-btn"
          type="button"
          onClick={onExportDubbed}
          disabled={isExportingDubbed || !hasDubbedAudio}
          title={!hasDubbedAudio ? t.exportDubbedFailed : exportHint}
          className={`inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-semibold border transition-all ${
            isExportingDubbed
              ? 'bg-indigo-50 text-indigo-700 border-indigo-200 cursor-wait'
              : !hasDubbedAudio
              ? 'bg-stone-50 text-stone-400 border-stone-200 cursor-not-allowed'
              : 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white border-indigo-500 hover:from-indigo-700 hover:to-violet-700 shadow-sm'
          }`}
        >
          {isExportingDubbed ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : isAudioMode ? (
            <Music className="w-4 h-4" />
          ) : (
            <Layers className="w-4 h-4" />
          )}
          <span>
            {isExportingDubbed
              ? exportStep
                ? exportStep
                : `${exportingLabel} ${Math.round(exportProgress * 100)}%`
              : exportLabel}
          </span>
        </button>
        )}
      </div>

      {/* Smart mixing toggle: original voice removed, music kept */}
      {!isEditMode && (
      <label
        id="remove-vocals-toggle"
        className="flex items-center gap-2.5 rounded-xl border border-stone-200 bg-stone-50/70 px-3 py-2 cursor-pointer select-none"
        title={t.keepMusicToggleHint}
      >
        <input
          type="checkbox"
          checked={removeVocalsOnExport}
          onChange={(e) => setRemoveVocalsOnExport(e.target.checked)}
          disabled={isExportingDubbed}
          className="w-4 h-4 accent-indigo-600 cursor-pointer shrink-0"
        />
        <span className="text-xs font-semibold text-stone-700 leading-snug">
          {t.keepMusicToggle}
        </span>
        <span className="ml-auto hidden sm:inline text-[10px] text-stone-400 font-medium">
          {t.keepMusicToggleHint}
        </span>
      </label>
      )}

      {/* Progress bars while busy */}
      {(isGeneratingDubbing || isExportingDubbed) && (
        <div className="space-y-1.5">
          {isGeneratingDubbing && dubbingTotal > 0 && (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-orange-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-orange-500 rounded-full transition-all duration-300"
                  style={{ width: `${(dubbingProgress / dubbingTotal) * 100}%` }}
                />
              </div>
              <span className="text-[10px] font-mono text-orange-600">
                {Math.round((dubbingProgress / dubbingTotal) * 100)}%
              </span>
            </div>
          )}
          {isExportingDubbed && (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-indigo-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                  style={{ width: `${Math.round(exportProgress * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Export Action Buttons Row */}
      <div className="pt-3 border-t border-stone-100 flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center justify-between gap-2 sm:gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Copy Text */}
          <button
            id="export-copy-transcript-btn"
            type="button"
            onClick={handleCopyText}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold border border-stone-200 bg-stone-50 text-stone-700 hover:bg-stone-100 transition-all"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? t.copied : t.copyAll}</span>
          </button>


        </div>

        {/* Quick Re-translate Row */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-stone-500 hidden md:inline">{t.quickRetranslate}</span>
          <select
            id="quick-retranslate-select"
            value={quickTargetLang}
            onChange={(e) => setQuickTargetLang(e.target.value)}
            disabled={isRetranslating}
            className="px-2.5 py-1 text-xs font-medium rounded-lg border border-stone-300 bg-stone-50 focus:outline-none"
          >
            {LANGUAGES.map((l) => (
              <option key={`quick-${l.code}`} value={l.code}>
                {l.flag} {l.name}
              </option>
            ))}
          </select>
          <button
            id="trigger-retranslate-btn"
            type="button"
            disabled={isRetranslating}
            onClick={handleTriggerRetranslate}
            className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-semibold bg-orange-50 border border-orange-200 text-orange-700 hover:bg-orange-100 transition-all disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${isRetranslating ? 'animate-spin' : ''}`} />
            <span>{t.retranslateBtn}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
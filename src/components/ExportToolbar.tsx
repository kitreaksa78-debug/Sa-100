import React, { useState } from 'react';
import {
  Download,
  Copy,
  Check,
  FileText,
  Volume2,
  RefreshCw,
  Sparkles,
  Layers,
  Mic,
  Loader2,
} from 'lucide-react';
import { SubtitleSegment, TranscriptionResult } from '../types';
import { UILang, UI_TEXT } from '../data/translations';
import { LANGUAGES } from '../data/languages';
import { exportToSrt, exportToVtt, downloadFile, speakText, stopSpeaking } from '../utils/subtitleUtils';

interface ExportToolbarProps {
  result: TranscriptionResult;
  onRetranslate: (targetLang: string, targetLangName: string) => void;
  isRetranslating: boolean;
  uiLang: UILang;
  onGenerateDubbing: () => void;
  isGeneratingDubbing: boolean;
  dubbingProgress: number;
  dubbingTotal: number;
  onExportDubbed: () => void;
  isExportingDubbed: boolean;
  exportProgress: number; // 0..1
}

export const ExportToolbar: React.FC<ExportToolbarProps> = ({
  result,
  onRetranslate,
  isRetranslating,
  uiLang,
  onGenerateDubbing,
  isGeneratingDubbing,
  dubbingProgress,
  dubbingTotal,
  onExportDubbed,
  isExportingDubbed,
  exportProgress,
}) => {
  const t = UI_TEXT[uiLang];
  const [copied, setCopied] = useState(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [quickTargetLang, setQuickTargetLang] = useState(result.targetLanguage || 'en');

  const handleDownloadSrt = (useTranslated: boolean) => {
    const srt = exportToSrt(result.segments, useTranslated);
    const langCode = useTranslated ? result.targetLanguage : result.detectedLanguage;
    downloadFile(srt, `subtitles-${langCode}.srt`, 'text/plain');
  };

  const handleDownloadVtt = (useTranslated: boolean) => {
    const vtt = exportToVtt(result.segments, useTranslated);
    const langCode = useTranslated ? result.targetLanguage : result.detectedLanguage;
    downloadFile(vtt, `subtitles-${langCode}.vtt`, 'text/vtt');
  };

  const handleDownloadTxt = (useTranslated: boolean) => {
    const text = useTranslated ? result.fullTranslatedText : result.fullOriginalText;
    const langCode = useTranslated ? result.targetLanguage : result.detectedLanguage;
    downloadFile(text, `transcript-${langCode}.txt`, 'text/plain');
  };

  const handleCopyText = () => {
    navigator.clipboard.writeText(result.fullTranslatedText || result.fullOriginalText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleToggleSpeak = () => {
    if (isPlayingAudio) {
      stopSpeaking();
      setIsPlayingAudio(false);
    } else {
      setIsPlayingAudio(true);
      speakText(
        result.fullTranslatedText || result.fullOriginalText,
        result.targetLanguage,
        () => setIsPlayingAudio(false),
        () => setIsPlayingAudio(false)
      );
    }
  };

  const handleTriggerRetranslate = () => {
    const langObj = LANGUAGES.find((l) => l.code === quickTargetLang);
    if (langObj) {
      onRetranslate(langObj.code, langObj.name);
    }
  };

  const hasDubbedAudio = result.segments.some((s) => s.dubbedAudioBase64);

  return (
    <div className="bg-white rounded-2xl border border-stone-200/80 shadow-sm shadow-stone-200/50 p-4 sm:p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center justify-between gap-2 sm:gap-3">
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

        {/* Audio TTS and Copy Buttons */}
        <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
          {/* Generate AI Voice Dubbing Button */}
          <button
            id="generate-ai-dubbing-btn"
            type="button"
            onClick={onGenerateDubbing}
            disabled={isGeneratingDubbing}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
              isGeneratingDubbing
                ? 'bg-orange-50 text-orange-700 border-orange-200 cursor-wait'
                : hasDubbedAudio
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-gradient-to-r from-orange-600 to-amber-600 text-white border-orange-500 hover:from-orange-700 hover:to-amber-700 shadow-sm'
            }`}
          >
            {isGeneratingDubbing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : hasDubbedAudio ? (
              <Check className="w-3.5 h-3.5" />
            ) : (
              <Mic className="w-3.5 h-3.5" />
            )}
            <span>
              {isGeneratingDubbing
                ? `${t.generatingAiVoice} ${dubbingProgress}/${dubbingTotal}`
                : hasDubbedAudio
                ? t.aiVoiceReady
                : t.generateAiVoice}
            </span>
          </button>

          {/* Progress bar when generating */}
          {isGeneratingDubbing && dubbingTotal > 0 && (
            <div className="hidden sm:flex items-center gap-2">
              <div className="w-16 h-1.5 bg-orange-100 rounded-full overflow-hidden">
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

          {/* Export Dubbed Video Button — records video + AI voice mix in real-time */}
          <button
            id="export-dubbed-video-btn"
            type="button"
            onClick={onExportDubbed}
            disabled={isExportingDubbed || !hasDubbedAudio}
            title={!hasDubbedAudio ? t.exportDubbedFailed : t.exportDubbedHint}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
              isExportingDubbed
                ? 'bg-indigo-50 text-indigo-700 border-indigo-200 cursor-wait'
                : !hasDubbedAudio
                ? 'bg-stone-50 text-stone-400 border-stone-200 cursor-not-allowed'
                : 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white border-indigo-500 hover:from-indigo-700 hover:to-violet-700 shadow-sm'
            }`}
          >
            {isExportingDubbed ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Layers className="w-3.5 h-3.5" />
            )}
            <span>
              {isExportingDubbed
                ? `${t.exportingDubbed} ${Math.round(exportProgress * 100)}%`
                : t.exportDubbedVideo}
            </span>
          </button>

          {/* Export progress bar */}
          {isExportingDubbed && (
            <div className="hidden sm:flex items-center gap-2">
              <div className="w-16 h-1.5 bg-indigo-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                  style={{ width: `${Math.round(exportProgress * 100)}%` }}
                />
              </div>
            </div>
          )}

          <button
            id="export-toggle-audio-tts"
            type="button"
            onClick={handleToggleSpeak}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
              isPlayingAudio
                ? 'bg-rose-50 text-rose-700 border-rose-200'
                : 'bg-stone-50 text-stone-700 border-stone-200 hover:bg-stone-100'
            }`}
          >
            <Volume2 className="w-3.5 h-3.5" />
            <span>{isPlayingAudio ? t.stopAudio : t.listenAudio}</span>
          </button>

          <button
            id="export-copy-transcript-btn"
            type="button"
            onClick={handleCopyText}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border border-stone-200 bg-stone-50 text-stone-700 hover:bg-stone-100 transition-all"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? t.copied : t.copyAll}</span>
          </button>
        </div>
      </div>

      {/* Export Action Buttons Row */}
      <div className="pt-3 border-t border-stone-100 flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center justify-between gap-2 sm:gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Download Translated SRT */}
          <button
            id="download-srt-translated"
            type="button"
            onClick={() => handleDownloadSrt(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-gradient-to-r from-stone-800 to-stone-900 text-white hover:from-stone-700 hover:to-stone-800 shadow-sm shadow-stone-900/20 transition-all active:scale-[0.98]"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{t.exportSrt}</span>
          </button>

          {/* Download Translated VTT */}
          <button
            id="download-vtt-translated"
            type="button"
            onClick={() => handleDownloadVtt(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-stone-100 text-stone-800 hover:bg-stone-200 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{t.exportVtt}</span>
          </button>

          {/* Download Plain Text */}
          <button
            id="download-txt-translated"
            type="button"
            onClick={() => handleDownloadTxt(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-stone-600 hover:text-stone-900 hover:bg-stone-100 rounded-lg transition-colors"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>{t.exportTxt}</span>
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

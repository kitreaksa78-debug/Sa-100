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
}

export const ExportToolbar: React.FC<ExportToolbarProps> = ({
  result,
  onRetranslate,
  isRetranslating,
  uiLang,
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

  return (
    <div className="bg-white rounded-2xl border border-stone-200 shadow-xs p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Statistics & Badges */}
        <div className="flex flex-wrap items-center gap-2">
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
        <div className="flex items-center gap-2">
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
      <div className="pt-3 border-t border-stone-100 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Download Translated SRT */}
          <button
            id="download-srt-translated"
            type="button"
            onClick={() => handleDownloadSrt(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-stone-900 text-white hover:bg-stone-800 shadow-xs transition-colors"
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

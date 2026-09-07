import React from 'react';
import { ArrowRight, Sparkles, Wand2, Loader2, Globe, Cpu } from 'lucide-react';
import { UILang, UI_TEXT } from '../data/translations';
import { LANGUAGES } from '../data/languages';

interface OptionsBarProps {
  uiLang: UILang;
  sourceLang: string;
  setSourceLang: (lang: string) => void;
  targetLang: string;
  setTargetLang: (lang: string) => void;
  whisperModel: string;
  setWhisperModel: (model: string) => void;
  translationModel: string;
  setTranslationModel: (model: string) => void;
  onTranscribeAndTranslate: () => void;
  isProcessing: boolean;
  canProcess: boolean;
}

export const OptionsBar: React.FC<OptionsBarProps> = ({
  uiLang,
  sourceLang,
  setSourceLang,
  targetLang,
  setTargetLang,
  whisperModel,
  setWhisperModel,
  translationModel,
  setTranslationModel,
  onTranscribeAndTranslate,
  isProcessing,
  canProcess,
}) => {
  const t = UI_TEXT[uiLang];

  return (
    <div className="bg-white rounded-2xl border border-stone-200 shadow-xs p-4 sm:p-5 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {/* Source Audio Language */}
        <div>
          <label className="block text-xs font-semibold text-stone-700 mb-1.5 flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5 text-stone-500" />
            {t.sourceLangLabel}
          </label>
          <select
            id="source-language-select"
            value={sourceLang}
            onChange={(e) => setSourceLang(e.target.value)}
            disabled={isProcessing}
            className="w-full px-3 py-2 text-xs font-medium rounded-xl border border-stone-300 bg-stone-50/60 focus:outline-none focus:ring-2 focus:ring-orange-500"
          >
            <option value="auto">✨ {t.sourceLangAuto}</option>
            {LANGUAGES.map((lang) => (
              <option key={`src-${lang.code}`} value={lang.code}>
                {lang.flag} {lang.name} ({lang.nativeName})
              </option>
            ))}
          </select>
        </div>

        {/* Target Translation Language */}
        <div>
          <label className="block text-xs font-semibold text-stone-700 mb-1.5 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-orange-500" />
            {t.targetLangLabel}
          </label>
          <select
            id="target-language-select"
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
            disabled={isProcessing}
            className="w-full px-3 py-2 text-xs font-medium rounded-xl border border-orange-300 bg-orange-50/30 text-stone-900 focus:outline-none focus:ring-2 focus:ring-orange-500"
          >
            {LANGUAGES.map((lang) => (
              <option key={`tgt-${lang.code}`} value={lang.code}>
                {lang.flag} {lang.name} ({lang.nativeName})
              </option>
            ))}
          </select>
        </div>

        {/* Whisper Model */}
        <div>
          <label className="block text-xs font-semibold text-stone-700 mb-1.5 flex items-center gap-1.5">
            <Cpu className="w-3.5 h-3.5 text-stone-500" />
            {t.whisperModelLabel}
          </label>
          <select
            id="whisper-model-select"
            value={whisperModel}
            onChange={(e) => setWhisperModel(e.target.value)}
            disabled={isProcessing}
            className="w-full px-3 py-2 text-xs font-medium rounded-xl border border-stone-300 bg-stone-50/60 focus:outline-none focus:ring-2 focus:ring-orange-500"
          >
            <option value="whisper-large-v3">Whisper Large v3 (Best Quality)</option>
            <option value="whisper-large-v3-turbo">Whisper Large v3 Turbo (Faster)</option>
          </select>
        </div>

        {/* Translation Model */}
        <div>
          <label className="block text-xs font-semibold text-stone-700 mb-1.5 flex items-center gap-1.5">
            <Wand2 className="w-3.5 h-3.5 text-stone-500" />
            {t.translationModelLabel}
          </label>
          <select
            id="translation-model-select"
            value={translationModel}
            onChange={(e) => setTranslationModel(e.target.value)}
            disabled={isProcessing}
            className="w-full px-3 py-2 text-xs font-medium rounded-xl border border-stone-300 bg-stone-50/60 focus:outline-none focus:ring-2 focus:ring-orange-500"
          >
            <option value="openai/gpt-oss-120b">GPT OSS 120B (High Quality & Context)</option>
            <option value="openai/gpt-oss-20b">GPT OSS 20B (Ultra Fast)</option>
            <option value="llama-3.3-70b-versatile">Llama 3.3 70B (Meta Llama)</option>
            <option value="llama-3.1-8b-instant">Llama 3.1 8B (Fast)</option>
          </select>
        </div>
      </div>

      {/* Action Button */}
      <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-stone-100">
        <div className="text-xs text-stone-500 text-center sm:text-left">
          {sourceLang === 'auto' ? 'Auto-detection' : sourceLang.toUpperCase()}{' '}
          <ArrowRight className="inline w-3 h-3 mx-1 text-stone-400" />
          <span className="font-semibold text-stone-800">
            {LANGUAGES.find((l) => l.code === targetLang)?.name || targetLang} (
            {LANGUAGES.find((l) => l.code === targetLang)?.nativeName})
          </span>
        </div>

        <button
          id="transcribe-and-translate-btn"
          type="button"
          disabled={!canProcess || isProcessing}
          onClick={onTranscribeAndTranslate}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-6 py-2.5 rounded-xl text-sm font-bold bg-orange-600 hover:bg-orange-700 text-white shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer active:scale-98"
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {t.processing}
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              {t.transcribeBtn}
            </>
          )}
        </button>
      </div>
    </div>
  );
};

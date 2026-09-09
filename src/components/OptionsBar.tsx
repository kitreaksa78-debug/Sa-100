import React from 'react';
import { ArrowRight, Sparkles, Wand2, Loader2, Globe, Cpu } from 'lucide-react';
import { UILang, UI_TEXT } from '../data/translations';
import { LANGUAGES } from '../data/languages';
import { WHISPER_MODELS, TRANSLATION_MODELS, findModel } from '../data/models';
import { getUsage } from '../utils/usageTracker';

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
  userId?: string;
}

function ModelQuotaHint({
  t,
  model,
  userId,
}: {
  t: (typeof UI_TEXT)['km'];
  model?: { id: string; rpdPerKey: number; rpdThreeKeys: number };
  userId?: string;
}) {
  if (!model) return null;
  const used = getUsage(model.id, userId);
  const fmt = (template: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
      template
    );
  return (
    <p className="mt-1.5 text-[10px] leading-relaxed text-stone-400">
      {fmt(t.freeQuotaPerKey, { n: model.rpdPerKey.toLocaleString() })}
      {' · '}
      {fmt(t.freeQuotaThreeKeys, { n: model.rpdThreeKeys.toLocaleString() })}
      {' — '}
      <span className={used >= model.rpdPerKey ? 'text-rose-500 font-semibold' : 'text-emerald-600'}>
        {fmt(t.usageToday, { used: String(used), limit: model.rpdPerKey.toLocaleString() })}
      </span>
    </p>
  );
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
  userId,
}) => {
  const t = UI_TEXT[uiLang];

  return (
    <div className="bg-white rounded-2xl border border-stone-200/80 shadow-sm shadow-stone-200/50 p-4 sm:p-5 space-y-4">
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
            {WHISPER_MODELS.map((m) => (
              <option key={`whisper-${m.id}`} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <ModelQuotaHint
            t={t}
            model={findModel(WHISPER_MODELS, whisperModel)}
            userId={userId}
          />
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
            {TRANSLATION_MODELS.map((m) => (
              <option key={`trans-${m.id}`} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <ModelQuotaHint
            t={t}
            model={findModel(TRANSLATION_MODELS, translationModel)}
            userId={userId}
          />
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
          className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-6 py-2.5 rounded-xl text-sm font-bold bg-gradient-to-r from-orange-600 to-amber-500 hover:from-orange-700 hover:to-amber-600 text-white shadow-md shadow-orange-500/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer active:scale-[0.98] ring-1 ring-orange-500/20"
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

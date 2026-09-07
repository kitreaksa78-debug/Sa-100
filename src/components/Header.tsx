import React from 'react';
import { KeyRound, Sparkles, Languages, CheckCircle2, AlertCircle } from 'lucide-react';
import { UILang, UI_TEXT } from '../data/translations';

interface HeaderProps {
  uiLang: UILang;
  setUiLang: (lang: UILang) => void;
  groqConnected: boolean;
  onOpenApiKeyModal: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  uiLang,
  setUiLang,
  groqConnected,
  onOpenApiKeyModal,
}) => {
  const t = UI_TEXT[uiLang];

  return (
    <header className="border-b border-stone-200 bg-white/90 backdrop-blur-sm sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4">
        {/* Brand / Logo */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-600 text-white flex items-center justify-center shadow-sm font-bold text-xl tracking-tight">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg sm:text-xl font-bold text-stone-900 tracking-tight">
                {t.appName}
              </h1>
              <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-800">
                Groq AI
              </span>
            </div>
            <p className="text-xs text-stone-700 hidden md:block">
              {t.tagline}
            </p>
          </div>
        </div>

        {/* Right Controls */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Groq API Key Status Button */}
          <button
            id="groq-api-key-btn"
            type="button"
            onClick={onOpenApiKeyModal}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              groqConnected
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                : 'bg-amber-50 text-amber-900 border-amber-300 hover:bg-amber-100'
            }`}
            title="Configure Groq API Key"
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">
              {groqConnected ? t.groqConnected : t.groqNeedsKey}
            </span>
            {groqConnected ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            ) : (
              <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
            )}
          </button>

          {/* Language Switcher Toggle */}
          <div className="flex items-center border border-stone-200 rounded-lg p-0.5 bg-stone-50">
            <button
              id="lang-toggle-km"
              type="button"
              onClick={() => setUiLang('km')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all ${
                uiLang === 'km'
                  ? 'bg-white text-stone-900 shadow-xs font-semibold'
                  : 'text-stone-700 hover:text-stone-900'
              }`}
            >
              🇰🇭 ខ្មែរ
            </button>
            <button
              id="lang-toggle-en"
              type="button"
              onClick={() => setUiLang('en')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all ${
                uiLang === 'en'
                  ? 'bg-white text-stone-900 shadow-xs font-semibold'
                  : 'text-stone-700 hover:text-stone-900'
              }`}
            >
              🇺🇸 EN
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};

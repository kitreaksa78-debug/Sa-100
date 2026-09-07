import React from 'react';
import { Sparkles } from 'lucide-react';
import { UILang, UI_TEXT } from '../data/translations';

interface HeaderProps {
  uiLang: UILang;
  setUiLang: (lang: UILang) => void;
}

export const Header: React.FC<HeaderProps> = ({
  uiLang,
  setUiLang,
}) => {
  const t = UI_TEXT[uiLang];

  return (
    <header className="border-b border-stone-200 bg-white/90 backdrop-blur-sm sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4">
        {/* Brand / Logo */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-orange-600 text-white flex items-center justify-center shadow-sm font-bold text-xl tracking-tight shrink-0">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-sm sm:text-xl font-bold text-stone-900 tracking-tight truncate">
                {t.appName}
              </h1>
              <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-800 shrink-0">
                Groq AI
              </span>
            </div>
            <p className="text-xs text-stone-700 hidden md:block truncate">
              {t.tagline}
            </p>
          </div>
        </div>

        {/* Right Controls */}
        <div className="flex items-center gap-2 sm:gap-3">
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

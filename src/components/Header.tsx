import React from 'react';
import { Sparkles, LogOut } from 'lucide-react';
import { UILang, UI_TEXT } from '../data/translations';
import { GoogleUser } from '../utils/googleAuth';

interface HeaderProps {
  uiLang: UILang;
  setUiLang: (lang: UILang) => void;
  user?: GoogleUser | null;
  onSignOut?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  uiLang,
  setUiLang,
  user,
  onSignOut,
}) => {
  const t = UI_TEXT[uiLang];

  return (
    <header className="border-b border-stone-200/80 bg-white/95 backdrop-blur-md sticky top-0 z-30 shadow-sm shadow-stone-200/50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4">
        {/* Brand / Logo */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 via-amber-500 to-orange-600 text-white flex items-center justify-center shadow-md shadow-orange-500/25 font-bold text-xl tracking-tight shrink-0 ring-1 ring-white/20">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-sm sm:text-xl font-bold bg-gradient-to-r from-stone-900 via-stone-800 to-stone-700 bg-clip-text text-transparent tracking-tight truncate">
                {t.appName}
              </h1>
              <span className="hidden sm:inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-gradient-to-r from-orange-500 to-amber-500 text-white shadow-sm shadow-orange-500/20 shrink-0">
                Groq AI
              </span>
            </div>
            <p className="text-xs text-stone-500 hidden md:block truncate">
              {t.tagline}
            </p>
          </div>
        </div>

        {/* Right Controls */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Signed-in user chip — always visible (mobile & desktop) so the
              logged-in account is never hidden, like a profile sidebar. */}
          {user && (
            <div className="flex items-center gap-1.5 sm:gap-2 pl-1 pr-1 sm:pl-1.5 sm:pr-2 py-1 rounded-full border border-stone-200 bg-stone-50">
              {user.picture ? (
                <img
                  src={user.picture}
                  alt={user.name}
                  className="w-6 h-6 sm:w-7 sm:h-7 rounded-full object-cover ring-1 ring-orange-200 shrink-0"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-gradient-to-br from-orange-500 to-amber-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                  {(user.name || user.email || '?').charAt(0).toUpperCase()}
                </span>
              )}
              <div className="leading-tight max-w-[6.5rem] sm:max-w-[10rem] truncate">
                <div className="text-[9px] sm:text-[10px] text-stone-400 font-medium truncate">
                  {t.signedInAs}
                </div>
                <div className="text-[11px] sm:text-xs font-semibold text-stone-800 truncate">
                  {user.name || user.email}
                </div>
              </div>
              <button
                id="header-sign-out-btn"
                type="button"
                onClick={onSignOut}
                title={t.signOut}
                className="ml-0.5 inline-flex items-center gap-1 px-1.5 sm:px-2 py-1.5 rounded-full text-[11px] font-semibold text-stone-500 hover:text-rose-600 hover:bg-rose-50 transition-colors shrink-0"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t.signOut}</span>
              </button>
            </div>
          )}
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

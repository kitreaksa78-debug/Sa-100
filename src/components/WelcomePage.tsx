import React, { useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  Languages,
  Film,
  Headphones,
  Zap,
  Download,
  Mic,
  ShieldCheck,
  ChevronRight,
  X,
} from 'lucide-react';
import { UILang, UI_TEXT } from '../data/translations';
import { GOOGLE_CLIENT_ID } from '../config';
import {
  GoogleUser,
  loadGoogleScript,
  renderGoogleButton,
} from '../utils/googleAuth';

interface WelcomePageProps {
  uiLang: UILang;
  setUiLang: (lang: UILang) => void;
  onSignedIn: (user: GoogleUser) => void;
  onContinueWithoutAccount: () => void;
}

export const WelcomePage: React.FC<WelcomePageProps> = ({
  uiLang,
  setUiLang,
  onSignedIn,
  onContinueWithoutAccount,
}) => {
  const t = UI_TEXT[uiLang];
  const [isSignInOpen, setIsSignInOpen] = useState(false);
  const googleBtnRef = useRef<HTMLDivElement | null>(null);
  const [googleBtnRendered, setGoogleBtnRendered] = useState(false);

  const features = [
    { icon: Mic, title: t.wFeat1Title, desc: t.wFeat1Desc },
    { icon: Languages, title: t.wFeat2Title, desc: t.wFeat2Desc },
    { icon: Headphones, title: t.wFeat3Title, desc: t.wFeat3Desc },
    { icon: Zap, title: t.wFeat4Title, desc: t.wFeat4Desc },
    { icon: Film, title: t.wFeat5Title, desc: t.wFeat5Desc },
    { icon: Download, title: t.wFeat6Title, desc: t.wFeat6Desc },
  ];

  const steps = [
    { n: '01', title: t.wStep1Title, desc: t.wStep1Desc },
    { n: '02', title: t.wStep2Title, desc: t.wStep2Desc },
    { n: '03', title: t.wStep3EditTitle, desc: t.wStep3EditDesc },
    { n: '04', title: t.wStep4Title, desc: t.wStep4Desc },
    { n: '05', title: t.wStep5Title, desc: t.wStep5Desc },
  ];

  const openSignIn = () => {
    setIsSignInOpen(true);
    setGoogleBtnRendered(false);
  };

  const closeSignIn = () => setIsSignInOpen(false);

  // Render the official Google button once the modal is open & GIS is loaded
  useEffect(() => {
    if (!isSignInOpen || !GOOGLE_CLIENT_ID || googleBtnRendered) return;
    let cancelled = false;
    loadGoogleScript().then((loaded) => {
      if (!loaded || cancelled || !googleBtnRef.current) return;
      renderGoogleButton(googleBtnRef.current, GOOGLE_CLIENT_ID, (user) => {
        onSignedIn(user);
        closeSignIn();
      });
      setGoogleBtnRendered(true);
    });
    return () => {
      cancelled = true;
    };
  }, [isSignInOpen, googleBtnRendered, onSignedIn]);

  return (
    <div className="min-h-screen text-stone-900 flex flex-col font-sans bg-stone-50 overflow-x-hidden">
      {/* Background décor */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -top-40 -left-32 w-[36rem] h-[36rem] rounded-full bg-orange-200/40 blur-3xl" />
        <div className="absolute top-1/3 -right-40 w-[32rem] h-[32rem] rounded-full bg-amber-200/40 blur-3xl" />
        <div className="absolute bottom-0 left-1/4 w-[28rem] h-[28rem] rounded-full bg-orange-100/60 blur-3xl" />
      </div>

      {/* Nav */}
      <header className="relative z-20 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 via-amber-500 to-orange-600 text-white flex items-center justify-center shadow-md shadow-orange-500/25 shrink-0 ring-1 ring-white/20">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm sm:text-lg font-bold bg-gradient-to-r from-stone-900 to-stone-700 bg-clip-text text-transparent tracking-tight truncate">
              {t.appName}
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <div className="flex items-center border border-stone-200 rounded-lg p-0.5 bg-white/80 backdrop-blur">
            <button
              id="welcome-lang-km"
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
              id="welcome-lang-en"
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
          <button
            id="welcome-signin-nav"
            type="button"
            onClick={openSignIn}
            className="hidden sm:inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold border border-stone-200 bg-white/80 text-stone-700 hover:border-orange-300 hover:text-orange-700 transition-all backdrop-blur"
          >
            {t.signIn}
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Hero */}
      <main className="relative z-10 flex-1">
        <section className="max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-14 sm:pt-24 pb-12 text-center animate-fade-in">
          <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[11px] sm:text-xs font-bold uppercase tracking-wider bg-white/90 border border-orange-200 text-orange-700 shadow-sm">
            <ShieldCheck className="w-3.5 h-3.5" />
            {t.welcomeBadge}
          </span>

          <h2 className="mt-6 text-4xl sm:text-6xl lg:text-7xl font-extrabold leading-[1.05] tracking-tight">
            <span className="bg-gradient-to-r from-stone-900 via-stone-800 to-stone-700 bg-clip-text text-transparent">
              {t.welcomeTitle1}
            </span>
            <br />
            <span className="bg-gradient-to-r from-orange-500 via-amber-500 to-orange-600 bg-clip-text text-transparent">
              {t.welcomeTitle2}
            </span>
          </h2>

          <p className="mt-6 text-sm sm:text-lg text-stone-600 max-w-2xl mx-auto leading-relaxed">
            {t.welcomeSub}
          </p>

          {/* CTA */}
          <div className="mt-9 flex flex-col items-center gap-3">
            <button
              id="welcome-get-started-btn"
              type="button"
              onClick={openSignIn}
              className="group inline-flex items-center gap-2.5 px-8 sm:px-10 py-4 rounded-2xl text-base sm:text-lg font-bold text-white bg-gradient-to-r from-orange-500 via-amber-500 to-orange-600 shadow-lg shadow-orange-500/30 hover:shadow-xl hover:shadow-orange-500/40 hover:-translate-y-0.5 active:translate-y-0 transition-all"
            >
              {t.getStarted}
              <ChevronRight className="w-5 h-5 transition-transform group-hover:translate-x-1" />
            </button>
            <button
              id="welcome-continue-guest"
              type="button"
              onClick={onContinueWithoutAccount}
              className="text-xs sm:text-sm text-stone-500 hover:text-stone-800 font-medium underline underline-offset-4 decoration-stone-300 hover:decoration-orange-400 transition-colors"
            >
              {t.continueWithoutAccount}
            </button>
          </div>

          {/* Trust stats */}
          <div className="mt-12 grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-3xl mx-auto">
            {[
              { v: '9+', l: t.wStat1 },
              { v: '50MB', l: t.wStat2 },
              { v: '3', l: t.wStat3 },
              { v: '2', l: t.wStat4 },
            ].map((s) => (
              <div
                key={s.l}
                className="rounded-2xl border border-stone-200/80 bg-white/80 backdrop-blur px-4 py-4 shadow-xs"
              >
                <div className="text-2xl sm:text-3xl font-extrabold bg-gradient-to-r from-orange-600 to-amber-600 bg-clip-text text-transparent">
                  {s.v}
                </div>
                <div className="mt-1 text-[11px] sm:text-xs text-stone-500 font-medium leading-snug">
                  {s.l}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Features */}
        <section id="welcome-features" className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="text-center mb-10">
            <h3 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-stone-900">
              {t.wFeaturesTitle}
            </h3>
            <p className="mt-2 text-sm text-stone-500">{t.wFeaturesSub}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
            {features.map((f) => (
              <div
                key={f.title}
                className="group rounded-2xl border border-stone-200/80 bg-white/90 backdrop-blur p-5 sm:p-6 shadow-xs hover:shadow-md hover:-translate-y-0.5 transition-all"
              >
                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-orange-100 to-amber-100 text-orange-600 flex items-center justify-center mb-4 group-hover:from-orange-500 group-hover:to-amber-500 group-hover:text-white transition-colors">
                  <f.icon className="w-5 h-5" />
                </div>
                <h4 className="text-sm font-bold text-stone-900">{f.title}</h4>
                <p className="mt-1.5 text-xs text-stone-500 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section className="max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="text-center mb-10">
            <h3 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-stone-900">
              {t.wHowTitle}
            </h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 sm:gap-4">
            {steps.map((s) => (
              <div
                key={s.n}
                className="relative rounded-2xl border border-stone-200/80 bg-white/90 backdrop-blur p-4 sm:p-5 shadow-xs hover:shadow-md hover:-translate-y-0.5 transition-all"
              >
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-orange-100 to-amber-100 text-orange-600 flex items-center justify-center text-sm font-extrabold mb-3">
                  {s.n}
                </div>
                <h4 className="text-xs sm:text-sm font-bold text-stone-900 leading-snug">{s.title}</h4>
                <p className="mt-1.5 text-[11px] text-stone-500 leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>

          {/* Final CTA */}
          <div className="mt-14 rounded-3xl bg-gradient-to-r from-orange-500 via-amber-500 to-orange-600 px-6 py-10 sm:py-12 text-center shadow-xl shadow-orange-500/25">
            <h3 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
              {t.wCtaTitle}
            </h3>
            <p className="mt-2 text-sm sm:text-base text-orange-50/90">{t.wCtaSub}</p>
            <button
              id="welcome-cta-get-started"
              type="button"
              onClick={openSignIn}
              className="mt-6 inline-flex items-center gap-2 px-8 py-3.5 rounded-2xl text-base font-bold bg-white text-orange-600 shadow-lg hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0 transition-all"
            >
              {t.getStarted}
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-stone-200/80 bg-white/70 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-stone-500">
            <Sparkles className="w-4 h-4 text-orange-500" />
            <span>{t.appName}</span>
          </div>
          <p className="text-[11px] text-stone-400 font-medium">{t.welcomeTrust}</p>
        </div>
      </footer>

      {/* Sign-in modal */}
      {isSignInOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/50 backdrop-blur-sm animate-fade-in"
          role="dialog"
          aria-modal="true"
          onClick={closeSignIn}
        >
          <div
            className="w-full max-w-md rounded-3xl bg-white shadow-2xl p-6 sm:p-8 text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-orange-500 via-amber-500 to-orange-600 text-white flex items-center justify-center shadow-md shadow-orange-500/25">
                <Sparkles className="w-6 h-6" />
              </div>
              <button
                id="welcome-signin-close"
                type="button"
                onClick={closeSignIn}
                className="p-2 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <h3 className="mt-5 text-xl font-extrabold text-stone-900 tracking-tight">
              {t.signInTitle}
            </h3>
            <p className="mt-2 text-xs text-stone-500 leading-relaxed">{t.signInSub}</p>

            <div className="mt-6 flex flex-col items-center gap-3">
              {GOOGLE_CLIENT_ID ? (
                <div ref={googleBtnRef} className="min-h-[44px] flex items-center justify-center" />
              ) : (
                <div className="w-full rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 leading-relaxed">
                  {t.googleNotConfigured}
                </div>
              )}

              <button
                id="welcome-signin-guest"
                type="button"
                onClick={() => {
                  closeSignIn();
                  onContinueWithoutAccount();
                }}
                className="text-xs text-stone-500 hover:text-stone-800 font-medium underline underline-offset-4 decoration-stone-300 hover:decoration-orange-400 transition-colors"
              >
                {t.continueWithoutAccount}
              </button>
            </div>

            <div className="mt-6 pt-5 border-t border-stone-100 flex items-center justify-center gap-2 text-[11px] text-stone-400">
              <ShieldCheck className="w-3.5 h-3.5 text-orange-500" />
              {t.welcomeTrust}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
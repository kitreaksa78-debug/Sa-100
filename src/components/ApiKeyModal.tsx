import React, { useState } from 'react';
import { KeyRound, Check, AlertCircle, X, ExternalLink, ShieldCheck, RefreshCw } from 'lucide-react';
import { UILang, UI_TEXT } from '../data/translations';
import { apiUrl } from '../utils/api';

interface ApiKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  apiKey: string;
  onSaveKey: (key: string) => void;
  serverGroqConfigured: boolean;
  uiLang: UILang;
}

export const ApiKeyModal: React.FC<ApiKeyModalProps> = ({
  isOpen,
  onClose,
  apiKey,
  onSaveKey,
  serverGroqConfigured,
  uiLang,
}) => {
  const t = UI_TEXT[uiLang];
  const [inputKey, setInputKey] = useState(apiKey);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  if (!isOpen) return null;

  const handleTestKey = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(apiUrl('verify-groq-key'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: inputKey.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.valid) {
        setTestResult({
          success: true,
          message: t.keyValid,
        });
      } else {
        setTestResult({
          success: false,
          message: data.error || t.keyInvalid,
        });
      }
    } catch (err: any) {
      setTestResult({
        success: false,
        message: err.message || 'Connection error. Please try again.',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    onSaveKey(inputKey.trim());
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/60 backdrop-blur-xs">
      <div className="bg-white rounded-2xl shadow-xl border border-stone-200 w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-stone-100 flex items-center justify-between bg-stone-50/70">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-orange-100 text-orange-700">
              <KeyRound className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-stone-900">{t.groqKeySettings}</h3>
              <p className="text-xs text-stone-500">Groq Cloud Whisper & Llama</p>
            </div>
          </div>
          <button
            id="close-api-key-modal"
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-4">
          {serverGroqConfigured && (
            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs leading-relaxed">
              <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold">Default Server Key is active.</span>
                <p className="text-emerald-700 mt-0.5">
                  The application is configured with an environment key. You may optionally provide your own personal key below.
                </p>
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-stone-700 mb-1.5">
              Groq API Key
            </label>
            <input
              id="groq-api-key-input"
              type="password"
              placeholder="gsk_..."
              value={inputKey}
              onChange={(e) => {
                setInputKey(e.target.value);
                setTestResult(null);
              }}
              className="w-full px-3.5 py-2.5 text-sm rounded-xl border border-stone-300 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500 font-mono"
            />
            <p className="mt-2 text-xs text-stone-500 flex items-center justify-between">
              <span>{t.groqKeyHelp}</span>
              <a
                href="https://console.groq.com/keys"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-orange-600 hover:text-orange-700 font-medium hover:underline"
              >
                console.groq.com <ExternalLink className="w-3 h-3" />
              </a>
            </p>
          </div>

          {/* Test verification feedback */}
          {testResult && (
            <div
              className={`p-3 rounded-xl text-xs flex items-center gap-2 border ${
                testResult.success
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-rose-50 border-rose-200 text-rose-800'
              }`}
            >
              {testResult.success ? (
                <Check className="w-4 h-4 text-emerald-600 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              )}
              <span>{testResult.message}</span>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 bg-stone-50 border-t border-stone-100 flex items-center justify-between gap-3">
          <button
            id="test-groq-key-btn"
            type="button"
            onClick={handleTestKey}
            disabled={testing || (!inputKey.trim() && !serverGroqConfigured)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 disabled:opacity-50"
          >
            {testing && <RefreshCw className="w-3 h-3 animate-spin" />}
            {t.testKey}
          </button>

          <div className="flex items-center gap-2">
            <button
              id="cancel-groq-modal-btn"
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-stone-600 hover:text-stone-900"
            >
              {t.cancel}
            </button>
            <button
              id="save-groq-key-btn"
              type="button"
              onClick={handleSave}
              className="px-4 py-1.5 rounded-xl text-xs font-semibold bg-orange-600 text-white hover:bg-orange-700 shadow-sm"
            >
              {t.saveKey}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

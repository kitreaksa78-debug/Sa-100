import React, { useState, useEffect, useRef } from 'react';
import {
  AlertCircle,
  Sparkles,
  Layers,
  KeyRound,
  FileVideo,
  CheckCircle,
  HelpCircle,
  ShieldAlert,
  Film,
  Download,
} from 'lucide-react';
import { Header } from './components/Header';
import { ApiKeyModal } from './components/ApiKeyModal';
import { MediaUploader } from './components/MediaUploader';
import { OptionsBar } from './components/OptionsBar';
import { MediaPlayer, MediaPlayerHandle } from './components/MediaPlayer';
import { TranscriptView } from './components/TranscriptView';
import { ExportToolbar } from './components/ExportToolbar';
import { UILang, UI_TEXT } from './data/translations';
import { SubtitleSegment, TranscriptionResult, ServerStatus } from './types';
import { LANGUAGES, SampleMedia } from './data/languages';
import { exportToSrt, exportToVtt } from './utils/subtitleUtils';

export default function App() {
  // UI Language: Khmer by default per prompt
  const [uiLang, setUiLang] = useState<UILang>('km');
  const t = UI_TEXT[uiLang];

  // Groq API Key management
  const [groqKey, setGroqKey] = useState<string>(() => {
    return localStorage.getItem('groq_api_key') || '';
  });
  const [isApiKeyModalOpen, setIsApiKeyModalOpen] = useState(false);
  const [serverStatus, setServerStatus] = useState<ServerStatus>({
    groqConfigured: false,
    geminiConfigured: false,
  });

  // Media state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<'video' | 'audio' | null>(null);

  // Model & Language Options
  const [sourceLang, setSourceLang] = useState('auto');
  const [targetLang, setTargetLang] = useState('km'); // Khmer default
  const [whisperModel, setWhisperModel] = useState('whisper-large-v3');
  const [translationModel, setTranslationModel] = useState('openai/gpt-oss-120b');

  // Transcription & Processing State
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStep, setProcessingStep] = useState<string | null>(null);
  const [result, setResult] = useState<TranscriptionResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isRetranslating, setIsRetranslating] = useState(false);

  // Media playback tracking
  const [currentTime, setCurrentTime] = useState(0);
  const mediaPlayerRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const mediaPlayerHandleRef = useRef<MediaPlayerHandle>(null);

  // AI Voice Dubbing state
  const [isGeneratingDubbing, setIsGeneratingDubbing] = useState(false);
  const [dubbingProgress, setDubbingProgress] = useState<number>(0);
  const [dubbingTotal, setDubbingTotal] = useState<number>(0);
  const [muteOriginal, setMuteOriginal] = useState(false);

  // Export dubbed video state
  const [isExportingDubbed, setIsExportingDubbed] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  // Rendered (AI-dubbed) video ready for preview & download
  const [exportedResult, setExportedResult] = useState<{
    url: string;
    ext: string;
    size: number;
    filename: string;
  } | null>(null);

  const clearExportedResult = () => {
    setExportedResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  };

  const handleDownloadExported = () => {
    if (!exportedResult) return;
    const a = document.createElement('a');
    a.href = exportedResult.url;
    a.download = exportedResult.filename;
    a.style.display = 'none';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    // Delay removal so the browser has time to start the download
    setTimeout(() => {
      document.body.removeChild(a);
    }, 200);
  };

  // Fetch server status on mount
  useEffect(() => {
    fetch('/api/status')
      .then(async (res) => {
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) return null;
        return res.json();
      })
      .then((data) => {
        if (data) {
          setServerStatus({
            groqConfigured: !!data.groqConfigured,
            geminiConfigured: !!data.geminiConfigured,
          });
        }
      })
      .catch((err) => console.warn('Could not fetch server status:', err));
  }, []);

  const handleSaveApiKey = (newKey: string) => {
    setGroqKey(newKey);
    if (newKey) {
      localStorage.setItem('groq_api_key', newKey);
    } else {
      localStorage.removeItem('groq_api_key');
    }
  };

  const isGroqActive = Boolean(serverStatus.groqConfigured || groqKey.trim());

  // Handle selecting a pre-bundled sample media
  const handleSelectSample = (sample: SampleMedia) => {
    setSelectedFile(null);
    setMediaPreviewUrl(sample.url);
    setMediaType(sample.type);
    setCurrentTime(0);
    setErrorMessage(null);
    clearExportedResult();

    // Compute SRT and VTT for sample initial result
    const srtOriginal = exportToSrt(sample.initialResult.segments, false);
    const srtTranslated = exportToSrt(sample.initialResult.segments, true);
    const vttOriginal = exportToVtt(sample.initialResult.segments, false);
    const vttTranslated = exportToVtt(sample.initialResult.segments, true);

    setResult({
      ...sample.initialResult,
      srtOriginal,
      srtTranslated,
      vttOriginal,
      vttTranslated,
    });
  };

  // Perform AI Transcription & Translation
  const handleTranscribeAndTranslate = async () => {
    if (!selectedFile && !mediaPreviewUrl) {
      setErrorMessage(t.noMediaLoaded);
      return;
    }

    if (!isGroqActive) {
      setIsApiKeyModalOpen(true);
      return;
    }

    setErrorMessage(null);
    setIsProcessing(true);
    setProcessingStep(t.processingStep1);

    try {
      let fileToUpload: File | Blob | null = selectedFile;

      // If user selected sample media without an uploaded local File
      if (!fileToUpload && mediaPreviewUrl) {
        // If sample result is already active, we can re-translate without re-downloading media
        if (result && result.segments && result.segments.length > 0) {
          const targetObj = LANGUAGES.find((l) => l.code === targetLang);
          if (result.targetLanguage !== targetLang) {
            await handleRetranslate(targetLang, targetObj?.name || targetLang);
          } else {
            // Already translated to target language, trigger rapid re-translate to refresh
            await handleRetranslate(targetLang, targetObj?.name || targetLang);
          }
          setIsProcessing(false);
          setProcessingStep(null);
          return;
        }

        setProcessingStep(t.processingStep1);
        try {
          const response = await fetch(mediaPreviewUrl);
          if (response.ok) {
            const blob = await response.blob();
            if (blob && blob.size > 0) {
              fileToUpload = new File([blob], `media-${Date.now()}.${mediaType === 'video' ? 'mp4' : 'wav'}`, {
                type: blob.type || (mediaType === 'video' ? 'video/mp4' : 'audio/wav'),
              });
            }
          }
        } catch (fetchErr) {
          console.warn('Could not fetch sample media blob directly:', fetchErr);
        }
      }

      if (!fileToUpload) {
        throw new Error('Please upload an audio or video file from your device, or record your voice.');
      }

      const formData = new FormData();
      formData.append('file', fileToUpload);
      formData.append('whisperModel', whisperModel);
      formData.append('translationModel', translationModel);
      formData.append('sourceLanguage', sourceLang);
      formData.append('targetLanguage', targetLang);

      const targetObj = LANGUAGES.find((l) => l.code === targetLang);
      formData.append('targetLanguageName', targetObj?.name || targetLang);

      const headers: HeadersInit = {};
      if (groqKey.trim()) {
        headers['x-groq-api-key'] = groqKey.trim();
      }

      setProcessingStep(t.processingStep2);

      const res = await fetch('/api/transcribe-and-translate', {
        method: 'POST',
        headers,
        body: formData,
      });

      const contentType = res.headers.get('content-type') || '';
      let data: any = {};
      if (contentType.includes('application/json')) {
        data = await res.json();
      } else {
        const text = await res.text();
        throw new Error(
          `Backend server returned an error (Status ${res.status}): ${text ? text.slice(0, 120) : 'Non-JSON response'}`
        );
      }

      if (!res.ok) {
        if (data.code === 'MISSING_API_KEY') {
          setIsApiKeyModalOpen(true);
        }
        throw new Error(data.error || 'Transcription failed');
      }

      setResult(data);
      setCurrentTime(0);
    } catch (err: any) {
      console.error('Transcription error:', err);
      setErrorMessage(err.message || 'An error occurred during transcription.');
    } finally {
      setIsProcessing(false);
      setProcessingStep(null);
    }
  };

  // Re-translate existing transcript segments to another language
  const handleRetranslate = async (newTargetLang: string, newTargetLangName: string) => {
    if (!result || !result.segments || result.segments.length === 0) return;

    if (!isGroqActive) {
      setIsApiKeyModalOpen(true);
      return;
    }

    setIsRetranslating(true);
    setErrorMessage(null);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (groqKey.trim()) {
        headers['x-groq-api-key'] = groqKey.trim();
      }

      const res = await fetch('/api/translate-segments', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          segments: result.segments,
          sourceLanguage: result.detectedLanguage,
          targetLanguage: newTargetLang,
          targetLanguageName: newTargetLangName,
          translationModel,
        }),
      });

      const contentType = res.headers.get('content-type') || '';
      let data: any = {};
      if (contentType.includes('application/json')) {
        data = await res.json();
      } else {
        const text = await res.text();
        throw new Error(`Server returned error (${res.status}): ${text ? text.slice(0, 120) : 'Non-JSON response'}`);
      }

      if (!res.ok) {
        throw new Error(data.error || 'Failed to re-translate');
      }

      setTargetLang(newTargetLang);
      setResult((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          targetLanguage: newTargetLang,
          targetLanguageName: newTargetLangName,
          segments: data.segments,
          fullTranslatedText: data.fullTranslatedText,
          srtTranslated: data.srtTranslated,
          vttTranslated: data.vttTranslated,
        };
      });
    } catch (err: any) {
      console.error('Re-translation error:', err);
      setErrorMessage(err.message || 'Error re-translating');
    } finally {
      setIsRetranslating(false);
    }
  };

  // Seek video/audio player to given timestamp
  const handleSeek = (time: number) => {
    setCurrentTime(time);
    if (mediaPlayerRef.current) {
      mediaPlayerRef.current.currentTime = time;
      if (mediaPlayerRef.current.paused) {
        mediaPlayerRef.current.play();
      }
    }
  };

  // Generate AI Voice Dubbing for all segments
  const handleGenerateDubbing = async () => {
    if (!result || !result.segments || result.segments.length === 0) return;
    if (!isGroqActive) {
      setIsApiKeyModalOpen(true);
      return;
    }

    setIsGeneratingDubbing(true);
    setDubbingProgress(0);
    setDubbingTotal(result.segments.length);
    setErrorMessage(null);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (groqKey.trim()) {
        headers['x-groq-api-key'] = groqKey.trim();
      }

      // Process segments in batches of 5 to show progress
      const BATCH_SIZE = 5;
      const allSegments = [...result.segments];
      const dubbedSegments: SubtitleSegment[] = [];

      for (let i = 0; i < allSegments.length; i += BATCH_SIZE) {
        const batch = allSegments.slice(i, i + BATCH_SIZE);
        const res = await fetch('/api/batch-tts', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            segments: batch,
            language: result.targetLanguage,
          }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Failed to generate AI voice');
        }

        const data = await res.json();
        if (data.fallback) {
          throw new Error('No API keys available for TTS generation');
        }

        // Merge dubbed audio into segments
        batch.forEach((seg, idx) => {
          const audioData = data.audio.find((a: any) => a.id === seg.id);
          dubbedSegments.push({
            ...seg,
            dubbedAudioBase64: audioData?.audio || '',
          });
        });

        setDubbingProgress(Math.min(i + BATCH_SIZE, allSegments.length));
      }

      // Update result with dubbed audio
      setResult((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          segments: dubbedSegments,
        };
      });

      // Auto-enable AI voice dubbing and mute original
      setMuteOriginal(true);
    } catch (err: any) {
      console.error('Dubbing generation error:', err);
      setErrorMessage(err.message || 'Error generating AI voice');
    } finally {
      setIsGeneratingDubbing(false);
    }
  };

  // Export the dubbed video file (video + AI voice mix burned in)
  const handleExportDubbed = async () => {
    if (!mediaPlayerHandleRef.current || isExportingDubbed) return;
    if (!result?.segments.some((s) => s.dubbedAudioBase64)) {
      setErrorMessage(t.exportDubbedFailed);
      return;
    }

    setIsExportingDubbed(true);
    setExportProgress(0);
    setErrorMessage(null);

    try {
      const out = await mediaPlayerHandleRef.current.exportDubbed((p) => setExportProgress(p));
      if (!out) {
        throw new Error(t.exportDubbedFailed);
      }
      const url = URL.createObjectURL(out.blob);
      setExportedResult((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return {
          url,
          ext: out.ext,
          size: out.blob.size,
          filename: `dubbed-${result.targetLanguage}-${Date.now()}.${out.ext}`,
        };
      });
    } catch (err: any) {
      console.error('Export dubbed error:', err);
      setErrorMessage(err.message || t.exportDubbedFailed);
    } finally {
      setIsExportingDubbed(false);
      setExportProgress(0);
    }
  };

  // Update segments after user inline edits
  const handleUpdateSegments = (updated: SubtitleSegment[]) => {
    if (!result) return;
    const fullTrans = updated.map((s) => s.translatedText).join(' ');
    const fullOrig = updated.map((s) => s.originalText).join(' ');
    const srtTrans = exportToSrt(updated, true);
    const srtOrig = exportToSrt(updated, false);
    const vttTrans = exportToVtt(updated, true);
    const vttOrig = exportToVtt(updated, false);

    setResult({
      ...result,
      segments: updated,
      fullTranslatedText: fullTrans,
      fullOriginalText: fullOrig,
      srtTranslated: srtTrans,
      srtOriginal: srtOrig,
      vttTranslated: vttTrans,
      vttOriginal: vttOrig,
    });
  };

  return (
    <div className="min-h-screen text-stone-900 flex flex-col font-sans">
      {/* Header */}
      <Header
        uiLang={uiLang}
        setUiLang={setUiLang}
      />

      {/* Main Workspace */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-6">
        {/* No API key banner needed - keys are configured via environment */}

        {/* Error notification */}
        {errorMessage && (
          <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center justify-between gap-3 shadow-xs">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{errorMessage}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              className="text-rose-600 hover:text-rose-800 font-bold text-xs"
            >
              ✕
            </button>
          </div>
        )}

        {/* Media Input Component */}
        <MediaUploader
          uiLang={uiLang}
          selectedFile={selectedFile}
          onSelectFile={(f) => {
            setSelectedFile(f);
            setResult(null);
            setErrorMessage(null);
            clearExportedResult();
          }}
          mediaPreviewUrl={mediaPreviewUrl}
          setMediaPreviewUrl={setMediaPreviewUrl}
          mediaType={mediaType}
          setMediaType={setMediaType}
          onSelectSample={handleSelectSample}
          disabled={isProcessing}
        />

        {/* Model & Language Options Bar */}
        <OptionsBar
          uiLang={uiLang}
          sourceLang={sourceLang}
          setSourceLang={setSourceLang}
          targetLang={targetLang}
          setTargetLang={setTargetLang}
          whisperModel={whisperModel}
          setWhisperModel={setWhisperModel}
          translationModel={translationModel}
          setTranslationModel={setTranslationModel}
          onTranscribeAndTranslate={handleTranscribeAndTranslate}
          isProcessing={isProcessing}
          canProcess={Boolean(selectedFile || mediaPreviewUrl)}
        />

        {/* Processing Indicator */}
        {isProcessing && (
          <div className="p-6 rounded-2xl bg-white border border-stone-200 text-center shadow-xs space-y-3">
            <div className="w-10 h-10 mx-auto rounded-full bg-orange-100 text-orange-600 flex items-center justify-center animate-spin">
              <Sparkles className="w-5 h-5" />
            </div>
            <h3 className="text-sm font-bold text-stone-800">{t.processing}</h3>
            <p className="text-xs text-stone-500 font-medium">
              {processingStep || t.processingStep1}
            </p>
          </div>
        )}

        {/* Results Area */}
        {result && (
          <div className="space-y-6 animate-in fade-in duration-300">
            {/* Top Export & Action Toolbar */}
            <ExportToolbar
              result={result}
              onRetranslate={handleRetranslate}
              isRetranslating={isRetranslating}
              uiLang={uiLang}
              onGenerateDubbing={handleGenerateDubbing}
              isGeneratingDubbing={isGeneratingDubbing}
              dubbingProgress={dubbingProgress}
              dubbingTotal={dubbingTotal}
              onExportDubbed={handleExportDubbed}
              isExportingDubbed={isExportingDubbed}
              exportProgress={exportProgress}
            />

            {/* AI-Rendered Video Preview (watch the final dubbed video & download) */}
            {exportedResult && (
              <div className="bg-white rounded-2xl border border-indigo-200 shadow-xs p-4 sm:p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="w-8 h-8 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center shrink-0">
                      <Film className="w-4 h-4" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-xs font-bold text-stone-800">{t.renderedTitle}</h3>
                      <p className="text-[11px] text-stone-500 font-mono truncate">
                        {exportedResult.filename} · {(exportedResult.size / (1024 * 1024)).toFixed(2)} MB
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      id="download-rendered-video-btn"
                      type="button"
                      onClick={handleDownloadExported}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-gradient-to-r from-indigo-600 to-violet-600 text-white hover:from-indigo-700 hover:to-violet-700 shadow-sm transition-all"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>
                        {t.downloadRendered} ({exportedResult.ext.toUpperCase()})
                      </span>
                    </button>
                    <button
                      id="discard-rendered-video-btn"
                      type="button"
                      onClick={clearExportedResult}
                      className="inline-flex items-center px-3 py-1.5 rounded-xl text-xs font-semibold border border-stone-200 bg-stone-50 text-stone-600 hover:bg-stone-100 transition-all"
                    >
                      <span>{t.discardRendered}</span>
                    </button>
                  </div>
                </div>
                <video
                  controls
                  playsInline
                  src={exportedResult.url}
                  className="w-full max-h-[70vh] rounded-xl bg-black"
                />
                <p className="text-[11px] text-indigo-600 font-medium">✅ {t.renderedReady}</p>
              </div>
            )}

            {/* Split Screen: Media Player + Interactive Transcript View */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Media Player Column */}
              <div className="lg:col-span-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-stone-700 uppercase tracking-wider">
                    {t.videoPlayerTitle}
                  </h3>
                  <span className="text-[11px] text-stone-500 font-medium">
                    {result.segments.length} Subtitle Lines
                  </span>
                </div>

                <MediaPlayer
                  ref={mediaPlayerHandleRef}
                  mediaUrl={mediaPreviewUrl}
                  mediaType={mediaType}
                  segments={result.segments}
                  currentTime={currentTime}
                  setCurrentTime={setCurrentTime}
                  mediaPlayerRef={mediaPlayerRef}
                  targetLangCode={result.targetLanguage}
                  uiLang={uiLang}
                  muteOriginal={muteOriginal}
                  setMuteOriginal={setMuteOriginal}
                />
              </div>

              {/* Interactive Subtitle & Transcript Column */}
              <div className="lg:col-span-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-stone-700 uppercase tracking-wider">
                    {t.resultsTitle}
                  </h3>
                  <span className="text-[11px] text-stone-500 font-medium">
                    Interactive Timestamps
                  </span>
                </div>

                <TranscriptView
                  segments={result.segments}
                  onUpdateSegments={handleUpdateSegments}
                  currentTime={currentTime}
                  onSeek={handleSeek}
                  uiLang={uiLang}
                  targetLangCode={result.targetLanguage}
                />
              </div>
            </div>
          </div>
        )}
      </main>


    </div>
  );
}

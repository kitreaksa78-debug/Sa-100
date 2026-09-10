import React, { useState, useEffect, useRef } from 'react';
import {
  AlertCircle,
  Sparkles,
  KeyRound,
  FileVideo,
  CheckCircle,
  HelpCircle,
  Film,
  Download,
  ArrowRight,
  ArrowLeft,
  Wand2,
  ScanSearch,
} from 'lucide-react';
import { Header } from './components/Header';
import { WelcomePage } from './components/WelcomePage';
import { ApiKeyModal } from './components/ApiKeyModal';
import { MediaUploader } from './components/MediaUploader';
import { OptionsBar } from './components/OptionsBar';
import { MediaPlayer, MediaPlayerHandle } from './components/MediaPlayer';
import { TranscriptView } from './components/TranscriptView';
import { ExportToolbar } from './components/ExportToolbar';
import { WorkflowSteps, WorkflowStepId } from './components/WorkflowSteps';
import { UILang, UI_TEXT } from './data/translations';
import { SubtitleSegment, TranscriptionResult, ServerStatus } from './types';
import { LANGUAGES, SampleMedia } from './data/languages';
import { exportToSrt, exportToVtt } from './utils/subtitleUtils';
import { apiUrl } from './utils/api';
import { exportEditedMp4ServerSide, exportEditedMp4Shotstack } from './utils/mp4Job';
import { shrinkMediaToAudio } from './utils/mediaCompress';
import { extractVocalEmphasizedAudio } from './utils/vocalSeparation';
import { recordUsage } from './utils/usageTracker';
import {
  GoogleUser,
  clearUser,
  loadGroqKey,
  loadUser,
  saveGroqKey,
  saveUser,
} from './utils/googleAuth';

// The deployed site runs the API as a serverless function that rejects request
// bodies over ~4.5 MB (HTTP 413). Anything above this guardrail must be shrunk
// to audio in the browser before upload, or rejected with a clear message when
// in-browser compression is unavailable on the client.
const SERVERLESS_BODY_SAFE_BYTES = 4.2 * 1024 * 1024;

export default function App() {
  // UI Language: Khmer by default per prompt
  const [uiLang, setUiLang] = useState<UILang>('km');
  const t = UI_TEXT[uiLang];

  // Google sign-in state: new visitors see the welcome page first, and
  // "Get started" connects with Google before entering the workspace.
  const [user, setUser] = useState<GoogleUser | null>(() => loadUser());
  const [authSkipped, setAuthSkipped] = useState(false);

  const handleGoogleSignedIn = (u: GoogleUser) => {
    saveUser(u);
    setUser(u);
    // Load THIS account's saved API key (each account keeps its own data).
    setGroqKey(loadGroqKey(u.sub));
  };

  const resetWorkspaceState = () => {
    setSelectedFile(null);
    setMediaPreviewUrl(null);
    setMediaType(null);
    setResult(null);
    setErrorMessage(null);
    clearExportedResult();
  };

  const handleSignOut = () => {
    clearUser();
    setUser(null);
    setAuthSkipped(false);
    // Never leak the signed-out account's in-memory data to the next user.
    setGroqKey('');
    resetWorkspaceState();
  };

  // Groq API Key management — stored per account, so each Google account
  // keeps its own key (guests keep the legacy shared key).
  const [groqKey, setGroqKey] = useState<string>(() => {
    return loadGroqKey(loadUser()?.sub);
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
  // Segment-level AI voice regeneration (Edit step)
  const [isRedubbingId, setIsRedubbingId] = useState<number | null>(null);

  // Smart export: strip the original voice, keep only music + translated voice.
  const [removeVocalsOnExport, setRemoveVocalsOnExport] = useState(true);

  // AI Video Editor workflow — step state
  const [activeStep, setActiveStep] = useState<WorkflowStepId>(1);
  const [maxReached, setMaxReached] = useState<WorkflowStepId>(1);

  // Audio mix defaults (applied automatically to the server render)
  const [voiceVolume, setVoiceVolume] = useState(1.0); // 0..2
  const [bgVolume, setBgVolume] = useState(0.15); // 0..1
  const [duckDepth, setDuckDepth] = useState<'light' | 'normal' | 'deep'>('normal');

  // Render provider: 'shotstack' = Shotstack cloud (sandbox key), 'ffmpeg' = server FFmpeg.
  const [renderProvider, setRenderProvider] = useState<'ffmpeg' | 'shotstack'>('ffmpeg');

  // Server-side MP4 generation state (real FFmpeg job — no browser recording)
  const [isExportingDubbed, setIsExportingDubbed] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStep, setExportStep] = useState<string | null>(null);
  // Rendered (AI-dubbed) video ready for preview & download
  const [exportedResult, setExportedResult] = useState<{
    url: string;
    ext: string;
    size: number;
    filename: string;
    isServerMp4: boolean;
  } | null>(null);

  const clearExportedResult = () => {
    setExportedResult((prev) => {
      if (prev && !prev.isServerMp4) URL.revokeObjectURL(prev.url);
      return null;
    });
  };

  const handleDownloadExported = () => {
    if (!exportedResult) return;
    // Server-generated MP4: navigate straight to the real file URL so the
    // browser downloads the actual .mp4 produced by FFmpeg.
    const a = document.createElement('a');
    a.href = exportedResult.url;
    a.download = exportedResult.filename;
    a.style.display = 'none';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
    }, 200);
  };

  // Fetch server status on mount
  useEffect(() => {
    fetch(apiUrl('status'))
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
    saveGroqKey(user?.sub, newKey);
  };

  const isGroqActive = Boolean(serverStatus.groqConfigured || groqKey.trim());

  // --- Workflow gating ---
  const hasMedia = Boolean(selectedFile || mediaPreviewUrl);
  const hasDubbedAudio = Boolean(result && result.segments.some((s) => s.dubbedAudioBase64));

  useEffect(() => {
    if (hasMedia && maxReached < 2) setMaxReached(2);
  }, [hasMedia, maxReached]);

  useEffect(() => {
    if (result && maxReached < 2) setMaxReached(2);
  }, [result, maxReached]);

  useEffect(() => {
    if (hasDubbedAudio && maxReached < 3) setMaxReached(3);
  }, [hasDubbedAudio, maxReached]);

  // Push mix-console levels into the live player whenever they change.
  useEffect(() => {
    mediaPlayerHandleRef.current?.setMixLevels(voiceVolume, bgVolume, duckDepth);
  }, [voiceVolume, bgVolume, duckDepth]);

  const goToStep = (step: WorkflowStepId) => {
    if (step <= maxReached) setActiveStep(step);
  };

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
    // A sample already carries a complete analyzed result → jump to the analyzer.
    setActiveStep(2);
  };

  // Recompute derived transcript strings after any segment edit.
  const rebuildResult = (segments: SubtitleSegment[]) => {
    if (!result) return;
    setResult({
      ...result,
      segments,
      fullOriginalText: segments.map((s) => s.originalText).join(' '),
      fullTranslatedText: segments.map((s) => s.translatedText).join(' '),
      srtOriginal: exportToSrt(segments, false),
      srtTranslated: exportToSrt(segments, true),
      vttOriginal: exportToVtt(segments, false),
      vttTranslated: exportToVtt(segments, true),
    });
  };

  // --- Video editor segment operations (all real, all feed the render) ---

  const handleDeleteSegment = (segId: number) => {
    if (!result) return;
    rebuildResult(result.segments.filter((s) => s.id !== segId));
  };

  const handleSplitSegment = (segId: number, atTime: number) => {
    if (!result) return;
    const seg = result.segments.find((s) => s.id === segId);
    if (!seg || atTime <= seg.start + 0.3 || atTime >= seg.end - 0.3) return;
    const nextId = Math.max(0, ...result.segments.map((s) => s.id)) + 1;
    const first = { ...seg, end: atTime, dubbedAudioBase64: undefined };
    const second = { ...seg, id: nextId, start: atTime, dubbedAudioBase64: undefined };
    const updated = [...result.segments];
    updated.splice(
      updated.findIndex((s) => s.id === segId),
      1,
      first,
      second
    );
    rebuildResult(updated);
  };

  const handleUpdateSegmentTimes = (segId: number, start: number, end: number) => {
    if (!result) return;
    rebuildResult(result.segments.map((s) => (s.id === segId ? { ...s, start, end } : s)));
  };

  // Regenerate the AI voice for ONE segment (real backend TTS call).
  const handleRedubSegment = async (segId: number) => {
    if (!result || isRedubbingId !== null) return;
    if (!isGroqActive) {
      setIsApiKeyModalOpen(true);
      return;
    }
    const seg = result.segments.find((s) => s.id === segId);
    if (!seg || !seg.translatedText.trim()) return;

    setIsRedubbingId(segId);
    setErrorMessage(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (groqKey.trim()) headers['x-groq-api-key'] = groqKey.trim();
      const res = await fetch(apiUrl('batch-tts'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ segments: [seg], language: result.targetLanguage }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to generate AI voice');
      }
      const data = await res.json();
      if (data.fallback) {
        throw new Error('No API keys available for TTS generation');
      }
      const audioData = data.audio.find((a: any) => a.id === segId);
      if (!audioData?.audio) {
        throw new Error('TTS returned no audio for this segment');
      }
      rebuildResult(
        result.segments.map((s) =>
          s.id === segId ? { ...s, dubbedAudioBase64: audioData.audio } : s
        )
      );
    } catch (err: any) {
      console.error('Re-dub error:', err);
      setErrorMessage(err.message || 'Error generating AI voice');
    } finally {
      setIsRedubbingId(null);
    }
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
              // Name the sample by its REAL container so Whisper can decode it
              // (Groq uses the file extension to pick the codec — a misnamed
              // audio sample would be rejected even though the bytes are fine).
              const extFromMime = (mime: string): string => {
                if (!mime) return '';
                if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
                if (mime.includes('wav')) return 'wav';
                if (mime.includes('webm')) return 'webm';
                if (mime.includes('ogg')) return 'ogg';
                if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
                return '';
              };
              const sampleExt =
                (mediaType === 'video' ? 'mp4' : extFromMime(blob.type) || 'wav');
              fileToUpload = new File([blob], `media-${Date.now()}.${sampleExt}`, {
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

      // SMART AUDIO: before uploading, try to separate the speech/singing from
      // the music. For true-stereo sources (most songs, movies, TV) the vocal
      // track is emphasized and sent to Whisper on its own — so the transcript
      // contains the LYRICS, not the band, and background noise/effects are
      // never transcribed. Mono/dual-mono clips cannot be separated, so they
      // keep the original audio (zero regression). Runs in real time (≈ clip
      // duration), showing live progress.
      setProcessingStep(t.separatingVocals);
      const vocalTrack = await extractVocalEmphasizedAudio(fileToUpload, (fraction) => {
        const pct = Math.min(99, Math.round(fraction * 100));
        setProcessingStep(`${t.separatingVocals} (${pct}%)`);
      });
      if (vocalTrack && vocalTrack.separable && vocalTrack.blob && vocalTrack.blob.size > 2000) {
        if (vocalTrack.silent) {
          throw new Error(t.noSpeechDetected);
        }
        const baseName =
          fileToUpload instanceof File && fileToUpload.name
            ? fileToUpload.name.replace(/\.[^.]+$/, '')
            : 'media';
        const ext = /mp4|m4a|aac/i.test(vocalTrack.blob.type) ? 'm4a' : 'webm';
        fileToUpload = new File([vocalTrack.blob], `${baseName}.${ext}`, {
          type: vocalTrack.blob.type || 'audio/webm',
        });
      }

      // The hosted serverless API rejects request bodies over ~4.5 MB, so media
      // larger than a few MB is shrunk to a compact audio track (Whisper only
      // needs audio). The encoder auto-adjusts the bitrate — with a second,
      // lower-quality pass if needed — so files up to ~50 MB always fit.
      // Compression runs in real time, so a live percentage is shown.
      const MAX_RAW_UPLOAD_BYTES = 3.5 * 1024 * 1024;
      if (fileToUpload.size > MAX_RAW_UPLOAD_BYTES) {
        setProcessingStep(t.compressingMedia);
        const shrunk = await shrinkMediaToAudio(fileToUpload, (fraction) => {
          const pct = Math.min(99, Math.round(fraction * 100));
          setProcessingStep(`${t.compressingMedia} (${pct}%)`);
        });
        if (shrunk && shrunk.blob.size > 2000) {
          if (shrunk.silent) {
            throw new Error(t.noSpeechDetected);
          }
          const baseName =
            fileToUpload instanceof File && fileToUpload.name
              ? fileToUpload.name.replace(/\.[^.]+$/, '')
              : 'media';
          const ext = /mp4|m4a|aac/i.test(shrunk.blob.type) ? 'm4a' : 'webm';
          fileToUpload = new File([shrunk.blob], `${baseName}.${ext}`, {
            type: shrunk.blob.type || 'audio/webm',
          });
        }
      }

      // Never send an oversized body to the deployed serverless API — the
      // platform rejects it (413) before our backend runs. In dev/preview the
      // Express backend accepts up to 50 MB raw, so only the deployed site
      // needs this guard.
      if (import.meta.env.PROD && fileToUpload.size > SERVERLESS_BODY_SAFE_BYTES) {
        throw new Error(t.uploadTooLarge);
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

      const res = await fetch(apiUrl('transcribe-and-translate'), {
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
        if (res.status === 413) {
          throw new Error(t.uploadTooLarge);
        }
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
      // Track today's free-quota usage (per model) — separately per account.
      recordUsage(whisperModel, user?.sub);
      recordUsage(translationModel, user?.sub);
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

      const res = await fetch(apiUrl('translate-segments'), {
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
      recordUsage(translationModel, user?.sub);
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
        const res = await fetch(apiUrl('batch-tts'), {
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

  // Export the dubbed video file.
  // 1) Preferred: server-side FFmpeg job — the original video is uploaded,
  //    the translated AI voice clips are scheduled onto the timeline, mixed
  //    with the preserved background audio (mix-console levels applied) and
  //    muxed into a real H.264+AAC MP4 (video stream copied whenever
  //    possible). No browser recording.
  // 2) Fallback (serverless deploys without ffmpeg): legacy client-side
  //    MediaRecorder export, only when the server pipeline is unavailable.
  const handleExportDubbed = async () => {
    if (isExportingDubbed) return;
    if (!result?.segments.some((s) => s.translatedText?.trim())) {
      setErrorMessage(t.exportDubbedFailed);
      return;
    }

    setIsExportingDubbed(true);
    setExportProgress(0);
    setExportStep(t.mp4JobStepUploading);
    setErrorMessage(null);

    try {
      let serverResult = null;
      if (renderProvider === 'shotstack') {
        // Preferred: Shotstack cloud render (sandbox key — watermark + 10min cap).
        serverResult = await exportEditedMp4Shotstack(result, {
          selectedFile,
          mediaPreviewUrl,
          mediaType,
          targetLanguage: result.targetLanguage,
          removeVocals: removeVocalsOnExport,
          voiceGain: voiceVolume,
          bgGain: bgVolume,
          duckDepth,
          setExportStep,
          setExportProgress: (p) => setExportProgress(p),
        });
      }
      if (!serverResult) {
        // Fallback / default: server-side FFmpeg job.
        serverResult = await exportEditedMp4ServerSide(result, {
          selectedFile,
          mediaPreviewUrl,
          mediaType,
          targetLanguage: result.targetLanguage,
          removeVocals: removeVocalsOnExport,
          voiceGain: voiceVolume,
          bgGain: bgVolume,
          duckDepth,
          setExportStep,
          setExportProgress: (p) => setExportProgress(p),
        });
      }
      if (serverResult) {
        setExportedResult((prev) => {
          if (prev && !prev.isServerMp4) URL.revokeObjectURL(prev.url);
          return { ...serverResult, isServerMp4: true };
        });
        return;
      }

      // Server pipeline unavailable (no ffmpeg / non-Express deploy) — fall
      // back to the legacy in-browser recording export.
      if (!mediaPlayerHandleRef.current) {
        throw new Error(t.exportDubbedFailed);
      }
      setExportStep(null);
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
          isServerMp4: false,
        };
      });
    } catch (err: any) {
      console.error('Export dubbed error:', err);
      setErrorMessage(err.message || t.exportDubbedFailed);
    } finally {
      setIsExportingDubbed(false);
      setExportProgress(0);
      setExportStep(null);
    }
  };

  // Update segments after user inline edits
  const handleUpdateSegments = (updated: SubtitleSegment[]) => {
    rebuildResult(updated);
  };

  // Welcome page shown to signed-out visitors; "Get started" connects with Google.
  if (!user && !authSkipped) {
    return (
      <WelcomePage
        uiLang={uiLang}
        setUiLang={setUiLang}
        onSignedIn={handleGoogleSignedIn}
        onContinueWithoutAccount={() => setAuthSkipped(true)}
      />
    );
  }

  return (
    <div className="min-h-screen text-stone-900 flex flex-col font-sans">
      {/* Header */}
      <Header
        uiLang={uiLang}
        setUiLang={setUiLang}
        user={user}
        onSignOut={handleSignOut}
      />

      {/* Main Workspace */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-6">
        {/* Workflow stepper */}
        <WorkflowSteps
          uiLang={uiLang}
          active={activeStep}
          maxReached={maxReached}
          onSelect={goToStep}
        />

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

        {/* ============ STEP 1: UPLOAD ============ */}
        {activeStep === 1 && (
          <div className="space-y-4 animate-fade-in">
            <div className="flex items-center gap-2.5">
              <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 text-white flex items-center justify-center shadow-md shadow-orange-500/25 shrink-0">
                <FileVideo className="w-5 h-5" />
              </span>
              <div>
                <h2 className="text-sm font-bold text-stone-900">{t.wfUploadLong}</h2>
                <p className="text-[11px] text-stone-500">{t.dropSub}</p>
              </div>
            </div>

            <MediaUploader
              uiLang={uiLang}
              selectedFile={selectedFile}
              onSelectFile={(f) => {
                setSelectedFile(f);
                setResult(null);
                setErrorMessage(null);
                clearExportedResult();
                setActiveStep(1);
                setMaxReached(1);
              }}
              mediaPreviewUrl={mediaPreviewUrl}
              setMediaPreviewUrl={setMediaPreviewUrl}
              mediaType={mediaType}
              setMediaType={setMediaType}
              onSelectSample={handleSelectSample}
              disabled={isProcessing}
            />

            <div className="flex justify-end">
              <button
                id="step1-next-btn"
                type="button"
                disabled={!hasMedia}
                onClick={() => goToStep(2)}
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold bg-gradient-to-r from-orange-600 to-amber-500 text-white shadow-md shadow-orange-500/25 hover:from-orange-700 hover:to-amber-600 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t.wfAnalyze}
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ============ STEP 2: ANALYZE & TRANSLATE ============ */}
        {activeStep === 2 && (
          <div className="space-y-4 animate-fade-in">
            <div className="flex items-center gap-2.5">
              <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white flex items-center justify-center shadow-md shadow-amber-500/25 shrink-0">
                <ScanSearch className="w-5 h-5" />
              </span>
              <div>
                <h2 className="text-sm font-bold text-stone-900">{t.wfAnalyzeLong}</h2>
                <p className="text-[11px] text-stone-500">{t.processingStep1}</p>
              </div>
            </div>

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
              userId={user?.sub}
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

            {/* Analysis summary */}
            {result && !isProcessing && (
              <div className="bg-white rounded-2xl border border-emerald-200/80 shadow-sm shadow-emerald-100/50 p-5 space-y-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2.5">
                    <span className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                      <CheckCircle className="w-5 h-5" />
                    </span>
                    <div>
                      <h3 className="text-sm font-bold text-stone-900">{t.analyzeReadyTitle}</h3>
                      <p className="text-[11px] text-stone-500">{t.analyzeReadySub}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      id="analyze-retry-btn"
                      type="button"
                      onClick={handleTranscribeAndTranslate}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold border border-stone-200 bg-stone-50 text-stone-700 hover:bg-stone-100 transition-all"
                    >
                      <Wand2 className="w-3.5 h-3.5" />
                      {t.analyzeRetry}
                    </button>
                    <button
                      id="analyze-next-btn"
                      type="button"
                      onClick={() => goToStep(3)}
                      className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-bold bg-stone-900 text-white hover:bg-stone-800 transition-all"
                    >
                      {t.wfRender}
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Badges */}
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
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-stone-100 text-stone-600 text-xs font-mono">
                    {t.analyzeSegmentsLabel}: {result.segments.length}
                  </span>
                  {result.processingTimeMs > 0 && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 text-xs font-mono border border-emerald-200">
                      ⚡ {(result.processingTimeMs / 1000).toFixed(2)}s
                    </span>
                  )}
                  <span
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border ${
                      hasDubbedAudio
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-amber-50 text-amber-700 border-amber-200'
                    }`}
                  >
                    {t.analyzeVoiceState}: {hasDubbedAudio ? t.analyzeVoiceReady : t.analyzeVoicePending}
                  </span>
                </div>

              </div>
            )}

            {/* AI Voice + Transcript editor — merged from old Edit step */}
            {result && !isProcessing && (
              <div className="space-y-4">
                <ExportToolbar
                  result={result}
                  onRetranslate={handleRetranslate}
                  isRetranslating={isRetranslating}
                  uiLang={uiLang}
                  mediaType={mediaType}
                  onGenerateDubbing={handleGenerateDubbing}
                  isGeneratingDubbing={isGeneratingDubbing}
                  dubbingProgress={dubbingProgress}
                  dubbingTotal={dubbingTotal}
                  onExportDubbed={handleExportDubbed}
                  isExportingDubbed={isExportingDubbed}
                  exportProgress={exportProgress}
                  exportStep={exportStep}
                  removeVocalsOnExport={removeVocalsOnExport}
                  setRemoveVocalsOnExport={setRemoveVocalsOnExport}
                  mode="edit"
                />
                <TranscriptView
                  segments={result.segments}
                  onUpdateSegments={handleUpdateSegments}
                  currentTime={currentTime}
                  onSeek={handleSeek}
                  uiLang={uiLang}
                  targetLangCode={result.targetLanguage}
                  onDeleteSegment={handleDeleteSegment}
                  onSplitSegment={handleSplitSegment}
                  onUpdateSegmentTimes={handleUpdateSegmentTimes}
                  onRedubSegment={handleRedubSegment}
                  isRedubbingId={isRedubbingId}
                />
              </div>
            )}

            <div className="flex justify-between">
              <button
                type="button"
                onClick={() => goToStep(1)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-stone-600 hover:bg-stone-100 transition-all"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                {t.stepBack}
              </button>
              <button
                id="step2-next-btn"
                type="button"
                disabled={!result}
                onClick={() => goToStep(3)}
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold bg-gradient-to-r from-orange-600 to-amber-500 text-white shadow-md shadow-orange-500/25 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t.wfRender}
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}



        {/* ============ STEP 3: RENDER & DOWNLOAD ============ */}
        {activeStep === 3 && result && (
          <div className="space-y-4 animate-fade-in">
            <div className="flex items-center gap-2.5">
              <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-rose-500 to-orange-500 text-white flex items-center justify-center shadow-md shadow-rose-500/25 shrink-0">
                <Film className="w-5 h-5" />
              </span>
              <div>
                <h2 className="text-sm font-bold text-stone-900">{t.wfRenderLong}</h2>
                <p className="text-[11px] text-stone-500">{t.renderHint}</p>
              </div>
            </div>

            {/* Render provider selector */}
            <div className="bg-white rounded-2xl border border-stone-200/80 shadow-sm shadow-stone-200/50 p-4 sm:p-5">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div>
                  <h3 className="text-xs font-bold text-stone-800">{t.renderProvider}</h3>
                  <p className="text-[11px] text-stone-500 mt-0.5">{t.renderProviderHint}</p>
                </div>
                <div className="flex items-center gap-1 bg-stone-100 p-1 rounded-xl">
                  <button
                    id="render-provider-ffmpeg"
                    type="button"
                    onClick={() => setRenderProvider('ffmpeg')}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                      renderProvider === 'ffmpeg'
                        ? 'bg-white text-stone-900 shadow-xs'
                        : 'text-stone-600 hover:text-stone-900'
                    }`}
                  >
                    {t.renderFfmpeg}
                  </button>
                  <button
                    id="render-provider-shotstack"
                    type="button"
                    onClick={() => setRenderProvider('shotstack')}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                      renderProvider === 'shotstack'
                        ? 'bg-white text-stone-900 shadow-xs'
                        : 'text-stone-600 hover:text-stone-900'
                    }`}
                  >
                    {t.renderShotstack}
                  </button>
                </div>
              </div>
              {renderProvider === 'shotstack' && (
                <p className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-800 leading-relaxed">
                  ⚠️ {t.shotstackSandboxNote}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <ExportToolbar
                result={result}
                onRetranslate={handleRetranslate}
                isRetranslating={isRetranslating}
                uiLang={uiLang}
                mediaType={mediaType}
                onGenerateDubbing={handleGenerateDubbing}
                isGeneratingDubbing={isGeneratingDubbing}
                dubbingProgress={dubbingProgress}
                dubbingTotal={dubbingTotal}
                onExportDubbed={handleExportDubbed}
                isExportingDubbed={isExportingDubbed}
                exportProgress={exportProgress}
                exportStep={exportStep}
                removeVocalsOnExport={removeVocalsOnExport}
                setRemoveVocalsOnExport={setRemoveVocalsOnExport}
                mode="render"
              />

              {/* Keep the player mounted so the browser fallback exporter works */}
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
                removeVocalsOnExport={removeVocalsOnExport}
              />
            </div>            {/* AI-Rendered Media Preview (watch/listen to the final dubbed file & download) */}
            {exportedResult && (
              <div className="bg-white rounded-2xl border border-indigo-200 shadow-xs p-4 sm:p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="w-8 h-8 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center shrink-0">
                      <Film className="w-4 h-4" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-xs font-bold text-stone-800">
                        {mediaType === 'audio' ? t.renderedTitleAudio : t.renderedTitle}
                      </h3>
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
                        {mediaType === 'audio' ? t.downloadRenderedAudio : t.downloadRendered} (
                        {exportedResult.ext.toUpperCase()})
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
                {mediaType === 'audio' ? (
                  <audio
                    controls
                    src={exportedResult.url}
                    className="w-full"
                  />
                ) : (
                  <video
                    controls
                    playsInline
                    src={exportedResult.url}
                    className="w-full max-h-[70vh] rounded-xl bg-black"
                  />
                )}
                <p className="text-[11px] text-indigo-600 font-medium">
                  ✅ {mediaType === 'audio' ? t.renderedReadyAudio : t.renderedReady}
                </p>
              </div>
            )}
            <div className="mt-2 flex justify-between">
              <button
                type="button"
                onClick={() => goToStep(2)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-stone-600 hover:bg-stone-100 transition-all"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                {t.stepBack}
              </button>
              {!hasDubbedAudio && (
                <button
                  type="button"
                  onClick={() => goToStep(2)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-all"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  {t.generateAiVoice}
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              )}
              {hasDubbedAudio && (
                <button
                  type="button"
                  id="step3-primary-download-btn"
                  onClick={() => {
                    if (renderProvider === 'shotstack') {
                      void handleExportDubbed()
                      return
                    }
                    const btn = document.querySelector('#export-dubbed-video-btn') as HTMLButtonElement | null
                    if (btn) btn.click()
                  }}
                  className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-rose-600 to-orange-500 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-rose-500/20 hover:from-rose-500 hover:to-orange-400 transition-all active:scale-[0.98]"
                >
                  {t.wfRender}
                  <Download className="mr-1.5 w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* No result yet in mix/render steps — guidance card */}
        {activeStep >= 2 && !result && (
          <div className="p-8 rounded-2xl bg-white border border-stone-200 text-center shadow-xs space-y-3">
            <HelpCircle className="w-10 h-10 mx-auto text-stone-300" />
            <h3 className="text-sm font-bold text-stone-800">{t.noMediaLoaded}</h3>
            <button
              type="button"
              onClick={() => goToStep(1)}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-stone-900 text-white hover:bg-stone-800 transition-all"
            >
              {t.wfUpload}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
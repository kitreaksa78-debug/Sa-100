import { SubtitleSegment } from '../types';

export function formatTimeCode(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${ms}`;
}

export function formatClockTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function padZero(n: number, width = 2): string {
  return String(Math.floor(n)).padStart(width, '0');
}

export function exportToSrt(segments: SubtitleSegment[], useTranslation = true): string {
  return segments
    .map((seg, idx) => {
      const startSec = seg.start;
      const endSec = seg.end;

      const formatSrtStamp = (t: number) => {
        const ms = Math.floor((t % 1) * 1000);
        const total = Math.floor(t);
        const s = total % 60;
        const m = Math.floor(total / 60) % 60;
        const h = Math.floor(total / 3600);
        return `${padZero(h)}:${padZero(m)}:${padZero(s)},${padZero(ms, 3)}`;
      };

      const text = useTranslation ? seg.translatedText : seg.originalText;
      return `${idx + 1}\n${formatSrtStamp(startSec)} --> ${formatSrtStamp(endSec)}\n${text.trim()}\n`;
    })
    .join('\n');
}

export function exportToVtt(segments: SubtitleSegment[], useTranslation = true): string {
  const lines = ['WEBVTT', ''];
  segments.forEach((seg, idx) => {
    const formatVttStamp = (t: number) => {
      const ms = Math.floor((t % 1) * 1000);
      const total = Math.floor(t);
      const s = total % 60;
      const m = Math.floor(total / 60) % 60;
      const h = Math.floor(total / 3600);
      return `${padZero(h)}:${padZero(m)}:${padZero(s)}.${padZero(ms, 3)}`;
    };

    const text = useTranslation ? seg.translatedText : seg.originalText;
    lines.push(`${idx + 1}`);
    lines.push(`${formatVttStamp(seg.start)} --> ${formatVttStamp(seg.end)}`);
    lines.push(text.trim());
    lines.push('');
  });
  return lines.join('\n');
}

export function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Global audio player reference for AI Voiceover
let currentAiAudio: HTMLAudioElement | null = null;

/**
 * High-fidelity AI Voice Text-to-Speech (TTS)
 * Calls the backend AI TTS service for crystal-clear natural speech,
 * with graceful browser SpeechSynthesis fallback if offline.
 */
export async function speakText(
  text: string,
  langCode = 'km',
  onEnded?: () => void,
  onError?: () => void
): Promise<HTMLAudioElement | null> {
  stopSpeaking();

  if (!text || !text.trim()) {
    onEnded?.();
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text.trim(),
        language: langCode,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.ok && res.headers.get('content-type')?.includes('audio')) {
      const blob = await res.blob();
      if (blob.size > 100) {
        const audioUrl = URL.createObjectURL(blob);
        const audio = new Audio(audioUrl);
        currentAiAudio = audio;

        audio.onended = () => {
          URL.revokeObjectURL(audioUrl);
          if (currentAiAudio === audio) {
            currentAiAudio = null;
          }
          onEnded?.();
        };

        audio.onerror = () => {
          URL.revokeObjectURL(audioUrl);
          if (currentAiAudio === audio) {
            currentAiAudio = null;
          }
          fallbackBrowserSpeak(text, langCode, onEnded);
        };

        try {
          await audio.play();
          return audio;
        } catch {
          URL.revokeObjectURL(audioUrl);
          currentAiAudio = null;
        }
      }
    }
    // 204 or non-audio response = no AI voice available, fall through
  } catch (err) {
    console.warn('Backend AI TTS failed, trying browser voice:', err);
  }

  // Fallback to browser Web Speech API
  fallbackBrowserSpeak(text, langCode, onEnded);
  return null;
}

function fallbackBrowserSpeak(text: string, langCode: string, onEnded?: () => void) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    onEnded?.();
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  const prefix = (langCode || 'km').toLowerCase().substring(0, 2);

  // Try exact match first, then prefix match, then any available voice
  const exactVoice = voices.find((v) => v.lang.toLowerCase() === langCode.toLowerCase());
  const prefixVoice = voices.find((v) => v.lang.toLowerCase().startsWith(prefix));
  utterance.voice = exactVoice || prefixVoice || voices[0];

  utterance.rate = 0.9;
  utterance.pitch = 1.0;
  utterance.onend = () => onEnded?.();
  utterance.onerror = () => onEnded?.();

  // Chrome bug: resume before speaking
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
  window.speechSynthesis.resume();
}

export function stopSpeaking() {
  if (currentAiAudio) {
    currentAiAudio.pause();
    currentAiAudio.currentTime = 0;
    currentAiAudio = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

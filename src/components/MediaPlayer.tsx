import React, { useRef, useState, useEffect, useImperativeHandle } from 'react';
import { apiUrl } from '../utils/api';
import {
  Play,
  Pause,
  Maximize,
  RotateCcw,
  Subtitles,
  Music,
  Radio,
} from 'lucide-react';
import { SubtitleSegment } from '../types';
import { formatClockTime, speakText, stopSpeaking } from '../utils/subtitleUtils';
import { buildExportPath, setVocalRemoval, type ExportPath } from '../utils/audioEngine';
import { isSeparableBuffer } from '../utils/vocalSeparation';

import { UILang, UI_TEXT } from '../data/translations';

export type DuckDepth = 'light' | 'normal' | 'deep';

export interface MediaPlayerHandle {
  exportDubbed: (onProgress?: (p: number) => void) => Promise<{ blob: Blob; ext: string } | null>;
  /** Live mix console: set AI voice gain, background gain and ducking depth. */
  setMixLevels: (voice: number, bg: number, depth: DuckDepth) => void;
}

// Music level while the translated AI voice speaks, relative to the
// background-music slider. The live preview and the exported file share this
// exact value so the download sounds like what the user heard while playing.
const MUSIC_DUCK = 0.45;
// Ducking depth presets (light / normal / deep) — how far the background dips
// under the AI voice. Kept in sync with the server FFmpeg ducking profiles.
const DUCK_FACTORS: Record<DuckDepth, number> = {
  light: 0.65,
  normal: MUSIC_DUCK,
  deep: 0.25,
};

// --- Canvas helpers: burn CC subtitles into the exported video frame ---

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const lines: string[] = [];
  // Shorten an over-long chunk (Khmer text often has no spaces) by hard-cutting
  const pushLong = (chunk: string): string => {
    let rest = chunk;
    while (ctx.measureText(rest).width > maxWidth && rest.length > 1) {
      let cut = rest.length;
      while (cut > 1 && ctx.measureText(rest.slice(0, cut)).width > maxWidth) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    return rest;
  };
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = pushLong(word);
    } else {
      line = test;
      if (ctx.measureText(line).width > maxWidth) {
        line = pushLong(line);
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

const SUBTITLE_FONT_STACK =
  "'Noto Sans Khmer', 'Khmer OS Battambang', 'Hanuman', 'Kantumruy Pro', Arial, sans-serif";

function drawSubtitleOnCanvas(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  seg: SubtitleSegment,
  opts: {
    mode: 'translated' | 'both' | 'original';
    scale: number;
    pos: { x: number; y: number };
    opacity: number;
  }
) {
  const { mode, scale, pos, opacity } = opts;
  if (scale <= 0 || opacity <= 0) return;
  const W = canvas.width;
  const H = canvas.height;
  if (!seg.translatedText && !seg.originalText) return;

  const maxTextW = W * 0.84;
  const showOriginal = mode === 'both' || mode === 'original';
  const showTranslated = mode === 'both' || mode === 'translated';

  const origSize = H * (mode === 'both' ? 0.03 : 0.042) * scale;
  const transSize = H * (mode === 'both' ? 0.036 : 0.05) * scale;
  const fontFor = (size: number, bold: boolean) =>
    `${bold ? 'bold ' : ''}${size}px ${SUBTITLE_FONT_STACK}`;

  type Line = { text: string; size: number; bold: boolean; color: string };
  const lines: Line[] = [];
  if (showOriginal && seg.originalText) {
    ctx.font = fontFor(origSize, false);
    const color = mode === 'both' ? '#a8a29e' : '#d6d3d1';
    for (const ln of wrapCanvasText(ctx, seg.originalText, maxTextW)) {
      lines.push({ text: ln, size: origSize, bold: false, color });
    }
  }
  if (showTranslated && seg.translatedText) {
    ctx.font = fontFor(transSize, true);
    for (const ln of wrapCanvasText(ctx, seg.translatedText, maxTextW)) {
      lines.push({ text: ln, size: transSize, bold: true, color: '#ffffff' });
    }
  }
  if (lines.length === 0) return;

  const lineH = (size: number) => size * 1.5;
  const gap = mode === 'both' ? H * 0.008 : 0;
  const blockH = lines.reduce((acc, l) => acc + lineH(l.size), 0) + gap * (lines.length - 1);
  const padX = W * 0.028;
  const padY = H * 0.016;
  const boxW = Math.min(maxTextW + padX * 2, W * 0.92);
  const boxH = blockH + padY * 2;
  const cx = (pos.x / 100) * W;
  const cy = (pos.y / 100) * H;

  ctx.save();
  ctx.globalAlpha = Math.min(Math.max(opacity / 100, 0), 1);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Background box (matches the on-screen overlay look)
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  roundRectPath(ctx, cx - boxW / 2, cy - boxH / 2, boxW, boxH, Math.min(H * 0.018, boxH / 4));
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = Math.max(1, H * 0.0015);
  ctx.stroke();

  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = H * 0.006;

  let y = cy - blockH / 2;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    ctx.font = fontFor(l.size, l.bold);
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, cx, y + lineH(l.size) / 2);
    y += lineH(l.size) + (i < lines.length - 1 ? gap : 0);
  }
  ctx.restore();
}

interface MediaPlayerProps {
  mediaUrl: string | null;
  mediaType: 'video' | 'audio' | null;
  segments: SubtitleSegment[];
  currentTime: number;
  setCurrentTime: (time: number) => void;
  mediaPlayerRef: React.RefObject<HTMLVideoElement | HTMLAudioElement | null>;
  targetLangCode?: string;
  uiLang?: UILang;
  muteOriginal?: boolean;
  setMuteOriginal?: (mute: boolean) => void;
  /** When true, exports strip the original voice and keep only music + AI voice. */
  removeVocalsOnExport?: boolean;
}

export const MediaPlayer = React.forwardRef<MediaPlayerHandle, MediaPlayerProps>(function MediaPlayer({
  mediaUrl,
  mediaType,
  segments,
  currentTime,
  setCurrentTime,
  mediaPlayerRef,
  targetLangCode = 'km',
  uiLang = 'km',
  muteOriginal = false,
  setMuteOriginal,
  removeVocalsOnExport = true,
}, ref) {
  const t = UI_TEXT[uiLang];
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [subtitleMode, setSubtitleMode] = useState<'translated' | 'both' | 'original'>('translated');
  // Subtitle text size scale (0x – 2.5x), persisted across sessions
  const [subtitleScale, setSubtitleScale] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('subtitleScale');
      const n = saved ? parseFloat(saved) : NaN;
      return Number.isFinite(n) ? Math.min(Math.max(n, 0), 2.5) : 1;
    } catch {
      return 1;
    }
  });

  // CapCut-style instant preview: keep the last subtitle visible for a moment
  // while adjusting size/opacity, so every change is seen on the video immediately
  const [subtitlePreviewHold, setSubtitlePreviewHold] = useState(false);
  const previewHoldTimerRef = useRef<number | null>(null);
  const holdIntervalRef = useRef<number | null>(null);
  const lastSegmentRef = useRef<SubtitleSegment | null>(null);

  const holdSubtitlePreview = () => {
    setSubtitlePreviewHold(true);
    if (previewHoldTimerRef.current) window.clearTimeout(previewHoldTimerRef.current);
    previewHoldTimerRef.current = window.setTimeout(() => setSubtitlePreviewHold(false), 2500);
  };

  useEffect(
    () => () => {
      if (previewHoldTimerRef.current) window.clearTimeout(previewHoldTimerRef.current);
      if (holdIntervalRef.current) window.clearInterval(holdIntervalRef.current);
    },
    []
  );

  // Press-and-hold A− / A+ to resize continuously (CapCut-style)
  const startSizeHold = (delta: number) => {
    endSizeHold();
    changeSubtitleScale(delta);
    holdIntervalRef.current = window.setInterval(() => changeSubtitleScale(delta), 140);
  };
  const endSizeHold = () => {
    if (holdIntervalRef.current) {
      window.clearInterval(holdIntervalRef.current);
      holdIntervalRef.current = null;
    }
  };

  const changeSubtitleScale = (delta: number) => {
    setSubtitleScale((prev) => {
      const next = Math.min(Math.max(Math.round((prev + delta) * 10) / 10, 0), 2.5);
      try {
        localStorage.setItem('subtitleScale', String(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
    holdSubtitlePreview();
  };

  const resetSubtitleScale = () => {
    setSubtitleScale(1);
    try {
      localStorage.setItem('subtitleScale', '1');
    } catch {
      /* storage unavailable */
    }
    holdSubtitlePreview();
  };

  // Subtitle overlay opacity (0% = hidden, 100% = fully visible), persisted
  const [subtitleOpacity, setSubtitleOpacity] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('subtitleOpacity');
      const n = saved ? parseFloat(saved) : NaN;
      return Number.isFinite(n) ? Math.min(Math.max(n, 0), 100) : 100;
    } catch {
      return 100;
    }
  });

  const changeSubtitleOpacity = (v: number) => {
    const next = Math.min(Math.max(Math.round(v), 0), 100);
    setSubtitleOpacity(next);
    try {
      localStorage.setItem('subtitleOpacity', String(next));
    } catch {
      /* storage unavailable */
    }
    holdSubtitlePreview();
  };

  // Subtitle position within the video (normalized 0–100 of box center).
  // Draggable anywhere — persisted across sessions. Default: bottom-center.
  const [subtitlePos, setSubtitlePos] = useState<{ x: number; y: number }>(() => {
    try {
      const saved = localStorage.getItem('subtitlePos');
      if (saved) {
        const p = JSON.parse(saved);
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          return {
            x: Math.min(Math.max(p.x, 5), 95),
            y: Math.min(Math.max(p.y, 5), 95),
          };
        }
      }
    } catch {
      /* storage unavailable */
    }
    return { x: 50, y: 85 };
  });
  const subtitlePosRef = useRef(subtitlePos);
  useEffect(() => {
    subtitlePosRef.current = subtitlePos;
  }, [subtitlePos]);
  const subtitleBoxRef = useRef<HTMLDivElement | null>(null);
  const subtitleDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);
  // Multi-touch state: track active pointers for pinch-to-zoom on the CC box
  const subtitlePointersRef = useRef<Record<number, { x: number; y: number }>>({});
  const pinchRef = useRef<{ startDist: number; startScale: number } | null>(null);
  const subtitleScaleRef = useRef(subtitleScale);
  useEffect(() => {
    subtitleScaleRef.current = subtitleScale;
  }, [subtitleScale]);

  const persistSubtitlePos = (pos: { x: number; y: number }) => {
    try {
      localStorage.setItem('subtitlePos', JSON.stringify(pos));
    } catch {
      /* storage unavailable */
    }
  };

  // Set subtitle scale directly (used by pinch zoom), clamped 0–2.5 and persisted
  const setSubtitleScaleValue = (v: number) => {
    const next = Math.min(Math.max(Math.round(v * 100) / 100, 0), 2.5);
    setSubtitleScale(next);
    try {
      localStorage.setItem('subtitleScale', String(next));
    } catch {
      /* storage unavailable */
    }
    holdSubtitlePreview();
  };

  // Subtitle dragging via document-level listeners (mobile-safe, no setPointerCapture)
  const isDraggingRef = useRef(false);

  const onDocMoveRef = useRef<(e: PointerEvent) => void>(() => {});
  const onDocUpRef = useRef<(e: PointerEvent) => void>(() => {});

  // Keep refs updated each render so native listeners always see latest state
  onDocMoveRef.current = (e: PointerEvent) => {
    const pts = subtitlePointersRef.current;
    if (pts[e.pointerId]) {
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    }

    // Pinch-to-zoom: two-finger scale
    if (pinchRef.current && Object.keys(pts).length >= 2) {
      const ptsArr = Object.values(pts) as Array<{ x: number; y: number }>;
      const dist = Math.hypot(ptsArr[0].x - ptsArr[1].x, ptsArr[0].y - ptsArr[1].y);
      if (pinchRef.current.startDist > 10) {
        setSubtitleScaleValue(pinchRef.current.startScale * (dist / pinchRef.current.startDist));
      }
      return;
    }

    // Single-finger drag
    const drag = subtitleDragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault(); // prevent page scroll while dragging
    const container = subtitleBoxRef.current?.parentElement?.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dx = ((e.clientX - drag.startX) / rect.width) * 100;
    const dy = ((e.clientY - drag.startY) / rect.height) * 100;
    if (!drag.moved && Math.abs(dx) < 0.2 && Math.abs(dy) < 0.2) return;
    drag.moved = true;
    setSubtitlePos({
      x: Math.min(Math.max(drag.origX + dx, 2), 98),
      y: Math.min(Math.max(drag.origY + dy, 2), 98),
    });
  };

  onDocUpRef.current = (e: PointerEvent) => {
    const pts = subtitlePointersRef.current;
    delete pts[e.pointerId];
    if (Object.keys(pts).length < 2) pinchRef.current = null;
    const drag = subtitleDragRef.current;
    if (drag && e.pointerId === drag.pointerId) {
      subtitleDragRef.current = null;
      isDraggingRef.current = false;
      if (drag.moved) persistSubtitlePos(subtitlePosRef.current);
    }
    document.removeEventListener('pointermove', onDocMoveRef.current);
    document.removeEventListener('pointerup', onDocUpRef.current);
    document.removeEventListener('pointercancel', onDocUpRef.current);
  };

  const handleSubtitleDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation(); // prevent video click-to-play
    const pts = subtitlePointersRef.current;
    pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    const ptsArr = Object.values(pts) as Array<{ x: number; y: number }>;

    if (ptsArr.length >= 2) {
      // Two fingers → pinch-to-zoom
      const dist = Math.hypot(ptsArr[0].x - ptsArr[1].x, ptsArr[0].y - ptsArr[1].y);
      pinchRef.current = { startDist: dist, startScale: subtitleScaleRef.current };
      subtitleDragRef.current = null;
    } else {
      // One finger → drag mode
      subtitleDragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origX: subtitlePosRef.current.x,
        origY: subtitlePosRef.current.y,
        moved: false,
      };
      isDraggingRef.current = true;
    }

    // Use document-level listeners (works outside element bounds, mobile-safe)
    document.addEventListener('pointermove', onDocMoveRef.current, { passive: false });
    document.addEventListener('pointerup', onDocUpRef.current);
    document.addEventListener('pointercancel', onDocUpRef.current);
  };
  const [isAiVoiceDubbing, setIsAiVoiceDubbing] = useState(false);
  const [bgVolume, setBgVolume] = useState(0.15); // Background music volume during dubbing

  const [activeDubbedEl, setActiveDubbedEl] = useState<HTMLAudioElement | null>(null);
  const [voiceVolume, setVoiceVolume] = useState(1.0); // AI voice volume
  const [duckFactor, setDuckFactor] = useState<number>(MUSIC_DUCK); // ducking depth
  const lastSpokenSegmentIdRef = useRef<number | null>(null);
  const dubbedAudioRef = useRef<HTMLAudioElement | null>(null);
  const currentTimeRef = useRef<number>(0); // Always-fresh playback time for accurate sync
  const exportBusyRef = useRef(false);
  const isAiVoiceDubbingRef = useRef(false); // fresh flag for async vocal-removal checks
  const separablePromiseRef = useRef<Promise<boolean> | null>(null);

  // Can this clip's vocals be separated from the music (true stereo)? Decoded
  // lazily once per media file and reused by both the live preview and export.
  const getSeparable = (): Promise<boolean> => {
    if (!separablePromiseRef.current) {
      separablePromiseRef.current = (async () => {
        try {
          if (!mediaUrl) return false;
          const res = await fetch(mediaUrl);
          if (!res.ok) return false;
          const ab = await res.arrayBuffer();
          const AudioCtx: typeof AudioContext | undefined =
            window.AudioContext || (window as any).webkitAudioContext;
          if (!AudioCtx) return false;
          const ctx = new AudioCtx();
          try {
            const buf = await ctx.decodeAudioData(ab);
            return isSeparableBuffer(buf);
          } finally {
            setTimeout(() => {
              try { ctx.close(); } catch { /* noop */ }
            }, 2000);
          }
        } catch {
          return false;
        }
      })();
    }
    return separablePromiseRef.current;
  };

  // A new media file means a fresh separability check.
  useEffect(() => {
    separablePromiseRef.current = null;
  }, [mediaUrl]);

  // Find active segment for current playback timestamp
  const activeSegment = segments.find(
    (seg) => currentTime >= seg.start && currentTime <= seg.end
  );

  // Remember the most recent segment for instant size/opacity preview
  useEffect(() => {
    if (activeSegment) lastSegmentRef.current = activeSegment;
  }, [activeSegment]);

  // While adjusting size/opacity, keep showing the last subtitle (instant preview)
  const displaySegment =
    activeSegment ?? (subtitlePreviewHold ? lastSegmentRef.current : null);

  // Smart audio mixing: when AI dubbing is ON, remove the ORIGINAL speaker
  // (center-cancel, stereo sources only) so only music + translated voice are
  // heard — exactly what the exported file contains. Applied ONCE per dubbing
  // session: rebuilding the network on every subtitle line change caused
  // audible clicks/glitches mid-song. Mono/dual-mono clips (cannot be
  // separated) fall back to plain ducking — never a broken mix.
  useEffect(() => {
    isAiVoiceDubbingRef.current = isAiVoiceDubbing;
    const el = mediaPlayerRef.current;
    if (!el) return;
    let cancelled = false;

    if (isAiVoiceDubbing) {
      getSeparable().then((separable) => {
        if (cancelled || !separable) return;
        const cur = mediaPlayerRef.current;
        if (cur && isAiVoiceDubbingRef.current) setVocalRemoval(cur, true);
      });
    } else {
      setVocalRemoval(el, false); // restore full original audio
      el.volume = 1.0; // Full volume when dubbing is off
    }
    return () => {
      cancelled = true;
    };
  }, [isAiVoiceDubbing, mediaPlayerRef]);

  // While dubbing, duck the music under the AI voice per segment (dip during
  // speech, recover in gaps). Volume only — the user's mute is respected and
  // never overridden by a segment change.
  useEffect(() => {
    if (!isAiVoiceDubbing || !isPlaying) return;
    const el = mediaPlayerRef.current;
    if (!el || isMuted) return;
    el.volume =
      activeSegment && activeSegment.dubbedAudioBase64
        ? bgVolume * duckFactor
        : bgVolume;
  }, [isAiVoiceDubbing, isPlaying, activeSegment, bgVolume, duckFactor, isMuted, mediaPlayerRef]);

  // Play pre-generated dubbed audio segment with precise timing sync
  // Rate is calculated from REMAINING segment time so speech fits the video exactly
  const playDubbedSegment = (segment: SubtitleSegment) => {
    if (!segment.dubbedAudioBase64) return;

    const segmentDuration = Math.max(segment.end - segment.start, 0.5);
    // How late are we relative to the segment start? (detection latency)
    const offset = Math.max(currentTimeRef.current - segment.start, 0);
    const remainingSegment = Math.max(segmentDuration - offset, 0.4);

    // Stop any currently playing dubbed audio
    if (dubbedAudioRef.current) {
      dubbedAudioRef.current.pause();
      dubbedAudioRef.current = null;
    }

    const audioBlob = base64ToBlob(segment.dubbedAudioBase64, 'audio/mpeg');
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
    audio.volume = voiceVolume; // Apply user-set AI voice volume
    audio.preservesPitch = true; // Keep natural pitch when speeding up/slowing down
    dubbedAudioRef.current = audio;
    // Feed the avatar lip-sync analyser (fresh element per segment).
    setActiveDubbedEl(audio);

    audio.onloadedmetadata = () => {
      const audioDuration = audio.duration;
      if (audioDuration > 0 && remainingSegment > 0) {
        // Rate needed so audio finishes exactly when the video segment ends — 100% sync.
        const requiredRate = audioDuration / remainingSegment;
        // Allow 0.5x (slow pad) to 4x (fast) — chained atempo on server side; preview mirrors it.
        // Keeps speech natural while guaranteeing voice ↔ video lock.
        const rate = Math.min(Math.max(requiredRate, 0.5), 4.0);
        audio.playbackRate = rate;

        // If we are significantly late AND audio is long, skip ahead proportionally
        // so speech stays in sync with the video timeline
        const effectiveAudioTimeNeeded = audioDuration / rate;
        if (offset > 0.5 && effectiveAudioTimeNeeded > remainingSegment + offset) {
          const skipAhead = offset * rate * 0.8;
          if (skipAhead > 0 && skipAhead < audioDuration) {
            audio.currentTime = skipAhead;
          }
        }
      }
    };

    const clearActiveAudio = () => {
      if (dubbedAudioRef.current === audio) {
        dubbedAudioRef.current = null;
      }
      setActiveDubbedEl((prev) => (prev === audio ? null : prev));
    };

    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      clearActiveAudio();
    };

    audio.onerror = () => {
      URL.revokeObjectURL(audioUrl);
      clearActiveAudio();
    };

    audio.play().catch(() => {});
  };

  // Synchronized AI Voice Dubbing effect with timing sync & graceful transitions
  useEffect(() => {
    if (!isAiVoiceDubbing || !isPlaying) {
      if (!isAiVoiceDubbing) {
        stopSpeaking();
        lastSpokenSegmentIdRef.current = null;
        if (dubbedAudioRef.current) {
          dubbedAudioRef.current.pause();
          dubbedAudioRef.current = null;
        }
        setActiveDubbedEl(null);
      }
      return;
    }

    if (activeSegment && activeSegment.id !== lastSpokenSegmentIdRef.current) {
      lastSpokenSegmentIdRef.current = activeSegment.id;
      const prevAudio = dubbedAudioRef.current;

      // Grace period: if previous speech is nearly done (< 1.2s left), let it finish
      // naturally instead of cutting it off mid-sentence
      if (prevAudio && !prevAudio.paused && prevAudio.duration > 0) {
        const timeLeft = prevAudio.duration - prevAudio.currentTime;
        if (timeLeft > 0 && timeLeft < 1.2) {
          const delay = timeLeft * 1000;
          const segSnapshot = activeSegment;
          const timer = setTimeout(() => {
            if (dubbedAudioRef.current === prevAudio) {
              if (segSnapshot.dubbedAudioBase64) {
                playDubbedSegment(segSnapshot);
              } else if (segSnapshot.translatedText) {
                speakText(segSnapshot.translatedText, targetLangCode);
              }
            }
          }, delay + 50);
          return () => clearTimeout(timer);
        }
      }

      // Play immediately (replacing previous audio)
      if (activeSegment.dubbedAudioBase64) {
        playDubbedSegment(activeSegment);
      } else if (activeSegment.translatedText) {
        speakText(activeSegment.translatedText, targetLangCode);
      }
    }
  }, [activeSegment, isAiVoiceDubbing, isPlaying, targetLangCode]);

  const togglePlay = () => {
    const el = mediaPlayerRef.current;
    if (!el) return;
    if (el.paused) {
      el.play();
      setIsPlaying(true);
    } else {
      el.pause();
      setIsPlaying(false);
      if (isAiVoiceDubbing) {
        stopSpeaking();
      }
    }
  };

  const handleTimeUpdate = () => {
    if (mediaPlayerRef.current) {
      currentTimeRef.current = mediaPlayerRef.current.currentTime;
      setCurrentTime(mediaPlayerRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (mediaPlayerRef.current) {
      setDuration(mediaPlayerRef.current.duration);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = parseFloat(e.target.value);
    setCurrentTime(newTime);
    if (mediaPlayerRef.current) {
      mediaPlayerRef.current.currentTime = newTime;
    }
    if (isAiVoiceDubbing) {
      stopSpeaking();
      lastSpokenSegmentIdRef.current = null;
    }
  };

  // Toggle AI dubbing with smart audio mixing
  const toggleAiDubbing = () => {
    const newDubbing = !isAiVoiceDubbing;
    setIsAiVoiceDubbing(newDubbing);
    if (setMuteOriginal) {
      setMuteOriginal(newDubbing);
    }
    const el = mediaPlayerRef.current;
    if (newDubbing) {
      // Enable AI dubbing: duck original audio but keep background music
      if (el) {
        el.volume = bgVolume;
        el.muted = false;
      }
      setIsMuted(false);
    } else {
      // Disable AI dubbing: restore full volume
      if (el) {
        el.volume = 1.0;
        el.muted = false;
      }
      setIsMuted(false);
      stopSpeaking();
      lastSpokenSegmentIdRef.current = null;
      if (dubbedAudioRef.current) {
        dubbedAudioRef.current.pause();
        dubbedAudioRef.current = null;
      }
    }
  };

  const restart = () => {
    if (mediaPlayerRef.current) {
      mediaPlayerRef.current.currentTime = 0;
      mediaPlayerRef.current.play();
      setIsPlaying(true);
      if (isAiVoiceDubbing) {
        stopSpeaking();
        lastSpokenSegmentIdRef.current = null;
        if (dubbedAudioRef.current) {
          dubbedAudioRef.current.pause();
          dubbedAudioRef.current = null;
        }
      }
    }
  };

  const toggleFullscreen = () => {
    const video = mediaPlayerRef.current as HTMLVideoElement;
    if (video && video.requestFullscreen) {
      video.requestFullscreen();
    }
  };

  // Helper to convert base64 to Blob
  const base64ToBlob = (base64: string, mimeType: string): Blob => {
    const byteChars = atob(base64);
    const byteArrays = [];
    const sliceSize = 512;
    for (let offset = 0; offset < byteChars.length; offset += sliceSize) {
      const slice = byteChars.slice(offset, offset + sliceSize);
      const byteNumbers = new Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i);
      }
      byteArrays.push(new Uint8Array(byteNumbers));
    }
    return new Blob(byteArrays, { type: mimeType });
  };

  /**
   * Export the dubbed media file (MP4/WebM video or audio).
   * Pipeline: video plays once in real-time while MediaRecorder captures
   * [video track] + [Web Audio mix]. Every dubbed segment is scheduled at its
   * exact timestamp via AudioContext (sample-accurate) and time-stretched
   * (playbackRate) so each phrase ends precisely when its subtitle segment ends.
   */
  const exportDubbedInternal = async (
    onProgress?: (p: number) => void
  ): Promise<{ blob: Blob; ext: string } | null> => {
    const el = mediaPlayerRef.current;
    if (!el || exportBusyRef.current || segments.length === 0) return null;
    exportBusyRef.current = true;

    const isVideo = mediaType === 'video';

    // Stop live dubbing preview to avoid double audio
    setIsAiVoiceDubbing(false);
    stopSpeaking();
    if (dubbedAudioRef.current) {
      dubbedAudioRef.current.pause();
      dubbedAudioRef.current = null;
    }

    let handle: ExportPath | null = null;
    let exportRafId = 0;
    let exportDrawTimer = 0;
    // Hoisted outside the try so the finally block can clean it up (let
    // declarations inside a try are not visible in its finally).
    let canvas: HTMLCanvasElement | null = null;
    try {
      // Smart export: when the user enabled "remove original voice", strip the
      // speaker (center-cancel) from the recorded background so the final file
      // is video + music + translated voice. Mono/dual-mono clips cannot be
      // separated → plain ducking fallback (never a broken/empty file).
      const useVocalRemoval = removeVocalsOnExport === true && (await getSeparable());
      handle = buildExportPath(el, bgVolume, voiceVolume, useVocalRemoval);
      const { ctx, mixDest, bgGain, voiceGain, restore } = handle;

      // Pick the best supported container that will actually PLAY on phones:
      // 1) True H.264+AAC MP4 (iPhone Safari records this natively) — plays
      //    in the phone gallery everywhere.
      // 2) VP8+Opus WebM — plays in Android galleries and most players. We
      //    prefer this over a generic "video/mp4" whose codecs may be VP9
      //    (many phone galleries reject VP9-in-MP4).
      // 3) Generic WebM / generic MP4 as last resorts.
      const mimeCandidates = isVideo
        ? [
            'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
            'video/webm;codecs=vp8,opus',
            'video/webm',
            'video/mp4',
          ]
        : ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
      const mimeType =
        mimeCandidates.find((m) => {
          try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
        });
      if (!mimeType) {
        throw new Error('Your browser does not support media recording. Please use Chrome, Edge or Safari.');
      }

      // Video track: ALWAYS render through a canvas (rAF draw loop) and capture
      // the canvas stream. This is far more reliable on Android, where
      // element.captureStream() can silently produce ZERO frames — the result is
      // exactly the broken "0.00 MB · 0:00 / 0:00" file seen in the field — when
      // the element is offscreen, throttled, or being composited oddly. Subtitles
      // are burned into the same canvas when CC is ON; when CC is OFF we still
      // draw the plain video frame. Element capture is only a fallback for
      // browsers without canvas.captureStream (older iOS Safari).
      const burnSubs =
        isVideo && showSubtitles && subtitleOpacity > 0 && subtitleScale > 0;
      let ctx2d: CanvasRenderingContext2D | null = null;
      let videoTrackSource: 'canvas' | 'element' | 'none' = 'none';
      const vEl = el as HTMLVideoElement;
      const tracks: MediaStreamTrack[] = [];
      if (isVideo) {
        try {
          canvas = document.createElement('canvas');
          canvas.width = vEl.videoWidth || 1280;
          canvas.height = vEl.videoHeight || 720;
          // CRITICAL for Android: canvas.captureStream() only emits frames while
          // the canvas is actually PAINTED by the compositor. A detached canvas
          // silently produces ZERO frames on Android Chrome → the "0.00 MB" /
          // "empty recording" bug. Attach it to the DOM, tiny and near-invisible
          // (opacity > 0 so it still paints), with pointer-events disabled.
          canvas.style.cssText =
            'position:fixed;top:0;left:0;width:2px;height:2px;opacity:0.02;' +
            'pointer-events:none;z-index:2147483647;will-change:transform;' +
            'transform:translateZ(0);';
          canvas.setAttribute('aria-hidden', 'true');
          document.body.appendChild(canvas);
          ctx2d = canvas.getContext('2d');
          const cs = canvas && (canvas as any).captureStream;
          if (ctx2d && cs) {
            const vs: MediaStream = (canvas as any).captureStream(30);
            const vt = vs.getVideoTracks?.()[0];
            if (vt) {
              tracks.push(vt);
              videoTrackSource = 'canvas';
            }
          }
          if (videoTrackSource === 'none') {
            canvas.remove();
            canvas = null;
            ctx2d = null;
          }
        } catch {
          try { canvas?.remove(); } catch { /* noop */ }
          canvas = null;
          ctx2d = null;
        }
        if (videoTrackSource === 'none') {
          try {
            const vs: MediaStream | undefined = (vEl as any).captureStream
              ? (vEl as any).captureStream()
              : (vEl as any).mozCaptureStream
              ? (vEl as any).mozCaptureStream()
              : (vEl as any).webkitCaptureStream();
            const vt = vs?.getVideoTracks?.()[0];
            if (vt) {
              tracks.push(vt);
              videoTrackSource = 'element';
            }
          } catch {
            // captureStream unavailable → audio-only export
          }
        }
      }
      tracks.push(...mixDest.stream.getAudioTracks());
      if (tracks.length === 0) {
        throw new Error(t.exportNoCapture);
      }
      const stream = new MediaStream(tracks);

      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      const stopped = new Promise<void>((res) => {
        recorder.onstop = () => res();
      });

      // Pre-decode all dubbed segment audio
      const buffers = new Map<number, AudioBuffer>();
      for (const seg of segments) {
        if (!seg.dubbedAudioBase64) continue;
        try {
          const blob = base64ToBlob(seg.dubbedAudioBase64, 'audio/mpeg');
          const ab = await blob.arrayBuffer();
          buffers.set(seg.id, await ctx.decodeAudioData(ab));
        } catch { /* skip undecodable segment */ }
      }

      // Reset media, then play + record in real-time. Two guards fix the
      // Android "empty recording" bug: (1) the AudioContext MUST be running or
      // the captured audio track stays silent/empty, and (2) play() can resolve
      // before frames actually flow, so we wait for the real `playing` event.
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch {
          /* non-fatal */
        }
      }
      el.pause();
      el.muted = false;
      el.volume = 1;
      el.currentTime = 0;

      // Start the recorder BEFORE the video plays so no audio/video sample at
      // the very beginning gets dropped (both tracks begin at the same instant,
      // which keeps voice ↔ video sync exact in the final file).
      recorder.start(500);

      // Sample BOTH clocks at the same wall moment (the `playing` event) so we
      // can schedule the dubbed voice exactly on the video timeline instead of
      // guessing an offset after playback already started.
      let wallStart = 0;
      let ctxAtStart = 0;
      const markStart = () => {
        wallStart = performance.now();
        ctxAtStart = ctx.currentTime;
      };
      vEl.addEventListener('playing', markStart);

      try {
        await el.play();
      } catch (err) {
        // Autoplay/gesture rejection on Android — stop the recorder so we never
        // hand back a silent empty file, then surface a clear error.
        try { recorder.stop(); } catch { /* noop */ }
        await stopped.catch(() => {});
        throw new Error(t.exportEmptyRecording);
      }
      if (vEl.readyState < 2) {
        await new Promise<void>((resolve) => {
          const done = () => {
            vEl.removeEventListener('playing', done);
            resolve();
          };
          vEl.addEventListener('playing', done);
          window.setTimeout(done, 2500);
        });
      }

      // Draw one frame synchronously so the captured video track has data from
      // the very first moment, then keep drawing via rAF while recording.
      const drawFrame = () => {
        if (!ctx2d || !canvas) return;
        if (vEl.videoWidth > 0 && vEl.videoHeight > 0) {
          if (canvas.width !== vEl.videoWidth || canvas.height !== vEl.videoHeight) {
            canvas.width = vEl.videoWidth;
            canvas.height = vEl.videoHeight;
          }
          ctx2d.drawImage(vEl, 0, 0, canvas.width, canvas.height);
          const t = vEl.currentTime;
          const seg = segments.find((s) => t >= s.start && t <= s.end);
          if (seg) {
            drawSubtitleOnCanvas(ctx2d, canvas, seg, {
              mode: subtitleMode,
              scale: subtitleScale,
              pos: subtitlePos,
              opacity: subtitleOpacity,
            });
          }
        }
      };
      const drawLoop = () => {
        drawFrame();
        exportRafId = requestAnimationFrame(drawLoop);
      };
      if (ctx2d) {
        drawFrame();
        exportRafId = requestAnimationFrame(drawLoop);
        // Interval fallback: rAF can be throttled/paused on some Android
        // devices mid-recording, which would stall canvas frame emission.
        exportDrawTimer = window.setInterval(drawFrame, 40);
      }

      // Audio time 0 is defined as the instant the video ACTUALLY started
      // (wallStart / ctxAtStart were sampled together on `playing`). Scheduling
      // at t0 + seg.start therefore plays each phrase exactly when its subtitle
      // segment appears on screen. The +0.05 guard keeps every start() time in
      // the future (sample-accurate) — total lip-sync error stays under ~50ms.
      const elapsedSinceStart = wallStart ? (performance.now() - wallStart) / 1000 : 0;
      const t0 = wallStart
        ? ctxAtStart - elapsedSinceStart + 0.05
        : ctx.currentTime + 0.15;
      vEl.removeEventListener('playing', markStart);
      const mediaDuration = el.duration || 0;

      // Schedule every dubbed segment at its exact video timestamp.
      // playbackRate = audioDuration / segmentDuration  → time-stretch so the
      // phrase ENDS precisely when its subtitle segment ends (0.5–4.0x, 100% sync).
      for (const seg of segments) {
        const buf = buffers.get(seg.id);
        if (!buf) continue;
        const segDur = Math.max(seg.end - seg.start, 0.4);
        const rate = Math.min(Math.max(buf.duration / segDur, 0.5), 4.0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;
        src.connect(voiceGain);
        src.start(t0 + seg.start);

        // Duck background music while this segment speaks
        const sAt = t0 + seg.start;
        const sEnd = sAt + Math.min(segDur, buf.duration / rate);
        const bg = bgGain.gain;
        try {
          bg.setValueAtTime(bgVolume, Math.max(sAt - 0.08, ctx.currentTime));
          bg.linearRampToValueAtTime(bgVolume * duckFactor, sAt + 0.06);
          bg.setValueAtTime(bgVolume * duckFactor, sEnd);
          bg.linearRampToValueAtTime(bgVolume, sEnd + 0.25);
        } catch { /* automation overlap — non-fatal */ }
      }

      // Progress reporting
      const prog = window.setInterval(() => {
        const p = mediaDuration > 0 ? Math.min(el.currentTime / mediaDuration, 1) : 0;
        onProgress?.(p);
      }, 250);

      // Record until media ends (real-time capture)
      await new Promise<void>((resolve) => {
        el.onended = () => resolve();
        if (mediaDuration > 0) {
          window.setTimeout(resolve, (mediaDuration + 5) * 1000);
        }
      });

      window.clearInterval(prog);

      // Small tail so the last word isn't clipped
      await new Promise((r) => setTimeout(r, 400));

      recorder.stop();
      await stopped;

      const outBlob = new Blob(chunks, { type: mimeType.split(';')[0] });

      // Never hand back a broken/empty recording (phones render it as a
      // playable-looking "0.00 MB · 0:00 / 0:00" file). If the capture produced
      // no data, fail loudly with a clear message instead.
      const minBytes = isVideo ? 15_000 : 2_000;
      if (outBlob.size < minBytes) {
        console.warn(`[Export] Recording too small (${outBlob.size}B) — capture produced no data.`);
        throw new Error(t.exportEmptyRecording);
      }

      // Name the file by its REAL container (sniff the magic bytes), never by
      // assumption — a WebM blob named .mp4 is what makes phones reject it.
      const sniffContainer = async (blob: Blob): Promise<'mp4' | 'webm' | 'unknown'> => {
        try {
          const buf = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
          // MP4 family starts with a size + "ftyp" at bytes 4..7
          if (buf.length > 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
            return 'mp4';
          }
          // WebM / Matroska starts with EBML magic 0x1A45DFA3
          if (buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
            return 'webm';
          }
          return 'unknown';
        } catch {
          return 'unknown';
        }
      };
      const container = await sniffContainer(outBlob);
      const declaredMp4 = mimeType.includes('mp4');
      let ext = isVideo ? 'mp4' : 'm4a';
      if (container === 'webm') ext = 'webm';
      else if (container === 'unknown') ext = isVideo ? (declaredMp4 ? 'mp4' : 'webm') : (declaredMp4 ? 'm4a' : 'webm');

      // WebM recording + video: try server-side conversion to a real MP4.
      // (The deployed serverless platform has no ffmpeg, so this usually
      // returns 501 — in that case we simply deliver the WebM, correctly named.)
      if (isVideo && ext === 'webm' && outBlob.size > 1000) {
        try {
          const formData = new FormData();
          formData.append('video', outBlob, 'recording.webm');
          onProgress?.(0.95);
          const resp = await fetch(apiUrl('render-mp4'), { method: 'POST', body: formData });
          if (resp.ok) {
            const ct = resp.headers.get('content-type') || '';
            if (ct.includes('video/mp4') || ct.includes('application/octet-stream')) {
              const mp4Blob = await resp.blob();
              const mp4Container = await sniffContainer(mp4Blob);
              if (mp4Blob.size > 1000 && mp4Container === 'mp4') {
                console.log(`[Export] Server MP4 conversion: ${(mp4Blob.size / 1024 / 1024).toFixed(1)}MB`);
                return { blob: mp4Blob, ext: 'mp4' };
              }
            }
          }
          await resp.text().catch(() => '');
          console.warn('[Export] Server MP4 conversion unavailable — keeping WebM.');
        } catch (err) {
          console.warn('[Export] MP4 conversion failed — keeping WebM:', (err as any)?.message);
        }
      }

      if (outBlob.size > 1000) {
        console.log(`[Export] Recorded ${container === 'unknown' ? mimeType : container}: ${(outBlob.size / 1024 / 1024).toFixed(1)}MB`);
      }
      return { blob: outBlob, ext };
    } catch (err) {
      console.error('Export failed:', err);
      throw err;
    } finally {
      if (exportRafId) cancelAnimationFrame(exportRafId);
      if (exportDrawTimer) window.clearInterval(exportDrawTimer);
      try { canvas?.remove(); } catch { /* noop */ }
      handle?.restore();
      el.pause();
      el.currentTime = 0;
      setCurrentTime(0);
      exportBusyRef.current = false;
    }
  };

  useImperativeHandle(ref, () => ({
    exportDubbed: (onProgress?: (p: number) => void) => exportDubbedInternal(onProgress),
    setMixLevels: (voice: number, bg: number, depth: DuckDepth) => {
      setVoiceVolume(Math.min(Math.max(voice, 0), 2));
      setBgVolume(Math.min(Math.max(bg, 0), 1));
      setDuckFactor(DUCK_FACTORS[depth] ?? MUSIC_DUCK);
    },
  }));

  if (!mediaUrl) {
    return null;
  }

  return (
    <div className="bg-stone-900 rounded-2xl overflow-hidden shadow-lg border border-stone-800 flex flex-col">
      {/* Visual / Media Container */}
      <div className="relative aspect-video w-full bg-black flex items-center justify-center overflow-hidden group">
        {mediaType === 'video' ? (
          <video
            id="main-video-player"
            ref={mediaPlayerRef as React.RefObject<HTMLVideoElement>}
            src={mediaUrl}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onEnded={() => setIsPlaying(false)}
            onClick={togglePlay}
            className="w-full h-full object-contain cursor-pointer"
            playsInline
          />
        ) : (
          <div
            onClick={togglePlay}
            className="w-full h-full flex flex-col items-center justify-center p-8 bg-gradient-to-b from-stone-900 via-stone-800 to-stone-950 text-white cursor-pointer select-none"
          >
            <audio
              id="main-audio-player"
              ref={mediaPlayerRef as React.RefObject<HTMLAudioElement>}
              src={mediaUrl}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
              onEnded={() => setIsPlaying(false)}
            />
            <div className="w-20 h-20 rounded-full bg-orange-600/30 border border-orange-500/50 flex items-center justify-center text-orange-400 mb-4 shadow-inner">
              <Music className="w-10 h-10 animate-pulse" />
            </div>
            <p className="text-sm font-semibold text-stone-300">{t.audioTrackPlaying}</p>
            <p className="text-xs text-stone-500 mt-1">{t.liveSubtitlesBelow}</p>
          </div>
        )}



        {/* Live Subtitle Overlay — draggable to any position in the video */}
        {showSubtitles && displaySegment && (
          <div
            className="absolute z-10 pointer-events-none"
            style={{
              left: `${subtitlePos.x}%`,
              top: `${subtitlePos.y}%`,
              transform: 'translate(-50%, -50%)',
              opacity: subtitleOpacity / 100,
            }}
          >
            <div
              ref={subtitleBoxRef}
              onPointerDown={handleSubtitleDragStart}
              className="pointer-events-auto bg-black/85 backdrop-blur-md px-4 py-2 rounded-xl text-center shadow-2xl max-w-[90%] sm:max-w-2xl border border-white/10 cursor-grab active:cursor-grabbing select-none touch-none transition-shadow"
              style={{ fontFamily: "'Kantumruy Pro', 'Noto Sans Khmer', 'Khmer OS', sans-serif", boxShadow: isDraggingRef.current ? '0 0 0 2px rgba(249,115,22,0.5), 0 8px 32px rgba(0,0,0,0.6)' : undefined }}
              title="អូស = ផ្លាស់ទី • ចុចពីរម្រាម = ពង្រីក/បង្រួម"
            >
              {/* Show Original text if 'both' or 'original' */}
              {(subtitleMode === 'both' || subtitleMode === 'original') && (
                <p
                  className={`text-stone-300 font-medium ${
                    subtitleMode === 'both' ? 'text-stone-400 mb-1 opacity-90' : ''
                  }`}
                  style={{
                    fontSize: `${(subtitleMode === 'both' ? 0.75 : 0.95) * subtitleScale}rem`,
                  }}
                >
                  {displaySegment.originalText}
                </p>
              )}

              {/* Show Translated text if 'both' or 'translated' */}
              {(subtitleMode === 'both' || subtitleMode === 'translated') && (
                <p
                  className="text-white font-bold leading-relaxed tracking-wide"
                  style={{
                    fontSize: `${(subtitleMode === 'both' ? 1.0 : 1.15) * subtitleScale}rem`,
                    textShadow: '0 2px 4px rgba(0,0,0,0.8)',
                    wordBreak: 'break-word',
                    overflowWrap: 'break-word',
                    hyphens: 'none',
                  }}
                >
                  {displaySegment.translatedText}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Media Player Controls Bar */}
      <div className="p-3 bg-stone-950 text-stone-300 flex flex-col gap-2">
        {/* Scrubber Range Bar */}
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-mono text-stone-400 w-10 text-right">
            {formatClockTime(currentTime)}
          </span>
          <input
            id="player-timeline-scrubber"
            type="range"
            min="0"
            max={duration || 100}
            step="0.1"
            value={currentTime}
            onChange={handleSeek}
            className="flex-1 h-1.5 bg-stone-800 rounded-lg appearance-none cursor-pointer accent-orange-500"
          />
          <span className="text-[11px] font-mono text-stone-400 w-10">
            {formatClockTime(duration)}
          </span>
        </div>

        {/* Buttons Row */}
        <div className="flex items-center justify-between gap-1 sm:gap-1.5 flex-wrap pt-0.5">
          <div className="flex items-center gap-1 sm:gap-1.5 flex-wrap min-w-0">
            <button
              id="player-toggle-play"
              type="button"
              onClick={togglePlay}
              className="p-1.5 sm:p-2 rounded-lg bg-orange-600 text-white hover:bg-orange-700 transition-colors"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause className="w-4 h-4 fill-white" /> : <Play className="w-4 h-4 fill-white" />}
            </button>

            <button
              id="player-restart"
              type="button"
              onClick={restart}
              className="p-1.5 sm:p-2 rounded-lg text-stone-400 hover:text-white hover:bg-stone-800 transition-colors"
              title="Restart"
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            {/* AI Voice Dubbing Toggle (compact) */}
            <button
              id="player-toggle-ai-dubbing"
              type="button"
              onClick={toggleAiDubbing}
              className={`px-2 py-1 sm:px-2.5 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-semibold flex items-center gap-1 sm:gap-1.5 whitespace-nowrap shrink-0 transition-all ${
                isAiVoiceDubbing
                  ? 'bg-gradient-to-r from-orange-600 to-amber-600 text-white shadow-sm ring-1 ring-orange-400'
                  : 'text-stone-400 hover:text-white hover:bg-stone-800'
              }`}
              title={isAiVoiceDubbing ? t.aiVoiceOn : t.aiVoiceOff}
            >
              <Radio className={`w-3.5 h-3.5 shrink-0 ${isAiVoiceDubbing ? 'animate-pulse text-amber-200' : ''}`} />
              <span>AI Voice</span>
            </button>



          </div>

          {/* Subtitle Controls */}
          <div className="flex items-center gap-0.5 sm:gap-1 flex-wrap">
            {/* Toggle CC button */}
            <button
              id="toggle-subtitles-cc"
              type="button"
              onClick={() => setShowSubtitles(!showSubtitles)}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1 transition-colors ${
                showSubtitles
                  ? 'bg-orange-600/30 border border-orange-500/50 text-orange-300'
                  : 'text-stone-500 hover:bg-stone-800'
              }`}
              title="Toggle Subtitles"
            >
              <Subtitles className="w-3.5 h-3.5" />
              <span>CC</span>
            </button>

            {/* Subtitle Language Switcher */}
            {showSubtitles && (
              <div className="hidden sm:flex items-center bg-stone-900 border border-stone-800 rounded-lg p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setSubtitleMode('translated')}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                    subtitleMode === 'translated'
                      ? 'bg-stone-800 text-white font-semibold'
                      : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  Translated
                </button>
                <button
                  type="button"
                  onClick={() => setSubtitleMode('both')}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                    subtitleMode === 'both'
                      ? 'bg-stone-800 text-white font-semibold'
                      : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  Both
                </button>
                <button
                  type="button"
                  onClick={() => setSubtitleMode('original')}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                    subtitleMode === 'original'
                      ? 'bg-stone-800 text-white font-semibold'
                      : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  Original
                </button>
              </div>
            )}

            {mediaType === 'video' && (
              <button
                id="player-fullscreen"
                type="button"
                onClick={toggleFullscreen}
                className="p-1.5 rounded-lg text-stone-400 hover:text-white hover:bg-stone-800"
                title="Fullscreen"
              >
                <Maximize className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Subtitle Opacity Slider (0–100%) */}
        {showSubtitles && (
          <div className="flex items-center gap-2 pt-1.5 border-t border-stone-800 mt-1">
            <Subtitles className="w-3.5 h-3.5 text-orange-400 shrink-0" />
            <input
              id="cc-opacity-slider"
              type="range"
              min="0"
              max="100"
              step="5"
              value={subtitleOpacity}
              onChange={(e) => changeSubtitleOpacity(parseInt(e.target.value))}
              className="flex-1 h-1 accent-orange-500"
              title={`CC Opacity: ${subtitleOpacity}%`}
            />
            <span className="text-[10px] font-mono text-orange-400 w-8 text-right">
              {subtitleOpacity}%
            </span>
          </div>
        )}

        {/* Volume Sliders Row (when dubbing is ON) */}
        {isAiVoiceDubbing && (
          <div className="flex items-center gap-3 pt-1.5 border-t border-stone-800 mt-1 flex-wrap">
            {/* AI Voice Volume */}
            <div className="flex items-center gap-1.5 flex-1 min-w-[130px]">
              <Radio className="w-3.5 h-3.5 text-orange-400 shrink-0" />
              <input
                id="ai-voice-volume-slider"
                type="range"
                min="0"
                max="100"
                value={Math.round(voiceVolume * 100)}
                onChange={(e) => setVoiceVolume(parseInt(e.target.value) / 100)}
                className="flex-1 max-w-[110px] h-1.5 accent-orange-500"
                title={`AI Voice: ${Math.round(voiceVolume * 100)}%`}
              />
              <span className="text-[10px] font-mono text-orange-400 w-8">
                {Math.round(voiceVolume * 100)}%
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

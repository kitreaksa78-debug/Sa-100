import React, { useRef, useState, useEffect, useImperativeHandle } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  RotateCcw,
  Subtitles,
  Music,
  Radio,
  Sparkles,
  MicOff,
} from 'lucide-react';
import { SubtitleSegment } from '../types';
import { formatClockTime, speakText, stopSpeaking } from '../utils/subtitleUtils';
import { setVocalRemoval, buildExportPath, type ExportPath } from '../utils/audioEngine';
import { UILang, UI_TEXT } from '../data/translations';

export interface MediaPlayerHandle {
  exportDubbed: (onProgress?: (p: number) => void) => Promise<{ blob: Blob; ext: string } | null>;
}

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
  const [voiceVolume, setVoiceVolume] = useState(1.0); // AI voice volume
  const [isVocalRemoval, setIsVocalRemoval] = useState(false);
  const lastSpokenSegmentIdRef = useRef<number | null>(null);
  const dubbedAudioRef = useRef<HTMLAudioElement | null>(null);
  const currentTimeRef = useRef<number>(0); // Always-fresh playback time for accurate sync
  const exportBusyRef = useRef(false);

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

  // Toggle vocal removal via shared audio engine
  const toggleVocalRemoval = () => {
    const el = mediaPlayerRef.current;
    if (!el) return;
    try {
      const nowOn = setVocalRemoval(el, !isVocalRemoval);
      setIsVocalRemoval(nowOn);
    } catch (err) {
      console.warn('Vocal removal toggle failed:', err);
    }
  };

  // Smart audio mixing: duck background music when AI voice speaks
  useEffect(() => {
    const el = mediaPlayerRef.current;
    if (!el) return;

    if (isAiVoiceDubbing && isPlaying) {
      // During AI dubbing: reduce original volume (ducking)
      // When a segment is active, duck more; when gap, restore slightly
      if (activeSegment && activeSegment.dubbedAudioBase64) {
        el.volume = bgVolume * 0.3; // Very low during AI speech
      } else {
        el.volume = bgVolume; // Background music at low volume in gaps
      }
      el.muted = false; // Don't fully mute — keep background music
    } else if (!isAiVoiceDubbing) {
      el.volume = 1.0; // Full volume when dubbing is off
    }
  }, [isAiVoiceDubbing, isPlaying, activeSegment, bgVolume, mediaPlayerRef]);

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

    audio.onloadedmetadata = () => {
      const audioDuration = audio.duration;
      if (audioDuration > 0 && remainingSegment > 0) {
        // Rate needed so audio finishes exactly when the video segment ends
        const requiredRate = audioDuration / remainingSegment;
        // Clamp: never slower than 0.85x, never faster than 1.8x (keeps it natural)
        const rate = Math.min(Math.max(requiredRate, 0.85), 1.8);
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

    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      if (dubbedAudioRef.current === audio) {
        dubbedAudioRef.current = null;
      }
    };

    audio.onerror = () => {
      URL.revokeObjectURL(audioUrl);
      if (dubbedAudioRef.current === audio) {
        dubbedAudioRef.current = null;
      }
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

  const toggleMute = () => {
    const el = mediaPlayerRef.current;
    if (!el) return;
    if (isMuted) {
      // Unmute
      el.muted = false;
      el.volume = isAiVoiceDubbing ? bgVolume : 1.0;
      setIsMuted(false);
    } else {
      // Mute
      el.muted = true;
      setIsMuted(true);
    }
    if (setMuteOriginal) {
      setMuteOriginal(!isMuted);
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
    try {
      handle = buildExportPath(el, bgVolume, voiceVolume);
      const { ctx, mixDest, bgGain, voiceGain, restore } = handle;

      // Pick the best supported container (MP4 where available, else WebM)
      const candidates = isVideo
        ? [
            'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
            'video/mp4',
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm',
          ]
        : ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
      const mimeType =
        candidates.find((m) => {
          try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
        }) || (isVideo ? 'video/webm' : 'audio/webm');

      // Video track: when CC is ON, burn subtitles onto a canvas stream so the
      // downloaded video INCLUDES them. When CC is OFF, capture the raw video
      // (no subtitles). Audio always comes from the Web Audio mix.
      const burnSubs =
        isVideo && showSubtitles && subtitleOpacity > 0 && subtitleScale > 0;
      let canvas: HTMLCanvasElement | null = null;
      let ctx2d: CanvasRenderingContext2D | null = null;
      const vEl = el as HTMLVideoElement;
      const tracks: MediaStreamTrack[] = [];
      if (isVideo) {
        try {
          let vs: MediaStream | null = null;
          if (burnSubs) {
            canvas = document.createElement('canvas');
            canvas.width = vEl.videoWidth || 1280;
            canvas.height = vEl.videoHeight || 720;
            ctx2d = canvas.getContext('2d');
            const cs = canvas && (canvas as any).captureStream;
            if (ctx2d && cs) {
              vs = (canvas as any).captureStream(30);
            } else {
              canvas = null;
              ctx2d = null;
            }
          }
          if (!vs) {
            vs = (vEl as any).captureStream
              ? (vEl as any).captureStream()
              : (vEl as any).mozCaptureStream
              ? (vEl as any).mozCaptureStream()
              : (vEl as any).webkitCaptureStream();
          }
          const vt = vs?.getVideoTracks?.()[0];
          if (vt) tracks.push(vt);
        } catch {
          // captureStream unavailable → audio-only export
        }
      }
      tracks.push(...mixDest.stream.getAudioTracks());
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

      // Reset media, then play + record in real-time
      el.pause();
      el.muted = false;
      el.volume = 1;
      el.currentTime = 0;
      await el.play();
      recorder.start(500);

      // Burn CC subtitles onto every frame while recording (only when CC is ON)
      const drawLoop = () => {
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
        exportRafId = requestAnimationFrame(drawLoop);
      };
      if (ctx2d) exportRafId = requestAnimationFrame(drawLoop);

      const t0 = ctx.currentTime + 0.15;
      const mediaDuration = el.duration || 0;

      // Schedule every dubbed segment at its exact video timestamp.
      // playbackRate = audioDuration / segmentDuration  → time-stretch so the
      // phrase ENDS precisely when its subtitle segment ends (clamped 0.85–1.8x).
      for (const seg of segments) {
        const buf = buffers.get(seg.id);
        if (!buf) continue;
        const segDur = Math.max(seg.end - seg.start, 0.4);
        const rate = Math.min(Math.max(buf.duration / segDur, 0.85), 1.8);
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
          bg.linearRampToValueAtTime(bgVolume * 0.25, sAt + 0.06);
          bg.setValueAtTime(bgVolume * 0.25, sEnd);
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

      // If this is a video, send WebM to server for FFmpeg MP4 conversion
      if (isVideo && outBlob.size > 1000) {
        try {
          const formData = new FormData();
          formData.append('video', outBlob, 'recording.webm');
          onProgress?.(0.95);
          const resp = await fetch('/api/render-mp4', { method: 'POST', body: formData });
          if (resp.ok) {
            const mp4Blob = await resp.blob();
            if (mp4Blob.size > 1000) {
              console.log(`[Export] MP4 conversion: ${(mp4Blob.size / 1024 / 1024).toFixed(1)}MB`);
              return { blob: mp4Blob, ext: 'mp4' };
            }
          }
          const errData = await resp.json().catch(() => ({}));
          console.warn('[Export] MP4 conversion failed, using WebM:', errData.error);
        } catch (err) {
          console.warn('[Export] MP4 conversion error, using WebM:', err);
        }
      }

      const ext = mimeType.includes('mp4') ? (isVideo ? 'mp4' : 'm4a') : isVideo ? 'webm' : 'webm';
      return { blob: outBlob, ext };
    } catch (err) {
      console.error('Export failed:', err);
      throw err;
    } finally {
      if (exportRafId) cancelAnimationFrame(exportRafId);
      handle?.restore();
      setIsVocalRemoval(false);
      el.pause();
      el.currentTime = 0;
      setCurrentTime(0);
      exportBusyRef.current = false;
    }
  };

  useImperativeHandle(ref, () => ({
    exportDubbed: (onProgress?: (p: number) => void) => exportDubbedInternal(onProgress),
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
            <p className="text-sm font-semibold text-stone-300">Audio Track Playing</p>
            <p className="text-xs text-stone-500 mt-1">Live subtitles synchronized below</p>
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

            <button
              id="player-toggle-mute"
              type="button"
              onClick={toggleMute}
              className="p-1.5 sm:p-2 rounded-lg text-stone-400 hover:text-white hover:bg-stone-800 transition-colors"
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4" />}
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

            {/* Vocal Removal Toggle (compact) */}
            <button
              id="player-toggle-vocal-removal"
              type="button"
              onClick={toggleVocalRemoval}
              className={`px-2 py-1 sm:px-2.5 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-semibold flex items-center gap-1 sm:gap-1.5 whitespace-nowrap shrink-0 transition-all ${
                isVocalRemoval
                  ? 'bg-purple-600 text-white shadow-sm ring-1 ring-purple-400'
                  : 'text-stone-400 hover:text-white hover:bg-stone-800'
              }`}
              title={isVocalRemoval ? 'Voice Removed (Music Only)' : 'Remove Voice (Keep Music)'}
            >
              <MicOff className="w-3.5 h-3.5 shrink-0" />
              <span>{isVocalRemoval ? 'Music' : 'No Voice'}</span>
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

            {/* Subtitle Size Controls (A− / reset / A+) */}
            {showSubtitles && (
              <div
                className="flex items-center bg-stone-900 border border-stone-800 rounded-lg"
                title="Subtitle size"
              >
                <button
                  id="subtitle-size-decrease"
                  type="button"
                  onPointerDown={() => startSizeHold(-0.1)}
                  onPointerUp={endSizeHold}
                  onPointerLeave={endSizeHold}
                  onPointerCancel={endSizeHold}
                  disabled={subtitleScale <= 0}
                  className="px-2 py-1.5 text-xs font-bold text-orange-300 hover:text-white hover:bg-orange-600/40 rounded-l-lg transition-colors disabled:opacity-30 active:bg-orange-600/60"
                  title="តូចជាង (កាន់ជាប់ = តូចជាបន្តបន្ទាប់)"
                >
                  A−
                </button>
                <button
                  id="subtitle-size-reset"
                  type="button"
                  onClick={resetSubtitleScale}
                  className="px-1 py-1 text-[10px] font-mono text-stone-500 hover:text-white transition-colors min-w-[34px]"
                  title="Reset (100%)"
                >
                  {Math.round(subtitleScale * 100)}%
                </button>
                <button
                  id="subtitle-size-increase"
                  type="button"
                  onPointerDown={() => startSizeHold(0.1)}
                  onPointerUp={endSizeHold}
                  onPointerLeave={endSizeHold}
                  onPointerCancel={endSizeHold}
                  disabled={subtitleScale >= 2.5}
                  className="px-2 py-1.5 text-sm font-bold text-orange-300 hover:text-white hover:bg-orange-600/40 rounded-r-lg transition-colors disabled:opacity-30 active:bg-orange-600/60"
                  title="ធំជាង (កាន់ជាប់ = ធំជាបន្តបន្ទាប់)"
                >
                  A+
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
                className="flex-1 max-w-[80px] h-1 accent-orange-500"
                title={`AI Voice: ${Math.round(voiceVolume * 100)}%`}
              />
              <span className="text-[10px] font-mono text-orange-400 w-8">
                {Math.round(voiceVolume * 100)}%
              </span>
            </div>
            {/* Background Music Volume */}
            <div className="flex items-center gap-1.5 flex-1 min-w-[130px]">
              <Music className="w-3.5 h-3.5 text-purple-400 shrink-0" />
              <input
                id="bg-volume-slider"
                type="range"
                min="0"
                max="100"
                value={Math.round(bgVolume * 100)}
                onChange={(e) => {
                  const vol = parseInt(e.target.value) / 100;
                  setBgVolume(vol);
                  const el = mediaPlayerRef.current;
                  if (el && isAiVoiceDubbing) {
                    el.volume = activeSegment?.dubbedAudioBase64 ? vol * 0.3 : vol;
                  }
                }}
                className="flex-1 max-w-[80px] h-1 accent-purple-500"
                title={`Background Music: ${Math.round(bgVolume * 100)}%`}
              />
              <span className="text-[10px] font-mono text-purple-400 w-8">
                {Math.round(bgVolume * 100)}%
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

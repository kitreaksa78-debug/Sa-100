import React, { useEffect, useRef } from 'react';
import { Mic } from 'lucide-react';
import { attachLipSync, detachLipSync } from '../utils/lipSync';
import { UILang, UI_TEXT } from '../data/translations';

interface TalkingAvatarProps {
  enabled: boolean;
  /** The audio element currently playing dubbed speech (null when none). */
  audioEl: HTMLAudioElement | null;
  /** True while a subtitle segment with speech is active on the timeline. */
  speaking: boolean;
  uiLang: UILang;
}

/**
 * A friendly "AI presenter" avatar. When `audioEl` is playing, its mouth opens
 * and closes from a real-time analysis of that audio (true lip-sync). When
 * only segment timing is known (no audio analysis), it pulses while a segment
 * is active. Animation happens via direct DOM/SVG mutation inside a rAF loop
 * (no per-frame React re-renders).
 */
export const TalkingAvatar: React.FC<TalkingAvatarProps> = ({
  enabled,
  audioEl,
  speaking,
  uiLang,
}) => {
  const t = UI_TEXT[uiLang];
  const mouthRef = useRef<SVGRectElement | null>(null);
  const headRef = useRef<SVGGElement | null>(null);
  const eyeLRef = useRef<SVGGElement | null>(null);
  const eyeRRef = useRef<SVGGElement | null>(null);
  const levelRef = useRef<(() => number) | null>(null);
  const speakingRef = useRef(speaking);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const enabledRef = useRef(enabled);

  speakingRef.current = speaking;
  enabledRef.current = enabled;

  // (Re)attach the analyser whenever the dubbed audio element changes.
  useEffect(() => {
    if (audioEl) {
      levelRef.current = attachLipSync(audioEl);
      audioElRef.current = audioEl;
    } else {
      if (audioElRef.current) {
        detachLipSync(audioElRef.current);
        audioElRef.current = null;
      }
      levelRef.current = null;
    }
  }, [audioEl]);

  // rAF animation loop — direct DOM mutation, no React state churn.
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let lastBlink = performance.now();
    const blinkEvery = 2600 + Math.random() * 1800;
    let blinkUntil = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!enabledRef.current) return;

      const levelReader = levelRef.current;
      let level = 0;
      if (levelReader && audioElRef.current && !audioElRef.current.paused) {
        level = levelReader();
      } else if (speakingRef.current) {
        // No analyzable audio: natural talking pulse while a segment is active.
        level = 0.3 + 0.25 * Math.sin(now / 130) + 0.15 * Math.sin(now / 47);
        level = Math.min(1, Math.max(0.08, level));
      }

      // Mouth: height scales with level (closed ≈ thin smile).
      const mouth = mouthRef.current;
      if (mouth) {
        const open = Math.min(1, level * 1.35);
        const h = 4 + open * 26;
        mouth.setAttribute('height', String(h));
        mouth.setAttribute('y', String(58 - h + 4));
        mouth.setAttribute('rx', String(3 + open * 6));
      }

      // Head bob while talking.
      const head = headRef.current;
      if (head) {
        const bob = level > 0.06 ? Math.sin(now / 160) * 1.6 : 0;
        head.setAttribute('transform', `translate(0 ${bob.toFixed(2)})`);
      }

      // Eye blink.
      const eyeL = eyeLRef.current;
      const eyeR = eyeRRef.current;
      if (eyeL && eyeR) {
        if (now - lastBlink > blinkEvery) {
          lastBlink = now;
          blinkUntil = now + 140;
        }
        const blinking = now < blinkUntil;
        const sy = blinking ? 0.12 : 1;
        // Scale around each eye's center so the blink looks natural.
        eyeL.setAttribute('transform', `translate(38 42) scale(1 ${sy}) translate(-38 -42)`);
        eyeR.setAttribute('transform', `translate(62 42) scale(1 ${sy}) translate(-62 -42)`);
      }
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);

  useEffect(() => {
    return () => {
      if (audioElRef.current) detachLipSync(audioElRef.current);
    };
  }, []);

  if (!enabled) return null;

  return (
    <div className="flex flex-col items-center gap-1 select-none pointer-events-none">
      <div className="relative rounded-2xl bg-gradient-to-b from-stone-800/95 to-stone-900/95 backdrop-blur border border-orange-500/25 shadow-xl shadow-black/40 p-2.5 pb-1.5">
        <svg width="96" height="96" viewBox="0 0 100 100" aria-hidden>
          {/* Head */}
          <g ref={headRef}>
            <circle cx="50" cy="48" r="36" fill="url(#avGrad)" stroke="rgba(255,255,255,0.18)" strokeWidth="1.5" />
            {/* Ears */}
            <circle cx="14" cy="48" r="6" fill="#f59e0b" opacity="0.85" />
            <circle cx="86" cy="48" r="6" fill="#f59e0b" opacity="0.85" />
            {/* Eyes */}
            <g ref={eyeLRef}>
              <circle cx="38" cy="42" r="6.5" fill="#fff" />
              <circle cx="39.5" cy="43" r="3" fill="#292524" />
            </g>
            <g ref={eyeRRef}>
              <circle cx="62" cy="42" r="6.5" fill="#fff" />
              <circle cx="63.5" cy="43" r="3" fill="#292524" />
            </g>
            {/* Eyebrows */}
            <path d="M30 33 q8 -5 16 -1" stroke="#292524" strokeWidth="2.2" fill="none" strokeLinecap="round" />
            <path d="M54 32 q8 -4 16 1" stroke="#292524" strokeWidth="2.2" fill="none" strokeLinecap="round" />
            {/* Nose */}
            <path d="M48 46 q3 4 0 8" stroke="#b45309" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.7" />
            {/* Mouth */}
            <rect ref={mouthRef} x="36" y="56" width="28" height="6" rx="3" fill="#292524" />
            {/* Blush */}
            <circle cx="27" cy="52" r="5" fill="#fdba74" opacity="0.45" />
            <circle cx="73" cy="52" r="5" fill="#fdba74" opacity="0.45" />
          </g>
          <defs>
            <linearGradient id="avGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#fb923c" />
              <stop offset="55%" stopColor="#f59e0b" />
              <stop offset="100%" stopColor="#ea580c" />
            </linearGradient>
          </defs>
        </svg>
        {/* Small live badge */}
        <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-emerald-500 ring-2 ring-stone-900 flex items-center justify-center">
          <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
        </span>
      </div>
      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-orange-100 bg-stone-900/80 rounded-full px-2 py-0.5 border border-orange-500/20">
        <Mic className="w-2.5 h-2.5 text-orange-400" />
        {t.avatarLabel}
      </span>
    </div>
  );
};
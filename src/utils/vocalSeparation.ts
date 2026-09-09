/**
 * vocalSeparation.ts
 *
 * Client-side "smart audio" helpers — no external API, no keys. They implement
 * the classic karaoke DSP that powers the site's intelligent translation:
 *
 *  • Vocals in a stereo mix are almost always panned to the CENTER.
 *  • Left − Right cancels the center → an instrumental ("music-only") estimate.
 *  • (L + R) / 2 mono-sum adds the center up and cancels wide-panned music, so
 *    speech/singing gets emphasized relative to the band — exactly the track
 *    Whisper should transcribe (lyrics come out clean, noise/effects/ambience
 *    are not transcribed).
 *
 * MONO / dual-mono sources (L ≡ R, very common for phone recordings) cannot be
 * separated with this math, so callers get `separable: false` and keep the
 * original audio — zero regression, no broken exports.
 */

import { pickAudioBitrate, pickSupportedAudioMime, recordStream } from './mediaCompress';

const MAX_BPS = 64_000;
const PASS_TARGET_BYTES = 3.4 * 1024 * 1024;
const PASS_FLOOR_BPS = 16_000;
// Dual-mono detection: if the L/R channels are this similar they are the same
// signal, and L−R would produce pure silence instead of an instrumental.
const DUAL_MONO_CORRELATION = 0.97;
// Peak RMS below this means the "vocals" track is actually silence.
const SILENCE_RMS = 0.005;

export interface VocalSeparationResult {
  /** True when stereo separation was possible; caller uses `blob`. */
  separable: boolean;
  /** Vocals-emphasized mono track (only set when separable). */
  blob: Blob | null;
  /** True when the extracted vocal track carried no audible program material. */
  silent: boolean;
}

/**
 * True when the decoded buffer is true stereo (L ≠ R), i.e. the center-cancel
 * math can separate vocals from music. Mono and dual-mono return false.
 */
export function isSeparableBuffer(buffer: AudioBuffer): boolean {
  if (!buffer || buffer.numberOfChannels < 2) return false;
  const len = buffer.length;
  if (len < 1024) return false;
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);

  // Sample the middle of the clip (start/end are often fade-in/out silence).
  const start = Math.floor(len * 0.25);
  const end = Math.floor(len * 0.75);
  const step = Math.max(1, Math.floor((end - start) / 20_000)); // cap the work
  let sumL2 = 0;
  let sumR2 = 0;
  let sumLR = 0;
  let n = 0;
  for (let i = start; i < end; i += step) {
    const x = l[i];
    const y = r[i];
    sumL2 += x * x;
    sumR2 += y * y;
    sumLR += x * y;
    n++;
  }
  if (n === 0) return false;
  const denom = Math.sqrt(sumL2 * sumR2);
  if (denom < 1e-9) return false; // one channel is pure silence — keep original
  const corr = sumLR / denom;
  return corr < DUAL_MONO_CORRELATION;
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext || (window as any).webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

/**
 * Render the (L+R)/2 mono-sum of a decoded stereo buffer into a compact audio
 * blob — the vocals-emphasized track Whisper should transcribe.
 */
async function renderVocalTrack(
  ctx: AudioContext,
  buffer: AudioBuffer,
  durationSeconds: number,
  onProgress?: (fraction: number) => void
): Promise<{ blob: Blob; maxRms: number } | null> {
  const mime = pickSupportedAudioMime();
  if (!mime) return null;

  const bitrate = pickAudioBitrate(durationSeconds, PASS_TARGET_BYTES, PASS_FLOOR_BPS);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const splitter = ctx.createChannelSplitter(2);
  const gL = ctx.createGain();
  const gR = ctx.createGain();
  gL.gain.value = 0.5;
  gR.gain.value = 0.5;
  const merger = ctx.createChannelMerger(1);
  const analyser = ctx.createAnalyser();
  const dest = ctx.createMediaStreamDestination();

  source.connect(splitter);
  splitter.connect(gL, 0);
  splitter.connect(gR, 1);
  gL.connect(merger, 0, 0);
  gR.connect(merger, 0, 0);
  merger.connect(analyser);
  analyser.connect(dest);

  const recording = recordStream(dest.stream, durationSeconds * 1000, bitrate, onProgress, analyser);
  source.start();

  const result = await recording;
  try { source.disconnect(); } catch { /* noop */ }
  try { splitter.disconnect(); } catch { /* noop */ }
  try { gL.disconnect(); } catch { /* noop */ }
  try { gR.disconnect(); } catch { /* noop */ }
  try { merger.disconnect(); } catch { /* noop */ }
  try { analyser.disconnect(); } catch { /* noop */ }
  try { dest.disconnect(); } catch { /* noop */ }
  return result;
}

/**
 * Smart-audio preprocess for transcription:
 *  - Decodes the source, checks whether vocals can be separated (true stereo).
 *  - If yes → returns the vocals-emphasized mono track (Whisper hears lyrics,
 *    not the band). If no → `separable: false`, caller uploads the original.
 *  - Runs in real time (≈ clip duration), reporting progress for the UI.
 */
export async function extractVocalEmphasizedAudio(
  blob: Blob | File,
  onProgress?: (fraction: number) => void
): Promise<VocalSeparationResult | null> {
  const ctx = getAudioContext();
  if (!ctx || typeof MediaRecorder === 'undefined' || !pickSupportedAudioMime()) return null;

  try {
    try {
      await ctx.resume();
    } catch {
      /* some browsers refuse until a gesture — keep going */
    }
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (!isSeparableBuffer(buffer)) {
      return { separable: false, blob: null, silent: false };
    }
    const track = await renderVocalTrack(ctx, buffer, buffer.duration, onProgress);
    if (!track || track.blob.size <= 2000) {
      return { separable: false, blob: null, silent: false };
    }
    return {
      separable: true,
      blob: track.blob,
      silent: track.maxRms < SILENCE_RMS,
    };
  } catch (err) {
    console.warn('Vocal separation unavailable; transcription will use the original audio:', err);
    return null;
  } finally {
    setTimeout(() => {
      try { ctx.close(); } catch { /* noop */ }
    }, 2000);
  }
}
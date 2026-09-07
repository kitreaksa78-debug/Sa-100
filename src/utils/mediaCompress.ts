/**
 * mediaCompress.ts
 *
 * The hosted serverless API rejects request bodies over ~4.5 MB
 * (HTTP 413 FUNCTION_PAYLOAD_TOO_LARGE). Whisper only needs the audio
 * track, so oversized media is decoded and re-encoded in the browser as
 * low-bitrate mono audio (Opus in WebM, or AAC in MP4 where WebM is
 * unsupported, e.g. Safari/iOS).
 *
 * The audio bitrate is derived from the clip duration so the encoded file
 * lands well inside the upload guardrail. If the first pass still overshoots
 * (unusually long clips), a second, lower-bitrate pass runs automatically,
 * which keeps even ~70-minute clips safely under the cap — so any video up
 * to ~50 MB can be transcribed.
 *
 * IMPORTANT — video capture: the <video> element is started muted (required
 * by the autoplay policy), then unmuted *before* creating the
 * MediaElementSource node. In Chromium, capturing while muted yields silence
 * (crbug.com/40717757), which makes Whisper transcribe garbage. Unmuting
 * before the source node is created keeps the captured signal intact while
 * the element's output is rerouted into the Web Audio graph — which is never
 * connected to ctx.destination, so nothing is audible to the user.
 *
 * The capture is also monitored with an AnalyserNode: if the loudest level
 * across the whole clip is effectively silent, the caller is told via the
 * returned `silent` flag so it can show a clear message instead of feeding
 * silence to Whisper.
 *
 * Returns { blob, silent } or null when compression is unsupported/fails.
 */

const MB = 1024 * 1024;

// Multipart form uploads add a little overhead on top of the raw body, so a
// generated clip must stay comfortably below the ~4.5 MB serverless cap.
const SAFE_UPLOAD_BYTES = 4.2 * MB;

// Pass 1: good speech quality (Opus stays intelligible down to ~16 kbps).
const PASS1_TARGET_BYTES = 3.4 * MB;
const PASS1_MIN_BPS = 16_000;

// Pass 2 (only runs if pass 1 overshoots): pushes the floor down to ~8 kbps
// so even ~70-minute clips fit inside the upload guardrail.
const PASS2_TARGET_BYTES = 2.6 * MB;
const PASS2_MIN_BPS = 8_000;

const MAX_BPS = 64_000;

// Peak RMS below this (≈ -46 dBFS) means the captured track carries no
// audible program material — transcription would only produce hallucinations.
const SILENCE_RMS = 0.005;

export interface ShrunkMedia {
  blob: Blob;
  /** True when the captured audio was effectively silent (no speech/music). */
  silent: boolean;
}

/** Pick an audio bitrate that keeps the clip under the target byte budget. */
function pickAudioBitrate(durationSeconds: number, targetBytes: number, floorBps: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 48_000;
  const targetBps = Math.floor((targetBytes * 8) / durationSeconds);
  return Math.min(MAX_BPS, Math.max(floorBps, targetBps));
}

function pickSupportedAudioMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((mime) => MediaRecorder.isTypeSupported(mime)) || '';
}

/** Current RMS of the signal entering the analyser (0 = silence). */
function sampleRms(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

function recordStream(
  stream: MediaStream,
  durationMs: number,
  audioBitsPerSecond: number,
  onProgress?: (fraction: number) => void,
  analyser?: AnalyserNode | null
): Promise<{ blob: Blob; maxRms: number }> {
  return new Promise((resolve) => {
    const mimeType = pickSupportedAudioMime();
    const options: MediaRecorderOptions = { audioBitsPerSecond };
    if (mimeType) options.mimeType = mimeType;
    const recorder = new MediaRecorder(stream, options);
    const chunks: Blob[] = [];
    const start = performance.now();
    let maxRms = 0;

    const stopRecorder = () => {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        /* noop */
      }
    };

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => {
      stopRecorder();
    };
    recorder.onstop = () => {
      if (progressTimer !== null) {
        window.clearInterval(progressTimer);
        progressTimer = null;
      }
      if (onProgress) onProgress(1);
      resolve({ blob: new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }), maxRms });
    };

    // Report live progress (compression takes roughly as long as the clip, so
    // the UI needs a percentage to show the user it is still working), and
    // sample the input level to detect silent captures.
    let progressTimer: number | null = null;
    if (onProgress || analyser) {
      progressTimer = window.setInterval(() => {
        if (analyser) {
          const rms = sampleRms(analyser);
          if (rms > maxRms) maxRms = rms;
        }
        if (onProgress) {
          const elapsed = performance.now() - start;
          onProgress(Math.min(1, elapsed / Math.max(durationMs, 1)));
        }
      }, 500);
    }

    recorder.start(500);
    // Stop shortly after the source finishes playing.
    setTimeout(stopRecorder, Math.min(Math.max(durationMs + 2500, 2500), 2_147_483_647));
  });
}

function isLikelyVideo(file: File | Blob): boolean {
  if (file.type.startsWith('video/')) return true;
  if (file instanceof File && /\.(mp4|mov|webm|m4v|mkv|3gp|avi)$/i.test(file.name)) return true;
  return false;
}

function loadVideoElement(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true; // start muted to satisfy the autoplay policy
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    const timer = setTimeout(() => reject(new Error('media metadata timeout')), 20_000);
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve(video);
    };
    video.onerror = () => {
      clearTimeout(timer);
      reject(new Error('could not load media'));
    };
  });
}

function createBareVideoElement(url: string): HTMLVideoElement {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  return video;
}

/** Record one full pass of an in-memory decoded audio buffer at the given bitrate. */
async function captureBufferPass(
  ctx: AudioContext,
  buffer: AudioBuffer,
  durationSeconds: number,
  bitrateBps: number,
  onProgress?: (fraction: number) => void
): Promise<{ blob: Blob; maxRms: number }> {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const analyser = ctx.createAnalyser();
  const dest = ctx.createMediaStreamDestination();
  source.connect(analyser);
  analyser.connect(dest);
  const recording = recordStream(dest.stream, durationSeconds * 1000, bitrateBps, onProgress, analyser);
  source.start();
  return recording;
}

/** Record one full playback pass of a <video> element's audio track. */
async function captureElementPass(
  ctx: AudioContext,
  video: HTMLVideoElement,
  durationSeconds: number,
  bitrateBps: number,
  onProgress?: (fraction: number) => void
): Promise<{ blob: Blob; maxRms: number }> {
  // Start playback muted (autoplay policy), then unmute BEFORE creating the
  // MediaElementSource — capturing while muted produces silence in Chromium.
  // After createMediaElementSource the element's audio only flows through the
  // graph (never connected to ctx.destination), so nothing is audible.
  video.muted = true;
  const playPromise = video.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => {
      /* playback may be blocked; the silent check will catch it */
    });
  }
  try {
    await playPromise;
  } catch {
    /* noop — proceed; the silent check will catch it */
  }
  video.muted = false;

  const source = ctx.createMediaElementSource(video);
  const analyser = ctx.createAnalyser();
  const dest = ctx.createMediaStreamDestination();
  source.connect(analyser);
  analyser.connect(dest);
  const recording = recordStream(dest.stream, durationSeconds * 1000, bitrateBps, onProgress, analyser);

  const result = await recording;
  try {
    video.pause();
  } catch {
    /* noop */
  }
  try {
    source.disconnect();
  } catch {
    /* noop */
  }
  try {
    analyser.disconnect();
  } catch {
    /* noop */
  }
  try {
    dest.disconnect();
  } catch {
    /* noop */
  }
  return result;
}

export async function shrinkMediaToAudio(
  file: File | Blob,
  onProgress?: (fraction: number) => void
): Promise<ShrunkMedia | null> {
  if (typeof window === 'undefined') return null;
  const AudioCtx: typeof AudioContext | undefined =
    window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx || typeof MediaRecorder === 'undefined') return null;
  if (!pickSupportedAudioMime()) return null;

  let ctx: AudioContext | null = null;
  let videoUrl: string | null = null;
  try {
    const ac = new AudioCtx();
    ctx = ac;
    try {
      await ac.resume();
    } catch {
      /* some browsers refuse until a gesture; keep going */
    }

    const isVideo = isLikelyVideo(file);
    let durationSeconds = 0;
    let audioBuffer: AudioBuffer | null = null;
    let firstVideoElement: HTMLVideoElement | null = null;

    if (isVideo) {
      // --- Video file: pull the audio track only --------------------------
      videoUrl = URL.createObjectURL(file);
      firstVideoElement = await loadVideoElement(videoUrl);
      if (!Number.isFinite(firstVideoElement.duration) || firstVideoElement.duration <= 0) {
        return null;
      }
      durationSeconds = firstVideoElement.duration;
    } else {
      // --- Audio file: decode and re-encode -------------------------------
      audioBuffer = await ac.decodeAudioData(await file.arrayBuffer());
      durationSeconds = audioBuffer.duration;
    }

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;

    const passes = [
      { targetBytes: PASS1_TARGET_BYTES, floorBps: PASS1_MIN_BPS },
      { targetBytes: PASS2_TARGET_BYTES, floorBps: PASS2_MIN_BPS },
    ];

    let last: { blob: Blob; maxRms: number } | null = null;
    let usedFirstVideoElement = false;

    for (const pass of passes) {
      const bitrateBps = pickAudioBitrate(durationSeconds, pass.targetBytes, pass.floorBps);
      let result: { blob: Blob; maxRms: number } | null = null;

      if (!isVideo && audioBuffer) {
        result = await captureBufferPass(ac, audioBuffer, durationSeconds, bitrateBps, onProgress);
      } else if (!usedFirstVideoElement && firstVideoElement) {
        // First video pass reuses the metadata-loaded element.
        result = await captureElementPass(ac, firstVideoElement, durationSeconds, bitrateBps, onProgress);
        usedFirstVideoElement = true;
      } else if (videoUrl) {
        // Rare retry pass: a fresh element plays the same clip from 0 again.
        const retryElement = createBareVideoElement(videoUrl);
        result = await captureElementPass(ac, retryElement, durationSeconds, bitrateBps, onProgress);
      }

      if (result && result.blob.size > 2000) {
        last = result;
        // Success: the clip now fits inside the serverless upload guardrail.
        if (result.blob.size <= SAFE_UPLOAD_BYTES) break;
      }
    }

    if (!last) return null;
    return { blob: last.blob, silent: last.maxRms < SILENCE_RMS };
  } catch (err) {
    console.warn('Could not shrink media to audio; upload handled by caller:', err);
    return null;
  } finally {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    if (ctx) {
      const context = ctx;
      setTimeout(() => {
        try {
          context.close();
        } catch {
          /* noop */
        }
      }, 2000);
    }
  }
}
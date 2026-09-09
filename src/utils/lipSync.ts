// lipSync.ts
// Analyzes a playing audio element's real-time level so a talking avatar can
// open/close its mouth in sync with the words being spoken. Uses the Web Audio
// AnalyserNode (time-domain RMS) with smoothing for natural motion.
//
// Only attaches to the offscreen "dubbed audio" elements (created fresh per
// segment), so there is never a duplicate MediaElementSourceNode conflict with
// the main media element (which audioEngine.ts already taps).

type Graph = { ctx: AudioContext; analyser: AnalyserNode };

const graphs = new WeakMap<HTMLMediaElement, Graph>();

function makeLevelReader(analyser: AnalyserNode): () => number {
  const data = new Uint8Array(analyser.fftSize);
  let smooth = 0;
  return () => {
    try {
      analyser.getByteTimeDomainData(data);
    } catch {
      return 0;
    }
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    // Silence ≈ 0.01 RMS; speech/music is much higher. Map to 0..1 openness.
    const target = Math.min(1, Math.max(0, (rms - 0.02) * 6));
    smooth = smooth * 0.72 + target * 0.28;
    return smooth;
  };
}

/** Attach analysis to an audio element; returns a getter for the current 0..1 level. */
export function attachLipSync(el: HTMLAudioElement): (() => number) | null {
  try {
    const existing = graphs.get(el);
    if (existing) return makeLevelReader(existing.analyser);

    const AudioCtx: typeof AudioContext =
      window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return null;

    const ctx = new AudioCtx();
    // Playback starts from a user gesture, so the context can run.
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
    const source = ctx.createMediaElementSource(el);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    analyser.connect(ctx.destination); // keep the audio audible
    graphs.set(el, { ctx, analyser });
    return makeLevelReader(analyser);
  } catch {
    return null;
  }
}

/** Tear down the analyser graph for an element (call when it stops playing). */
export function detachLipSync(el: HTMLMediaElement): void {
  const g = graphs.get(el);
  if (g) {
    try {
      g.ctx.close();
    } catch {
      /* noop */
    }
    graphs.delete(el);
  }
}
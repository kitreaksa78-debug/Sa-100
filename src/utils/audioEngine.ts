// audioEngine.ts
// Singleton Web Audio graph manager — one AudioContext per media element.
// Both vocal removal and video export tap the SAME MediaElementSource,
// avoiding the browser error "HTMLMediaElement already connected to a
// different MediaElementSourceNode".

type Graph = {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
};

const graphs = new WeakMap<HTMLMediaElement, Graph>();

let vocalNodes: { nodes: AudioNode[] } | null = null;

/** Get (or create) the shared AudioContext + source node for a media element. */
export function ensureGraph(el: HTMLMediaElement): Graph {
  let g = graphs.get(el);
  if (!g) {
    const AudioCtx: typeof AudioContext =
      window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioCtx();
    const source = ctx.createMediaElementSource(el);
    source.connect(ctx.destination); // default direct path
    g = { ctx, source };
    graphs.set(el, g);
  }
  if (g.ctx.state === 'suspended') {
    void g.ctx.resume();
  }
  return g;
}

/** Tear down any existing vocal-removal path and reconnect direct output. */
function teardownVocal(source: MediaElementAudioSourceNode, ctx: AudioContext) {
  if (!vocalNodes) return;
  try { source.disconnect(); } catch { /* noop */ }
  vocalNodes.nodes.forEach((n) => {
    try { n.disconnect(); } catch { /* noop */ }
  });
  vocalNodes = null;
  source.connect(ctx.destination);
}

/**
 * Build the classic karaoke center-cancel network: L−R on the left output and
 * R−L on the right. Center-panned vocals cancel out; wide-panned music stays.
 * Returns the list of created nodes (the last one is the network's output).
 */
function createCenterCancelNetwork(ctx: AudioContext): AudioNode[] {
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  const gL = ctx.createGain();
  const gR = ctx.createGain();
  const invR = ctx.createGain(); invR.gain.value = -1;
  const invL = ctx.createGain(); invL.gain.value = -1;

  // L_out = L - R   (cancels center-panned vocals)
  splitter.connect(gL, 0);
  splitter.connect(invR, 1);
  gL.connect(merger, 0, 0);
  invR.connect(merger, 0, 0);

  // R_out = R - L
  splitter.connect(gR, 1);
  splitter.connect(invL, 0);
  gR.connect(merger, 0, 1);
  invL.connect(merger, 0, 1);

  return [splitter, merger, gL, gR, invL, invR];
}

/**
 * Enable/disable center-channel vocal cancellation.
 * Returns the resulting enabled state.
 */
export function setVocalRemoval(el: HTMLMediaElement, enabled: boolean): boolean {
  const g = ensureGraph(el);
  const { ctx, source } = g;

  teardownVocal(source, ctx);
  if (!enabled) return false;

  const nodes = createCenterCancelNetwork(ctx);
  const merger = nodes[1]; // [splitter, merger, ...]
  const splitter = nodes[0];

  source.disconnect();
  source.connect(splitter);
  merger.connect(ctx.destination);

  vocalNodes = { nodes };
  return true;
}

export type ExportPath = {
  ctx: AudioContext;
  bgGain: GainNode;
  voiceGain: GainNode;
  mixDest: MediaStreamAudioDestinationNode;
  restore: () => void;
};

/**
 * Build an export audio path:
 *   element → bgGain → (speakers + recorder mix)
 *   voiceGain → (speakers + recorder mix)
 * Used during "Export Dubbed Video" so the recorded track contains the
 * ducked background music plus the scheduled AI voice segments.
 */
export function buildExportPath(
  el: HTMLMediaElement,
  bgVolume: number,
  voiceVolume: number,
  removeVocals = false
): ExportPath {
  const g = ensureGraph(el);
  const { ctx, source } = g;

  teardownVocal(source, ctx);
  try { source.disconnect(); } catch { /* noop */ }

  const bgGain = ctx.createGain();
  bgGain.gain.value = bgVolume;
  const voiceGain = ctx.createGain();
  voiceGain.gain.value = voiceVolume;
  const mixDest = ctx.createMediaStreamDestination();

  if (removeVocals) {
    // Original voice removed (center-cancel) → only the music/ambience reaches
    // the background bus, then the translated AI voice is mixed on top.
    const nodes = createCenterCancelNetwork(ctx);
    const splitter = nodes[0];
    const merger = nodes[1];
    source.connect(splitter);
    merger.connect(bgGain);
  } else {
    source.connect(bgGain);
  }

  bgGain.connect(ctx.destination); // user hears while exporting
  bgGain.connect(mixDest);         // recorded
  voiceGain.connect(ctx.destination);
  voiceGain.connect(mixDest);

  return {
    ctx,
    bgGain,
    voiceGain,
    mixDest,
    restore: () => {
      try { source.disconnect(); } catch { /* noop */ }
      try { bgGain.disconnect(); } catch { /* noop */ }
      try { voiceGain.disconnect(); } catch { /* noop */ }
      source.connect(ctx.destination);
    },
  };
}

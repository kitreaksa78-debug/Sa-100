/**
 * mp4Job.ts — client for the server-side "Generate Edited MP4" pipeline.
 *
 * The original video is uploaded to the Express backend (disk-backed), the
 * translated AI voice clips are scheduled on the original timeline, mixed with
 * the preserved background audio by FFmpeg, and muxed with the original video
 * stream (copied when compatible, H.264 re-encode otherwise) into a real
 * H.264+AAC MP4 (+faststart). No browser recording is involved.
 *
 * Flow:
 *   POST /api/video/upload        → { jobId }
 *   POST /api/video/process       → starts the FFmpeg job
 *   GET  /api/video/status/:id    → { status, progress, message }
 *   GET  /api/video/download/:id  → the actual generated .mp4 file
 */

import { apiUrl } from './api';
import { TranscriptionResult } from '../types';

export interface ServerMp4Result {
  url: string;
  ext: string;
  size: number;
  filename: string;
}

export interface Mp4JobOptions {
  selectedFile: File | null;
  mediaPreviewUrl: string | null;
  mediaType: 'video' | 'audio' | null;
  targetLanguage: string;
  removeVocals: boolean;
  setExportStep?: (step: string | null) => void;
  setExportProgress?: (fraction: number) => void;
  groqKey?: string;
}

/** Step labels are translated by the caller via setExportStep. */
export type Mp4JobPhase =
  | 'uploading'
  | 'analyzing'
  | 'detecting'
  | 'translating'
  | 'tts'
  | 'mixing'
  | 'rendering'
  | 'preparing';

function phaseToProgress(phase: Mp4JobPhase): number {
  switch (phase) {
    case 'uploading': return 0.05;
    case 'analyzing': return 0.15;
    case 'detecting': return 0.3;
    case 'translating': return 0.45;
    case 'tts': return 0.55;
    case 'mixing': return 0.62;
    case 'rendering': return 0.7;
    case 'preparing': return 0.95;
  }
}

async function fetchBlobFromUrl(url: string): Promise<Blob | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

/** Resolve the ORIGINAL media (the real file, not the shrunk audio). */
async function resolveOriginalMedia(opts: Mp4JobOptions): Promise<File | null> {
  if (opts.selectedFile) return opts.selectedFile;
  if (opts.mediaPreviewUrl) {
    const blob = await fetchBlobFromUrl(opts.mediaPreviewUrl);
    if (blob) {
      const ext = opts.mediaType === 'video' ? 'mp4' : 'm4a';
      return new File([blob], `original-${Date.now()}.${ext}`, {
        type: blob.type || (opts.mediaType === 'video' ? 'video/mp4' : 'audio/mp4'),
      });
    }
  }
  return null;
}

/** Start the server job and poll until done; returns the MP4 download info. */
export async function exportEditedMp4ServerSide(
  result: TranscriptionResult,
  opts: Mp4JobOptions
): Promise<ServerMp4Result | null> {
  const { setExportStep, setExportProgress } = opts;
  const step = (phase: Mp4JobPhase) => setExportStep?.(phase);
  const progress = (p: number) => setExportProgress?.(Math.max(0, Math.min(1, p)));

  step('uploading');
  progress(0.02);

  // 1. Probe whether the server pipeline exists at all (cheap GET).
  let caps: { ffmpeg?: boolean } | null = null;
  try {
    const res = await fetch(apiUrl('video/capabilities'));
    if (res.ok) caps = await res.json();
  } catch {
    /* endpoint missing → serverless deploy, fall back to the client export */
  }
  if (!caps?.ffmpeg) return null;

  // 2. Upload the ORIGINAL media (full quality, never the shrunk audio).
  const media = await resolveOriginalMedia(opts);
  if (!media) throw new Error('No original media available for MP4 generation');

  const headers: Record<string, string> = {};
  if (opts.groqKey?.trim()) headers['x-groq-api-key'] = opts.groqKey.trim();

  const form = new FormData();
  form.append('video', media, media.name || 'original.mp4');
  const upRes = await fetch(apiUrl('video/upload'), { method: 'POST', body: form });
  if (!upRes.ok) {
    const err = await upRes.json().catch(() => ({}));
    throw new Error(err.error || `Upload failed (${upRes.status})`);
  }
  const { jobId, hasVideo } = (await upRes.json()) as { jobId: string; hasVideo?: boolean };
  if (!jobId) throw new Error('Upload did not return a jobId');

  // 3. Kick off processing with the translated segments + dubbed audio.
  step('analyzing');
  const segments = result.segments.map((s) => ({
    id: s.id,
    start: s.start,
    end: s.end,
    translatedText: s.translatedText,
    dubbedAudioBase64: s.dubbedAudioBase64,
  }));
  const procRes = await fetch(apiUrl('video/process'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      jobId,
      segments,
      removeVocals: opts.removeVocals,
      targetLanguage: opts.targetLanguage,
    }),
  });
  if (!procRes.ok) {
    const err = await procRes.json().catch(() => ({}));
    throw new Error(err.error || `Process failed (${procRes.status})`);
  }

  // 4. Poll the job status until done/error.
  const started = Date.now();
  const TIMEOUT_MS = 20 * 60 * 1000; // matches the server FFmpeg timeout
  while (Date.now() - started < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 1500));
    let status: any = null;
    try {
      const res = await fetch(apiUrl(`video/status/${jobId}`));
      if (res.ok) status = await res.json();
    } catch {
      /* transient network hiccup — keep polling */
    }
    if (!status) continue;
    if (status.status === 'done') {
      step('preparing');
      progress(0.97);
      const size = Number(status.size) || 0;
      const filename = status.downloadFilename || `translated-${opts.targetLanguage}.mp4`;
      return {
        url: apiUrl(`video/download/${jobId}`),
        ext: hasVideo === false ? 'm4a' : 'mp4',
        size,
        filename,
      };
    }
    if (status.status === 'error') {
      throw new Error(status.error || 'MP4 generation failed on the server');
    }
    // Map the server message onto a UI phase.
    const msg = String(status.message || '').toLowerCase();
    if (msg.includes('render')) step('rendering');
    else if (msg.includes('mix')) step('mixing');
    else if (msg.includes('generating translated audio') || msg.includes('clip')) step('tts');
    else if (msg.includes('extract')) step('analyzing');
    else if (msg.includes('analyz')) step('analyzing');
    progress(0.05 + Math.min(0.9, (Number(status.progress) || 0) / 100) * 0.9);
  }
  throw new Error('MP4 generation timed out');
}

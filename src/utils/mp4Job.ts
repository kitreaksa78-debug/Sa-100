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
 *   GET  /api/video/download/:id  → the actual generated .mp4/.m4a file
 *
 * On serverless (4.5 MB body limit) large files are uploaded via a chunked
 * JSON protocol (init / chunk / finish) that re-assembles on the server.
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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    r.onerror = () => reject(r.error || new Error('base64 read failed'));
    r.readAsDataURL(blob);
  });
}

/**
 * Chunked uploader for serverless (bypasses the ~4.5 MB body limit).
 * Protocol: init → chunk* → finish  on the same endpoint `video/upload`.
 */
async function uploadChunked(
  media: File,
  onProgress?: (fraction: number) => void
): Promise<{ jobId: string; hasVideo?: boolean }> {
  // keep each JSON body well under 4.5 MB (750 KB binary → ~1 MB base64 + overhead)
  const CHUNK = 750 * 1024;
  const totalChunks = Math.max(1, Math.ceil(media.size / CHUNK));

  const initRes = await fetch(apiUrl('video/upload'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'init', name: media.name, mime: media.type, size: media.size }),
  });
  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({}));
    throw new Error(err.error || `Upload init failed (${initRes.status})`);
  }
  const { jobId } = (await initRes.json()) as { jobId: string };
  if (!jobId) throw new Error('Upload init did not return a jobId');

  for (let i = 0; i < totalChunks; i++) {
    const slice = media.slice(i * CHUNK, (i + 1) * CHUNK);
    const data = await blobToBase64(slice);
    const res = await fetch(apiUrl('video/upload'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'chunk', jobId, index: i, data }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Upload chunk ${i} failed (${res.status})`);
    }
    onProgress?.((i + 1) / totalChunks);
  }

  const finRes = await fetch(apiUrl('video/upload'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'finish', jobId }),
  });
  if (!finRes.ok) {
    const err = await finRes.json().catch(() => ({}));
    throw new Error(err.error || `Upload finish failed (${finRes.status})`);
  }
  const finJson = (await finRes.json().catch(() => ({}))) as { hasVideo?: boolean; ok?: boolean };
  // finish may not return hasVideo in some deploys — treat missing as undefined
  return { jobId, hasVideo: finJson.hasVideo };
}

async function uploadMultipart(media: File): Promise<{ jobId: string; hasVideo?: boolean }> {
  const form = new FormData();
  form.append('video', media, media.name || 'original.mp4');
  const res = await fetch(apiUrl('video/upload'), { method: 'POST', body: form });
  if (!res.ok) {
    // let caller decide whether to fall back to chunked on 413
    const err = await res.json().catch(() => ({}));
    const e: any = new Error(err.error || `Upload failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return (await res.json()) as { jobId: string; hasVideo?: boolean };
}

/** Start the server job and poll until done; returns the MP4/M4A download info. */
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
  let caps: { ffmpeg?: boolean; chunked?: boolean } | null = null;
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

  // Serverless allows only ~4.2 MB per request body. Prefer the chunked
  // protocol for anything over ~3 MB in production; in preview (Express)
  // the multipart path is faster and supports up to 200 MB.
  const SERVERLESS_CHUNK_THRESHOLD = 3 * 1024 * 1024;
  const shouldChunkFirst = Boolean(caps?.chunked) && media.size > SERVERLESS_CHUNK_THRESHOLD;

  let jobId = '';
  let hasVideo: boolean | undefined = undefined;

  if (shouldChunkFirst) {
    const r = await uploadChunked(media, (f) => progress(0.02 + f * 0.28));
    jobId = r.jobId;
    hasVideo = r.hasVideo;
  } else {
    try {
      const r = await uploadMultipart(media);
      jobId = r.jobId;
      hasVideo = r.hasVideo;
    } catch (e: any) {
      // Fallback to chunked when the platform rejects the multipart body (413)
      const is413 = e?.status === 413 || String(e?.message || '').includes('413');
      if (is413 && caps?.chunked) {
        const r2 = await uploadChunked(media, (f) => progress(0.02 + f * 0.28));
        jobId = r2.jobId;
        hasVideo = r2.hasVideo;
      } else {
        throw e;
      }
    }
  }

  if (!jobId) throw new Error('Upload did not return a jobId');
  // infer hasVideo from original file when server did not return it (chunked finish)
  if (hasVideo === undefined) {
    const t = (media.type || '').toLowerCase();
    const n = (media.name || '').toLowerCase();
    hasVideo = t.startsWith('video/') || /\.(mp4|webm|mov|mkv|m4v)$/.test(n);
  }

  // 3. Kick off processing with the translated segments + dubbed audio.
  step('analyzing');
  progress(0.32);
  const headers: Record<string, string> = {};
  if (opts.groqKey?.trim()) headers['x-groq-api-key'] = opts.groqKey.trim();

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
  // Server uses query-param style on serverless: /api/index.py?route=video/status&jobId=xxx
  // and path-param style on Express: /api/video/status/:id — support both.
  const statusUrl = (id: string) => apiUrl(`video/status/${id}`) + (apiUrl(`video/status/${id}`).includes('?') ? `&jobId=${encodeURIComponent(id)}` : `?jobId=${encodeURIComponent(id)}`);
  const downloadUrl = (id: string) => {
    const base = apiUrl(`video/download/${id}`);
    return base.includes('?') ? `${base}&jobId=${encodeURIComponent(id)}` : `${base}?jobId=${encodeURIComponent(id)}`;
  };

  const started = Date.now();
  const TIMEOUT_MS = 20 * 60 * 1000; // matches the server FFmpeg timeout
  while (Date.now() - started < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 1500));
    let status: any = null;
    try {
      const res = await fetch(statusUrl(jobId));
      if (res.ok) status = await res.json();
    } catch {
      /* transient network hiccup — keep polling */
    }
    if (!status) continue;
    if (status.status === 'done') {
      step('preparing');
      progress(0.97);
      const size = Number(status.size) || 0;
      const extFallback = hasVideo === false ? 'm4a' : 'mp4';
      const filename =
        status.downloadFilename || `translated-${opts.targetLanguage}.${extFallback}`;
      // Prefer server-provided ext (audio → m4a) but fall back to hasVideo
      const extFromName = filename.toLowerCase().endsWith('.m4a') ? 'm4a' : hasVideo === false ? 'm4a' : 'mp4';
      return {
        url: downloadUrl(jobId),
        ext: extFromName,
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

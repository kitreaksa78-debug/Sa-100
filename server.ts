import "dotenv/config";
import dotenv from "dotenv";
// Load platform-managed secrets (GROQ_API_KEY, GROQ_API_KEY2, GROQ_API_KEY3, ...)
// dotenv never overrides already-set env vars, so this is a safe supplement.
dotenv.config({ path: ".env.local" });
import express from "express";
import multer from "multer";
import { createServer as createViteServer } from "vite";
import https from "https";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, unlink, mkdtemp, stat, mkdir, rename } from "fs/promises";
import { createReadStream, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { EdgeTTS as NodeEdgeTTS } from "node-edge-tts";

const execFileAsync = promisify(execFile);

const PORT = 3000;
const app = express();
// Accepts raw uploads up to 50 MB (frontend normally shrinks larger files to
// audio first, but allow the full claimed size in case a browser cannot).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 52_428_800 } });
const uploadLarge = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB for video render

// --- Server-side video job store (real FFmpeg MP4 generation) ---
type VideoJobStatus = 'queued' | 'uploading' | 'processing' | 'done' | 'error';
type PipelineStage =
  | 'extract_audio'
  | 'detect_speakers'
  | 'detect_speech'
  | 'transcribe'
  | 'translate_khmer'
  | 'generate_voices'
  | 'sync_audio'
  | 'mix_audio'
  | 'render_mp4';

interface VideoJob {
  id: string;
  status: VideoJobStatus;
  currentStage?: PipelineStage | null;
  stepNumber?: number; // 1..9
  failedStage?: PipelineStage | null;
  progress: number; // 0..100
  message: string;
  createdAt: number;
  inputPath?: string;
  outputPath?: string;
  error?: string;
  originalName?: string;
  downloadFilename?: string;
  hasVideo?: boolean;
  size?: number;
  targetLanguage?: string;
  sourceLanguage?: string;
  removeVocals?: boolean;
  segments?: ProcessSegment[];
  detectedLanguage?: string;
  extractedAudioPath?: string;
  /** Mix console levels applied by the FFmpeg pipeline. */
  voiceGain?: number;
  bgGain?: number;
  duckDepth?: string;
}
interface ProcessSegment {
  id: number;
  start: number;
  end: number;
  originalText?: string;
  translatedText?: string;
  isSpeech?: boolean;
  soundType?: 'dialogue' | 'music' | 'sfx' | 'ambient' | 'noise';
  speakerId?: string;
  speakerName?: string;
  speakerGender?: 'male' | 'female';
  voiceId?: string;
  dubbedAudioBase64?: string;
  audioDuration?: number;
}
const videoJobs = new Map<string, VideoJob>();
const JOBS_ROOT = join(tmpdir(), 'video-jobs');
const VIDEO_UPLOAD_LIMIT = 200 * 1024 * 1024; // 200 MB for MP4 generation
const uploadsDir = join(JOBS_ROOT, 'uploads');
// Cleanup old jobs (older than 90 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of videoJobs.entries()) {
    if (now - job.createdAt > 90 * 60 * 1000) {
      import('fs/promises').then(fs => fs.rm(join(JOBS_ROOT, id), { recursive: true, force: true }).catch(()=>{}));
      videoJobs.delete(id);
    }
  }
}, 10 * 60 * 1000);

// Disk-backed upload storage so a large MP4 never has to fit in RAM.
function ensureJobDirs(): void {
  try { mkdirSync(JOBS_ROOT, { recursive: true }); } catch { /* noop */ }
  try { mkdirSync(uploadsDir, { recursive: true }); } catch { /* noop */ }
}
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { ensureJobDirs(); cb(null, uploadsDir); },
    filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`),
  }),
  limits: { fileSize: VIDEO_UPLOAD_LIMIT },
});

// Detect FFmpeg once at startup; the capabilities endpoint reports it so the
// client can show a clear server-config error when it is missing.
let FFMPEG_AVAILABLE = false;
void (async () => {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 15_000 });
    FFMPEG_AVAILABLE = true;
    console.log("[VideoJobs] FFmpeg available — server-side MP4 generation enabled");
  } catch {
    FFMPEG_AVAILABLE = false;
    console.warn("[VideoJobs] FFmpeg NOT found — server-side MP4 generation disabled");
  }
})();

// In-memory rotation order for environment GROQ keys. When a key is exhausted
// (rate limit / quota / server error) it is moved to the end of this list, so
// subsequent requests start with the key that still works: key1 → key2 → key3.
let envKeyOrder: string[] = ["GROQ_API_KEY", "GROQ_API_KEY2", "GROQ_API_KEY3"];

/** Move the env key that produced `key` to the back of the rotation. */
function rotateKeyToBack(key: string): void {
  const idx = envKeyOrder.findIndex((name) => process.env[name]?.trim() === key);
  if (idx >= 0 && envKeyOrder.length > 1) {
    const [name] = envKeyOrder.splice(idx, 1);
    envKeyOrder.push(name);
  }
}

function getAllGroqKeys(req: any): string[] {
  const keys: string[] = [];
  // User-provided key from the client takes priority
  const headerKey = req.headers["x-groq-api-key"] as string | undefined;
  if (headerKey?.trim()) keys.push(headerKey.trim());
  // Then env keys in current rotation order (1, 2, 3 by default)
  for (const envKey of envKeyOrder) {
    const val = process.env[envKey]?.trim();
    if (val && !keys.includes(val)) keys.push(val);
  }
  return keys;
}

// Gemini API keys (GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3) live only
// in server environment variables. Quota is per Google project, so each env key
// should belong to a different project. Rotation works the same as Groq.
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_FALLBACK_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash"];
let geminiKeyOrder: string[] = ["GEMINI_API_KEY", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3"];

function rotateGeminiKeyToBack(key: string): void {
  const idx = geminiKeyOrder.findIndex((name) => process.env[name]?.trim() === key);
  if (idx >= 0 && geminiKeyOrder.length > 1) {
    const [name] = geminiKeyOrder.splice(idx, 1);
    geminiKeyOrder.push(name);
  }
}

function getGeminiKeys(): string[] {
  const keys: string[] = [];
  for (const envKey of geminiKeyOrder) {
    const val = process.env[envKey]?.trim();
    if (val && !keys.includes(val)) keys.push(val);
  }
  return keys;
}

async function geminiGenerate(keys: string[], model: string, prompt: string): Promise<Response> {
  let lastErr: any;
  for (const key of keys) {
    try {
      const res = await fetch(
        `${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
          }),
        }
      );
      if (res.ok) return res;
      await res.text().catch(() => "");
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Gemini HTTP ${res.status}`);
        rotateGeminiKeyToBack(key);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      rotateGeminiKeyToBack(key);
    }
  }
  throw lastErr || new Error("All Gemini API keys failed");
}

async function tryGeminiModels(keys: string[], model: string, prompt: string): Promise<any | null> {
  // Try the selected Gemini model, then built-in flash fallbacks. Shapes the
  // response like an OpenAI chat completion so parseTranslatedLines works unchanged.
  const candidates = [model, ...GEMINI_FALLBACK_MODELS].filter((m, i, arr) => arr.indexOf(m) === i);
  for (const candidate of candidates) {
    try {
      const res = await geminiGenerate(keys, candidate, prompt);
      if (res.ok) {
        const data: any = await res.json();
        const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
        const text = parts.map((p) => p?.text || "").join("").trim();
        if (text) return { choices: [{ message: { content: text } }] };
      } else {
        await res.text().catch(() => "");
        console.warn(`[Translate] Gemini ${candidate} returned ${res.status}`);
      }
    } catch (err: any) {
      console.warn(`[Translate] Gemini ${candidate} failed:`, err?.message);
      continue;
    }
  }
  return null;
}

async function fetchWithKeyFallback(
  url: string,
  keys: string[],
  options: Omit<RequestInit, "headers"> & { headers?: Record<string, string> }
): Promise<{ res: Response; key: string }> {
  let lastErr: any;
  for (const key of keys) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${key}` },
      });
      if (res.ok) return { res, key };
      // Always consume the body to avoid connection leaks
      const errBody = await res.text().catch(() => "");
      // On rate-limit (429), server errors (5xx), or model errors (404/403), try next key
      if (res.status === 429 || res.status >= 500 || res.status === 404 || res.status === 403) {
        lastErr = new Error(`HTTP ${res.status} with key ...${key.slice(-6)}: ${errBody.slice(0, 200)}`);
        rotateKeyToBack(key);
        continue;
      }
      // Other client errors (401, 400 etc) - return as-is
      return { res, key };
    } catch (err) {
      lastErr = err;
      rotateKeyToBack(key);
    }
  }
  throw lastErr || new Error("All API keys failed");
}

// --- Translation helpers (verify output is actually in the target language) ---

const DEFAULT_TRANSLATION_MODEL = "openai/gpt-oss-120b";

// Scripts that prove a line is written in the target language. Latin-script
// targets (en, vi, …) cannot be verified this way and always pass.
const TARGET_SCRIPT: Record<string, RegExp> = {
  km: /[\u1780-\u17FF]/,
  zh: /[\u4E00-\u9FFF]/,
  ja: /[\u3040-\u30FF\u4E00-\u9FFF]/,
  ko: /[\uAC00-\uD7AF]/,
  th: /[\u0E00-\u0E7F]/,
  ru: /[\u0400-\u04FF]/,
  ar: /[\u0600-\u06FF]/,
  hi: /[\u0900-\u097F]/,
};

function lineInTargetScript(line: string, targetLanguage: string): boolean {
  const regex = TARGET_SCRIPT[targetLanguage];
  if (!regex) return true;
  return regex.test(line);
}

function parseTranslatedLines(content: string): string[] {
  const trimmed = content.trim();
  // Models sometimes return a JSON array of strings — parse it directly.
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        return arr
          .map((x) => (typeof x === "string" ? x.trim() : String(x).trim()))
          .filter((l) => l.length > 0);
      }
    } catch {
      // Not valid JSON — fall through to line-based parsing.
    }
  }
  return content
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*(?:\d+\s*[\.\)\]:]|[-*•])\s*/, "")
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
        .trim()
    )
    .filter((l) => l.length > 0);
}

function buildTranslationPrompt(
  sourceLanguage: string,
  targetLanguage: string,
  targetLanguageName: string,
  segments: any[]
): string {
  const langPair = `${sourceLanguage} → ${targetLanguage}`;
  const fullText = segments.map((s: any) => s.originalText || "").join(" ");
  const numbered = segments.map((s: any, i: number) => `${i + 1}. ${s.originalText || ""}`).join("\n");
  return `You are a professional subtitle translator creating natural speech for dubbing. Translate each numbered segment below from ${langPair} (${targetLanguageName || targetLanguage}). Write the way a real person would speak aloud in ${targetLanguage}: natural word order, conversational tone, and clear, easy-to-listen sentences — never a literal word-for-word rendering. Keep each line short enough to fit subtitle timing. Every translated line MUST be written in the target language (${targetLanguage}) script — never repeat the source-language text. Use the full transcript below as context so short or ambiguous segments are translated naturally and consistently. Keep the numbering and return ONLY the translated text lines, one per segment, preserving blank lines between segments.\n\nFull transcript: \"${fullText}\"\n\n${numbered}`;
}

function buildForcedTranslationPrompt(
  sourceLanguage: string,
  targetLanguage: string,
  targetLanguageName: string,
  segments: any[]
): string {
  const numbered = segments.map((s: any, i: number) => `${i + 1}. ${s.originalText || ""}`).join("\n");
  return `Translate the following subtitle segments from ${sourceLanguage} to ${targetLanguage} (${targetLanguageName || targetLanguage}). Write each line the way a real person would speak it aloud: natural, conversational, easy to listen to, short enough for subtitle timing — never literal word-for-word. Every line MUST be written in the target language's script — never repeat the original-language text. Return one translation per line, numbered to match the input, with no extra text.\n\n${numbered}`;
}

async function tryChatModels(apiKeys: string[], model: string, prompt: string): Promise<any | null> {
  const modelsToTry = [model, "openai/gpt-oss-120b", "openai/gpt-oss-20b"].filter((m, i, arr) => arr.indexOf(m) === i);
  for (const candidate of modelsToTry) {
    try {
      const result = await fetchWithKeyFallback(
        "https://api.groq.com/openai/v1/chat/completions",
        apiKeys,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: candidate,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
            max_tokens: 4096,
          }),
        }
      );
      if (result.res.ok) {
        return await result.res.json();
      }
      await result.res.text().catch(() => "");
      console.warn(`[Translate] Model ${candidate} returned ${result.res.status}`);
    } catch (err: any) {
      console.warn(`[Translate] Model ${candidate} failed:`, err?.message);
      continue;
    }
  }
  return null;
}

/**
 * Translate every segment, then verify each line is actually written in the
 * target language's script. Lines that came back untranslated (echoed, empty,
 * or still in the source language) are retried with a strict instruction —
 * first with the user-selected model, then with alternative models — so the
 * displayed translation always respects the user's target-language setting.
 * Provider (Groq vs Gemini) is chosen from the model id prefix (`gemini/`).
 */
async function translateSegmentsWithFallback(
  apiKeys: string[],
  model: string,
  sourceLanguage: string,
  targetLanguage: string,
  targetLanguageName: string,
  segments: any[]
): Promise<string[]> {
  const lines: string[] = [];
  let pending = segments.map((_, i) => i);

  // Models prefixed `gemini/` use the Gemini API; everything else uses Groq.
  const callProvider = (m: string, prompt: string) =>
    m.startsWith("gemini/")
      ? tryGeminiModels(getGeminiKeys(), m.slice("gemini/".length), prompt)
      : tryChatModels(apiKeys, m, prompt);

  // Run one model+prompt pass over the pending segments, keeping lines that
  // pass the target-script check and re-queueing the rest for another pass.
  const runPass = async (m: string, buildPrompt: (sub: any[]) => string) => {
    if (pending.length === 0) return;
    const prompt = buildPrompt(pending.map((i) => segments[i]));
    const chatData = await callProvider(m, prompt);
    const got = chatData
      ? parseTranslatedLines(chatData.choices?.[0]?.message?.content || "")
      : [];
    const still: number[] = [];
    pending.forEach((idx, j) => {
      if (j < got.length && got[j].trim() && lineInTargetScript(got[j], targetLanguage)) {
        lines[idx] = got[j];
      } else {
        still.push(idx);
      }
    });
    pending = still;
  };

  // Pass 1: normal translation prompt with the user-selected model.
  await runPass(model, (sub) =>
    buildTranslationPrompt(sourceLanguage, targetLanguage, targetLanguageName, sub)
  );
  // Pass 2: strict forced prompt with the user-selected model.
  await runPass(model, (sub) =>
    buildForcedTranslationPrompt(sourceLanguage, targetLanguage, targetLanguageName, sub)
  );
  // Pass 3+: strict forced prompt with alternative models, so a model that
  // keeps echoing the source language gets replaced by one that actually
  // writes in the target language's script.
  const alternatives = model.startsWith("gemini/")
    ? ["gemini/gemini-3.6-flash", "gemini/gemini-3.5-flash"]
    : [
        DEFAULT_TRANSLATION_MODEL,
        "qwen/qwen3.8-27b",
        "qwen/qwen3.6-27b",
        "groq/compound-mini",
        "openai/gpt-oss-20b",
      ];
  const uniqueAlternatives = alternatives.filter((m, i, arr) => arr.indexOf(m) === i && m !== model);
  for (const alt of uniqueAlternatives) {
    if (pending.length === 0) break;
    await runPass(alt, (sub) =>
      buildForcedTranslationPrompt(sourceLanguage, targetLanguage, targetLanguageName, sub)
    );
  }

  if (pending.length > 0) {
    console.warn(
      `[Translate] ${pending.length}/${segments.length} segment(s) could not be verified in target language "${targetLanguage}"`
    );
  }
  return lines;
}

// Microsoft Edge neural TTS — natural, human-like voices (free).
const EDGE_TTS_VOICES: Record<string, string> = {
  km: "km-KH-PisethNeural", // Khmer (male)
  en: "en-US-AndrewNeural", // English (male)
  zh: "zh-CN-XiaoxiaoNeural", // Chinese (female)
  ja: "ja-JP-NanamiNeural", // Japanese (female)
  ko: "ko-KR-SunHiNeural", // Korean (female)
  th: "th-TH-PremwadeeNeural", // Thai (female)
  vi: "vi-VN-HoaiMyNeural", // Vietnamese (female)
  fr: "fr-FR-DeniseNeural", // French (female)
  es: "es-ES-ElviraNeural", // Spanish (female)
  de: "de-DE-KatjaNeural", // German (female)
  id: "id-ID-GadisNeural", // Indonesian (female)
  ru: "ru-RU-SvetlanaNeural", // Russian (female)
  ar: "ar-SA-ZariyahNeural", // Arabic (female)
  hi: "hi-IN-SwaraNeural", // Hindi (female)
  it: "it-IT-ElsaNeural", // Italian (female)
  pt: "pt-PT-RaquelNeural", // Portuguese (female)
};

async function edgeTTS(
  text: string,
  voiceOrLang: string,
  options?: { rate?: string; pitch?: string }
): Promise<Buffer | null> {
  const voice = voiceOrLang.includes("-")
    ? voiceOrLang
    : (EDGE_TTS_VOICES[voiceOrLang] || "km-KH-PisethNeural");
  const tmpFile = join(tmpdir(), `tts-${randomUUID()}.mp3`);
  try {
    const tts = new NodeEdgeTTS({
      voice,
      rate: options?.rate || "+0%",
      pitch: options?.pitch || "+0Hz",
    });
    await tts.ttsPromise(text.trim(), tmpFile);
    const buf = await readFile(tmpFile);
    try { await unlink(tmpFile); } catch { /* noop */ }
    return buf.length > 0 ? buf : null;
  } catch (err: any) {
    console.warn(`[NodeEdgeTTS] failed for ${voice}:`, err?.message);
    try { await unlink(tmpFile); } catch { /* noop */ }
    return null;
  }
}

// Google Translate TTS (free, supports 50+ languages including Khmer)
function fetchGoogleTTSChunk(text: string, lang: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(text.trim());
    // Natural speed for human-like voice (no ttsspeed param = normal)
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${lang}&client=tw-ob`;
    const req = https.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Google TTS returned ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Google TTS timeout"));
    });
  });
}

// Split text into natural sentences for better pacing
function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation (Khmer ។ and universal !?.)
  return text.split(/[។!?.]+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

// Generate natural-sounding audio by splitting into sentences with pauses
// Uses natural speech speed (client-side playbackRate handles timing sync)
async function googleTTS(text: string, lang: string): Promise<Buffer> {
  const sentences = splitSentences(text.trim());
  if (sentences.length === 0) {
    // Single chunk fallback
    return fetchGoogleTTSChunk(text.trim(), lang);
  }

  const buffers: Buffer[] = [];
  // Generate 200ms silence as MP3 frames for natural pause between sentences
  const silenceMs = 200;
  const silence = Buffer.alloc(Math.floor(24000 * silenceMs / 1000 / 8), 0);

  for (const sentence of sentences) {
    try {
      const chunk = await fetchGoogleTTSChunk(sentence, lang);
      buffers.push(chunk);
      // Only add pause between sentences (not after the last one)
      if (sentence !== sentences[sentences.length - 1]) {
        buffers.push(silence);
      }
    } catch {
      // Skip failed chunks, continue with others
    }
  }

  if (buffers.length === 0) {
    throw new Error("All TTS chunks failed");
  }

  return Buffer.concat(buffers);
}

// --- API Routes ---

app.get("/api/status", (_req, res) => {
  res.json({
    groqConfigured: Boolean(
      process.env.GROQ_API_KEY?.trim() ||
      process.env.GROQ_API_KEY2?.trim() ||
      process.env.GROQ_API_KEY3?.trim()
    ),
    geminiConfigured: Boolean(
      process.env.GEMINI_API_KEY?.trim() ||
      process.env.GEMINI_API_KEY_2?.trim() ||
      process.env.GEMINI_API_KEY_3?.trim()
    ),
  });
});

app.get("/api/check-groq-keys", async (_req, res) => {
  // Probe each environment Groq key (rotation order) and report health.
  // Never echoes key values — only per-key status.
  const results: { envKey: string; configured: boolean; ok: boolean; error?: string | null }[] = [];
  for (const envKey of envKeyOrder) {
    const value = process.env[envKey]?.trim() || "";
    if (!value) {
      results.push({ envKey, configured: false, ok: false, error: "not configured" });
      continue;
    }
    try {
      const r = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${value}` },
        signal: AbortSignal.timeout(20000),
      });
      results.push({ envKey, configured: true, ok: r.ok, error: r.ok ? null : `HTTP ${r.status}` });
    } catch (err: any) {
      results.push({ envKey, configured: true, ok: false, error: `network: ${err?.name || "error"}` });
    }
  }
  res.json({ keys: results, allOk: results.every((r) => r.ok) });
});

app.get("/api/check-gemini-keys", async (_req, res) => {
  // Probe each environment Gemini key (rotation order) and report health.
  // Never echoes key values — only per-key status. Also returns the model
  // catalog from the first working key so model ids can be verified.
  const results: { envKey: string; configured: boolean; ok: boolean; error?: string | null }[] = [];
  let models: string[] = [];
  for (const envKey of geminiKeyOrder) {
    const value = process.env[envKey]?.trim() || "";
    if (!value) {
      results.push({ envKey, configured: false, ok: false, error: "not configured" });
      continue;
    }
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(value)}`,
        { signal: AbortSignal.timeout(20000) }
      );
      if (r.ok && models.length === 0) {
        const data: any = await r.json();
        const ids: string[] = ((data?.models || []) as Array<{ name?: string }>)
          .map((m) => (m.name || "").split("/").pop() || "")
          .filter((s) => s.length > 0);
        models = [...new Set(ids)].sort();
      }
      results.push({ envKey, configured: true, ok: r.ok, error: r.ok ? null : `HTTP ${r.status}` });
    } catch (err: any) {
      results.push({ envKey, configured: true, ok: false, error: `network: ${err?.name || "error"}` });
    }
  }
  res.json({ keys: results, allOk: results.every((r) => r.ok), models });
});

app.get("/api/list-groq-models", async (_req, res) => {
  // List model ids available on Groq (first configured key that answers).
  // Never echoes key values. Used to verify model ids before exposing them.
  for (const envKey of envKeyOrder) {
    const value = process.env[envKey]?.trim() || "";
    if (!value) continue;
    try {
      const r = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${value}` },
        signal: AbortSignal.timeout(20000),
      });
      if (r.ok) {
        const data: any = await r.json();
        res.json({ models: (data?.data || []).map((m: any) => m.id).filter(Boolean) });
        return;
      }
    } catch {
      /* try next key */
    }
  }
  res.json({ models: [] });
});

app.post("/api/transcribe-and-translate", upload.single("file") as any, async (req: any, res) => {
  const apiKeys = getAllGroqKeys(req);
  if (apiKeys.length === 0) {
    res.status(400).json({ error: "Groq API key is required. Please provide one in Settings or via environment.", code: "MISSING_API_KEY" });
    return;
  }

  const file = req.file;
  const { whisperModel = "whisper-large-v3", translationModel = "openai/gpt-oss-120b", sourceLanguage = "auto", targetLanguage = "km", targetLanguageName = "Khmer" } = req.body;

  if (!file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  try {
    // Step 1: Transcribe with Groq Whisper
    const formData = new FormData();
    formData.append("file", new Blob([file.buffer], { type: file.mimetype }), file.originalname);
    formData.append("model", whisperModel);
    formData.append("response_format", "verbose_json");
    if (sourceLanguage && sourceLanguage !== "auto") {
      formData.append("language", sourceLanguage);
    }

    const { res: whisperRes } = await fetchWithKeyFallback(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      apiKeys,
      { method: "POST", body: formData }
    );

    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      throw new Error(`Whisper API error (${whisperRes.status}): ${errText}`);
    }

    const whisperData = await whisperRes.json() as any;
    const segments = (whisperData.segments || []).map((seg: any, i: number) => ({
      id: i + 1,
      start: seg.start,
      end: seg.end,
      originalText: seg.text?.trim() || "",
      translatedText: "",
    }));

    const detectedLanguage = whisperData.language || sourceLanguage;
    const fullOriginalText = segments.map((s: any) => s.originalText).join(" ");
    const duration = whisperData.duration || 0;
    const processingTimeMs = 0;

    // Step 2: Translate segments with the selected Groq model. Every line is
    // verified to be written in the target language's script, and lines that
    // come back untranslated (echoed, empty, or in the wrong language) are
    // retried with a strict prompt — so the displayed translation always
    // matches the user's chosen target language.
    const translatedLines = await translateSegmentsWithFallback(
      apiKeys,
      translationModel,
      detectedLanguage,
      targetLanguage,
      targetLanguageName,
      segments
    );

    segments.forEach((seg: any, i: number) => {
      seg.translatedText = translatedLines[i] || seg.originalText;
    });

    const fullTranslatedText = segments.map((s: any) => s.translatedText).join(" ");

    // Build SRT and VTT strings
    const srtOriginal = buildSrt(segments, false);
    const srtTranslated = buildSrt(segments, true);
    const vttOriginal = buildVtt(segments, false);
    const vttTranslated = buildVtt(segments, true);

    res.json({
      detectedLanguage,
      targetLanguage,
      targetLanguageName,
      duration,
      processingTimeMs,
      fullOriginalText,
      fullTranslatedText,
      segments,
      srtOriginal,
      srtTranslated,
      vttOriginal,
      vttTranslated,
    });
  } catch (err: any) {
    console.error("Transcription error:", err);
    res.status(500).json({ error: err.message || "Transcription failed" });
  }
});

app.post("/api/translate-segments", express.json(), async (req, res) => {
  const apiKeys = getAllGroqKeys(req);
  if (apiKeys.length === 0) {
    res.status(400).json({ error: "Groq API key is required.", code: "MISSING_API_KEY" });
    return;
  }

  const { segments, sourceLanguage, targetLanguage, targetLanguageName, translationModel = "openai/gpt-oss-120b" } = req.body;

  if (!segments || !Array.isArray(segments) || segments.length === 0) {
    res.status(400).json({ error: "No segments provided" });
    return;
  }

  try {
    // Translate every segment with the selected Groq model, verifying each
    // line is actually written in the target language's script (with strict
    // retries), so the re-translated text always matches the chosen target.
    const translatedLines = await translateSegmentsWithFallback(
      apiKeys,
      translationModel,
      sourceLanguage,
      targetLanguage,
      targetLanguageName,
      segments
    );

    segments.forEach((seg: any, i: number) => {
      seg.translatedText = translatedLines[i] || seg.originalText;
    });

    const fullTranslatedText = segments.map((s: any) => s.translatedText).join(" ");
    const srtTranslated = buildSrt(segments, true);
    const vttTranslated = buildVtt(segments, true);

    res.json({ segments, fullTranslatedText, srtTranslated, vttTranslated, targetLanguage, targetLanguageName });
  } catch (err: any) {
    console.error("Translation error:", err);
    res.status(500).json({ error: err.message || "Translation failed" });
  }
});

app.post("/api/tts", express.json(), async (req, res) => {
  const { text, language = "km" } = req.body;
  if (!text || !text.trim()) {
    res.status(400).json({ error: "No text provided" });
    return;
  }

  // 1. Edge TTS — natural neural voices (human-like speech)
  const edgeAudio = await edgeTTS(text.trim(), language);
  if (edgeAudio && edgeAudio.length > 100) {
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(edgeAudio);
    return;
  }

  // 2. Google Translate TTS (free, supports 50+ languages including Khmer)
  try {
    const audioBuffer = await googleTTS(text.trim(), language);
    if (audioBuffer.length > 100) {
      res.setHeader("Content-Type", "audio/mpeg");
      res.send(audioBuffer);
      return;
    }
  } catch (err: any) {
    console.warn(`[TTS] Google TTS failed for language ${language}:`, err?.message || err);
  }

  // 3. Fallback: Groq Orpheus (English only, higher quality)
  const ttsKeys = getAllGroqKeys(req);
  if (ttsKeys.length > 0) {
    try {
      const { res: ttsRes } = await fetchWithKeyFallback(
        "https://api.groq.com/openai/v1/audio/speech",
        ttsKeys,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "canopylabs/orpheus-v1-english",
            input: text.trim(),
            voice: "troy",
            response_format: "wav",
          }),
        }
      );
      if (ttsRes.ok) {
        const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
        res.setHeader("Content-Type", "audio/wav");
        res.send(audioBuffer);
        return;
      }
    } catch {
      // all keys exhausted - fall through to browser TTS fallback
    }
  }

  // 3. All options exhausted - signal client to use browser TTS fallback
  res.status(204).end();
});

// Batch TTS: generate audio for all subtitle segments for AI dubbing
app.post("/api/batch-tts", express.json(), async (req, res) => {
  const { segments, language = "km" } = req.body;
  if (!segments || !Array.isArray(segments) || segments.length === 0) {
    res.status(400).json({ error: "No segments provided" });
    return;
  }

  // Edge TTS + Google TTS are free and don't need Groq keys. Only Groq
  // Orpheus (English) uses Groq keys, so keep working when Groq is missing.
  const ttsKeys = getAllGroqKeys(req);

  const results: { id: number; start: number; end: number; audio: string }[] = [];

  for (const seg of segments) {
    if (!seg.translatedText?.trim()) continue;

    let audioBase64 = "";

    // 1. Edge TTS — natural neural voice (human-like)
    try {
      const edgeAudio = await edgeTTS(seg.translatedText.trim(), language);
      if (edgeAudio && edgeAudio.length > 100) {
        audioBase64 = edgeAudio.toString("base64");
      }
    } catch (err: any) {
      console.warn(`[BatchTTS] Edge TTS failed for seg ${seg.id}:`, err?.message);
    }

    // 2. Google Translate TTS (free, multilingual)
    if (!audioBase64) {
      try {
        const audioBuffer = await googleTTS(seg.translatedText.trim(), language);
        if (audioBuffer.length > 100) {
          audioBase64 = audioBuffer.toString("base64");
        }
      } catch (err: any) {
        console.warn(`[BatchTTS] Google TTS failed for seg ${seg.id}:`, err?.message);
      }
    }

    // 3. Fallback: Groq Orpheus (English only)
    if (!audioBase64 && ttsKeys.length > 0) {
      try {
        const { res: ttsRes } = await fetchWithKeyFallback(
          "https://api.groq.com/openai/v1/audio/speech",
          ttsKeys,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "canopylabs/orpheus-v1-english",
              input: seg.translatedText.trim(),
              voice: "troy",
              response_format: "wav",
            }),
          }
        );
        if (ttsRes.ok) {
          const buf = Buffer.from(await ttsRes.arrayBuffer());
          if (buf.length > 100) {
            audioBase64 = buf.toString("base64");
          }
        }
      } catch {
        // all keys exhausted for this segment
      }
    }

    results.push({
      id: seg.id,
      start: seg.start,
      end: seg.end,
      audio: audioBase64,
    });
  }

  res.json({ audio: results, fallback: false });
});

// --- Video Rendering: Convert WebM → MP4 (H.264 + AAC + yuv420p + faststart) ---
app.post("/api/render-mp4", uploadLarge.single("video") as any, async (req: any, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No video file provided" });
    return;
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "render-"));
  const inputPath = join(tmpDir, "input.webm");
  const outputPath = join(tmpDir, "output.mp4");

  try {
    // Write uploaded WebM to temp file
    await writeFile(inputPath, file.buffer);

    console.log(`[RenderMP4] Converting ${file.originalname} (${(file.size / 1024 / 1024).toFixed(1)}MB) → MP4...`);

    // FFmpeg: WebM → MP4 with H.264 + AAC + yuv420p + faststart
    await execFileAsync("ffmpeg", [
      "-i", inputPath,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ], { timeout: 120_000 });

    // Validate the output
    const { stdout: probeStdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,duration",
      "-of", "json",
      outputPath,
    ], { timeout: 10_000 });

    const probeData = JSON.parse(probeStdout);
    const videoStream = probeData.streams?.[0];

    if (!videoStream || !videoStream.codec_name) {
      throw new Error("FFmpeg produced no valid video stream");
    }

    // Check audio stream exists
    const { stdout: audioProbe } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_name",
      "-of", "json",
      outputPath,
    ], { timeout: 10_000 });
    const audioData = JSON.parse(audioProbe);
    if (!audioData.streams?.[0]) {
      throw new Error("FFmpeg produced no valid audio stream");
    }

    const mp4Buffer = await readFile(outputPath);
    if (mp4Buffer.length < 1000) {
      throw new Error("Output MP4 is too small to be valid");
    }

    const now = new Date();
    const filename = `translated-khmer-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}.mp4`;

    console.log(`[RenderMP4] Success: ${filename} (${(mp4Buffer.length / 1024 / 1024).toFixed(1)}MB, ${videoStream.width}x${videoStream.height}, ${videoStream.codec_name}+${audioData.streams[0].codec_name})`);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(mp4Buffer);
  } catch (err: any) {
    console.error("[RenderMP4] Error:", err);
    res.status(500).json({ error: err.message || "Video export failed. Please try again." });
  } finally {
    // Clean up temp files
    try { await unlink(inputPath); } catch {}
    try { await unlink(outputPath); } catch {}
    try { await import("fs/promises").then(fs => fs.rm(tmpDir, { recursive: true, force: true })); } catch {}
  }
});

// --- Server-side MP4 generation: real FFmpeg pipeline (no browser recording) ---
// The uploaded original video is stored on disk, then the translated AI voice
// clips are scheduled onto the original timeline and mixed with the preserved
// background audio, and finally muxed back with the original (or re-encoded)
// video stream into a real H.264+AAC MP4. No MediaRecorder / canvas capture.

function setJobProgress(id: string, progress: number, message: string): void {
  const job = videoJobs.get(id);
  if (!job) return;
  job.progress = Math.max(0, Math.min(100, Math.round(progress)));
  job.message = message;
}

function sniffAudioKind(buf: Buffer): 'mp3' | 'wav' {
  // RIFF -> WAV
  if (buf.length > 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'wav';
  // ID3 tag or MPEG sync word -> MP3
  if (buf.length > 4 && ((buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) || (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33))) return 'mp3';
  return 'mp3';
}

const MIME_EXT: Record<string, string> = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/m4v': 'm4v',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/flac': 'flac', 'audio/opus': 'opus',
};
function safeExt(mime: string | undefined, name: string | undefined): string {
  const fromMime = mime ? MIME_EXT[mime.toLowerCase()] : undefined;
  if (fromMime) return fromMime;
  const m = (name || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  const ext = m ? m[1] : '';
  return ['mp4','webm','mov','mkv','m4v','mp3','wav','m4a','aac','ogg','flac','opus'].includes(ext) ? ext : 'mp4';
}

function isVideoMime(mime: string | undefined, name: string | undefined): boolean {
  if ((mime || '').startsWith('video/')) return true;
  return /\.(mp4|webm|mov|mkv|m4v)$/i.test(name || '');
}

/** Run FFmpeg, parsing `-progress pipe:1` (out_time_us) for real render progress. */
function runFfmpegWithProgress(
  args: string[],
  totalDuration: number,
  onProgress: (fraction: number) => void,
  timeoutMs = 20 * 60 * 1000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
      reject(new Error('FFmpeg timed out'));
    }, timeoutMs);
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 60_000) stdout = stdout.slice(-20_000);
      const m = stdout.match(/out_time_us=(\d+)/g) || stdout.match(/out_time_ms=(\d+)/g);
      if (m && totalDuration > 0) {
        const last = m[m.length - 1];
        const us = Number(last.split('=')[1]);
        if (Number.isFinite(us) && us > 0) onProgress(Math.min(1, us / 1e6 / totalDuration));
      }
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 60_000) stderr = stderr.slice(-20_000);
    });
    proc.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-600)}`));
    });
  });
}

async function probeDuration(ffprobeArgs: string[]): Promise<number> {
  try {
    const res = await execFileAsync('ffprobe', ffprobeArgs, { timeout: 20_000 });
    const n = Number(res.stdout.trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function processVideoJob(jobId: string): Promise<void> {
  const job = videoJobs.get(jobId);
  if (!job || !job.inputPath) return;
  const jobDir = join(JOBS_ROOT, jobId);
  try {
    setJobProgress(jobId, 12, 'Analyzing media');

    // 1. Probe the original file
    const probeRes = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', job.inputPath,
    ], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    const info = JSON.parse(probeRes.stdout || '{}');
    const streams: any[] = info.streams || [];
    const vStream = streams.find((s) => s.codec_type === 'video');
    const aStream = streams.find((s) => s.codec_type === 'audio');
    const duration = Number(info.format?.duration || vStream?.duration || aStream?.duration || 0) || 0;
    job.hasVideo = Boolean(vStream);
    setJobProgress(jobId, 16, 'Extracting audio');

    // 2. Decode + probe the translated AI voice clips
    const segs: ProcessSegment[] = job.segments || [];
    const clips: { start: number; end: number; path: string; duration: number }[] = [];
    const withAudio = segs.filter((s) => (s.dubbedAudioBase64 || '').length > 100);
    for (let i = 0; i < withAudio.length; i++) {
      const seg = withAudio[i];
      try {
        const buf = Buffer.from(seg.dubbedAudioBase64 || '', 'base64');
        if (buf.length < 100) continue;
        const kind = sniffAudioKind(buf);
        const clipPath = join(jobDir, `clip_${String(clips.length).padStart(4, '0')}.${kind}`);
        await writeFile(clipPath, buf);
        const dur = await probeDuration(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', clipPath]);
        if (dur > 0.05) clips.push({ start: Math.max(0, seg.start), end: Math.max(seg.end, seg.start + 0.3), path: clipPath, duration: dur });
      } catch (err: any) {
        console.warn(`[VideoJobs] clip ${i} failed:`, err?.message);
      }
      setJobProgress(jobId, 20 + Math.round(25 * ((i + 1) / Math.max(withAudio.length, 1))), `Generating translated audio (${i + 1}/${withAudio.length})`);
    }

    setJobProgress(jobId, 50, 'Mixing audio');

    // 3. Build the FFmpeg mix + mux command
    const args: string[] = ['-y', '-i', job.inputPath];
    for (const c of clips) args.push('-i', c.path);
    const filters: string[] = [];
    const hasAudio = Boolean(aStream);
    const stereo = (aStream?.channels || 0) >= 2;
    const applyCenterCancel = job.removeVocals === true && stereo;

    if (hasAudio) {
      // Background bus. True-stereo sources get the original speaker removed by
      // cancelling the center channel (speech is almost always center-panned),
      // leaving music / ambience / SFX intact; mono & dual-mono sources keep the
      // full track because the math cannot separate them. User-set background
      // gain is applied right here (mix console → final MP4).
      const bgGain = typeof job.bgGain === 'number' && job.bgGain !== 1 ? `,volume=${job.bgGain.toFixed(3)}` : '';
      filters.push(
        applyCenterCancel
          ? `[0:a]aformat=channel_layouts=stereo,aresample=48000,pan=stereo|c0=c0-c1|c1=c1-c0${bgGain}[bg0]`
          : `[0:a]aformat=channel_layouts=stereo,aresample=48000${bgGain}[bg0]`
      );
    }

    // Build atempo chain that covers any stretch ratio via FFmpeg's 0.5-2.0 per-filter range.
    // This makes the dubbed voice EXACTLY fill its Whisper segment (100% sync) instead of
    // clamping to 0.85-2.0 and leaving gaps/overlaps.
    const buildAtempo = (rate: number): string => {
      if (Math.abs(rate - 1) < 0.015) return '';
      const parts: string[] = [];
      let r = rate;
      let guard = 0;
      while (r > 2.0 && guard < 6) { parts.push('atempo=2.0'); r /= 2; guard++; }
      while (r < 0.5 && guard < 6) { parts.push('atempo=0.5'); r /= 0.5; guard++; }
      parts.push(`atempo=${r.toFixed(4)}`);
      return ',' + parts.join(',');
    };
    // Build the per-clip chain: stretch the TTS clip so it EXACTLY fills its
    // Whisper segment (100% lip-sync), pad/trim to the segment window, fade the
    // edges so the voice blends in (no clicks), then delay to its timestamp.
    const buildClipChain = (segDur: number, rawRate: number, start: number): string => {
      const clampedRate = Math.min(Math.max(rawRate, 0.5), 4.0);
      const delayMs = Math.max(0, Math.round(start * 1000));
      // User-set AI voice gain (mix console → final MP4).
      const vGain = typeof job.voiceGain === 'number' && job.voiceGain !== 1 ? `volume=${job.voiceGain.toFixed(3)},` : '';
      let chain = `${vGain}aformat=channel_layouts=stereo`;
      chain += buildAtempo(clampedRate);
      chain += `,aresample=48000:async=1:min_hard_comp=0.100000,apad,atrim=start=0:duration=${segDur.toFixed(3)}`;
      if (segDur > 0.25) {
        const fadeOutStart = Math.max(0, segDur - 0.1);
        chain += `,afade=t=in:st=0:d=0.03,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.1`;
      }
      // Per-channel delays for the stereo bus (no `all=1`: it needs FFmpeg >= 5
      // and is redundant since aformat already forced stereo).
      chain += `,adelay=${delayMs}|${delayMs}`;
      return chain;
    };
    clips.forEach((c, i) => {
      const segDur = Math.max(c.end - c.start, 0.4);
      const rawRate = c.duration / segDur;
      const chain = buildClipChain(segDur, rawRate, c.start);
      filters.push(`[${i + 1}:a]${chain}[v${i}]`);
    });

    // Voice bus (final mix).
    let vc: string | null = null;
    if (clips.length > 0) {
      const mkBus = (tag: string): string => {
        const inputs = clips.map((_, i) => `[${tag}${i}]`);
        if (inputs.length === 1) {
          filters.push(`${inputs[0]}anull[${tag}c]`);
          return `[${tag}c]`;
        }
        filters.push(`${inputs.join('')}amix=inputs=${inputs.length}:duration=longest:dropout_transition=0:normalize=0,aresample=48000[${tag}c]`);
        return `[${tag}c]`;
      };
      vc = mkBus('v');
    }

    // Precise automatic audio ducking — the "Music 100% -> 0% -> 100%"
    // behavior. While the AI Khmer voice plays, the background
    // music/ambience/SFX bus drops to duckLevel (normal/deep = 1, i.e. FULL
    // silence, so the original speaker can never bleed through as a double
    // voice); in every gap it recovers to full volume instantly. The ducking
    // is an exact volume envelope per segment with short attack/release ramps,
    // so transitions are smooth and click-free.
    //  • light  -> background still audible at 25% under the voice
    //  • normal -> background fully muted under the voice (default)
    //  • deep   -> fully muted, with a longer hold around each line
    let aout: string | null = null;
    if (hasAudio) {
      if (vc) {
        const duckLevel = ({ light: 0.75, normal: 1, deep: 1 } as Record<string, number>)[
          (job.duckDepth || 'normal') as string
        ] ?? 1;
        const pre = 0.08; // start ducking 80 ms before the voice starts
        const post = 0.15; // recover 150 ms after the voice ends
        const fade = 0.08; // ramp length (seconds)
        const terms = clips.map((c) => {
          const s = Math.max(0, c.start - pre);
          const e = Math.max(c.end + post, s + 0.4);
          return `min(1,max(0,min((t-${s.toFixed(3)})/${fade.toFixed(3)},(${e.toFixed(3)}-t)/${fade.toFixed(3)})))`;
        });
        const duckExpr = `1-${duckLevel}*min(1,${terms.join('+')})`;
        filters.push(`[bg0]volume='${duckExpr}':eval=frame[bg]`);
        // Final mix: ducked background + voice bus, with a limiter so the sum
        // can never clip → no distortion, no harsh peaks.
        filters.push('[bg][vc]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,aresample=48000,alimiter=limit=0.95:level=false[aout]');
        aout = '[aout]';
      } else {
        filters.push('[bg0]anull[bg]');
        aout = '[bg]';
      }
    } else if (clips.length > 0) {
      filters.push('[vc]alimiter=limit=0.95:level=false[aout]');
      aout = '[aout]';
    }

    const isVideo = Boolean(vStream);
    const outputPath = join(jobDir, 'output.mp4');
    const buildArgs = (copyVideo: boolean): string[] => {
      const a: string[] = ['-y', '-i', job.inputPath!];
      for (const c of clips) a.push('-i', c.path);
      if (filters.length > 0) a.push('-filter_complex', filters.join(';'));
      if (isVideo) a.push('-map', '0:v:0');
      if (aout) a.push('-map', aout);
      if (isVideo) {
        if (copyVideo) a.push('-c:v', 'copy');
        else a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
      }
      if (aout) a.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
      if (isVideo) a.push('-movflags', '+faststart', '-shortest');
      a.push(outputPath);
      return a;
    };

    const canCopyVideo = Boolean(
      vStream && vStream.codec_name === 'h264' && ['yuv420p', 'yuvj420p'].includes(String(vStream.pix_fmt || ''))
    );
    let usedCopy = false;
    try {
      if (canCopyVideo) {
        await runFfmpegWithProgress(buildArgs(true), duration || 0, (f) => setJobProgress(jobId, 60 + Math.round(30 * f), `Rendering MP4 (${Math.round(f * 100)}%)`));
        usedCopy = true;
      } else {
        throw new Error('re-encode required');
      }
    } catch {
      setJobProgress(jobId, 60, 'Rendering MP4 (re-encoding video)');
      await runFfmpegWithProgress(buildArgs(false), duration || 0, (f) => setJobProgress(jobId, 60 + Math.round(30 * f), `Rendering MP4 (${Math.round(f * 100)}%)`));
    }

    // 4. Validate the output
    const outProbe = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', outputPath], { timeout: 20_000 });
    const outInfo = JSON.parse(outProbe.stdout || '{}');
    const outStreams: any[] = outInfo.streams || [];
    if (outStreams.length === 0) throw new Error('FFmpeg produced no valid streams');
    const outSize = (await stat(outputPath)).size;
    if (outSize < 1000) throw new Error('Output file is too small to be valid');

    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const filename = isVideo ? `translated-${job.targetLanguage || 'video'}-${stamp}.mp4` : `translated-${job.targetLanguage || 'audio'}-${stamp}.m4a`;

    job.status = 'done';
    job.progress = 100;
    job.message = 'Ready';
    job.outputPath = outputPath;
    job.downloadFilename = filename;
    job.size = outSize;
    console.log(`[VideoJobs] Job ${jobId} done: ${filename} (${(outSize / 1024 / 1024).toFixed(1)}MB, copy=${usedCopy})`);
  } catch (err: any) {
    console.error(`[VideoJobs] Job ${jobId} failed:`, err?.message || err);
    job.status = 'error';
    job.error = err?.message || 'MP4 generation failed';
    job.progress = 100;
  }
}

app.get('/api/video/capabilities', (_req, res) => {
  res.json({ ffmpeg: FFMPEG_AVAILABLE, shotstack: Boolean(SHOTSTACK_API_KEY), chunked: false, maxUploadBytes: VIDEO_UPLOAD_LIMIT });
});

app.post('/api/video/upload', videoUpload.single('video') as any, async (req: any, res) => {
  if (!FFMPEG_AVAILABLE && !SHOTSTACK_API_KEY) {
    res.status(501).json({ error: 'FFmpeg is not installed on the server — MP4 generation is unavailable.' });
    return;
  }
  const file = req.file as Express.Multer.File | undefined;
  if (!file) {
    res.status(400).json({ error: 'No video file provided' });
    return;
  }
  const id = randomUUID();
  const jobDir = join(JOBS_ROOT, id);
  try {
    await mkdir(jobDir, { recursive: true });
    const ext = safeExt(file.mimetype, file.originalname);
    const inputPath = join(jobDir, `original.${ext}`);
    await rename(file.path, inputPath);
    videoJobs.set(id, {
      id, status: 'queued', progress: 5, message: 'Uploaded', createdAt: Date.now(),
      inputPath, originalName: file.originalname, hasVideo: isVideoMime(file.mimetype, file.originalname), targetLanguage: 'km',
    });
    res.json({ jobId: id, hasVideo: isVideoMime(file.mimetype, file.originalname), size: file.size });
  } catch (err: any) {
    try { await unlink(file.path); } catch { /* noop */ }
    res.status(500).json({ error: err?.message || 'Failed to store upload' });
  }
});

app.post('/api/video/process', express.json({ limit: '80mb' }), async (req, res) => {
  const { jobId, segments, removeVocals = true, targetLanguage = 'km', voiceGain = 1, bgGain = 1, duckDepth = 'normal' } = req.body || {};
  const job = videoJobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: 'Unknown jobId — please upload the video again.' });
    return;
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    res.status(400).json({ error: 'No subtitle segments provided' });
    return;
  }
  if (job.status === 'processing') {
    res.json({ jobId, status: 'processing', progress: job.progress });
    return;
  }
  if (job.status === 'done') {
    res.json({ jobId, status: 'done', progress: 100 });
    return;
  }
  job.segments = segments as ProcessSegment[];
  job.removeVocals = Boolean(removeVocals);
  job.targetLanguage = String(targetLanguage || 'km');
  // Mix console levels (0..2 voice gain, 0..1 background gain, duck profile)
  const vGain = Number(voiceGain);
  const bGain = Number(bgGain);
  job.voiceGain = Number.isFinite(vGain) && vGain >= 0 && vGain <= 2 ? vGain : 1;
  job.bgGain = Number.isFinite(bGain) && bGain >= 0 && bGain <= 1 ? bGain : 1;
  job.duckDepth = ['light', 'normal', 'deep'].includes(String(duckDepth)) ? String(duckDepth) : 'normal';
  job.status = 'processing';
  job.progress = 10;
  job.message = 'Preparing';
  job.error = undefined;
  res.json({ jobId, status: 'processing' });
  void processVideoJob(jobId);
});

app.get('/api/video/status/:id', (req, res) => {
  const job = videoJobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Unknown jobId' });
    return;
  }
  res.json({
    jobId: job.id, status: job.status, progress: job.progress, message: job.message,
    error: job.error, hasVideo: job.hasVideo,
    size: job.status === 'done' ? job.size : undefined,
    downloadFilename: job.status === 'done' ? job.downloadFilename : undefined,
  });
});

app.get('/api/video/download/:id', async (req, res) => {
  const job = videoJobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.outputPath) {
    res.status(404).json({ error: 'Video is not ready yet' });
    return;
  }
  try {
    const size = (await stat(job.outputPath)).size;
    res.setHeader('Content-Type', job.hasVideo ? 'video/mp4' : 'audio/mp4');
    res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Disposition', `attachment; filename="${job.downloadFilename || 'translated-video.mp4'}"`);
    res.setHeader('Cache-Control', 'private, max-age=600');
    createReadStream(job.outputPath).pipe(res);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Download failed' });
  }
});

// Stream video with HTTP 206 Partial Content for instant, seekable player preview
app.get('/api/video/stream/:id', async (req, res) => {
  const job = videoJobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.outputPath) {
    res.status(404).json({ error: 'Video is not ready yet' });
    return;
  }
  try {
    const filePath = job.outputPath;
    const fileStat = await stat(filePath);
    const fileSize = fileStat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const stream = createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': job.hasVideo ? 'video/mp4' : 'audio/mp4',
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': job.hasVideo ? 'video/mp4' : 'audio/mp4',
        'Accept-Ranges': 'bytes',
      });
      createReadStream(filePath).pipe(res);
    }
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Streaming failed' });
  }
});

// --- 9-Stage AI Video Dubbing & Translation Pipeline Implementation ---
const PIPELINE_CONFIG: { id: PipelineStage; stepNumber: number; nameKm: string; nameEn: string }[] = [
  { id: 'extract_audio', stepNumber: 1, nameKm: 'ទាញយកសំឡេងចេញពីវីដេអូ', nameEn: 'Extracting audio' },
  { id: 'detect_speakers', stepNumber: 2, nameKm: 'ស្វែងរក និងកំណត់តួអង្គ (Speaker Diarization)', nameEn: 'Detecting speakers' },
  { id: 'detect_speech', stepNumber: 3, nameKm: 'ត្រួតពិនិត្យ និងច្រោះរកតែសំឡេងនិយាយពិត (VAD)', nameEn: 'Detecting speech (VAD)' },
  { id: 'transcribe', stepNumber: 4, nameKm: 'បម្លែងសំឡេងនិយាយជាអត្ថបទ (Transcription)', nameEn: 'Transcribing speech' },
  { id: 'translate_khmer', stepNumber: 5, nameKm: 'បកប្រែជាភាសាខ្មែរធម្មជាតិ រលូន', nameEn: 'Translating to Khmer' },
  { id: 'generate_voices', stepNumber: 6, nameKm: 'បង្កើតសំឡេងខ្មែរតាមតួអង្គ និង segment', nameEn: 'Generating Khmer voices' },
  { id: 'sync_audio', stepNumber: 7, nameKm: 'តម្រឹមសំឡេងខ្មែរតាម Timestamp ដើម', nameEn: 'Synchronizing audio' },
  { id: 'mix_audio', stepNumber: 8, nameKm: 'រក្សាភ្លេង background & SFX ជាមួយ Ducking', nameEn: 'Mixing background audio' },
  { id: 'render_mp4', stepNumber: 9, nameKm: 'បង្កើតវីដេអូ MP4 H.264 + AAC សម្រេច', nameEn: 'Rendering final MP4' },
];

async function runAiDubbingPipeline(jobId: string, fromStage?: PipelineStage): Promise<void> {
  const job = videoJobs.get(jobId);
  if (!job || !job.inputPath) return;
  const jobDir = join(JOBS_ROOT, jobId);
  await mkdir(jobDir, { recursive: true });
  const ttsDir = join(jobDir, 'tts');
  await mkdir(ttsDir, { recursive: true });

  const stages: PipelineStage[] = [
    'extract_audio',
    'detect_speakers',
    'detect_speech',
    'transcribe',
    'translate_khmer',
    'generate_voices',
    'sync_audio',
    'mix_audio',
    'render_mp4',
  ];

  const startIndex = fromStage ? Math.max(0, stages.indexOf(fromStage)) : 0;
  job.status = 'processing';
  job.error = undefined;
  job.failedStage = null;

  try {
    // -------------------------------------------------------------
    // STAGE 1: Extract Audio (FFmpeg 16kHz mono)
    // -------------------------------------------------------------
    const audioPath = join(jobDir, 'audio_16k.mp3');
    if (startIndex <= 0 || !job.extractedAudioPath) {
      job.currentStage = 'extract_audio';
      job.stepNumber = 1;
      job.progress = 10;
      job.message = 'ទាញយកសំឡេងចេញពីវីដេអូដើម (Extracting audio)';

      const probeRes = await execFileAsync('ffprobe', [
        '-v', 'error', '-show_format', '-show_streams', '-of', 'json', job.inputPath,
      ], { timeout: 30_000 });
      const info = JSON.parse(probeRes.stdout || '{}');
      const streams: any[] = info.streams || [];
      const vStream = streams.find((s: any) => s.codec_type === 'video');
      job.hasVideo = Boolean(vStream);

      await execFileAsync('ffmpeg', [
        '-y', '-i', job.inputPath,
        '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'libmp3lame', '-q:a', '3',
        audioPath,
      ], { timeout: 60_000 });

      job.extractedAudioPath = audioPath;
      job.progress = 18;
    }

    // -------------------------------------------------------------
    // STAGE 4: Transcribe (Speech-to-Text with Whisper)
    // -------------------------------------------------------------
    if (startIndex <= 3 || !job.segments || job.segments.length === 0) {
      job.currentStage = 'transcribe';
      job.stepNumber = 4;
      job.progress = 25;
      job.message = 'បម្លែងសំឡេងនិយាយជាអត្ថបទដើម (Transcribing with Whisper)';

      const audioBuffer = await readFile(job.extractedAudioPath || audioPath);
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'audio_16k.mp3');
      formData.append('model', 'whisper-large-v3');
      formData.append('response_format', 'verbose_json');
      formData.append('temperature', '0');
      if (job.sourceLanguage && job.sourceLanguage !== 'auto') {
        formData.append('language', job.sourceLanguage);
      }

      const apiKeys = getAllGroqKeys({ headers: {} });
      const { res: whisperRes } = await fetchWithKeyFallback(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        apiKeys,
        { method: 'POST', body: formData }
      );

      if (!whisperRes.ok) {
        const errText = await whisperRes.text();
        throw new Error(`Whisper transcription failed (${whisperRes.status}): ${errText.slice(0, 150)}`);
      }

      const whisperData = await whisperRes.json() as any;
      job.detectedLanguage = whisperData.language || 'en';
      const rawSegments = whisperData.segments || [];

      // Preserve all segments with precise timestamps starting from the very first spoken second
      job.segments = rawSegments.map((seg: any, idx: number) => ({
        id: idx + 1,
        start: Math.max(0, Number(seg.start || 0)),
        end: Math.max(Number(seg.start || 0) + 0.35, Number(seg.end || (seg.start + 1))),
        originalText: (seg.text || '').trim(),
        translatedText: '',
        isSpeech: true,
        soundType: 'dialogue' as const,
        speakerId: 'Speaker 1',
        speakerGender: 'male' as const,
        no_speech_prob: seg.no_speech_prob,
      }));
      job.progress = 35;
    }

    // -------------------------------------------------------------
    // STAGE 3: Detect Speech (VAD)
    // Filter out music symbols/tags while protecting real dialogue from the start
    // -------------------------------------------------------------
    if (startIndex <= 2) {
      job.currentStage = 'detect_speech';
      job.stepNumber = 3;
      job.progress = 42;
      job.message = 'ត្រួតពិនិត្យ និងច្រោះរកតែសំឡេងនិយាយពិត (VAD / Speech Detection)';

      for (const seg of (job.segments || [])) {
        const text = (seg.originalText || '').trim();
        const isPureMusicSymbol = /^[♪\s]+$/.test(text);
        const isPureBracketedTag = /^[\[\(]\s*(music|applause|laughter|crying|footsteps|gunshot|explosion|instrumental|ambient|cough|screaming|sigh|gasp|cheering)\s*[\]\)]$/i.test(text);
        const hasLettersOrNumbers = /[a-zA-Z\u00C0-\u024F\u4E00-\u9FFF\u3040-\u30FF\u0E00-\u0E7F0-9]/.test(text);

        if (isPureMusicSymbol || isPureBracketedTag || (!hasLettersOrNumbers && text.length > 0)) {
          seg.isSpeech = false;
          seg.soundType = isPureMusicSymbol ? 'music' : 'sfx';
        } else if ((seg as any).no_speech_prob && (seg as any).no_speech_prob > 0.88 && text.split(/\s+/).length <= 1) {
          seg.isSpeech = false;
          seg.soundType = 'noise';
        } else {
          seg.isSpeech = true;
          seg.soundType = 'dialogue';
        }
      }
      job.progress = 48;
    }

    // -------------------------------------------------------------
    // STAGE 2: Detect Speakers (Speaker Diarization)
    // -------------------------------------------------------------
    if (startIndex <= 1) {
      job.currentStage = 'detect_speakers';
      job.stepNumber = 2;
      job.progress = 52;
      job.message = 'ស្វែងរក និងកំណត់អត្តសញ្ញាណតួអង្គ (Speaker Diarization)';

      const speechSegs = (job.segments || []).filter(s => s.isSpeech !== false && (s.originalText || '').length > 0);
      if (speechSegs.length > 0) {
        try {
          const apiKeys = getAllGroqKeys({ headers: {} });
          const diarizationPrompt = `You are an expert film supervisor doing Speaker Diarization and Voice Activity Detection.
Analyze these dialogue segments and assign consistent speaker identities ('Speaker 1', 'Speaker 2', 'Speaker 3'...) and speakerGender ('male' or 'female').
If any segment is actually music or sound effect, set isSpeech: false and soundType: 'music' or 'sfx'.
Input:
${JSON.stringify(speechSegs.map(s => ({ id: s.id, start: s.start, end: s.end, text: s.originalText })))}

Return a strict JSON array of objects with keys: id, isSpeech, soundType, speakerId, speakerGender. Output JSON array only.`;

          const { res: diarizeRes } = await fetchWithKeyFallback(
            'https://api.groq.com/openai/v1/chat/completions',
            apiKeys,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'openai/gpt-oss-20b',
                messages: [
                  { role: 'system', content: 'You are an expert audio analyst. Output JSON array only.' },
                  { role: 'user', content: diarizationPrompt }
                ],
                temperature: 0.1,
                max_tokens: 1500,
              })
            }
          );

          if (diarizeRes.ok) {
            const dData = await diarizeRes.json() as any;
            const content = dData.choices?.[0]?.message?.content || '';
            const m = content.match(/\[[\s\S]*\]/);
            if (m) {
              const parsed = JSON.parse(m[0]);
              if (Array.isArray(parsed)) {
                for (const item of parsed) {
                  const seg = job.segments?.find(s => s.id === item.id);
                  if (seg) {
                    if (item.isSpeech === false) {
                      seg.isSpeech = false;
                      seg.soundType = item.soundType || 'sfx';
                    } else {
                      seg.isSpeech = true;
                      seg.soundType = 'dialogue';
                      seg.speakerId = item.speakerId || 'Speaker 1';
                      seg.speakerGender = item.speakerGender === 'female' ? 'female' : 'male';
                    }
                  }
                }
              }
            }
          }
        } catch (e: any) {
          console.warn('[Pipeline] Diarization warning:', e?.message);
        }
      }
      job.progress = 56;
    }

    // -------------------------------------------------------------
    // STAGE 5: Translate to Khmer (Natural Spoken Khmer)
    // -------------------------------------------------------------
    if (startIndex <= 4) {
      job.currentStage = 'translate_khmer';
      job.stepNumber = 5;
      job.progress = 60;
      job.message = 'បកប្រែជាភាសាខ្មែរធម្មជាតិ រលូន (Natural Khmer Translation)';

      const dialogueSegs = (job.segments || []).filter(s => s.isSpeech !== false && (s.originalText || '').length > 0);
      if (dialogueSegs.length > 0) {
        const apiKeys = getAllGroqKeys({ headers: {} });
        const translatePrompt = `You are a master film dubbing director for Cambodian Khmer cinema.
Translate the following spoken dialogue segments into natural, conversational, fluent spoken Khmer (ភាសានិយាយខ្មែរធម្មជាតិ រលូន សមរម្យ ដូចមនុស្សនិយាយពិតៗ មិនបកប្រែពាក្យមួយៗ word-by-word បែបម៉ាស៊ីន).
Dialogue segments:
${JSON.stringify(dialogueSegs.map(s => ({ id: s.id, speaker: s.speakerId, text: s.originalText })))}

Return a strict JSON array of objects with keys: id, translatedText.
Output JSON array only.`;

        const { res: transRes } = await fetchWithKeyFallback(
          'https://api.groq.com/openai/v1/chat/completions',
          apiKeys,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'openai/gpt-oss-20b',
              messages: [
                { role: 'system', content: 'You are an expert Khmer film dubbing translator. Output JSON array only.' },
                { role: 'user', content: translatePrompt }
              ],
              temperature: 0.2,
              max_tokens: 2000,
            })
          }
        );

        if (transRes.ok) {
          const tData = await transRes.json() as any;
          const content = tData.choices?.[0]?.message?.content || '';
          const m = content.match(/\[[\s\S]*\]/);
          if (m) {
            try {
              const parsed = JSON.parse(m[0]);
              if (Array.isArray(parsed)) {
                for (const item of parsed) {
                  const seg = job.segments?.find(s => s.id === item.id);
                  if (seg && item.translatedText) {
                    seg.translatedText = item.translatedText.trim();
                  }
                }
              }
            } catch (err) {
              console.warn('[Pipeline] Parse translation json failed:', err);
            }
          }
        }

        for (const seg of dialogueSegs) {
          if (!seg.translatedText || !/[\u1780-\u17FF]/.test(seg.translatedText)) {
            seg.translatedText = seg.originalText || '';
          }
        }
      }
      job.progress = 68;
    }

    // -------------------------------------------------------------
    // STAGE 6: Generate Khmer Voices (Consistent per speaker)
    // -------------------------------------------------------------
    if (startIndex <= 5) {
      job.currentStage = 'generate_voices';
      job.stepNumber = 6;
      job.progress = 72;
      job.message = 'បង្កើតសំឡេងខ្មែរតាមតួអង្គ និង segment (Consistent Voices)';

      const dubSegs = (job.segments || []).filter(s => s.isSpeech !== false && (s.translatedText || '').trim().length > 0);
      for (let i = 0; i < dubSegs.length; i++) {
        const seg = dubSegs[i];
        const segFile = join(ttsDir, `seg_${seg.id}.mp3`);

        let voice = 'km-KH-PisethNeural';
        let options: { rate?: string; pitch?: string } = { rate: '+0%', pitch: '+0Hz' };
        if (seg.speakerGender === 'female' || seg.speakerId === 'Speaker 2') {
          voice = 'km-KH-SreymomNeural';
        } else if (seg.speakerId === 'Speaker 3') {
          voice = 'km-KH-PisethNeural';
          options = { rate: '-4%', pitch: '-2Hz' };
        } else if (seg.speakerId === 'Speaker 4') {
          voice = 'km-KH-SreymomNeural';
          options = { rate: '+4%', pitch: '+2Hz' };
        }

        seg.voiceId = voice;
        let audioBuf: Buffer | null = await edgeTTS(seg.translatedText || '', voice, options);
        if (!audioBuf || audioBuf.length < 500) {
          try {
            audioBuf = await fetchGoogleTTSChunk(seg.translatedText || '', 'km');
          } catch {
            audioBuf = null;
          }
        }

        if (audioBuf && audioBuf.length > 500) {
          await writeFile(segFile, audioBuf);
          seg.dubbedAudioBase64 = audioBuf.toString('base64');
          const dur = await probeDuration(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', segFile]);
          seg.audioDuration = dur > 0.05 ? dur : (seg.end - seg.start);
        }

        job.progress = 72 + Math.round(8 * ((i + 1) / Math.max(1, dubSegs.length)));
      }
    }

    // -------------------------------------------------------------
    // STAGE 7: Synchronizing Audio (100% Precision Sync & Time-Stretch)
    // -------------------------------------------------------------
    const clipsToMix: { segId: number; start: number; end: number; path: string; duration: number }[] = [];
    if (startIndex <= 6) {
      job.currentStage = 'sync_audio';
      job.stepNumber = 7;
      job.progress = 81;
      job.message = 'តម្រឹមសំឡេងខ្មែរ 100% ស៊ីគ្នានឹងវីដេអូ (100% Synchronizing)';

      const dubSegs = (job.segments || []).filter(s => s.isSpeech !== false && (s.dubbedAudioBase64 || '').length > 100);
      for (const seg of dubSegs) {
        const segFile = join(ttsDir, `seg_${seg.id}.mp3`);
        const syncedFile = join(ttsDir, `synced_${seg.id}.wav`);
        const origWindow = Math.max(0.35, seg.end - seg.start);
        const ttsDur = seg.audioDuration || origWindow;

        // Calculate exact speed ratio needed to fit origWindow 100%
        const speedRatio = ttsDur / origWindow;
        const clampedRatio = Math.min(Math.max(speedRatio, 0.4), 3.5);
        const atempoFilters: string[] = [];
        let r = clampedRatio;
        let guard = 0;
        while (r > 2.0 && guard < 6) { atempoFilters.push('atempo=2.0'); r /= 2; guard++; }
        while (r < 0.5 && guard < 6) { atempoFilters.push('atempo=0.5'); r /= 0.5; guard++; }
        if (Math.abs(r - 1.0) >= 0.015) {
          atempoFilters.push(`atempo=${r.toFixed(4)}`);
        }
        const atempoChain = atempoFilters.length > 0 ? `${atempoFilters.join(',')},` : '';

        try {
          const fadeOutStart = Math.max(0, origWindow - 0.04);
          await execFileAsync('ffmpeg', [
            '-y', '-i', segFile,
            '-filter:a', `${atempoChain}aformat=channel_layouts=stereo,aresample=48000:async=1:min_hard_comp=0.100000,apad,atrim=start=0:duration=${origWindow.toFixed(3)},afade=t=in:st=0:d=0.02,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.04`,
            syncedFile
          ], { timeout: 20_000 });
          clipsToMix.push({ segId: seg.id, start: seg.start, end: seg.end, path: syncedFile, duration: origWindow });
        } catch (e: any) {
          console.warn('[Sync] Time stretch error, using fallback:', e?.message);
          clipsToMix.push({ segId: seg.id, start: seg.start, end: seg.end, path: segFile, duration: ttsDur });
        }
      }
      job.progress = 85;
    }

    // -------------------------------------------------------------
    // STAGE 8: Mixing Background Audio (Original Voice Silenced 100% During Speech)
    // -------------------------------------------------------------
    const mixedAudioPath = join(jobDir, 'mixed_audio.m4a');
    if (startIndex <= 7) {
      job.currentStage = 'mix_audio';
      job.stepNumber = 8;
      job.progress = 87;
      job.message = 'បំបាត់សំឡេងតួដើម 100% ពេលនិយាយ និងរក្សាភ្លេង background & SFX';

      const aProbe = await execFileAsync('ffprobe', [
        '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels,codec_name', '-of', 'json', job.inputPath
      ], { timeout: 15_000 });
      const aInfo = JSON.parse(aProbe.stdout || '{}');
      const hasOriginalAudio = Boolean(aInfo.streams?.[0]);

      if (clipsToMix.length === 0) {
        if (hasOriginalAudio) {
          await execFileAsync('ffmpeg', ['-y', '-i', job.inputPath, '-vn', '-c:a', 'aac', '-b:a', '192k', mixedAudioPath], { timeout: 60_000 });
        } else {
          await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '10', '-c:a', 'aac', mixedAudioPath], { timeout: 15_000 });
        }
      } else {
        const ffmpegArgs: string[] = ['-y', '-i', job.inputPath];
        for (const clip of clipsToMix) {
          ffmpegArgs.push('-i', clip.path);
        }

        const filterComplex: string[] = [];

        // 1. Duck original background audio:
        // When AI Khmer voice speaks: volume is exactly 0.0 (100% silent, completely muting original voice)
        // Between speech lines (intro music, sound effects, ambience): volume is 1.0 (100% full background audio)
        // Smooth 60ms crossfade ramps prevent clicks and pops
        if (hasOriginalAudio) {
          const pre = 0.06;
          const post = 0.08;
          const fade = 0.06;
          const terms = clipsToMix.map((c) => {
            const s = Math.max(0, c.start - pre);
            const e = Math.max(c.start + c.duration + post, s + 0.35);
            return `min(1,max(0,min((t-${s.toFixed(3)})/${fade.toFixed(3)},(${e.toFixed(3)}-t)/${fade.toFixed(3)})))`;
          });
          // 1 - 1.0 * min(1, sum): strictly 0.0 during speech!
          const duckExpr = `1-1.0*min(1,${terms.join('+')})`;
          filterComplex.push(`[0:a]aformat=channel_layouts=stereo,aresample=48000,volume='${duckExpr}':eval=frame[bg]`);
        }

        // 2. Align voice clips onto the timeline with sample-accurate adelay
        for (let i = 0; i < clipsToMix.length; i++) {
          const c = clipsToMix[i];
          const delayMs = Math.max(0, Math.round(c.start * 1000));
          const inputIdx = i + 1;
          filterComplex.push(
            `[${inputIdx}:a]aformat=channel_layouts=stereo,aresample=48000,adelay=${delayMs}|${delayMs}[v${i}]`
          );
        }

        // 3. Merge into speech bus [vc] with normalize=0 so volume is loud and crisp
        const voiceInputs = clipsToMix.map((_, i) => `[v${i}]`);
        if (voiceInputs.length === 1) {
          filterComplex.push(`${voiceInputs[0]}anull[vc]`);
        } else {
          filterComplex.push(`${voiceInputs.join('')}amix=inputs=${voiceInputs.length}:duration=longest:dropout_transition=0:normalize=0,aresample=48000[vc]`);
        }

        // 4. Mix ducked background [bg] + voice bus [vc] with alimiter to prevent distortion
        if (hasOriginalAudio) {
          filterComplex.push('[bg][vc]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,aresample=48000,alimiter=limit=0.98:level=false[aout]');
          ffmpegArgs.push('-filter_complex', filterComplex.join(';'), '-map', '[aout]');
        } else {
          filterComplex.push('[vc]alimiter=limit=0.98:level=false[aout]');
          ffmpegArgs.push('-filter_complex', filterComplex.join(';'), '-map', '[aout]');
        }

        ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k', mixedAudioPath);
        await execFileAsync('ffmpeg', ffmpegArgs, { timeout: 120_000 });
      }

      job.progress = 92;
    }

    // -------------------------------------------------------------
    // STAGE 9: Rendering Final MP4
    // -------------------------------------------------------------
    job.currentStage = 'render_mp4';
    job.stepNumber = 9;
    job.progress = 94;
    job.message = 'បង្កើតវីដេអូ MP4 H.264 + AAC គុណភាពដើមសម្រេច';

    const finalMp4Path = join(jobDir, 'final_translated.mp4');
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const filename = `translated-khmer-${stamp}.mp4`;

    let muxSuccess = false;
    if (job.hasVideo) {
      try {
        await execFileAsync('ffmpeg', [
          '-y',
          '-i', job.inputPath,
          '-i', mixedAudioPath,
          '-c:v', 'copy',
          '-c:a', 'copy',
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-movflags', '+faststart',
          finalMp4Path,
        ], { timeout: 60_000 });
        muxSuccess = true;
      } catch {
        muxSuccess = false;
      }
    }

    if (!muxSuccess) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', job.inputPath,
        '-i', mixedAudioPath,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '22',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-map', '0:v:0?',
        '-map', '1:a:0',
        '-movflags', '+faststart',
        finalMp4Path,
      ], { timeout: 120_000 });
    }

    const outProbe = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', finalMp4Path
    ], { timeout: 15_000 });
    const outInfo = JSON.parse(outProbe.stdout || '{}');
    if (!outInfo.streams || outInfo.streams.length === 0) {
      throw new Error('FFmpeg generated invalid MP4 with no streams');
    }

    const outStat = await stat(finalMp4Path);
    if (outStat.size < 1000) {
      throw new Error('Generated MP4 file is too small');
    }

    job.status = 'done';
    job.currentStage = null;
    job.progress = 100;
    job.message = 'វីដេអូរួចរាល់ (Ready)';
    job.outputPath = finalMp4Path;
    job.downloadFilename = filename;
    job.size = outStat.size;

  } catch (err: any) {
    console.error(`[Pipeline Error] Job ${jobId} failed at stage ${job.currentStage}:`, err);
    job.status = 'error';
    job.failedStage = job.currentStage || 'extract_audio';
    job.error = err?.message || `ការដំណើរការបានបរាជ័យនៅដំណាក់កាល ${job.currentStage}`;
  }
}

// Start 9-stage pipeline endpoint
app.post('/api/pipeline/start', (req: any, res: any, next: any) => {
  (videoUpload.any() as any)(req, res, (err: any) => {
    if (err) {
      console.error('[Pipeline Start] Multer upload error:', err);
      return res.status(400).json({ error: err?.message || 'File upload failed' });
    }
    next();
  });
}, async (req: any, res: any) => {
  const uploadedFile = (req.files && req.files.length > 0) ? req.files[0] : req.file;
  let jobId = req.body?.jobId as string | undefined;
  let job: VideoJob | undefined;

  if (uploadedFile) {
    jobId = randomUUID();
    ensureJobDirs();
    const jobDir = join(JOBS_ROOT, jobId);
    await mkdir(jobDir, { recursive: true });
    const ext = safeExt(uploadedFile.mimetype, uploadedFile.originalname);
    const diskPath = join(jobDir, `original.${ext}`);
    await rename(uploadedFile.path, diskPath);

    job = {
      id: jobId,
      status: 'queued',
      progress: 5,
      message: 'កំពុងរៀបចំវីដេអូ (Preparing video)',
      createdAt: Date.now(),
      inputPath: diskPath,
      originalName: uploadedFile.originalname,
      sourceLanguage: req.body?.sourceLanguage || 'auto',
      targetLanguage: req.body?.targetLanguage || 'km',
      currentStage: 'extract_audio',
      stepNumber: 1,
    };
    videoJobs.set(jobId, job);
  } else if (jobId) {
    job = videoJobs.get(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (req.body?.sourceLanguage) job.sourceLanguage = req.body.sourceLanguage;
    if (req.body?.targetLanguage) job.targetLanguage = req.body.targetLanguage;
  } else {
    res.status(400).json({ error: 'No video file or jobId provided' });
    return;
  }

  res.json({
    jobId,
    status: 'processing',
    currentStage: 'extract_audio',
    stepNumber: 1,
    message: 'ចាប់ផ្តើមដំណើរការបកប្រែវីដេអូ AI (Starting AI Dubbing Pipeline)',
  });

  void runAiDubbingPipeline(jobId);
});

// Granular status endpoint for the 9-stage pipeline
app.get('/api/pipeline/status/:id', (req, res) => {
  const job = videoJobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.json({
    jobId: job.id,
    status: job.status,
    currentStage: job.currentStage,
    stepNumber: job.stepNumber || 1,
    progress: job.progress,
    message: job.message,
    error: job.error,
    failedStage: job.failedStage,
    hasVideo: job.hasVideo,
    segments: job.segments || [],
    detectedLanguage: job.detectedLanguage,
    downloadUrl: job.status === 'done' ? `/api/video/download/${job.id}` : undefined,
    streamUrl: job.status === 'done' ? `/api/video/stream/${job.id}` : undefined,
    downloadFilename: job.downloadFilename,
    size: job.size,
  });
});

// Retry endpoint for retrying from any failed or specific stage without re-uploading
app.post('/api/pipeline/retry', express.json(), async (req, res) => {
  const { jobId, stage } = req.body || {};
  const job = videoJobs.get(jobId);
  if (!job || !job.inputPath) {
    res.status(404).json({ error: 'Job not found or original file missing' });
    return;
  }

  const retryStage: PipelineStage = stage || job.failedStage || job.currentStage || 'extract_audio';
  const stageCfg = PIPELINE_CONFIG.find(s => s.id === retryStage);

  job.status = 'processing';
  job.currentStage = retryStage;
  job.stepNumber = stageCfg?.stepNumber || 1;
  job.failedStage = null;
  job.error = undefined;
  job.message = `សាកល្បងដំណាក់កាល ${stageCfg?.stepNumber} ឡើងវិញ (Retrying stage ${retryStage})`;

  res.json({
    jobId,
    status: 'processing',
    stage: retryStage,
    stepNumber: stageCfg?.stepNumber || 1,
  });

  void runAiDubbingPipeline(jobId, retryStage);
});

// ---------------------------------------------------------------- Shotstack
// Cloud video rendering (sandbox): the original video + the translated AI
// voice clips are hosted via the Shotstack Ingest API, composed on a timeline
// (video track with muted/ducked original audio + a voice track), and rendered
// by Shotstack's Edit API into a hosted MP4. Sandbox renders carry a watermark
// and are capped at 10 minutes — unlimited development renders.
const SHOTSTACK_ENV_VAR = 'SHOTSTACK_API_KEY';
const SHOTSTACK_API_KEY = process.env[SHOTSTACK_ENV_VAR]?.trim() || '';
const SHOTSTACK_INGEST_BASE = 'https://api.shotstack.io/ingest/stage';
const SHOTSTACK_EDIT_BASE = 'https://api.shotstack.io/edit/stage';
const shotstackRenders = new Map<string, { renderId: string; jobId: string }>();

async function shotstackIngestUpload(filePath: string, filename: string): Promise<string> {
  if (!SHOTSTACK_API_KEY) throw new Error('SHOTSTACK_API_KEY is not configured on the server');
  const headers = { Accept: 'application/json', 'x-api-key': SHOTSTACK_API_KEY };
  const upRes = await fetch(`${SHOTSTACK_INGEST_BASE}/upload`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename }),
  });
  if (!upRes.ok) throw new Error(`Shotstack upload init failed (${upRes.status})`);
  const upJson: any = await upRes.json();
  const upId = upJson.data?.id;
  const signed = upJson.data?.attributes?.url;
  if (!upId || !signed) throw new Error('Shotstack upload init returned no signed URL');

  const buf = await readFile(filePath);
  const low = filename.toLowerCase();
  let mime = 'video/mp4';
  if (low.endsWith('.wav')) mime = 'audio/wav';
  else if (low.endsWith('.mp3')) mime = 'audio/mpeg';
  else if (low.endsWith('.m4a') || low.endsWith('.aac')) mime = 'audio/mp4';
  else if (low.endsWith('.webm')) mime = 'video/webm';
  else if (low.endsWith('.mov')) mime = 'video/quicktime';
  let putRes: Response | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      putRes = await fetch(signed, { method: 'PUT', headers: { 'Content-Type': mime }, body: buf });
      if (putRes.ok) break;
    } catch (err: any) {
      console.warn(`[Shotstack] upload attempt ${attempt}/3 failed:`, err?.message || err);
    }
    if (attempt < 3) await new Promise((res) => setTimeout(res, 3000 * attempt));
  }
  if (!putRes || !putRes.ok) throw new Error(`Shotstack upload failed (${putRes?.status || 'network error'})`);

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${SHOTSTACK_INGEST_BASE}/sources/${upId}`, { headers });
      if (r.ok) {
        const j: any = await r.json();
        const st = j.data?.attributes?.status;
        if (st === 'ready') return j.data.attributes.source;
        if (st === 'failed') throw new Error('Shotstack ingest failed');
      }
    } catch (err: any) {
      if (err?.message === 'Shotstack ingest failed') throw err;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error('Shotstack ingest timed out');
}

async function shotstackStartRender(jobId: string): Promise<void> {
  const job = videoJobs.get(jobId);
  if (!job || !job.inputPath) {
    if (job) { job.status = 'error'; job.error = 'Job not found'; job.progress = 100; }
    return;
  }
  try {
    setJobProgress(jobId, 15, 'Uploading to Shotstack');
    const jobDir = join(JOBS_ROOT, jobId);
    const originalName = job.inputPath.split(/[\\/]/).pop() || 'original.mp4';
    const originalUrl = await shotstackIngestUpload(job.inputPath, originalName);

    const segs: ProcessSegment[] = job.segments || [];
    const withAudio = segs.filter((s) => (s.dubbedAudioBase64 || '').length > 100);
    const clips: { start: number; end: number; url: string }[] = [];
    for (let i = 0; i < withAudio.length; i++) {
      try {
        const seg = withAudio[i];
        const buf = Buffer.from(seg.dubbedAudioBase64 || '', 'base64');
        if (buf.length < 100) continue;
        const kind = sniffAudioKind(buf);
        const clipPath = join(JOBS_ROOT, jobId, `shotstack_clip_${String(i).padStart(4, '0')}.${kind}`);
        await writeFile(clipPath, buf);
        const url = await shotstackIngestUpload(clipPath, clipPath.split(/[\\/]/).pop() || 'clip.wav');
        clips.push({ start: Math.max(0, seg.start), end: Math.max(seg.end, seg.start + 0.3), url });
      } catch (err: any) {
        console.warn(`[Shotstack] clip ${i} failed:`, err?.message);
      }
      setJobProgress(jobId, 15 + Math.round(20 * ((i + 1) / Math.max(withAudio.length, 1))), `Uploading voice clips (${i + 1}/${withAudio.length})`);
    }

    let duration = Math.max(...clips.map((c) => c.end), 0);
    if (duration <= 0) duration = Math.max(...segs.map((s) => s.end || 0), 0);
    duration = Math.max(duration + 1, 3);
    const removeVocals = job.removeVocals === true;
    const bgGain = typeof job.bgGain === 'number' ? job.bgGain : 1;
    const voiceGain = typeof job.voiceGain === 'number' ? job.voiceGain : 1;
    const duckDepth = (['light', 'normal', 'deep'] as const).includes(job.duckDepth as any) ? job.duckDepth : 'normal';

    // Interval ducking for Shotstack (no sidechain compressor there, so
    // ducking is expressed as timeline segments): the background dips to
    // duckGain while the AI voice speaks (normal/deep = 0, full silence, so
    // the original speaker can never be heard as a double voice) and returns
    // to full level in every gap between the AI speech intervals.
    const DUCK_GAIN: Record<string, number> = { light: 0.35, normal: 0, deep: 0 };
    const DUCK_PAD: Record<string, number> = { light: 0.15, normal: 0.3, deep: 0.45 };
    const duckGain = DUCK_GAIN[duckDepth];

    // Background audio source:
    //  * "keep original soundtrack" (removeVocals=false): the original source
    //    itself, layered via video assets (Shotstack audio assets reject .mp4).
    //  * "remove original voice, keep the music" (removeVocals=true): a
    //    server-side center-cancelled (music-only) WAV when the source is true
    //    stereo, so the background music/ambience/SFX survive exactly like the
    //    UI promises; mono/dual-mono sources cannot be separated, so the
    //    original soundtrack stays fully muted there.
    let bgUrl: string | null = null;
    if (removeVocals && FFMPEG_AVAILABLE) {
      try {
        const { stdout } = await execFileAsync(
          'ffprobe',
          ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'json', job.inputPath!],
          { timeout: 20_000 }
        );
        const ch = JSON.parse(stdout).streams?.[0]?.channels || 0;
        if (ch >= 2) {
          const bgPath = join(jobDir, 'shotstack_bg.wav');
          await runFfmpegWithProgress(
            [
              '-y', '-i', job.inputPath!,
              '-af', `aformat=channel_layouts=stereo,aresample=48000,pan=stereo|c0=c0-c1|c1=c1-c0,volume=${bgGain.toFixed(3)}`,
              '-c:a', 'pcm_s16le',
              '-t', duration.toFixed(3),
              bgPath,
            ],
            duration,
            () => { /* no progress UI here */ },
            600_000
          );
          const st = await stat(bgPath).catch(() => null);
          if (st && st.size > 2000) {
            bgUrl = await shotstackIngestUpload(bgPath, bgPath.split(/[\\/]/).pop() || 'bg_music.wav');
          }
        }
      } catch (err: any) {
        console.warn('[Shotstack] background separation failed:', err?.message || err);
      }
    }

    // The base video track is always silent — the soundtrack comes from
    // per-window background layers below.
    const tracks: any[] = [
      {
        clips: [
          {
            asset: { type: 'video', src: originalUrl, volume: 0 },
            start: 0,
            length: duration,
          },
        ],
      },
    ];
    if (clips.length > 0) {
      const pad = DUCK_PAD[duckDepth];
      const ranges = clips
        .map((c) => [Math.max(0, c.start - pad), Math.max(c.end + pad, c.start + 0.4)] as [number, number])
        .sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const [s, e] of ranges) {
        if (merged.length && s <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
        else merged.push([s, e]);
      }
      // Background level in the gaps: full music when we have a separated
      // music track or the original is kept; silent when the original voice
      // was removed but no separation was possible.
      const gapGain = !removeVocals || bgUrl ? bgGain : 0;
      const windows: [number, number, number][] = [];
      let cursor = 0;
      for (const [s0, e0] of merged) {
        const s = Math.min(Math.max(0, s0), duration);
        const e = Math.min(Math.max(0, e0), duration);
        if (e <= cursor) continue;
        if (s - cursor > 0.05) windows.push([cursor, s, gapGain]);
        if (e - s > 0.05) windows.push([s, e, duckGain]);
        cursor = Math.max(cursor, e);
      }
      if (duration - cursor > 0.05) windows.push([cursor, duration, gapGain]);
      // Merge consecutive windows with the SAME gain so the timeline stays compact.
      const compact: [number, number, number][] = [];
      for (const [s, e, g] of windows) {
        if (compact.length && Math.abs(compact[compact.length - 1][2] - g) < 1e-9 && Math.abs(compact[compact.length - 1][1] - s) < 0.05) {
          compact[compact.length - 1][1] = e;
        } else {
          compact.push([s, e, g]);
        }
      }
      if (bgUrl) {
        // Music-only WAV with per-window volume (audio assets accept wav
        // sources; Shotstack caps clip volume at 1.0).
        tracks.push({
          clips: compact.map(([s, e, g]) => ({
            asset: { type: 'audio', src: bgUrl, volume: Math.min(Math.max(g, 0), 1) },
            start: Math.round(s * 1000) / 1000,
            length: Math.round((e - s) * 1000) / 1000,
          })),
        });
      } else if (!removeVocals) {
        // Original soundtrack re-layered as video assets (video assets carry
        // their audio with them): full background in the gaps, ducked to
        // duckGain while the AI voice speaks.
        for (const [s, e, g] of compact) {
          tracks.push({
            clips: [
              {
                asset: { type: 'video', src: originalUrl, volume: g },
                start: Math.round(s * 1000) / 1000,
                length: Math.round((e - s) * 1000) / 1000,
              },
            ],
          });
        }
      }
      // else: remove_vocals with no separable background -> the original
      // soundtrack stays fully muted; only the AI voice is audible.
      tracks.push({
        clips: clips.map((c) => ({
          asset: { type: 'audio', src: c.url, volume: Math.min(Math.max(voiceGain, 0), 1) },
          start: c.start,
          length: Math.max(c.end - c.start, 0.4),
        })),
      });
    }
    const edit = { timeline: { tracks, fps: 30 }, output: { format: 'mp4', resolution: 'sd', fps: 30 } };
    setJobProgress(jobId, 45, 'Submitting Shotstack render');
    const res = await fetch(`${SHOTSTACK_EDIT_BASE}/render`, {
      method: 'POST',
      headers: { ...{ Accept: 'application/json', 'x-api-key': SHOTSTACK_API_KEY }, 'Content-Type': 'application/json' },
      body: JSON.stringify(edit),
    });
    if (!res.ok) throw new Error(`Shotstack render submit failed (${res.status})`);
    const body: any = await res.json();
    const rid = body.response?.id;
    if (!rid) throw new Error('Shotstack render returned no id');
    shotstackRenders.set(jobId, { renderId: rid, jobId });
    setJobProgress(jobId, 50, `Shotstack rendering (${rid})`);
    console.log(`[Shotstack] Job ${jobId} queued render ${rid}`);
  } catch (err: any) {
    console.error(`[Shotstack] Job ${jobId} failed:`, err?.message || err);
    job.status = 'error';
    job.error = err?.message || 'Shotstack render failed';
    job.progress = 100;
  }
}

app.post('/api/video/shotstack-render', express.json({ limit: '80mb' }), async (req, res) => {
  const { jobId, segments, removeVocals = true, targetLanguage = 'km', voiceGain = 1, bgGain = 1 } = req.body || {};
  const job = videoJobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: 'Unknown jobId — please upload the video again.' });
    return;
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    res.status(400).json({ error: 'No subtitle segments provided' });
    return;
  }
  if (!SHOTSTACK_API_KEY) {
    res.status(501).json({ error: 'SHOTSTACK_API_KEY is not configured on the server' });
    return;
  }
  job.segments = segments as ProcessSegment[];
  job.removeVocals = Boolean(removeVocals);
  job.targetLanguage = String(targetLanguage || 'km');
  const vGain = Number(voiceGain);
  const bGain = Number(bgGain);
  job.voiceGain = Number.isFinite(vGain) && vGain >= 0 && vGain <= 2 ? vGain : 1;
  job.bgGain = Number.isFinite(bGain) && bGain >= 0 && bGain <= 1 ? bGain : 1;
  job.status = 'processing';
  job.progress = 10;
  job.message = 'Preparing Shotstack render';
  job.error = undefined;
  res.json({ jobId, status: 'processing', provider: 'shotstack' });
  void shotstackStartRender(jobId);
});

app.get('/api/video/shotstack-status', async (req, res) => {
  const jobId = String(req.query.jobId || '');
  const job = videoJobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: 'Unknown jobId' });
    return;
  }
  const entry = shotstackRenders.get(jobId);
  if (!entry) {
    res.json({ jobId, status: job.status, progress: job.progress, message: job.message, error: job.error, hasVideo: job.hasVideo, provider: 'shotstack' });
    return;
  }
  try {
    const r = await fetch(`${SHOTSTACK_EDIT_BASE}/render/${entry.renderId}`, {
      headers: { Accept: 'application/json', 'x-api-key': SHOTSTACK_API_KEY },
    });
    if (!r.ok) throw new Error(`Shotstack status failed (${r.status})`);
    const j: any = await r.json();
    const resp = j.response || {};
    const status = resp.status;
    const url = resp.url;
    if (status === 'done' && url) {
      let size = 0;
      try {
        const h = await fetch(url, { method: 'HEAD' });
        size = Number(h.headers.get('content-length') || 0);
      } catch { /* noop */ }
      const fname = `translated-${job.targetLanguage || 'video'}.mp4`;
      job.status = 'done';
      job.progress = 100;
      job.message = 'Ready';
      job.outputPath = url;
      job.downloadFilename = fname;
      job.size = size;
      res.json({ jobId, status: 'done', progress: 100, message: 'Ready', hasVideo: true, size, url, downloadFilename: fname, provider: 'shotstack' });
      return;
    }
    if (status === 'failed') {
      const err = resp.error || 'Shotstack render failed';
      job.status = 'error';
      job.error = err;
      job.progress = 100;
      res.json({ jobId, status: 'error', error: err, provider: 'shotstack' });
      return;
    }
    setJobProgress(
      jobId,
      ['queued', 'fetching', 'preprocessing'].includes(status) ? 55 : 70,
      status === 'rendering' || status === 'saving' ? 'Shotstack rendering' : `Shotstack preparing (${status})`
    );
    res.json({ jobId, status: 'processing', progress: job.progress, message: job.message, provider: 'shotstack', shotstackStatus: status });
  } catch (err: any) {
    res.json({ jobId, status: job.status, progress: job.progress, message: job.message, error: job.error, provider: 'shotstack' });
  }
});


// --- Helper functions ---

function formatSrtTime(t: number): string {
  const ms = Math.floor((t % 1) * 1000);
  const total = Math.floor(t);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

function formatVttTime(t: number): string {
  const ms = Math.floor((t % 1) * 1000);
  const total = Math.floor(t);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms, 3)}`;
}

function p(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function buildSrt(segments: any[], useTranslation: boolean): string {
  return segments
    .map((seg, i) => {
      const text = useTranslation ? seg.translatedText : seg.originalText;
      return `${i + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${text.trim()}\n`;
    })
    .join("\n");
}

function buildVtt(segments: any[], useTranslation: boolean): string {
  const lines = ["WEBVTT", ""];
  segments.forEach((seg, i) => {
    const text = useTranslation ? seg.translatedText : seg.originalText;
    lines.push(`${i + 1}`);
    lines.push(`${formatVttTime(seg.start)} --> ${formatVttTime(seg.end)}`);
    lines.push(text.trim());
    lines.push("");
  });
  return lines.join("\n");
}

// --- Vite Dev Middleware & Production Static Serving ---

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();

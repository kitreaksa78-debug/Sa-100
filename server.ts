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
import { EdgeTTS } from "@travisvn/edge-tts";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT) || 5173;
const app = express();
// Accepts raw uploads up to 50 MB (frontend normally shrinks larger files to
// audio first, but allow the full claimed size in case a browser cannot).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 52_428_800 } });
const uploadLarge = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB for video render

// --- Server-side video job store (real FFmpeg MP4 generation) ---
type VideoJobStatus = 'queued' | 'uploading' | 'processing' | 'done' | 'error';
interface VideoJob {
  id: string;
  status: VideoJobStatus;
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
  removeVocals?: boolean;
  segments?: ProcessSegment[];
}
interface ProcessSegment {
  id?: number;
  start: number;
  end: number;
  translatedText?: string;
  dubbedAudioBase64?: string;
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

function getAllGroqKeys(req: express.Request): string[] {
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

async function edgeTTS(text: string, lang: string): Promise<Buffer | null> {
  const voice = EDGE_TTS_VOICES[lang];
  if (!voice) return null;
  try {
    const tts = new EdgeTTS(text, voice);
    const result = await tts.synthesize();
    const audio = Buffer.from(await result.audio.arrayBuffer());
    return audio.length > 0 ? audio : null;
  } catch (err: any) {
    console.warn(`[EdgeTTS] failed for ${lang}:`, err?.message);
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

app.post("/api/transcribe-and-translate", upload.single("file"), async (req, res) => {
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
app.post("/api/render-mp4", uploadLarge.single("video"), async (req, res) => {
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
      filters.push(
        applyCenterCancel
          ? '[0:a]aformat=channel_layouts=stereo,pan=stereo|c0=c0-c1|c1=c1-c0[bg0]'
          : '[0:a]aformat=channel_layouts=stereo[bg0]'
      );
      const cond = clips.map((c) => `between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})`).join('+');
      filters.push(
        cond
          ? `[bg0]volume='if(${cond}>=1,0.45,1)':eval=frame[bg]`
          : '[bg0]anull[bg]'
      );
    }

    clips.forEach((c, i) => {
      const segDur = Math.max(c.end - c.start, 0.4);
      const rate = Math.min(Math.max(c.duration / segDur, 0.85), 2.0);
      const delayMs = Math.max(0, Math.round(c.start * 1000));
      let chain = 'aformat=channel_layouts=stereo';
      if (Math.abs(rate - 1) > 0.02) chain += `,atempo=${rate.toFixed(3)}`;
      chain += `,adelay=${delayMs}|${delayMs}:all=1`;
      filters.push(`[${i + 1}:a]${chain}[v${i}]`);
    });

    let aout: string | null = null;
    if (hasAudio) {
      const inputs = ['[bg]', ...clips.map((_, i) => `[v${i}]`)];
      if (inputs.length === 1) {
        aout = '[bg]';
      } else {
        filters.push(`${inputs.join('')}amix=inputs=${inputs.length}:duration=first:dropout_transition=0:normalize=0,aresample=48000[aout]`);
        aout = '[aout]';
      }
    } else if (clips.length > 0) {
      const inputs = clips.map((_, i) => `[v${i}]`);
      if (inputs.length === 1) {
        aout = inputs[0];
      } else {
        filters.push(`${inputs.join('')}amix=inputs=${inputs.length}:duration=longest:dropout_transition=0:normalize=0,aresample=48000[aout]`);
        aout = '[aout]';
      }
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
  res.json({ ffmpeg: FFMPEG_AVAILABLE, chunked: false, maxUploadBytes: VIDEO_UPLOAD_LIMIT });
});

app.post('/api/video/upload', videoUpload.single('video'), async (req, res) => {
  if (!FFMPEG_AVAILABLE) {
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
  const { jobId, segments, removeVocals = true, targetLanguage = 'km' } = req.body || {};
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

// --- Vite Dev Middleware ---

async function startServer() {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });

  app.use(vite.middlewares);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();

import "dotenv/config";
import dotenv from "dotenv";
// Load platform-managed secrets (GROQ_API_KEY, GROQ_API_KEY2, GROQ_API_KEY3, ...)
// dotenv never overrides already-set env vars, so this is a safe supplement.
dotenv.config({ path: ".env.local" });
import express from "express";
import multer from "multer";
import { createServer as createViteServer } from "vite";
import https from "https";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, unlink, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT) || 5173;
const app = express();
// Accepts raw uploads up to 50 MB (frontend normally shrinks larger files to
// audio first, but allow the full claimed size in case a browser cannot).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 52_428_800 } });
const uploadLarge = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB for video render

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
  return `You are a professional subtitle translator. Translate each numbered segment below from ${langPair} (${targetLanguageName || targetLanguage}). Every translated line MUST be written in the target language (${targetLanguage}) script — never repeat the source-language text. Use the full transcript below as context so short or ambiguous segments are translated naturally and consistently. Keep the numbering and return ONLY the translated text lines, one per segment, preserving blank lines between segments.\n\nFull transcript: \"${fullText}\"\n\n${numbered}`;
}

function buildForcedTranslationPrompt(
  sourceLanguage: string,
  targetLanguage: string,
  targetLanguageName: string,
  segments: any[]
): string {
  const numbered = segments.map((s: any, i: number) => `${i + 1}. ${s.originalText || ""}`).join("\n");
  return `Translate the following subtitle segments from ${sourceLanguage} to ${targetLanguage} (${targetLanguageName || targetLanguage}). Every line MUST be written in the target language's script — never repeat the original-language text. Return one translation per line, numbered to match the input, with no extra text.\n\n${numbered}`;
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

  // Run one model+prompt pass over the pending segments, keeping lines that
  // pass the target-script check and re-queueing the rest for another pass.
  const runPass = async (m: string, buildPrompt: (sub: any[]) => string) => {
    if (pending.length === 0) return;
    const prompt = buildPrompt(pending.map((i) => segments[i]));
    const chatData = await tryChatModels(apiKeys, m, prompt);
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
  const alternatives = [
    DEFAULT_TRANSLATION_MODEL,
    "qwen/qwen3.8-27b",
    "qwen/qwen3.6-27b",
    "groq/compound-mini",
    "openai/gpt-oss-20b",
  ].filter((m, i, arr) => arr.indexOf(m) === i && m !== model);
  for (const alt of alternatives) {
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
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
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

  // 1. Try Google Translate TTS (free, supports 50+ languages including Khmer)
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

  // 2. Fallback: Groq Orpheus (English only, higher quality)
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

  const ttsKeys = getAllGroqKeys(req);
  if (ttsKeys.length === 0) {
    res.status(200).json({ audio: [], fallback: true });
    return;
  }

  const results: { id: number; start: number; end: number; audio: string }[] = [];

  for (const seg of segments) {
    if (!seg.translatedText?.trim()) continue;

    let audioBase64 = "";

    // 1. Try Google Translate TTS (free, multilingual)
    try {
      const audioBuffer = await googleTTS(seg.translatedText.trim(), language);
      if (audioBuffer.length > 100) {
        audioBase64 = audioBuffer.toString("base64");
      }
    } catch (err: any) {
      console.warn(`[BatchTTS] Google TTS failed for seg ${seg.id}:`, err?.message);
    }

    // 2. Fallback: Groq Orpheus (English only)
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

var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// server.ts
var import_config = require("dotenv/config");
var import_dotenv = __toESM(require("dotenv"), 1);
var import_express = __toESM(require("express"), 1);
var import_multer = __toESM(require("multer"), 1);
var import_vite = require("vite");
var import_https = __toESM(require("https"), 1);
var import_child_process = require("child_process");
var import_util = require("util");
var import_promises = require("fs/promises");
var import_fs = require("fs");
var import_os = require("os");
var import_path = require("path");
var import_crypto = require("crypto");
var import_edge_tts = require("@travisvn/edge-tts");
import_dotenv.default.config({ path: ".env.local" });
var execFileAsync = (0, import_util.promisify)(import_child_process.execFile);
var PORT = Number(process.env.PORT) || 5173;
var app = (0, import_express.default)();
var upload = (0, import_multer.default)({ storage: import_multer.default.memoryStorage(), limits: { fileSize: 52428800 } });
var uploadLarge = (0, import_multer.default)({ storage: import_multer.default.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
var videoJobs = /* @__PURE__ */ new Map();
var JOBS_ROOT = (0, import_path.join)((0, import_os.tmpdir)(), "video-jobs");
var VIDEO_UPLOAD_LIMIT = 200 * 1024 * 1024;
var uploadsDir = (0, import_path.join)(JOBS_ROOT, "uploads");
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of videoJobs.entries()) {
    if (now - job.createdAt > 90 * 60 * 1e3) {
      import("fs/promises").then((fs) => fs.rm((0, import_path.join)(JOBS_ROOT, id), { recursive: true, force: true }).catch(() => {
      }));
      videoJobs.delete(id);
    }
  }
}, 10 * 60 * 1e3);
function ensureJobDirs() {
  try {
    (0, import_fs.mkdirSync)(JOBS_ROOT, { recursive: true });
  } catch {
  }
  try {
    (0, import_fs.mkdirSync)(uploadsDir, { recursive: true });
  } catch {
  }
}
var videoUpload = (0, import_multer.default)({
  storage: import_multer.default.diskStorage({
    destination: (_req, _file, cb) => {
      ensureJobDirs();
      cb(null, uploadsDir);
    },
    filename: (_req, _file, cb) => cb(null, `${(0, import_crypto.randomUUID)()}.upload`)
  }),
  limits: { fileSize: VIDEO_UPLOAD_LIMIT }
});
var FFMPEG_AVAILABLE = false;
void (async () => {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 15e3 });
    FFMPEG_AVAILABLE = true;
    console.log("[VideoJobs] FFmpeg available \u2014 server-side MP4 generation enabled");
  } catch {
    FFMPEG_AVAILABLE = false;
    console.warn("[VideoJobs] FFmpeg NOT found \u2014 server-side MP4 generation disabled");
  }
})();
var envKeyOrder = ["GROQ_API_KEY", "GROQ_API_KEY2", "GROQ_API_KEY3"];
function rotateKeyToBack(key) {
  const idx = envKeyOrder.findIndex((name) => process.env[name]?.trim() === key);
  if (idx >= 0 && envKeyOrder.length > 1) {
    const [name] = envKeyOrder.splice(idx, 1);
    envKeyOrder.push(name);
  }
}
function getAllGroqKeys(req) {
  const keys = [];
  const headerKey = req.headers["x-groq-api-key"];
  if (headerKey?.trim()) keys.push(headerKey.trim());
  for (const envKey of envKeyOrder) {
    const val = process.env[envKey]?.trim();
    if (val && !keys.includes(val)) keys.push(val);
  }
  return keys;
}
var GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
var GEMINI_FALLBACK_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash"];
var geminiKeyOrder = ["GEMINI_API_KEY", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3"];
function rotateGeminiKeyToBack(key) {
  const idx = geminiKeyOrder.findIndex((name) => process.env[name]?.trim() === key);
  if (idx >= 0 && geminiKeyOrder.length > 1) {
    const [name] = geminiKeyOrder.splice(idx, 1);
    geminiKeyOrder.push(name);
  }
}
function getGeminiKeys() {
  const keys = [];
  for (const envKey of geminiKeyOrder) {
    const val = process.env[envKey]?.trim();
    if (val && !keys.includes(val)) keys.push(val);
  }
  return keys;
}
async function geminiGenerate(keys, model, prompt) {
  let lastErr;
  for (const key of keys) {
    try {
      const res = await fetch(
        `${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
          })
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
async function tryGeminiModels(keys, model, prompt) {
  const candidates = [model, ...GEMINI_FALLBACK_MODELS].filter((m, i, arr) => arr.indexOf(m) === i);
  for (const candidate of candidates) {
    try {
      const res = await geminiGenerate(keys, candidate, prompt);
      if (res.ok) {
        const data = await res.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const text = parts.map((p2) => p2?.text || "").join("").trim();
        if (text) return { choices: [{ message: { content: text } }] };
      } else {
        await res.text().catch(() => "");
        console.warn(`[Translate] Gemini ${candidate} returned ${res.status}`);
      }
    } catch (err) {
      console.warn(`[Translate] Gemini ${candidate} failed:`, err?.message);
      continue;
    }
  }
  return null;
}
async function fetchWithKeyFallback(url, keys, options) {
  let lastErr;
  for (const key of keys) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${key}` }
      });
      if (res.ok) return { res, key };
      const errBody = await res.text().catch(() => "");
      if (res.status === 429 || res.status >= 500 || res.status === 404 || res.status === 403) {
        lastErr = new Error(`HTTP ${res.status} with key ...${key.slice(-6)}: ${errBody.slice(0, 200)}`);
        rotateKeyToBack(key);
        continue;
      }
      return { res, key };
    } catch (err) {
      lastErr = err;
      rotateKeyToBack(key);
    }
  }
  throw lastErr || new Error("All API keys failed");
}
var DEFAULT_TRANSLATION_MODEL = "openai/gpt-oss-120b";
var TARGET_SCRIPT = {
  km: /[\u1780-\u17FF]/,
  zh: /[\u4E00-\u9FFF]/,
  ja: /[\u3040-\u30FF\u4E00-\u9FFF]/,
  ko: /[\uAC00-\uD7AF]/,
  th: /[\u0E00-\u0E7F]/,
  ru: /[\u0400-\u04FF]/,
  ar: /[\u0600-\u06FF]/,
  hi: /[\u0900-\u097F]/
};
function lineInTargetScript(line, targetLanguage) {
  const regex = TARGET_SCRIPT[targetLanguage];
  if (!regex) return true;
  return regex.test(line);
}
function parseTranslatedLines(content) {
  const trimmed = content.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        return arr.map((x) => typeof x === "string" ? x.trim() : String(x).trim()).filter((l) => l.length > 0);
      }
    } catch {
    }
  }
  return content.split("\n").map(
    (l) => l.replace(/^\s*(?:\d+\s*[\.\)\]:]|[-*•])\s*/, "").replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim()
  ).filter((l) => l.length > 0);
}
function buildTranslationPrompt(sourceLanguage, targetLanguage, targetLanguageName, segments) {
  const langPair = `${sourceLanguage} \u2192 ${targetLanguage}`;
  const fullText = segments.map((s) => s.originalText || "").join(" ");
  const numbered = segments.map((s, i) => `${i + 1}. ${s.originalText || ""}`).join("\n");
  return `You are a professional subtitle translator creating natural speech for dubbing. Translate each numbered segment below from ${langPair} (${targetLanguageName || targetLanguage}). Write the way a real person would speak aloud in ${targetLanguage}: natural word order, conversational tone, and clear, easy-to-listen sentences \u2014 never a literal word-for-word rendering. Keep each line short enough to fit subtitle timing. Every translated line MUST be written in the target language (${targetLanguage}) script \u2014 never repeat the source-language text. Use the full transcript below as context so short or ambiguous segments are translated naturally and consistently. Keep the numbering and return ONLY the translated text lines, one per segment, preserving blank lines between segments.

Full transcript: "${fullText}"

${numbered}`;
}
function buildForcedTranslationPrompt(sourceLanguage, targetLanguage, targetLanguageName, segments) {
  const numbered = segments.map((s, i) => `${i + 1}. ${s.originalText || ""}`).join("\n");
  return `Translate the following subtitle segments from ${sourceLanguage} to ${targetLanguage} (${targetLanguageName || targetLanguage}). Write each line the way a real person would speak it aloud: natural, conversational, easy to listen to, short enough for subtitle timing \u2014 never literal word-for-word. Every line MUST be written in the target language's script \u2014 never repeat the original-language text. Return one translation per line, numbered to match the input, with no extra text.

${numbered}`;
}
async function tryChatModels(apiKeys, model, prompt) {
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
            max_tokens: 4096
          })
        }
      );
      if (result.res.ok) {
        return await result.res.json();
      }
      await result.res.text().catch(() => "");
      console.warn(`[Translate] Model ${candidate} returned ${result.res.status}`);
    } catch (err) {
      console.warn(`[Translate] Model ${candidate} failed:`, err?.message);
      continue;
    }
  }
  return null;
}
async function translateSegmentsWithFallback(apiKeys, model, sourceLanguage, targetLanguage, targetLanguageName, segments) {
  const lines = [];
  let pending = segments.map((_, i) => i);
  const callProvider = (m, prompt) => m.startsWith("gemini/") ? tryGeminiModels(getGeminiKeys(), m.slice("gemini/".length), prompt) : tryChatModels(apiKeys, m, prompt);
  const runPass = async (m, buildPrompt) => {
    if (pending.length === 0) return;
    const prompt = buildPrompt(pending.map((i) => segments[i]));
    const chatData = await callProvider(m, prompt);
    const got = chatData ? parseTranslatedLines(chatData.choices?.[0]?.message?.content || "") : [];
    const still = [];
    pending.forEach((idx, j) => {
      if (j < got.length && got[j].trim() && lineInTargetScript(got[j], targetLanguage)) {
        lines[idx] = got[j];
      } else {
        still.push(idx);
      }
    });
    pending = still;
  };
  await runPass(
    model,
    (sub) => buildTranslationPrompt(sourceLanguage, targetLanguage, targetLanguageName, sub)
  );
  await runPass(
    model,
    (sub) => buildForcedTranslationPrompt(sourceLanguage, targetLanguage, targetLanguageName, sub)
  );
  const alternatives = model.startsWith("gemini/") ? ["gemini/gemini-3.6-flash", "gemini/gemini-3.5-flash"] : [
    DEFAULT_TRANSLATION_MODEL,
    "qwen/qwen3.8-27b",
    "qwen/qwen3.6-27b",
    "groq/compound-mini",
    "openai/gpt-oss-20b"
  ];
  const uniqueAlternatives = alternatives.filter((m, i, arr) => arr.indexOf(m) === i && m !== model);
  for (const alt of uniqueAlternatives) {
    if (pending.length === 0) break;
    await runPass(
      alt,
      (sub) => buildForcedTranslationPrompt(sourceLanguage, targetLanguage, targetLanguageName, sub)
    );
  }
  if (pending.length > 0) {
    console.warn(
      `[Translate] ${pending.length}/${segments.length} segment(s) could not be verified in target language "${targetLanguage}"`
    );
  }
  return lines;
}
var EDGE_TTS_VOICES = {
  km: "km-KH-PisethNeural",
  // Khmer (male)
  en: "en-US-AndrewNeural",
  // English (male)
  zh: "zh-CN-XiaoxiaoNeural",
  // Chinese (female)
  ja: "ja-JP-NanamiNeural",
  // Japanese (female)
  ko: "ko-KR-SunHiNeural",
  // Korean (female)
  th: "th-TH-PremwadeeNeural",
  // Thai (female)
  vi: "vi-VN-HoaiMyNeural",
  // Vietnamese (female)
  fr: "fr-FR-DeniseNeural",
  // French (female)
  es: "es-ES-ElviraNeural",
  // Spanish (female)
  de: "de-DE-KatjaNeural",
  // German (female)
  id: "id-ID-GadisNeural",
  // Indonesian (female)
  ru: "ru-RU-SvetlanaNeural",
  // Russian (female)
  ar: "ar-SA-ZariyahNeural",
  // Arabic (female)
  hi: "hi-IN-SwaraNeural",
  // Hindi (female)
  it: "it-IT-ElsaNeural",
  // Italian (female)
  pt: "pt-PT-RaquelNeural"
  // Portuguese (female)
};
async function edgeTTS(text, lang) {
  const voice = EDGE_TTS_VOICES[lang];
  if (!voice) return null;
  try {
    const tts = new import_edge_tts.EdgeTTS(text, voice);
    const result = await tts.synthesize();
    const audio = Buffer.from(await result.audio.arrayBuffer());
    return audio.length > 0 ? audio : null;
  } catch (err) {
    console.warn(`[EdgeTTS] failed for ${lang}:`, err?.message);
    return null;
  }
}
function fetchGoogleTTSChunk(text, lang) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(text.trim());
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${lang}&client=tw-ob`;
    const req = import_https.default.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Google TTS returned ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(15e3, () => {
      req.destroy();
      reject(new Error("Google TTS timeout"));
    });
  });
}
function splitSentences(text) {
  return text.split(/[។!?.]+/).map((s) => s.trim()).filter((s) => s.length > 0);
}
async function googleTTS(text, lang) {
  const sentences = splitSentences(text.trim());
  if (sentences.length === 0) {
    return fetchGoogleTTSChunk(text.trim(), lang);
  }
  const buffers = [];
  const silenceMs = 200;
  const silence = Buffer.alloc(Math.floor(24e3 * silenceMs / 1e3 / 8), 0);
  for (const sentence of sentences) {
    try {
      const chunk = await fetchGoogleTTSChunk(sentence, lang);
      buffers.push(chunk);
      if (sentence !== sentences[sentences.length - 1]) {
        buffers.push(silence);
      }
    } catch {
    }
  }
  if (buffers.length === 0) {
    throw new Error("All TTS chunks failed");
  }
  return Buffer.concat(buffers);
}
app.get("/api/status", (_req, res) => {
  res.json({
    groqConfigured: Boolean(
      process.env.GROQ_API_KEY?.trim() || process.env.GROQ_API_KEY2?.trim() || process.env.GROQ_API_KEY3?.trim()
    ),
    geminiConfigured: Boolean(
      process.env.GEMINI_API_KEY?.trim() || process.env.GEMINI_API_KEY_2?.trim() || process.env.GEMINI_API_KEY_3?.trim()
    )
  });
});
app.get("/api/check-groq-keys", async (_req, res) => {
  const results = [];
  for (const envKey of envKeyOrder) {
    const value = process.env[envKey]?.trim() || "";
    if (!value) {
      results.push({ envKey, configured: false, ok: false, error: "not configured" });
      continue;
    }
    try {
      const r = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${value}` },
        signal: AbortSignal.timeout(2e4)
      });
      results.push({ envKey, configured: true, ok: r.ok, error: r.ok ? null : `HTTP ${r.status}` });
    } catch (err) {
      results.push({ envKey, configured: true, ok: false, error: `network: ${err?.name || "error"}` });
    }
  }
  res.json({ keys: results, allOk: results.every((r) => r.ok) });
});
app.get("/api/check-gemini-keys", async (_req, res) => {
  const results = [];
  let models = [];
  for (const envKey of geminiKeyOrder) {
    const value = process.env[envKey]?.trim() || "";
    if (!value) {
      results.push({ envKey, configured: false, ok: false, error: "not configured" });
      continue;
    }
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(value)}`,
        { signal: AbortSignal.timeout(2e4) }
      );
      if (r.ok && models.length === 0) {
        const data = await r.json();
        const ids = (data?.models || []).map((m) => (m.name || "").split("/").pop() || "").filter((s) => s.length > 0);
        models = [...new Set(ids)].sort();
      }
      results.push({ envKey, configured: true, ok: r.ok, error: r.ok ? null : `HTTP ${r.status}` });
    } catch (err) {
      results.push({ envKey, configured: true, ok: false, error: `network: ${err?.name || "error"}` });
    }
  }
  res.json({ keys: results, allOk: results.every((r) => r.ok), models });
});
app.get("/api/list-groq-models", async (_req, res) => {
  for (const envKey of envKeyOrder) {
    const value = process.env[envKey]?.trim() || "";
    if (!value) continue;
    try {
      const r = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${value}` },
        signal: AbortSignal.timeout(2e4)
      });
      if (r.ok) {
        const data = await r.json();
        res.json({ models: (data?.data || []).map((m) => m.id).filter(Boolean) });
        return;
      }
    } catch {
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
    const whisperData = await whisperRes.json();
    const segments = (whisperData.segments || []).map((seg, i) => ({
      id: i + 1,
      start: seg.start,
      end: seg.end,
      originalText: seg.text?.trim() || "",
      translatedText: ""
    }));
    const detectedLanguage = whisperData.language || sourceLanguage;
    const fullOriginalText = segments.map((s) => s.originalText).join(" ");
    const duration = whisperData.duration || 0;
    const processingTimeMs = 0;
    const translatedLines = await translateSegmentsWithFallback(
      apiKeys,
      translationModel,
      detectedLanguage,
      targetLanguage,
      targetLanguageName,
      segments
    );
    segments.forEach((seg, i) => {
      seg.translatedText = translatedLines[i] || seg.originalText;
    });
    const fullTranslatedText = segments.map((s) => s.translatedText).join(" ");
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
      vttTranslated
    });
  } catch (err) {
    console.error("Transcription error:", err);
    res.status(500).json({ error: err.message || "Transcription failed" });
  }
});
app.post("/api/translate-segments", import_express.default.json(), async (req, res) => {
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
    const translatedLines = await translateSegmentsWithFallback(
      apiKeys,
      translationModel,
      sourceLanguage,
      targetLanguage,
      targetLanguageName,
      segments
    );
    segments.forEach((seg, i) => {
      seg.translatedText = translatedLines[i] || seg.originalText;
    });
    const fullTranslatedText = segments.map((s) => s.translatedText).join(" ");
    const srtTranslated = buildSrt(segments, true);
    const vttTranslated = buildVtt(segments, true);
    res.json({ segments, fullTranslatedText, srtTranslated, vttTranslated, targetLanguage, targetLanguageName });
  } catch (err) {
    console.error("Translation error:", err);
    res.status(500).json({ error: err.message || "Translation failed" });
  }
});
app.post("/api/tts", import_express.default.json(), async (req, res) => {
  const { text, language = "km" } = req.body;
  if (!text || !text.trim()) {
    res.status(400).json({ error: "No text provided" });
    return;
  }
  const edgeAudio = await edgeTTS(text.trim(), language);
  if (edgeAudio && edgeAudio.length > 100) {
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(edgeAudio);
    return;
  }
  try {
    const audioBuffer = await googleTTS(text.trim(), language);
    if (audioBuffer.length > 100) {
      res.setHeader("Content-Type", "audio/mpeg");
      res.send(audioBuffer);
      return;
    }
  } catch (err) {
    console.warn(`[TTS] Google TTS failed for language ${language}:`, err?.message || err);
  }
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
            response_format: "wav"
          })
        }
      );
      if (ttsRes.ok) {
        const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
        res.setHeader("Content-Type", "audio/wav");
        res.send(audioBuffer);
        return;
      }
    } catch {
    }
  }
  res.status(204).end();
});
app.post("/api/batch-tts", import_express.default.json(), async (req, res) => {
  const { segments, language = "km" } = req.body;
  if (!segments || !Array.isArray(segments) || segments.length === 0) {
    res.status(400).json({ error: "No segments provided" });
    return;
  }
  const ttsKeys = getAllGroqKeys(req);
  const results = [];
  for (const seg of segments) {
    if (!seg.translatedText?.trim()) continue;
    let audioBase64 = "";
    try {
      const edgeAudio = await edgeTTS(seg.translatedText.trim(), language);
      if (edgeAudio && edgeAudio.length > 100) {
        audioBase64 = edgeAudio.toString("base64");
      }
    } catch (err) {
      console.warn(`[BatchTTS] Edge TTS failed for seg ${seg.id}:`, err?.message);
    }
    if (!audioBase64) {
      try {
        const audioBuffer = await googleTTS(seg.translatedText.trim(), language);
        if (audioBuffer.length > 100) {
          audioBase64 = audioBuffer.toString("base64");
        }
      } catch (err) {
        console.warn(`[BatchTTS] Google TTS failed for seg ${seg.id}:`, err?.message);
      }
    }
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
              response_format: "wav"
            })
          }
        );
        if (ttsRes.ok) {
          const buf = Buffer.from(await ttsRes.arrayBuffer());
          if (buf.length > 100) {
            audioBase64 = buf.toString("base64");
          }
        }
      } catch {
      }
    }
    results.push({
      id: seg.id,
      start: seg.start,
      end: seg.end,
      audio: audioBase64
    });
  }
  res.json({ audio: results, fallback: false });
});
app.post("/api/render-mp4", uploadLarge.single("video"), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No video file provided" });
    return;
  }
  const tmpDir = await (0, import_promises.mkdtemp)((0, import_path.join)((0, import_os.tmpdir)(), "render-"));
  const inputPath = (0, import_path.join)(tmpDir, "input.webm");
  const outputPath = (0, import_path.join)(tmpDir, "output.mp4");
  try {
    await (0, import_promises.writeFile)(inputPath, file.buffer);
    console.log(`[RenderMP4] Converting ${file.originalname} (${(file.size / 1024 / 1024).toFixed(1)}MB) \u2192 MP4...`);
    await execFileAsync("ffmpeg", [
      "-i",
      inputPath,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      "-y",
      outputPath
    ], { timeout: 12e4 });
    const { stdout: probeStdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,duration",
      "-of",
      "json",
      outputPath
    ], { timeout: 1e4 });
    const probeData = JSON.parse(probeStdout);
    const videoStream = probeData.streams?.[0];
    if (!videoStream || !videoStream.codec_name) {
      throw new Error("FFmpeg produced no valid video stream");
    }
    const { stdout: audioProbe } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "json",
      outputPath
    ], { timeout: 1e4 });
    const audioData = JSON.parse(audioProbe);
    if (!audioData.streams?.[0]) {
      throw new Error("FFmpeg produced no valid audio stream");
    }
    const mp4Buffer = await (0, import_promises.readFile)(outputPath);
    if (mp4Buffer.length < 1e3) {
      throw new Error("Output MP4 is too small to be valid");
    }
    const now = /* @__PURE__ */ new Date();
    const filename = `translated-khmer-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}.mp4`;
    console.log(`[RenderMP4] Success: ${filename} (${(mp4Buffer.length / 1024 / 1024).toFixed(1)}MB, ${videoStream.width}x${videoStream.height}, ${videoStream.codec_name}+${audioData.streams[0].codec_name})`);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(mp4Buffer);
  } catch (err) {
    console.error("[RenderMP4] Error:", err);
    res.status(500).json({ error: err.message || "Video export failed. Please try again." });
  } finally {
    try {
      await (0, import_promises.unlink)(inputPath);
    } catch {
    }
    try {
      await (0, import_promises.unlink)(outputPath);
    } catch {
    }
    try {
      await import("fs/promises").then((fs) => fs.rm(tmpDir, { recursive: true, force: true }));
    } catch {
    }
  }
});
function setJobProgress(id, progress, message) {
  const job = videoJobs.get(id);
  if (!job) return;
  job.progress = Math.max(0, Math.min(100, Math.round(progress)));
  job.message = message;
}
function sniffAudioKind(buf) {
  if (buf.length > 12 && buf[0] === 82 && buf[1] === 73 && buf[2] === 70 && buf[3] === 70) return "wav";
  if (buf.length > 4 && (buf[0] === 255 && (buf[1] & 224) === 224 || buf[0] === 73 && buf[1] === 68 && buf[2] === 51)) return "mp3";
  return "mp3";
}
var MIME_EXT = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/m4v": "m4v",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/flac": "flac",
  "audio/opus": "opus"
};
function safeExt(mime, name) {
  const fromMime = mime ? MIME_EXT[mime.toLowerCase()] : void 0;
  if (fromMime) return fromMime;
  const m = (name || "").toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  const ext = m ? m[1] : "";
  return ["mp4", "webm", "mov", "mkv", "m4v", "mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"].includes(ext) ? ext : "mp4";
}
function isVideoMime(mime, name) {
  if ((mime || "").startsWith("video/")) return true;
  return /\.(mp4|webm|mov|mkv|m4v)$/i.test(name || "");
}
function runFfmpegWithProgress(args, totalDuration, onProgress, timeoutMs = 20 * 60 * 1e3) {
  return new Promise((resolve, reject) => {
    const proc = (0, import_child_process.spawn)("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try {
        proc.kill("SIGKILL");
      } catch {
      }
      reject(new Error("FFmpeg timed out"));
    }, timeoutMs);
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > 6e4) stdout = stdout.slice(-2e4);
      const m = stdout.match(/out_time_us=(\d+)/g) || stdout.match(/out_time_ms=(\d+)/g);
      if (m && totalDuration > 0) {
        const last = m[m.length - 1];
        const us = Number(last.split("=")[1]);
        if (Number.isFinite(us) && us > 0) onProgress(Math.min(1, us / 1e6 / totalDuration));
      }
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 6e4) stderr = stderr.slice(-2e4);
    });
    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-600)}`));
    });
  });
}
async function probeDuration(ffprobeArgs) {
  try {
    const res = await execFileAsync("ffprobe", ffprobeArgs, { timeout: 2e4 });
    const n = Number(res.stdout.trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
async function processVideoJob(jobId) {
  const job = videoJobs.get(jobId);
  if (!job || !job.inputPath) return;
  const jobDir = (0, import_path.join)(JOBS_ROOT, jobId);
  try {
    setJobProgress(jobId, 12, "Analyzing media");
    const probeRes = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      job.inputPath
    ], { timeout: 3e4, maxBuffer: 16 * 1024 * 1024 });
    const info = JSON.parse(probeRes.stdout || "{}");
    const streams = info.streams || [];
    const vStream = streams.find((s) => s.codec_type === "video");
    const aStream = streams.find((s) => s.codec_type === "audio");
    const duration = Number(info.format?.duration || vStream?.duration || aStream?.duration || 0) || 0;
    job.hasVideo = Boolean(vStream);
    setJobProgress(jobId, 16, "Extracting audio");
    const segs = job.segments || [];
    const clips = [];
    const withAudio = segs.filter((s) => (s.dubbedAudioBase64 || "").length > 100);
    for (let i = 0; i < withAudio.length; i++) {
      const seg = withAudio[i];
      try {
        const buf = Buffer.from(seg.dubbedAudioBase64 || "", "base64");
        if (buf.length < 100) continue;
        const kind = sniffAudioKind(buf);
        const clipPath = (0, import_path.join)(jobDir, `clip_${String(clips.length).padStart(4, "0")}.${kind}`);
        await (0, import_promises.writeFile)(clipPath, buf);
        const dur = await probeDuration(["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", clipPath]);
        if (dur > 0.05) clips.push({ start: Math.max(0, seg.start), end: Math.max(seg.end, seg.start + 0.3), path: clipPath, duration: dur });
      } catch (err) {
        console.warn(`[VideoJobs] clip ${i} failed:`, err?.message);
      }
      setJobProgress(jobId, 20 + Math.round(25 * ((i + 1) / Math.max(withAudio.length, 1))), `Generating translated audio (${i + 1}/${withAudio.length})`);
    }
    setJobProgress(jobId, 50, "Mixing audio");
    const args = ["-y", "-i", job.inputPath];
    for (const c of clips) args.push("-i", c.path);
    const filters = [];
    const hasAudio = Boolean(aStream);
    const stereo = (aStream?.channels || 0) >= 2;
    const applyCenterCancel = job.removeVocals === true && stereo;
    if (hasAudio) {
      filters.push(
        applyCenterCancel ? "[0:a]aformat=channel_layouts=stereo,pan=stereo|c0=c0-c1|c1=c1-c0[bg0]" : "[0:a]aformat=channel_layouts=stereo[bg0]"
      );
      const cond = clips.map((c) => `between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})`).join("+");
      filters.push(
        cond ? `[bg0]volume='if(${cond}>=1,0.45,1)':eval=frame[bg]` : "[bg0]anull[bg]"
      );
    }
    const buildAtempo = (rate) => {
      if (Math.abs(rate - 1) < 0.015) return "";
      const parts = [];
      let r = rate;
      let guard = 0;
      while (r > 2 && guard < 6) {
        parts.push("atempo=2.0");
        r /= 2;
        guard++;
      }
      while (r < 0.5 && guard < 6) {
        parts.push("atempo=0.5");
        r /= 0.5;
        guard++;
      }
      parts.push(`atempo=${r.toFixed(4)}`);
      return "," + parts.join(",");
    };
    clips.forEach((c, i) => {
      const segDur = Math.max(c.end - c.start, 0.4);
      const rawRate = c.duration / segDur;
      const clampedRate = Math.min(Math.max(rawRate, 0.5), 4);
      const delayMs = Math.max(0, Math.round(c.start * 1e3));
      let chain = "aformat=channel_layouts=stereo";
      chain += buildAtempo(clampedRate);
      chain += `,aresample=48000:async=1:min_hard_comp=0.100000,apad,atrim=start=0:duration=${segDur.toFixed(3)}`;
      chain += `,adelay=${delayMs}|${delayMs}:all=1`;
      filters.push(`[${i + 1}:a]${chain}[v${i}]`);
    });
    let aout = null;
    if (hasAudio) {
      const inputs = ["[bg]", ...clips.map((_, i) => `[v${i}]`)];
      if (inputs.length === 1) {
        aout = "[bg]";
      } else {
        filters.push(`${inputs.join("")}amix=inputs=${inputs.length}:duration=first:dropout_transition=0:normalize=0,aresample=48000[aout]`);
        aout = "[aout]";
      }
    } else if (clips.length > 0) {
      const inputs = clips.map((_, i) => `[v${i}]`);
      if (inputs.length === 1) {
        aout = inputs[0];
      } else {
        filters.push(`${inputs.join("")}amix=inputs=${inputs.length}:duration=longest:dropout_transition=0:normalize=0,aresample=48000[aout]`);
        aout = "[aout]";
      }
    }
    const isVideo = Boolean(vStream);
    const outputPath = (0, import_path.join)(jobDir, "output.mp4");
    const buildArgs = (copyVideo) => {
      const a = ["-y", "-i", job.inputPath];
      for (const c of clips) a.push("-i", c.path);
      if (filters.length > 0) a.push("-filter_complex", filters.join(";"));
      if (isVideo) a.push("-map", "0:v:0");
      if (aout) a.push("-map", aout);
      if (isVideo) {
        if (copyVideo) a.push("-c:v", "copy");
        else a.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p");
      }
      if (aout) a.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000");
      if (isVideo) a.push("-movflags", "+faststart", "-shortest");
      a.push(outputPath);
      return a;
    };
    const canCopyVideo = Boolean(
      vStream && vStream.codec_name === "h264" && ["yuv420p", "yuvj420p"].includes(String(vStream.pix_fmt || ""))
    );
    let usedCopy = false;
    try {
      if (canCopyVideo) {
        await runFfmpegWithProgress(buildArgs(true), duration || 0, (f) => setJobProgress(jobId, 60 + Math.round(30 * f), `Rendering MP4 (${Math.round(f * 100)}%)`));
        usedCopy = true;
      } else {
        throw new Error("re-encode required");
      }
    } catch {
      setJobProgress(jobId, 60, "Rendering MP4 (re-encoding video)");
      await runFfmpegWithProgress(buildArgs(false), duration || 0, (f) => setJobProgress(jobId, 60 + Math.round(30 * f), `Rendering MP4 (${Math.round(f * 100)}%)`));
    }
    const outProbe = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,codec_type", "-of", "json", outputPath], { timeout: 2e4 });
    const outInfo = JSON.parse(outProbe.stdout || "{}");
    const outStreams = outInfo.streams || [];
    if (outStreams.length === 0) throw new Error("FFmpeg produced no valid streams");
    const outSize = (await (0, import_promises.stat)(outputPath)).size;
    if (outSize < 1e3) throw new Error("Output file is too small to be valid");
    const now = /* @__PURE__ */ new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    const filename = isVideo ? `translated-${job.targetLanguage || "video"}-${stamp}.mp4` : `translated-${job.targetLanguage || "audio"}-${stamp}.m4a`;
    job.status = "done";
    job.progress = 100;
    job.message = "Ready";
    job.outputPath = outputPath;
    job.downloadFilename = filename;
    job.size = outSize;
    console.log(`[VideoJobs] Job ${jobId} done: ${filename} (${(outSize / 1024 / 1024).toFixed(1)}MB, copy=${usedCopy})`);
  } catch (err) {
    console.error(`[VideoJobs] Job ${jobId} failed:`, err?.message || err);
    job.status = "error";
    job.error = err?.message || "MP4 generation failed";
    job.progress = 100;
  }
}
app.get("/api/video/capabilities", (_req, res) => {
  res.json({ ffmpeg: FFMPEG_AVAILABLE, chunked: false, maxUploadBytes: VIDEO_UPLOAD_LIMIT });
});
app.post("/api/video/upload", videoUpload.single("video"), async (req, res) => {
  if (!FFMPEG_AVAILABLE) {
    res.status(501).json({ error: "FFmpeg is not installed on the server \u2014 MP4 generation is unavailable." });
    return;
  }
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No video file provided" });
    return;
  }
  const id = (0, import_crypto.randomUUID)();
  const jobDir = (0, import_path.join)(JOBS_ROOT, id);
  try {
    await (0, import_promises.mkdir)(jobDir, { recursive: true });
    const ext = safeExt(file.mimetype, file.originalname);
    const inputPath = (0, import_path.join)(jobDir, `original.${ext}`);
    await (0, import_promises.rename)(file.path, inputPath);
    videoJobs.set(id, {
      id,
      status: "queued",
      progress: 5,
      message: "Uploaded",
      createdAt: Date.now(),
      inputPath,
      originalName: file.originalname,
      hasVideo: isVideoMime(file.mimetype, file.originalname),
      targetLanguage: "km"
    });
    res.json({ jobId: id, hasVideo: isVideoMime(file.mimetype, file.originalname), size: file.size });
  } catch (err) {
    try {
      await (0, import_promises.unlink)(file.path);
    } catch {
    }
    res.status(500).json({ error: err?.message || "Failed to store upload" });
  }
});
app.post("/api/video/process", import_express.default.json({ limit: "80mb" }), async (req, res) => {
  const { jobId, segments, removeVocals = true, targetLanguage = "km" } = req.body || {};
  const job = videoJobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Unknown jobId \u2014 please upload the video again." });
    return;
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    res.status(400).json({ error: "No subtitle segments provided" });
    return;
  }
  if (job.status === "processing") {
    res.json({ jobId, status: "processing", progress: job.progress });
    return;
  }
  if (job.status === "done") {
    res.json({ jobId, status: "done", progress: 100 });
    return;
  }
  job.segments = segments;
  job.removeVocals = Boolean(removeVocals);
  job.targetLanguage = String(targetLanguage || "km");
  job.status = "processing";
  job.progress = 10;
  job.message = "Preparing";
  job.error = void 0;
  res.json({ jobId, status: "processing" });
  void processVideoJob(jobId);
});
app.get("/api/video/status/:id", (req, res) => {
  const job = videoJobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Unknown jobId" });
    return;
  }
  res.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    hasVideo: job.hasVideo,
    size: job.status === "done" ? job.size : void 0,
    downloadFilename: job.status === "done" ? job.downloadFilename : void 0
  });
});
app.get("/api/video/download/:id", async (req, res) => {
  const job = videoJobs.get(req.params.id);
  if (!job || job.status !== "done" || !job.outputPath) {
    res.status(404).json({ error: "Video is not ready yet" });
    return;
  }
  try {
    const size = (await (0, import_promises.stat)(job.outputPath)).size;
    res.setHeader("Content-Type", job.hasVideo ? "video/mp4" : "audio/mp4");
    res.setHeader("Content-Length", String(size));
    res.setHeader("Content-Disposition", `attachment; filename="${job.downloadFilename || "translated-video.mp4"}"`);
    res.setHeader("Cache-Control", "private, max-age=600");
    (0, import_fs.createReadStream)(job.outputPath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err?.message || "Download failed" });
  }
});
function formatSrtTime(t) {
  const ms = Math.floor(t % 1 * 1e3);
  const total = Math.floor(t);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}
function formatVttTime(t) {
  const ms = Math.floor(t % 1 * 1e3);
  const total = Math.floor(t);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms, 3)}`;
}
function p(n, w = 2) {
  return String(n).padStart(w, "0");
}
function buildSrt(segments, useTranslation) {
  return segments.map((seg, i) => {
    const text = useTranslation ? seg.translatedText : seg.originalText;
    return `${i + 1}
${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}
${text.trim()}
`;
  }).join("\n");
}
function buildVtt(segments, useTranslation) {
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
async function startServer() {
  const vite = await (0, import_vite.createServer)({
    server: { middlewareMode: true },
    appType: "spa"
  });
  app.use(vite.middlewares);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
  });
}
startServer();
//# sourceMappingURL=server.cjs.map

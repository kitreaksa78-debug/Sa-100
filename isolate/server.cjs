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
var import_os = require("os");
var import_path = require("path");
import_dotenv.default.config({ path: ".env.local" });
var execFileAsync = (0, import_util.promisify)(import_child_process.execFile);
var PORT = Number(process.env.PORT) || 5173;
var app = (0, import_express.default)();
var upload = (0, import_multer.default)({ storage: import_multer.default.memoryStorage(), limits: { fileSize: 52428800 } });
var uploadLarge = (0, import_multer.default)({ storage: import_multer.default.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
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
  return `You are a professional subtitle translator. Translate each numbered segment below from ${langPair} (${targetLanguageName || targetLanguage}). Every translated line MUST be written in the target language (${targetLanguage}) script \u2014 never repeat the source-language text. Use the full transcript below as context so short or ambiguous segments are translated naturally and consistently. Keep the numbering and return ONLY the translated text lines, one per segment, preserving blank lines between segments.

Full transcript: "${fullText}"

${numbered}`;
}
function buildForcedTranslationPrompt(sourceLanguage, targetLanguage, targetLanguageName, segments) {
  const numbered = segments.map((s, i) => `${i + 1}. ${s.originalText || ""}`).join("\n");
  return `Translate the following subtitle segments from ${sourceLanguage} to ${targetLanguage} (${targetLanguageName || targetLanguage}). Every line MUST be written in the target language's script \u2014 never repeat the original-language text. Return one translation per line, numbered to match the input, with no extra text.

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
  const runPass = async (m, buildPrompt) => {
    if (pending.length === 0) return;
    const prompt = buildPrompt(pending.map((i) => segments[i]));
    const chatData = await tryChatModels(apiKeys, m, prompt);
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
  const alternatives = [
    DEFAULT_TRANSLATION_MODEL,
    "qwen/qwen3.8-27b",
    "qwen/qwen3.6-27b",
    "groq/compound-mini",
    "openai/gpt-oss-20b"
  ].filter((m, i, arr) => arr.indexOf(m) === i && m !== model);
  for (const alt of alternatives) {
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
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim())
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
  if (ttsKeys.length === 0) {
    res.status(200).json({ audio: [], fallback: true });
    return;
  }
  const results = [];
  for (const seg of segments) {
    if (!seg.translatedText?.trim()) continue;
    let audioBase64 = "";
    try {
      const audioBuffer = await googleTTS(seg.translatedText.trim(), language);
      if (audioBuffer.length > 100) {
        audioBase64 = audioBuffer.toString("base64");
      }
    } catch (err) {
      console.warn(`[BatchTTS] Google TTS failed for seg ${seg.id}:`, err?.message);
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

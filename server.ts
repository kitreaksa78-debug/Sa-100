import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import multer from 'multer';
import Groq from 'groq-sdk';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = 3000;

// Increase payload limit for JSON/base64
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configure multer for file uploads to temp directory
const uploadDir = path.join(os.tmpdir(), 'groq-uploads');
if (!fs.existsSync(uploadDir)) {
  try {
    fs.mkdirSync(uploadDir, { recursive: true });
  } catch (err) {
    console.error('Failed to create upload dir:', err);
  }
}

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB max
  },
});

// Helper to format seconds to SRT timestamp: 00:00:00,000
function formatSrtTime(seconds: number): string {
  const safeSec = isNaN(seconds) || seconds === undefined || seconds === null ? 0 : Math.max(0, seconds);
  const pad = (n: number, z = 2) => String(Math.floor(n)).padStart(z, '0');
  const ms = Math.floor((safeSec % 1) * 1000);
  const totalSec = Math.floor(safeSec);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

// Helper to format seconds to VTT timestamp: 00:00:00.000
function formatVttTime(seconds: number): string {
  const safeSec = isNaN(seconds) || seconds === undefined || seconds === null ? 0 : Math.max(0, seconds);
  const pad = (n: number, z = 2) => String(Math.floor(n)).padStart(z, '0');
  const ms = Math.floor((safeSec % 1) * 1000);
  const totalSec = Math.floor(safeSec);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

// Generate SRT file string
function generateSrt(segments: Array<{ id: number; start: number; end: number; text: string }>): string {
  return segments
    .map((seg, idx) => {
      const num = idx + 1;
      const start = formatSrtTime(seg.start);
      const end = formatSrtTime(seg.end);
      return `${num}\n${start} --> ${end}\n${seg.text.trim()}\n`;
    })
    .join('\n');
}

// Generate WebVTT file string
function generateVtt(segments: Array<{ id: number; start: number; end: number; text: string }>): string {
  const lines = ['WEBVTT', ''];
  segments.forEach((seg, idx) => {
    const start = formatVttTime(seg.start);
    const end = formatVttTime(seg.end);
    lines.push(`${idx + 1}`);
    lines.push(`${start} --> ${end}`);
    lines.push(seg.text.trim());
    lines.push('');
  });
  return lines.join('\n');
}

// Resolve Groq client instance
function getGroqClient(customKey?: string): Groq {
  const apiKey = (customKey && customKey.trim()) || process.env.GROQ_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error('GROQ_API_KEY_REQUIRED');
  }
  return new Groq({ apiKey: apiKey.trim() });
}

// Helper to perform multi-model subtitle translation with automatic fallback
async function translateSubtitleSegments({
  groq,
  segments,
  targetLanguage,
  targetLanguageName,
  sourceLanguage,
  preferredModel,
}: {
  groq: Groq;
  segments: Array<{ id: number; text: string }>;
  targetLanguage: string;
  targetLanguageName: string;
  sourceLanguage: string;
  preferredModel?: string;
}): Promise<{
  translationMap: Map<number, string>;
  modelUsed: string;
}> {
  // Try preferred model first, then known available high-performance Groq models
  const candidateModels = [
    preferredModel,
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
  ].filter(Boolean) as string[];

  // Deduplicate while preserving priority order
  const modelsToTry = Array.from(new Set(candidateModels));

  const translationPrompt = `You are a professional film and media subtitle translator.
Translate the following subtitle segments from "${sourceLanguage || 'source'}" into "${targetLanguageName}" (${targetLanguage}).

CRITICAL GUIDELINES:
1. Translate accurately, naturally, and contextually for subtitles.
2. If the target is Khmer (km), write in natural, grammatically correct Khmer script (ភាសាខ្មែរ).
3. Preserve the exact segment IDs.
4. Return ONLY a valid JSON object with a "translations" array. Each item must contain:
   - "id": number (matching segment id)
   - "translatedText": string (the translated subtitle line)

Input segments to translate:
${JSON.stringify(
  segments.map((s) => ({ id: s.id, text: s.text })),
  null,
  2
)}`;

  let lastError: any = null;

  for (const model of modelsToTry) {
    try {
      console.log(`Attempting subtitle translation with model: ${model}`);
      const chatCompletion = await groq.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are an expert film and media subtitle translator. You output only valid JSON matching the requested schema.',
          },
          {
            role: 'user',
            content: translationPrompt,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      });

      const replyContent = chatCompletion.choices[0]?.message?.content || '{}';
      let parsedResult: any = {};
      try {
        parsedResult = JSON.parse(replyContent);
      } catch {
        const jsonMatch = replyContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsedResult = JSON.parse(jsonMatch[0]);
        }
      }

      const translationMap = new Map<number, string>();
      if (Array.isArray(parsedResult.translations)) {
        parsedResult.translations.forEach((item: any) => {
          if (item.id !== undefined && item.translatedText) {
            translationMap.set(Number(item.id), String(item.translatedText).trim());
          }
        });
      }

      if (translationMap.size > 0 || segments.length === 0) {
        console.log(`Translation successful using model: ${model} (${translationMap.size} lines)`);
        return { translationMap, modelUsed: model };
      }
    } catch (err: any) {
      console.warn(`Translation attempt with model "${model}" failed:`, err?.message || err);
      lastError = err;
      // Proceed to try next model in candidate list
    }
  }

  throw lastError || new Error('All translation models failed to translate segments');
}

// 1. Check API configuration status
app.get('/api/status', (req, res) => {
  const groqServerKey = !!(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim());
  const geminiServerKey = !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
  res.json({
    groqConfigured: groqServerKey,
    geminiConfigured: geminiServerKey,
    defaultTranslationModel: 'openai/gpt-oss-120b',
    supportedModels: [
      { id: 'whisper-large-v3', name: 'Whisper Large v3 (Best Quality)', type: 'audio' },
      { id: 'whisper-large-v3-turbo', name: 'Whisper Large v3 Turbo (Fast)', type: 'audio' },
      { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B (High Quality & Context)', type: 'llm' },
      { id: 'openai/gpt-oss-20b', name: 'GPT OSS 20B (Ultra Fast)', type: 'llm' },
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B (Meta Llama)', type: 'llm' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B (Fast)', type: 'llm' },
    ],
  });
});

// 2. Verify a Groq API key
app.post('/api/verify-groq-key', async (req, res) => {
  const customKey = (req.body.apiKey as string) || (req.headers['x-groq-api-key'] as string);
  try {
    const groq = getGroqClient(customKey);
    const models = await groq.models.list();
    const hasWhisper = models.data.some((m) => m.id.includes('whisper'));
    res.json({
      valid: true,
      message: 'API Key is valid and active on Groq!',
      hasWhisper,
    });
  } catch (err: any) {
    res.status(400).json({
      valid: false,
      error: err?.message || 'Invalid Groq API key. Please check your key.',
    });
  }
});

// 3. Audio & Video Transcription + Translation
app.post('/api/transcribe-and-translate', upload.single('file'), async (req, res) => {
  const uploadedFile = req.file;
  let tempFilePath: string | null = null;

  try {
    if (!uploadedFile) {
      return res.status(400).json({ error: 'No audio or video file uploaded' });
    }

    tempFilePath = uploadedFile.path;
    // Rename temp file to have proper original extension so Groq identifies mime type
    const originalExt = path.extname(uploadedFile.originalname) || '.mp3';
    const finalFilePath = `${tempFilePath}${originalExt}`;
    try {
      fs.renameSync(tempFilePath, finalFilePath);
      tempFilePath = finalFilePath;
    } catch (renameErr) {
      console.warn('Could not rename temp file with extension, proceeding with original temp path:', renameErr);
    }

    const customKey = (req.headers['x-groq-api-key'] as string) || (req.body.apiKey as string);
    const whisperModel = (req.body.whisperModel as string) || 'whisper-large-v3';
    const translationModel = (req.body.translationModel as string) || 'openai/gpt-oss-120b';
    const targetLanguage = (req.body.targetLanguage as string) || 'km'; // Default to Khmer
    const targetLanguageName = (req.body.targetLanguageName as string) || 'Khmer';
    const sourceLanguage = (req.body.sourceLanguage as string) || '';

    const groq = getGroqClient(customKey);

    const startTime = Date.now();

    // Step 1: Transcribe with Groq Whisper
    const transcriptionParams: any = {
      file: fs.createReadStream(tempFilePath),
      model: whisperModel,
      response_format: 'verbose_json',
      temperature: 0.0,
    };

    if (sourceLanguage && sourceLanguage !== 'auto') {
      transcriptionParams.language = sourceLanguage;
    }

    const whisperResponse: any = await groq.audio.transcriptions.create(transcriptionParams);

    const detectedLanguage = whisperResponse.language || sourceLanguage || 'en';
    const duration = whisperResponse.duration || 0;
    const fullOriginalText = whisperResponse.text || '';

    // Process segments from Whisper
    let rawSegments: Array<{ id: number; start: number; end: number; text: string }> = [];
    if (Array.isArray(whisperResponse.segments) && whisperResponse.segments.length > 0) {
      rawSegments = whisperResponse.segments.map((s: any, idx: number) => ({
        id: idx + 1,
        start: Number(s.start || 0),
        end: Number(s.end || 0),
        text: (s.text || '').trim(),
      }));
    } else {
      // Fallback single segment if no segments array
      rawSegments = [
        {
          id: 1,
          start: 0,
          end: duration || 5,
          text: fullOriginalText,
        },
      ];
    }

    // Step 2: Translate segments using Groq (e.g. into Khmer or specified language)
    let translatedSegments: Array<{ id: number; start: number; end: number; originalText: string; translatedText: string }> = [];
    let fullTranslatedText = '';
    let usedTranslationModel = translationModel;

    if (rawSegments.length > 0) {
      try {
        const { translationMap, modelUsed } = await translateSubtitleSegments({
          groq,
          segments: rawSegments.map((s) => ({ id: s.id, text: s.text })),
          targetLanguage,
          targetLanguageName,
          sourceLanguage: detectedLanguage,
          preferredModel: translationModel,
        });

        usedTranslationModel = modelUsed;
        translatedSegments = rawSegments.map((s) => {
          const trans = translationMap.get(s.id) || s.text;
          return {
            id: s.id,
            start: s.start,
            end: s.end,
            originalText: s.text,
            translatedText: trans,
          };
        });

        fullTranslatedText = translatedSegments.map((s) => s.translatedText).join(' ');
      } catch (transErr: any) {
        console.error('Translation error across models:', transErr);
        // If translation fails, provide original text as fallback so transcription isn't lost
        translatedSegments = rawSegments.map((s) => ({
          id: s.id,
          start: s.start,
          end: s.end,
          originalText: s.text,
          translatedText: s.text,
        }));
        fullTranslatedText = fullOriginalText;
      }
    }

    const processingTimeMs = Date.now() - startTime;

    // Generate SRT and VTT formats
    const srtOriginal = generateSrt(
      rawSegments.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.text }))
    );
    const srtTranslated = generateSrt(
      translatedSegments.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.translatedText }))
    );

    const vttOriginal = generateVtt(
      rawSegments.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.text }))
    );
    const vttTranslated = generateVtt(
      translatedSegments.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.translatedText }))
    );

    res.json({
      success: true,
      detectedLanguage,
      targetLanguage,
      targetLanguageName,
      translationModelUsed: usedTranslationModel,
      duration,
      processingTimeMs,
      fullOriginalText,
      fullTranslatedText,
      segments: translatedSegments,
      srtOriginal,
      srtTranslated,
      vttOriginal,
      vttTranslated,
    });
  } catch (err: any) {
    console.error('API Error:', err);
    if (err.message === 'GROQ_API_KEY_REQUIRED') {
      return res.status(401).json({
        error: 'Groq API Key is required. Please provide a Groq API Key or set GROQ_API_KEY in .env',
        code: 'MISSING_API_KEY',
      });
    }
    return res.status(500).json({
      error: err?.message || 'Error processing audio/video transcription and translation',
    });
  } finally {
    // Clean up temporary uploaded file
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (cleanupErr) {
        console.warn('Could not remove temp file:', cleanupErr);
      }
    }
  }
});

// 4. Translate existing segments to a different target language
app.post('/api/translate-segments', async (req, res) => {
  try {
    const { segments, targetLanguage, targetLanguageName, sourceLanguage, translationModel } = req.body;
    const customKey = (req.headers['x-groq-api-key'] as string) || (req.body.apiKey as string);

    if (!Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({ error: 'Segments array is required' });
    }

    const groq = getGroqClient(customKey);
    const modelToUse = translationModel || 'openai/gpt-oss-120b';

    const { translationMap, modelUsed } = await translateSubtitleSegments({
      groq,
      segments: segments.map((s: any) => ({ id: s.id, text: s.originalText || s.text })),
      targetLanguage,
      targetLanguageName: targetLanguageName || targetLanguage,
      sourceLanguage: sourceLanguage || 'source',
      preferredModel: modelToUse,
    });

    const updatedSegments = segments.map((s: any) => ({
      ...s,
      translatedText: translationMap.get(Number(s.id)) || s.originalText || s.text,
    }));

    const fullTranslatedText = updatedSegments.map((s: any) => s.translatedText).join(' ');
    const srtTranslated = generateSrt(
      updatedSegments.map((s: any) => ({ id: s.id, start: s.start, end: s.end, text: s.translatedText }))
    );
    const vttTranslated = generateVtt(
      updatedSegments.map((s: any) => ({ id: s.id, start: s.start, end: s.end, text: s.translatedText }))
    );

    res.json({
      success: true,
      targetLanguage,
      targetLanguageName,
      translationModelUsed: modelUsed,
      segments: updatedSegments,
      fullTranslatedText,
      srtTranslated,
      vttTranslated,
    });
  } catch (err: any) {
    console.error('Translation error:', err);
    res.status(500).json({ error: err?.message || 'Failed to translate segments' });
  }
});

// 5. High-fidelity AI Text-to-Speech (TTS) Voice Synthesis
app.post('/api/tts', async (req, res) => {
  try {
    const { text, language = 'km', voice } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Text is required for TTS synthesis' });
    }

    const cleanText = text.trim();
    const langCode = (language || 'km').toLowerCase().split('-')[0];

    // Priority 1: Groq Orpheus AI Voice for English or Arabic if requested
    const customKey = (req.headers['x-groq-api-key'] as string) || (req.body.apiKey as string);
    if ((langCode === 'en' || langCode === 'ar') && cleanText.length < 500) {
      try {
        const groq = getGroqClient(customKey);
        const orpheusModel = langCode === 'ar' ? 'canopylabs/orpheus-arabic-saudi' : 'canopylabs/orpheus-v1-english';
        const selectedVoice = voice || (langCode === 'ar' ? 'fahad' : 'autumn');
        const speechRes = await groq.audio.speech.create({
          model: orpheusModel,
          input: cleanText,
          voice: selectedVoice,
          response_format: 'wav',
        });
        const arrayBuf = await speechRes.arrayBuffer();
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(Buffer.from(arrayBuf));
      } catch (orpheusErr) {
        console.warn('Groq Orpheus TTS failed, falling back to multi-lingual voice engine:', orpheusErr);
      }
    }

    // Priority 2: Google Neural TTS engine with native Khmer (km) and 50+ global languages support
    const targetTl = langCode === 'km' ? 'km' : langCode;
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(
      targetTl
    )}&client=tw-ob&q=${encodeURIComponent(cleanText.slice(0, 1000))}`;

    const ttsResponse = await fetch(ttsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'audio/mpeg, audio/*; q=0.9',
      },
    });

    if (ttsResponse.ok) {
      const audioArrayBuf = await ttsResponse.arrayBuffer();
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(Buffer.from(audioArrayBuf));
    }

    throw new Error(`TTS upstream service returned status ${ttsResponse.status}`);
  } catch (err: any) {
    console.error('TTS synthesis error:', err);
    res.status(500).json({ error: err?.message || 'Failed to synthesize AI voice' });
  }
});

// Explicit 404 handler for any unknown /api/* endpoints (prevents falling through to Vite HTML fallback)
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.path}` });
});

// Express API Error Handler (Ensures all errors return JSON instead of default HTML)
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Express API Error Handler:', err);
  if (res.headersSent) {
    return next(err);
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'The uploaded file is too large (maximum 50MB). Please select a smaller audio or video file.',
        code: 'LIMIT_FILE_SIZE',
      });
    }
    return res.status(400).json({
      error: `File upload error: ${err.message}`,
      code: err.code,
    });
  }
  res.status(err.status || 500).json({
    error: err?.message || 'An internal server error occurred',
  });
});

// Vite middleware & Static Serving
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

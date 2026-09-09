"""Freebuff serverless API entrypoint — all /api/* endpoints in one WSGI app.

The Groq API keys (GROQ_API_KEY, GROQ_API_KEY2, GROQ_API_KEY3) live only in
server environment variables — never in the browser. Every Groq call rotates
through the keys, falling back to the next on 429/5xx/404/403.

Endpoints (matched on the last path segment):
  GET  .../status                   -> {groqConfigured, geminiConfigured}
  POST .../transcribe-and-translate (multipart: file + options)
  POST .../translate-segments       (JSON)
  POST .../tts                      (JSON -> audio)
  POST .../batch-tts                (JSON -> base64 audio per segment)
  POST .../verify-groq-key          (JSON -> {valid})
  POST .../render-mp4               (501: no ffmpeg; client falls back to WebM)
  GET  .../video-capabilities       (JSON -> {ffmpeg, chunked, maxUploadBytes})
  POST .../video-upload             (multipart video, or JSON chunked mode)
  POST .../video-process            (JSON -> start server-side MP4 generation)
  GET  .../video-status             (JSON -> {status, progress, message})
  GET  .../video-download           (streams the generated MP4)
"""

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import wave

import requests
from flask import Flask, Response, jsonify, request, send_file

GROQ_BASE = "https://api.groq.com/openai/v1"
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
GOOGLE_TTS_URL = "https://translate.google.com/translate_tts"

_SENTENCE_SPLIT = re.compile(r"[។!?.]+")
_LEADING_NUMBER = re.compile(r"^\d+[\.\)]\s*")

app = Flask(__name__)


# ---------------------------------------------------------------- Groq keys

# In-memory rotation order for environment Groq keys. When a key is exhausted
# (rate limit / quota / server error) it is moved to the end of this list, so
# subsequent requests start with the key that still works: key1 → key2 → key3.
_ENV_KEY_ORDER = ["GROQ_API_KEY", "GROQ_API_KEY2", "GROQ_API_KEY3"]


def _rotate_key_to_back(key):
    """Move the env key that produced `key` to the back of the rotation."""
    global _ENV_KEY_ORDER
    if len(_ENV_KEY_ORDER) < 2:
        return
    for i, env_key in enumerate(_ENV_KEY_ORDER):
        if (os.environ.get(env_key) or "").strip() == key:
            _ENV_KEY_ORDER = _ENV_KEY_ORDER[:i] + _ENV_KEY_ORDER[i + 1 :] + [env_key]
            return


def get_groq_keys():
    """Client header key first, then env keys in rotation order (deduplicated)."""
    keys = []
    header_key = (request.headers.get("x-groq-api-key") or "").strip()
    if header_key:
        keys.append(header_key)
    for env_key in _ENV_KEY_ORDER:
        value = (os.environ.get(env_key) or "").strip()
        if value and value not in keys:
            keys.append(value)
    return keys


def groq_post(url, keys, *, data=None, files=None, json_body=None, timeout=120):
    """POST to Groq with key fallback. Returns requests.Response.

    Retries the next key on 429/5xx/404/403; other client errors (401, 400…)
    are returned as-is. Exhausted keys rotate to the back so the next request
    starts with the key that still works. Raises when every key fails.
    """
    last_err = None
    for key in keys:
        try:
            resp = requests.post(
                url,
                data=data,
                files=files,
                json=json_body,
                headers={"Authorization": "Bearer %s" % key},
                timeout=timeout,
            )
        except requests.RequestException as err:
            last_err = err
            _rotate_key_to_back(key)
            continue
        if resp.ok:
            return resp
        err_body = (resp.text or "")[:200]  # consume body to avoid leaks
        if resp.status_code == 429 or resp.status_code >= 500 or resp.status_code in (404, 403):
            last_err = RuntimeError("HTTP %s with key ...%s: %s" % (resp.status_code, key[-6:], err_body))
            _rotate_key_to_back(key)
            continue
        return resp
    raise last_err or RuntimeError("All API keys failed")


def translate_via_groq(keys, model, prompt):
    """Try the selected model, then built-in fallback models."""
    models_to_try = []
    for candidate in (model, "openai/gpt-oss-120b", "openai/gpt-oss-20b"):
        if candidate and candidate not in models_to_try:
            models_to_try.append(candidate)
    for candidate in models_to_try:
        try:
            resp = groq_post(
                "%s/chat/completions" % GROQ_BASE,
                keys,
                json_body={
                    "model": candidate,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.1,
                    "max_tokens": 4096,
                },
            )
        except Exception:
            continue
        if resp.ok:
            return resp.json()
    return None


# -------------------------------------------------------------- Gemini keys

# Gemini API keys (GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3) live only
# in server environment variables. Quota is per Google project, so each env key
# should belong to a different project. Rotation works the same as Groq: an
# exhausted key moves to the back of the order.
_GEMINI_KEY_ORDER = ["GEMINI_API_KEY", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3"]

_GEMINI_FALLBACK_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash"]


def _rotate_gemini_key_to_back(key):
    global _GEMINI_KEY_ORDER
    if len(_GEMINI_KEY_ORDER) < 2:
        return
    for i, env_key in enumerate(_GEMINI_KEY_ORDER):
        if (os.environ.get(env_key) or "").strip() == key:
            _GEMINI_KEY_ORDER = _GEMINI_KEY_ORDER[:i] + _GEMINI_KEY_ORDER[i + 1 :] + [env_key]
            return


def get_gemini_keys():
    keys = []
    for env_key in _GEMINI_KEY_ORDER:
        value = (os.environ.get(env_key) or "").strip()
        if value and value not in keys:
            keys.append(value)
    return keys


def gemini_generate(keys, model, prompt):
    """POST :generateContent to the Gemini API with key fallback.
    Exhausted keys (429/5xx) rotate to the back; other errors return as-is.
    """
    last_err = None
    for key in keys:
        try:
            resp = requests.post(
                "%s/models/%s:generateContent?key=%s" % (GEMINI_BASE, model, key),
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {"temperature": 0.1, "maxOutputTokens": 4096},
                },
                timeout=120,
            )
        except requests.RequestException as err:
            last_err = err
            _rotate_gemini_key_to_back(key)
            continue
        if resp.ok:
            return resp
        err_body = (resp.text or "")[:200]
        if resp.status_code in (429, 500, 502, 503, 504):
            last_err = RuntimeError(
                "Gemini HTTP %s with key ...%s: %s" % (resp.status_code, key[-6:], err_body)
            )
            _rotate_gemini_key_to_back(key)
            continue
        return resp
    raise last_err or RuntimeError("All Gemini API keys failed")


def translate_via_gemini(keys, model, prompt):
    """Try the selected Gemini model, then built-in flash fallbacks.
    Shapes the response like an OpenAI chat completion so the shared
    parse_translated_lines() helper works unchanged.
    """
    candidates = []
    for candidate in (model,) + tuple(_GEMINI_FALLBACK_MODELS):
        if candidate and candidate not in candidates:
            candidates.append(candidate)
    for candidate in candidates:
        try:
            resp = gemini_generate(keys, candidate, prompt)
        except Exception:
            continue
        if resp.ok:
            data = resp.json() or {}
            parts = (data.get("candidates") or [{}])[0].get("content", {}).get("parts") or []
            text = "".join(p.get("text", "") for p in parts).strip()
            if text:
                return {"choices": [{"message": {"content": text}}]}
    return None


def translate_via_provider(model, prompt):
    """Route a translation prompt to the right provider. Models prefixed
    `gemini/` use the Gemini API; everything else uses Groq."""
    if model.startswith("gemini/"):
        return translate_via_gemini(get_gemini_keys(), model.split("/", 1)[1], prompt)
    return translate_via_groq(get_groq_keys(), model, prompt)


def build_translation_prompt(source_language, target_language, target_language_name, segments):
    numbered = "\n".join(
        "%d. %s" % (i + 1, seg.get("originalText", "")) for i, seg in enumerate(segments)
    )
    full_text = " ".join(
        (seg.get("originalText") or "").strip() for seg in segments if (seg.get("originalText") or "").strip()
    )
    return (
        "You are a professional subtitle translator creating natural speech for dubbing. "
        "Translate each numbered segment below from %s → %s (%s). Write the way a real "
        "person would speak aloud in %s: natural word order, conversational tone, and clear, "
        "easy-to-listen sentences — never a literal word-for-word rendering. Keep each line "
        "short enough to fit subtitle timing. Every translated line MUST be written in the "
        "target language (%s) script — never repeat the source-language text. Use the full "
        "transcript below as context so short or ambiguous segments are translated naturally "
        "and consistently. Keep the numbering and return ONLY the translated text lines, one "
        "per segment, preserving blank lines between segments.\n\n"
        'Full transcript: "%s"\n\n%s'
        % (source_language, target_language, target_language_name or target_language, target_language, target_language, full_text, numbered)
    )


def parse_translated_lines(chat_data):
    try:
        content = chat_data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        content = ""
    lines = [_LEADING_NUMBER.sub("", line).strip() for line in content.split("\n")]
    return [line for line in lines if line]


DEFAULT_TRANSLATION_MODEL = "openai/gpt-oss-120b"

# Scripts that prove a line is written in the target language. Latin-script
# targets (en, vi, …) cannot be verified this way and always pass.
_TARGET_SCRIPT = {
    "km": re.compile(r"[\u1780-\u17FF]"),
    "zh": re.compile(r"[\u4E00-\u9FFF]"),
    "ja": re.compile(r"[\u3040-\u30FF\u4E00-\u9FFF]"),
    "ko": re.compile(r"[\uAC00-\uD7AF]"),
    "th": re.compile(r"[\u0E00-\u0E7F]"),
    "ru": re.compile(r"[\u0400-\u04FF]"),
    "ar": re.compile(r"[\u0600-\u06FF]"),
    "hi": re.compile(r"[\u0900-\u097F]"),
}


def line_in_target_script(line, target_language):
    regex = _TARGET_SCRIPT.get(target_language)
    if regex is None:
        return True
    return bool(regex.search(line))


def build_forced_prompt(source_language, target_language, target_language_name, segments):
    numbered = "\n".join(
        "%d. %s" % (i + 1, seg.get("originalText", "")) for i, seg in enumerate(segments)
    )
    return (
        "Translate the following subtitle segments from %s to %s (%s). Every line "
        "MUST be written in the target language's script — never repeat the "
        "original-language text. Return one translation per line, numbered to "
        "match the input, with no extra text.\n\n%s"
        % (source_language, target_language, target_language_name or target_language, numbered)
    )


def translate_segments_with_fallback(keys, model, source_language, target_language, target_language_name, segments):
    """Translate every segment, then re-translate any line that came back in the
    source language (echoed/empty) using the default model with a strict
    instruction — so the output is always written in the target language's script.
    Provider (Groq vs Gemini) is chosen from the model id prefix.
    """
    prompt = build_translation_prompt(source_language, target_language, target_language_name, segments)
    chat = translate_via_provider(model, prompt)
    lines = parse_translated_lines(chat) if chat else []
    failing = [
        i
        for i, seg in enumerate(segments)
        if i >= len(lines) or not line_in_target_script(lines[i], target_language)
    ]
    if failing:
        sub = [segments[i] for i in failing]
        sub_prompt = build_forced_prompt(source_language, target_language, target_language_name, sub)
        default_model = (
            "gemini/gemini-3.6-flash" if model.startswith("gemini/") else DEFAULT_TRANSLATION_MODEL
        )
        sub_chat = translate_via_provider(default_model, sub_prompt)
        sub_lines = parse_translated_lines(sub_chat) if sub_chat else []
        # Make room so the retried lines can be stored even if the first pass
        # returned fewer lines than there are segments (e.g. a provider hiccup).
        if len(lines) < len(segments):
            lines.extend([""] * (len(segments) - len(lines)))
        for j, idx in enumerate(failing):
            if j < len(sub_lines) and line_in_target_script(sub_lines[j], target_language):
                lines[idx] = sub_lines[j]
    return lines


# ------------------------------------------------- Edge TTS (natural neural voices)

# Best Microsoft Edge neural voice per app language. Natural, human-like speech.
# Voices that are missing/wrong simply fail and the caller falls back to Google TTS.
EDGE_TTS_VOICES = {
    "km": "km-KH-PisethNeural",  # Khmer (male)
    "en": "en-US-AndrewNeural",  # English (male)
    "zh": "zh-CN-XiaoxiaoNeural",  # Chinese (female)
    "ja": "ja-JP-NanamiNeural",  # Japanese (female)
    "ko": "ko-KR-SunHiNeural",  # Korean (female)
    "th": "th-TH-PremwadeeNeural",  # Thai (female)
    "vi": "vi-VN-HoaiMyNeural",  # Vietnamese (female)
    "fr": "fr-FR-DeniseNeural",  # French (female)
    "es": "es-ES-ElviraNeural",  # Spanish (female)
    "de": "de-DE-KatjaNeural",  # German (female)
    "id": "id-ID-GadisNeural",  # Indonesian (female)
    "ru": "ru-RU-SvetlanaNeural",  # Russian (female)
    "ar": "ar-SA-ZariyahNeural",  # Arabic (female)
    "hi": "hi-IN-SwaraNeural",  # Hindi (female)
    "it": "it-IT-ElsaNeural",  # Italian (female)
    "pt": "pt-PT-RaquelNeural",  # Portuguese (female)
}


def edge_tts_speech(text, lang):
    """Synthesize with Microsoft Edge neural voices (natural, human-like).
    Returns mp3 bytes, or None when the language is unsupported or the
    request fails (caller falls back to Google Translate TTS).
    """
    voice = EDGE_TTS_VOICES.get(lang)
    if not voice:
        return None
    try:
        import asyncio
        import edge_tts

        async def _synthesize():
            communicate = edge_tts.Communicate(text, voice)
            chunks = []
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    chunks.append(chunk["data"])
            return b"".join(chunks)

        return asyncio.run(_synthesize())
    except Exception as err:  # noqa: BLE001
        print("[EdgeTTS] failed for language %s: %s" % (lang, err))
        return None


# ------------------------------------------------- Google Translate TTS

def fetch_google_tts_chunk(text, lang):
    resp = requests.get(
        GOOGLE_TTS_URL,
        params={"ie": "UTF-8", "q": text.strip(), "tl": lang, "client": "tw-ob"},
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=15,
    )
    if resp.status_code != 200:
        raise RuntimeError("Google TTS returned %s" % resp.status_code)
    return resp.content


def split_sentences(text):
    return [s.strip() for s in _SENTENCE_SPLIT.split(text.strip()) if s.strip()]


def google_tts(text, lang):
    """One request per sentence with ~200ms of silence between (natural pacing)."""
    sentences = split_sentences(text)
    if not sentences:
        return fetch_google_tts_chunk(text, lang)
    silence = b"\x00" * 600
    parts = []
    last = len(sentences) - 1
    for idx, sentence in enumerate(sentences):
        try:
            parts.append(fetch_google_tts_chunk(sentence, lang))
            if idx != last:
                parts.append(silence)
        except Exception:
            continue
    if not parts:
        raise RuntimeError("All TTS chunks failed")
    return b"".join(parts)


def groq_tts_audio(keys, text):
    """Fallback: Groq Orpheus TTS (English only)."""
    for key in keys:
        try:
            resp = requests.post(
                "%s/audio/speech" % GROQ_BASE,
                json={
                    "model": "canopylabs/orpheus-v1-english",
                    "input": text.strip(),
                    "voice": "troy",
                    "response_format": "wav",
                },
                headers={"Authorization": "Bearer %s" % key},
                timeout=60,
            )
            if resp.ok and len(resp.content) > 0:
                return resp.content
        except Exception:
            continue
    return None


# ------------------------------------------------- Subtitle builders

def _p(n, width=2):
    return str(n).zfill(width)


def _split_time_parts(t):
    ms = int((t % 1) * 1000)
    total = int(t)
    return total // 3600, (total // 60) % 60, total % 60, ms


def format_srt_time(t):
    h, m, s, ms = _split_time_parts(t)
    return "%s:%s:%s,%s" % (_p(h), _p(m), _p(s), _p(ms, 3))


def format_vtt_time(t):
    h, m, s, ms = _split_time_parts(t)
    return "%s:%s:%s.%s" % (_p(h), _p(m), _p(s), _p(ms, 3))


def _seg_text(seg, use_translation):
    text = seg.get("translatedText") if use_translation else seg.get("originalText")
    return (text or "").strip()


def build_srt(segments, use_translation):
    blocks = []
    for i, seg in enumerate(segments):
        blocks.append(
            "%d\n%s --> %s\n%s\n"
            % (i + 1, format_srt_time(seg["start"]), format_srt_time(seg["end"]), _seg_text(seg, use_translation))
        )
    return "\n".join(blocks)


def build_vtt(segments, use_translation):
    lines = ["WEBVTT", ""]
    for i, seg in enumerate(segments):
        lines.append(str(i + 1))
        lines.append("%s --> %s" % (format_vtt_time(seg["start"]), format_vtt_time(seg["end"])))
        lines.append(_seg_text(seg, use_translation))
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------- Handlers

def handle_status():
    return jsonify(
        {
            "groqConfigured": bool(
                (os.environ.get("GROQ_API_KEY") or "").strip()
                or (os.environ.get("GROQ_API_KEY2") or "").strip()
                or (os.environ.get("GROQ_API_KEY3") or "").strip()
            ),
            "geminiConfigured": bool(
                (os.environ.get("GEMINI_API_KEY") or "").strip()
                or (os.environ.get("GEMINI_API_KEY_2") or "").strip()
                or (os.environ.get("GEMINI_API_KEY_3") or "").strip()
            ),
        }
    )


def handle_transcribe_and_translate():
    api_keys = get_groq_keys()
    if not api_keys:
        return (
            jsonify(
                {
                    "error": "Groq API key is required. Please provide one in Settings or via environment.",
                    "code": "MISSING_API_KEY",
                }
            ),
            400,
        )

    upload = request.files.get("file")
    if upload is None:
        return jsonify({"error": "No file uploaded"}), 400

    form = request.form
    whisper_model = form.get("whisperModel", "whisper-large-v3")
    translation_model = form.get("translationModel", "openai/gpt-oss-120b")
    source_language = form.get("sourceLanguage", "auto")
    target_language = form.get("targetLanguage", "km")
    target_language_name = form.get("targetLanguageName", "Khmer")

    try:
        # Step 1: Transcribe with Groq Whisper
        files = {
            "file": (
                upload.filename or "audio",
                upload.read(),
                upload.mimetype or "application/octet-stream",
            )
        }
        data = {"model": whisper_model, "response_format": "verbose_json"}
        if source_language and source_language != "auto":
            data["language"] = source_language

        whisper_resp = groq_post(
            "%s/audio/transcriptions" % GROQ_BASE, api_keys, data=data, files=files, timeout=300
        )
        if not whisper_resp.ok:
            return (
                jsonify(
                    {
                        "error": "Whisper API error (%s): %s"
                        % (whisper_resp.status_code, (whisper_resp.text or "")[:500])
                    }
                ),
                500,
            )

        whisper_data = whisper_resp.json()
        segments = [
            {
                "id": i + 1,
                "start": seg.get("start", 0),
                "end": seg.get("end", 0),
                "originalText": (seg.get("text") or "").strip(),
                "translatedText": "",
            }
            for i, seg in enumerate(whisper_data.get("segments") or [])
        ]

        detected_language = whisper_data.get("language") or source_language
        full_original_text = " ".join(seg["originalText"] for seg in segments)
        duration = whisper_data.get("duration") or 0

        # Step 2: Translate segments with a Groq chat model (with automatic
        # verification that the output is written in the target language).
        translated_lines = translate_segments_with_fallback(
            api_keys, translation_model, detected_language, target_language, target_language_name, segments
        )
        for i, seg in enumerate(segments):
            seg["translatedText"] = (
                translated_lines[i] if i < len(translated_lines) else seg["originalText"]
            )

        return jsonify(
            {
                "detectedLanguage": detected_language,
                "targetLanguage": target_language,
                "targetLanguageName": target_language_name,
                "duration": duration,
                "processingTimeMs": 0,
                "fullOriginalText": full_original_text,
                "fullTranslatedText": " ".join(seg["translatedText"] for seg in segments),
                "segments": segments,
                "srtOriginal": build_srt(segments, False),
                "srtTranslated": build_srt(segments, True),
                "vttOriginal": build_vtt(segments, False),
                "vttTranslated": build_vtt(segments, True),
            }
        )
    except Exception as err:  # noqa: BLE001
        return jsonify({"error": str(err) or "Transcription failed"}), 500


def handle_translate_segments():
    api_keys = get_groq_keys()
    if not api_keys:
        return jsonify({"error": "Groq API key is required.", "code": "MISSING_API_KEY"}), 400

    body = request.get_json(silent=True) or {}
    segments = body.get("segments")
    if not segments or not isinstance(segments, list) or len(segments) == 0:
        return jsonify({"error": "No segments provided"}), 400

    source_language = body.get("sourceLanguage", "auto")
    target_language = body.get("targetLanguage", "km")
    target_language_name = body.get("targetLanguageName", "Khmer")
    translation_model = body.get("translationModel", "openai/gpt-oss-120b")

    try:
        translated_lines = translate_segments_with_fallback(
            api_keys, translation_model, source_language, target_language, target_language_name, segments
        )
        for i, seg in enumerate(segments):
            seg["translatedText"] = (
                translated_lines[i] if i < len(translated_lines) else seg.get("originalText", "")
            )

        return jsonify(
            {
                "segments": segments,
                "fullTranslatedText": " ".join(seg["translatedText"] for seg in segments),
                "srtTranslated": build_srt(segments, True),
                "vttTranslated": build_vtt(segments, True),
                "targetLanguage": target_language,
                "targetLanguageName": target_language_name,
            }
        )
    except Exception as err:  # noqa: BLE001
        return jsonify({"error": str(err) or "Translation failed"}), 500


def handle_tts():
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    language = body.get("language") or "km"
    if not text:
        return jsonify({"error": "No text provided"}), 400

    # 1. Edge TTS — natural neural voices, human-like speech
    audio = edge_tts_speech(text, language)
    if audio and len(audio) > 100:
        return Response(audio, mimetype="audio/mpeg")

    # 2. Google Translate TTS (free, 50+ languages including Khmer)
    try:
        audio = google_tts(text, language)
        if len(audio) > 100:
            return Response(audio, mimetype="audio/mpeg")
    except Exception as err:  # noqa: BLE001
        print("[TTS] Google TTS failed for language %s: %s" % (language, err))

    # 3. Fallback: Groq Orpheus (English only)
    audio = groq_tts_audio(get_groq_keys(), text)
    if audio:
        return Response(audio, mimetype="audio/wav")

    # 4. Signal the client to use its browser TTS fallback
    return Response(status=204)


def handle_batch_tts():
    body = request.get_json(silent=True) or {}
    segments = body.get("segments")
    language = body.get("language") or "km"
    if not segments or not isinstance(segments, list) or len(segments) == 0:
        return jsonify({"error": "No segments provided"}), 400

    tts_keys = get_groq_keys()
    if not tts_keys:
        return jsonify({"audio": [], "fallback": True})

    results = []
    for seg in segments:
        if not (seg.get("translatedText") or "").strip():
            continue

        audio_base64 = ""

        # 1. Edge TTS — natural neural voice (human-like)
        audio = edge_tts_speech(seg["translatedText"].strip(), language)
        if audio and len(audio) > 100:
            audio_base64 = base64.b64encode(audio).decode("ascii")

        # 2. Google Translate TTS (free, multilingual)
        if not audio_base64:
            try:
                audio = google_tts(seg["translatedText"].strip(), language)
                if len(audio) > 100:
                    audio_base64 = base64.b64encode(audio).decode("ascii")
            except Exception as err:  # noqa: BLE001
                print("[BatchTTS] Google TTS failed for seg %s: %s" % (seg.get("id"), err))

        # 3. Fallback: Groq Orpheus (English only)
        if not audio_base64:
            audio = groq_tts_audio(tts_keys, seg["translatedText"])
            if audio and len(audio) > 100:
                audio_base64 = base64.b64encode(audio).decode("ascii")

        results.append(
            {"id": seg.get("id"), "start": seg.get("start"), "end": seg.get("end"), "audio": audio_base64}
        )

    return jsonify({"audio": results, "fallback": False})


def handle_check_groq_keys():
    """Probe each configured environment Groq key (rotation order) and report
    health. Never echoes key values — only per-key status.
    """
    results = []
    for env_key in _ENV_KEY_ORDER:
        value = (os.environ.get(env_key) or "").strip()
        if not value:
            results.append(
                {"envKey": env_key, "configured": False, "ok": False, "error": "not configured"}
            )
            continue
        try:
            resp = requests.get(
                "%s/models" % GROQ_BASE,
                headers={"Authorization": "Bearer %s" % value},
                timeout=20,
            )
        except requests.RequestException as err:
            results.append(
                {
                    "envKey": env_key,
                    "configured": True,
                    "ok": False,
                    "error": "network: %s" % type(err).__name__,
                }
            )
            continue
        results.append(
            {
                "envKey": env_key,
                "configured": True,
                "ok": resp.ok,
                "error": None if resp.ok else "HTTP %s" % resp.status_code,
            }
        )
    return jsonify({"keys": results, "allOk": all(r["ok"] for r in results)})


def handle_check_gemini_keys():
    """Probe each configured environment Gemini key (rotation order) and report
    health. Never echoes key values — only per-key status. Also returns the
    model catalog from the first working key so model ids can be verified.
    """
    results = []
    models = []
    for env_key in _GEMINI_KEY_ORDER:
        value = (os.environ.get(env_key) or "").strip()
        if not value:
            results.append(
                {"envKey": env_key, "configured": False, "ok": False, "error": "not configured"}
            )
            continue
        try:
            resp = requests.get("%s/models?key=%s" % (GEMINI_BASE, value), timeout=20)
        except requests.RequestException as err:
            results.append(
                {
                    "envKey": env_key,
                    "configured": True,
                    "ok": False,
                    "error": "network: %s" % type(err).__name__,
                }
            )
            continue
        if resp.ok and not models:
            data = resp.json() or {}
            models = sorted(
                {m.get("name", "").rsplit("/", 1)[-1] for m in data.get("models") or []}
            )
        results.append(
            {
                "envKey": env_key,
                "configured": True,
                "ok": resp.ok,
                "error": None if resp.ok else "HTTP %s" % resp.status_code,
            }
        )
    return jsonify({"keys": results, "allOk": all(r["ok"] for r in results), "models": models})


def handle_list_groq_models():
    """List model ids available on Groq (first configured key that answers).
    Never echoes key values. Used to verify model ids before exposing them.
    """
    for env_key in _ENV_KEY_ORDER:
        value = (os.environ.get(env_key) or "").strip()
        if not value:
            continue
        try:
            resp = requests.get(
                "%s/models" % GROQ_BASE,
                headers={"Authorization": "Bearer %s" % value},
                timeout=20,
            )
        except requests.RequestException:
            continue
        if resp.ok:
            data = resp.json() or {}
            return jsonify({"models": [m.get("id") for m in data.get("data") or [] if m.get("id")]})
    return jsonify({"models": []})


def handle_verify_groq_key():
    body = request.get_json(silent=True) or {}
    api_key = (body.get("apiKey") or "").strip()
    if not api_key:
        return jsonify({"valid": False, "error": "No API key provided"}), 400

    try:
        resp = requests.get(
            "%s/models" % GROQ_BASE,
            headers={"Authorization": "Bearer %s" % api_key},
            timeout=15,
        )
    except requests.RequestException as err:
        return jsonify({"valid": False, "error": str(err)}), 502

    if resp.ok:
        return jsonify({"valid": True})
    return (
        jsonify({"valid": False, "error": "Groq rejected this key (HTTP %s)" % resp.status_code}),
        401,
    )


def handle_probe_model():
    """Diagnostic: run a tiny chat completion with the requested model using
    the first configured key and report only the HTTP status / short error
    body — never the key value. Used to verify a model id actually serves
    traffic before exposing it in the UI.
    """
    model = (
        request.args.get("model")
        or (request.get_json(silent=True) or {}).get("model")
        or ""
    ).strip()
    if not model:
        return jsonify({"error": "No model provided"}), 400
    if model.startswith("gemini/"):
        gem_model = model.split("/", 1)[1]
        gem_keys = get_gemini_keys()
        if not gem_keys:
            return jsonify({"error": "No Gemini API key configured"}), 400
        try:
            resp = gemini_generate(gem_keys, gem_model, "Reply with the single word OK.")
        except Exception as err:
            return jsonify({"model": model, "ok": False, "status": 0, "error": str(err)[:200]}), 502
        error = ""
        if not resp.ok:
            try:
                error = (resp.json() or {}).get("error", {}).get("message", "")[:200]
            except Exception:
                error = resp.text[:200]
        return jsonify({"model": model, "ok": resp.ok, "status": resp.status_code, "error": error})
    api_keys = get_groq_keys()
    if not api_keys:
        return jsonify({"error": "No Groq API key configured"}), 400
    try:
        resp = requests.post(
            "%s/chat/completions" % GROQ_BASE,
            headers={
                "Authorization": "Bearer %s" % api_keys[0],
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": "Reply with the single word OK."}],
                "max_tokens": 8,
                "temperature": 0,
            },
            timeout=30,
        )
        error = ""
        if not resp.ok:
            try:
                error = (resp.json() or {}).get("error", {}).get("message", "")[:160]
            except Exception:
                error = resp.text[:160]
        return jsonify({"model": model, "ok": resp.ok, "status": resp.status_code, "error": error})
    except requests.RequestException as err:
        return jsonify({"model": model, "ok": False, "status": 0, "error": type(err).__name__}), 502


def handle_probe_tts():
    """Diagnostic: which TTS engine serves in production (edge vs google)."""
    text = request.args.get("text") or "សួស្តី សាកល្បងសំឡេង"
    lang = request.args.get("lang") or "km"
    edge = edge_tts_speech(text, lang)
    if edge and len(edge) > 100:
        return jsonify({"engine": "edge", "bytes": len(edge), "voice": EDGE_TTS_VOICES.get(lang)})
    try:
        g = google_tts(text, lang)
        if len(g) > 100:
            return jsonify({"engine": "google", "bytes": len(g)})
    except Exception:
        pass
    return jsonify({"engine": "none"}), 502


def handle_render_mp4():
    # No ffmpeg in the hosting image — the client falls back to WebM.
    return (
        jsonify(
            {
                "error": "MP4 conversion is not available on this deployment. The WebM recording will be downloaded instead."
            }
        ),
        501,
    )


# ------------------------------------------- Server-side MP4 generation
#
# Real FFmpeg pipeline (no browser recording): the original video is stored in
# /tmp, the translated AI voice clips are scheduled onto the original timeline
# and mixed with the preserved background audio, then muxed back with the
# original (or re-encoded) video stream into an H.264+AAC MP4.
#
# FFmpeg comes from the `imageio-ffmpeg` wheel (bundled static binary). If it
# is unavailable we report `ffmpeg: false` so the client shows a clear error.

_VIDEO_JOBS = {}
_VIDEO_JOBS_LOCK = threading.Lock()
_VIDEO_ROOT = os.path.join(tempfile.gettempdir(), "video-jobs")
_FFMPEG_EXE_CACHE = None

_MIME_EXT = {
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
    "audio/opus": "opus",
}


def _ffmpeg_exe():
    global _FFMPEG_EXE_CACHE
    if _FFMPEG_EXE_CACHE:
        return _FFMPEG_EXE_CACHE
    exe = None
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        exe = None
    if not exe:
        exe = shutil.which("ffmpeg")
    _FFMPEG_EXE_CACHE = exe
    return exe


def _safe_ext(mime, name):
    from_mime = _MIME_EXT.get((mime or "").lower())
    if from_mime:
        return from_mime
    m = re.search(r"\.([a-z0-9]{2,5})$", (name or "").lower())
    ext = m.group(1) if m else ""
    if ext in ("mp4", "webm", "mov", "mkv", "m4v", "mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"):
        return ext
    return "mp4"


def _is_video_mime(mime, name):
    if (mime or "").startswith("video/"):
        return True
    return bool(re.search(r"\.(mp4|webm|mov|mkv|m4v)$", (name or "").lower()))


def _sniff_audio_kind(data):
    if len(data) > 12 and data[:4] == b"RIFF":
        return "wav"
    return "mp3"


def _set_job(job_id, **kw):
    with _VIDEO_JOBS_LOCK:
        job = _VIDEO_JOBS.get(job_id)
        if job:
            job.update(kw)


def _probe_original(ffmpeg, path):
    """Parse `ffmpeg -i` stderr for duration / streams (no ffprobe on hosting)."""
    try:
        proc = subprocess.run([ffmpeg, "-i", path], capture_output=True, text=True, timeout=60)
        err = proc.stderr or ""
    except Exception:
        err = ""
    duration = 0.0
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.?\d*)", err)
    if m:
        duration = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    has_video = bool(re.search(r"Video:", err))
    has_audio = bool(re.search(r"Audio:", err))
    vcodec = ""
    vpix = ""
    vm = re.search(r"Video:\s*([a-zA-Z0-9_]+)", err)
    if vm:
        vcodec = vm.group(1)
    # "Video: h264 (High), yuv420p, 1920x1080 ..."
    vm2 = re.search(r"Video:\s*[^,]*(?:\([^)]*\))?[,\s]+([a-zA-Z0-9_]+)[,\s]", err)
    if vm2:
        vpix = vm2.group(1)
    channels = 1
    cm = re.search(r"Audio:\s*[^,]*,?[^,]*?,\s*([a-zA-Z0-9]+)\s", err)
    if cm:
        ch = cm.group(1)
        channels = 2 if ch in ("stereo", "5.1", "7.1") else 1
    return {"duration": duration, "has_video": has_video, "has_audio": has_audio, "vcodec": vcodec, "vpix": vpix, "channels": channels}


def _clip_duration(ffmpeg, path):
    """Convert a clip to WAV then read its duration from the header."""
    wav_path = path + ".wav"
    try:
        subprocess.run(
            [ffmpeg, "-y", "-i", path, "-ar", "48000", "-ac", "2", wav_path],
            capture_output=True,
            timeout=60,
        )
        with wave.open(wav_path, "rb") as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return 0.0


def _process_video_job(job_id):
    job = _VIDEO_JOBS.get(job_id)
    if not job or not job.get("inputPath"):
        return
    ffmpeg = _ffmpeg_exe()
    if not ffmpeg:
        _set_job(job_id, status="error", error="FFmpeg is not installed on the server", progress=100)
        return
    job_dir = job.get("dir")
    try:
        _set_job(job_id, status="processing", progress=12, message="Analyzing media")
        info = _probe_original(ffmpeg, job["inputPath"])
        duration = info["duration"]
        has_video = info["has_video"]
        has_audio = info["has_audio"]
        stereo = info["channels"] >= 2
        _set_job(job_id, hasVideo=has_video, progress=16, message="Extracting audio")

        segs = job.get("segments") or []
        clips = []
        with_audio = [s for s in segs if (s.get("dubbedAudioBase64") or "") and len(s["dubbedAudioBase64"]) > 100]
        for i, seg in enumerate(with_audio):
            try:
                data = base64.b64decode(seg["dubbedAudioBase64"])
                if len(data) < 100:
                    continue
                kind = _sniff_audio_kind(data)
                clip_path = os.path.join(job_dir, "clip_%04d.%s" % (len(clips), kind))
                with open(clip_path, "wb") as f:
                    f.write(data)
                dur = _clip_duration(ffmpeg, clip_path)
                start = max(0.0, float(seg.get("start") or 0))
                end = max(float(seg.get("end") or start + 0.5), start + 0.3)
                if dur > 0.05:
                    clips.append({"start": start, "end": end, "path": clip_path, "duration": dur})
            except Exception as err:
                print("[VideoJobs] clip %s failed: %s" % (i, err))
            _set_job(job_id, progress=20 + int(25 * (i + 1) / max(len(with_audio), 1)), message="Generating translated audio (%d/%d)" % (i + 1, len(with_audio)))

        _set_job(job_id, progress=50, message="Mixing audio")
        filters = []
        apply_center_cancel = bool(job.get("removeVocals")) and stereo
        if has_audio:
            if apply_center_cancel:
                filters.append("[0:a]aformat=channel_layouts=stereo,pan=stereo|c0=c0-c1|c1=c1-c0[bg0]")
            else:
                filters.append("[0:a]aformat=channel_layouts=stereo[bg0]")
            cond = "+".join("between(t,%.2f,%.2f)" % (c["start"], c["end"]) for c in clips)
            if cond:
                filters.append("[bg0]volume='if(%s>=1,0.45,1)':eval=frame[bg]" % cond)
            else:
                filters.append("[bg0]anull[bg]")

        for i, c in enumerate(clips):
            seg_dur = max(c["end"] - c["start"], 0.4)
            rate = min(max(c["duration"] / seg_dur, 0.85), 2.0)
            delay_ms = max(0, int(round(c["start"] * 1000)))
            chain = "aformat=channel_layouts=stereo"
            if abs(rate - 1) > 0.02:
                chain += ",atempo=%.3f" % rate
            chain += ",adelay=%d|%d:all=1" % (delay_ms, delay_ms)
            filters.append("[%d:a]%s[v%d]" % (i + 1, chain, i))

        aout = None
        if has_audio:
            inputs = ["[bg]"] + ["[v%d]" % i for i in range(len(clips))]
            if len(inputs) == 1:
                aout = "[bg]"
            else:
                filters.append("".join(inputs) + "amix=inputs=%d:duration=first:dropout_transition=0:normalize=0,aresample=48000[aout]" % len(inputs))
                aout = "[aout]"
        elif clips:
            inputs = ["[v%d]" % i for i in range(len(clips))]
            if len(inputs) == 1:
                aout = inputs[0]
            else:
                filters.append("".join(inputs) + "amix=inputs=%d:duration=longest:dropout_transition=0:normalize=0,aresample=48000[aout]" % len(inputs))
                aout = "[aout]"

        output_path = os.path.join(job_dir, "output.mp4")

        def build_args(copy_video):
            a = ["-y", "-i", job["inputPath"]]
            for c in clips:
                a += ["-i", c["path"]]
            if filters:
                a += ["-filter_complex", ";".join(filters)]
            if has_video:
                a += ["-map", "0:v:0"]
            if aout:
                a += ["-map", aout]
            if has_video:
                if copy_video:
                    a += ["-c:v", "copy"]
                else:
                    a += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"]
            if aout:
                a += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
            if has_video:
                a += ["-movflags", "+faststart", "-shortest"]
            a += [output_path]
            return a

        can_copy = info["vcodec"] == "h264" and info["vpix"] in ("yuv420p", "yuvj420p")
        try:
            if can_copy:
                subprocess.run(build_args(True), capture_output=True, timeout=1200)
            else:
                raise RuntimeError("re-encode required")
        except Exception:
            _set_job(job_id, progress=60, message="Rendering MP4 (re-encoding video)")
            subprocess.run(build_args(False), capture_output=True, timeout=1200)

        if not os.path.exists(output_path) or os.path.getsize(output_path) < 1000:
            raise RuntimeError("FFmpeg produced no valid output")

        now = time.strftime("%Y%m%d-%H%M")
        filename = "translated-%s-%s.mp4" % (job.get("targetLanguage") or ("video" if has_video else "audio"), now)
        _set_job(
            job_id,
            status="done",
            progress=100,
            message="Ready",
            outputPath=output_path,
            downloadFilename=filename,
            size=os.path.getsize(output_path),
        )
        print("[VideoJobs] %s done: %s" % (job_id, filename))
    except Exception as err:
        print("[VideoJobs] %s failed: %s" % (job_id, err))
        _set_job(job_id, status="error", error=str(err) or "MP4 generation failed", progress=100)


def handle_video_capabilities():
    return jsonify({"ffmpeg": bool(_ffmpeg_exe()), "chunked": True, "maxUploadBytes": 200 * 1024 * 1024})


def handle_video_upload():
    if not _ffmpeg_exe():
        return jsonify({"error": "FFmpeg is not installed on the server — MP4 generation is unavailable."}), 501

    body = request.get_json(silent=True) or {}
    mode = body.get("mode")
    if mode:
        # Chunked JSON protocol (uploads larger than the 4.5 MB request limit).
        if mode == "init":
            job_id = uuid.uuid4().hex
            job_dir = os.path.join(_VIDEO_ROOT, job_id)
            os.makedirs(job_dir, exist_ok=True)
            ext = _safe_ext(body.get("mime"), body.get("name"))
            job = {
                "id": job_id,
                "dir": job_dir,
                "inputPath": os.path.join(job_dir, "original.%s" % ext),
                "status": "uploading",
                "progress": 0,
                "message": "Uploading",
                "createdAt": time.time(),
                "hasVideo": _is_video_mime(body.get("mime"), body.get("name")),
                "targetLanguage": "km",
                "parts": [],
            }
            with _VIDEO_JOBS_LOCK:
                _VIDEO_JOBS[job_id] = job
            return jsonify({"jobId": job_id})

        job_id = body.get("jobId")
        job = _VIDEO_JOBS.get(job_id)
        if not job:
            return jsonify({"error": "Unknown jobId — start an upload first"}), 404
        if mode == "chunk":
            index = int(body.get("index") or 0)
            data = base64.b64decode(body.get("data") or "")
            part_path = os.path.join(job["dir"], "part_%06d" % index)
            with open(part_path, "wb") as f:
                f.write(data)
            job.setdefault("parts", []).append(index)
            return jsonify({"jobId": job_id, "received": index})
        if mode == "finish":
            parts = sorted(job.get("parts") or [])
            with open(job["inputPath"], "wb") as out:
                for idx in parts:
                    p = os.path.join(job["dir"], "part_%06d" % idx)
                    if os.path.exists(p):
                        with open(p, "rb") as f:
                            shutil.copyfileobj(f, out)
            _set_job(job_id, status="queued", progress=5, message="Uploaded")
            return jsonify({"jobId": job_id, "ok": True})
        return jsonify({"error": "Unknown upload mode"}), 400

    # Direct multipart upload (small files within the platform request limit).
    upload = request.files.get("video")
    if upload is None:
        return jsonify({"error": "No video file provided"}), 400
    job_id = uuid.uuid4().hex
    job_dir = os.path.join(_VIDEO_ROOT, job_id)
    os.makedirs(job_dir, exist_ok=True)
    ext = _safe_ext(upload.mimetype, upload.filename)
    input_path = os.path.join(job_dir, "original.%s" % ext)
    upload.save(input_path)
    job = {
        "id": job_id,
        "dir": job_dir,
        "inputPath": input_path,
        "status": "queued",
        "progress": 5,
        "message": "Uploaded",
        "createdAt": time.time(),
        "hasVideo": _is_video_mime(upload.mimetype, upload.filename),
        "targetLanguage": "km",
    }
    with _VIDEO_JOBS_LOCK:
        _VIDEO_JOBS[job_id] = job
    return jsonify({"jobId": job_id, "hasVideo": job["hasVideo"], "size": os.path.getsize(input_path)})


def handle_video_process():
    body = request.get_json(silent=True) or {}
    job_id = body.get("jobId")
    segments = body.get("segments")
    job = _VIDEO_JOBS.get(job_id)
    if not job:
        return jsonify({"error": "Unknown jobId — please upload the video again."}), 404
    if not isinstance(segments, list) or not segments:
        return jsonify({"error": "No subtitle segments provided"}), 400
    if job.get("status") == "processing":
        return jsonify({"jobId": job_id, "status": "processing", "progress": job.get("progress")})
    if job.get("status") == "done":
        return jsonify({"jobId": job_id, "status": "done", "progress": 100})
    job["segments"] = segments
    job["removeVocals"] = bool(body.get("removeVocals", True))
    job["targetLanguage"] = body.get("targetLanguage") or "km"
    _set_job(job_id, status="processing", progress=10, message="Preparing", error=None)
    threading.Thread(target=_process_video_job, args=(job_id,), daemon=True).start()
    return jsonify({"jobId": job_id, "status": "processing"})


def handle_video_status():
    job_id = request.args.get("jobId") or (request.get_json(silent=True) or {}).get("jobId")
    job = _VIDEO_JOBS.get(job_id)
    if not job:
        return jsonify({"error": "Unknown jobId"}), 404
    return jsonify(
        {
            "jobId": job_id,
            "status": job.get("status"),
            "progress": job.get("progress"),
            "message": job.get("message"),
            "error": job.get("error"),
            "hasVideo": job.get("hasVideo"),
            "size": job.get("size") if job.get("status") == "done" else None,
            "downloadFilename": job.get("downloadFilename") if job.get("status") == "done" else None,
        }
    )


def handle_video_download():
    job_id = request.args.get("jobId")
    job = _VIDEO_JOBS.get(job_id)
    if not job or job.get("status") != "done" or not job.get("outputPath"):
        return jsonify({"error": "Video is not ready yet"}), 404
    path = job["outputPath"]
    if not os.path.exists(path):
        return jsonify({"error": "Output file is missing"}), 404
    mimetype = "video/mp4" if job.get("hasVideo") else "audio/mp4"
    filename = job.get("downloadFilename") or "translated-video.mp4"
    return send_file(path, mimetype=mimetype, as_attachment=True, download_name=filename)


# ---------------------------------------------------------------- Routing

def _endpoint_name():
    """Best-effort resolution of the original endpoint name.

    Resolution order:
      1. ?route= / ?path= query param — used by the static deploy where the
         function is mounted at /api/index.py and the client calls
         /api/index.py?route=<endpoint>.
      2. Proxy headers (x-original-url, …) — in case the platform rewrites
         /api/<name> to the function and preserves the original URL there.
      3. The last path segment (e.g. /api/status -> status).
    """
    route = (request.args.get("route") or request.args.get("path") or "").strip().strip("/")
    if route:
        return route.lower()
    for header in ("x-original-url", "x-forwarded-uri", "x-rewritten-url", "x-original-uri"):
        value = request.headers.get(header)
        if value:
            return value.rstrip("/").rsplit("/", 1)[-1].lower()
    path = request.path or ""
    name = path.rstrip("/").rsplit("/", 1)[-1].lower() if path else ""
    return name


_HANDLERS = {
    "status": handle_status,
    "transcribe-and-translate": handle_transcribe_and_translate,
    "translate-segments": handle_translate_segments,
    "tts": handle_tts,
    "batch-tts": handle_batch_tts,
    "verify-groq-key": handle_verify_groq_key,
    "probe-model": handle_probe_model,
    "check-groq-keys": handle_check_groq_keys,
    "check-gemini-keys": handle_check_gemini_keys,
    "list-groq-models": handle_list_groq_models,
    "render-mp4": handle_render_mp4,
    "probe-tts": handle_probe_tts,
    "video-capabilities": handle_video_capabilities,
    "video-upload": handle_video_upload,
    "video-process": handle_video_process,
    "video-status": handle_video_status,
    "video-download": handle_video_download,
}


@app.route("/", defaults={"_path": ""}, methods=["GET", "POST"])
@app.route("/<path:_path>", methods=["GET", "POST"])
def dispatch(_path):
    name = _endpoint_name()
    handler = _HANDLERS.get(name)
    if handler is None:
        return (
            jsonify(
                {
                    "error": "Unknown API endpoint",
                    "path": request.path,
                    "method": request.method,
                }
            ),
            404,
        )
    if name in ("status", "check-groq-keys", "check-gemini-keys", "list-groq-models", "probe-model", "probe-tts", "video-capabilities", "video-status", "video-download"):
        if request.method != "GET":
            return jsonify({"error": "Method not allowed"}), 405
    elif request.method != "POST":
        return jsonify({"error": "Method not allowed"}), 405
    return handler()

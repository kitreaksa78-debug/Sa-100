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
"""

import base64
import os
import re

import requests
from flask import Flask, Response, jsonify, request

GROQ_BASE = "https://api.groq.com/openai/v1"
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


def build_translation_prompt(source_language, target_language, target_language_name, segments):
    numbered = "\n".join(
        "%d. %s" % (i + 1, seg.get("originalText", "")) for i, seg in enumerate(segments)
    )
    full_text = " ".join(
        (seg.get("originalText") or "").strip() for seg in segments if (seg.get("originalText") or "").strip()
    )
    return (
        "You are a professional subtitle translator. Translate each numbered segment "
        "below from %s → %s (%s). Every translated line MUST be written in the target "
        "language (%s) script — never repeat the source-language text. Use the full "
        "transcript below as context so short or ambiguous segments are translated "
        "naturally and consistently. Keep the numbering and return ONLY the translated "
        "text lines, one per segment, preserving blank lines between segments.\n\n"
        'Full transcript: "%s"\n\n%s'
        % (source_language, target_language, target_language_name or target_language, target_language, full_text, numbered)
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
    """
    prompt = build_translation_prompt(source_language, target_language, target_language_name, segments)
    chat = translate_via_groq(keys, model, prompt)
    lines = parse_translated_lines(chat) if chat else []
    failing = [
        i
        for i, seg in enumerate(segments)
        if i >= len(lines) or not line_in_target_script(lines[i], target_language)
    ]
    if failing:
        sub = [segments[i] for i in failing]
        sub_prompt = build_forced_prompt(source_language, target_language, target_language_name, sub)
        sub_chat = translate_via_groq(keys, DEFAULT_TRANSLATION_MODEL, sub_prompt)
        sub_lines = parse_translated_lines(sub_chat) if sub_chat else []
        for j, idx in enumerate(failing):
            if j < len(sub_lines) and line_in_target_script(sub_lines[j], target_language):
                lines[idx] = sub_lines[j]
    return lines


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
            "geminiConfigured": bool((os.environ.get("GEMINI_API_KEY") or "").strip()),
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

    # 1. Google Translate TTS (free, 50+ languages including Khmer)
    try:
        audio = google_tts(text, language)
        if len(audio) > 100:
            return Response(audio, mimetype="audio/mpeg")
    except Exception as err:  # noqa: BLE001
        print("[TTS] Google TTS failed for language %s: %s" % (language, err))

    # 2. Fallback: Groq Orpheus (English only)
    audio = groq_tts_audio(get_groq_keys(), text)
    if audio:
        return Response(audio, mimetype="audio/wav")

    # 3. Signal the client to use its browser TTS fallback
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

        # 1. Google Translate TTS (free, multilingual)
        try:
            audio = google_tts(seg["translatedText"].strip(), language)
            if len(audio) > 100:
                audio_base64 = base64.b64encode(audio).decode("ascii")
        except Exception as err:  # noqa: BLE001
            print("[BatchTTS] Google TTS failed for seg %s: %s" % (seg.get("id"), err))

        # 2. Fallback: Groq Orpheus (English only)
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
    "check-groq-keys": handle_check_groq_keys,
    "list-groq-models": handle_list_groq_models,
    "render-mp4": handle_render_mp4,
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
    if name in ("status", "check-groq-keys", "list-groq-models"):
        if request.method != "GET":
            return jsonify({"error": "Method not allowed"}), 405
    elif request.method != "POST":
        return jsonify({"error": "Method not allowed"}), 405
    return handler()

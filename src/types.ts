export interface SubtitleSegment {
  id: number;
  start: number;
  end: number;
  originalText: string;
  translatedText: string;
  /** Base64-encoded audio for AI dubbing (populated after batch TTS) */
  dubbedAudioBase64?: string;
}

export interface TranscriptionResult {
  detectedLanguage: string;
  targetLanguage: string;
  targetLanguageName: string;
  duration: number;
  processingTimeMs: number;
  fullOriginalText: string;
  fullTranslatedText: string;
  segments: SubtitleSegment[];
  srtOriginal: string;
  srtTranslated: string;
  vttOriginal: string;
  vttTranslated: string;
}

export interface SupportedLanguage {
  code: string;
  name: string;
  nativeName: string;
  flag: string;
}

export type ViewMode = 'split' | 'translated' | 'original';

export interface ServerStatus {
  groqConfigured: boolean;
  geminiConfigured: boolean;
}

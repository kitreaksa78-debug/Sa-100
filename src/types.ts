export type SoundType = 'dialogue' | 'music' | 'sfx' | 'ambient' | 'noise';

export interface SubtitleSegment {
  id: number;
  start: number;
  end: number;
  originalText: string;
  translatedText: string;
  /** Whether this segment is actual character speech (true) or non-speech/music/sfx (false) */
  isSpeech?: boolean;
  /** Type of sound detected: dialogue, music, sfx, ambient, noise */
  soundType?: SoundType;
  /** Speaker ID: e.g. "Speaker 1", "Speaker 2", "Speaker 3" */
  speakerId?: string;
  /** Friendly speaker name or character tag */
  speakerName?: string;
  /** Inferred speaker gender/voice profile */
  speakerGender?: 'male' | 'female';
  /** Assigned neural voice identifier */
  voiceId?: string;
  /** Base64-encoded audio for AI dubbing (populated after segment TTS) */
  dubbedAudioBase64?: string;
  /** Measured duration in seconds of generated audio */
  audioDuration?: number;
}

export type PipelineStage =
  | 'extract_audio'
  | 'detect_speakers'
  | 'detect_speech'
  | 'transcribe'
  | 'translate_khmer'
  | 'generate_voices'
  | 'sync_audio'
  | 'mix_audio'
  | 'render_mp4';

export interface PipelineStageConfig {
  id: PipelineStage;
  stepNumber: number; // 1 to 9
  nameKm: string;
  nameEn: string;
  descKm: string;
  descEn: string;
}

export interface PipelineJobStatus {
  jobId: string;
  status: 'queued' | 'processing' | 'done' | 'error';
  currentStage: PipelineStage | null;
  stepNumber: number; // 1 to 9
  progress: number; // 0 to 100
  message: string;
  error?: string;
  failedStage?: PipelineStage | null;
  hasVideo?: boolean;
  downloadFilename?: string;
  size?: number;
  segments?: SubtitleSegment[];
  detectedLanguage?: string;
  streamUrl?: string;
  downloadUrl?: string;
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


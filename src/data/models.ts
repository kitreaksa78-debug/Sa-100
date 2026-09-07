/**
 * models.ts
 *
 * AI model catalog with free daily request limits (per key, and with the 3
 * configured GROQ keys combined). Whisper models transcribe; the translation
 * models power the subtitle translation step.
 */

export interface AIModelInfo {
  id: string;
  label: string;
  /** Free requests per day per single API key. */
  rpdPerKey: number;
  /** Free requests per day when all 3 configured keys are usable. */
  rpdThreeKeys: number;
}

export const WHISPER_MODELS: AIModelInfo[] = [
  {
    id: 'whisper-large-v3',
    label: 'Whisper Large v3 (Best Quality)',
    rpdPerKey: 2000,
    rpdThreeKeys: 6000,
  },
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper Large v3 Turbo (Faster)',
    rpdPerKey: 2000,
    rpdThreeKeys: 6000,
  },
];

export const TRANSLATION_MODELS: AIModelInfo[] = [
  {
    id: 'openai/gpt-oss-20b',
    label: 'GPT-OSS 20B (Ultra Fast)',
    rpdPerKey: 1000,
    rpdThreeKeys: 3000,
  },
  {
    id: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B (High Quality)',
    rpdPerKey: 1000,
    rpdThreeKeys: 3000,
  },
  {
    id: 'qwen/qwen3.6-27b',
    label: 'Qwen 3.6 27B',
    rpdPerKey: 1000,
    rpdThreeKeys: 3000,
  },
  {
    id: 'qwen/qwen3.8-27b',
    label: 'Qwen 3.8 27B',
    rpdPerKey: 1000,
    rpdThreeKeys: 3000,
  },
  {
    id: 'groq/compound',
    label: 'Groq Compound',
    rpdPerKey: 250,
    rpdThreeKeys: 750,
  },
  {
    id: 'groq/compound-mini',
    label: 'Groq Compound Mini',
    rpdPerKey: 250,
    rpdThreeKeys: 750,
  },
];

export function findModel(models: AIModelInfo[], id: string): AIModelInfo | undefined {
  return models.find((m) => m.id === id);
}
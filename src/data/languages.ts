import { SupportedLanguage } from '../types';

export const LANGUAGES: SupportedLanguage[] = [
  { code: 'km', name: 'Khmer', nativeName: 'ភាសាខ្មែរ', flag: '🇰🇭' },
  { code: 'en', name: 'English', nativeName: 'English', flag: '🇺🇸' },
  { code: 'zh', name: 'Chinese', nativeName: '中文 (简体)', flag: '🇨🇳' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', flag: '🇯🇵' },
  { code: 'ko', name: 'Korean', nativeName: '한국어', flag: '🇰🇷' },
  { code: 'th', name: 'Thai', nativeName: 'ภาษาไทย', flag: '🇹🇭' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', flag: '🇻🇳' },
  { code: 'fr', name: 'French', nativeName: 'Français', flag: '🇫🇷' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', flag: '🇪🇸' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', flag: '🇩🇪' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', flag: '🇮🇩' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', flag: '🇷🇺' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', flag: '🇸🇦' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', flag: '🇮🇳' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', flag: '🇮🇹' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', flag: '🇵🇹' },
];

export interface SampleMedia {
  id: string;
  title: string;
  titleKh: string;
  description: string;
  descriptionKh: string;
  type: 'video' | 'audio';
  url: string;
  durationSec: number;
  initialResult: {
    detectedLanguage: string;
    targetLanguage: string;
    targetLanguageName: string;
    duration: number;
    processingTimeMs: number;
    fullOriginalText: string;
    fullTranslatedText: string;
    segments: Array<{
      id: number;
      start: number;
      end: number;
      originalText: string;
      translatedText: string;
    }>;
  };
}

export const SAMPLE_MEDIAS: SampleMedia[] = [
  {
    id: 'sample-nature-video',
    title: 'Nature & Tech Innovation Clip',
    titleKh: 'វីដេអូគំរូ៖ ធម្មជាតិ និងបច្ចេកវិទ្យា',
    description: 'High-definition short video clip about AI speech and visual discovery.',
    descriptionKh: 'វីដេអូខ្លីអំពីការរកឃើញបច្ចេកវិទ្យា AI និងការច្នៃប្រឌិត។',
    type: 'video',
    url: '/samples/sample-tech-video.mp4',
    durationSec: 6,
    initialResult: {
      detectedLanguage: 'en',
      targetLanguage: 'km',
      targetLanguageName: 'Khmer',
      duration: 6,
      processingTimeMs: 840,
      fullOriginalText:
        'Introducing the next generation of visual intelligence and speech recognition. Experience crystal-clear subtitles and real-time translation powered by Groq ultra-fast AI.',
      fullTranslatedText:
        'សូមណែនាំនូវជំនាន់បន្ទាប់នៃបច្ចេកវិទ្យាវៃឆ្លាតមើលឃើញ និងការសម្គាល់សំឡេង។ ទទួលយកបទពិសោធន៍ចំណងជើងរងច្បាស់ល្អ និងការបកប្រែពេលវេលាជាក់ស្តែង ដែលដំណើរការដោយ Groq AI ល្បឿនលឿនបំផុត។',
      segments: [
        {
          id: 1,
          start: 0.0,
          end: 2.8,
          originalText: 'Introducing the next generation of visual intelligence and speech recognition.',
          translatedText: 'សូមណែនាំនូវជំនាន់បន្ទាប់នៃបច្ចេកវិទ្យាវៃឆ្លាតមើលឃើញ និងការសម្គាល់សំឡេង។',
        },
        {
          id: 2,
          start: 2.9,
          end: 4.5,
          originalText: 'Experience crystal-clear subtitles and real-time translation.',
          translatedText: 'ទទួលយកបទពិសោធន៍ចំណងជើងរងច្បាស់ល្អ និងការបកប្រែពេលវេលាជាក់ស្តែង។',
        },
        {
          id: 3,
          start: 4.6,
          end: 5.9,
          originalText: 'Powered by Groq ultra-fast AI Whisper and Llama models.',
          translatedText: 'ដំណើរការដោយម៉ូដែល Groq AI Whisper និង Llama ដ៏លឿនបំផុត។',
        },
      ],
    },
  },
  {
    id: 'sample-ai-audio',
    title: 'Technology & AI Speech',
    titleKh: 'សំឡេងគំរូ៖ បច្ចេកវិទ្យាបញ្ញាសិប្បនិម្មិត',
    description: 'English speech explaining how Whisper neural networks decode human language.',
    descriptionKh: 'ការថ្លែងសុន្ទរកថាជាភាសាអង់គ្លេសពន្យល់ពីដំណើរការបកប្រែសំឡេងរបស់ AI។',
    type: 'audio',
    url: '/samples/sample-tech-audio.mp3',
    durationSec: 4,
    initialResult: {
      detectedLanguage: 'en',
      targetLanguage: 'km',
      targetLanguageName: 'Khmer',
      duration: 4,
      processingTimeMs: 620,
      fullOriginalText:
        'Artificial intelligence enables seamless cross-border communication and breaks down language barriers everywhere.',
      fullTranslatedText:
        'បញ្ញាសិប្បនិម្មិត (AI) ជួយសម្រួលដល់ការប្រាស្រ័យទាក់ទងឆ្លងព្រំដែនយ៉ាងរលូន និងលុបបំបាត់របាំងភាសានៅគ្រប់ទីកន្លែង។',
      segments: [
        {
          id: 1,
          start: 0.0,
          end: 2.0,
          originalText: 'Artificial intelligence enables seamless cross-border communication.',
          translatedText: 'បញ្ញាសិប្បនិម្មិត (AI) ជួយសម្រួលដល់ការប្រាស្រ័យទាក់ទងឆ្លងព្រំដែនយ៉ាងរលូន។',
        },
        {
          id: 2,
          start: 2.1,
          end: 3.9,
          originalText: 'And breaks down language barriers everywhere around the world.',
          translatedText: 'និងលុបបំបាត់រាល់របាំងភាសានៅទូទាំងពិភពលោក។',
        },
      ],
    },
  },
];

import React from 'react';
import {
  FileAudio,
  Users,
  Mic,
  FileText,
  Languages,
  Sparkles,
  SlidersHorizontal,
  Volume2,
  Film,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  RotateCcw,
  Download,
  Play,
} from 'lucide-react';
import { PipelineStage } from '../types';
import { UILang } from '../data/translations';

export interface PipelineStatusData {
  jobId: string;
  status: 'queued' | 'uploading' | 'processing' | 'done' | 'error';
  currentStage?: PipelineStage | null;
  stepNumber: number;
  progress: number;
  message: string;
  error?: string;
  failedStage?: PipelineStage | null;
  hasVideo?: boolean;
  segments?: any[];
  downloadUrl?: string;
  streamUrl?: string;
  downloadFilename?: string;
  size?: number;
  detectedLanguage?: string;
}

interface ProcessingDashboardProps {
  uiLang: UILang;
  pipelineData: PipelineStatusData | null;
  isProcessing: boolean;
  onRetryStep: (stage?: PipelineStage) => void;
  onReset: () => void;
  onOpenPlayer?: () => void;
}

const STAGES_METADATA: {
  id: PipelineStage;
  step: number;
  nameKm: string;
  nameEn: string;
  descKm: string;
  descEn: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    id: 'extract_audio',
    step: 1,
    nameKm: 'ទាញយកសំឡេងចេញពីវីដេអូ',
    nameEn: 'Extracting audio',
    descKm: 'បម្លែងសំឡេងទៅជា 16kHz Mono សម្រាប់ដំណើរការ Whisper',
    descEn: 'Extract 16kHz mono audio stream for speech analysis',
    icon: FileAudio,
  },
  {
    id: 'detect_speakers',
    step: 2,
    nameKm: 'កំណត់អត្តសញ្ញាណតួអង្គ (Diarization)',
    nameEn: 'Detecting speakers',
    descKm: 'បែងចែកតួអង្គ (Speaker 1, 2, 3...) និងភេទ ប្រុស/ស្រី',
    descEn: 'Assign consistent speaker IDs and gender',
    icon: Users,
  },
  {
    id: 'detect_speech',
    step: 3,
    nameKm: 'ច្រោះរកតែសំឡេងនិយាយពិត (VAD)',
    nameEn: 'Detecting speech (VAD)',
    descKm: 'មិន dub លើ Music, SFX, សំឡេងសើច ឬសំឡេងបរិយាកាស',
    descEn: 'Filter out music, SFX, and ambient noise from dubbing',
    icon: Mic,
  },
  {
    id: 'transcribe',
    step: 4,
    nameKm: 'បម្លែងសំឡេងនិយាយជាអត្ថបទ',
    nameEn: 'Transcribing speech',
    descKm: 'ស្ដាប់ និងស្រង់ពាក្យនិយាយជាមួយ Whisper Large-v3',
    descEn: 'High-accuracy speech-to-text with exact timestamps',
    icon: FileText,
  },
  {
    id: 'translate_khmer',
    step: 5,
    nameKm: 'បកប្រែជាភាសាខ្មែរធម្មជាតិ រលូន',
    nameEn: 'Translating to Khmer',
    descKm: 'បកប្រែតាមបែបសន្ទនាធម្មជាតិ មិនបកប្រែពាក្យមួយៗបែបម៉ាស៊ីន',
    descEn: 'Context-aware natural Khmer dialogue translation',
    icon: Languages,
  },
  {
    id: 'generate_voices',
    step: 6,
    nameKm: 'បង្កើតសំឡេងខ្មែរតាមតួអង្គ (AI Voices)',
    nameEn: 'Generating Khmer voices',
    descKm: 'សំឡេង Piseth & Sreymom Neural តាម segment នីមួយៗ',
    descEn: 'Per-segment neural voice synthesis matching speaker identities',
    icon: Sparkles,
  },
  {
    id: 'sync_audio',
    step: 7,
    nameKm: 'តម្រឹមសំឡេងខ្មែរ 100% ស៊ីគ្នានឹងវីដេអូ',
    nameEn: '100% Audio-Video Sync & Time-Stretch',
    descKm: 'កែសម្រួលល្បឿន atempo ឱ្យស៊ីគ្នានឹង Timestamp ដើម 100% គ្មានទាក់ គ្មានយឺត',
    descEn: 'Exact sample-accurate time-stretch and micro-fades into dialogue windows',
    icon: SlidersHorizontal,
  },
  {
    id: 'mix_audio',
    step: 8,
    nameKm: 'បំបាត់សំឡេងតួដើម 100% ពេលនិយាយ (Audio Ducking)',
    nameEn: 'Muting Original Voice & Preserving Background',
    descKm: 'ពេលសំឡេងខ្មែរនិយាយ សំឡេងតួដើមស្ងាត់ 100% និងរក្សាភ្លេង Background & SFX ពេញលេញ',
    descEn: 'Original character voice 100% silenced during speech, preserving full background audio & SFX',
    icon: Volume2,
  },
  {
    id: 'render_mp4',
    step: 9,
    nameKm: 'បង្កើតវីដេអូ MP4 គុណភាពដើមសម្រេច',
    nameEn: 'Rendering final MP4',
    descKm: 'Render H.264 + AAC ជាមួយ faststart សម្រាប់ទស្សនា និងទាញយក',
    descEn: 'Mux synchronized audio with original video into MP4',
    icon: Film,
  },
];

export const ProcessingDashboard: React.FC<ProcessingDashboardProps> = ({
  uiLang,
  pipelineData,
  isProcessing,
  onRetryStep,
  onReset,
  onOpenPlayer,
}) => {
  if (!pipelineData && !isProcessing) return null;

  const currentStepNum = pipelineData?.stepNumber || 1;
  const progressPercent = pipelineData?.progress || 5;
  const isDone = pipelineData?.status === 'done';
  const isError = pipelineData?.status === 'error';
  const failedStage = pipelineData?.failedStage;

  return (
    <div
      id="processing-dashboard"
      className="bg-white rounded-2xl border border-stone-200/90 shadow-sm shadow-stone-200/50 overflow-hidden mb-8 animate-in fade-in duration-300"
    >
      {/* Top Banner Header */}
      <div className="bg-gradient-to-r from-stone-900 via-stone-800 to-stone-900 text-white p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-orange-500/20 border border-orange-400/30 text-orange-300 text-xs font-semibold mb-2">
              <Sparkles className="w-3.5 h-3.5" />
              <span>9-Stage AI Dubbing Pipeline</span>
            </div>
            <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight">
              {uiLang === 'km'
                ? 'ដំណាក់កាលបកប្រែ និងបញ្ចូលសំឡេងខ្មែរក្នុងវីដេអូ'
                : 'AI Video Dubbing & Translation Pipeline'}
            </h2>
            <p className="text-xs sm:text-sm text-stone-300 mt-1 max-w-xl">
              {pipelineData?.message ||
                (uiLang === 'km'
                  ? 'កំពុងដំណើរការបកប្រែ...'
                  : 'Processing video dubbing pipeline...')}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-right">
              <span className="text-2xl sm:text-3xl font-black font-mono text-orange-400">
                {progressPercent}%
              </span>
              <p className="text-[11px] text-stone-400 font-medium">
                {uiLang === 'km' ? `ដំណាក់កាល ${currentStepNum} នៃ 9` : `Stage ${currentStepNum} of 9`}
              </p>
            </div>
          </div>
        </div>

        {/* Real Progress Bar */}
        <div className="mt-5 w-full bg-stone-700/60 rounded-full h-2.5 overflow-hidden p-0.5">
          <div
            id="pipeline-progress-bar"
            className="h-full bg-gradient-to-r from-orange-500 via-amber-400 to-orange-500 rounded-full transition-all duration-500 shadow-sm"
            style={{ width: `${Math.max(4, Math.min(100, progressPercent))}%` }}
          />
        </div>

        {/* Quality Badges */}
        <div className="mt-3.5 flex flex-wrap items-center gap-2 pt-1 border-t border-stone-800/80 text-[11px] text-stone-300">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-500/30 text-emerald-300 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            {uiLang === 'km' ? 'សំឡេងដើមស្ងាត់ 100% ពេលនិយាយ' : '100% Original Muted on Speech'}
          </span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-950/60 border border-amber-500/30 text-amber-300 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            {uiLang === 'km' ? 'តម្រឹមស៊ីគ្នានឹងវីដេអូ 100%' : '100% Video-Speech Sync'}
          </span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-sky-950/60 border border-sky-500/30 text-sky-300 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
            {uiLang === 'km' ? 'និយាយខ្មែរតាំងពីដើមវីដេអូ' : 'Full Dubbing from 0:00s'}
          </span>
        </div>
      </div>

      {/* Error Alert with Retry button */}
      {isError && (
        <div
          id="pipeline-error-banner"
          className="m-5 p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-in shake duration-300"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
            <div>
              <h4 className="text-xs sm:text-sm font-bold text-rose-800">
                {uiLang === 'km'
                  ? `បញ្ហាបានកើតឡើងនៅដំណាក់កាលទី ${currentStepNum}`
                  : `Error at Stage ${currentStepNum}`}
              </h4>
              <p className="text-xs text-rose-700 mt-0.5 leading-relaxed">
                {pipelineData?.error || 'Processing encountered an unexpected error.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              id="retry-step-btn"
              type="button"
              onClick={() => onRetryStep(failedStage || undefined)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-rose-600 text-white hover:bg-rose-700 transition-colors shadow-sm"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{uiLang === 'km' ? 'សាកល្បងជំហាននេះឡើងវិញ' : 'Retry This Step'}</span>
            </button>
            <button
              id="reset-pipeline-btn"
              type="button"
              onClick={onReset}
              className="px-3 py-2 rounded-xl text-xs font-medium text-stone-600 hover:text-stone-900 hover:bg-rose-100/60 transition-colors"
            >
              {uiLang === 'km' ? 'ប្តូរវីដេអូ' : 'Change Video'}
            </button>
          </div>
        </div>
      )}

      {/* Done Banner */}
      {isDone && (
        <div
          id="pipeline-done-banner"
          className="m-5 p-5 rounded-2xl bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 text-emerald-900 flex flex-col sm:flex-row sm:items-center justify-between gap-4 animate-in fade-in duration-300 shadow-xs"
        >
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-emerald-600 text-white flex items-center justify-center shrink-0 shadow-sm shadow-emerald-600/30">
              <CheckCircle2 className="w-7 h-7" />
            </div>
            <div>
              <h3 className="text-sm sm:text-base font-bold text-emerald-950">
                {uiLang === 'km'
                  ? 'ការបកប្រែ និងបញ្ចូលសំឡេងខ្មែរសម្រេចជាស្ថាពរ!'
                  : 'AI Video Dubbing Complete!'}
              </h3>
              <p className="text-xs text-emerald-700 mt-0.5">
                {uiLang === 'km'
                  ? `វីដេអូ MP4 H.264 រួចរាល់សម្រាប់ទស្សនា និងទាញយក (${pipelineData?.downloadFilename || 'translated-khmer.mp4'})`
                  : `Your translated MP4 video is ready with original background music preserved.`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            {pipelineData?.downloadUrl && (
              <a
                id="download-final-mp4-btn"
                href={pipelineData.downloadUrl}
                download={pipelineData.downloadFilename || 'translated-video.mp4'}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 transition-all shadow-sm shadow-emerald-600/20 active:scale-95"
              >
                <Download className="w-4 h-4" />
                <span>{uiLang === 'km' ? 'ទាញយកវីដេអូ MP4' : 'Download MP4'}</span>
              </a>
            )}

            {onOpenPlayer && (
              <button
                id="open-player-preview-btn"
                type="button"
                onClick={onOpenPlayer}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold bg-stone-900 text-white hover:bg-stone-800 transition-all shadow-sm active:scale-95"
              >
                <Play className="w-4 h-4" />
                <span>{uiLang === 'km' ? 'មើលវីដេអូ' : 'Preview Video'}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 9 Stages Grid */}
      <div className="p-5 sm:p-6 grid grid-cols-1 md:grid-cols-3 gap-3.5">
        {STAGES_METADATA.map((stage) => {
          const Icon = stage.icon;
          const isCurrent = !isDone && !isError && currentStepNum === stage.step;
          const isPassed = isDone || currentStepNum > stage.step;
          const isStageFailed = isError && (failedStage === stage.id || currentStepNum === stage.step);

          return (
            <div
              key={stage.id}
              id={`stage-card-${stage.id}`}
              className={`relative p-4 rounded-xl border transition-all ${
                isCurrent
                  ? 'border-orange-400 bg-orange-50/50 ring-2 ring-orange-200/70 shadow-xs'
                  : isPassed
                  ? 'border-emerald-200/80 bg-emerald-50/20'
                  : isStageFailed
                  ? 'border-rose-300 bg-rose-50/40'
                  : 'border-stone-200/80 bg-stone-50/30 opacity-75'
              }`}
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                    isCurrent
                      ? 'bg-orange-600 text-white'
                      : isPassed
                      ? 'bg-emerald-600 text-white'
                      : isStageFailed
                      ? 'bg-rose-600 text-white'
                      : 'bg-stone-200 text-stone-600'
                  }`}
                >
                  {isCurrent ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : isPassed ? (
                    <CheckCircle2 className="w-4 h-4" />
                  ) : isStageFailed ? (
                    <AlertTriangle className="w-4 h-4" />
                  ) : (
                    <Icon className="w-4 h-4" />
                  )}
                </div>

                <span
                  className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full ${
                    isCurrent
                      ? 'bg-orange-200/80 text-orange-900'
                      : isPassed
                      ? 'bg-emerald-100 text-emerald-800'
                      : isStageFailed
                      ? 'bg-rose-200 text-rose-900'
                      : 'bg-stone-200/70 text-stone-600'
                  }`}
                >
                  Step {stage.step}
                </span>
              </div>

              <h4 className="text-xs sm:text-sm font-bold text-stone-900 leading-snug">
                {uiLang === 'km' ? stage.nameKm : stage.nameEn}
              </h4>
              <p className="text-[11px] text-stone-500 mt-1 leading-relaxed">
                {uiLang === 'km' ? stage.descKm : stage.descEn}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
};

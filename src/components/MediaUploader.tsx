import React, { useState, useRef, useEffect } from 'react';
import {
  Upload,
  Mic,
  Video,
  Music,
  Play,
  Square,
  Sparkles,
  FileCheck,
  Trash2,
  Volume2,
} from 'lucide-react';
import { UILang, UI_TEXT } from '../data/translations';
import { SAMPLE_MEDIAS, SampleMedia } from '../data/languages';
import { formatClockTime } from '../utils/subtitleUtils';

interface MediaUploaderProps {
  uiLang: UILang;
  selectedFile: File | null;
  onSelectFile: (file: File | null) => void;
  mediaPreviewUrl: string | null;
  setMediaPreviewUrl: (url: string | null) => void;
  mediaType: 'video' | 'audio' | null;
  setMediaType: (type: 'video' | 'audio' | null) => void;
  onSelectSample: (sample: SampleMedia) => void;
  disabled: boolean;
}

export const MediaUploader: React.FC<MediaUploaderProps> = ({
  uiLang,
  selectedFile,
  onSelectFile,
  mediaPreviewUrl,
  setMediaPreviewUrl,
  mediaType,
  setMediaType,
  onSelectSample,
  disabled,
}) => {
  const t = UI_TEXT[uiLang];
  const [activeTab, setActiveTab] = useState<'upload' | 'record' | 'sample'>('upload');
  const [isDragging, setIsDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // Only MP4 (video) and MP3 (audio) files are supported.
  const isSupportedFile = (file: File): boolean => {
    const name = (file.name || '').toLowerCase();
    const mime = (file.type || '').toLowerCase();
    return (
      name.endsWith('.mp4') ||
      name.endsWith('.mp3') ||
      mime === 'video/mp4' ||
      mime === 'audio/mpeg' ||
      mime === 'audio/mp3'
    );
  };

  // Audio Recording States
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, []);

  const handleFileChange = (file: File | null) => {
    if (!file) return;
    if (!isSupportedFile(file)) {
      setFileError(t.unsupportedFileType);
      return;
    }
    setFileError(null);
    onSelectFile(file);
    const isVideo = file.type === 'video/mp4' || file.name.toLowerCase().endsWith('.mp4');
    setMediaType(isVideo ? 'video' : 'audio');
    const objectUrl = URL.createObjectURL(file);
    setMediaPreviewUrl(objectUrl);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileChange(e.dataTransfer.files[0]);
    }
  };

  // Start voice recording
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const recordedFile = new File([audioBlob], `voice-recording-${Date.now()}.webm`, {
          type: 'audio/webm',
        });
        onSelectFile(recordedFile);
        setMediaType('audio');
        const audioUrl = URL.createObjectURL(audioBlob);
        setMediaPreviewUrl(audioUrl);
        // Stop all tracks
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start(250);
      setIsRecording(true);
      setRecordingSeconds(0);
      timerIntervalRef.current = window.setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      console.error('Error accessing microphone:', err);
      alert('Microphone access was denied or not available in this browser.');
    }
  };

  // Stop voice recording
  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    }
  };

  const handleClearMedia = () => {
    onSelectFile(null);
    setMediaPreviewUrl(null);
    setMediaType(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="bg-white rounded-2xl border border-stone-200/80 shadow-sm shadow-stone-200/50 overflow-hidden">
      {/* Navigation Tabs */}
      <div className="flex border-b border-stone-100 bg-stone-50/50 p-1.5 gap-1">
        <button
          id="tab-upload-media"
          type="button"
          disabled={disabled}
          onClick={() => setActiveTab('upload')}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
            activeTab === 'upload'
              ? 'bg-white text-stone-900 shadow-xs'
              : 'text-stone-500 hover:text-stone-800'
          }`}
        >
          <Upload className="w-4 h-4 text-orange-600" />
          {t.uploadTab}
        </button>

        <button
          id="tab-record-voice"
          type="button"
          disabled={disabled}
          onClick={() => setActiveTab('record')}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
            activeTab === 'record'
              ? 'bg-white text-stone-900 shadow-xs'
              : 'text-stone-500 hover:text-stone-800'
          }`}
        >
          <Mic className="w-4 h-4 text-rose-600" />
          {t.recordTab}
        </button>

        <button
          id="tab-sample-clips"
          type="button"
          disabled={disabled}
          onClick={() => setActiveTab('sample')}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
            activeTab === 'sample'
              ? 'bg-white text-stone-900 shadow-xs'
              : 'text-stone-500 hover:text-stone-800'
          }`}
        >
          <Sparkles className="w-4 h-4 text-amber-500" />
          {t.sampleTab}
        </button>
      </div>

      <div className="p-4 sm:p-6">
        {/* Upload File Tab */}
        {activeTab === 'upload' && (
        <div
          id="dropzone-area"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-2xl p-8 sm:p-10 text-center transition-all cursor-pointer ${
            isDragging
              ? 'border-orange-400 bg-gradient-to-br from-orange-50 to-amber-50/50 scale-[0.99] shadow-inner shadow-orange-100'
              : 'border-stone-200 hover:border-orange-300 hover:bg-gradient-to-br hover:from-stone-50 hover:to-orange-50/30 hover:shadow-inner hover:shadow-stone-100'
          }`}
          onClick={() => fileInputRef.current?.click()}
        >
            <input
              ref={fileInputRef}
              type="file"
              id="file-upload-input"
              className="hidden"
              accept=".mp4,.mp3,video/mp4,audio/mpeg,audio/mp3"
              onChange={(e) => {
                if (e.target.files && e.target.files[0]) {
                  handleFileChange(e.target.files[0]);
                }
              }}
            />

            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-orange-100 to-amber-50 text-orange-600 flex items-center justify-center shadow-sm shadow-orange-200/50 ring-1 ring-orange-200/50">
              <Upload className="w-7 h-7" />
            </div>

            <h3 className="text-base font-bold text-stone-800 mb-1">{t.dropTitle}</h3>
            <p className="text-xs text-stone-500 mb-4 max-w-md mx-auto">{t.dropSub}</p>
            {fileError && (
              <p
                id="unsupported-file-error"
                className="mb-4 text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 max-w-md mx-auto"
              >
                {fileError}
              </p>
            )}

            <button
              type="button"
              id="browse-files-btn"
              disabled={disabled}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs sm:text-sm font-semibold bg-gradient-to-r from-stone-900 to-stone-800 text-white hover:from-stone-800 hover:to-stone-700 transition-all shadow-sm hover:shadow-md shadow-stone-900/20 active:scale-[0.98]"
            >
              <FileCheck className="w-4 h-4" />
              {t.browseFiles}
            </button>
          </div>
        )}

        {/* Live Voice Recording Tab */}
        {activeTab === 'record' && (
          <div className="py-6 px-4 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center">
              <Mic className={`w-8 h-8 ${isRecording ? 'animate-pulse text-rose-600' : ''}`} />
            </div>

            <h3 className="text-base font-bold text-stone-800 mb-1">{t.recordingTitle}</h3>
            <p className="text-xs text-stone-500 mb-6 max-w-sm mx-auto">{t.recordingDesc}</p>

            {isRecording ? (
              <div className="space-y-4">
                <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-rose-50 border border-rose-200 text-rose-700 font-mono text-sm font-semibold">
                  <span className="w-2.5 h-2.5 rounded-full bg-rose-600 animate-ping" />
                  {formatClockTime(recordingSeconds)}
                </div>

                <div>
                  <button
                    id="stop-recording-btn"
                    type="button"
                    onClick={stopRecording}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-rose-600 text-white hover:bg-rose-700 shadow-sm"
                  >
                    <Square className="w-4 h-4 fill-white" />
                    {t.stopRecording}
                  </button>
                </div>
              </div>
            ) : (
              <button
                id="start-recording-btn"
                type="button"
                onClick={startRecording}
                disabled={disabled}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-rose-600 text-white hover:bg-rose-700 shadow-sm transition-transform active:scale-95"
              >
                <Mic className="w-4 h-4" />
                {t.startRecording}
              </button>
            )}
          </div>
        )}

        {/* Sample Clips Tab */}
        {activeTab === 'sample' && (
          <div className="space-y-3">
            <p className="text-xs text-stone-500 mb-2 font-medium">
              {uiLang === 'km'
                ? 'ជ្រើសរើសវីដេអូ ឬសំឡេងគំរូខាងក្រោម ដើម្បីសាកល្បងមុខងារបកប្រែភ្លាមៗ៖'
                : 'Select a sample video or audio clip below to test transcription and translation:'}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {SAMPLE_MEDIAS.map((sample) => (
                <div
                  key={sample.id}
                  id={`sample-item-${sample.id}`}
                  onClick={() => onSelectSample(sample)}
                  className="p-3.5 rounded-xl border border-stone-200 hover:border-orange-400 hover:bg-orange-50/30 transition-all cursor-pointer text-left flex items-start gap-3 group"
                >
                  <div className="p-2.5 rounded-lg bg-orange-100 text-orange-700 group-hover:scale-105 transition-transform shrink-0">
                    {sample.type === 'video' ? (
                      <Video className="w-5 h-5" />
                    ) : (
                      <Music className="w-5 h-5" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1 mb-0.5">
                      <h4 className="text-xs font-bold text-stone-900 truncate">
                        {uiLang === 'km' ? sample.titleKh : sample.title}
                      </h4>
                      <span className="text-[10px] font-mono text-stone-500 bg-stone-100 px-1.5 py-0.5 rounded">
                        {sample.durationSec}s
                      </span>
                    </div>
                    <p className="text-[11px] text-stone-500 line-clamp-2 leading-relaxed">
                      {uiLang === 'km' ? sample.descriptionKh : sample.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Selected File Banner */}
        {mediaPreviewUrl && (
          <div className="mt-4 p-3 rounded-xl bg-stone-50 border border-stone-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="p-2 rounded-lg bg-stone-200 text-stone-700 shrink-0">
                {mediaType === 'video' ? (
                  <Video className="w-4 h-4 text-blue-600" />
                ) : (
                  <Volume2 className="w-4 h-4 text-purple-600" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-stone-900 truncate">
                  {selectedFile ? selectedFile.name : 'Sample Media Loaded'}
                </p>
                <p className="text-[11px] text-stone-500">
                  {selectedFile
                    ? `${(selectedFile.size / (1024 * 1024)).toFixed(2)} MB • ${mediaType?.toUpperCase()}`
                    : `${mediaType?.toUpperCase()} Clip Ready`}
                </p>
              </div>
            </div>

            <button
              id="clear-media-btn"
              type="button"
              disabled={disabled}
              onClick={handleClearMedia}
              className="p-1.5 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-stone-100 transition-colors"
              title={t.clearAll}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

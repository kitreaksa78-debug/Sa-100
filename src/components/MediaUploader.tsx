import React, { useState, useRef } from 'react';
import {
  Upload,
  Video,
  FileCheck,
  Trash2,
  Film,
  AlertCircle,
} from 'lucide-react';
import { UILang, UI_TEXT } from '../data/translations';

interface MediaUploaderProps {
  uiLang: UILang;
  selectedFile: File | null;
  onSelectFile: (file: File | null) => void;
  mediaPreviewUrl: string | null;
  setMediaPreviewUrl: (url: string | null) => void;
  mediaType: 'video' | 'audio' | null;
  setMediaType: (type: 'video' | 'audio' | null) => void;
  onSelectSample?: (sample: any) => void;
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
  disabled,
}) => {
  const t = UI_TEXT[uiLang];
  const [isDragging, setIsDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Strictly enforce MP4 support as requested
  const isSupportedFile = (file: File): boolean => {
    const name = (file.name || '').toLowerCase();
    const mime = (file.type || '').toLowerCase();
    return name.endsWith('.mp4') || mime === 'video/mp4';
  };

  const handleFileChange = (file: File | null) => {
    if (!file) return;
    if (!isSupportedFile(file)) {
      setFileError(
        uiLang === 'km'
          ? 'សូម Upload តែឯកសារវីដេអូប្រភេទ MP4 ប៉ុណ្ណោះ (*.mp4)'
          : 'Please upload MP4 video files only (*.mp4)'
      );
      return;
    }
    setFileError(null);
    onSelectFile(file);
    setMediaType('video');
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

  const handleClearMedia = () => {
    onSelectFile(null);
    setMediaPreviewUrl(null);
    setMediaType(null);
    setFileError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="bg-white rounded-2xl border border-stone-200/90 shadow-sm shadow-stone-200/50 overflow-hidden">
      {/* Header Bar */}
      <div className="flex items-center justify-between border-b border-stone-100 bg-stone-50/60 px-5 py-3">
        <div className="flex items-center gap-2">
          <Film className="w-4 h-4 text-orange-600" />
          <span className="text-xs sm:text-sm font-bold text-stone-800">
            {uiLang === 'km' ? 'បញ្ចូលវីដេអូ MP4' : 'Upload MP4 Video'}
          </span>
        </div>
        <span className="text-[11px] font-semibold text-orange-700 bg-orange-100/70 border border-orange-200/60 px-2.5 py-0.5 rounded-full">
          MP4 Only
        </span>
      </div>

      <div className="p-5 sm:p-6">
        {/* Upload Dropzone */}
        <div
          id="dropzone-area"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => {
            if (!disabled) fileInputRef.current?.click();
          }}
          className={`border-2 border-dashed rounded-2xl p-8 sm:p-10 text-center transition-all cursor-pointer ${
            isDragging
              ? 'border-orange-500 bg-orange-50/70 scale-[0.99] shadow-inner shadow-orange-100'
              : 'border-stone-200 hover:border-orange-400 hover:bg-stone-50/60 hover:shadow-inner hover:shadow-stone-100'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            id="file-upload-input"
            className="hidden"
            accept=".mp4,video/mp4"
            onChange={(e) => {
              if (e.target.files && e.target.files[0]) {
                handleFileChange(e.target.files[0]);
              }
            }}
          />

          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-orange-100 to-amber-50 text-orange-600 flex items-center justify-center shadow-sm shadow-orange-200/50 ring-1 ring-orange-200/60">
            <Upload className="w-7 h-7" />
          </div>

          <h3 className="text-base font-bold text-stone-800 mb-1">
            {uiLang === 'km' ? 'ទម្លាក់វីដេអូ MP4 នៅទីនេះ' : 'Drop your MP4 video here'}
          </h3>
          <p className="text-xs text-stone-500 mb-4 max-w-md mx-auto">
            {uiLang === 'km'
              ? 'គាំទ្រតែឯកសារវីដេអូ MP4 (H.264 / AAC) ទំហំរហូតដល់ 200MB'
              : 'Supports MP4 video files only (up to 200MB)'}
          </p>

          {fileError && (
            <div
              id="unsupported-file-error"
              className="mb-4 flex items-center justify-center gap-2 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 max-w-md mx-auto"
            >
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{fileError}</span>
            </div>
          )}

          <button
            type="button"
            id="browse-files-btn"
            disabled={disabled}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs sm:text-sm font-semibold bg-gradient-to-r from-stone-900 to-stone-800 text-white hover:from-stone-800 hover:to-stone-700 transition-all shadow-sm hover:shadow-md shadow-stone-900/20 active:scale-[0.98]"
          >
            <FileCheck className="w-4 h-4" />
            {uiLang === 'km' ? 'ជ្រើសរើសវីដេអូពីកុំព្យូទ័រ' : 'Browse MP4 Video'}
          </button>
        </div>

        {/* Selected File Banner */}
        {selectedFile && (
          <div className="mt-4 p-3.5 rounded-xl bg-stone-50 border border-stone-200 flex items-center justify-between gap-3 animate-in fade-in duration-200">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-2.5 rounded-lg bg-orange-100 text-orange-700 shrink-0">
                <Video className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <p className="text-xs sm:text-sm font-bold text-stone-900 truncate">
                  {selectedFile.name}
                </p>
                <p className="text-[11px] text-stone-500 font-mono">
                  {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB • MP4 VIDEO
                </p>
              </div>
            </div>

            <button
              id="clear-media-btn"
              type="button"
              disabled={disabled}
              onClick={handleClearMedia}
              className="p-2 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
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

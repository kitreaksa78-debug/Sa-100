import React, { useState } from 'react';
import {
  Play,
  Volume2,
  VolumeX,
  Edit2,
  Check,
  X,
  Search,
  Languages,
  Sparkles,
  Layers,
} from 'lucide-react';
import { SubtitleSegment, ViewMode } from '../types';
import { UILang, UI_TEXT } from '../data/translations';
import { formatTimeCode, speakText, stopSpeaking } from '../utils/subtitleUtils';

interface TranscriptViewProps {
  segments: SubtitleSegment[];
  onUpdateSegments: (segments: SubtitleSegment[]) => void;
  currentTime: number;
  onSeek: (time: number) => void;
  uiLang: UILang;
  targetLangCode: string;
}

export const TranscriptView: React.FC<TranscriptViewProps> = ({
  segments,
  onUpdateSegments,
  currentTime,
  onSeek,
  uiLang,
  targetLangCode,
}) => {
  const t = UI_TEXT[uiLang];
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTranslated, setEditTranslated] = useState('');
  const [editOriginal, setEditOriginal] = useState('');
  const [speakingSegmentId, setSpeakingSegmentId] = useState<number | null>(null);

  const handleSpeakSegment = (segId: number, text: string) => {
    if (speakingSegmentId === segId) {
      stopSpeaking();
      setSpeakingSegmentId(null);
    } else {
      setSpeakingSegmentId(segId);
      speakText(
        text,
        targetLangCode,
        () => setSpeakingSegmentId(null),
        () => setSpeakingSegmentId(null)
      );
    }
  };

  const startEditing = (seg: SubtitleSegment) => {
    setEditingId(seg.id);
    setEditTranslated(seg.translatedText);
    setEditOriginal(seg.originalText);
  };

  const cancelEditing = () => {
    setEditingId(null);
  };

  const saveEditing = (segId: number) => {
    const updated = segments.map((s) =>
      s.id === segId
        ? { ...s, translatedText: editTranslated.trim(), originalText: editOriginal.trim() }
        : s
    );
    onUpdateSegments(updated);
    setEditingId(null);
  };

  // Filtered segments based on search
  const filteredSegments = segments.filter((seg) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      seg.originalText.toLowerCase().includes(q) || seg.translatedText.toLowerCase().includes(q)
    );
  });

  return (
    <div className="bg-white rounded-2xl border border-stone-200 shadow-xs flex flex-col h-[360px] sm:h-[480px] lg:h-[520px] overflow-hidden">
      {/* Top Header with view toggles & search */}
      <div className="p-3.5 border-b border-stone-100 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-stone-50/50">
        {/* View Mode Switcher */}
        <div className="flex items-center gap-1 bg-stone-200/70 p-1 rounded-xl">
          <button
            id="view-mode-split"
            type="button"
            onClick={() => setViewMode('split')}
            className={`px-3 py-1 text-xs font-semibold rounded-lg transition-all ${
              viewMode === 'split'
                ? 'bg-white text-stone-900 shadow-xs'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            {t.bilingualView}
          </button>
          <button
            id="view-mode-translated"
            type="button"
            onClick={() => setViewMode('translated')}
            className={`px-3 py-1 text-xs font-semibold rounded-lg transition-all ${
              viewMode === 'translated'
                ? 'bg-white text-stone-900 shadow-xs'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            {t.translatedOnly}
          </button>
          <button
            id="view-mode-original"
            type="button"
            onClick={() => setViewMode('original')}
            className={`px-3 py-1 text-xs font-semibold rounded-lg transition-all ${
              viewMode === 'original'
                ? 'bg-white text-stone-900 shadow-xs'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            {t.originalOnly}
          </button>
        </div>

        {/* Search Field */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
          <input
            id="transcript-search-input"
            type="text"
            placeholder={uiLang === 'km' ? 'ស្វែងរកអត្ថបទ...' : 'Search transcript...'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full sm:w-48 pl-8 pr-3 py-1.5 text-xs rounded-xl border border-stone-300 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>
      </div>

      {/* Segments List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5 divide-y divide-stone-100">
        {filteredSegments.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-stone-400">
            <Languages className="w-8 h-8 mb-2 opacity-50" />
            <p className="text-xs">
              {searchQuery
                ? 'No matching subtitle lines found'
                : 'No subtitle lines generated yet'}
            </p>
          </div>
        ) : (
          filteredSegments.map((seg) => {
            const isActive = currentTime >= seg.start && currentTime <= seg.end;
            const isEditing = editingId === seg.id;

            return (
              <div
                key={seg.id}
                id={`subtitle-segment-${seg.id}`}
                className={`pt-2.5 first:pt-0 group rounded-xl p-2.5 transition-all ${
                  isActive
                    ? 'bg-orange-50/80 border border-orange-200 shadow-xs ring-1 ring-orange-200'
                    : 'hover:bg-stone-50 border border-transparent'
                }`}
              >
                {/* Header row: timecode & quick buttons */}
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-2">
                    <button
                      id={`seek-to-seg-${seg.id}`}
                      type="button"
                      onClick={() => onSeek(seg.start)}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono font-semibold transition-colors ${
                        isActive
                          ? 'bg-orange-600 text-white'
                          : 'bg-stone-100 text-stone-600 hover:bg-orange-100 hover:text-orange-700'
                      }`}
                      title={t.clickToSeek}
                    >
                      <Play className="w-2.5 h-2.5 fill-current" />
                      <span>{formatTimeCode(seg.start)}</span>
                      <span className="text-stone-400">→</span>
                      <span>{formatTimeCode(seg.end)}</span>
                    </button>

                    <span className="text-[10px] text-stone-400 font-mono">#{seg.id}</span>
                  </div>

                  {/* Actions for this segment */}
                  <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100">
                    <button
                      id={`tts-listen-seg-${seg.id}`}
                      type="button"
                      onClick={() => speakText(seg.translatedText, targetLangCode)}
                      className="p-1 rounded text-stone-400 hover:text-orange-600 hover:bg-stone-100"
                      title={t.listenAudio}
                    >
                      <Volume2 className="w-3.5 h-3.5" />
                    </button>

                    {!isEditing && (
                      <button
                        id={`edit-seg-${seg.id}`}
                        type="button"
                        onClick={() => startEditing(seg)}
                        className="p-1 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-100"
                        title={t.editSubtitle}
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Edit Form or Text Display */}
                {isEditing ? (
                  <div className="space-y-2 mt-2 bg-white p-2.5 rounded-lg border border-stone-200">
                    <div>
                      <label className="text-[10px] font-semibold text-stone-500 uppercase tracking-wider block mb-0.5">
                        Original Text
                      </label>
                      <input
                        type="text"
                        value={editOriginal}
                        onChange={(e) => setEditOriginal(e.target.value)}
                        className="w-full px-2.5 py-1 text-xs border border-stone-200 rounded-lg focus:ring-1 focus:ring-orange-500"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-orange-600 uppercase tracking-wider block mb-0.5">
                        Translated Text
                      </label>
                      <input
                        type="text"
                        value={editTranslated}
                        onChange={(e) => setEditTranslated(e.target.value)}
                        className="w-full px-2.5 py-1 text-xs border border-orange-300 rounded-lg focus:ring-1 focus:ring-orange-500"
                      />
                    </div>
                    <div className="flex items-center justify-end gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={cancelEditing}
                        className="px-2.5 py-1 text-xs text-stone-500 hover:bg-stone-100 rounded-md"
                      >
                        {t.cancel}
                      </button>
                      <button
                        type="button"
                        onClick={() => saveEditing(seg.id)}
                        className="px-3 py-1 text-xs font-semibold bg-orange-600 text-white hover:bg-orange-700 rounded-md flex items-center gap-1"
                      >
                        <Check className="w-3 h-3" />
                        {t.saveChanges}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {/* Translated Line */}
                    {(viewMode === 'split' || viewMode === 'translated') && (
                      <p
                        className={`text-sm font-semibold leading-relaxed ${
                          isActive ? 'text-stone-900' : 'text-stone-800'
                        }`}
                      >
                        {seg.translatedText}
                      </p>
                    )}

                    {/* Original Line */}
                    {(viewMode === 'split' || viewMode === 'original') && (
                      <p
                        className={`text-xs leading-relaxed ${
                          viewMode === 'split'
                            ? 'text-stone-500 font-normal'
                            : 'text-stone-800 font-medium'
                        }`}
                      >
                        {seg.originalText}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer helper */}
      <div className="p-2.5 bg-stone-50 border-t border-stone-100 text-[11px] text-stone-500 text-center">
        {t.clickToSeek}
      </div>
    </div>
  );
};

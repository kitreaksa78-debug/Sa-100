import React, { useRef, useState, useEffect } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  RotateCcw,
  Subtitles,
  Type,
  Music,
  Radio,
  Sparkles,
} from 'lucide-react';
import { SubtitleSegment } from '../types';
import { formatClockTime, speakText, stopSpeaking } from '../utils/subtitleUtils';
import { UILang, UI_TEXT } from '../data/translations';

interface MediaPlayerProps {
  mediaUrl: string | null;
  mediaType: 'video' | 'audio' | null;
  segments: SubtitleSegment[];
  currentTime: number;
  setCurrentTime: (time: number) => void;
  mediaPlayerRef: React.RefObject<HTMLVideoElement | HTMLAudioElement | null>;
  targetLangCode?: string;
  uiLang?: UILang;
}

export const MediaPlayer: React.FC<MediaPlayerProps> = ({
  mediaUrl,
  mediaType,
  segments,
  currentTime,
  setCurrentTime,
  mediaPlayerRef,
  targetLangCode = 'km',
  uiLang = 'km',
}) => {
  const t = UI_TEXT[uiLang];
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [subtitleMode, setSubtitleMode] = useState<'translated' | 'both' | 'original'>('translated');
  const [fontSize, setFontSize] = useState<'sm' | 'base' | 'lg'>('base');
  const [isAiVoiceDubbing, setIsAiVoiceDubbing] = useState(false);
  const lastSpokenSegmentIdRef = useRef<number | null>(null);

  // Find active segment for current playback timestamp
  const activeSegment = segments.find(
    (seg) => currentTime >= seg.start && currentTime <= seg.end
  );

  // Synchronized AI Voice Dubbing effect
  useEffect(() => {
    if (!isAiVoiceDubbing || !isPlaying) {
      if (!isAiVoiceDubbing) {
        stopSpeaking();
        lastSpokenSegmentIdRef.current = null;
      }
      return;
    }

    if (activeSegment && activeSegment.id !== lastSpokenSegmentIdRef.current) {
      lastSpokenSegmentIdRef.current = activeSegment.id;
      if (activeSegment.translatedText) {
        speakText(activeSegment.translatedText, targetLangCode);
      }
    }
  }, [activeSegment, isAiVoiceDubbing, isPlaying, targetLangCode]);

  const togglePlay = () => {
    const el = mediaPlayerRef.current;
    if (!el) return;
    if (el.paused) {
      el.play();
      setIsPlaying(true);
    } else {
      el.pause();
      setIsPlaying(false);
      if (isAiVoiceDubbing) {
        stopSpeaking();
      }
    }
  };

  const handleTimeUpdate = () => {
    if (mediaPlayerRef.current) {
      setCurrentTime(mediaPlayerRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (mediaPlayerRef.current) {
      setDuration(mediaPlayerRef.current.duration);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = parseFloat(e.target.value);
    setCurrentTime(newTime);
    if (mediaPlayerRef.current) {
      mediaPlayerRef.current.currentTime = newTime;
    }
    if (isAiVoiceDubbing) {
      stopSpeaking();
      lastSpokenSegmentIdRef.current = null;
    }
  };

  const toggleMute = () => {
    if (mediaPlayerRef.current) {
      mediaPlayerRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  const restart = () => {
    if (mediaPlayerRef.current) {
      mediaPlayerRef.current.currentTime = 0;
      mediaPlayerRef.current.play();
      setIsPlaying(true);
      if (isAiVoiceDubbing) {
        stopSpeaking();
        lastSpokenSegmentIdRef.current = null;
      }
    }
  };

  const toggleFullscreen = () => {
    const video = mediaPlayerRef.current as HTMLVideoElement;
    if (video && video.requestFullscreen) {
      video.requestFullscreen();
    }
  };

  if (!mediaUrl) {
    return null;
  }

  return (
    <div className="bg-stone-900 rounded-2xl overflow-hidden shadow-lg border border-stone-800 flex flex-col">
      {/* Visual / Media Container */}
      <div className="relative aspect-video w-full bg-black flex items-center justify-center overflow-hidden group">
        {mediaType === 'video' ? (
          <video
            id="main-video-player"
            ref={mediaPlayerRef as React.RefObject<HTMLVideoElement>}
            src={mediaUrl}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onEnded={() => setIsPlaying(false)}
            onClick={togglePlay}
            className="w-full h-full object-contain cursor-pointer"
            playsInline
          />
        ) : (
          <div
            onClick={togglePlay}
            className="w-full h-full flex flex-col items-center justify-center p-8 bg-gradient-to-b from-stone-900 via-stone-800 to-stone-950 text-white cursor-pointer select-none"
          >
            <audio
              id="main-audio-player"
              ref={mediaPlayerRef as React.RefObject<HTMLAudioElement>}
              src={mediaUrl}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
              onEnded={() => setIsPlaying(false)}
            />
            <div className="w-20 h-20 rounded-full bg-orange-600/30 border border-orange-500/50 flex items-center justify-center text-orange-400 mb-4 shadow-inner">
              <Music className="w-10 h-10 animate-pulse" />
            </div>
            <p className="text-sm font-semibold text-stone-300">Audio Track Playing</p>
            <p className="text-xs text-stone-500 mt-1">Live subtitles synchronized below</p>
          </div>
        )}

        {/* Live Subtitle Overlay */}
        {showSubtitles && activeSegment && (
          <div className="absolute bottom-6 inset-x-4 sm:inset-x-12 pointer-events-none flex flex-col items-center justify-center z-10 transition-all duration-150">
            <div className="bg-black/85 backdrop-blur-md px-4 py-2 rounded-xl text-center shadow-2xl max-w-2xl border border-white/10">
              {/* Show Original text if 'both' or 'original' */}
              {(subtitleMode === 'both' || subtitleMode === 'original') && (
                <p
                  className={`text-stone-300 font-medium ${
                    fontSize === 'sm'
                      ? 'text-xs'
                      : fontSize === 'lg'
                      ? 'text-base sm:text-lg'
                      : 'text-sm sm:text-base'
                  } ${subtitleMode === 'both' ? 'text-xs text-stone-400 mb-1 opacity-90' : ''}`}
                >
                  {activeSegment.originalText}
                </p>
              )}

              {/* Show Translated text if 'both' or 'translated' */}
              {(subtitleMode === 'both' || subtitleMode === 'translated') && (
                <p
                  className={`text-white font-bold leading-relaxed tracking-wide ${
                    fontSize === 'sm'
                      ? 'text-sm sm:text-base'
                      : fontSize === 'lg'
                      ? 'text-lg sm:text-2xl'
                      : 'text-base sm:text-xl'
                  }`}
                  style={{ textShadow: '0 2px 4px rgba(0,0,0,0.8)' }}
                >
                  {activeSegment.translatedText}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Media Player Controls Bar */}
      <div className="p-3 bg-stone-950 text-stone-300 flex flex-col gap-2">
        {/* Scrubber Range Bar */}
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-mono text-stone-400 w-10 text-right">
            {formatClockTime(currentTime)}
          </span>
          <input
            id="player-timeline-scrubber"
            type="range"
            min="0"
            max={duration || 100}
            step="0.1"
            value={currentTime}
            onChange={handleSeek}
            className="flex-1 h-1.5 bg-stone-800 rounded-lg appearance-none cursor-pointer accent-orange-500"
          />
          <span className="text-[11px] font-mono text-stone-400 w-10">
            {formatClockTime(duration)}
          </span>
        </div>

        {/* Buttons Row */}
        <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
          <div className="flex items-center gap-2">
            <button
              id="player-toggle-play"
              type="button"
              onClick={togglePlay}
              className="p-2 rounded-lg bg-orange-600 text-white hover:bg-orange-700 transition-colors"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause className="w-4 h-4 fill-white" /> : <Play className="w-4 h-4 fill-white" />}
            </button>

            <button
              id="player-restart"
              type="button"
              onClick={restart}
              className="p-2 rounded-lg text-stone-400 hover:text-white hover:bg-stone-800 transition-colors"
              title="Restart"
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            <button
              id="player-toggle-mute"
              type="button"
              onClick={toggleMute}
              className="p-2 rounded-lg text-stone-400 hover:text-white hover:bg-stone-800 transition-colors"
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4" />}
            </button>

            {/* AI Voice Dubbing / Live Audio Translation Toggle */}
            <button
              id="player-toggle-ai-dubbing"
              type="button"
              onClick={() => setIsAiVoiceDubbing(!isAiVoiceDubbing)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                isAiVoiceDubbing
                  ? 'bg-gradient-to-r from-orange-600 to-amber-600 text-white shadow-sm ring-1 ring-orange-400'
                  : 'text-stone-400 hover:text-white hover:bg-stone-800'
              }`}
              title={isAiVoiceDubbing ? t.aiVoiceOn : t.aiVoiceOff}
            >
              <Radio className={`w-3.5 h-3.5 ${isAiVoiceDubbing ? 'animate-pulse text-amber-200' : ''}`} />
              <span className="hidden sm:inline">{t.aiVoiceDubbing}</span>
              <span className="sm:hidden">AI Voice</span>
            </button>
          </div>

          {/* Subtitle Controls */}
          <div className="flex items-center gap-1.5">
            {/* Toggle CC button */}
            <button
              id="toggle-subtitles-cc"
              type="button"
              onClick={() => setShowSubtitles(!showSubtitles)}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1 transition-colors ${
                showSubtitles
                  ? 'bg-orange-600/30 border border-orange-500/50 text-orange-300'
                  : 'text-stone-500 hover:bg-stone-800'
              }`}
              title="Toggle Subtitles"
            >
              <Subtitles className="w-3.5 h-3.5" />
              <span>CC</span>
            </button>

            {/* Subtitle Language Switcher */}
            {showSubtitles && (
              <div className="flex items-center bg-stone-900 border border-stone-800 rounded-lg p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setSubtitleMode('translated')}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                    subtitleMode === 'translated'
                      ? 'bg-stone-800 text-white font-semibold'
                      : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  Translated
                </button>
                <button
                  type="button"
                  onClick={() => setSubtitleMode('both')}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                    subtitleMode === 'both'
                      ? 'bg-stone-800 text-white font-semibold'
                      : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  Both
                </button>
                <button
                  type="button"
                  onClick={() => setSubtitleMode('original')}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                    subtitleMode === 'original'
                      ? 'bg-stone-800 text-white font-semibold'
                      : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  Original
                </button>
              </div>
            )}

            {/* Font Size Selector */}
            {showSubtitles && (
              <button
                id="toggle-subtitles-font-size"
                type="button"
                onClick={() =>
                  setFontSize(fontSize === 'sm' ? 'base' : fontSize === 'base' ? 'lg' : 'sm')
                }
                className="p-1.5 rounded-lg text-stone-400 hover:text-white hover:bg-stone-800 text-xs font-mono"
                title={`Font Size: ${fontSize.toUpperCase()}`}
              >
                <Type className="w-3.5 h-3.5" />
              </button>
            )}

            {mediaType === 'video' && (
              <button
                id="player-fullscreen"
                type="button"
                onClick={toggleFullscreen}
                className="p-1.5 rounded-lg text-stone-400 hover:text-white hover:bg-stone-800"
                title="Fullscreen"
              >
                <Maximize className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

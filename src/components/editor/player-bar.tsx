'use client';

import { DownloadIcon, Loader2Icon, RefreshCcwIcon, Mic2Icon } from 'lucide-react';
import { cn } from 'cn';
import { type SpeakerColor } from '@/lib/speaker-color';
import {
  AudioPlayerButton,
  AudioPlayerDuration,
  AudioPlayerProgress,
  AudioPlayerSpeed,
  AudioPlayerTime,
  useAudioPlayer,
} from '@/components/ui/audio-player';

export type PlayerBarProps = {
  activeLineId: string | null;
  activePosition: number | null;
  activeSpeaker: string | null;
  speakerColorOf: (name: string | null) => SpeakerColor;
  episodeMode: boolean;
  regenerating: boolean;
  onRegenerate: () => void;
  /** ?download=1 URL for the loaded clip; null while nothing is loaded */
  downloadHref: string | null;
};

// layout mirrors the elevenlabs ui audio-player demo:
// label heading above, then outline play button · time · progress · duration · speed
// all transport state (time, duration, buffering, speed) lives in AudioPlayerProvider
export function PlayerBar({
  activeLineId,
  activePosition,
  activeSpeaker,
  speakerColorOf,
  episodeMode,
  regenerating,
  onRegenerate,
  downloadHref,
}: PlayerBarProps) {
  const player = useAudioPlayer();
  const disabled = !activeLineId && !episodeMode;
  const buffering = player.isBuffering;
  const failed = !!player.error;
  const spkColor = speakerColorOf(activeSpeaker);

  let label = 'No line loaded — press play on a line above';
  if (activeLineId) {
    if (failed) label = 'Audio failed to load — try Regenerate';
    else if (buffering) label = 'Loading audio…';
    else
      label = '';
  }

  return (
    <footer className="sticky bottom-0 z-20 border-t border-border bg-neutral-950/95 px-6 py-3 backdrop-blur">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-sm font-medium">
            {episodeMode && !failed && !buffering ? (
              <span className="inline-flex items-center gap-1.5 text-foreground">
                <Mic2Icon size={11} />
                Full episode
              </span>
            ) : activeLineId && !failed && !buffering ? (
              <>
                Line {activePosition} <span className="mx-1 text-muted-foreground">·</span>{' '}
                <span className={cn('inline-flex items-center gap-1', spkColor.text)}>
                  <Mic2Icon size={11} />
                  {activeSpeaker}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">{label}</span>
            )}
          </span>
          {!episodeMode && (
            <button
              type="button"
              onClick={onRegenerate}
              disabled={disabled || regenerating}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground',
                (disabled || regenerating) && 'pointer-events-none opacity-50',
              )}
              title="Re-create this line's audio"
            >
              {regenerating ? <Loader2Icon size={12} className="animate-spin" /> : <RefreshCcwIcon size={12} />}
              Regenerate
            </button>
          )}
          {downloadHref && (
            <a
              href={downloadHref}
              download
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
              title="Download this clip as .wav"
            >
              <DownloadIcon size={12} />
              Download
            </a>
          )}
        </div>
        <div className="flex items-center gap-3 sm:gap-4">
          <AudioPlayerButton
            variant="outline"
            size="default"
            disabled={disabled}
            className="size-10 shrink-0"
          />
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
            <AudioPlayerTime className="shrink-0 text-xs tabular-nums" />
            <AudioPlayerProgress className="flex-1" />
            <AudioPlayerDuration className="shrink-0 text-xs tabular-nums" />
            <AudioPlayerSpeed className="shrink-0" />
          </div>
        </div>
      </div>
    </footer>
  );
}

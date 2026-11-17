'use client';

import {
  CheckIcon,
  Loader2Icon,
  PenLineIcon,
  SparklesIcon,
  Undo2Icon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from 'cn';
import { wordDiff } from '@/lib/diff';
import type { RewriteMode } from '@/lib/grammar';

const HEADER_SPACE = 68; // sticky top bar height; popups open below it
const GAP = 6;
const FIX_W = 235; // approx popup widths so the clamping matches visually
const DIFF_W = 492;

export type Rect = { top: number; bottom: number; left: number };

function resolveAnchor(rect: Rect, selfWidth: number) {
  const vw = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const below = rect.top - 56 < HEADER_SPACE;
  return {
    top: below ? rect.bottom + GAP : rect.top - GAP,
    left: Math.max(8, Math.min(rect.left, vw - selfWidth - 12)),
    below,
  };
}

function Positioned({
  rect,
  selfWidth,
  children,
  tag,
}: {
  rect: Rect;
  selfWidth: number;
  children: React.ReactNode;
  tag?: string;
}) {
  const a = resolveAnchor(rect, selfWidth);
  return (
    <div
      {...(tag ? { [tag]: true } : {})}
      className={cn('fixed z-40', !a.below && '-translate-y-full')}
      style={{ top: a.top, left: a.left }}
    >
      {children}
    </div>
  );
}

/** Selection-anchored card: Fix grammar | Improve writing (or the busy state). */
export function FixPopup({
  rect,
  busy,
  busyMode,
  onRun,
}: {
  rect: Rect;
  busy: boolean;
  busyMode: RewriteMode;
  onRun: (mode: RewriteMode) => void;
}) {
  return (
    <Positioned rect={rect} selfWidth={FIX_W}>
      {busy ? (
        <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#131316] px-3 py-2 text-xs text-zinc-400 shadow-2xl shadow-black/50">
          <Loader2Icon size={13} className="animate-spin" />
          {busyMode === 'improve' ? 'Improving writing…' : 'Fixing grammar…'}
        </div>
      ) : (
        <div className="flex items-center overflow-hidden rounded-lg border border-white/10 bg-[#131316] shadow-2xl shadow-black/50">
          <button
            onClick={() => onRun('grammar')}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/5"
          >
            <SparklesIcon size={13} className="text-violet-400" />
            Fix grammar
          </button>
          <div className="h-5 w-px bg-white/10" />
          <button
            onClick={() => onRun('improve')}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/5"
          >
            <PenLineIcon size={13} className="text-sky-400" />
            Improve
          </button>
        </div>
      )}
    </Positioned>
  );
}

/** Post-apply review card: word diff with Keep / Remove. */
export function DiffPopup({
  rect,
  mode,
  prev,
  next,
  onKeep,
  onRemove,
}: {
  rect: Rect;
  mode: RewriteMode;
  prev: string;
  next: string;
  onKeep: () => void;
  onRemove: () => void;
}) {
  const parts = wordDiff(prev, next);
  return (
    <Positioned rect={rect} selfWidth={DIFF_W} tag="data-diff-popup">
      <div
        role="dialog"
        aria-label="Review AI edit"
        className="w-[min(492px,calc(100vw-24px))] overflow-hidden rounded-xl border border-white/10 bg-[#121214] shadow-2xl shadow-black/60"
      >
        <div className="flex items-center justify-between border-b border-white/5 px-3 py-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
            {mode === 'improve' ? (
              <PenLineIcon size={13} className="text-sky-400" />
            ) : (
              <SparklesIcon size={13} className="text-violet-400" />
            )}
            {mode === 'improve' ? 'Writing improved' : 'Grammar fixed'}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">
            keep or remove
          </span>
        </div>
        <div className="max-h-40 overflow-y-auto px-3 py-2 text-[13px] leading-6">
          {parts.map((p, i) =>
            p.type === 'same' ? (
              <span key={i} className="text-zinc-300">
                {p.text}
              </span>
            ) : p.type === 'add' ? (
              <span
                key={i}
                className="rounded bg-emerald-400/10 px-0.5 text-emerald-300"
              >
                {p.text}
              </span>
            ) : (
              <span
                key={i}
                className="rounded bg-red-400/10 px-0.5 text-red-300/90 line-through"
              >
                {p.text}
              </span>
            )
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-white/5 px-2.5 py-2">
          <Button
            size="xs"
            variant="ghost"
            className="gap-1 text-red-300 hover:bg-red-400/10 hover:text-red-200"
            onClick={onRemove}
          >
            <Undo2Icon size={12} /> Remove
          </Button>
          <Button size="xs" className="gap-1" onClick={onKeep}>
            <CheckIcon size={12} /> Keep
          </Button>
        </div>
      </div>
    </Positioned>
  );
}

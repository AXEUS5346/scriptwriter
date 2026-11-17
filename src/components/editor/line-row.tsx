'use client';

import { useEffect, useRef, type KeyboardEvent as ReactKeyEvent } from 'react';
import {
  AlertCircleIcon,
  Mic2Icon,
  PlayIcon,
  Loader2Icon,
  PencilIcon,
} from 'lucide-react';
import { cn } from 'cn';
import { spokenText, type EmotionTag } from '@/lib/line-text';
import { type SpeakerColor } from '@/lib/speaker-color';
import { setCaretAtTextIndex } from '@/lib/caret';
import type { LineStatus, ClientLine } from '@/components/editor/types';

const TAG_SPLIT_RE = /(\[(?:excited|sad|whispers|sighs|laughs)\])/i;

// per-emotion chip colors, same pill family as the speaker chip (sky)
const EMO_CHIP_CLS: Record<EmotionTag, string> = {
  excited: 'bg-amber-500/10 text-amber-300',
  sad: 'bg-violet-500/10 text-violet-300',
  whispers: 'bg-fuchsia-500/10 text-fuchsia-300',
  sighs: 'bg-zinc-400/10 text-zinc-300',
  laughs: 'bg-emerald-500/10 text-emerald-300',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Model text -> html with emotion tags as non-editable chips (innerText round-trips 1:1). */
export function textToHtml(text: string): string {
  return text
    .split(TAG_SPLIT_RE)
    .map((tok) => {
      const m = tok.match(/^\[(excited|sad|whispers|sighs|laughs)\]$/i) as RegExpMatchArray | null;
      if (m) {
        const tag = m[1].toLowerCase() as EmotionTag;
        return `<span class="emo-chip ${EMO_CHIP_CLS[tag]} inline-flex cursor-default items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-4" contenteditable="false" data-tag="${tag}">[${tag}]</span>`;
      }
      return escapeHtml(tok);
    })
    .join('');
}

export type LineRowProps = {
  line: ClientLine;
  position: number;
  status: LineStatus;
  playing: boolean;
  onText: (id: string, text: string, caret: number) => void;
  onSlash: (id: string) => void; // a '/' was just typed
  onCaretMoved: (id: string, caret: number) => void; // selection/caret changed with menu open
  onMenuNav: (e: ReactKeyEvent, id: string) => boolean; // menu keyboard routing; true if consumed
  onEnter: (id: string) => void;
  onBackspaceEmpty: (id: string) => void;
  onUndo: (id: string) => boolean;
  onPlay: (id: string) => void;
  onChipSpeaker: (id: string) => void;
  registerEl: (id: string, el: HTMLDivElement | null) => void;
  speakerColorOf: (name: string | null) => SpeakerColor;
  pendingCaret: { lineId: string; index: number } | null;
  clearPendingCaret: () => void;
};

// tiny status marks; "ready" lines stay perfectly clean like ruled paper
const STATUS_MARK: Record<LineStatus, { label: string; cls: string } | null> = {
  empty: null,
  nospeaker: { label: 'set speaker', cls: 'text-amber-300' },
  none: null,
  ready: null,
  stale: { label: 'stale', cls: 'text-amber-300/80' },
  failed: { label: 'failed', cls: 'text-red-300' },
  generating: { label: 'generating', cls: 'text-sky-300' },
};

export function LineRow(props: LineRowProps) {
  const { line, position, status } = props;
  const elRef = useRef<HTMLDivElement | null>(null);
  const lastLocal = useRef<string | null>(null);

  // external model changes (chips inserted, undo, grammar fix) re-render; typing doesn't
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (lastLocal.current === line.text) return;
    lastLocal.current = null;
    const sel = document.getSelection();
    const hadFocus = el.contains(sel?.anchorNode ?? null);
    el.innerHTML = textToHtml(line.text);
    if (hadFocus) el.focus();
  }, [line.text]);

  // applied caret position after programmatic text changes (chip insert etc.)
  const pendingCaret = props.pendingCaret;
  const clearPendingCaret = props.clearPendingCaret;
  useEffect(() => {
    const el = elRef.current;
    if (!el || !pendingCaret || pendingCaret.lineId !== line.id) return;
    el.focus();
    setCaretAtTextIndex(el, pendingCaret.index);
    clearPendingCaret();
  }, [pendingCaret, clearPendingCaret, line.id]);

  const readModel = (): { text: string; caret: number } => {
    const el = elRef.current;
    if (!el) return { text: line.text, caret: -1 };
    return { text: el.innerText.replace(/\u00a0/g, ' '), caret: caretIndex(el) };
  };
  const caretIndex = (el: HTMLElement): number => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return -1;
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer)) return -1;
    const probe = document.createRange();
    probe.selectNodeContents(el);
    probe.setEnd(r.startContainer, r.startOffset);
    return probe.toString().length;
  };

  const handleKeyDown = (e: ReactKeyEvent) => {
    if (props.onMenuNav(e, line.id)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      props.onEnter(line.id);
      return;
    }
    if (e.key === '/') {
      // decide the menu AFTER the character lands (input event)
      requestAnimationFrame(() => props.onSlash(line.id));
      return;
    }
    if (e.key === 'Backspace' && !line.text.trim()) {
      e.preventDefault();
      props.onBackspaceEmpty(line.id);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (props.onUndo(line.id)) e.preventDefault();
    }
  };

  const handleInput = () => {
    const { text, caret } = readModel();
    lastLocal.current = text;
    props.onText(line.id, text, caret);
    props.onCaretMoved(line.id, caret);
  };

  const mark = STATUS_MARK[status];
  const spkColor = props.speakerColorOf(line.speaker);

  return (
    <div
      data-row-id={line.id}
      className={cn(
        'group grid grid-cols-[2.25rem_1.75rem_auto_minmax(0,1fr)_auto] items-baseline gap-x-1.5 border-l-2 py-1 pl-1 pr-3 transition-colors',
        position % 2 === 1 ? 'border-l-transparent bg-zinc-950' : 'border-l-transparent bg-white/[0.045]',
        line.speaker && status !== 'nospeaker' && spkColor.border,
        status === 'nospeaker' && 'border-l-amber-500/70 bg-amber-500/[0.04]',
        props.playing && 'border-l-sky-400 bg-sky-500/[0.06]',
      )}
    >
      <button
        type="button"
        aria-label={`Play line ${position}`}
        title={status === 'ready' || status === 'stale' ? 'Play this line' : 'Generate and play this line'}
        onClick={() => props.onPlay(line.id)}
        className={cn(
          'flex size-6 translate-y-[3px] items-center justify-center rounded-md text-muted-foreground/50 transition hover:bg-white/5 hover:text-foreground',
          'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          props.playing && 'text-sky-300 opacity-100',
          status === 'generating' && 'cursor-wait opacity-100',
        )}
      >
        {status === 'generating'
          ? <Loader2Icon size={12} className="animate-spin" />
          : <PlayIcon size={12} />}
      </button>

      <span className="select-none text-right text-[11px] leading-5 text-muted-foreground/60 tabular-nums">{position}</span>

      {line.speaker ? (
        <button
          type="button"
          onClick={() => props.onChipSpeaker(line.id)}
          className={cn(
            'translate-y-[-1px] inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-4 transition hover:brightness-125',
            spkColor.chip,
          )}
          title="Change speaker (or press / on the line)"
        >
          <Mic2Icon size={9} /> {line.speaker}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => props.onChipSpeaker(line.id)}
          className="inline-flex items-center text-[10px] text-amber-300/50 transition hover:text-amber-200"
          title="Pick a speaker — the previous line's speaker is preselected (or press /)"
        >
          <Mic2Icon size={9} />
        </button>
      )}

      <div
        ref={(el) => {
          elRef.current = el;
          props.registerEl(line.id, el);
        }}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        role="textbox"
        aria-multiline="false"
        aria-label={`Line ${position}`}
        className="min-w-0 whitespace-pre-wrap break-words py-px text-[13px] leading-5 outline-none placeholder:text-muted-foreground/40"
        data-placeholder="Type dialogue…"
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        onKeyUp={() => {
          const { caret } = readModel();
          props.onCaretMoved(line.id, caret);
        }}
        onMouseUp={() => {
          const { caret } = readModel();
          props.onCaretMoved(line.id, caret);
        }}
        onPaste={(e) => {
          e.preventDefault();
          const t = e.clipboardData.getData('text/plain').replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ');
          document.execCommand('insertText', false, t);
        }}
      />

      <div className="flex min-w-[2.5rem] items-baseline justify-end gap-1.5">
        {status === 'failed' && line.lastError && (
          <span title={line.lastError}><AlertCircleIcon size={11} className="translate-y-[2px] text-red-300/80" /></span>
        )}
        {status === 'stale' && <PencilIcon size={10} className="translate-y-[2px] text-amber-300/70" />}
        {status === 'generating' && <Loader2Icon size={11} className="translate-y-[2px] animate-spin text-sky-300" />}
        {mark && <span className={cn('text-[9px] leading-4', mark.cls)}>{mark.label}</span>}
      </div>
    </div>
  );
}

export function spokenPreview(text: string): string {
  return spokenText(text);
}

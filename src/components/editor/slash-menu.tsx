'use client';

import { useEffect, useRef } from 'react';
import { Mic2Icon, SparklesIcon } from 'lucide-react';
import { cn } from 'cn';
import { VOICES } from '@/lib/voices';
import { EMOTION_TAGS } from '@/lib/line-text';
import { SPEAKER_PALETTE, type SpeakerColor } from '@/lib/speaker-color';

export type SlashMode = 'speaker' | 'emotion' | 'speaker-pick';

export type SlashMenuState = {
  lineId: string;
  mode: SlashMode;
  queryStart: number; // index of the '/' character in the text (speaker-pick: -1)
  caretEnd: number;   // current caret index (end of the typed query)
  query: string;
  rect: { top: number; left: number };
  active: number;
};

export type SlashItem = { value: string; label: string; hint?: string; group: 'speaker' | 'emotion' };

const TAG_HINTS: Array<{ t: EmotionTagItem; hint: string }> = [
  { t: 'excited', hint: 'a true spike of energy' },
  { t: 'sad', hint: 'loss, regret, vulnerability' },
  { t: 'whispers', hint: 'hushed, close, aside' },
  { t: 'sighs', hint: 'tired, resigned, relief' },
  { t: 'laughs', hint: 'real laughter' },
];

type EmotionTagItem = (typeof EMOTION_TAGS)[number];

export function menuItems(menu: SlashMenuState): SlashItem[] {
  const q = menu.mode === 'speaker-pick' ? '' : menu.query.toLowerCase();
  if (menu.mode === 'emotion') {
    return TAG_HINTS
      .filter(({ t }) => t.includes(q))
      .map(({ t, hint }) => ({ value: `em:${t}`, label: `[${t}]`, hint, group: 'emotion' as const }));
  }
  return VOICES
    .filter((v) => v.toLowerCase().includes(q))
    .map((v) => ({ value: `sp:${v}`, label: v, hint: menu.mode === 'speaker-pick' ? 'voice' : 'set speaker', group: 'speaker' as const }));
}

export function SlashMenu({
  menu,
  onCommit,
  onClose,
  onHover,
  speakerColorOf,
}: {
  menu: SlashMenuState;
  onCommit: (value: string) => void;
  onClose: () => void;
  onHover: (index: number) => void;
  speakerColorOf?: (name: string | null) => SpeakerColor;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const items = menuItems(menu);
  const active = Math.min(menu.active, Math.max(0, items.length - 1));
  const colorFor = (label: string): SpeakerColor =>
    speakerColorOf ? speakerColorOf(label) : SPEAKER_PALETTE[0]!;

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  if (items.length === 0) {
    return (
      <div ref={ref} className="fixed z-50 rounded-xl border border-border bg-popover p-3 text-xs text-muted-foreground shadow-xl" style={{ top: menu.rect.top + 6, left: menu.rect.left }}>
        No matching {menu.mode === 'emotion' ? 'emotions' : 'speakers'}
        <span className="mt-1 block text-[10px] text-muted-foreground/70">Esc to close and keep the text as typed</span>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="fixed z-50 max-h-72 w-60 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-xl"
      style={{ top: menu.rect.top + 6, left: menu.rect.left }}
      role="listbox"
    >
      <p className="flex items-center gap-1.5 px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {menu.mode === 'emotion' ? <SparklesIcon size={10} /> : <Mic2Icon size={10} />}
        {menu.mode === 'emotion' ? 'emotion tag' : 'speaker'}
      </p>
      {items.map((it, i) => (
        <button
          key={it.value}
          type="button"
          role="option"
          aria-selected={i === active}
          className={cn(
            'flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-[13px]',
            i === active ? 'bg-primary/90 text-primary-foreground' : 'hover:bg-muted',
          )}
          onMouseEnter={() => onHover(i)}
          onClick={() => onCommit(it.value)}
        >
          {it.group === 'emotion'
            ? <span className="font-mono text-[11px]">{it.label}</span>
            : <><span className={cn('size-2 shrink-0 self-center rounded-full', colorFor(it.label).dot)} /><span className="font-medium">{it.label}</span></>}
          {it.hint && <span className={cn('ml-auto truncate text-[10px]', i === active ? 'text-primary-foreground/70' : 'text-muted-foreground')}>{it.hint}</span>}
        </button>
      ))}
    </div>
  );
}

export function defaultMenu(mode: SlashMode, lineId: string, rect: { top: number; left: number }, queryStart: number, caretEnd: number): SlashMenuState {
  return { lineId, mode, queryStart, caretEnd, query: '', rect, active: 0 };
}

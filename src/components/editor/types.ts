// Client-side script types (aligned with src/lib/script-store.ts) and status
// derivation shared by the home page, editor, and player.

import { lineHash } from '@/lib/line-text';

export type ClientLine = {
  id: string;
  text: string;
  speaker: string | null;
  audio: { hash: string; durationMs: number; gen?: number } | null;
  lastError?: string;
};

export type ClientScript = {
  id: string;
  title: string;
  updatedAt: string;
  lines: ClientLine[];
};

export type LineStatus = 'empty' | 'nospeaker' | 'none' | 'ready' | 'stale' | 'failed' | 'generating';

export function statusOf(line: ClientLine, generating: boolean): LineStatus {
  if (generating) return 'generating';
  if (!line.text.trim()) return 'empty';
  if (!line.speaker) return 'nospeaker';
  const hash = lineHash(line.speaker, line.text);
  if (line.lastError && (!line.audio || line.audio.hash === hash)) return 'failed';
  if (!line.audio) return 'none';
  if (line.audio.hash !== hash) return 'stale';
  return 'ready';
}

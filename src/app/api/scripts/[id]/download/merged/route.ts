import fs from 'node:fs';
import { headers } from 'next/headers';
import { readScript, clipPath } from '@/lib/script-store';
import { lineHash } from '@/lib/line-text';
import { concatWavs, parseWav, silenceWav, readWavDurationMs } from '@/lib/wav';
import { ensureClipEnhanced } from '@/lib/tts';

const GAP_MS = 250; // between lines; within a line, segments play as one continuous clip

function allClipsUpToDate(id: string): { ok: boolean; why?: string } {
  const s = readScript(id);
  if (!s) return { ok: false, why: 'Script not found' };
  if (s.lines.filter((l) => l.text.trim()).length === 0) return { ok: false, why: 'No lines to download' };
  let why: string | undefined;
  s.lines.forEach((l, i) => {
    if (!l.text.trim()) return; // blank lines are never spoken
    if (!l.speaker) { why ??= `Line ${i + 1} has no speaker`; return; }
    if (!l.audio || l.audio.hash !== lineHash(l.speaker, l.text)) {
      why ??= `Line ${i + 1} has no up-to-date audio`;
      return;
    }
    if (!fs.existsSync(clipPath(id, l.id))) why ??= `Clip for line ${i + 1} is missing`;
  });
  return why ? { ok: false, why } : { ok: true };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await headers(); // forces dynamic rendering (never prerender a snapshot)
  const { id } = await params;
  const gate = allClipsUpToDate(id);
  if (!gate.ok) {
    return Response.json({ error: gate.why ?? 'Not all lines have up-to-date audio' }, { status: 409 });
  }
  const s = readScript(id)!;
  const speakable = s.lines.filter((l) => l.text.trim());

  const bufs: Buffer[] = [];
  let fmt = null as null | { sampleRate: number; channels: number; bitsPerSample: number };
  for (let i = 0; i < speakable.length; i++) {
    const l = speakable[i];
    // legacy 24 kHz clips are upgraded to enhanced 48 kHz here (and on disk)
    const buf = await ensureClipEnhanced(id, l.id);
    if (!fmt) fmt = parseWav(buf);
    bufs.push(buf);
    if (i < speakable.length - 1) bufs.push(silenceWav(GAP_MS, fmt));
  }
  const merged = concatWavs(bufs);
  const durMs = speakable.reduce((n, l) => n + readWavDurationMs(clipPath(id, l.id)), 0) + (speakable.length - 1) * GAP_MS;

  const name = (s.title || 'script').replace(/[<>:"/\\|?*]+/g, '').trim().replace(/\s+/g, '_') || 'script';
  return new Response(new Uint8Array(merged), {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Disposition': `attachment; filename="${name}_merged.wav"`,
      'Content-Length': String(merged.length),
      'X-Script-Duration-Ms': String(durMs),
    },
  });
}

import fs from 'node:fs';
import { headers } from 'next/headers';
import { readScript, clipPath, type Line } from '@/lib/script-store';
import { lineHash } from '@/lib/line-text';
import { concatWavs, parseWav, silenceWav, readWavDurationMs } from '@/lib/wav';
import { ensureClipEnhanced } from '@/lib/tts';

const GAP_MS = 250; // between lines; within a line, segments play as one continuous clip

/** The clip set that goes into the merged file: speakable lines with a speaker
 *  whose audio is up to date. Lines without a speaker are legal silent lines
 *  (the user may keep them unvoiced) - they contribute nothing and don't block
 *  the download; neither do stale clips for speaker'd lines. */
function mergedClipSet(id: string): { lines: Line[] } | { error: string } {
  const s = readScript(id);
  if (!s) return { error: 'Script not found' };
  const set = s.lines.filter(
    (l) =>
      l.text.trim() &&
      l.speaker &&
      l.audio &&
      l.audio.hash === lineHash(l.speaker, l.text) &&
      fs.existsSync(clipPath(id, l.id)),
  );
  if (set.length === 0) return { error: 'No lines have generated audio yet' };
  return { lines: set };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await headers(); // forces dynamic rendering (never prerender a snapshot)
  const { id } = await params;
  const gate = mergedClipSet(id);
  if ('error' in gate) {
    return Response.json({ error: gate.error }, { status: 409 });
  }
  const s = readScript(id)!;
  const set = gate.lines;

  const bufs: Buffer[] = [];
  let fmt = null as null | { sampleRate: number; channels: number; bitsPerSample: number };
  for (let i = 0; i < set.length; i++) {
    const l = set[i];
    // legacy 24 kHz clips are upgraded to enhanced 48 kHz here (and on disk)
    const buf = await ensureClipEnhanced(id, l.id);
    if (!fmt) fmt = parseWav(buf);
    bufs.push(buf);
    if (i < set.length - 1) bufs.push(silenceWav(GAP_MS, fmt));
  }
  const merged = concatWavs(bufs);
  const durMs = set.reduce((n, l) => n + readWavDurationMs(clipPath(id, l.id)), 0) + (set.length - 1) * GAP_MS;

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

import fs from 'node:fs';
import { headers } from 'next/headers';
import { createZip } from '@/lib/zip';
import { readScript, clipPath } from '@/lib/script-store';
import { lineHash, zipNameForLine } from '@/lib/line-text';
import { ensureClipEnhanced } from '@/lib/tts';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await headers(); // forces dynamic rendering (never prerender a snapshot)
  const { id } = await params;
  const s = readScript(id);
  if (!s) return new Response('Script not found', { status: 404 });

  const speakable = s.lines.filter((l) => l.text.trim());
  // lines without a speaker are legal silent lines: skipped, never a 409
  const clips = s.lines.filter(
    (l) =>
      l.text.trim() &&
      l.speaker &&
      l.audio &&
      l.audio.hash === lineHash(l.speaker, l.text) &&
      fs.existsSync(clipPath(id, l.id)),
  );
  if (clips.length === 0) return new Response('No lines have generated audio yet', { status: 409 });

  const entries: Array<{ name: string; data: Uint8Array }> = [];
  for (const l of clips) {
    // legacy 24 kHz clips are upgraded to enhanced 48 kHz here (and on disk)
    const data = await ensureClipEnhanced(id, l.id);
    const position = s.lines.indexOf(l) + 1; // row number, matching the editor
    entries.push({
      name: zipNameForLine(position, l.speaker!, l.text),
      data: new Uint8Array(data),
    });
  }

  const zip = createZip(entries);
  const name = (s.title || 'script').replace(/[<>:"/\\|?*]+/g, '').trim().replace(/\s+/g, '_') || 'script';
  return new Response(new Uint8Array(zip), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${name}_clips.zip"`,
      'Content-Length': String(zip.length),
    },
  });
}

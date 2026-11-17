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
  if (speakable.length === 0) return new Response('No lines to download', { status: 404 });

  // strict gate: every speakable line must be up to date (matches merged / UI allReady)
  for (let i = 0; i < s.lines.length; i++) {
    const l = s.lines[i];
    if (!l.text.trim()) continue;
    if (!l.speaker) return Response.json({ error: `Line ${i + 1} has no speaker` }, { status: 409 });
    if (!l.audio || l.audio.hash !== lineHash(l.speaker, l.text) || !fs.existsSync(clipPath(id, l.id))) {
      return Response.json({ error: `Line ${i + 1} has no up-to-date audio` }, { status: 409 });
    }
  }

  const entries: Array<{ name: string; data: Uint8Array }> = [];
  for (let i = 0; i < speakable.length; i++) {
    const l = speakable[i];
    // legacy 24 kHz clips are upgraded to enhanced 48 kHz here (and on disk)
    const data = await ensureClipEnhanced(id, l.id);
    entries.push({
      name: zipNameForLine(i + 1, l.speaker!, l.text),
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

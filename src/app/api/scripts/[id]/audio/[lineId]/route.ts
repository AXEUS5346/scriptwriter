import fs from 'node:fs';
import { headers } from 'next/headers';
import { readScript, clipPath } from '@/lib/script-store';
import { ensureClipEnhanced } from '@/lib/tts';

export async function GET(req: Request, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  await headers(); // forces dynamic rendering (never prerender a snapshot)
  const { id, lineId } = await params;
  const s = readScript(id);
  if (!s) return new Response('Script not found', { status: 404 });
  const line = s.lines.find((l) => l.id === lineId);
  if (!line) return new Response('Line not found', { status: 404 });
  const file = clipPath(id, lineId);
  if (!fs.existsSync(file)) return new Response('Clip not generated', { status: 404 });
  // clips reach the player cleared: legacy 24 kHz clips are upgraded to
  // enhanced 48 kHz on first touch (same render, DSP post-process only)
  const buf = await ensureClipEnhanced(id, lineId);
  const headers_: Record<string, string> = {
    'Content-Type': 'audio/wav',
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
  };
  // ?download=1: save as a file instead of streaming into the player
  if (new URL(req.url).searchParams.get('download')) {
    const slug = (s.title || 'clip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'clip';
    const pos = String(s.lines.indexOf(line) + 1).padStart(2, '0');
    const who = (line.speaker || 'speaker').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    headers_['Content-Disposition'] = `attachment; filename="${slug}-${pos}-${who}.wav"`;
  }
  return new Response(new Uint8Array(buf), { headers: headers_ });
}

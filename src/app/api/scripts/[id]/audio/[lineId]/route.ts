import fs from 'node:fs';
import { headers } from 'next/headers';
import { readScript, clipPath } from '@/lib/script-store';
import { ensureClipEnhanced } from '@/lib/tts';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  await headers(); // forces dynamic rendering (never prerender a snapshot)
  const { id, lineId } = await params;
  const s = readScript(id);
  if (!s) return new Response('Script not found', { status: 404 });
  if (!s.lines.some((l) => l.id === lineId)) return new Response('Line not found', { status: 404 });
  const file = clipPath(id, lineId);
  if (!fs.existsSync(file)) return new Response('Clip not generated', { status: 404 });
  // clips reach the player cleared: legacy 24 kHz clips are upgraded to
  // enhanced 48 kHz on first touch (same render, DSP post-process only)
  const buf = await ensureClipEnhanced(id, lineId);
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store',
    },
  });
}

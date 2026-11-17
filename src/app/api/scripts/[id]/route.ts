import { headers } from 'next/headers';
import { readScript, saveScript } from '@/lib/script-store';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await headers(); // forces dynamic rendering (never prerender a snapshot)
  const { id } = await params;
  const s = readScript(id);
  if (!s) return Response.json({ error: 'Script not found' }, { status: 404 });
  return Response.json({ script: s });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let patch: { title?: string; lines?: Array<{ id: string; text: string; speaker: string | null }> };
  try {
    patch = (await req.json()) as typeof patch;
  } catch {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }
  const s = saveScript(id, patch);
  if (!s) return Response.json({ error: 'Script not found' }, { status: 404 });
  return Response.json({ script: s, savedAt: new Date().toISOString() });
}

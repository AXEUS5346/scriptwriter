import {
  readScript,
  recordClipResult,
} from '@/lib/script-store';
import { getTTSState, startPreflight } from '@/lib/preflight';
import { generateLineAudio, enqueueTts, touchTtsLock, clearTtsLock } from '@/lib/tts';
import { lineHash } from '@/lib/line-text';

const globalKey = '__SCRIPTWRITER_LINE_INFLIGHT__';
function inflight(): Set<string> {
  const g = globalThis as typeof globalThis & Record<string, Set<string> | undefined>;
  if (!g[globalKey]) g[globalKey] = new Set();
  return g[globalKey]!;
}

/**
 * Generate (or regenerate) ONE line's clip. The client drives the batch loop, so
 * this is synchronous to the request and returns the final state of the line.
 * Regenerating overwrites the previous clip only on success.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let lineId = '';
  try {
    lineId = ((await req.json()) as { lineId?: string }).lineId ?? '';
  } catch { /* fallthrough */ }
  if (!lineId) return Response.json({ error: 'Missing lineId' }, { status: 400 });

  const script = readScript(id);
  if (!script) return Response.json({ error: 'Script not found' }, { status: 404 });
  const line = script.lines.find((l) => l.id === lineId);
  if (!line) return Response.json({ error: 'Line not found' }, { status: 404 });

  const text = line.text.trim();
  if (!text) return Response.json({ error: 'Line is empty', lineId }, { status: 422 });
  if (!line.speaker) {
    return Response.json({ error: 'This line has no speaker', lineId }, { status: 422 });
  }

  const key = `${id}:${lineId}`;
  if (inflight().has(key)) {
    return Response.json({ error: 'Line is already generating', lineId }, { status: 409 });
  }
  const tts = getTTSState();
  if (tts.state !== 'ready') {
    startPreflight(); // warm the resident engine; the client polls and retries
    return Response.json({ error: `Voice engine not ready (${tts.state}${tts.reason ? `: ${tts.reason}` : ''})` }, { status: 503 });
  }

  inflight().add(key);
  try {
    // snapshot the line content that THIS render adopts (an edit during
    // generation lands in a fresh save and will mark the clip stale afterwards)
    const renderSpeaker = line.speaker;
    const renderText = line.text;

    const r = await enqueueTts(async () => {
      touchTtsLock();
      try {
        return await generateLineAudio(id, { ...line, speaker: renderSpeaker, text: renderText });
      } finally {
        clearTtsLock();
      }
    });

    const updated = await recordClipResult(id, lineId, r.ok
      ? { ok: true, hash: lineHash(renderSpeaker, renderText), durationMs: r.durationMs }
      : { ok: false, error: r.error });
    if (!updated) return Response.json({ error: 'Script vanished during generation' }, { status: 500 });

    if (r.ok) {
      return Response.json({ ok: true, line: updated, segments: r.segments });
    }
    return Response.json({ error: r.error, line: updated }, { status: 500 });
  } finally {
    inflight().delete(key);
  }
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// gen stamps WHICH RENDER of the line this clip is (hash only reflects
// text+speaker, so two regenerations of identical text must not share a
// playback identity - the player reloads when gen changes).
export type LineAudio = { hash: string; durationMs: number; gen?: number };

export type Line = {
  id: string;
  text: string;
  speaker: string | null;
  audio?: LineAudio | null; // set by the server when a clip renders; client-SDK never writes it
  lastError?: string; // last generation failure, if any
};

export type Script = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lines: Line[];
};

export type ScriptSummary = {
  id: string;
  title: string;
  updatedAt: string;
  lineCount: number;
};

export function dataRoot(): string {
  return path.join(process.cwd(), '.data', 'scripts');
}

export function scriptDir(id: string): string {
  return path.join(dataRoot(), id);
}

export function scriptPath(id: string): string {
  return path.join(scriptDir(id), 'script.json');
}

export function audioRoot(id: string): string {
  return path.join(scriptDir(id), 'audio');
}

export function clipDir(scriptId: string, lineId: string): string {
  return path.join(audioRoot(scriptId), lineId);
}

export function clipPath(scriptId: string, lineId: string): string {
  return path.join(clipDir(scriptId, lineId), 'clip.wav');
}

export function segPath(scriptId: string, lineId: string, seg: number): string {
  return path.join(clipDir(scriptId, lineId), `seg-${String(seg).padStart(3, '0')}`);
}

export function newId(): string {
  return crypto.randomUUID();
}

export function listScripts(): ScriptSummary[] {
  try {
    const out: ScriptSummary[] = [];
    for (const dir of fs.readdirSync(dataRoot())) {
      const s = readScript(dir);
      if (s) {
        out.push({ id: s.id, title: s.title, updatedAt: s.updatedAt, lineCount: s.lines.length });
      }
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out;
  } catch {
    return [];
  }
}

export function readScript(id: string): Script | null {
  try {
    const raw = fs.readFileSync(scriptPath(id), 'utf8');
    const s = JSON.parse(raw) as Script;
    if (!s || typeof s.id !== 'string' || !Array.isArray(s.lines)) return null;
    return s;
  } catch {
    return null;
  }
}

export function writeScript(s: Script): void {
  const dir = scriptDir(s.id);
  fs.mkdirSync(dir, { recursive: true });
  s.updatedAt = new Date().toISOString();
  const tmp = path.join(dir, `script.json.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, scriptPath(s.id));
}

export function createScript(title?: string): Script {
  const s: Script = {
    id: newId(),
    title: title?.trim() || 'Untitled script',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lines: [{ id: newId(), text: '', speaker: null, audio: null }],
  };
  writeScript(s);
  return s;
}

/** Delete one script dir (script.json + all audio). Ids only, no paths. */
export function deleteScript(id: string): boolean {
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(id)) return false;
  if (!fs.existsSync(scriptPath(id))) return false;
  fs.rmSync(scriptDir(id), { recursive: true, force: true });
  return true;
}

/**
 * All script.json writes (autosave PUT, clip results) go through one promise
 * chain, so a save can't interleave with a finished clip write and drop it.
 * Route handlers of this app share one server process, so an in-process chain
 * is a full lock. (The instrumentation worker never writes scripts.)
 */
const writeChainKey = '__SCRIPTWRITER_WRITE_CHAIN__';
export function runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
  const g = globalThis as typeof globalThis & Record<string, Promise<unknown> | undefined>;
  const prev = g[writeChainKey] ?? Promise.resolve();
  const next = prev.then(fn, fn);
  g[writeChainKey] = next.then(() => undefined, () => undefined);
  return next;
}

export async function saveScript(id: string, patch: { title?: string; lines?: Array<{ id: string; text: string; speaker: string | null }> }): Promise<Script | null> {
  return runExclusive(() => saveScriptInner(id, patch));
}

function saveScriptInner(id: string, patch: { title?: string; lines?: Array<{ id: string; text: string; speaker: string | null }> }): Script | null {
  const cur = readScript(id);
  if (!cur) return null;
  if (typeof patch.title === 'string' && patch.title.trim()) cur.title = patch.title.trim().slice(0, 200);
  if (Array.isArray(patch.lines)) {
    const byId = new Map(cur.lines.map((l) => [l.id, l]));
    cur.lines = patch.lines.map((l) => {
      const existing = byId.get(l.id);
      if (existing) {
        existing.text = typeof l.text === 'string' ? l.text : existing.text;
        existing.speaker = typeof l.speaker === 'string' && l.speaker.trim() ? l.speaker : null;
        return existing;
      }
      return {
        id: l.id,
        text: typeof l.text === 'string' ? l.text : '',
        speaker: typeof l.speaker === 'string' && l.speaker.trim() ? l.speaker : null,
        audio: null,
      };
    });
  }
  writeScript(cur);
  return cur;
}

/** Record a clip render outcome for one line (inside the write lock). */
export async function recordClipResult(scriptId: string, lineId: string, result: { ok: true; hash: string; durationMs: number } | { ok: false; error: string }): Promise<Line | null> {
  return runExclusive(() => {
    const cur = readScript(scriptId);
    if (!cur) return null;
    const line = cur.lines.find((l) => l.id === lineId);
    if (!line) return null;
    if (result.ok) {
      line.audio = { hash: result.hash, durationMs: result.durationMs, gen: Date.now() };
      line.lastError = undefined;
    } else {
      line.lastError = result.error;
    }
    writeScript(cur);
    return line;
  });
}

// Always-on end-to-end logging for the app: every audio generation, enhancement
// and engine event lands in data/logs/app-YYYY-MM-DD.log. No env gate - the
// point is that a failure notification can always be explained from disk.
// Logging must NEVER crash the app: every call is best-effort.
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILES = 10;
const MAX_BYTES = 5 * 1024 * 1024;

export function logDir(): string {
  const base = process.env.SCRIPTWRITER_DATA_DIR || path.join(process.cwd(), '.data');
  return path.join(base, 'logs');
}

function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function fileForNow(): string {
  return path.join(logDir(), `app-${dayStamp()}.log`);
}

let currentDay = '';

function rollIfNeeded(): void {
  const day = dayStamp();
  if (day === currentDay) return;
  currentDay = day;
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    // prune: keep the newest MAX_FILES-1 app logs (today's is being written)
    const logs = fs.readdirSync(dir)
      .filter((f) => /^app-\d{4}-\d{2}-\d{2}(\.[a-z0-9-]+)?\.log$/.test(f))
      .sort();
    while (logs.length >= MAX_FILES) {
      const oldest = logs.shift()!;
      try { fs.unlinkSync(path.join(dir, oldest)); } catch { /* busy: keep others */ }
    }
  } catch { /* best effort */ }
}

/**
 * Append one event line: `2026-02-14T18:12:33.204Z [tts] seg 2/3 ok bytes=...`.
 * `data` (if any) is JSON-serialized. Fire-and-forget by design.
 */
export function logEv(scope: string, msg: string, data?: unknown): void {
  try {
    rollIfNeeded();
    let extra = '';
    if (data !== undefined) {
      try { extra = ' ' + JSON.stringify(data); } catch { extra = ' [unserializable]'; }
    }
    const line = `${new Date().toISOString()} [${scope}] ${msg}${extra}\n`;
    const f = fileForNow();
    // rotate oversized files at most once a day-change or when starting a write
    try {
      const st = fs.statSync(f);
      if (st.size > MAX_BYTES) {
        fs.renameSync(f, f.replace(/\.log$/, `-${Date.now()}.log`));
      }
    } catch { /* does not exist yet: fine */ }
    fs.appendFileSync(f, line);
  } catch { /* logging must never crash the app */ }
}

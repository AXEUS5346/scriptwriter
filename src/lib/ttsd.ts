// Resident llama-ttsd client. The daemon (tools/ttsd in the ROCmFPX fork) loads
// the Maya2 backbone + mmproj into RAM/GPU ONCE and then serves line-based
// requests over stdin/stdout, so a clip costs ~3-5 s instead of a full model
// reload. The model leaves VRAM when the daemon dies - which happens when this
// server process closes its stdin on exit (see installExitHooks), or is killed.
//
// OWNER RULE (handover trap B): Next 16's instrumentation register() runs in a
// separate worker process from route handlers, and globals are not shared
// across realms. The daemon is therefore owned by the ROUTE-SERVER process:
// ensureDaemon() is driven from the /api/preflight poller and from generation
// requests, both of which run in the main server process.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { buildTtsEnv, dlog, TTS_PATHS } from './tts-paths';
import { logEv } from './applog';

export type DaemonStatus = 'idle' | 'starting' | 'ready' | 'dead';

const READY_TIMEOUT_MS = 4 * 60 * 1000; // cold model load, incl. slow first-run CUDA init
const REQ_TIMEOUT_MS = 10 * 60 * 1000; // generous: long lines render for tens of seconds

type Waiter = {
  resolve: (r: { ok: boolean; error?: string }) => void;
  timer: NodeJS.Timeout | null;
};

type DaemonState = {
  proc: ChildProcess | null;
  status: DaemonStatus;
  errTail: string;
  stdoutBuf: string;
  lastError: string;
  readyWaiters: Array<{ resolve: (r: { ok: boolean; error?: string }) => void; timer: NodeJS.Timeout | null }>;
  reqWaiter: Waiter | null;
  listeners: Set<(status: DaemonStatus, reason?: string) => void>;
};

const globalKey = '__SCRIPTWRITER_TTSD__';
function s(): DaemonState {
  const g = globalThis as typeof globalThis & Record<string, DaemonState | undefined>;
  if (!g[globalKey]) {
    g[globalKey] = {
      proc: null,
      status: 'idle',
      errTail: '',
      stdoutBuf: '',
      lastError: '',
      readyWaiters: [],
      reqWaiter: null,
      listeners: new Set(),
    };
  }
  return g[globalKey]!;
}

export function onDaemonStatus(fn: (status: DaemonStatus, reason?: string) => void): void {
  s().listeners.add(fn);
}
export function daemonStatus(): DaemonStatus {
  return s().status;
}
export function daemonLastError(): string | undefined {
  return s().lastError || undefined;
}

function notify(status: DaemonStatus, reason?: string): void {
  logEv('engine', `daemon ${status}${reason ? `: ${reason}` : ''}`);
  for (const fn of s().listeners) {
    try { fn(status, reason); } catch { /* listener errors don't break the daemon */ }
  }
}

/** Kills any llama-ttsd still running from a crashed/older server. One GPU instance max. */
function clearOrphans(): void {
  const r = spawnSync('taskkill', ['/F', '/IM', 'llama-ttsd.exe'], { windowsHide: true });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  dlog(`ttsd orphan taskkill rc=${r.status} ${out.split('\n').slice(-1)[0] ?? ''}`.slice(0, 300));
}

let hooksInstalled = false;
function installExitHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const kill = () => {
    const st = s();
    const pid = st.proc?.pid;
    if (!pid) return;
    // 'exit' handlers must be synchronous: taskkill /T /F reaches the model no matter what
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
    st.proc = null;
    st.status = 'dead';
  };
  process.on('exit', kill);
  const term = () => {
    kill();
    process.exit(0);
  };
  process.on('SIGINT', term);
  process.on('SIGTERM', term);
}

export function killDaemon(): void {
  const st = s();
  const pid = st.proc?.pid;
  if (pid) {
    st.proc?.stdin?.end();
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
  }
  st.proc = null;
  st.status = 'dead';
  st.lastError = 'TTS daemon stopped';
  dlog(`ttsd killed (pid was ${pid})`);
}

function failLater(errTail: string, reason: string): void {
  const st = s();
  st.proc = null;
  st.status = 'dead';
  st.lastError = reason;
  const w = st.readyWaiters;
  st.readyWaiters = [];
  for (const x of w) {
    if (x.timer) clearTimeout(x.timer);
    x.resolve({ ok: false, error: reason });
  }
  const rw = st.reqWaiter;
  st.reqWaiter = null;
  if (rw) {
    if (rw.timer) clearTimeout(rw.timer);
    rw.resolve({ ok: false, error: `llama-ttsd died: ${reason}` });
  }
  notify('dead', reason);
  dlog(`ttsd exit; tail=${errTail.split('\n').filter(Boolean).slice(-3).join(' | ').slice(-400)}`);
}

/** Start the daemon if it isn't alive. Resolves when the model is resident ("READY"). */
export function ensureDaemon(): Promise<{ ok: boolean; error?: string }> {
  const st = s();
  if (st.proc && !st.proc.killed) {
    if (st.status === 'ready') return Promise.resolve({ ok: true });
    // already starting; piggyback on its READY waiter if one is pending
    return new Promise((resolve) => {
      st.readyWaiters.push({ resolve, timer: null });
      if (st.readyWaiters.length === 1) armReadyTimer(st.readyWaiters[0]);
    });
  }
  installExitHooks();
  clearOrphans(); // never two instances on the GPU (locked rule)

  for (const p of [TTS_PATHS.TTS_DAEMON, TTS_PATHS.TTS_BACKBONE, TTS_PATHS.TTS_MMPROJ]) {
    if (!fsExists(p)) {
      st.status = 'dead';
      st.lastError = `Missing file: ${p}`;
      notify('dead', st.lastError);
      return Promise.resolve({ ok: false, error: st.lastError });
    }
  }

  st.status = 'starting';
  st.errTail = '';
  st.stdoutBuf = '';
  st.lastError = '';
  st.readyWaiters = [];
  notify('starting');

  const args = [
    '-m', TTS_PATHS.TTS_BACKBONE,
    '-mm', TTS_PATHS.TTS_MMPROJ,
    '-ngl', '99',
    '-t', '5',
    '-c', '2048', // docs: 2048 KV-cache tokens per seat (reference engine)
    '--tts-lang', 'en',
    '--log-disable',
  ];
  dlog(`spawning daemon ${TTS_PATHS.TTS_DAEMON}`);
  const child = spawn(TTS_PATHS.TTS_DAEMON, args, { env: buildTtsEnv(), windowsHide: true });
  st.proc = child;

  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (d: string) => onStdout(d));
  child.stderr!.on('data', (d: Buffer) => {
    st.errTail = (st.errTail + d.toString()).slice(-2000);
  });
  child.on('error', (e) => {
    if (s().proc === child) failLater(st.errTail, `spawn failed: ${e.message}`);
  });
  child.on('exit', (code) => {
    if (s().proc === child) failLater(st.errTail, `daemon exited early (code ${code})`);
  });

  return new Promise((resolve) => {
    st.readyWaiters.push({ resolve, timer: null });
    armReadyTimer(st.readyWaiters[0]);
  });
}

function fsExists(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

function armReadyTimer(w: { resolve: (r: { ok: boolean; error?: string }) => void; timer: NodeJS.Timeout | null }): void {
  w.timer = setTimeout(() => {
    const st = s();
    const i = st.readyWaiters.indexOf(w);
    if (i >= 0) st.readyWaiters.splice(i, 1);
    w.resolve({ ok: false, error: 'llama-ttsd did not report READY in time' });
    // keep the remaining piggybacking waiters on a countdown too
    const next = st.readyWaiters[0];
    if (next && !next.timer) armReadyTimer(next);
  }, READY_TIMEOUT_MS);
}

function onStdout(chunk: string): void {
  const st = s();
  st.stdoutBuf += chunk;
  let idx: number;
  while ((idx = st.stdoutBuf.indexOf('\n')) >= 0) {
    const line = st.stdoutBuf.slice(0, idx).trim();
    st.stdoutBuf = st.stdoutBuf.slice(idx + 1);
    if (!line) continue;
    dlog(`ttsd stdout: ${line.slice(0, 200)}`);
    if (line === 'READY') {
      st.status = 'ready';
      const w = st.readyWaiters;
      st.readyWaiters = [];
      for (const x of w) {
        if (x.timer) clearTimeout(x.timer);
        x.resolve({ ok: true });
      }
      notify('ready');
    } else if (line.startsWith('FATAL')) {
      failLater(st.errTail, line.slice(6).trim() || 'daemon fatal error');
    } else if (line.startsWith('OK') || line.startsWith('ERR')) {
      const w = st.reqWaiter;
      st.reqWaiter = null;
      if (w) {
        if (w.timer) clearTimeout(w.timer);
        w.resolve({ ok: line.startsWith('OK'), error: line.startsWith('ERR') ? line.slice(4).trim() : undefined });
      }
    }
  }
}

/** Send one generation request; resolves when the daemon answers OK/ERR for it.
 *  `seed` pins the sampler for this request (equal across a line's chunks keeps
 *  their voice character consistent); omit it for a random take. */
export function sendTtsRequest(outPath: string, prompt: string, seed?: number): Promise<{ ok: boolean; error?: string }> {
  const st = s();
  if (st.status !== 'ready' || !st.proc || !st.proc.stdin || st.reqWaiter) {
    return Promise.resolve({ ok: false, error: 'llama-ttsd is not ready' });
  }
  const clean = prompt.replace(/[\r\n]+/g, ' ');
  const seedLine = Number.isFinite(seed) && (seed as number) > 0 ? String(Math.floor(seed as number)) : '';
  return new Promise((resolve) => {
    const waiter: Waiter = {
      resolve,
      timer: setTimeout(() => {
        if (st.reqWaiter === waiter) st.reqWaiter = null;
        resolve({ ok: false, error: 'llama-ttsd request timed out' });
      }, REQ_TIMEOUT_MS),
    };
    st.reqWaiter = waiter;
    try {
      st.proc!.stdin!.write(`${outPath}\n${clean}\n${seedLine}\n`);
    } catch (e) {
      st.reqWaiter = null;
      clearTimeout(waiter.timer!);
      resolve({ ok: false, error: `stdin write failed: ${String(e)}` });
    }
  });
}

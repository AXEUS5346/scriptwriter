// Status layer for the resident TTS daemon (see ./ttsd.ts).
// Route handlers answer from LIVE daemon state so a status file left by an
// earlier run can never claim "ready" while nothing is in VRAM (stale-snapshot
// trap A). The file (%TEMP%\scriptwriter_tts_status.json) still mirrors every
// transition for observability and cross-realm consumers (handover trap B).
//
// OWNER RULE: the daemon is spawned only by the main route-server process
// (/api/preflight poller, generation, /api/restart). src/instrumentation.ts
// runs in a separate worker and MUST NOT call startPreflight() - the model
// should be released by this server's own exit hooks (see ttsd.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { daemonLastError, daemonStatus, ensureDaemon, onDaemonStatus, type DaemonStatus } from './ttsd';
import { dlog } from './tts-paths';

export type TTSState = {
  state: 'loading' | 'ready' | 'failed';
  reason?: string;
  checkedAt?: string;
};

const STATUS_FILE = path.join(os.tmpdir(), 'scriptwriter_tts_status.json');

function writeStatusFile(state: TTSState): void {
  try {
    const tmp = `${STATUS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, STATUS_FILE);
  } catch (e) {
    dlog(`status file write failed: ${String(e)}`);
  }
}

function mapDaemon(status: DaemonStatus, failReason?: string): TTSState {
  if (status === 'ready') return { state: 'ready' };
  if (status === 'starting') return { state: 'loading', reason: 'Loading Maya2 into RAM/GPU (resident daemon)' };
  if (status === 'dead') return { state: 'failed', reason: failReason ?? daemonLastError() ?? 'Voice engine is not running' };
  return { state: 'loading', reason: 'Voice engine not started yet' };
}

let listenerInstalled = false;
function installStatusSync(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  onDaemonStatus((status, reason) => writeStatusFile(mapDaemon(status, reason)));
}
installStatusSync();

export function getTTSState(): TTSState {
  const st = mapDaemon(daemonStatus());
  return { ...st, checkedAt: new Date().toISOString() };
}

/** Fire-and-forget: makes sure the resident daemon is loading / loaded. */
export function startPreflight(): void {
  ensureDaemon()
    .then((r) => {
      if (!r.ok) dlog(`preflight: daemon did not become ready: ${r.error}`);
    })
    .catch((e) => dlog(`preflight crashed: ${String(e)}`));
}

// Shared TTS binary paths + spawn env. Kept in its own module so the daemon
// client (ttsd.ts) and the status layer (preflight.ts) can both import it
// without a circular dependency.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEBUG_LOG = path.join(os.tmpdir(), 'scriptwriter_preflight_debug.log');

export function dlog(msg: string): void {
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} pid=${process.pid} ${msg}\n`);
  } catch { /* ignore */ }
}

export const TTS_BIN = process.env.TTS_BIN ?? 'S:\\Code\\podcaster\\ROCmFPX\\build-cuda\\bin\\Release\\llama-tts.exe';
export const TTS_DAEMON = process.env.TTS_DAEMON ?? process.env.TTS_DAEMON_BIN
  ?? 'S:\\Code\\podcaster\\ROCmFPX\\build-cuda\\bin\\Release\\llama-ttsd.exe';
export const TTS_BACKBONE = process.env.TTS_BACKBONE ?? 'S:\\Code\\podcaster\\Maya2-Native-Q8_0.gguf';
export const TTS_MMPROJ = process.env.TTS_MMPROJ ?? 'S:\\Code\\podcaster\\mmproj-Maya2-Native-Q8_0.gguf';
export const CUDA_BIN = process.env.TTS_CUDA_PATH ?? 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.5';

export const TTS_PATHS = { TTS_BIN, TTS_DAEMON, TTS_BACKBONE, TTS_MMPROJ, CUDA_BIN };

export function buildTtsEnv(): NodeJS.ProcessEnv {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const cur = process.env[pathKey] ?? process.env.PATH ?? '';
  return {
    ...process.env,
    CUDA_PATH: CUDA_BIN,
    CUDA_PATH_V13_5: CUDA_BIN,
    [pathKey]: `${CUDA_BIN}\\bin;${CUDA_BIN}\\bin\\x64;${cur}`,
    PATH: `${CUDA_BIN}\\bin;${CUDA_BIN}\\bin\\x64;${process.env.PATH ?? ''}`,
  };
}

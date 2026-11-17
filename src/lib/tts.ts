import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clipDir,
  clipPath,
  segPath,
  type Line,
} from '@/lib/script-store';
import { buildTtsEnv, dlog, TTS_PATHS } from '@/lib/tts-paths';
import { daemonStatus, ensureDaemon, sendTtsRequest } from '@/lib/ttsd';
import { splitLinePrompts, GAP_MS } from '@/lib/prompt-chunks';
import { VOICES } from '@/lib/voices';
import { enhanceWavBuffer } from '@/lib/enhance';
import { concatWavs, parseWav, silenceWav, clipIsEnhancedPcm16Mono48k } from '@/lib/wav';

// ---- TTS prompt chunking ----------------------------------------------------
// The chunker lives in ./prompt-chunks (pure, unit-testable): callbacks only
// when the 30-word / 2-tag limit forces a split, cuts on the nearest sentence
// mark. Segments of one line are merged byte-exact so the result plays as a
// single clip.

const KNOWN_TAGS = ['excited', 'sad', 'whispers', 'sighs', 'laughs'];

/** The TTS only knows the 5 real tags; anything else in [brackets] must not reach it. */
function scrubUnknownTags(text: string): string {
  return text
    .replace(/\[([a-z]+)\]/gi, (m, name: string) => {
      return KNOWN_TAGS.includes(name.toLowerCase()) ? `[${name.toLowerCase()}]` : ' ';
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const FOREIGN_VOICE_RE = new RegExp(`\\b(${VOICES.join('|')})\\b`, 'gi');

/**
 * The model sometimes "hears" a built-in voice name inside the spoken text as a
 * voice switch: measured on seed-pinned renders, a Satvik line opening with
 * "Ahana, ..." leaves Satvik's timbre and lands near Ahana's (mel-cos 0.975 to
 * Ahana vs 0.927 for a clean Satvik line; F0 164 vs 136). Uppercasing the very
 * same spoken word prevents the switch (mel 0.919 to Ahana, F0 140, normal
 * duration - it is not spelled out). Mentions of the line's own speaker are
 * consistent with its conditioning and stay as typed.
 *
 * Render-time only: the editor page keeps the text exactly as the user wrote it.
 */
function guardForeignVoiceNames(text: string, speaker: string): string {
  if (!text) return text;
  const own = speaker.toLowerCase();
  return text.replace(FOREIGN_VOICE_RE, (m) =>
    m.toLowerCase() === own ? m : m.toUpperCase(),
  );
}

/** Sub-UINT32_MAX seed: 0 and 0xFFFFFFFF mean "random" inside the sampler. */
function randomUInt31(): number {
  return crypto.randomInt(1, 0x7FFFFFFE);
}

export async function runTts(promptPath: string, outPath: string, seed?: number): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const args = [
      '-m', TTS_PATHS.TTS_BACKBONE,
      '-mm', TTS_PATHS.TTS_MMPROJ,
      '-ngl', '99',
      '-t', '5',
      '-c', '2048', // docs: 2048 KV-cache tokens per seat (reference engine)
      '--tts-lang', 'en',
    ];
    if (seed !== undefined) args.push('-s', String(seed));
    args.push('-f', promptPath, '--output', outPath);
    const child = spawn(TTS_PATHS.TTS_BIN, args, { env: buildTtsEnv(), windowsHide: true });
    let errTail = '';
    child.stderr.on('data', (d: Buffer) => {
      errTail = (errTail + d.toString()).slice(-1200);
    });
    child.on('error', (e) => resolve({ ok: false, error: `spawn failed: ${e.message}` }));
    child.on('exit', (code) => {
      if (code === 0 && fs.existsSync(outPath)) {
        try {
          parseWav(fs.readFileSync(outPath));
          resolve({ ok: true });
        } catch (e) {
          resolve({ ok: false, error: `Bad WAV produced: ${String(e)}` });
        }
      } else {
        resolve({ ok: false, error: `llama-tts exit ${code}: ${errTail.trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(-300)}` });
      }
    });
  });
}

/**
 * One segment, best path first: the resident llama-ttsd daemon (model already
 * in RAM/GPU, ~3-5 s per clip). Falls back to a one-shot llama-tts.exe run ONLY
 * when the daemon cannot serve (missing exe, died). While the daemon is still
 * LOADING we never spawn the one-shot binary - that would put two models on the
 * GPU at once (locked rule).
 */
async function runSegment(
  promptPath: string,
  outPath: string,
  prompt: string,
  segIndex: number,
  total: number,
  seed?: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const d = await ensureDaemon();
  if (d.ok) {
    const r = await sendTtsRequest(outPath, prompt, seed);
    if (r.ok && fs.existsSync(outPath)) {
      try {
        parseWav(fs.readFileSync(outPath));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `Bad WAV produced: ${String(e)}` };
      }
    }
    if (daemonStatus() === 'starting') {
      return { ok: false, error: 'Voice engine is still loading; retry in a moment' };
    }
    dlog(`segment ${segIndex}/${total}: daemon ERR (${r.error ?? 'no output'}); one-shot fallback`);
  } else {
    if (daemonStatus() === 'starting') {
      return { ok: false, error: 'Voice engine is still loading; retry in a moment' };
    }
    dlog(`segment ${segIndex}/${total}: daemon unavailable (${d.error ?? '?'}); one-shot fallback`);
  }
  return runTts(promptPath, outPath, seed);
}

export type GenerateLineResult =
  | { ok: true; clipPath: string; durationMs: number; segments: number }
  | { ok: false; error: string; segments: number };

/** Generate one line's audio: chunked prompts -> llama-tts per segment -> merged clip.wav.
 *  One sampling seed per RENDER, shared by all chunks of this take: chunks render
 *  independently, so without a shared seed each chunk gets another random voice
 *  take and the merged line audibly changes character better mid-sentence. The
 *  seed still differs between regens (fresh take on the Regenerate button). */
export async function generateLineAudio(scriptId: string, line: Line): Promise<GenerateLineResult> {
  const dir = clipDir(scriptId, line.id);
  fs.mkdirSync(dir, { recursive: true });
  const text = guardForeignVoiceNames(scrubUnknownTags(line.text), line.speaker ?? '');
  const prompts = splitLinePrompts(text);
  const seed = randomUInt31();
  const parts: Buffer[] = [];

  for (let seg = 0; seg < prompts.length; seg++) {
    const promptPath = segPath(scriptId, line.id, seg) + '.txt';
    const outPath = segPath(scriptId, line.id, seg) + '.wav';
    const full = `{${line.speaker}}: ${prompts[seg]}`;
    fs.writeFileSync(promptPath, full, 'utf8');
    const r = await runSegment(promptPath, outPath, full, seg + 1, prompts.length, seed);
    if (!r.ok) {
      return { ok: false, error: prompts.length > 1 ? `segment ${seg + 1}/${prompts.length}: ${r.error}` : r.error, segments: seg + 1 };
    }
    parts.push(fs.readFileSync(outPath));
  }

  try {
    // reference engine: pieces are streamed back-to-back with 150 ms gaps
    // (gap_s = 0.15) - bake that into the merged clip
    const fmtInfo = parseWav(parts[0]);
    const gap = silenceWav(GAP_MS, {
      sampleRate: fmtInfo.sampleRate,
      channels: fmtInfo.channels,
      bitsPerSample: fmtInfo.bitsPerSample,
    });
    const mergedParts: Buffer[] = [];
    parts.forEach((p, i) => {
      if (i > 0) mergedParts.push(gap);
      mergedParts.push(p);
    });
    const merged = concatWavs(mergedParts);
    // Mandatory Clear enhancement (denoise/dereverb/loudness): every clip is
    // cleared before it can enter the player or any download. 24 kHz TTS PCM
    // goes up to 48 kHz first; the enhanced clip is what gets stored.
    let enhanced;
    try {
      enhanced = await enhanceWavBuffer(merged);
    } catch (e) {
      return { ok: false, error: `Clear enhancement failed: ${String(e)}`, segments: prompts.length };
    }
    const out = clipPath(scriptId, line.id);
    fs.writeFileSync(out, enhanced.buffer);
    return { ok: true, clipPath: out, durationMs: enhanced.durationMs, segments: prompts.length };
  } catch (e) {
    return { ok: false, error: `Merge failed: ${String(e)}`, segments: prompts.length };
  }
}

/**
 * Return the line's clip, upgrading legacy 24 kHz (pre-enhancement) clips to
 * enhanced 48 kHz in place on first touch. Old clips keep their exact TTS
 * render - this is DSP post-processing, not a regeneration.
 */
export async function ensureClipEnhanced(scriptId: string, lineId: string): Promise<Buffer> {
  const p = clipPath(scriptId, lineId);
  const buf = fs.readFileSync(p);
  if (clipIsEnhancedPcm16Mono48k(buf)) return buf;
  const enhanced = await enhanceWavBuffer(buf);
  fs.writeFileSync(p, enhanced.buffer);
  return enhanced.buffer;
}

// ---- serialization ----------------------------------------------------------
// Two guards: (1) an in-process queue, because route handlers of this app share
// one server process and llama-tts must never run twice in parallel on the GPU
// (locked finding); (2) a trivial cross-process advisory via the debug lock file,
// so a second scriptwriter/podcaster server can't pile a second instance on top.

const globalKey = '__SCRIPTWRITER_TTS_QUEUE__';
type QueueState = { chain: Promise<unknown> };
function queue(): QueueState {
  const g = globalThis as typeof globalThis & Record<string, QueueState | undefined>;
  if (!g[globalKey]) g[globalKey] = { chain: Promise.resolve() };
  return g[globalKey]!;
}

export async function enqueueTts<T>(fn: () => Promise<T>): Promise<T> {
  const q = queue();
  const run = q.chain.then(fn, fn);
  // keep the chain alive regardless of success/failure of this run
  q.chain = run.then(() => undefined, () => undefined);
  return run;
}

const LOCK_PATH = path.join(os.tmpdir(), 'scriptwriter_tts.lock');
const LOCK_STALE_MS = 3 * 60 * 1000;

export function ttsLockInfo(): { held: boolean; ageMs: number } {
  try {
    const s = fs.statSync(LOCK_PATH);
    return { held: Date.now() - s.mtimeMs < LOCK_STALE_MS, ageMs: Date.now() - s.mtimeMs };
  } catch {
    return { held: false, ageMs: 0 };
  }
}

export function touchTtsLock(): void {
  try { fs.closeSync(fs.openSync(LOCK_PATH, 'a')); } catch { /* best effort */ }
}

export function clearTtsLock(): void {
  try { fs.unlinkSync(LOCK_PATH); } catch { /* best effort */ }
}

import fs from 'node:fs';

export interface WavInfo {
  durationMs: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

/** Minimal RIFF/WAVE parser (PCM only). */
export function parseWav(buf: Buffer): WavInfo {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Not a RIFF/WAVE file');
  }
  let offset = 12;
  let sampleRate = 24000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (id === 'fmt ') {
      const audioFormat = buf.readUInt16LE(payload);
      if (audioFormat !== 1) throw new Error(`Unsupported WAV format ${audioFormat} (only PCM supported)`);
      channels = buf.readUInt16LE(payload + 2);
      sampleRate = buf.readUInt32LE(payload + 4);
      bitsPerSample = buf.readUInt16LE(payload + 14);
    } else if (id === 'data') {
      dataOffset = payload;
      dataSize = Math.min(size, buf.length - payload);
    }
    offset = payload + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error('No data chunk found in WAV');
  const bytesPerSec = sampleRate * channels * (bitsPerSample / 8);
  return {
    durationMs: Math.round((dataSize / bytesPerSec) * 1000),
    sampleRate,
    channels,
    bitsPerSample,
    dataOffset,
    dataSize,
  };
}

/** Concatenate PCM WAV buffers with a shared fmt chunk. */
export function concatWavs(buffers: Buffer[]): Buffer {
  const infos = buffers.map(parseWav);
  const first = infos[0];
  for (const i of infos) {
    if (i.sampleRate !== first.sampleRate || i.channels !== first.channels || i.bitsPerSample !== first.bitsPerSample) {
      throw new Error('Cannot stitch WAVs with mismatched fmt');
    }
  }
  const fmtPayload = Buffer.alloc(16);
  fmtPayload.writeUInt16LE(1, 0);
  fmtPayload.writeUInt16LE(first.channels, 2);
  fmtPayload.writeUInt32LE(first.sampleRate, 4);
  fmtPayload.writeUInt32LE(first.sampleRate * first.channels * (first.bitsPerSample / 8), 8);
  fmtPayload.writeUInt16LE(first.channels * (first.bitsPerSample / 8), 12);
  fmtPayload.writeUInt16LE(first.bitsPerSample, 14);

  const dataSize = infos.reduce((n, i) => n + i.dataSize, 0);
  const out = Buffer.alloc(44 + dataSize);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataSize, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  fmtPayload.copy(out, 20);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataSize, 40);
  let o = 44;
  for (let i = 0; i < buffers.length; i++) {
    const n = infos[i].dataSize;
    buffers[i].copy(out, o, infos[i].dataOffset, infos[i].dataOffset + n);
    o += n;
  }
  return out;
}

/** All-zero PCM WAV of given duration (ms), matching the given format. */
export function silenceWav(durationMs: number, fmt: { sampleRate: number; channels: number; bitsPerSample: number }): Buffer {
  const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  const dataSize = Math.max(0, Math.round((durationMs / 1000) * bytesPerSec));
  const out = Buffer.alloc(44 + dataSize);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataSize, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(fmt.channels, 22);
  out.writeUInt32LE(fmt.sampleRate, 24);
  out.writeUInt32LE(bytesPerSec, 28);
  out.writeUInt16LE(fmt.channels * (fmt.bitsPerSample / 8), 32);
  out.writeUInt16LE(fmt.bitsPerSample, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataSize, 40);
  return out;
}

/** True if the WAV buffer is exactly the enhanced clip format: PCM16 mono 48 kHz. */
export function clipIsEnhancedPcm16Mono48k(buf: Buffer): boolean {
  try {
    const info = parseWav(buf);
    return info.sampleRate === 48000 && info.channels === 1 && info.bitsPerSample === 16;
  } catch {
    return false;
  }
}

/** ms -> HH:MM:SS,mmm (SRT timestamp). */
export function msToSrtStamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const mmm = total % 1000;
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(mmm, 3)}`;
}

/** ms -> HH:MM:SS,mmm precision trimming not needed. */
export function readWavDurationMs(path: string): number {
  const buf = fs.readFileSync(path);
  return parseWav(buf).durationMs;
}

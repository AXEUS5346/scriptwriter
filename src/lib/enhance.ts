// Speech enhancement with the "clear" studio model (desert-ant-labs) - server only.
//
// The @desert-ant-labs/clear SDK has no Windows native build and its WASM path
// cannot initialize in plain Node, so we drive its exported clear-studio.onnx
// graph directly via onnxruntime-node. The graph is DeepFilterNet3-style with a
// fixed time length of 200 frames (2 s at 48 kHz, 10 ms hop):
//   spec       [1, 1, 200, 481, 2]  complex STFT of the noisy signal (re, im)
//   feat_erb   [1, 1, 200, 32]      ERB-band log features, EMA mean-normalized
//   feat_spec  [1, 1, 200, 96, 2]   unit-normalized complex features (bins 0..95)
//   -> spec_enhanced [1, 1, 200, 481, 2]
//
// Preprocessing/synthesis replicate the DeepFilterNet reference runtime
// (github.com/Rikorose/DeepFilterNet, libDF/src/lib.rs + tract.rs, MIT):
//   - sr 48000, fft_size 960, hop_size 480, WOLA with the vorbis window
//     w[n] = sin(pi/2 * sin^2(pi*(n+0.5)/960)) (power-complementary at 50%
//     overlap), spec normalized by wnorm = 1/960 after the forward DFT
//   - ERB bank per libDF erb_fb(48000, 960, 32, 2)
//   - feat_erb: 10*log10(band_power + 1e-10) then per-band EMA mean-norm
//     (alpha 0.990, state init linspace(-60, -90, 32)), output / 40
//   - feat_spec: first 96 bins, per-bin EMA unit-norm (alpha 0.990, state init
//     linspace(0.001, 0.0001, 96)), output / sqrt(state)
// Long signals are processed in 200-frame chunks with 18 warm-up frames at the
// head and 24 lookahead frames at the tail; each chunk owns a disjoint sample
// region, so chunks tile without crossfades. Fidelity is asserted by probe:
// a clean clip must come out near-identical (the model is ~transparent).

import fs from 'node:fs';
import path from 'node:path';

export const CLEAR_MODEL_PATH =
  process.env.CLEAR_MODEL_PATH ?? path.join(process.cwd(), 'models', 'clear-studio.onnx');

const SR = 48000;
const FFT = 960;
const HOP = 480;
const FREQ_BINS = FFT / 2 + 1; // 481
const NB_ERB = 32;
const NB_DF = 96;
const NORM_ALPHA = 0.99; // exp(-hop/sr / norm_tau=1s) rounded to 3 decimals
const FRAMES_PER_CHUNK = 200;
const HEAD_CTX = 18; // frames fed to the model but not written out (GRU warm-up)
const TAIL_CTX = 24; // trailing frames for the model's lookahead (df_lookahead=2)
const FRAMES_OUT = FRAMES_PER_CHUNK - HEAD_CTX - TAIL_CTX; // 158 owned frames/chunk

// ---------------------------------------------------------------- FFT (960) --
// 960 = 2^6 * 15 is not a power of two, so the 960-point DFT runs through
// Bluestein's chirp-z algorithm over a radix-2 FFT of size 4096.

const FFTL = 4096;
const FFT_REVERSE = new Uint32Array(FFTL);
for (let i = 0; i < FFTL; i++) {
  let r = 0;
  for (let b = 1, j = i; b < FFTL; b <<= 1, j >>= 1) r = (r << 1) | (j & 1);
  FFT_REVERSE[i] = r;
}
const TW_RE = new Float64Array(FFTL / 2);
const TW_IM = new Float64Array(FFTL / 2);
for (let k = 0; k < FFTL / 2; k++) {
  TW_RE[k] = Math.cos((-2 * Math.PI * k) / FFTL);
  TW_IM[k] = Math.sin((-2 * Math.PI * k) / FFTL);
}

/** In-place radix-2 FFT. forward=false => forward (unnormalized);
 *  forward=true => inverse (normalized by 1/N). */
function fft4096(re: Float64Array, im: Float64Array, inverse: boolean): void {
  for (let i = 0; i < FFTL; i++) {
    const j = FFT_REVERSE[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= FFTL; len <<= 1) {
    const half = len >> 1;
    const step = FFTL / len;
    for (let base = 0; base < FFTL; base += len) {
      for (let k = 0; k < half; k++) {
        const tw = k * step;
        const wr = TW_RE[tw];
        const wi = inverse ? -TW_IM[tw] : TW_IM[tw];
        const i0 = base + k;
        const i1 = i0 + half;
        const xr = re[i1];
        const xi = im[i1];
        const tr = xr * wr - xi * wi;
        const ti = xr * wi + xi * wr;
        re[i1] = re[i0] - tr;
        im[i1] = im[i0] - ti;
        re[i0] += tr;
        im[i0] += ti;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < FFTL; i++) {
      re[i] /= FFTL;
      im[i] /= FFTL;
    }
  }
}

// Bluestein machinery: X[k] = chirp[k] * IFFT(A . B)/FFTL with
// A = FFT(x.chirp), B = FFT(conjugated chirp mirrored circularly).
const CHIRP_RE = new Float64Array(FFT);
const CHIRP_IM = new Float64Array(FFT);
const B_TAB_RE = new Float64Array(FFTL);
const B_TAB_IM = new Float64Array(FFTL);
for (let n = 0; n < FFT; n++) {
  const ang = (-Math.PI * n * n) / FFT;
  CHIRP_RE[n] = Math.cos(ang);
  CHIRP_IM[n] = Math.sin(ang);
}
{
  for (let m = 0; m < FFT; m++) {
    B_TAB_RE[m] = CHIRP_RE[m];
    B_TAB_IM[m] = -CHIRP_IM[m];
  }
  // b is an even function of m (m^2 is symmetric), so the circularly wrapped
  // half holds exactly the same values as the front half.
  for (let m = 1; m < FFT; m++) {
    B_TAB_RE[FFTL - m] = B_TAB_RE[m];
    B_TAB_IM[FFTL - m] = B_TAB_IM[m];
  }
  fft4096(B_TAB_RE, B_TAB_IM, false);
}
const BS_RE = new Float64Array(FFTL);
const BS_IM = new Float64Array(FFTL);
const BD_RE = new Float64Array(FFTL);
const BD_IM = new Float64Array(FFTL);

/** Unnormalized DFT, size 960: out[k] = sum x[n] e^{-2 pi i n k / 960}. */
function dft960(xRe: Float64Array, xIm: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
  BS_RE.fill(0);
  BS_IM.fill(0);
  for (let n = 0; n < FFT; n++) {
    BS_RE[n] = xRe[n] * CHIRP_RE[n] - xIm[n] * CHIRP_IM[n];
    BS_IM[n] = xRe[n] * CHIRP_IM[n] + xIm[n] * CHIRP_RE[n];
  }
  fft4096(BS_RE, BS_IM, false);
  for (let m = 0; m < FFTL; m++) {
    BD_RE[m] = BS_RE[m] * B_TAB_RE[m] - BS_IM[m] * B_TAB_IM[m];
    BD_IM[m] = BS_RE[m] * B_TAB_IM[m] + BS_IM[m] * B_TAB_RE[m];
  }
  fft4096(BD_RE, BD_IM, true);
  for (let k = 0; k < FFT; k++) {
    outRe[k] = BD_RE[k] * CHIRP_RE[k] - BD_IM[k] * CHIRP_IM[k];
    outIm[k] = BD_RE[k] * CHIRP_IM[k] + BD_IM[k] * CHIRP_RE[k];
  }
}

const ID_X_RE = new Float64Array(FFT);
const ID_X_IM = new Float64Array(FFT);
const ID_T_RE = new Float64Array(FFT);
const ID_T_IM = new Float64Array(FFT);

/** Pure inverse DFT, size 960 (no 1/N scaling): x[n] = sum X[k] e^{+2 pi i n k / 960}. */
function idft960(xRe: Float64Array, xIm: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
  for (let k = 0; k < FFT; k++) {
    ID_X_RE[k] = xRe[k];
    ID_X_IM[k] = -xIm[k];
  }
  dft960(ID_X_RE, ID_X_IM, ID_T_RE, ID_T_IM);
  for (let n = 0; n < FFT; n++) {
    outRe[n] = ID_T_RE[n];
    outIm[n] = -ID_T_IM[n];
  }
}

// ----------------------------------------------------------- STFT pipeline ---
const WINDOW = (() => {
  const w = new Float64Array(FFT);
  for (let i = 0; i < FFT; i++) {
    const s = Math.sin((Math.PI * (i + 0.5)) / FFT);
    w[i] = Math.sin((Math.PI / 2) * s * s);
  }
  return w;
})();

/** ERB band widths in FFT bins, exactly libDF erb_fb(48000, 960, 32, 2). */
const ERB_BANDS = (() => {
  const freq2erb = (f: number) => 9.265 * Math.log1p(f / (24.7 * 9.265));
  const erb2freq = (n: number) => 24.7 * 9.265 * (Math.exp(n / 9.265) - 1);
  const freqWidth = SR / FFT;
  const erbLow = freq2erb(0);
  const erbHigh = freq2erb(SR / 2);
  const bands: number[] = new Array(NB_ERB).fill(0);
  const step = (erbHigh - erbLow) / NB_ERB;
  let prevFreq = 0;
  let freqOver = 0;
  for (let i = 1; i <= NB_ERB; i++) {
    const fb = Math.round(erb2freq(erbLow + i * step) / freqWidth);
    let nbFreqs = fb - prevFreq - freqOver;
    if (nbFreqs < 2) {
      freqOver = 2 - nbFreqs;
      nbFreqs = 2;
    } else {
      freqOver = 0;
    }
    bands[i - 1] = nbFreqs;
    prevFreq = fb;
  }
  bands[NB_ERB - 1] += 1; // fft_size/2 + 1 bins in total
  const tooLarge = bands.reduce((a, b) => a + b, 0) - (FFT / 2 + 1);
  if (tooLarge > 0) bands[NB_ERB - 1] -= tooLarge;
  return Uint32Array.from(bands);
})();

function linspace(a: number, b: number, n: number): Float64Array {
  const out = new Float64Array(n);
  const step = (b - a) / (n - 1);
  for (let i = 0; i < n; i++) out[i] = a + i * step;
  return out;
}

const OUT_FWD_RE = new Float64Array(FFT);
const OUT_FWD_IM = new Float64Array(FFT);

interface FeatStates {
  erbMean: Float64Array;
  specUnit: Float64Array;
}

function newFeatStates(): FeatStates {
  return { erbMean: linspace(-60, -90, NB_ERB), specUnit: linspace(0.001, 0.0001, NB_DF) };
}

// Analysis results for a whole line (per frame).
interface FrameAnalysis {
  nFrames: number;
  specRe: Float32Array;
  specIm: Float32Array;
  erbF: Float32Array;
  featRe: Float32Array;
  featIm: Float32Array;
}

/** STFT + model features for all frames of the signal. The EMA states advance
 *  continuously across every frame, exactly like the reference runtime. */
function analyzeFrames(x: Float32Array): FrameAnalysis {
  const len = x.length;
  const nFrames = Math.max(1, Math.ceil(len / HOP));
  const out: FrameAnalysis = {
    nFrames,
    specRe: new Float32Array(nFrames * FREQ_BINS),
    specIm: new Float32Array(nFrames * FREQ_BINS),
    erbF: new Float32Array(nFrames * NB_ERB),
    featRe: new Float32Array(nFrames * NB_DF),
    featIm: new Float32Array(nFrames * NB_DF),
  };
  const states = newFeatStates();
  const buf = new Float64Array(FFT);
  const specFrameRe = OUT_FWD_RE;
  const specFrameIm = OUT_FWD_IM;
  const erbView = new Float64Array(NB_ERB);
  const featFrameRe = new Float64Array(NB_DF);
  const featFrameIm = new Float64Array(NB_DF);
  for (let t = 0; t < nFrames; t++) {
    for (let j = 0; j < FFT; j++) {
      const idx = t * HOP - HOP + j; // frame buffer = [t*hop-480, t*hop+480)
      buf[j] = idx >= 0 && idx < len ? x[idx] : 0;
    }
    for (let n = 0; n < FFT; n++) {
      OUT_FWD_RE[n] = buf[n] * WINDOW[n];
      OUT_FWD_IM[n] = 0;
    }
    dft960(OUT_FWD_RE, OUT_FWD_IM, specFrameRe, specFrameIm);
    // wnorm (libDF applies it in analysis)
    for (let k = 0; k < FREQ_BINS; k++) {
      specFrameRe[k] *= 1 / FFT;
      specFrameIm[k] *= 1 / FFT;
    }
    for (let k = 0; k < FREQ_BINS; k++) {
      out.specRe[t * FREQ_BINS + k] = specFrameRe[k];
      out.specIm[t * FREQ_BINS + k] = specFrameIm[k];
    }
    // feat_erb
    let bcsum = 0;
    for (let b = 0; b < NB_ERB; b++) {
      const size = ERB_BANDS[b];
      const kInv = 1 / size;
      let acc = 0;
      for (let j = 0; j < size; j++) {
        const idx = bcsum + j;
        acc += (specFrameRe[idx] * specFrameRe[idx] + specFrameIm[idx] * specFrameIm[idx]) * kInv;
      }
      bcsum += size;
      const v = 10 * Math.log10(acc + 1e-10);
      const st = states.erbMean[b];
      states.erbMean[b] = v * (1 - NORM_ALPHA) + st * NORM_ALPHA;
      erbView[b] = (v - states.erbMean[b]) / 40;
    }
    for (let b = 0; b < NB_ERB; b++) out.erbF[t * NB_ERB + b] = erbView[b];
    // feat_spec: first 96 bins, unit-norm EMA
    for (let b = 0; b < NB_DF; b++) {
      const re = specFrameRe[b];
      const im = specFrameIm[b];
      const mag = Math.sqrt(re * re + im * im);
      const st = states.specUnit[b];
      states.specUnit[b] = mag * (1 - NORM_ALPHA) + st * NORM_ALPHA;
      const nrm = Math.sqrt(states.specUnit[b]);
      featFrameRe[b] = re / nrm;
      featFrameIm[b] = im / nrm;
    }
    for (let b = 0; b < NB_DF; b++) {
      out.featRe[t * NB_DF + b] = featFrameRe[b];
      out.featIm[t * NB_DF + b] = featFrameIm[b];
    }
  }
  return out;
}

// ------------------------------------------------------------- resampler -----
// Windowed-sinc 2x upsampler (24k -> 48k). TTS content is band-limited below
// 24 kHz, so only interpolation correctness matters.
const RES_TAPS = 32;
const UP_KERNELS = (() => {
  const hannJ = (j: number) => 0.5 * (1 - Math.cos((2 * Math.PI * j) / (RES_TAPS - 1)));
  return [0, 0.5].map((frac) => {
    const k = new Float64Array(RES_TAPS);
    for (let j = 0; j < RES_TAPS; j++) {
      const u = 15 + frac - j;
      const sinc = Math.abs(u) < 1e-9 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
      k[j] = sinc * hannJ(j);
    }
    let sum = 0;
    for (let j = 0; j < RES_TAPS; j++) sum += k[j];
    for (let j = 0; j < RES_TAPS; j++) k[j] /= sum;
    return k;
  });
})();

export function upsample2x(x: Float32Array): Float32Array {
  const y = new Float32Array(x.length * 2);
  for (let n = 0; n < y.length; n++) {
    const p = n / 2;
    const n0 = Math.floor(p);
    const kern = UP_KERNELS[p === n0 ? 0 : 1];
    let acc = 0;
    for (let j = 0; j < RES_TAPS; j++) {
      const idx = n0 - 15 + j;
      acc += (idx >= 0 && idx < x.length ? x[idx] : 0) * kern[j];
    }
    y[n] = acc;
  }
  return y;
}

// ----------------------------------------------------------- session ---------
type Ort = typeof import('onnxruntime-node');
type OrtSession = import('onnxruntime-node').InferenceSession;
let ortP: Promise<Ort | null> | null = null;
let sessionP: Promise<{ session: OrtSession; ort: Ort }> | null = null;

function loadOrt(): Promise<Ort | null> {
  if (!ortP) ortP = import('onnxruntime-node').then((m) => m as Ort).catch(() => null);
  return ortP;
}

async function getSession(): Promise<{ session: OrtSession; ort: Ort }> {
  if (!sessionP) {
    const p = (async () => {
      const ort = await loadOrt();
      if (!ort) throw new Error('onnxruntime-node not available');
      if (!fs.existsSync(CLEAR_MODEL_PATH)) {
        throw new Error(`clear model missing at ${CLEAR_MODEL_PATH}`);
      }
      const session = await ort.InferenceSession.create(CLEAR_MODEL_PATH, {
        graphOptimizationLevel: 'all',
        executionMode: 'sequential',
        intraOpNumThreads: 5, // locked rule: leave one core for OS/TTS
        interOpNumThreads: 1,
      });
      return { session, ort };
    })();
    // a failed load must not poison every future call - allow a retry
    p.catch(() => { if (sessionP === p) sessionP = null; });
    sessionP = p;
  }
  return sessionP;
}

const SPEC_ORT = new Float32Array(FRAMES_PER_CHUNK * FREQ_BINS * 2);
const ERB_ORT = new Float32Array(FRAMES_PER_CHUNK * NB_ERB);
const FEAT_ORT = new Float32Array(FRAMES_PER_CHUNK * NB_DF * 2);
const REN_RE = new Float64Array(FFT);
const REN_IM = new Float64Array(FFT);

/**
 * Enhance a mono 48 kHz signal. Throws on any model/runtime failure so callers
 * can surface a real error instead of silently passing audio through.
 */
export async function enhanceMono48k(x: Float32Array): Promise<Float32Array> {
  const { session, ort } = await getSession();
  const len = x.length;
  let rms = 0;
  for (let i = 0; i < len; i++) rms += x[i] * x[i];
  if (Math.sqrt(rms / Math.max(1, len)) < 1e-5) return x.slice(); // silence

  const an = analyzeFrames(x);
  const y = new Float32Array(len);
  let coveredTo = 0;
  const chunkCount = Math.max(1, Math.ceil(an.nFrames / FRAMES_OUT));
  const tRe = new Float64Array(FFT);
  const tIm = new Float64Array(FFT);
  for (let c = 0; c < chunkCount; c++) {
    const f0 = c * FRAMES_OUT;
    const cf = f0 - HEAD_CTX;
    SPEC_ORT.fill(0);
    ERB_ORT.fill(0);
    FEAT_ORT.fill(0);
    for (let i = 0; i < FRAMES_PER_CHUNK; i++) {
      const g = cf + i;
      if (g < 0 || g >= an.nFrames) continue; // zero pad = coherent silence
      for (let k = 0; k < FREQ_BINS; k++) {
        SPEC_ORT[i * FREQ_BINS * 2 + k * 2] = an.specRe[g * FREQ_BINS + k];
        SPEC_ORT[i * FREQ_BINS * 2 + k * 2 + 1] = an.specIm[g * FREQ_BINS + k];
      }
      for (let k = 0; k < NB_ERB; k++) ERB_ORT[i * NB_ERB + k] = an.erbF[g * NB_ERB + k];
      for (let k = 0; k < NB_DF; k++) {
        FEAT_ORT[i * NB_DF * 2 + k * 2] = an.featRe[g * NB_DF + k];
        FEAT_ORT[i * NB_DF * 2 + k * 2 + 1] = an.featIm[g * NB_DF + k];
      }
    }
    const specT = new ort.Tensor('float32', SPEC_ORT, [1, 1, FRAMES_PER_CHUNK, FREQ_BINS, 2]);
    const erbT = new ort.Tensor('float32', ERB_ORT, [1, 1, FRAMES_PER_CHUNK, NB_ERB]);
    const featT = new ort.Tensor('float32', FEAT_ORT, [1, 1, FRAMES_PER_CHUNK, NB_DF, 2]);
    const nameOf = (want: string) => {
      const i = session.inputNames.indexOf(want);
      return i >= 0 ? want : session.inputNames[i];
    };
    const feeds: Record<string, import('onnxruntime-node').Tensor> = {
      [nameOf('spec')]: specT,
      [nameOf('feat_erb')]: erbT,
      [nameOf('feat_spec')]: featT,
    };
    const result = await session.run(feeds);
    const enhOut = result[session.outputNames[0]].data as Float32Array;
    // WOLA synthesis of the frames this chunk owns:
    // output region = samples covered (both humps) by output frames
    // [f0-1 .. f0+FRAMES_OUT-1]: (f0*hop, (f0+FRAMES_OUT)*hop).
    const regionStart = coveredTo;
    const regionEnd = Math.min(len, (f0 + FRAMES_OUT) * HOP);
    if (regionEnd <= regionStart) continue;
    for (let i = HEAD_CTX - 1; i < HEAD_CTX + FRAMES_OUT + 1 && cf + i < an.nFrames; i++) {
      const g = cf + i;
      for (let k = 0; k < FREQ_BINS; k++) {
        REN_RE[k] = enhOut[(i * FREQ_BINS + k) * 2];
        REN_IM[k] = enhOut[(i * FREQ_BINS + k) * 2 + 1];
      }
      for (let k = FREQ_BINS; k < FFT; k++) {
        REN_RE[k] = REN_RE[FFT - k];
        REN_IM[k] = -REN_IM[FFT - k];
      }
      idft960(REN_RE, REN_IM, tRe, tIm);
      const g0 = g * HOP - HOP;
      for (let j = 0; j < FFT; j++) {
        const s = g0 + j;
        if (s < regionStart || s >= regionEnd) continue;
        y[s] += tRe[j] * WINDOW[j]; // iFFT already inverts wnorm; second window = WOLA
      }
    }
    coveredTo = regionEnd;
  }
  return y;
}

// ------------------------------------------------------------- WAV in/out ----
export interface DecodedWav {
  sampleRate: number;
  channels: number;
  mono: Float32Array; // averaged down
}

function decodeWavMono(buf: Buffer): DecodedWav {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Not a RIFF/WAVE file');
  let offset = 12;
  let sampleRate = 24000;
  let channels = 1;
  let bits = 16;
  let format = 1;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(payload);
      channels = buf.readUInt16LE(payload + 2);
      sampleRate = buf.readUInt32LE(payload + 4);
      bits = buf.readUInt16LE(payload + 14);
    } else if (id === 'data') {
      dataOffset = payload;
      dataSize = Math.min(size, buf.length - payload);
    }
    offset = payload + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error('WAV has no data chunk');
  if (format !== 1 || bits !== 16) throw new Error(`Unsupported WAV (format=${format}, bits=${bits})`);
  const frames = Math.floor(dataSize / (2 * channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let ch = 0; ch < channels; ch++) acc += buf.readInt16LE(dataOffset + (i * channels + ch) * 2);
    mono[i] = acc / channels / 32768;
  }
  return { sampleRate, channels, mono };
}

function encodeWav48k(x: Float32Array): Buffer {
  const dataSize = x.length * 2;
  const out = Buffer.alloc(44 + dataSize);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataSize, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(48000, 24);
  out.writeUInt32LE(48000 * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < x.length; i++) {
    let v = x[i];
    if (v > 1) v = 1;
    if (v < -1) v = -1;
    out.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return out;
}

export interface EnhanceWavResult {
  buffer: Buffer; // PCM16 mono 48 kHz
  durationMs: number;
  sampleRate: number;
}

/**
 * Enhance a TTS WAV clip: decode -> upsample to 48 kHz -> clear model -> WAV.
 * This is a mandatory stage: callers must treat failure as a render failure.
 */
export async function enhanceWavBuffer(buf: Buffer): Promise<EnhanceWavResult> {
  const wav = decodeWavMono(buf);
  let x = wav.mono;
  if (wav.sampleRate !== SR) {
    if (wav.sampleRate === SR / 2) {
      x = upsample2x(x);
    } else if (wav.sampleRate === 44100) {
      x = resampleLinear(x, wav.sampleRate, SR);
    } else {
      x = resampleLinear(x, wav.sampleRate, SR);
    }
  }
  const enhanced = await enhanceMono48k(x);
  // gentle true-peak guard after enhancement
  let peak = 0;
  for (let i = 0; i < enhanced.length; i++) peak = Math.max(peak, Math.abs(enhanced[i]));
  if (peak > 1) {
    const g = 0.99 / peak;
    for (let i = 0; i < enhanced.length; i++) enhanced[i] *= g;
  }
  return { buffer: encodeWav48k(enhanced), durationMs: Math.round((enhanced.length / SR) * 1000), sampleRate: SR };
}

// Fallback resampler for non-2x ratios (e.g. 44.1k) - windowed sinc, low taps.
function resampleLinear(x: Float32Array, from: number, to: number): Float32Array {
  const ratio = to / from;
  const outLen = Math.max(1, Math.round(x.length * ratio));
  const y = new Float32Array(outLen);
  for (let n = 0; n < outLen; n++) {
    const p = n / ratio;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const a = i0 >= 0 && i0 < x.length ? x[i0] : 0;
    const b = i0 + 1 >= 0 && i0 + 1 < x.length ? x[i0 + 1] : 0;
    y[n] = a + (b - a) * frac;
  }
  return y;
}

export function clearModelAvailable(): boolean {
  return fs.existsSync(CLEAR_MODEL_PATH);
}

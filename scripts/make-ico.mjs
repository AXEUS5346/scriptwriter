// Rasterizes the Scriptwriter logo tile and packs a multi-size .ico.
// Mirrors src/components/logo.tsx so the exe icon matches the in-app mark.
// Usage: node scripts/make-ico.mjs [out.ico]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.env.MAKE_ICO_SKIP === '1' ? null : (process.argv[2] ?? 'dist/scriptwriter.ico');

// --- geometry (512-space, identical to the SVG) ---
const R = { x: 16, y: 16, w: 480, h: 480, rx: 112, fill: [13, 13, 15, 255] };
const BORDER = { rx: 110.5, color: [44, 44, 49, 255], sw: 3 };
const GREY = [74, 74, 82, 255];
const WHITE = [250, 250, 250, 255];

const rects = [
  { x: 108, y: 149, w: 296, h: 22, c: GREY },              // line 1
  { x: 108, y: 341, w: 232, h: 22, c: GREY },              // line 3
];
// line 2 — waveform bars
const bars = [26, 52, 78, 96, 64, 40, 72, 96, 58, 34, 20, 44];
bars.forEach((h, i) => rects.push({ x: 108 + i * 25, y: 256 - h / 2, w: 11, h, c: WHITE }));

function insideRoundedRect(px, py, r) {
  const dx = Math.max(r.x + r.rx - px, px - (r.x + r.w - r.rx), 0);
  const dy = Math.max(r.y + r.rx - py, py - (r.y + r.h - r.rx), 0);
  if (dx === 0 && dy === 0) return true;
  return dx * dx + dy * dy <= r.rx * r.rx;
}

export function rasterize(size) {
  const s = size / 512;
  const data = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // 4x4 supersample per pixel, blending bg -> border -> bars
      const S = size <= 48 ? 6 : 4;
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / s;
          const y = (py + (sy + 0.5) / S) / s;
          let col = [0, 0, 0, 0];
          if (insideRoundedRect(x, y, R)) {
            // band between outer tile edge and the shrunken inner rect is the border stroke
            const inner = { x: R.x + 1.5, y: R.y + 1.5, w: R.w - 3, h: R.h - 3, rx: BORDER.rx };
            col = insideRoundedRect(x, y, inner) ? R.fill.slice() : BORDER.color.slice();
            for (const rect of rects) {
              if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) col = rect.c.slice();
            }
          }
          const w = col[3] / 255;
          r += col[0] * w; g += col[1] * w; b += col[2] * w; a += w;
        }
      }
      const n = S * S, i = (py * size + px) * 4;
      const aw = a / n;
      data[i] = Math.round(r / n);
      data[i + 1] = Math.round(g / n);
      data[i + 2] = Math.round(b / n);
      data[i + 3] = Math.round(aw * 255);
    }
  }
  return data;
}

// --- ICO packing: one BMP entry per size (32bpp BGRA, bottom-up + AND mask) ---
function bmpEntry(size, rgba) {
  const stride = size * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  const dib = Buffer.alloc(40 + stride * size + maskStride * size);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * stride;
    for (let x = 0; x < size; x++) {
      const o = 40 + y * stride + x * 4;
      dib[o] = rgba[src + x * 4 + 2];
      dib[o + 1] = rgba[src + x * 4 + 1];
      dib[o + 2] = rgba[src + x * 4];
      dib[o + 3] = rgba[src + x * 4 + 3];
    }
  }
  return dib;
}

if (!OUT) {
  // loaded as a library (preview tooling) — rasterizer only
} else {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const entries = sizes.map((s) => ({ s, rgba: rasterize(s) }));

  const headerSize = 6 + entries.length * 16;
  let offset = headerSize;
  const eHeaders = [];
  const blobs = [];
  for (const { s, rgba } of entries) {
    const bmp = bmpEntry(s, rgba);
    const eh = Buffer.alloc(16);
    eh[0] = s === 256 ? 0 : s;
    eh[1] = s === 256 ? 0 : s;
    eh.writeUInt16LE(1, 4);
    eh.writeUInt16LE(32, 6);
    eh.writeUInt32LE(bmp.length, 8);
    eh.writeUInt32LE(offset, 12);
    eHeaders.push(eh);
    blobs.push(bmp);
    offset += bmp.length;
  }

  const ico = Buffer.concat([Buffer.alloc(6), ...eHeaders, ...blobs]);
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(entries.length, 4);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, ico);
  console.log(`${OUT}: ${ico.length} bytes, sizes ${sizes.join(', ')}`);
}

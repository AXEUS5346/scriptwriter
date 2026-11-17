// Visual QA: render the 256px tile to a PNG (re-runs the rasterizer from make-ico.mjs).
process.env.MAKE_ICO_SKIP = '1';
const { rasterize } = await import('./make-ico.mjs');
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SIZES = process.argv.slice(2).map(Number);
const list = SIZES.length ? SIZES : [256];

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = ~0;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function pngFromRgba(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const s of list) {
  const out = `scripts/preview-${s}.png`;
  const png = pngFromRgba(s, rasterize(s));
  writeFileSync(out, png);
  console.log(`${out}: ${png.length} bytes`);
}

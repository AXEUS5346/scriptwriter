import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import fs from 'node:fs';
import path from 'node:path';

const build = path.resolve(import.meta.dirname, '..', 'build');
const svg = fs.readFileSync(path.join(build, 'icon.svg'));

const sizes = [512, 256, 128, 64, 48, 32, 16];
const pngs = [];
for (const size of sizes) {
  const buf = await sharp(svg, { density: 96 }).resize(size, size).png().toBuffer();
  pngs.push(buf);
  fs.writeFileSync(path.join(build, 'icons', `icon-${size}.png`), buf);
}
fs.writeFileSync(path.join(build, 'icon.png'), pngs[1]);

const ico = await pngToIco(pngs.slice(1));
fs.writeFileSync(path.join(build, 'icon.ico'), ico);
console.log('icon.ico +', sizes.length, 'pngs written to build/');

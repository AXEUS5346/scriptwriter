// Stage the Next.js standalone build into dist/app for electron-builder.
// Next standalone output does NOT include .next/static (client JS/CSS chunks) -
// it must be copied manually or the packaged app renders forever as "Loading
// script..." because every /_next/static/* request 404s and hydration never
// runs. This script does the full stage and verifies nothing is missing.
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nextDir = path.join(root, '.next');
const dest = path.join(root, 'dist', 'app');

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function copyDir(src, dst, stack = new Set()) {
  if (!exists(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  const real = (() => {
    try {
      return fs.realpathSync(src);
    } catch {
      return src;
    }
  })();
  if (stack.has(real)) return;
  stack.add(real);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    // standalone output uses junctions to dedupe node_modules; fs.copyFileSync
    // fails with EPERM on reparse points - copy the resolved target instead
    if (entry.isSymbolicLink()) {
      let target = null;
      let isDir = false;
      try {
        target = fs.realpathSync(s);
        isDir = fs.statSync(target).isDirectory();
      } catch {
        continue;
      }
      if (isDir) copyDir(target, d, stack);
      else fs.copyFileSync(target, d);
      continue;
    }
    if (entry.isDirectory()) copyDir(s, d, stack);
    else fs.copyFileSync(s, d);
  }
  stack.delete(real);
}

function rmDir(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function main() {
  if (!exists(path.join(nextDir, 'BUILD_ID'))) {
    throw new Error('.next/BUILD_ID missing - run `npm run build` first');
  }

  // 1. standalone server output -> dist/app (fresh copy per stage)
  const standalone = path.join(nextDir, 'standalone');
  if (exists(standalone)) {
    rmDir(dest);
    copyDir(standalone, dest);
  } else if (!exists(dest)) {
    throw new Error('.next/standalone missing and dist/app absent');
  }

  // 2. client chunks: .next/static -> dist/app/.next/static (never shipped by standalone)
  copyDir(path.join(nextDir, 'static'), path.join(dest, '.next', 'static'));

  // 3. verify the shipped build can actually boot and hydrate
  const required = [
    path.join(dest, 'server.js'),
    path.join(dest, 'package.json'),
    path.join(dest, '.next', 'BUILD_ID'),
    path.join(dest, '.next', 'server'),
    path.join(dest, '.next', 'static', 'chunks'),
  ];
  for (const p of required) {
    if (!exists(p)) throw new Error('staged build missing: ' + p);
  }
  const chunkCount = fs.readdirSync(path.join(dest, '.next', 'static', 'chunks')).length;
  const cssCount = fs
    .readdirSync(path.join(dest, '.next', 'static', 'chunks'))
    .filter((f) => f.endsWith('.css')).length;
  if (cssCount === 0) throw new Error('staged build has no CSS chunks');
  const buildId = fs.readFileSync(path.join(dest, '.next', 'BUILD_ID'), 'utf8').trim();
  console.log(`staged dist/app: BUILD_ID ${buildId}, ${chunkCount} chunk files, ${cssCount} css files`);
}

main();

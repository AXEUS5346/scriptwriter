// Post-build fixup: Next's output file tracer copies onnxruntime-node's
// onnxruntime_binding.node into standalone bundles but NOT always the sibling
// DLLs the binding loads (onnxruntime.dll, DirectML.dll, dxcompiler.dll).
// Without them the binding falls back to Windows' DLL search order and can
// bind an ancient C:\Windows\System32\onnxruntime.dll (v1.17.1 seen in the
// wild), version-mismatches against the 1.31.1 binding and ACCESS-VIOLATIONs
// the whole server on the first session create. Copy the real DLLs next to
// EVERY binding copy we produce.
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64');
const DLLS = ['onnxruntime.dll', 'DirectML.dll', 'dxcompiler.dll'];

// every dir under `root` containing an onnxruntime_binding.node
function findOrtDirs(root, out) {
  if (fs.existsSync(path.join(root, 'onnxruntime_binding.node'))) out.push(root);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== '.git') {
      findOrtDirs(path.join(root, e.name), out);
    }
  }
}

function runInto(root) {
  const targets = [];
  const base = path.resolve(root);
  findOrtDirs(base, targets);
  let fixed = 0;
  for (const dir of targets) {
    for (const dll of DLLS) {
      const from = path.join(SRC, dll);
      const to = path.join(dir, dll);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.copyFileSync(from, to);
        fixed++;
      }
    }
  }
  if (targets.length || fixed) console.log(`[fix-ort-dlls] ${base}: ort copies ${targets.length}, dlls copied ${fixed}`);
  return { dirs: targets.length, fixed };
}

module.exports = { runInto };

if (require.main === module) {
  const roots = process.argv.slice(2).map((p) => path.resolve(p));
  if (roots.length === 0) roots.push(path.join(__dirname, '..', '.next'));
  let dirs = 0;
  let fixed = 0;
  for (const root of roots) {
    const r = runInto(root);
    dirs += r.dirs;
    fixed += r.fixed;
  }
  console.log(`[fix-ort-dlls] ort copies found: ${dirs}, dlls copied: ${fixed}`);
}

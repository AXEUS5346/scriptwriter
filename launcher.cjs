// Scriptwriter launcher - compiled into scriptwriter.exe via Node SEA.
// Starts the bundled Next standalone server with a hidden node.exe child,
// waits for preflight, opens the default browser, and kills the whole tree
// when this console window closes.
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.dirname(process.execPath);
const NODE = path.join(ROOT, 'node', 'node.exe');
const APP = path.join(ROOT, 'app');
const PORT = 3060;
const URL = `http://localhost:${PORT}`;

function fail(msg) {
  console.error('scriptwriter: ' + msg);
  process.exit(1);
}

function preflight() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/preflight', timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function openBrowser(u) {
  spawnSync('cmd', ['/c', 'start', '', u], { windowsHide: true, detached: false });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  if (!fs.existsSync(NODE)) fail(`node runtime missing at ${NODE}`);
  if (!fs.existsSync(path.join(APP, 'server.js'))) fail(`app server missing at ${path.join(APP, 'server.js')}`);

  if (await preflight()) {
    console.log(`Scriptwriter is already running at ${URL}`);
    openBrowser(URL);
    process.exit(0);
  }

  const env = { ...process.env, PORT: String(PORT) };
  env.CLEAR_MODEL_PATH = path.join(ROOT, 'models', 'clear-studio.onnx');
  // optional local overrides (TTS paths etc.) from a launcher.env next to the exe
  const envFile = path.join(ROOT, 'launcher.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (m && m[1] !== 'PORT') env[m[1]] = m[2].trim();
    }
  }

  console.log('Starting Scriptwriter (first voice render loads the GPU model, give it a moment)…');
  const server = spawn(NODE, ['server.js'], {
    cwd: APP,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(d));
  server.stderr.on('data', (d) => process.stderr.write(d));

  const cleanup = () => {
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(server.pid)], { windowsHide: true });
    } catch { /* already gone */ }
  };
  process.on('exit', cleanup);
  ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach((sig) => {
    process.on(sig, () => { cleanup(); process.exit(0); });
  });

  server.on('exit', (code) => {
    console.log(`\nScriptwriter stopped (exit code ${code === null ? '?' : code}).`);
    process.exit(code ?? 0);
  });

  let ready = false;
  for (let i = 0; i < 180; i++) {
    if (server.exitCode !== null) break; // died while starting
    if (await preflight()) { ready = true; break; }
    await sleep(1000);
  }
  if (!ready) {
    console.error(`\nScriptwriter did not become reachable at ${URL} within 3 minutes.`);
    return; // keep the console open (server may still answer later)
  }
  openBrowser(URL);
  console.log(`\nScriptwriter is running at ${URL}`);
  console.log('Close this window to stop it (the voice engine model is released as well).');

  // liveness monitor: if the UI dies, surface it
  while (server.exitCode === null) {
    await sleep(5000);
    if (!(await preflight())) {
      const gone = server.exitCode !== null;
      if (gone) break;
      console.error('warning: server stopped answering on the port');
    }
  }
}

main().catch((e) => fail(String(e && e.stack || e)));

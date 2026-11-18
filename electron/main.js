const { app, BrowserWindow, shell } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const BASE_PORT = 3060;
const PORT_RANGE = 10;
const PREFLIGHT_TIMEOUT_MS = 180000;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let splash = null;
let serverProc = null;
let serverPort = null;
let quitting = false;
let serverRestarts = 0;
const MAX_SERVER_RESTARTS = 3;
let serverStartedAt = 0;

// --- helpers -----------------------------------------------------------

function resourceRoot() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'dist');
}

function parseEnvFile(file) {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function freePort(start) {
  return new Promise((resolve) => {
    const tryPort = (port, left) => {
      if (left <= 0) return resolve(null);
      const srv = http.createServer();
      srv.once('error', () => tryPort(port + 1, left - 1));
      srv.listen(port, '127.0.0.1', () => {
        srv.close(() => resolve(port));
      });
    };
    tryPort(start, PORT_RANGE);
  });
}

function serverLog() {
  const dir = path.join(app.getPath('userData'), 'logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return fs.createWriteStream(path.join(dir, 'server.log'), { flags: 'a' });
  } catch {
    return null;
  }
}

function preflightOnce(port) {
  const p = port == null ? serverPort : port;
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: p, path: '/api/preflight', timeout: 2500 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function waitForServer(port) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      const ok = await preflightOnce(port);
      if (ok) return resolve(ok);
      if (Date.now() - started > PREFLIGHT_TIMEOUT_MS) return resolve(null);
      setTimeout(tick, 500);
    };
    tick();
  });
}

function fetchText(port, reqPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: reqPath, timeout: timeoutMs || 2000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(res.statusCode === 200 ? body : null));
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function localBuildId() {
  try {
    return fs
      .readFileSync(path.join(resourceRoot(), 'app', '.next', 'BUILD_ID'), 'utf8')
      .trim();
  } catch {
    return null;
  }
}

function killPortListeners(port) {
  const out = spawnSync('cmd.exe', [
    '/c', `netstat -ano | findstr :${port} | findstr LISTENING`,
  ], { windowsHide: true, encoding: 'utf8' });
  const pids = new Set();
  for (const line of String(out.stdout || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 5 && /^\d+$/.test(parts[4]) && Number(parts[4]) !== process.pid) {
      pids.add(parts[4]);
    }
  }
  for (const pid of pids) {
    spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }
  return pids.size;
}

/**
 * Reuse a running server instead of spawning another one. The Maya2 model
 * takes tens of seconds to load, so a warm server from a previous launch is
 * worth keeping - but only if it serves the SAME build this window is about
 * to load (otherwise a post-update stale orphan would keep showing old UI).
 * Foreign or stale-build servers on the port range are killed.
 */
async function adoptExistingServer() {
  const buildId = localBuildId();
  if (!buildId) return null;
  for (let p = BASE_PORT; p < BASE_PORT + PORT_RANGE; p++) {
    const pf = await preflightOnce(p);
    if (!pf) continue;
    const remote = await fetchText(p, '/build-id.txt');
    if (remote && remote.trim() === buildId) return p;
    killPortListeners(p);
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// --- server ------------------------------------------------------------

function startServer() {
  const root = resourceRoot();
  const appRoot = path.join(root, 'app');
  // Next 16 PPR persists rendered pages into .next/server/route-cache at
  // runtime. On a file-copy update those snapshots outlive the old build and
  // are then served instead of the new one. A fresh spawn owns this build,
  // so its runtime cache starts empty.
  try {
    fs.rmSync(path.join(appRoot, '.next', 'server', 'route-cache'), { recursive: true, force: true });
  } catch {}
  const appEnv = parseEnvFile(path.join(appRoot, '.env.local'));
  // Scripts live in roaming app data (%APPDATA%/Scriptwriter/data) - the
  // install folder is wiped by every update, so it must never hold the only
  // copy. One-time migration from the legacy bundled .data on first run.
  const dataDir = path.join(app.getPath('userData'), 'data');
  try {
    fs.mkdirSync(path.join(dataDir, 'scripts'), { recursive: true });
    const legacyBase = path.join(appRoot, '.data', 'scripts');
    const legacyHasEntries = fs
      .readdirSync(legacyBase, { withFileTypes: true })
      .some((e) => e.isDirectory() && e.name.includes('-'));
    const targetEmpty =
      fs.readdirSync(path.join(dataDir, 'scripts'), { withFileTypes: true }).length === 0;
    if (legacyHasEntries && targetEmpty) {
      fs.cpSync(legacyBase, path.join(dataDir, 'scripts'), { recursive: true });
    }
  } catch {}
  const env = {
    ...appEnv,
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(serverPort),
    HOSTNAME: '127.0.0.1',
    CLEAR_MODEL_PATH: path.join(root, 'models', 'clear-studio.onnx'),
    SCRIPTWRITER_DATA_DIR: dataDir,
    NEXT_TELEMETRY_DISABLED: '1',
  };

  // Prefer a real node.exe when bundled (packaged): spawning the electron
  // exe in ELECTRON_RUN_AS_NODE mode from a packaged app hangs silently.
  const bundledNode = path.join(root, 'node', 'node.exe');
  const useBundledNode = fs.existsSync(bundledNode);
  if (useBundledNode) {
    delete env.ELECTRON_RUN_AS_NODE;
  } else {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  const nodeBin = useBundledNode ? bundledNode : process.execPath;

  serverProc = spawn(nodeBin, [path.join(appRoot, 'server.js')], {
    env,
    cwd: appRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverStartedAt = Date.now();
  serverProc.on('error', (err) => {
    try {
      const { dialog } = require('electron');
      dialog.showErrorBox('Scriptwriter', 'Failed to start the local server: ' + err.message);
    } catch {}
  });

  const log = serverLog();
  if (log) {
    log.write(`\n--- start ${new Date().toISOString()} (pid ${serverProc.pid}) ---\n`);
    serverProc.stdout.on('data', (d) => log.write(d));
    serverProc.stderr.on('data',
      (d) => log.write(`[err] ${d}`));
    serverProc.on('exit', (code) => log.write(`--- exit ${new Date().toISOString()} (code ${code}) ---\n`));
  }
  // watchdog: a native crash in a route (e.g. a bad addon) must not turn the
  // whole app dead while the window is open - spawn a fresh server on the
  // same port, so a renderer retry just works
  if (serverProc) {
    serverProc.once('exit', (code) => {
      if (quitting || !win || win.isDestroyed()) return;
      serverProc = null;
      // a server that lived > 5 min earns a fresh restart budget
      if (Date.now() - serverStartedAt > 5 * 60 * 1000) serverRestarts = 0;
      if (serverRestarts >= MAX_SERVER_RESTARTS) {
        try {
          const { dialog } = require('electron');
          dialog.showErrorBox('Scriptwriter', 'The local audio server crashed repeatedly. Restart the app.');
        } catch {}
        return;
      }
      serverRestarts += 1;
      if (log) log.write(`--- watchdog: restarting server (attempt ${serverRestarts}/${MAX_SERVER_RESTARTS}, prev code ${code}) ---\n`);
      setTimeout(() => {
        if (quitting) return;
        try { startServer(); } catch (e) {
          if (log) log.write(`--- watchdog restart failed: ${e.message} ---\n`);
        }
      }, 1500);
    });
  }
}

function killServer() {
  if (serverProc && serverProc.pid) {
    try {
      spawnSync('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      try {
        serverProc.kill();
      } catch {}
    }
  } else if (serverPort != null) {
    // adopted server: we never spawned it, but it serves nobody else now
    killPortListeners(serverPort);
  }
  serverProc = null;
}

// --- windows -----------------------------------------------------------

function splashHtml(state) {
  const icon = `data:image/svg+xml;utf8,${encodeURIComponent(
    fs.readFileSync(path.join(__dirname, 'splash.svg'), 'utf8')
  )}`;
  const label = state === 'slow' ? 'Maya2 is waking up — first run takes a while…' : 'Starting the speech engine…';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0a0a0c;color:#d4d4d8;
      font-family:"Segoe UI",system-ui,sans-serif;overflow:hidden}
    body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}
    img{width:96px;height:96px;animation:pulse 1.6s ease-in-out infinite}
    p{margin:0;font-size:13px;color:#a1a1aa}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
  </style></head><body>
    <img src="${icon}"><p>${label}</p>
  </body></html>`;
}

function makeSplash() {
  splash = new BrowserWindow({
    width: 420,
    height: 300,
    center: true,
    resizable: false,
    frame: false,
    backgroundColor: '#0a0a0c',
    autoHideMenuBar: true,
    show: false,
  });
  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml('start')));
  splash.once('ready-to-show', () => splash.show());
  setTimeout(() => {
    if (splash && !splash.isDestroyed()) {
      splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml('slow')));
    }
  }, 20000);
}

function makeMain() {
  win = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0a0a0c',
    autoHideMenuBar: true,
    title: 'Scriptwriter',
    show: false,
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => {
    win.show();
    if (splash && !splash.isDestroyed()) splash.close();
  });
  win.on('closed', () => (win = null));
}

// --- lifecycle ---------------------------------------------------------

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  killServer();
});

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  const adopted = await adoptExistingServer();
  if (adopted != null) {
    serverPort = adopted;
    makeMain();
    win.loadURL(`http://127.0.0.1:${serverPort}/`);
    return;
  }
  serverPort = await freePort(BASE_PORT);
  if (serverPort == null) {
    const { dialog } = require('electron');
    dialog.showErrorBox('Scriptwriter', 'No free local port (3060-3069). Close other instances and try again.');
    app.quit();
    return;
  }
  startServer();
  makeSplash();
  await waitForServer(serverPort);
  makeMain();
  win.loadURL(`http://127.0.0.1:${serverPort}/`);
});

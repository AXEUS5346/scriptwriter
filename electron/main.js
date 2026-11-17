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

function preflightOnce() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: serverPort, path: '/api/preflight', timeout: 2500 },
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

function waitForServer() {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      const ok = await preflightOnce();
      if (ok) return resolve(ok);
      if (Date.now() - started > PREFLIGHT_TIMEOUT_MS) return resolve(null);
      setTimeout(tick, 500);
    };
    tick();
  });
}

// --- server ------------------------------------------------------------

function startServer() {
  const root = resourceRoot();
  const appRoot = path.join(root, 'app');
  const appEnv = parseEnvFile(path.join(appRoot, '.env.local'));
  const env = {
    ...appEnv,
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(serverPort),
    HOSTNAME: '127.0.0.1',
    CLEAR_MODEL_PATH: path.join(root, 'models', 'clear-studio.onnx'),
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
}

function killServer() {
  if (!serverProc || !serverProc.pid) return;
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
  serverPort = await freePort(BASE_PORT);
  if (serverPort == null) {
    const { dialog } = require('electron');
    dialog.showErrorBox('Scriptwriter', 'No free local port (3060-3069). Close other instances and try again.');
    app.quit();
    return;
  }
  startServer();
  makeSplash();
  await waitForServer();
  makeMain();
  win.loadURL(`http://127.0.0.1:${serverPort}/`);
});

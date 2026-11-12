'use strict';
/*
 * LARP main process.
 *
 * The agent in the middle of the window is the real Claude Code CLI running in
 * a pseudo-terminal: LARP adds nothing to it and takes nothing away. Everything
 * around it is a dashboard that only reads: the session transcript Claude Code
 * writes, `git` state for the folder, and host CPU/memory.
 */
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const pty = require('node-pty');
const { TranscriptWatcher } = require('./lib/transcript');
const { startDemo } = require('./lib/demo');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const argv = process.argv.slice(app.isPackaged ? 1 : 2);
const flag = (name) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagValue = (name) => {
  const f = flag(name);
  return f && f.includes('=') ? f.slice(f.indexOf('=') + 1) : null;
};

// A capture must not depend on the window being in front: Chromium pauses
// painting and throttles timers for covered or background windows.
if (flag('screenshot')) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}

let win = null;
let term = null;
let watcher = null;
let session = null;
let stopDemo = null;
let size = { cols: 100, rows: 30 };
let cfg = { cwd: null, theme: 'signal', view: 'split', scene: 'graph' };
let cfgFile = null;
let shellPath = null;
const claude = { path: null, version: null };

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---------- config ---------- */

function loadCfg() {
  try {
    cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')) };
  } catch {
    /* first launch */
  }
}

function saveCfg() {
  try {
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  } catch {
    /* settings are a convenience; never block on them */
  }
}

/* ---------- locating Claude Code ---------- */

/** Apps started from the macOS/Linux desktop do not inherit the shell's PATH. */
function loginShellPath() {
  if (isWin) return null;
  try {
    const sh = process.env.SHELL || '/bin/bash';
    const out = execFileSync(sh, ['-ilc', 'printf "__LARP__%s__LARP__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = /__LARP__(.*?)__LARP__/s.exec(out);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function findClaude() {
  const home = os.homedir();
  const known = isWin
    ? [path.join(home, '.local', 'bin', 'claude.exe')]
    : [
        path.join(home, '.local', 'bin', 'claude'),
        path.join(home, '.claude', 'local', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
      ];
  for (const p of known) if (fs.existsSync(p)) return p;

  const exts = isWin ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of (shellPath || process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, 'claude' + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const isBatch = (p) => /\.(cmd|bat)$/i.test(p);

function readClaudeVersion() {
  return new Promise((resolve) => {
    if (!claude.path) return resolve(null);
    const batch = isBatch(claude.path);
    execFile(
      batch ? `"${claude.path}"` : claude.path,
      ['--version'],
      { timeout: 8000, windowsHide: true, shell: batch },
      (err, out) => {
        const m = /(\d+\.\d+\.\d+)/.exec(String(out || ''));
        resolve(err || !m ? null : m[1]);
      }
    );
  });
}

const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/* ---------- the session: one pty running the real CLI ---------- */

let outBuf = '';
let outTimer = null;
function queueOutput(data) {
  outBuf += data;
  if (outTimer) return;
  outTimer = setTimeout(() => {
    outTimer = null;
    const s = outBuf;
    outBuf = '';
    send('larp:pty-data', s);
  }, 6);
}

/**
 * Environment for the CLI. Normally the user's own, untouched.
 *
 * The exception: LARP started from inside another Claude Code session (an
 * agent ran `npm start`, or the desktop app's shell did). That parent injects
 * its own session markers, and a CLI that inherits them thinks it is a child of
 * that session — it turns transcript saving off and borrows the parent's auth
 * route. Drop the parent's markers so the CLI starts as the user's own session.
 * Anything the user configured in ~/.claude/settings.json still applies.
 */
function childEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'larp' };
  if (shellPath) env.PATH = shellPath;
  if (env.CLAUDECODE) {
    const hostOwnsAuth = !!env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH;
    for (const k of Object.keys(env)) {
      if (/^(CLAUDECODE$|CLAUDE_PID$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PREVIEW_)/.test(k)) delete env[k];
    }
    if (hostOwnsAuth) delete env.ANTHROPIC_BASE_URL; // the parent host's endpoint, not the user's
  }
  return env;
}

function pushSession() {
  if (session) send('larp:session', { ...session, claudeVersion: claude.version, demo: !!stopDemo });
}

function stopSession() {
  if (watcher) watcher.stop();
  watcher = null;
  if (term) {
    const p = term;
    term = null;
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
}

function startSession(mode) {
  stopSession();
  if (!claude.path) claude.path = findClaude(); // may have been installed since launch

  const cwd = cfg.cwd && isDir(cfg.cwd) ? cfg.cwd : os.homedir();
  cfg.cwd = cwd;
  saveCfg();

  const startedAt = Date.now();
  const id = mode === 'continue' ? null : crypto.randomUUID();
  const env = childEnv();

  let file;
  let args;
  const missing = !claude.path;
  if (missing) {
    file = isWin ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
    args = isWin ? ['-NoLogo'] : ['-l'];
  } else {
    const cliArgs = mode === 'continue' ? ['--continue'] : ['--session-id', id];
    if (isBatch(claude.path)) {
      file = process.env.ComSpec || 'cmd.exe';
      args = ['/d', '/c', claude.path, ...cliArgs];
    } else {
      file = claude.path;
      args = cliArgs;
    }
  }

  session = { key: startedAt, id, mode, cwd, startedAt, missing, status: 'running', transcript: null, pid: null };

  let p;
  try {
    p = pty.spawn(file, args, { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd, env });
  } catch (err) {
    session.status = 'failed';
    pushSession();
    send('larp:pty-data', `\r\n\x1b[31m[larp] could not start ${path.basename(file)}: ${err.message}\x1b[0m\r\n`);
    return;
  }
  term = p;
  session.pid = p.pid;
  pushSession();

  if (missing) {
    send(
      'larp:pty-data',
      '\x1b[1mCLAUDE CODE WAS NOT FOUND ON THIS MACHINE\x1b[0m\r\n\r\n' +
        'LARP is a control room around the real Claude Code CLI, so it needs it installed.\r\n' +
        'Install it in the shell below, sign in once with \x1b[1mclaude\x1b[0m, then press \x1b[1mNEW\x1b[0m:\r\n\r\n' +
        '  Windows       irm https://claude.ai/install.ps1 | iex\r\n' +
        '  macOS/Linux   curl -fsSL https://claude.ai/install.sh | bash\r\n\r\n'
    );
  }

  p.onData((d) => {
    if (term === p) queueOutput(d);
  });
  p.onExit(({ exitCode }) => {
    if (term !== p) return;
    term = null;
    session.status = 'exited';
    session.exitCode = exitCode;
    pushSession();
  });

  if (!missing) {
    watcher = new TranscriptWatcher({
      root: path.join(claudeConfigDir(), 'projects'),
      cwd,
      sessionId: id,
      startedAt,
      onEvents: (events, replay) => send('larp:events', { events, replay }),
      onLink: (file) => {
        if (session && session.key === startedAt) {
          session.transcript = path.basename(file, '.jsonl');
          pushSession();
        }
      },
    });
    watcher.start();
  }
  refreshGit();
}

/* ---------- read-only telemetry: git + host ---------- */

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 3000, windowsHide: true }, (err, out) =>
      resolve(err ? null : String(out).trim())
    );
  });
}

let gitBusy = false;
async function refreshGit() {
  if (!session || gitBusy) return;
  gitBusy = true;
  const cwd = session.cwd;
  try {
    const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') return send('larp:git', { repo: false });
    const [branch, status, remote, last] = await Promise.all([
      git(cwd, ['branch', '--show-current']),
      git(cwd, ['status', '--porcelain']),
      git(cwd, ['remote', 'get-url', 'origin']),
      git(cwd, ['log', '-1', '--format=%h %s']),
    ]);
    send('larp:git', {
      repo: true,
      branch: branch || 'detached',
      dirty: status ? status.split('\n').filter(Boolean).length : 0,
      // Strip scheme and any embedded credentials before the URL reaches the UI.
      remote: remote
        ? remote.replace(/^[a-z+]+:\/\/([^@/]+@)?/i, '').replace(/^git@/, '').replace(/\.git$/, '')
        : null,
      last,
    });
  } finally {
    gitBusy = false;
  }
}

/* ---------- repo map for the 3D graph (names only, read-only) ---------- */

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', '__pycache__',
  'venv', 'Library', 'Temp', 'Logs', 'obj', 'Pods', 'DerivedData',
]);

/**
 * Breadth-first listing of the folder, bounded on every axis so a huge repo or
 * a home directory costs the same as a small one: shallow entries win.
 */
async function scanRepo(root) {
  const MAX_NODES = 320;
  const MAX_PER_DIR = 36;
  const MAX_DEPTH = 4;
  const out = [];
  const queue = [{ dir: root, rel: '', depth: 0 }];
  while (queue.length && out.length < MAX_NODES) {
    const { dir, rel, depth } = queue.shift();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => b.isDirectory() - a.isDirectory() || a.name.localeCompare(b.name));
    let taken = 0;
    for (const e of entries) {
      if (out.length >= MAX_NODES || taken >= MAX_PER_DIR) break;
      const isDirectory = e.isDirectory();
      if (isDirectory ? SKIP_DIRS.has(e.name) || e.name.startsWith('.') : !e.isFile()) continue;
      const p = rel ? rel + '/' + e.name : e.name;
      let size = 0;
      if (!isDirectory) {
        try {
          size = (await fs.promises.stat(path.join(dir, e.name))).size; // drives building height in the city
        } catch {
          /* vanished between listing and stat */
        }
      }
      out.push({ p, d: isDirectory, s: size });
      taken++;
      if (isDirectory && depth < MAX_DEPTH) queue.push({ dir: path.join(dir, e.name), rel: p, depth: depth + 1 });
    }
  }
  return { name: path.basename(root) || root, items: out };
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

let lastCpu = cpuTimes();
function pushHost() {
  const now = cpuTimes();
  const dt = now.total - lastCpu.total;
  const cpu = dt > 0 ? 1 - (now.idle - lastCpu.idle) / dt : 0;
  lastCpu = now;
  send('larp:host', { cpu, mem: 1 - os.freemem() / os.totalmem() });
}

/* ---------- window ---------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1640,
    height: 1020,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: '#050505',
    title: 'LARP / AGENT.CONTROL',
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 12, y: 10 } }
      : { titleBarOverlay: { color: '#050505', symbolColor: '#8a8a8a', height: 34 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: !flag('screenshot'),
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => {
    win = null;
  });
  win.on('focus', () => win.flashFrame(false));
  if (flag('devtools')) win.webContents.openDevTools({ mode: 'detach' });

  // --screenshot=<file.png>: capture the window after a few seconds and quit.
  const shot = flagValue('screenshot');
  if (shot) {
    const delay = Number(flagValue('screenshot-delay')) || 7000;
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.resolve(shot), img.toPNG());
      } finally {
        app.quit();
      }
    }, delay);
  }
}

/* ---------- ipc ---------- */

ipcMain.handle('larp:init', () => ({
  platform: process.platform,
  arch: process.arch,
  appVersion: app.getVersion(),
  theme: cfg.theme,
  view: cfg.view,
  scene: cfg.scene,
  claudeFound: !!claude.path,
  cwd: cfg.cwd && isDir(cfg.cwd) ? cfg.cwd : os.homedir(),
}));

ipcMain.handle('larp:start', (_e, o) => {
  o = o || {};
  if (Number.isInteger(o.cols) && Number.isInteger(o.rows) && o.cols > 1 && o.rows > 1) {
    size = { cols: o.cols, rows: o.rows };
  }
  startSession(o.mode === 'continue' ? 'continue' : 'new');
  if (flag('demo') && !stopDemo) {
    stopDemo = () => {};
    pushSession();
    // the demo plays on the real files of the open folder
    scanRepo(session.cwd).then(({ items }) => {
      const files = items.filter((i) => !i.d).map((i) => i.p);
      stopDemo = startDemo((events) => send('larp:events', { events, replay: false }), files);
    });
  }
});

ipcMain.handle('larp:open-repo', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open a project folder',
    defaultPath: cfg.cwd || os.homedir(),
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  cfg.cwd = r.filePaths[0];
  startSession('new');
  return cfg.cwd;
});

ipcMain.on('larp:write', (_e, data) => {
  if (term && typeof data === 'string') term.write(data);
});

ipcMain.on('larp:resize', (_e, s) => {
  if (!s || !Number.isInteger(s.cols) || !Number.isInteger(s.rows) || s.cols < 2 || s.rows < 2) return;
  size = { cols: s.cols, rows: s.rows };
  if (term) {
    try {
      term.resize(s.cols, s.rows);
    } catch {
      /* the pty exited between the check and the call */
    }
  }
});

ipcMain.on('larp:theme', (_e, t) => {
  if (!t || typeof t.name !== 'string') return;
  cfg.theme = t.name.slice(0, 24);
  saveCfg();
  if (!isMac && win && /^#[0-9a-f]{6}$/i.test(t.bg) && /^#[0-9a-f]{6}$/i.test(t.fg)) {
    try {
      win.setTitleBarOverlay({ color: t.bg, symbolColor: t.fg, height: 34 });
    } catch {
      /* not supported on this window manager */
    }
  }
});

ipcMain.on('larp:view', (_e, v) => {
  if (['term', 'split', 'graph'].includes(v)) {
    cfg.view = v;
    saveCfg();
  }
});

ipcMain.on('larp:scene', (_e, v) => {
  if (['graph', 'city', 'helix', 'orbit'].includes(v)) {
    cfg.scene = v;
    saveCfg();
  }
});

ipcMain.handle('larp:scan', () => scanRepo(session ? session.cwd : cfg.cwd || os.homedir()));

// Taskbar feedback for the request in flight: 'busy' = working (indeterminate),
// a 0..1 number = plan progress, 'done' = finished (flash if LARP is not in front).
ipcMain.on('larp:progress', (_e, p) => {
  if (!win || win.isDestroyed()) return;
  if (p === 'busy') win.setProgressBar(2);
  else if (typeof p === 'number' && p > 0 && p <= 1) win.setProgressBar(p);
  else {
    win.setProgressBar(-1);
    if (p === 'done' && !win.isFocused()) win.flashFrame(true);
  }
});

ipcMain.on('larp:clipboard-write', (_e, text) => clipboard.writeText(String(text || '')));

ipcMain.on('larp:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

/* ---------- lifecycle ---------- */

app.whenReady().then(() => {
  cfgFile = path.join(app.getPath('userData'), 'config.json');
  loadCfg();
  const argDir = argv.find((a) => !a.startsWith('-') && a !== '.' && isDir(a));
  if (argDir) cfg.cwd = path.resolve(argDir);
  if (flagValue('theme')) cfg.theme = flagValue('theme');
  if (flagValue('view')) cfg.view = flagValue('view');
  if (flagValue('scene')) cfg.scene = flagValue('scene');

  shellPath = loginShellPath();
  claude.path = findClaude();

  if (!isMac) Menu.setApplicationMenu(null);
  createWindow();
  // `claude --version` can take seconds on a cold start: never hold the window for it.
  readClaudeVersion().then((v) => {
    claude.version = v;
    pushSession();
  });
  setInterval(pushHost, 1000);
  setInterval(refreshGit, 5000);
});

// Quit paths differ per platform (close button, Cmd+Q, app.quit()), so the CLI
// is stopped on both: it must never outlive the window.
app.on('before-quit', () => {
  if (stopDemo) stopDemo();
  stopSession();
});

app.on('window-all-closed', () => app.quit());

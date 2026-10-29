#!/usr/bin/env node
'use strict';
// Soflution MCP supervisor: keeps the server up to date without restarting Claude or Cursor.
//
// Same model as McpHub. The MCP client (Claude, Cursor...) talks to this small process, which
// stays connected; the real server runs behind it as a child process. In the background the
// supervisor asks npm for the latest version and installs it next to the current one, in
// ~/.soflution/mcp/<package>/<version> (npm checks the package integrity). As soon as no request
// is in flight, it starts the new version, replays the MCP handshake to it, switches over and
// tells the client the tool list may have changed. If the new version fails to start, the
// current one keeps running and that version is never picked automatically again on this machine.
//
// Network: one GET to registry.npmjs.org at start-up and every 6 hours. Nothing else is sent.
// NO_UPDATE_NOTIFIER=1 or SOFLUTION_AUTO_UPDATE=0: no check, no install, no switch.
// Modes that are not MCP over stdio (setup, --http, --dashboard...) run the server directly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'update.json'), 'utf8')); // { package, server, passthrough }
const OWN_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const OFF = Boolean(process.env.NO_UPDATE_NOTIFIER) || process.env.SOFLUTION_AUTO_UPDATE === '0' || Boolean(process.env.CI);
const HOME = path.join(os.homedir(), '.soflution', 'mcp', cfg.package);
const STATE = path.join(HOME, 'state.json');
const CHECK_EVERY_MS = 6 * 3600 * 1000;
const HEALTHY_AFTER_MS = 120 * 1000;
const MAX_BOOTS = 3;
const SWAP_ID = '__soflution_swap__';

const log = (m) => process.stderr.write(`[${cfg.package} supervisor] ${m}\n`);

// ---------- versions and state ----------

function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function isNewer(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return { installed: s.installed || null, rejected: Array.isArray(s.rejected) ? s.rejected : [], boots: s.boots | 0, healthy: !!s.healthy };
  } catch {
    return { installed: null, rejected: [], boots: 0, healthy: false };
  }
}
function writeState(s) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    const tmp = `${STATE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, STATE);
  } catch (e) {
    log(`state not saved: ${e.message}`);
  }
}
function reject(version) {
  const s = readState();
  if (!s.rejected.includes(version)) s.rejected.push(version);
  if (s.installed && s.installed.version === version) s.installed = null;
  s.boots = 0;
  s.healthy = false;
  writeState(s);
}

const serverIn = (dir) => path.join(dir, 'node_modules', cfg.package, cfg.server);
const OWN = { version: OWN_VERSION, entry: path.join(ROOT, cfg.server) };

/** The version to start with: an installed update newer than this package, unless it keeps crashing. */
function pickStart() {
  if (OFF) return OWN;
  const s = readState();
  const inst = s.installed;
  if (!inst || !isNewer(inst.version, OWN_VERSION) || s.rejected.includes(inst.version) || !fs.existsSync(serverIn(inst.dir))) return OWN;
  if (!s.healthy && s.boots >= MAX_BOOTS) {
    log(`${inst.version} failed to start ${s.boots} times, back to ${OWN_VERSION}`);
    reject(inst.version);
    return OWN;
  }
  if (!s.healthy) {
    s.boots += 1;
    writeState(s);
  }
  return { version: inst.version, entry: serverIn(inst.dir) };
}

// ---------- passthrough modes ----------

const args = process.argv.slice(2);
if (args.some((a) => (cfg.passthrough || []).includes(a))) {
  const target = pickStart();
  process.argv[1] = target.entry;
  import(pathToFileURL(target.entry).href).catch((e) => {
    log(e && e.stack ? e.stack : String(e));
    process.exit(1);
  });
  return;
}

// ---------- line framing ----------

function lines(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
}
function tryJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
const idKey = (id) => JSON.stringify(id);
const toClient = (line) => process.stdout.write(line + '\n');

// ---------- supervision ----------

let current = null; // { child, version, entry, onLine }
let swapping = false;
let shuttingDown = false;
const queue = []; // client lines held during a switch
const clientPending = new Set(); // requests from the client awaiting the server's answer
const serverPending = new Map(); // requests from the server awaiting the client's answer, with their time
let initRequest = null; // the client's initialize request, replayed to a new version
let initAnswered = false;
let initializedSeen = false;
let lastActivity = Date.now();

function start(target) {
  const child = spawn(process.execPath, [target.entry, ...args], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, SOFLUTION_SUPERVISED: '1' },
    windowsHide: true,
  });
  const proc = { child, version: target.version, entry: target.entry, startedAt: Date.now(), handler: null };
  lines(child.stdout, (line) => proc.handler && proc.handler(line));
  child.stdin.on('error', () => {});
  return proc;
}

function attach(proc) {
  current = proc;
  proc.handler = (line) => {
    lastActivity = Date.now();
    const msg = tryJson(line);
    if (msg && msg.id !== undefined && msg.method === undefined) {
      clientPending.delete(idKey(msg.id));
      if (initRequest && idKey(msg.id) === idKey(initRequest.id)) initAnswered = true;
    } else if (msg && msg.id !== undefined && msg.method !== undefined) {
      serverPending.set(idKey(msg.id), Date.now());
    }
    toClient(line);
  };
  proc.child.on('exit', (code, signal) => onExit(proc, code, signal));
}

function onExit(proc, code, signal) {
  if (proc !== current || shuttingDown) return;
  const early = Date.now() - proc.startedAt < 30 * 1000;
  if (early && proc.version !== OWN_VERSION) {
    log(`${proc.version} stopped at start-up (${signal || code}), back to ${OWN_VERSION}`);
    reject(proc.version);
    swapping = true; // hold client messages until the bundled version is up
    clientPending.clear();
    serverPending.clear();
    const next = start(OWN);
    replayInit(next).then(() => {
      attach(next);
      swapping = false;
      flush();
    }).catch((e) => {
      log(`restart failed: ${e.message}`);
      process.exit(1);
    });
    return;
  }
  process.exit(code === null ? 1 : code);
}

/** Replays the client's handshake to a freshly started server. */
function replayInit(proc) {
  return new Promise((resolve, reject) => {
    if (!initRequest) return resolve();
    // If the client is still waiting for its own initialize answer, the new server gives it.
    const ownAnswer = !initAnswered;
    const id = ownAnswer ? initRequest.id : SWAP_ID;
    const timer = setTimeout(() => reject(new Error('no answer to initialize')), 30 * 1000);
    proc.handler = (line) => {
      const msg = tryJson(line);
      if (msg && msg.id !== undefined && idKey(msg.id) === idKey(id) && msg.method === undefined) {
        clearTimeout(timer);
        if (msg.error) return reject(new Error(msg.error.message || 'initialize failed'));
        if (ownAnswer) {
          initAnswered = true;
          clientPending.delete(idKey(initRequest.id));
          toClient(line);
        }
        if (initializedSeen) proc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        return resolve();
      }
      // Anything else before the handshake completes (logs) goes to the client as usual.
      toClient(line);
    };
    proc.child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('stopped during initialize'));
    });
    proc.child.stdin.write(JSON.stringify({ ...initRequest, id }) + '\n');
  });
}

function flush() {
  while (queue.length && !swapping) send(queue.shift());
}

function send(line) {
  const msg = tryJson(line);
  if (msg) {
    if (msg.method === 'initialize' && msg.id !== undefined) {
      initRequest = msg;
      initAnswered = false;
    }
    if (msg.method === 'notifications/initialized') initializedSeen = true;
    if (msg.id !== undefined && msg.method !== undefined) clientPending.add(idKey(msg.id));
    if (msg.id !== undefined && msg.method === undefined) serverPending.delete(idKey(msg.id));
  }
  current.child.stdin.write(line + '\n');
}

lines(process.stdin, (line) => {
  lastActivity = Date.now();
  if (swapping) queue.push(line);
  else send(line);
});

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (current) {
    // Let the server answer what it already received, as when it runs without the supervisor.
    const child = current.child;
    try { child.stdin.end(); } catch {}
    child.once('exit', () => process.exit(code));
    setTimeout(() => child.kill('SIGTERM'), 3000).unref();
    setTimeout(() => process.exit(code), 6000).unref();
  } else {
    process.exit(code);
  }
}
process.stdin.on('end', () => shutdown(0));
process.stdin.on('close', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// ---------- hot switch ----------

async function switchTo(target) {
  if (swapping || !current || current.version === target.version) return;
  swapping = true;
  log(`switching from ${current.version} to ${target.version}`);
  const next = start(target);
  try {
    await replayInit(next);
  } catch (e) {
    log(`${target.version} did not start (${e.message}), staying on ${current.version}`);
    reject(target.version);
    next.child.kill('SIGKILL');
    swapping = false;
    flush();
    return;
  }
  const old = current;
  attach(next);
  swapping = false;
  try { old.child.stdin.end(); } catch {}
  old.child.kill('SIGTERM');
  setTimeout(() => { try { old.child.kill('SIGKILL'); } catch {} }, 5000).unref();
  if (initializedSeen) toClient(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
  flush();
  setTimeout(() => {
    const s = readState();
    if (s.installed && s.installed.version === target.version) {
      s.healthy = true;
      s.boots = 0;
      writeState(s);
    }
  }, HEALTHY_AFTER_MS).unref();
  log(`now running ${target.version}`);
}

function switchWhenIdle(target) {
  let quiet = 0;
  const t = setInterval(() => {
    // A server request the client never answers (unsupported by that client) stops counting after a minute.
    for (const [k, t0] of serverPending) if (Date.now() - t0 > 60 * 1000) serverPending.delete(k);
    const idle = clientPending.size === 0 && serverPending.size === 0 && !swapping && Date.now() - lastActivity > 2000;
    quiet = idle ? quiet + 1 : 0;
    if (quiet >= 2) {
      clearInterval(t);
      switchTo(target);
    }
  }, 1000);
  t.unref();
}

// ---------- background install ----------

function findNpm() {
  const win = process.platform === 'win32';
  const name = win ? 'npm.cmd' : 'npm';
  const dirs = [path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter)];
  if (!win) dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

function lock() {
  const file = path.join(HOME, 'install.lock');
  try {
    fs.mkdirSync(HOME, { recursive: true });
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > 15 * 60 * 1000) fs.unlinkSync(file);
    } catch {}
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return () => { try { fs.unlinkSync(file); } catch {} };
  } catch {
    return null; // another instance is installing
  }
}

function cleanup(keep) {
  try {
    for (const name of fs.readdirSync(HOME)) {
      const p = path.join(HOME, name);
      if (parse(name) && !keep.includes(name) && fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {}
}

async function checkForUpdate() {
  let latest;
  try {
    const res = await fetch(`${process.env.SOFLUTION_REGISTRY || 'https://registry.npmjs.org'}/${encodeURIComponent(cfg.package)}/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    latest = (await res.json()).version;
  } catch {
    return; // offline
  }
  if (!current || !isNewer(latest, current.version)) return;
  const s = readState();
  if (s.rejected.includes(latest)) return;

  // Already installed by another instance: just switch.
  if (s.installed && s.installed.version === latest && fs.existsSync(serverIn(s.installed.dir))) {
    switchWhenIdle({ version: latest, entry: serverIn(s.installed.dir) });
    return;
  }
  const npm = findNpm();
  if (!npm) {
    log(`${latest} is available, but npm was not found to install it`);
    return;
  }
  const unlock = lock();
  if (!unlock) return;
  const dir = path.join(HOME, latest);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  log(`installing ${latest} in the background`);
  const env = { ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH || ''].join(path.delimiter) };
  await new Promise((resolve) => {
    const child = spawn(npm, ['install', '--prefix', dir, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', `${cfg.package}@${latest}`], {
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    child.on('error', (e) => {
      unlock();
      log(`install failed: ${e.message}`);
      resolve();
    });
    child.on('exit', (code) => {
      unlock();
      if (code !== 0 || !fs.existsSync(serverIn(dir))) {
        log(`install of ${latest} failed (npm exit ${code}), retried at the next check`);
        fs.rmSync(dir, { recursive: true, force: true });
        return resolve();
      }
      const st = readState();
      st.installed = { version: latest, dir };
      st.healthy = false;
      st.boots = 0;
      writeState(st);
      cleanup([latest, current ? current.version : '']);
      log(`${latest} installed`);
      switchWhenIdle({ version: latest, entry: serverIn(dir) });
      resolve();
    });
  });
}

// ---------- go ----------

const first = start(pickStart());
attach(first);
if (first.version !== OWN_VERSION) {
  setTimeout(() => {
    const s = readState();
    if (s.installed && s.installed.version === first.version && current === first) {
      s.healthy = true;
      s.boots = 0;
      writeState(s);
    }
  }, HEALTHY_AFTER_MS).unref();
}
if (!OFF) {
  const run = () => checkForUpdate().catch((e) => log(`update check failed: ${e.message}`));
  setTimeout(run, Number(process.env.SOFLUTION_FIRST_CHECK_MS) || 10 * 1000).unref();
  setInterval(run, CHECK_EVERY_MS).unref();
}

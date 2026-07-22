'use strict';
// Shared plumbing for every hook script: read stdin, honor the kill switch,
// write the durable local log, and best-effort notify the dashboard server.
// Every exported helper is designed to never throw past its caller and to
// resolve quickly — hooks must not slow Claude Code down, even when the
// dashboard is unreachable or misconfigured.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const PORT = parseInt(process.env.ATTENTION_ROUTER_PORT || '4123', 10);
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..', '..');
const RUNTIME_DIR = path.join(os.homedir(), '.attention-router');
const PIDFILE = path.join(RUNTIME_DIR, 'server.pid');

function attentionDir(cwd) {
  return path.join(cwd, '.claude', 'attention');
}

function isEnabled(cwd) {
  if (process.env.ATTENTION_ROUTER === 'off') return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(attentionDir(cwd), 'config.json'), 'utf8'));
    if (cfg.enabled === false) return false;
  } catch {
    // no config file, or unreadable — default enabled
  }
  return true;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function appendEventLocal(cwd, envelope) {
  try {
    const dir = attentionDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(envelope) + '\n');
  } catch {
    // durability best-effort only; never let a disk error break the hook
  }
}

function consumeNextDirective(cwd) {
  const file = path.join(attentionDir(cwd), 'inbox.jsonl');
  let entries;
  try {
    entries = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return null;
  }
  const next = entries.find((e) => !e.delivered);
  if (!next) return null;
  next.delivered = true;
  try {
    fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  } catch {
    // if we can't mark it delivered, better to risk redelivery than lose it
  }
  return next.text;
}

function probeServer(timeoutMs = 200) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnDaemon() {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    try {
      const existing = parseInt(fs.readFileSync(PIDFILE, 'utf8'), 10);
      if (existing && pidAlive(existing)) return; // already starting/running
    } catch {
      // no pidfile yet
    }
    const serverEntry = path.join(PLUGIN_ROOT, 'server', 'index.js');
    if (!fs.existsSync(serverEntry)) return;
    const child = spawn(process.execPath, [serverEntry], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    fs.writeFileSync(PIDFILE, String(child.pid));
  } catch {
    // if we can't spawn, the next hook event will try again
  }
}

function postEvent(envelope, timeoutMs = 500) {
  return new Promise((resolve) => {
    const body = JSON.stringify(envelope);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/event',
        method: 'POST',
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

function gitBranch(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim();
  } catch {
    return null;
  }
}

// Wraps a hook's per-event logic with the standard envelope/deliver/exit
// lifecycle. `handler(payload)` may return a plain object to print as the
// hook's JSON stdout (e.g. hookSpecificOutput), or nothing. `augment(payload)`,
// if given, runs first and may mutate payload (e.g. add a git branch) before
// it's captured into the envelope.
async function run(hookEventName, handler, augment) {
  const watchdog = setTimeout(() => process.exit(0), 900);
  watchdog.unref();
  try {
    const raw = await readStdin();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = {};
    }
    const cwd = payload.cwd || process.cwd();
    if (!isEnabled(cwd)) return process.exit(0);
    if (augment) {
      try {
        augment(payload);
      } catch {
        // best-effort enrichment only
      }
    }

    const envelope = { id: crypto.randomUUID(), ts: new Date().toISOString(), event: hookEventName, payload };
    appendEventLocal(cwd, envelope);

    const output = (await handler(payload, envelope)) || {};

    const up = await probeServer(200);
    if (!up) spawnDaemon();
    await postEvent(envelope, 500);

    if (Object.keys(output).length) process.stdout.write(JSON.stringify(output));
    process.exit(0);
  } catch {
    process.exit(0);
  }
}

module.exports = {
  PORT,
  PLUGIN_ROOT,
  attentionDir,
  isEnabled,
  readStdin,
  appendEventLocal,
  consumeNextDirective,
  probeServer,
  spawnDaemon,
  postEvent,
  gitBranch,
  run,
};

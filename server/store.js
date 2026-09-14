'use strict';
// File-backed persistence for one supervised project's attention data.
// Everything lives under <cwd>/.claude/attention/ as plain files:
//   events.jsonl  - append-only log of {id, ts, event, payload}
//   state.json    - last reducer output
//   inbox.jsonl   - directives waiting for hook delivery
//   cursor.json   - {lastAckTs} last-acknowledged event timestamp
//   plan.md       - optional user-authored plan, one task per checkbox line
//   config.json   - optional {enabled:false} kill switch

const fs = require('node:fs');
const path = require('node:path');

function dirFor(cwd) {
  return path.join(cwd, '.claude', 'attention');
}

function ensureDir(cwd) {
  const dir = dirFor(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip a corrupt line rather than fail the whole read
    }
  }
  return out;
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function readEvents(cwd) {
  return readJsonl(path.join(dirFor(cwd), 'events.jsonl'));
}

function appendEvent(cwd, envelope) {
  ensureDir(cwd);
  appendJsonl(path.join(dirFor(cwd), 'events.jsonl'), envelope);
}

function hasEventId(cwd, id) {
  const file = path.join(dirFor(cwd), 'events.jsonl');
  if (!fs.existsSync(file)) return false;
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const tail = lines.slice(-1000);
  for (const line of tail) {
    try {
      const obj = JSON.parse(line);
      if (obj.id === id) return true;
    } catch {
      // skip a corrupt line rather than fail the scan
    }
  }
  return false;
}

function readState(cwd) {
  const file = path.join(dirFor(cwd), 'state.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(cwd, state) {
  ensureDir(cwd);
  const file = path.join(dirFor(cwd), 'state.json');
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function readInbox(cwd) {
  return readJsonl(path.join(dirFor(cwd), 'inbox.jsonl'));
}

function writeInbox(cwd, entries) {
  ensureDir(cwd);
  const file = path.join(dirFor(cwd), 'inbox.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

function appendInbox(cwd, entry) {
  ensureDir(cwd);
  appendJsonl(path.join(dirFor(cwd), 'inbox.jsonl'), entry);
}

function readCursor(cwd) {
  const file = path.join(dirFor(cwd), 'cursor.json');
  if (!fs.existsSync(file)) return { lastAckTs: null };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { lastAckTs: null };
  }
}

function writeCursor(cwd, cursor) {
  ensureDir(cwd);
  fs.writeFileSync(path.join(dirFor(cwd), 'cursor.json'), JSON.stringify(cursor, null, 2));
}

function readPlanFile(cwd) {
  const file = path.join(dirFor(cwd), 'plan.md');
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const tasks = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*-\s*\[( |x|X)\]\s*(.+)$/);
    if (m) tasks.push({ text: m[2].trim(), done: m[1].toLowerCase() === 'x' });
  }
  return tasks;
}

function appendPlanTask(cwd, taskText) {
  ensureDir(cwd);
  const file = path.join(dirFor(cwd), 'plan.md');
  const line = `- [ ] ${taskText}\n`;
  fs.appendFileSync(file, line);
}

function isEnabled(cwd) {
  if (process.env.ATTENTION_ROUTER === 'off') return false;
  const file = path.join(dirFor(cwd), 'config.json');
  if (!fs.existsSync(file)) return true;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cfg.enabled !== false;
  } catch {
    return true;
  }
}

module.exports = {
  dirFor,
  ensureDir,
  readEvents,
  appendEvent,
  hasEventId,
  readState,
  writeState,
  readInbox,
  writeInbox,
  appendInbox,
  readCursor,
  writeCursor,
  readPlanFile,
  appendPlanTask,
  isEnabled,
};

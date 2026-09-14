'use strict';
// Cross-project index of every cwd the server has ever seen an event from,
// plus bounded, depth-1 discovery of likely-supervised projects on disk.
// Persisted at ~/.attention-router/projects.json (ATTENTION_ROUTER_HOME
// overrides the home directory). Never throws: a corrupt or missing index
// file is treated as empty, and every write is atomic (tmp file + rename)
// so a crash mid-write can't leave a half-written index behind.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAX_ROOTS = 8;
const MAX_CHILDREN = 200;

function homeDir() {
  return process.env.ATTENTION_ROUTER_HOME || path.join(os.homedir(), '.attention-router');
}

function indexPath() {
  return path.join(homeDir(), 'projects.json');
}

function emptyIndex() {
  return { version: 1, projects: [] };
}

function read() {
  const file = indexPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return emptyIndex();
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.projects)) return emptyIndex();
    return { version: 1, projects: parsed.projects };
  } catch {
    return emptyIndex();
  }
}

function writeAtomic(data) {
  const file = indexPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function record(cwd, ts = new Date().toISOString()) {
  const data = read();
  let entry = data.projects.find((p) => p.cwd === cwd);
  if (entry) {
    entry.lastSeen = ts;
  } else {
    entry = { cwd, firstSeen: ts, lastSeen: ts };
    data.projects.push(entry);
  }
  writeAtomic(data);
  return entry;
}

function list() {
  return read().projects;
}

function isIndexed(cwd, data) {
  return data.projects.some((p) => p.cwd === cwd);
}

function listChildDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (out.length >= MAX_CHILDREN) break;
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

function eventsLogFor(cwd) {
  return path.join(cwd, '.claude', 'attention', 'events.jsonl');
}

function maybeRecord(cwd, data, added) {
  if (isIndexed(cwd, data)) return;
  const eventsFile = eventsLogFor(cwd);
  let stat;
  try {
    stat = fs.statSync(eventsFile);
  } catch {
    return;
  }
  const ts = stat.mtime.toISOString();
  const entry = { cwd, firstSeen: ts, lastSeen: ts };
  data.projects.push(entry);
  added.push(cwd);
}

// Depth-1 discovery: for each root, check the root itself and each direct
// child directory for .claude/attention/events.jsonl. Never recurses past
// one level. Missing roots are skipped silently.
function discover(opts) {
  const roots = (opts && opts.roots) || [];
  const data = read();
  const added = [];
  const boundedRoots = roots.slice(0, MAX_ROOTS);
  for (const root of boundedRoots) {
    if (!root) continue;
    let stat;
    try {
      stat = fs.statSync(root);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    maybeRecord(root, data, added);

    for (const child of listChildDirs(root)) {
      maybeRecord(child, data, added);
    }
  }
  if (added.length) writeAtomic(data);
  return added;
}

function defaultRoots() {
  const roots = new Set();
  const data = read();
  for (const p of data.projects) {
    roots.add(path.dirname(p.cwd));
  }
  const devDir = path.join(os.homedir(), 'Developer');
  try {
    if (fs.statSync(devDir).isDirectory()) roots.add(devDir);
  } catch {
    // ~/Developer doesn't exist; nothing to add
  }
  const scanDirs = process.env.ATTENTION_ROUTER_SCAN_DIRS;
  if (scanDirs) {
    for (const dir of scanDirs.split(':')) {
      if (dir) roots.add(dir);
    }
  }
  return [...roots];
}

module.exports = {
  indexPath,
  read,
  record,
  list,
  discover,
  defaultRoots,
};

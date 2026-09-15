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

function configPath() {
  return path.join(homeDir(), 'config.json');
}

function expandTilde(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function defaultConfig() {
  return { roots: [path.join(os.homedir(), 'Developer')], recordOutsideRoots: true };
}

// Reads ~/.attention-router/config.json (ATTENTION_ROUTER_HOME overrides the
// home dir). Missing or corrupt file, or a non-object body, falls back to
// defaults. A non-array `roots` falls back to the default roots array only;
// `recordOutsideRoots` is still honoured independently. Never throws.
function readConfig() {
  const file = configPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return defaultConfig();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultConfig();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return defaultConfig();
  }
  const roots = Array.isArray(parsed.roots)
    ? parsed.roots.filter((r) => typeof r === 'string').map(expandTilde)
    : defaultConfig().roots;
  const recordOutsideRoots =
    typeof parsed.recordOutsideRoots === 'boolean' ? parsed.recordOutsideRoots : true;
  return { roots, recordOutsideRoots };
}

// Configured roots merged with the legacy ATTENTION_ROUTER_SCAN_DIRS env var,
// deduped and capped at MAX_ROOTS.
function roots() {
  const cfg = readConfig();
  const set = new Set(cfg.roots);
  const scanDirs = process.env.ATTENTION_ROUTER_SCAN_DIRS;
  if (scanDirs) {
    for (const dir of scanDirs.split(':')) {
      if (dir) set.add(dir);
    }
  }
  return [...set].slice(0, MAX_ROOTS);
}

function hasGitEntry(dir) {
  try {
    fs.statSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

// Direct children of each configured root that look like git repos and
// aren't already indexed. Capped at MAX_CHILDREN per root. An unreadable
// root is skipped silently.
function listCandidates() {
  const data = read();
  const out = [];
  for (const root of roots()) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    let count = 0;
    for (const entry of entries) {
      if (count >= MAX_CHILDREN) break;
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      const cwd = path.join(root, entry.name);
      if (!hasGitEntry(cwd)) continue;
      if (isIndexed(cwd, data)) continue;
      out.push({ cwd });
      count += 1;
    }
  }
  return out;
}

// True if `dir` is strictly inside `ancestor` (not equal to it).
function isStrictlyInside(ancestor, dir) {
  const rel = path.relative(ancestor, dir);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// True if `cwd` is `root` or strictly inside it.
function isUnderRoot(root, cwd) {
  const rel = path.relative(root, cwd);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Gate for record(): rejects the home directory, the filesystem root, any
// strict ancestor of a configured root (so scanning ~/Developer doesn't also
// let ~ itself get recorded), and, when recordOutsideRoots is false,
// anything not under a configured root.
function shouldRecord(cwd) {
  if (!cwd) return false;
  if (cwd === os.homedir()) return false;
  if (cwd === '/') return false;
  const cfg = readConfig();
  for (const root of cfg.roots) {
    if (isStrictlyInside(cwd, root)) return false;
  }
  if (cfg.recordOutsideRoots === false) {
    const underAny = roots().some((root) => isUnderRoot(root, cwd));
    if (!underAny) return false;
  }
  return true;
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
  if (!shouldRecord(cwd)) return null;
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
  if (!shouldRecord(cwd)) return;
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
  const set = new Set();
  const data = read();
  for (const p of data.projects) {
    set.add(path.dirname(p.cwd));
  }
  for (const r of roots()) {
    set.add(r);
  }
  return [...set];
}

module.exports = {
  indexPath,
  read,
  record,
  list,
  discover,
  defaultRoots,
  configPath,
  readConfig,
  roots,
  listCandidates,
  shouldRecord,
};

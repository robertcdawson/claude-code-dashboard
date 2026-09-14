#!/usr/bin/env node
'use strict';
// Attention Router server — single process, no framework, no database.
// Serves the reducer's state over REST + SSE and the static UI.
// Start with: node server/index.js  (default port 4123)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const registry = require('./registry');
const projectsIndex = require('./projects-index');
const git = require('./git');
const overview = require('./overview');

const PORT = parseInt(process.env.ATTENTION_ROUTER_PORT || '4123', 10);
const UI_DIR = path.join(__dirname, '..', 'ui');
const MAX_BODY = 2 * 1024 * 1024; // 2MB, generous for a transcript-free event

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function pickSoleProject(query) {
  if (query.cwd) return query.cwd;
  const all = registry.listProjects();
  return all.length === 1 ? all[0].cwd : null;
}

async function handleEvent(req, res) {
  let envelope;
  try {
    envelope = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'invalid json' });
  }
  const { id, ts, event, payload } = envelope;
  if (!id || !ts || !event || !payload || typeof payload !== 'object') {
    return sendJson(res, 400, { error: 'missing id/ts/event/payload' });
  }
  const cwd = payload.cwd;
  if (!cwd) return sendJson(res, 400, { error: 'payload.cwd is required' });
  if (!store.isEnabled(cwd)) return sendJson(res, 200, { ok: true, disabled: true });

  try {
    projectsIndex.record(cwd);
  } catch {
    // the cross-project index is a convenience, not the source of truth;
    // never let it break event handling
  }

  const state = registry.appendEvent(cwd, envelope);
  registry.broadcast(cwd, state);
  sendJson(res, 200, { ok: true });
}

async function handleAction(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'invalid json' });
  }
  const { type, cwd } = body;
  if (!cwd) return sendJson(res, 400, { error: 'cwd is required' });

  if (type === 'ack') {
    store.writeCursor(cwd, { lastAckTs: new Date().toISOString() });
  } else if (type === 'adopt-task') {
    if (!body.taskText) return sendJson(res, 400, { error: 'taskText is required' });
    store.appendPlanTask(cwd, body.taskText);
  } else if (type === 'directive') {
    if (!body.text) return sendJson(res, 400, { error: 'text is required' });
    store.appendInbox(cwd, { id: crypto.randomUUID(), ts: new Date().toISOString(), text: body.text, delivered: false });
  } else {
    return sendJson(res, 400, { error: `unknown action type: ${type}` });
  }

  const state = registry.recompute(cwd);
  registry.broadcast(cwd, state);
  sendJson(res, 200, { ok: true, state });
}

// Cross-project overview: git.summary() shells out, so we cache results
// per-cwd for a short window rather than re-shelling on every poll of a page
// that may be showing many projects at once. Lives here, not in git.js,
// which stays pure/side-effect-free (see docs/plans/cross-project-overview.md
// decision 9).
const GIT_TTL_MS = 30000;
const gitCache = new Map(); // cwd -> { at, value }

// Runs fn over items with at most `limit` in flight at once, so a large
// project count doesn't spawn dozens of git processes simultaneously.
async function mapWithConcurrency(items, limit, fn) {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(fn));
  }
}

// Refreshes the cache entry for any cwd whose entry is missing or stale,
// running the underlying git spawns concurrently (bounded) rather than the
// serial-per-project sync calls this replaced.
async function refreshGitCache(cwds, now) {
  const stale = cwds.filter((cwd) => {
    const cached = gitCache.get(cwd);
    return !(cached && now - cached.at < GIT_TTL_MS);
  });
  await mapWithConcurrency(stale, 8, async (cwd) => {
    const value = await git.summaryAsync(cwd);
    gitCache.set(cwd, { at: now, value });
  });
}

function cachedGitSummary(cwd) {
  const cached = gitCache.get(cwd);
  return cached
    ? cached.value
    : { isRepo: false, branch: null, changedFiles: 0, lastCommitSubject: null, lastCommitAt: null };
}

function countPendingDirectives(cwd) {
  try {
    const entries = store.readInbox(cwd);
    return entries.filter((e) => !e.delivered).length;
  } catch {
    return 0;
  }
}

async function handleOverview(req, res) {
  const now = Date.now();
  const cwds = new Set();
  for (const p of projectsIndex.list()) cwds.add(p.cwd);
  for (const cwd of registry.projects.keys()) cwds.add(cwd);

  const existing = [...cwds].filter((cwd) => fs.existsSync(cwd));
  await refreshGitCache(existing, now);

  const summaries = [];
  for (const cwd of existing) {
    try {
      const registered = registry.projects.get(cwd);
      const state = registered && registered.state ? registered.state : store.readState(cwd);
      const hydrated = Boolean(state);
      const pendingDirectives = countPendingDirectives(cwd);
      const gitInfo = cachedGitSummary(cwd);
      const label = path.basename(cwd);
      summaries.push(
        overview.summarizeProject(state, gitInfo, { cwd, label, hydrated, pendingDirectives, now })
      );
    } catch {
      // one bad project should never break the whole overview
    }
  }
  sendJson(res, 200, overview.sortSummaries(summaries));
}

function handleState(req, res, query) {
  const cwd = pickSoleProject(query);
  if (!cwd) return sendJson(res, 404, { error: 'no project specified; pass ?cwd= or GET /api/projects' });
  const state = registry.recompute(cwd);
  sendJson(res, 200, state);
}

function handleStream(req, res, query) {
  const cwd = pickSoleProject(query);
  if (!cwd) return sendJson(res, 404, { error: 'no project specified; pass ?cwd=' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const project = registry.getProject(cwd);
  project.clients.add(res);
  const state = registry.recompute(cwd);
  res.write(`data: ${JSON.stringify(state)}\n\n`);
  const keepAlive = setInterval(() => res.write(':keepalive\n\n'), 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    project.clients.delete(res);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const filePath = path.normalize(path.join(UI_DIR, rel));
  if (!filePath.startsWith(UI_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const query = Object.fromEntries(url.searchParams);

  if (url.pathname === '/health') return sendJson(res, 200, { ok: true, pid: process.pid });
  if (req.method === 'POST' && url.pathname === '/event') return handleEvent(req, res).catch((e) => sendJson(res, 500, { error: String(e) }));
  if (req.method === 'POST' && url.pathname === '/action') return handleAction(req, res).catch((e) => sendJson(res, 500, { error: String(e) }));
  if (req.method === 'GET' && url.pathname === '/state') return handleState(req, res, query);
  if (req.method === 'GET' && url.pathname === '/stream') return handleStream(req, res, query);
  if (req.method === 'GET' && url.pathname === '/api/projects') return sendJson(res, 200, registry.listProjects());
  if (req.method === 'GET' && url.pathname === '/api/overview') return handleOverview(req, res).catch((e) => sendJson(res, 500, { error: String(e) }));
  if (req.method === 'GET') return serveStatic(req, res, url.pathname);
  sendJson(res, 405, { error: 'method not allowed' });
});

// Runs a bounded, depth-1 discovery pass over likely project directories and
// records anything found in the cross-project index. Only ever invoked when
// the server is actually started (see the require.main guard below) so that
// requiring this module in tests never touches the filesystem beyond what a
// test explicitly asks for.
function bootstrapProjects() {
  try {
    projectsIndex.discover({ roots: projectsIndex.defaultRoots() });
  } catch {
    // discovery is best-effort; never block startup on it
  }
}

if (require.main === module) {
  bootstrapProjects();
  server.listen(PORT, () => {
    process.stdout.write(`attention-router listening on http://localhost:${PORT}\n`);
  });
}

module.exports = server;
module.exports.bootstrapProjects = bootstrapProjects;

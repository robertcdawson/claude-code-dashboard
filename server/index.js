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
  if (req.method === 'GET') return serveStatic(req, res, url.pathname);
  sendJson(res, 405, { error: 'method not allowed' });
});

if (require.main === module) {
  server.listen(PORT, () => {
    process.stdout.write(`attention-router listening on http://localhost:${PORT}\n`);
  });
}

module.exports = server;

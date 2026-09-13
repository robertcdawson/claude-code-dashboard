'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../server/store.js');
const registry = require('../server/registry.js');

function mkCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ar-registry-'));
}

function eventsFile(cwd) {
  return path.join(store.dirFor(cwd), 'events.jsonl');
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
}

function makeEnvelope(cwd, id) {
  return { id, ts: new Date().toISOString(), event: 'SessionStart', payload: { cwd, session_id: 's1' } };
}

test('appendEvent: same id posted twice writes exactly one line and one in-memory event', (t) => {
  const cwd = mkCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const envelope = makeEnvelope(cwd, 'evt-1');
  registry.appendEvent(cwd, envelope);
  registry.appendEvent(cwd, envelope);

  const lines = readLines(eventsFile(cwd));
  assert.equal(lines.length, 1);

  const project = registry.getProject(cwd);
  assert.equal(project.events.length, 1);
});

test('appendEvent: id already on disk before hydration is not duplicated', (t) => {
  const cwd = mkCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const envelope = makeEnvelope(cwd, 'evt-2');
  store.ensureDir(cwd);
  store.appendEvent(cwd, envelope);

  // First touch of this cwd hydrates the in-memory project from disk.
  registry.appendEvent(cwd, envelope);

  const lines = readLines(eventsFile(cwd));
  assert.equal(lines.length, 1);
});

test('getProject: pre-existing duplicate lines on disk collapse to one in-memory event', (t) => {
  const cwd = mkCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const envelope = makeEnvelope(cwd, 'evt-3');
  store.ensureDir(cwd);
  store.appendEvent(cwd, envelope);
  store.appendEvent(cwd, envelope);

  const lines = readLines(eventsFile(cwd));
  assert.equal(lines.length, 2);

  const project = registry.getProject(cwd);
  assert.equal(project.events.length, 1);
});

test('store.hasEventId: false for missing file, false for unknown id, true for present id', (t) => {
  const cwd = mkCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  assert.equal(store.hasEventId(cwd, 'nope'), false);

  const envelope = makeEnvelope(cwd, 'evt-4');
  store.ensureDir(cwd);
  store.appendEvent(cwd, envelope);

  assert.equal(store.hasEventId(cwd, 'unknown-id'), false);
  assert.equal(store.hasEventId(cwd, 'evt-4'), true);
});

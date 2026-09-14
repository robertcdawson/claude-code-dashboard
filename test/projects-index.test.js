'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let ORIGINAL_HOME;
let TMP_HOME;

test.before(() => {
  ORIGINAL_HOME = process.env.ATTENTION_ROUTER_HOME;
  TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-home-'));
  process.env.ATTENTION_ROUTER_HOME = TMP_HOME;
});

test.after(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  if (ORIGINAL_HOME === undefined) delete process.env.ATTENTION_ROUTER_HOME;
  else process.env.ATTENTION_ROUTER_HOME = ORIGINAL_HOME;
});

// Re-require fresh each time isn't necessary since the module reads
// process.env at call time, not at require time.
const projectsIndex = require('../server/projects-index.js');

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-home-'));
  process.env.ATTENTION_ROUTER_HOME = dir;
  return dir;
}

test('indexPath honors ATTENTION_ROUTER_HOME set at call time', () => {
  const dir = freshHome();
  assert.equal(projectsIndex.indexPath(), path.join(dir, 'projects.json'));
});

test('read() on missing file returns empty index', () => {
  freshHome();
  assert.deepEqual(projectsIndex.read(), { version: 1, projects: [] });
});

test('record() twice updates lastSeen but keeps firstSeen, one entry', () => {
  freshHome();
  const first = projectsIndex.record('/tmp/proj-a', '2026-01-01T00:00:00.000Z');
  assert.equal(first.firstSeen, '2026-01-01T00:00:00.000Z');
  assert.equal(first.lastSeen, '2026-01-01T00:00:00.000Z');

  const second = projectsIndex.record('/tmp/proj-a', '2026-01-02T00:00:00.000Z');
  assert.equal(second.firstSeen, '2026-01-01T00:00:00.000Z');
  assert.equal(second.lastSeen, '2026-01-02T00:00:00.000Z');

  const all = projectsIndex.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].cwd, '/tmp/proj-a');
});

test('corrupt file: read() returns empty without throwing', () => {
  const dir = freshHome();
  fs.writeFileSync(path.join(dir, 'projects.json'), '{ not valid json');
  assert.deepEqual(projectsIndex.read(), { version: 1, projects: [] });
});

test('discover() indexes only a direct child with events.jsonl, not a grandchild', () => {
  freshHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-scan-'));

  const withEvents = path.join(root, 'has-events');
  fs.mkdirSync(path.join(withEvents, '.claude', 'attention'), { recursive: true });
  fs.writeFileSync(path.join(withEvents, '.claude', 'attention', 'events.jsonl'), '{}\n');

  const withoutEvents = path.join(root, 'no-events');
  fs.mkdirSync(withoutEvents, { recursive: true });

  const nested = path.join(root, 'parent', 'grandchild-with-events');
  fs.mkdirSync(path.join(nested, '.claude', 'attention'), { recursive: true });
  fs.writeFileSync(path.join(nested, '.claude', 'attention', 'events.jsonl'), '{}\n');

  const added = projectsIndex.discover({ roots: [root] });

  assert.deepEqual(added, [withEvents]);
  const cwds = projectsIndex.list().map((p) => p.cwd);
  assert.ok(cwds.includes(withEvents));
  assert.ok(!cwds.includes(withoutEvents));
  assert.ok(!cwds.includes(nested));

  fs.rmSync(root, { recursive: true, force: true });
});

test('discover() with a missing root does not throw', () => {
  freshHome();
  assert.doesNotThrow(() => {
    const added = projectsIndex.discover({ roots: ['/definitely/does/not/exist/anywhere'] });
    assert.deepEqual(added, []);
  });
});

test('atomic write leaves no .tmp file behind', () => {
  const dir = freshHome();
  projectsIndex.record('/tmp/proj-b');
  const files = fs.readdirSync(dir);
  assert.ok(!files.some((f) => f.endsWith('.tmp')));
  assert.ok(files.includes('projects.json'));
});

test('discover() also checks the root itself for events.jsonl', () => {
  freshHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-scan-root-'));
  fs.mkdirSync(path.join(root, '.claude', 'attention'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'attention', 'events.jsonl'), '{}\n');

  const added = projectsIndex.discover({ roots: [root] });
  assert.deepEqual(added, [root]);

  fs.rmSync(root, { recursive: true, force: true });
});

test('defaultRoots includes parent dirs of indexed cwds and dedupes', () => {
  freshHome();
  projectsIndex.record('/tmp/some/nested/proj-a');
  projectsIndex.record('/tmp/some/nested/proj-b');
  const roots = projectsIndex.defaultRoots();
  const uniqueRoots = new Set(roots);
  assert.equal(roots.length, uniqueRoots.size);
  assert.ok(roots.includes('/tmp/some/nested'));
});

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

test('configPath honors ATTENTION_ROUTER_HOME set at call time', () => {
  const dir = freshHome();
  assert.equal(projectsIndex.configPath(), path.join(dir, 'config.json'));
});

test('readConfig() returns default roots when config file is missing', () => {
  freshHome();
  const cfg = projectsIndex.readConfig();
  assert.deepEqual(cfg, {
    roots: [path.join(os.homedir(), 'Developer')],
    recordOutsideRoots: true,
  });
});

test('readConfig() returns defaults on corrupt json without throwing', () => {
  const dir = freshHome();
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not valid json');
  assert.doesNotThrow(() => projectsIndex.readConfig());
  const cfg = projectsIndex.readConfig();
  assert.deepEqual(cfg, {
    roots: [path.join(os.homedir(), 'Developer')],
    recordOutsideRoots: true,
  });
});

test('readConfig() expands a leading ~ in roots', () => {
  const dir = freshHome();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ roots: ['~/Projects'] }));
  const cfg = projectsIndex.readConfig();
  assert.deepEqual(cfg.roots, [path.join(os.homedir(), 'Projects')]);
});

test('readConfig() with non-array roots falls back to default roots', () => {
  const dir = freshHome();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ roots: 'not-an-array' }));
  const cfg = projectsIndex.readConfig();
  assert.deepEqual(cfg.roots, [path.join(os.homedir(), 'Developer')]);
});

test('listCandidates() returns only direct git-repo children not already indexed', () => {
  const dir = freshHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cand-'));
  fs.mkdirSync(path.join(root, 'repo-a', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plain-dir'), { recursive: true });
  fs.mkdirSync(path.join(root, 'repo-b', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'parent', 'grandchild-repo', '.git'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ roots: [root] }));

  // Pre-index repo-b so listCandidates() must exclude it.
  const recorded = projectsIndex.record(path.join(root, 'repo-b'));
  assert.notEqual(recorded, null);

  const candidates = projectsIndex.listCandidates().map((c) => c.cwd);
  assert.deepEqual(candidates, [path.join(root, 'repo-a')]);

  fs.rmSync(root, { recursive: true, force: true });
});

test('record(os.homedir()) is a no-op', () => {
  const dir = freshHome();
  const result = projectsIndex.record(os.homedir());
  assert.equal(result, null);
  assert.equal(fs.existsSync(path.join(dir, 'projects.json')), false);
});

test('record() rejects a strict ancestor of a configured root', () => {
  const dir = freshHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-anc-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ roots: [root] }));
  const parent = path.dirname(root);

  const result = projectsIndex.record(parent);
  assert.equal(result, null);
  const cwds = projectsIndex.list().map((p) => p.cwd);
  assert.ok(!cwds.includes(parent));

  fs.rmSync(root, { recursive: true, force: true });
});

test('record() with recordOutsideRoots:false rejects a cwd outside configured roots', () => {
  const dir = freshHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-out-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-outside-'));
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ roots: [root], recordOutsideRoots: false })
  );

  const rejected = projectsIndex.record(outside);
  assert.equal(rejected, null);

  const accepted = projectsIndex.record(path.join(root, 'proj'));
  assert.notEqual(accepted, null);

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('shouldRecord(os.homedir()) is false', () => {
  freshHome();
  assert.equal(projectsIndex.shouldRecord(os.homedir()), false);
});

test('discover() applies shouldRecord: a matching cwd outside the configured root is dropped when recordOutsideRoots is false', () => {
  const dir = freshHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-disc-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-disc-outside-'));

  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ roots: [root], recordOutsideRoots: false })
  );

  // A project under the configured root: should be discovered.
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(proj, '.claude', 'attention'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'attention', 'events.jsonl'), '{}\n');

  // A cwd with a matching events.jsonl but outside any configured root:
  // discover() must not record it even though it matches the events-file
  // heuristic, because shouldRecord() rejects it.
  fs.mkdirSync(path.join(outside, '.claude', 'attention'), { recursive: true });
  fs.writeFileSync(path.join(outside, '.claude', 'attention', 'events.jsonl'), '{}\n');

  const added = projectsIndex.discover({ roots: [root, outside] });

  assert.deepEqual(added, [proj]);
  const cwds = projectsIndex.list().map((p) => p.cwd);
  assert.ok(cwds.includes(proj));
  assert.ok(!cwds.includes(outside));

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('discover() never records os.homedir() even when it has a matching events.jsonl', () => {
  freshHome();
  const home = os.homedir();
  const homeEventsFile = path.join(home, '.claude', 'attention', 'events.jsonl');

  // Only meaningful to assert on machines where this heuristic file exists;
  // otherwise discover() would skip the home dir for an unrelated reason
  // (no events.jsonl) and the test wouldn't exercise the shouldRecord path.
  if (fs.existsSync(homeEventsFile)) {
    const added = projectsIndex.discover({ roots: [home] });
    assert.ok(!added.includes(home));
    const cwds = projectsIndex.list().map((p) => p.cwd);
    assert.ok(!cwds.includes(home));
  }
});

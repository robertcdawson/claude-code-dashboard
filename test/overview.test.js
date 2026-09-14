'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { summarizeProject, sortSummaries, STALE_DAYS } = require('../server/overview');

const BASE_TS = '2026-01-01T12:00:00.000Z';
const BASE_MS = Date.parse(BASE_TS);
const TEN_MIN = 10 * 60 * 1000;
const SEVEN_DAYS = STALE_DAYS * 24 * 60 * 60 * 1000;

// Five inline fixture states, shaped like server/reducer.js output.

const STATE_WORKING = {
  status: 'working',
  updatedAt: BASE_TS,
  now: { goal: 'Ship the sync feature', doing: 'Editing worker.js' },
  plan: {
    tasks: [
      { text: 'Task A', status: 'done', extra: false },
      { text: 'Task B', status: 'todo', extra: false },
      { text: 'Task C', status: 'run', extra: false },
      { text: 'Task D', status: 'todo', extra: false },
      { text: 'Task E', status: 'todo', extra: false },
      { text: 'Extra task', status: 'todo', extra: true },
    ],
    doneCount: 1,
    totalCount: 5,
  },
  attention: { unseenCount: 1, needsYou: false },
};

const STATE_NEEDS_YOU = {
  status: 'needs_you',
  updatedAt: BASE_TS,
  now: { goal: 'Fix the flaky test', doing: null },
  plan: { tasks: [], doneCount: 0, totalCount: 0 },
  attention: { unseenCount: 2, needsYou: true },
};

const STATE_FINISHED = {
  status: 'finished',
  updatedAt: BASE_TS,
  now: { goal: 'Untitled task', doing: null },
  plan: { tasks: [], doneCount: 0, totalCount: 0 },
  attention: { unseenCount: 0, needsYou: false },
};

const STATE_NOPLAN = {
  status: 'idle',
  updatedAt: BASE_TS,
  now: { goal: 'Explore the codebase', doing: null },
  plan: { tasks: [], doneCount: 0, totalCount: 0 },
  attention: { unseenCount: 0, needsYou: false },
};

const STATE_BOUNDARY = {
  status: 'working',
  updatedAt: BASE_TS,
  now: { goal: 'Long running task', doing: 'Running tests' },
  plan: { tasks: [], doneCount: 0, totalCount: 0 },
  attention: { unseenCount: 0, needsYou: false },
};

const GIT_CLEAN = { isRepo: true, branch: 'main', changedFiles: 0, lastCommitSubject: 'Initial', lastCommitAt: BASE_TS };
const GIT_DIRTY = { isRepo: true, branch: 'main', changedFiles: 3, lastCommitSubject: 'wip', lastCommitAt: BASE_TS };

function extras(overrides) {
  return { cwd: '/proj/demo', hydrated: true, pendingDirectives: 0, now: BASE_MS, ...overrides };
}

describe('overview: status re-derivation at the 10-minute boundary', () => {
  test('just over 10 minutes idle flips working to stale', () => {
    const s = summarizeProject(STATE_BOUNDARY, GIT_CLEAN, extras({ now: BASE_MS + TEN_MIN + 1 }));
    assert.equal(s.status, 'stale');
  });

  test('just under 10 minutes idle stays working', () => {
    const s = summarizeProject(STATE_BOUNDARY, GIT_CLEAN, extras({ now: BASE_MS + TEN_MIN - 1 }));
    assert.equal(s.status, 'working');
  });
});

describe('overview: status re-derivation at the 7-day boundary', () => {
  test('just over 7 days flips to idle and flags stale', () => {
    const s = summarizeProject(STATE_BOUNDARY, GIT_CLEAN, extras({ now: BASE_MS + SEVEN_DAYS + 1 }));
    assert.equal(s.status, 'idle');
    assert.equal(s.flags.stale, true);
  });

  test('just under 7 days does not set flags.stale', () => {
    const s = summarizeProject(STATE_BOUNDARY, GIT_CLEAN, extras({ now: BASE_MS + SEVEN_DAYS - 1 }));
    assert.notEqual(s.status, 'idle');
    assert.equal(s.flags.stale, false);
  });
});

describe('overview: needs_you goes stale after 10 minutes', () => {
  test('needs_you older than 10 minutes re-derives to stale', () => {
    const s = summarizeProject(STATE_NEEDS_YOU, GIT_CLEAN, extras({ now: BASE_MS + TEN_MIN + 1 }));
    assert.equal(s.status, 'stale');
  });
});

describe('overview: finished status', () => {
  test('finished within 7 days stays finished', () => {
    const s = summarizeProject(STATE_FINISHED, GIT_CLEAN, extras({ now: BASE_MS + 24 * 60 * 60 * 1000 }));
    assert.equal(s.status, 'finished');
  });

  test("'Untitled task' goal is reported as null", () => {
    const s = summarizeProject(STATE_FINISHED, GIT_CLEAN, extras());
    assert.equal(s.goal, null);
  });
});

describe('overview: plan summary', () => {
  test('no plan tasks means hasPlan is false and openTasks is empty', () => {
    const s = summarizeProject(STATE_NOPLAN, GIT_CLEAN, extras());
    assert.equal(s.plan.hasPlan, false);
    assert.deepEqual(s.plan.openTasks, []);
    assert.equal(s.plan.openCount, 0);
  });

  test('openTasks excludes done/extra and is capped at 3', () => {
    const s = summarizeProject(STATE_WORKING, GIT_CLEAN, extras());
    assert.equal(s.plan.openCount, 4);
    assert.deepEqual(s.plan.openTasks, ['Task B', 'Task C', 'Task D']);
  });
});

describe('overview: leftDirty flag', () => {
  test('finished with a dirty tree is leftDirty', () => {
    const s = summarizeProject(STATE_FINISHED, GIT_DIRTY, extras({ now: BASE_MS + 60 * 1000 }));
    assert.equal(s.status, 'finished');
    assert.equal(s.flags.leftDirty, true);
  });

  test('working with a dirty tree is not leftDirty', () => {
    const s = summarizeProject(STATE_WORKING, GIT_DIRTY, extras({ now: BASE_MS + 60 * 1000 }));
    assert.equal(s.status, 'working');
    assert.equal(s.flags.leftDirty, false);
  });
});

describe('overview: un-hydrated / missing state', () => {
  test('null state (not hydrated) reports idle status, null goal, but real git info', () => {
    const s = summarizeProject(null, GIT_CLEAN, extras({ cwd: '/proj/none', hydrated: false }));
    assert.equal(s.status, 'idle');
    assert.equal(s.goal, null);
    assert.equal(s.hydrated, false);
    assert.deepEqual(s.git, GIT_CLEAN);
    assert.equal(s.lastActivityAt, null);
  });
});

describe('overview: sortSummaries', () => {
  test('orders needs_you, working, then by recency, stale band mixed in, nulls last, without mutating input', () => {
    const needsYou = summarizeProject(STATE_NEEDS_YOU, GIT_CLEAN, extras({ cwd: '/p/needs-you', now: BASE_MS + 60 * 1000 }));
    const working = summarizeProject(STATE_WORKING, GIT_CLEAN, extras({ cwd: '/p/working', now: BASE_MS + 2 * 60 * 1000 }));
    const recentFinished = summarizeProject(STATE_FINISHED, GIT_CLEAN, extras({ cwd: '/p/recent-finished', now: BASE_MS + 3 * 60 * 1000 }));
    const staleWorking = summarizeProject(
      { ...STATE_BOUNDARY, updatedAt: '2026-01-01T11:40:00.000Z' },
      GIT_CLEAN,
      extras({ cwd: '/p/stale', now: BASE_MS })
    );
    const olderFinished = summarizeProject(
      { ...STATE_FINISHED, updatedAt: '2025-12-31T12:00:00.000Z' },
      GIT_CLEAN,
      extras({ cwd: '/p/older-finished', now: BASE_MS })
    );
    const nullEntry = summarizeProject(null, null, extras({ cwd: '/p/null-entry', hydrated: false }));

    assert.equal(staleWorking.status, 'stale');
    assert.equal(nullEntry.lastActivityAt, null);

    const input = [olderFinished, nullEntry, staleWorking, recentFinished, working, needsYou];
    const inputSnapshot = [...input];
    const sorted = sortSummaries(input);

    assert.notEqual(sorted, input);
    assert.deepEqual(input, inputSnapshot);

    assert.deepEqual(
      sorted.map((s) => s.cwd),
      ['/p/needs-you', '/p/working', '/p/recent-finished', '/p/stale', '/p/older-finished', '/p/null-entry']
    );
  });
});

function httpJson(method, port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers: data ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('GET /api/overview: integration', () => {
  test('returns a card for a freshly-posted project with every contract key present', async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-home-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-overview-project-'));
    process.env.ATTENTION_ROUTER_HOME = home;

    // Require after setting the env var so the projects-index module (read
    // lazily, at call time, not at require time) never touches the real
    // ~/.attention-router. Requiring must not start listening on its own;
    // that's gated by index.js's require.main guard.
    delete require.cache[require.resolve('../server/index')];
    const server = require('../server/index');

    t.after(() => {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
      delete process.env.ATTENTION_ROUTER_HOME;
    });

    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    const envelope = {
      id: 'ov-evt-1',
      ts: new Date().toISOString(),
      event: 'SessionStart',
      payload: { cwd: projectDir, session_id: 'ov-sess-1', model: 'claude-sonnet-5' },
    };
    const posted = await httpJson('POST', port, '/event', envelope);
    assert.equal(posted.status, 200);

    const overviewRes = await httpJson('GET', port, '/api/overview');
    assert.equal(overviewRes.status, 200);
    assert.ok(Array.isArray(overviewRes.body));

    const entry = overviewRes.body.find((p) => p.cwd === projectDir);
    assert.ok(entry, 'expected an overview entry for the posted project');

    const requiredKeys = [
      ['cwd'],
      ['label'],
      ['status'],
      ['hydrated'],
      ['lastActivityAt'],
      ['goal'],
      ['now', 'doing'],
      ['now', 'doneCount'],
      ['now', 'totalCount'],
      ['plan', 'hasPlan'],
      ['plan', 'openCount'],
      ['plan', 'openTasks'],
      ['attention', 'unseenCount'],
      ['attention', 'needsYou'],
      ['attention', 'pendingDirectives'],
      ['git', 'isRepo'],
      ['git', 'branch'],
      ['git', 'changedFiles'],
      ['git', 'lastCommitSubject'],
      ['git', 'lastCommitAt'],
      ['flags', 'stale'],
      ['flags', 'leftDirty'],
    ];
    for (const keyPath of requiredKeys) {
      let value = entry;
      for (const key of keyPath) value = value ? value[key] : undefined;
      assert.notStrictEqual(value, undefined, `expected ${keyPath.join('.')} to be defined`);
    }

    assert.equal(entry.hydrated, true);
    assert.equal(entry.git.isRepo, false);
  });
});

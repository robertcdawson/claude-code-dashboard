'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { reduce } = require('../server/reducer');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'events.jsonl');

function loadFixture() {
  return fs
    .readFileSync(FIXTURE_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const GIT_FILES = [
  { path: 'src/migration.js', added: 40, deleted: 5 },
  { path: 'src/worker.js', added: 30, deleted: 0 },
  { path: 'src/adapter.js', added: 90, deleted: 10 },
];

function reduceFixture(events, overrides = {}) {
  return reduce(events, {
    cwd: '/demo/project',
    planFileTasks: [],
    gitFiles: GIT_FILES,
    newDeps: 0,
    cursorTs: null,
    now: Date.parse('2026-01-01T09:30:00.000Z'),
    previousHistory: [],
    ...overrides,
  });
}

describe('reducer: normal run', () => {
  const events = loadFixture();

  test('derives the goal from the first user prompt', () => {
    const state = reduceFixture(events);
    assert.equal(state.now.goal, 'Sync the offline queue with the new worker service');
  });

  test('reads the in-progress step from TodoWrite', () => {
    const state = reduceFixture(events);
    assert.equal(state.now.currentStepText, 'Build the sync worker');
    assert.equal(state.now.stepIndex, 3);
    assert.equal(state.now.stepCount, 4);
  });

  test('plan mirrors TodoWrite status and counts', () => {
    const state = reduceFixture(events);
    assert.equal(state.plan.doneCount, 2);
    assert.equal(state.plan.totalCount, 4);
    const worker = state.plan.tasks.find((t) => t.text === 'Build the sync worker');
    assert.equal(worker.status, 'run');
  });
});

describe('reducer: off-plan work', () => {
  test('flags a changed file with no matching plan task', () => {
    const state = reduceFixture(loadFixture());
    const offPlan = state.health.offPlanWork;
    assert.equal(offPlan.files.length, 1);
    assert.equal(offPlan.files[0].path, 'src/adapter.js');
    // 100 off-plan lines (adapter.js) out of 175 total changed lines
    assert.equal(offPlan.pct, 57);
    assert.equal(offPlan.level, 'attention');
  });

  test('does not flag files that map to an in-progress or done task', () => {
    const state = reduceFixture(loadFixture());
    const paths = state.health.offPlanWork.files.map((f) => f.path);
    assert.ok(!paths.includes('src/migration.js'));
    assert.ok(!paths.includes('src/worker.js'));
  });
});

describe('reducer: rework', () => {
  test('flags a file edited in 3+ separate bursts', () => {
    const state = reduceFixture(loadFixture());
    assert.equal(state.health.rework.max, 3);
    assert.equal(state.health.rework.topFile, 'src/adapter.js');
    assert.equal(state.health.rework.level, 'watch');
  });
});

describe('reducer: tests', () => {
  test('parses pass/fail counts from the latest matching test run', () => {
    const state = reduceFixture(loadFixture());
    assert.equal(state.health.tests.pass, 10);
    assert.equal(state.health.tests.fail, 2);
    assert.equal(state.health.tests.total, 12);
    assert.equal(state.health.tests.level, 'watch');
  });

  test('reports unknown when no test run has happened yet', () => {
    const events = loadFixture().filter((e) => e.payload.tool_name !== 'Bash');
    const state = reduceFixture(events);
    assert.equal(state.health.tests.level, 'unknown');
    assert.equal(state.health.tests.total, null);
  });
});

describe('reducer: notification / needsYou', () => {
  test('sets needsYou and status when Notification is the latest event', () => {
    const state = reduceFixture(loadFixture());
    assert.equal(state.attention.needsYou, true);
    assert.equal(state.status, 'needs_you');
  });

  test('clears needsYou once another event follows', () => {
    const events = loadFixture();
    events.push({
      id: 'e14',
      ts: '2026-01-01T09:21:00.000Z',
      event: 'PostToolUse',
      payload: { cwd: '/demo/project', tool_name: 'Read', tool_input: { file_path: 'src/worker.js' } },
    });
    const state = reduceFixture(events);
    assert.equal(state.attention.needsYou, false);
    assert.equal(state.status, 'working');
  });

  test('without a Notification, status is working', () => {
    const events = loadFixture().slice(0, -1);
    const state = reduceFixture(events);
    assert.equal(state.status, 'working');
    assert.equal(state.attention.needsYou, false);
  });
});

describe('reducer: decisions', () => {
  const events = loadFixture();

  test('extracts and tags decisions from the Stop transcript message', () => {
    const state = reduceFixture(events);
    assert.equal(state.decisions.length, 2);
    const tags = state.decisions.map((d) => d.tag).sort();
    assert.deepEqual(tags, ['Scope', 'Workaround']);
  });

  test('everything is unseen when the cursor has never acked', () => {
    const state = reduceFixture(events, { cursorTs: null });
    assert.equal(state.attention.unseenDecisions, 2);
    assert.equal(state.attention.unseenExtraTasks, 1);
    assert.equal(state.attention.unseenCount, 3);
  });

  test('acking past the decisions clears unseen counts', () => {
    const state = reduceFixture(events, { cursorTs: '2026-01-01T09:16:30.000Z' });
    assert.equal(state.attention.unseenDecisions, 0);
    assert.equal(state.attention.unseenExtraTasks, 0);
    assert.equal(state.attention.unseenCount, 0);
  });

  test('a Scope decision becomes an off-plan plan entry', () => {
    const state = reduceFixture(events);
    const extra = state.plan.tasks.find((t) => t.extra);
    assert.ok(extra, 'expected an extra plan task derived from the Scope decision');
    assert.match(extra.text, /retry queue/);
  });
});

describe('reducer: session scoping', () => {
  test('only reduces events since the latest SessionStart', () => {
    const firstSession = loadFixture().slice(0, 4); // through the first Edit
    const secondSession = [
      { id: 'x1', ts: '2026-01-02T09:00:00.000Z', event: 'SessionStart', payload: { session_id: 'sess-2', cwd: '/demo/project', model: 'claude-sonnet-5' } },
      { id: 'x2', ts: '2026-01-02T09:00:05.000Z', event: 'UserPromptSubmit', payload: { cwd: '/demo/project', prompt: 'A completely different task' } },
    ];
    const state = reduceFixture([...firstSession, ...secondSession]);
    assert.equal(state.sessionId, 'sess-2');
    assert.equal(state.now.goal, 'A completely different task');
    assert.equal(state.plan.totalCount, 0);
  });
});

describe('reducer: SessionEnd', () => {
  test('status is finished once SessionEnd is the latest event', () => {
    const events = [
      ...loadFixture().slice(0, 4),
      { id: 'y1', ts: '2026-01-01T09:30:00.000Z', event: 'SessionEnd', payload: { cwd: '/demo/project', reason: 'other' } },
    ];
    const state = reduceFixture(events);
    assert.equal(state.status, 'finished');
  });
});

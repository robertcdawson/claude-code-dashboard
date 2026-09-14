'use strict';
// events.jsonl -> state.json. Pure function of (events, options) so it's
// unit-testable without a filesystem or a clock: pass `now` explicitly.

const path = require('node:path');
const { extractDecisions } = require('./decisions');

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'with', 'on', 'in', 'at',
  'is', 'are', 'be', 'it', 'this', 'that', 'from', 'by', 'as', 'once', 'new',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function basename(filePath) {
  return path.basename(filePath || '').replace(/\.[^.]+$/, '');
}

function fileTokens(filePath) {
  return tokenize(basename(filePath).replace(/[-_]/g, ' '));
}

// Poor-man's stemming: two tokens "match" if they share a long-enough
// prefix (migration/migrate, queue/queues), not just exact equality.
function tokensMatch(a, b) {
  if (a === b) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 5;
}

function matchesAnyTask(filePath, tasks) {
  const ftoks = fileTokens(filePath);
  if (ftoks.length === 0) return null;
  for (const task of tasks) {
    const ttoks = tokenize(task.text);
    if (ttoks.some((t) => ftoks.some((f) => tokensMatch(t, f)))) return task;
  }
  return null;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TEST_CMD_RE = /\b(vitest|jest|pytest|go test|npm test|npm run test|yarn test|pnpm test)\b/i;

function toolFilePath(payload) {
  const input = payload.tool_input || {};
  return input.file_path || input.path || null;
}

function lastSessionSlice(events) {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event === 'SessionStart') {
      start = i;
      break;
    }
  }
  return events.slice(start);
}

function findGoal(sessionEvents) {
  const prompts = sessionEvents.filter((e) => e.event === 'UserPromptSubmit');
  const goalOverride = [...prompts].reverse().find((e) => /^\/goal\b/i.test(e.payload.prompt || ''));
  if (goalOverride) return goalOverride.payload.prompt.replace(/^\/goal\s*/i, '').trim();
  if (prompts.length) return prompts[0].payload.prompt.trim().slice(0, 200);
  return 'Untitled task';
}

function latestTodos(sessionEvents) {
  for (let i = sessionEvents.length - 1; i >= 0; i--) {
    const e = sessionEvents[i];
    if (e.event === 'PostToolUse' && e.payload.tool_name === 'TodoWrite') {
      const todos = e.payload.tool_input && e.payload.tool_input.todos;
      if (Array.isArray(todos)) return todos;
    }
  }
  return null;
}

function describeDoing(event) {
  if (!event) return null;
  const { tool_name: name, tool_input: input = {} } = event.payload;
  if (EDIT_TOOLS.has(name)) return `Editing ${basename(toolFilePath(event.payload)) || 'a file'}`;
  if (name === 'Read') return `Reading ${basename(toolFilePath(event.payload)) || 'a file'}`;
  if (name === 'Bash') return `Running: ${(input.command || '').slice(0, 90)}`;
  if (name === 'TodoWrite') return 'Updating the task list';
  if (name) return `Using ${name}`;
  return null;
}

function buildPlan(sessionEvents, planFileTasks) {
  const todos = latestTodos(sessionEvents);
  const tasks = [];
  if (todos) {
    for (const t of todos) {
      const status = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'run' : 'todo';
      tasks.push({ text: t.content, status, extra: false });
    }
  }
  for (const pf of planFileTasks) {
    const already = tasks.some((t) => t.text.trim().toLowerCase() === pf.text.trim().toLowerCase());
    if (!already) tasks.push({ text: pf.text, status: pf.done ? 'done' : 'todo', extra: false });
  }

  // Scope decisions describe work the plan never scheduled; surface them as
  // "extra" plan entries unless a task with matching text already exists.
  const decisions = collectDecisions(sessionEvents);
  for (const d of decisions.filter((d) => d.tag === 'Scope')) {
    const already = tasks.some((t) => tokensOverlap(t.text, d.text));
    if (!already) tasks.push({ text: summarize(d.text), status: 'todo', extra: true, ts: d.ts });
  }

  const doneCount = tasks.filter((t) => t.status === 'done' && !t.extra).length;
  const totalCount = tasks.filter((t) => !t.extra).length;
  return { tasks, doneCount, totalCount };
}

function tokensOverlap(a, b) {
  const ta = new Set(tokenize(a));
  return tokenize(b).some((t) => ta.has(t));
}

function summarize(sentence) {
  const words = sentence.split(' ');
  return words.length <= 8 ? sentence.replace(/\.$/, '') : words.slice(0, 8).join(' ') + '…';
}

function collectDecisions(sessionEvents) {
  const out = [];
  for (const e of sessionEvents) {
    if (e.event !== 'Stop' && e.event !== 'SubagentStop') continue;
    const text = e.payload.last_assistant_message;
    if (!text) continue;
    for (const d of extractDecisions(text)) {
      out.push({ id: `${e.id}:${out.length}`, tag: d.tag, text: d.text, ts: e.ts });
    }
  }
  return out;
}

function editEvents(sessionEvents) {
  return sessionEvents.filter((e) => e.event === 'PostToolUse' && EDIT_TOOLS.has(e.payload.tool_name) && toolFilePath(e.payload));
}

function computeRework(sessionEvents) {
  const edits = editEvents(sessionEvents);
  const burstCounts = new Map();
  let lastFile = null;
  for (const e of edits) {
    const file = toolFilePath(e.payload);
    if (file !== lastFile) {
      burstCounts.set(file, (burstCounts.get(file) || 0) + 1);
    }
    lastFile = file;
  }
  const files = [...burstCounts.entries()]
    .map(([filePath, bursts]) => ({ path: filePath, bursts }))
    .sort((a, b) => b.bursts - a.bursts);
  const max = files[0] || { path: null, bursts: 0 };
  return { max: max.bursts, topFile: max.path, files, level: max.bursts >= 3 ? 'watch' : 'ok' };
}

function computeOffPlan(gitFiles, planTasks, opts) {
  const nonExtraTasks = planTasks.filter((t) => !t.extra);
  const changed = gitFiles.filter((f) => !f.binary);
  const totalLoc = changed.reduce((sum, f) => sum + f.added + f.deleted, 0);
  if (nonExtraTasks.length === 0) {
    return {
      pct: null,
      level: 'none',
      noPlan: true,
      totalLoc,
      offPlanLoc: 0,
      files: [],
      history: (opts.previousHistory || []).slice(-24),
      deltaFromLastHour: null,
    };
  }
  const offPlanFiles = [];
  let offPlanLoc = 0;
  for (const f of changed) {
    const match = matchesAnyTask(f.path, nonExtraTasks);
    if (!match) {
      offPlanLoc += f.added + f.deleted;
      offPlanFiles.push({
        name: basename(f.path) || f.path,
        path: f.path,
        loc: f.added + f.deleted,
        why: 'New change not referenced by any plan task.',
      });
    } else if (match.status === 'todo') {
      offPlanFiles.push({
        name: basename(f.path) || f.path,
        path: f.path,
        loc: f.added + f.deleted,
        why: `Touched early — the plan hasn't reached "${match.text}" yet.`,
      });
    }
  }
  const pct = totalLoc === 0 ? 0 : Math.round((offPlanLoc / totalLoc) * 100);
  const level = pct > 40 ? 'attention' : pct > 15 ? 'watch' : 'ok';

  const history = (opts.previousHistory || []).slice(-24);
  const throttleMs = 5 * 60 * 1000;
  const lastSnap = history[history.length - 1];
  if (!lastSnap || opts.now - lastSnap.ts >= throttleMs) {
    history.push({ pct, ts: opts.now });
  }
  const hourAgo = opts.now - 60 * 60 * 1000;
  const priorSnap = [...history].reverse().find((s) => s.ts <= hourAgo);
  const deltaFromLastHour = priorSnap ? pct - priorSnap.pct : null;

  return { pct, level, noPlan: false, totalLoc, offPlanLoc, files: offPlanFiles.sort((a, b) => b.loc - a.loc), history, deltaFromLastHour };
}

function computeAddedCode(gitFiles, newDeps) {
  const net = gitFiles.reduce((sum, f) => sum + f.added - f.deleted, 0);
  return { net, newDeps, level: newDeps > 0 ? 'watch' : 'ok' };
}

function parseTestOutput(output) {
  if (!output) return null;
  let passed = null;
  let failed = null;
  const passMatch = output.match(/(\d+)\s+passed/i);
  const failMatch = output.match(/(\d+)\s+failed/i);
  if (passMatch) passed = parseInt(passMatch[1], 10);
  if (failMatch) failed = parseInt(failMatch[1], 10);
  if (passed === null && failed === null) {
    const goPass = (output.match(/--- PASS:/g) || []).length;
    const goFail = (output.match(/--- FAIL:/g) || []).length;
    if (goPass || goFail) {
      passed = goPass;
      failed = goFail;
    }
  }
  if (passed === null && failed === null) return null;
  return { passed: passed || 0, failed: failed || 0 };
}

function computeTests(sessionEvents) {
  for (let i = sessionEvents.length - 1; i >= 0; i--) {
    const e = sessionEvents[i];
    if (e.event !== 'PostToolUse' || e.payload.tool_name !== 'Bash') continue;
    const cmd = (e.payload.tool_input || {}).command || '';
    if (!TEST_CMD_RE.test(cmd)) continue;
    const parsed = parseTestOutput((e.payload.tool_response || {}).output);
    if (!parsed) continue;
    return {
      pass: parsed.passed,
      fail: parsed.failed,
      total: parsed.passed + parsed.failed,
      ts: e.ts,
      level: parsed.failed > 0 ? 'watch' : 'ok',
    };
  }
  return { pass: null, fail: null, total: null, ts: null, level: 'unknown' };
}

function findMemoryPct(sessionEvents) {
  const re = /context.*pct|contextwindow|memorypct/i;
  for (let i = sessionEvents.length - 1; i >= 0; i--) {
    const payload = sessionEvents[i].payload || {};
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === 'number' && re.test(key)) return value;
      if (value && typeof value === 'object') {
        for (const [k2, v2] of Object.entries(value)) {
          if (typeof v2 === 'number' && re.test(k2)) return v2;
        }
      }
    }
  }
  return null;
}

function computeNeedsYou(sessionEvents) {
  const last = sessionEvents[sessionEvents.length - 1];
  return Boolean(last && last.event === 'Notification');
}

const STALE_MS = 10 * 60 * 1000;

function computeStatus(sessionEvents, needsYou, now) {
  if (sessionEvents.length === 0) return 'idle';
  if (needsYou) return 'needs_you';
  const last = sessionEvents[sessionEvents.length - 1];
  if (last.event === 'SessionEnd') return 'finished';
  if (now - Date.parse(last.ts) > STALE_MS) return 'stale';
  return 'working';
}

function reduce(events, opts) {
  const { planFileTasks = [], gitFiles = [], newDeps = 0, cursorTs = null, now, previousHistory = [] } = opts;
  const sessionEvents = lastSessionSlice(events);
  const start = sessionEvents.find((e) => e.event === 'SessionStart');

  const plan = buildPlan(sessionEvents, planFileTasks);
  const todos = latestTodos(sessionEvents);
  const progressPct = plan.totalCount ? Math.round((plan.doneCount / plan.totalCount) * 100) : 0;

  let currentStepText = null;
  let stepIndex = null;
  if (todos) {
    const idx = todos.findIndex((t) => t.status === 'in_progress');
    if (idx >= 0) {
      currentStepText = todos[idx].content;
      stepIndex = idx + 1;
    }
  }
  const lastToolEvent = [...sessionEvents].reverse().find((e) => e.event === 'PostToolUse' && e.payload.tool_name !== 'TodoWrite');

  const decisions = collectDecisions(sessionEvents)
    .map((d) => ({ ...d, unseen: cursorTs === null || d.ts > cursorTs, watch: d.tag === 'Workaround' }))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1));

  const offPlan = computeOffPlan(gitFiles, plan.tasks, { now, previousHistory });
  const needsYou = computeNeedsYou(sessionEvents);
  const unseenDecisions = decisions.filter((d) => d.unseen).length;
  const unseenExtraTasks = plan.tasks.filter((t) => t.extra && (cursorTs === null || t.ts > cursorTs)).length;

  const lastEvent = sessionEvents.length ? sessionEvents[sessionEvents.length - 1] : null;
  const idleMs = lastEvent ? Math.round(now - Date.parse(lastEvent.ts)) : null;

  return {
    sessionId: start ? start.payload.session_id : null,
    cwd: opts.cwd,
    model: start ? start.payload.model : null,
    branch: start ? start.payload.branch : null,
    status: computeStatus(sessionEvents, needsYou, now),
    startedAt: start ? start.ts : null,
    updatedAt: lastEvent ? lastEvent.ts : null,
    idleMs,
    now: {
      goal: findGoal(sessionEvents),
      stepIndex,
      stepCount: todos ? todos.length : null,
      currentStepText,
      doing: describeDoing(lastToolEvent),
      progressPct,
    },
    plan,
    health: {
      offPlanWork: offPlan,
      rework: computeRework(sessionEvents),
      addedCode: computeAddedCode(gitFiles, newDeps),
      tests: computeTests(sessionEvents),
      memory: (() => {
        const pct = findMemoryPct(sessionEvents);
        return { pct, level: pct === null ? 'unknown' : pct >= 70 ? 'watch' : 'ok' };
      })(),
    },
    decisions,
    attention: {
      unseenCount: unseenDecisions + unseenExtraTasks,
      unseenDecisions,
      unseenExtraTasks,
      needsYou,
    },
  };
}

module.exports = { reduce, extractDecisions, matchesAnyTask, tokenize };

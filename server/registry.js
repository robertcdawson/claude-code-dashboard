'use strict';
// In-memory registry of supervised projects, keyed by cwd. Lazily hydrates
// from disk (events.jsonl / state.json) so a server restart picks up where
// the files left off.

const store = require('./store');
const git = require('./git');
const { reduce } = require('./reducer');

function dedupeById(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

class Project {
  constructor(cwd) {
    this.cwd = cwd;
    this.events = dedupeById(store.readEvents(cwd));
    this.state = store.readState(cwd) || null;
    this.clients = new Set();
    this.label = path_basename(cwd);
  }
}

function path_basename(p) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

const projects = new Map();

function getProject(cwd) {
  if (!projects.has(cwd)) projects.set(cwd, new Project(cwd));
  return projects.get(cwd);
}

function listProjects() {
  return [...projects.values()].map((p) => ({
    cwd: p.cwd,
    label: p.label,
    status: p.state ? p.state.status : 'idle',
    updatedAt: p.state ? p.state.updatedAt : null,
    unseenCount: p.state ? p.state.attention.unseenCount : 0,
    needsYou: p.state ? p.state.attention.needsYou : false,
  }));
}

function recompute(cwd, { now } = {}) {
  const project = getProject(cwd);
  const planFileTasks = store.readPlanFile(cwd);
  const cursor = store.readCursor(cwd);
  const gitFiles = git.numstat(cwd);
  const newDeps = git.newDependencyCount(cwd);
  const previousHistory = project.state && project.state.health ? project.state.health.offPlanWork.history : [];
  const state = reduce(project.events, {
    cwd,
    planFileTasks,
    gitFiles,
    newDeps,
    cursorTs: cursor.lastAckTs,
    now: now ?? Date.now(),
    previousHistory,
  });
  project.state = state;
  store.writeState(cwd, state);
  return state;
}

function appendEvent(cwd, envelope) {
  const project = getProject(cwd);
  // A hook may have already written this same event to events.jsonl before
  // POSTing it here (its own durability path, which works even if the
  // server is briefly unreachable). Persist it here too so *any* caller of
  // /event survives a server restart; dedupe by id against whatever's
  // in-memory so a hook's own write never becomes a visible duplicate.
  if (!project.events.some((e) => e.id === envelope.id)) {
    project.events.push(envelope);
  }
  store.appendEvent(cwd, envelope);
  return recompute(cwd);
}

function broadcast(cwd, state) {
  const project = getProject(cwd);
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of project.clients) {
    res.write(payload);
  }
}

module.exports = { getProject, listProjects, recompute, appendEvent, broadcast, projects };

'use strict';
// Pure summarizer + sorter for the cross-project overview: no filesystem,
// no subprocess, no network — callers hydrate state/git info and pass them
// in. See docs/plans/cross-project-overview.md (decisions 3, 4, 6).

const path = require('node:path');

const STALE_MS = 10 * 60 * 1000;
const STALE_DAYS = 7;
const STALE_DAY_MS = STALE_DAYS * 24 * 60 * 60 * 1000;
const UNTITLED_GOAL = 'Untitled task';

function normalizeGit(gitInfo) {
  if (!gitInfo) {
    return { isRepo: false, branch: null, changedFiles: 0, lastCommitSubject: null, lastCommitAt: null };
  }
  return {
    isRepo: Boolean(gitInfo.isRepo),
    branch: gitInfo.branch || null,
    changedFiles: gitInfo.changedFiles || 0,
    lastCommitSubject: gitInfo.lastCommitSubject || null,
    lastCommitAt: gitInfo.lastCommitAt || null,
  };
}

// Never trust the stored status: re-derive from how old lastActivityAt is.
function deriveStatus(storedStatus, lastActivityAt, now) {
  if (!lastActivityAt) return { status: storedStatus, stale: false };
  const age = now - Date.parse(lastActivityAt);
  if (age > STALE_DAY_MS) return { status: 'idle', stale: true };
  if ((storedStatus === 'working' || storedStatus === 'needs_you') && age > STALE_MS) {
    return { status: 'stale', stale: false };
  }
  return { status: storedStatus, stale: false };
}

function goalFrom(state) {
  const goal = state && state.now ? state.now.goal : null;
  if (!goal || goal === UNTITLED_GOAL) return null;
  return goal;
}

function nowFrom(state) {
  const plan = state ? state.plan : null;
  return {
    doing: (state && state.now && state.now.doing) || null,
    doneCount: (plan && plan.doneCount) || 0,
    totalCount: (plan && plan.totalCount) || 0,
  };
}

function planFrom(state) {
  const plan = state ? state.plan : null;
  const tasks = plan && Array.isArray(plan.tasks) ? plan.tasks : [];
  const totalCount = (plan && plan.totalCount) || 0;
  const openTasks = tasks.filter((t) => t.status !== 'done' && !t.extra).map((t) => t.text);
  return {
    hasPlan: totalCount > 0,
    openCount: openTasks.length,
    openTasks: openTasks.slice(0, 3),
  };
}

function attentionFrom(state, extras) {
  const att = state ? state.attention : null;
  return {
    unseenCount: (att && att.unseenCount) || 0,
    needsYou: Boolean(att && att.needsYou),
    pendingDirectives: (extras && extras.pendingDirectives) || 0,
  };
}

function summarizeProject(state, gitInfo, extras = {}) {
  const { cwd, label, hydrated = false, now, neverSeen = false } = extras;
  const git = normalizeGit(gitInfo);

  // A candidate discovered on disk that the server has never recorded an
  // event for: no state to read, so every derived field is a fixed zero
  // shape rather than a re-derivation of something that doesn't exist.
  // leftDirty stays false here even with a dirty tree — "left dirty" implies
  // a session was here and walked away, which never happened.
  if (neverSeen) {
    return {
      cwd,
      label: label || path.basename(cwd || ''),
      status: 'never_seen',
      hydrated: false,
      lastActivityAt: null,
      goal: null,
      now: { doing: null, doneCount: 0, totalCount: 0 },
      plan: { hasPlan: false, openCount: 0, openTasks: [] },
      attention: { unseenCount: 0, needsYou: false, pendingDirectives: 0 },
      git,
      flags: { stale: false, leftDirty: false, neverSeen: true },
    };
  }

  const lastActivityAt = state ? state.updatedAt || null : null;
  const storedStatus = state ? state.status : 'idle';
  const { status, stale } = deriveStatus(storedStatus, lastActivityAt, now);
  const leftDirty = git.changedFiles > 0 && status !== 'working' && status !== 'needs_you';

  return {
    cwd,
    label: label || path.basename(cwd || ''),
    status,
    hydrated: Boolean(hydrated),
    lastActivityAt,
    goal: goalFrom(state),
    now: nowFrom(state),
    plan: planFrom(state),
    attention: attentionFrom(state, extras),
    git,
    flags: { stale, leftDirty, neverSeen: false },
  };
}

function sortRank(summary) {
  let rank = summary.attention.needsYou ? 0 : summary.status === 'working' ? 1 : 2;
  if (summary.flags.stale) rank += 10;
  if (summary.flags.neverSeen) rank += 20;
  return rank;
}

function sortSummaries(list) {
  return [...list].sort((a, b) => {
    const rankDiff = sortRank(a) - sortRank(b);
    if (rankDiff !== 0) return rankDiff;
    const aT = a.lastActivityAt ? Date.parse(a.lastActivityAt) : null;
    const bT = b.lastActivityAt ? Date.parse(b.lastActivityAt) : null;
    if (aT !== bT) {
      if (aT === null) return 1;
      if (bT === null) return -1;
      return bT - aT;
    }
    return (a.label || '').localeCompare(b.label || '');
  });
}

module.exports = { summarizeProject, sortRank, sortSummaries, STALE_DAYS };

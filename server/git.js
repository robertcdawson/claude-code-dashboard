'use strict';
// On-demand ground truth for changed-line counts. We shell out to git
// rather than trust hook-reported line counts, since tool_response bodies
// don't reliably carry them.

const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function isGitRepo(cwd) {
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// Whether the repo at cwd has at least one commit (i.e. HEAD resolves).
function hasCommits(cwd) {
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// Combined working-tree + staged diff against HEAD, per file.
// Returns [] outside a git repo. Before the first commit, diffs against the
// empty tree instead, since `git diff HEAD` has no HEAD to compare to.
function numstat(cwd) {
  if (!isGitRepo(cwd)) return [];
  const tryRun = (args) => {
    try {
      return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
    } catch {
      return '';
    }
  };
  // Once there's a commit, `git diff --numstat HEAD` is authoritative on its
  // own: empty output means a clean tree, not "no commits yet".
  const out = hasCommits(cwd)
    ? tryRun(['diff', '--numstat', 'HEAD'])
    : tryRun(['diff', '--numstat', '4b825dc642cb6eb9a060e54bf8d69288fbee4904']);
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [added, deleted, ...pathParts] = line.split('\t');
    const filePath = pathParts.join('\t');
    if (!filePath) continue;
    files.push({
      path: filePath,
      added: added === '-' ? 0 : parseInt(added, 10) || 0,
      deleted: deleted === '-' ? 0 : parseInt(deleted, 10) || 0,
      binary: added === '-' && deleted === '-',
    });
  }
  return files;
}

// Rough new-dependency signal: added lines in dependency manifests that
// look like `"pkg": "1.2.3"` (or similar) rather than removed/modified ones.
const MANIFESTS = ['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Gemfile', 'Cargo.toml'];

function newDependencyCount(cwd) {
  if (!isGitRepo(cwd)) return 0;
  let count = 0;
  for (const manifest of MANIFESTS) {
    let diff;
    try {
      diff = execFileSync('git', ['-C', cwd, 'diff', '--unified=0', 'HEAD', '--', manifest], {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString('utf8');
    } catch {
      continue;
    }
    for (const line of diff.split('\n')) {
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      if (/"[\w@/.\-]+"\s*:\s*"[^"]+"/.test(line) || /^\+\s*[\w.\-]+\s*[=~^><]/.test(line.slice(1))) {
        count++;
      }
    }
  }
  return count;
}


// Branch name; null outside a repo or before the first commit (rev-parse
// against a HEAD that doesn't resolve yet fails in that case).
function currentBranch(cwd) {
  if (!hasCommits(cwd)) return null;
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8').trim();
  } catch {
    return null;
  }
}

// Subject + author date of the last commit, split on the NUL byte. Both
// null before the first commit or outside a repo.
function lastCommitInfo(cwd) {
  if (!hasCommits(cwd)) return { subject: null, at: null };
  try {
    const out = execFileSync('git', ['-C', cwd, 'log', '-1', '--format=%s%x00%cI'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8');
    const [subject, at] = out.split('\0');
    return { subject: subject ?? null, at: (at ?? '').trim() || null };
  } catch {
    return { subject: null, at: null };
  }
}

// Snapshot of repo state for the dashboard overview: identity, branch,
// changed-file count, and last-commit metadata. Never throws.
function summary(cwd) {
  const isRepo = isGitRepo(cwd);
  if (!isRepo) {
    return { isRepo: false, branch: null, changedFiles: 0, lastCommitSubject: null, lastCommitAt: null };
  }
  const branch = currentBranch(cwd);
  const changedFiles = numstat(cwd).length;
  const { subject, at } = lastCommitInfo(cwd);
  return { isRepo: true, branch, changedFiles, lastCommitSubject: subject, lastCommitAt: at };
}

// --- Async summary path (used by the overview endpoint, which fans out over
// many repos and can't afford ~7 sequential sync spawns each). Same shape and
// same never-throws contract as summary(), but batches to at most 3 git
// spawns per repo and lets the diff/log spawns run concurrently. Kept
// separate from the sync helpers above rather than rewritten in terms of
// them, so summary()/numstat() stay untouched for existing callers.

// Runs git and never throws: resolves with { ok, stdout } where ok reflects
// the exit code, and stdout is whatever was captured either way (git still
// writes partial stdout before failing on some subcommands).
async function tryExecAsync(args) {
  try {
    const { stdout } = await execFileAsync('git', args, { windowsHide: true });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stdout: (err && err.stdout) || '' };
  }
}

// Single spawn covering both isGitRepo and currentBranch. On an unborn HEAD
// (repo exists, zero commits) `--abbrev-ref HEAD` fails to resolve and the
// whole rev-parse call exits non-zero, but `--is-inside-work-tree` still
// printed its line first — so we can tell "not a repo" apart from "repo,
// no commits yet" from the partial stdout without a second spawn.
async function repoAndBranchAsync(cwd) {
  const { ok, stdout } = await tryExecAsync(['-C', cwd, 'rev-parse', '--is-inside-work-tree', '--abbrev-ref', 'HEAD']);
  const lines = stdout.split('\n');
  const isRepo = lines[0] === 'true';
  if (!isRepo) return { isRepo: false, hasCommits: false, branch: null };
  if (!ok) return { isRepo: true, hasCommits: false, branch: null };
  return { isRepo: true, hasCommits: true, branch: (lines[1] || '').trim() || null };
}

// Duplicates numstat()'s line-parsing on purpose (see comment above) rather
// than sharing it, to keep the sync path's behavior pinned.
function parseNumstatLines(out) {
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [added, deleted, ...pathParts] = line.split('\t');
    const filePath = pathParts.join('\t');
    if (!filePath) continue;
    files.push({
      path: filePath,
      added: added === '-' ? 0 : parseInt(added, 10) || 0,
      deleted: deleted === '-' ? 0 : parseInt(deleted, 10) || 0,
      binary: added === '-' && deleted === '-',
    });
  }
  return files;
}

async function numstatAsync(cwd, hasCommitsFlag) {
  const ref = hasCommitsFlag ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const { stdout } = await tryExecAsync(['-C', cwd, 'diff', '--numstat', ref]);
  return parseNumstatLines(stdout);
}

async function lastCommitInfoAsync(cwd) {
  const { ok, stdout } = await tryExecAsync(['-C', cwd, 'log', '-1', '--format=%s%x00%cI']);
  if (!ok) return { subject: null, at: null };
  const [subject, at] = stdout.split('\0');
  return { subject: subject ?? null, at: (at ?? '').trim() || null };
}

// Async twin of summary(): same shape, same never-throws contract. At most
// 3 spawns per repo — 1 for repo+branch, then diff and log concurrently.
async function summaryAsync(cwd) {
  try {
    const { isRepo, hasCommits: hc, branch } = await repoAndBranchAsync(cwd);
    if (!isRepo) {
      return { isRepo: false, branch: null, changedFiles: 0, lastCommitSubject: null, lastCommitAt: null };
    }
    const [files, commitInfo] = await Promise.all([
      numstatAsync(cwd, hc),
      hc ? lastCommitInfoAsync(cwd) : Promise.resolve({ subject: null, at: null }),
    ]);
    return { isRepo: true, branch, changedFiles: files.length, lastCommitSubject: commitInfo.subject, lastCommitAt: commitInfo.at };
  } catch {
    return { isRepo: false, branch: null, changedFiles: 0, lastCommitSubject: null, lastCommitAt: null };
  }
}

module.exports = { isGitRepo, hasCommits, numstat, newDependencyCount, summary, summaryAsync };

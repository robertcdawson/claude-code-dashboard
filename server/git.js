'use strict';
// On-demand ground truth for changed-line counts. We shell out to git
// rather than trust hook-reported line counts, since tool_response bodies
// don't reliably carry them.

const { execFileSync } = require('node:child_process');

function isGitRepo(cwd) {
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// Combined working-tree + staged diff against HEAD, per file.
// Returns [] outside a git repo or before the first commit.
function numstat(cwd) {
  if (!isGitRepo(cwd)) return [];
  const tryRun = (args) => {
    try {
      return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
    } catch {
      return '';
    }
  };
  let out = tryRun(['diff', '--numstat', 'HEAD']);
  if (!out) {
    // no commits yet: diff the empty tree against the index+worktree
    out = tryRun(['diff', '--numstat', '4b825dc642cb6eb9a060e54bf8d69288fbee4904']);
  }
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

module.exports = { isGitRepo, numstat, newDependencyCount };

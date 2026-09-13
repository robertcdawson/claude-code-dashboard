'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { numstat, hasCommits } = require('../server/git.js');

const GIT_ENV = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...GIT_ENV, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
}

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-git-'));
  git(dir, ['init']);
  return dir;
}

test('numstat: committed + clean tree returns []', (t) => {
  const dir = mkRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nline2\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-m', 'init']);

  assert.deepEqual(numstat(dir), []);
});

test('numstat: committed + one modified tracked file', (t) => {
  const dir = mkRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nline2\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-m', 'init']);

  fs.appendFileSync(path.join(dir, 'a.txt'), 'line3\nline4\n');

  const files = numstat(dir);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0], { path: 'a.txt', added: 2, deleted: 0, binary: false });
});

test('numstat: no commits yet, staged file listed via empty-tree diff', (t) => {
  const dir = mkRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nline2\nline3\n');
  git(dir, ['add', 'a.txt']);

  const files = numstat(dir);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'a.txt');
  assert.equal(files[0].added, 3);
});

test('numstat: non-git directory returns []', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-git-nogit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(numstat(dir), []);
});

test('hasCommits: true after first commit, false before', (t) => {
  const dir = mkRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nline2\nline3\n');
  git(dir, ['add', 'a.txt']);
  assert.equal(hasCommits(dir), false);

  git(dir, ['commit', '-m', 'init']);
  assert.equal(hasCommits(dir), true);
});

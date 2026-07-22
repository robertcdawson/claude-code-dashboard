#!/usr/bin/env node
'use strict';
// SessionStart — registers the session (id, cwd, git branch, model) so the
// reducer has a starting point for "now" and "elapsed".

const { run, gitBranch } = require('./lib/common');

run('SessionStart', async () => {}, (payload) => {
  payload.branch = gitBranch(payload.cwd || process.cwd());
});

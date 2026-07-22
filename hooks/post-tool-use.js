#!/usr/bin/env node
'use strict';
// PostToolUse — the workhorse. The event itself (tool name, file paths,
// TodoWrite state, Bash test output) is captured generically by common.run's
// envelope; this handler's only extra job is inbox delivery: if a directive
// is waiting, hand it back as additionalContext so it enters Claude's
// context on the very next turn.

const { run, consumeNextDirective } = require('./lib/common');

run('PostToolUse', async (payload) => {
  const cwd = payload.cwd || process.cwd();
  const directive = consumeNextDirective(cwd);
  if (!directive) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `[Attention Router] The developer sent a directive while you were working: ${directive}`,
    },
  };
});

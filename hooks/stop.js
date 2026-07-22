#!/usr/bin/env node
'use strict';
// Stop — if a directive is waiting, block the stop so the loop absorbs the
// correction instead of finishing. Guarded by stop_hook_active so a directive
// delivered this way can't retrigger itself into an infinite loop: once
// Claude Code re-invokes Stop because we blocked it, stop_hook_active is
// true and we let the turn end normally even if another directive queued up
// in the meantime (it will be picked up by the next PostToolUse or Stop).

const { run, consumeNextDirective } = require('./lib/common');

run('Stop', async (payload) => {
  if (payload.stop_hook_active) return null;
  const cwd = payload.cwd || process.cwd();
  const directive = consumeNextDirective(cwd);
  if (!directive) return null;
  return {
    decision: 'block',
    reason: `[Attention Router] The developer sent a directive: ${directive}`,
  };
});

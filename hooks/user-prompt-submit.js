#!/usr/bin/env node
'use strict';
// UserPromptSubmit — not one of the events the spec enumerates, but the
// reducer's "now.goal" (first user prompt, or an explicit "/goal ..."
// override) has no other source: none of SessionStart/PostToolUse/Stop/
// Notification/SessionEnd carry the prompt text. Capturing it here is a
// minimal, non-blocking addition using the same fire-and-forget pipeline as
// every other hook.

const { run } = require('./lib/common');

run('UserPromptSubmit', async () => null);

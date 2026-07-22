#!/usr/bin/env node
'use strict';
// SubagentStop — a subagent finished. Its last_assistant_message feeds the
// same decision extractor as the top-level Stop event.

const { run } = require('./lib/common');

run('SubagentStop', async () => null);

#!/usr/bin/env node
'use strict';
// Notification — Claude is waiting on permission or input. Highest priority
// event: the reducer flips attention.needsYou true as soon as this lands,
// and clears it on the next activity in the session.

const { run } = require('./lib/common');

run('Notification', async () => null);

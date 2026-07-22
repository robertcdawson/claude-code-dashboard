#!/usr/bin/env node
'use strict';
// Used by the /attention-router:open slash command: make sure the daemon is
// up, then open the dashboard with the platform's default opener. Falls
// back to printing the URL if no opener is available (e.g. headless CI).

const { spawn } = require('node:child_process');
const { PORT, probeServer, spawnDaemon } = require('../hooks/lib/common');

const URL = `http://localhost:${PORT}`;

function openerFor(platform) {
  if (platform === 'darwin') return ['open', [URL]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '""', URL]];
  return ['xdg-open', [URL]];
}

async function waitForServer(maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await probeServer(300)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  let up = await probeServer(300);
  if (!up) {
    spawnDaemon();
    up = await waitForServer(4000);
  }
  if (!up) {
    console.log(`Dashboard server did not start in time. Try running it manually: node server/index.js\nThen open ${URL}`);
    return;
  }

  const [cmd, args] = openerFor(process.platform);
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    console.log(`Open this URL in your browser: ${URL}`);
  });
  child.unref();
  console.log(`Attention Router is running at ${URL}`);
}

main();

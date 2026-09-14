# Attention Router — project notes

Local-only dashboard for supervising Claude Code sessions. Node built-ins only,
no npm install, `npm test` runs `node --test`. See README.md for architecture.

## Standing rules (lessons learned, cumulative)

- **Restarting the daemon races the installed plugin.** Hooks from any live
  session auto-respawn the server the instant port 4123 goes down, and they
  spawn it from the installed plugin cache
  (`~/.claude/plugins/cache/attention-router-marketplace/attention-router/<ver>/`),
  not from this repo. To run repo code on 4123: kill the port, immediately
  start `node server/index.js` from the repo, then confirm with
  `curl localhost:4123/app.js | grep -c "<a string only in the new UI>"` and
  check `ps` for which path the pid is running. Write the new pid to
  `~/.attention-router/server.pid` yourself; `server/index.js` does not.
  Repo changes only persist across restarts once the plugin is updated.
- **An empty `git diff` is not "no commits".** Decide whether HEAD exists
  (`git rev-parse --verify HEAD`) before falling back to the empty-tree diff;
  a clean tree and a commitless repo both produce empty diff output.
- **Hooks write events.jsonl themselves before POSTing.** The server must
  check the file, not just memory, before appending, or every event lands twice.
- **Status must expire.** Anything derived from "last event" needs a staleness
  rule; sessions die without SessionEnd (closed terminal, crash).
- **No plan is a distinct state, not 100% off-plan.** The user rarely works
  without a task list, but when it happens the UI says "No plan", never red.
- **UI only receives SSE pushes on events.** Any time-derived state (stale,
  idle minutes) needs the 30 s poll of `/state`; do not add new timers.
- **Verifier runs against a copy of the working tree.** Nothing is committed
  until the user asks; a "fresh clone" gate is simulated with rsync excluding
  `.git` and `.claude`.
- **Grid/flex cards need `min-width:0` and `overflow-wrap:anywhere`.** Card
  text comes from raw prompts, shell commands and paths, so an unbroken
  120-char token will otherwise push the whole grid past a 400 px viewport.
  Verify with `scrollWidth <= innerWidth` at 400 px, not by eye.
- **Never shell out to git synchronously per project on a request path.**
  ~7 sequential spawns × 13 projects was 6.5 s cold. Use `git.summaryAsync`
  (≤3 spawns, `execFile`, `Promise.all`) behind the 30 s cache in
  `server/index.js`; gate is < 2 s cold, < 0.5 s warm on `/api/overview`.

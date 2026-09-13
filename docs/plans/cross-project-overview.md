# Plan: Cross-project Overview page (v0.1.3)

Status: DRAFTED 2026-09-13, awaiting user approval. Prerequisite (accuracy
fixes, v0.1.2) is implemented and verified in the working tree.

## Goal
`/` becomes an always-on overview of every project the server has ever seen,
answering per project: where it stands, what is going stale, open action
items, what is in process. Clicking a card opens the existing `?cwd=` view.

## Design decisions (final)
1. Index file `~/.attention-router/projects.json` (`ATTENTION_ROUTER_HOME`
   overrides, read at call time). Shape `{version:1, projects:[{cwd, firstSeen, lastSeen}]}`.
   Temp-file + rename writes; corrupt/missing reads as [].
2. Bounded discovery at startup: depth-1 scan of parents of indexed cwds,
   `~/Developer`, and `ATTENTION_ROUTER_SCAN_DIRS` (colon-separated). Cap 8
   roots x 200 children; a child is a project iff `.claude/attention/events.jsonl` exists.
3. Overview never replays event logs: uses in-memory `project.state` if present,
   else `store.readState(cwd)`; `hydrated:false` when only events.jsonl exists.
4. Never trust stored status: re-derive from `updatedAt` vs now. >10 min → stale;
   >7 days → idle with `flags.stale=true` (STALE_DAYS = 7).
5. `GET /api/overview` returns a sorted JSON array; `/api/projects` kept as-is (superseded).
6. Sort rank: 0 needsYou, 1 working, 2 otherwise; +10 if flags.stale; ties by
   lastActivityAt desc, nulls last. UI draws a divider at the stale band.
7. UI in `ui/index.html` + `ui/app.js` (`views` map / `showView()`); delete the
   `#picker` view and its boot branch; keep `#empty-state`.
8. Polling via the existing 30 s setInterval (`loadOverview()` when visible). No SSE fan-in.
9. Git calls cached in the overview module (GIT_TTL_MS = 10000); git.js stays pure.
10. Version 0.1.3 in package.json and .claude-plugin/plugin.json.

## Card contract (`summarizeProject(state, gitInfo, extras)`)
cwd, label, status, hydrated, lastActivityAt, goal, now.{doing,doneCount,totalCount},
plan.{hasPlan,openCount,openTasks[≤3]}, attention.{unseenCount,needsYou,pendingDirectives},
git.{isRepo,branch,changedFiles,lastCommitSubject,lastCommitAt},
flags.{stale,leftDirty}  — leftDirty = changedFiles>0 && status not in (working, needs_you).

## Tasks
- T1 `server/projects-index.js` (+test): indexPath/read/record/list/discover; wire
  `record()` into handleEvent and `discover()` at listen time (inside require.main guard, exported).
- T2 `git.summary(cwd)` in server/git.js (+test/git.test.js): {isRepo, branch,
  changedFiles, lastCommitSubject, lastCommitAt}; nulls/0 outside repo; never throws.
- T3 `server/overview.js` (+test/overview.test.js): pure summarizeProject + sortSummaries;
  ≥12 assertions over 5 inline fixtures; no fs/child_process imports.
- T4 `GET /api/overview` in server/index.js: union index + registry; skip missing dirs;
  integration test with server.listen(0) and ATTENTION_ROUTER_HOME in a tmpdir.
- T5 Overview UI: `<div class="wrap" id="overview" hidden>`, header
  "N projects · M active · K need you", cards, stale divider, link to ?cwd=,
  timeAgo extended to days, `.ov-*` CSS using existing tokens, single column <720px.
  Verify: node --check ui/app.js; grep -c 'id="overview"' ui/index.html → 1;
  grep -c picker ui/* → 0; grep -c '/api/overview' ui/app.js → 1; grep -c EventSource ui/app.js → 1.
- T6 Version 0.1.3 + README (API list, `/` is overview, index file, SCAN_DIRS, 7-day threshold).
- T7 Discoverability (optional, last): check whether hook `systemMessage` is user-visible on
  SessionStart. Branch A: session-start.js returns {systemMessage:'Attention Router: http://localhost:4123'}.
  Branch B: `scripts/open.js --print-url` prints the URL, exits 0, spawns nothing; README line.
- T8 Operational: restart daemon from repo on 4123 (see CLAUDE.md race note), curl
  /api/overview, quote rows for weather-rewind, interactives, llm-council; `time curl` twice,
  <500 ms warm, <2 s cold.

Dependencies: T1‖T2‖T3 → T4 → T5 → T6 → T7, T8.

## Acceptance gates
- `node --test` fail 0, pass ≥ previous + 12; node --check on all server/ui files.
- server/reducer.js unchanged (git diff --stat shows 0 lines).
- ≤ 360 added production lines across server/ and ui/ (target 300).
- Cold start on a copy: temp project with one SessionStart event, server on 4199 with
  ATTENTION_ROUTER_HOME=/tmp/ar-home ATTENTION_ROUTER_SCAN_DIRS=/tmp; /api/overview is an
  array whose entry has every contract key non-undefined; GET / → 200 containing id="overview".

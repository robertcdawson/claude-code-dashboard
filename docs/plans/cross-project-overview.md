# Plan: Cross-project Overview page (v0.1.3)

Status: IMPLEMENTED 2026-09-13 (approved same day). Prerequisite (accuracy
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

## v0.1.4 — roots config, Never seen, hooks freshness

1. New `~/.attention-router/config.json` (`ATTENTION_ROUTER_HOME` overrides,
   same as `projects.json`): `{"roots": ["~/Developer"], "recordOutsideRoots": true}`
   is the default when the file is absent, unreadable, or fails to parse as a
   non-array object; `~` is expanded to `os.homedir()` in every configured
   root. `ATTENTION_ROUTER_SCAN_DIRS` (colon-separated) is still merged in
   alongside the configured roots, deduped, and the combined list is capped
   at `MAX_ROOTS = 8` (`server/projects-index.js`).
2. Discovery (`listCandidates()`): direct children of each root that (a)
   contain a `.git` entry, (b) aren't dot-prefixed, (c) aren't
   `node_modules`, and (d) aren't already in `projects.json` or the live
   registry, become "never seen" candidates. Capped at `MAX_CHILDREN = 200`
   scanned per root; the overview renders at most `MAX_NEVER_SEEN = 40` of
   them (`server/index.js`), appended only after the already-seen union so a
   candidate can never displace or duplicate a real project.
3. `shouldRecord(cwd)` gates `record()`: sessions whose cwd is the home
   directory, `/`, or any strict ancestor of a configured root are never
   registered as projects (so scanning `~/Developer` doesn't let `~` itself
   get recorded as a side effect). When `recordOutsideRoots` is `false`,
   only cwds that are a configured root or strictly under one register at
   all; the default (`true`) keeps today's unrestricted behaviour.
4. Overview payload for a never-seen candidate: `status: 'never_seen'`,
   `hydrated: false`, `lastActivityAt: null`, zeroed `now`/`plan`/`attention`
   shapes, real `git` info (candidates are real git repos), and
   `flags: { stale: false, leftDirty: false, neverSeen: true }` — `leftDirty`
   is forced false because "left dirty" implies a session walked away, which
   never happened here. Sort rank adds +20 (after the existing +10 stale
   band), so never-seen cards sort last. Git lookups for never-seen cwds use
   a 300 s cache TTL (`GIT_TTL_IDLE_MS`) instead of the normal 30 s
   (`GIT_TTL_MS`), since a candidate the server has never gotten an event
   from changes state far less often from our point of view.
5. UI (`ui/app.js`, `ui/index.html`, `ui/styles.css`): a new
   "Never tracked · no Claude session here yet" divider (`#ov-never-divider`)
   renders above the existing stale divider, placed ahead of any stale rows
   whenever at least one never-seen card is present. Never-seen cards show
   the label, a `Never seen` pill (`data-status="never_seen"`), the git line,
   and the line "No Claude session has run here yet" in place of the
   in-process/plan/attention blocks. The summary line
   (`N projects · M active · K need you`) appends `· J never seen` only when
   `J > 0`.
6. Hooks freshness header: a new `#ov-hooks` line reads
   "Hooks: last event `<ago>`", computed client-side in `renderOverview`'s
   existing 30 s poll from the newest `lastActivityAt` across all cards — no
   new timer. Past 24 hours (or if no card has ever had an event) it turns
   amber (`.ov-hooks-warn`) and the text becomes
   "Hooks: no events in `<ago>` — is the plugin enabled? Run /plugin" (or
   "Hooks: no events yet — …" when nothing has ever posted).
7. Drill-down sheet hardening: `#sheet`'s closed state is now
   `visibility:hidden`, delayed by the existing `.3s` slide-out transition
   (`transition-delay` differs between the open and closed rules) so the
   hidden sheet can't be tabbed to or found by assistive tech mid-animation.
   `openSheet()` also now refuses to run unless `currentView === 'dashboard'`
   and the requested `kind` has a builder, since it's only ever meant to
   open from the per-project view.
8. Regression: divider elements (`#ov-cards`, `#ov-stale-divider`,
   `#ov-never-divider`) are captured once at module scope on load, not
   re-fetched via `getElementById` on every poll — `renderOverview` moves
   them in and out of `#ov-cards` and clears it with `innerHTML = ''` each
   cycle, which detaches whichever divider wasn't placed; a detached element
   is invisible to a later `getElementById` call, which would otherwise
   return `null` and throw inside an uncaught async poll. `test/ui-overview.test.js`
   drives four consecutive poll cycles (through the never-seen band, the
   stale band, both, and neither) to guard this.

Updated card contract: `summarizeProject` can now return
`status: 'never_seen'` with `flags.neverSeen: true` in addition to the
statuses and flags in decision list item 4 above; every other consumer of
the contract must treat `neverSeen` as always present (`true`/`false`), not
optional.

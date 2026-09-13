(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const views = { picker: $('picker'), dashboard: $('dashboard'), empty: $('empty-state') };
  function showView(name) {
    for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  }

  // ── Theme toggle ─────────────────────────────────────────────
  const themeBtn = $('theme-toggle');
  function refreshThemeLabel() {
    const setting = window.AttentionTheme.getSetting();
    themeBtn.textContent = setting[0].toUpperCase() + setting.slice(1);
  }
  themeBtn.addEventListener('click', () => window.AttentionTheme.cycleSetting());
  document.addEventListener('attention-theme-change', refreshThemeLabel);
  window.AttentionTheme.evaluate();
  refreshThemeLabel();

  // ── Determine which project to show ─────────────────────────
  const params = new URLSearchParams(location.search);
  let cwd = params.get('cwd');

  function projectUrl(c) {
    return `${location.pathname}?cwd=${encodeURIComponent(c)}`;
  }

  async function boot() {
    if (cwd) return connect(cwd);
    let projects;
    try {
      projects = await fetch('/api/projects').then((r) => r.json());
    } catch {
      projects = [];
    }
    if (projects.length === 0) return showView('empty');
    if (projects.length === 1) {
      cwd = projects[0].cwd;
      return connect(cwd);
    }
    showView('picker');
    const list = $('picker-list');
    list.innerHTML = '';
    for (const p of projects) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = projectUrl(p.cwd);
      a.innerHTML = `<span class="p-label">${escapeHtml(p.label)}</span><span class="p-status">${escapeHtml(p.status)}</span>` +
        (p.unseenCount ? `<span class="p-badge">${p.unseenCount}</span>` : '');
      li.appendChild(a);
      list.appendChild(li);
    }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── Live connection ──────────────────────────────────────────
  let currentState = null;
  let wasNeedsYou = false;

  function connect(c) {
    showView('dashboard');
    const source = new EventSource(`/stream?cwd=${encodeURIComponent(c)}`);
    source.onmessage = (ev) => {
      let state;
      try {
        state = JSON.parse(ev.data);
      } catch {
        return;
      }
      currentState = state;
      render(state);
    };
  }

  // ── Elapsed timer + read-driven refresh ─────────────────────
  setInterval(() => {
    if (currentState && currentState.startedAt) renderElapsed(currentState);
    if (cwd) refreshState();
  }, 30000);

  async function refreshState() {
    try {
      const state = await fetch(`/state?cwd=${encodeURIComponent(cwd)}`).then((r) => r.json());
      currentState = state;
      render(state);
    } catch {
      // ignore transient fetch errors
    }
  }

  function renderElapsed(state) {
    if (!state.startedAt) {
      $('elapsed').textContent = '—';
      return;
    }
    const mins = Math.max(0, Math.round((Date.now() - Date.parse(state.startedAt)) / 60000));
    $('elapsed').textContent = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  const STATUS_LABEL = { working: 'Working', needs_you: 'Needs you', finished: 'Finished', idle: 'Idle' };
  function statusLabel(state) {
    if (state.status === 'stale') {
      return state.idleMs === null ? 'No recent activity' : `No activity for ${Math.round(state.idleMs / 60000)} min`;
    }
    return STATUS_LABEL[state.status] || state.status;
  }
  const BASE_TITLE = document.title;

  function render(state) {
    // Status pill + title + native notification
    const pill = $('pill');
    pill.dataset.status = state.status;
    $('pill-text').textContent = statusLabel(state);
    document.title = state.status === 'needs_you' ? `● ${BASE_TITLE}` : BASE_TITLE;
    if (state.attention.needsYou && !wasNeedsYou) notifyNeedsYou(state);
    wasNeedsYou = state.attention.needsYou;

    renderElapsed(state);
    $('goal').textContent = state.now.goal || 'Untitled task';

    // Ack button
    const ack = $('ack');
    const { unseenCount, unseenDecisions, unseenExtraTasks } = state.attention;
    if (unseenCount === 0) {
      ack.classList.add('quiet');
      $('ackbig').textContent = 'All caught up';
      $('acksub').textContent = 'Nothing new needs your attention';
    } else {
      ack.classList.remove('quiet');
      $('ackbig').textContent = `${unseenCount} new since you looked`;
      const parts = [];
      if (unseenDecisions) parts.push(`${unseenDecisions} decision${unseenDecisions === 1 ? '' : 's'}`);
      if (unseenExtraTasks) parts.push(`${unseenExtraTasks} task${unseenExtraTasks === 1 ? '' : 's'} added outside the plan`);
      $('acksub').textContent = parts.join(' · ') || 'Take a look';
    }

    // Now card
    $('now-step-text').textContent = state.now.currentStepText
      || (state.plan.totalCount === 0 && state.now.goal ? 'Working without a task list'
        : state.now.goal ? 'Getting started…' : 'Waiting for activity…');
    $('now-step-count').textContent = state.now.stepIndex ? `step ${state.now.stepIndex} of ${state.now.stepCount}` : '';
    $('nowdoing').textContent = state.now.doing || '';
    $('progressbar').setAttribute('aria-valuenow', String(state.now.progressPct));
    $('progressbar').setAttribute('aria-label', `Overall progress ${state.now.progressPct} percent`);
    $('progressbar-fill').style.width = `${state.now.progressPct}%`;

    renderHealth(state);
    renderDecisions(state);
    renderPlan(state);
  }

  function notifyNeedsYou(state) {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') Notification.requestPermission();
    if (Notification.permission === 'granted') {
      new Notification('Claude needs you', { body: state.now.goal || 'A session needs your input.' });
    }
  }

  // ── Health chips ─────────────────────────────────────────────
  const CHIP_DEFS = [
    {
      key: 'offPlanWork',
      name: 'Off-plan work',
      value: (h) => (h.offPlanWork.noPlan ? '—' : `${h.offPlanWork.pct}%`),
      word: (h) => (h.offPlanWork.noPlan ? 'No plan' : wordFor(h.offPlanWork.level, ['Fine', 'Worth a look', 'Needs attention'])),
      hint: (h) => (h.offPlanWork.noPlan
        ? "Claude hasn't written a task list"
        : `${h.offPlanWork.files.length} file${h.offPlanWork.files.length === 1 ? '' : 's'} changed that the plan never mentions`),
    },
    {
      key: 'rework',
      name: 'Rework',
      value: (h) => `${h.rework.max}×`,
      word: (h) => wordFor(h.rework.level, ['Fine', 'Worth a look']),
      hint: (h) => (h.rework.topFile ? `${baseName(h.rework.topFile)} keeps getting rewritten` : 'No repeated rewrites'),
    },
    {
      key: 'addedCode',
      name: 'Added code',
      value: (h) => `${h.addedCode.net >= 0 ? '+' : ''}${h.addedCode.net}`,
      word: (h) => wordFor(h.addedCode.level, ['Fine', 'Worth a look']),
      hint: (h) => (h.addedCode.newDeps > 0 ? `${h.addedCode.newDeps} new dependenc${h.addedCode.newDeps === 1 ? 'y' : 'ies'}` : 'No new dependencies'),
    },
    {
      key: 'tests',
      name: 'Tests',
      value: (h) => (h.tests.total === null ? '—' : `${h.tests.pass}/${h.tests.total}`),
      word: (h) => (h.tests.total === null ? 'Not run yet' : wordFor(h.tests.level, ['Passing', 'Failing'])),
      hint: (h) => (h.tests.ts ? `Last run ${timeAgo(h.tests.ts)}` : 'No test run captured yet'),
    },
    {
      key: 'memory',
      name: 'Memory',
      value: (h) => (h.memory.pct === null ? '—' : `${h.memory.pct}%`),
      word: (h) => (h.memory.pct === null ? 'Unavailable' : wordFor(h.memory.level, ['Fine', 'Worth a look'])),
      hint: (h) => (h.memory.pct === null ? 'Not reported by this session' : 'of context window used'),
    },
  ];

  function wordFor(level, labels) {
    if (level === 'ok') return labels[0];
    if (level === 'watch') return labels[1];
    if (level === 'attention') return labels[2] || labels[1];
    return labels[0];
  }

  function baseName(p) {
    return (p || '').split(/[\\/]/).pop();
  }

  function timeAgo(iso) {
    const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    return `${Math.floor(mins / 60)}h ago`;
  }

  function renderHealth(state) {
    const grid = $('health-grid');
    grid.innerHTML = '';
    for (const def of CHIP_DEFS) {
      const level = state.health[def.key].level;
      const btn = document.createElement('button');
      btn.className = 'chip';
      btn.dataset.level = level;
      btn.setAttribute('aria-haspopup', 'dialog');
      btn.innerHTML = `
        <span class="c-name">${def.name}</span>
        <span class="c-val num">${escapeHtml(def.value(state.health))}</span>
        <span class="c-word">${escapeHtml(def.word(state.health))}</span>
        <span class="c-hint">${escapeHtml(def.hint(state.health))}</span>`;
      btn.addEventListener('click', () => openSheet(def.key, state));
      grid.appendChild(btn);
    }
  }

  // ── Decisions ────────────────────────────────────────────────
  function renderDecisions(state) {
    const list = $('declist');
    list.innerHTML = '';
    for (const d of state.decisions) {
      const div = document.createElement('div');
      div.className = 'dec' + (d.unseen ? ' unseen' : '') + (d.watch ? ' watch' : '');
      div.innerHTML = `
        <div class="d-head">
          <span class="d-tag">${escapeHtml(d.tag)}</span>
          ${d.unseen ? '<span class="d-new">New</span>' : ''}
          <span class="d-time num">${formatTime(d.ts)}</span>
        </div>
        <p>${escapeHtml(d.text)}</p>`;
      list.appendChild(div);
    }
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // ── Plan ─────────────────────────────────────────────────────
  function renderPlan(state) {
    $('plan-count').textContent = `${state.plan.doneCount} of ${state.plan.totalCount} done`;
    const list = $('plan-list');
    list.innerHTML = '';
    for (const t of state.plan.tasks) {
      const li = document.createElement('li');
      li.className = t.extra ? 'extra' : t.status;
      const mark = t.extra ? '＋' : t.status === 'done' ? '✓' : t.status === 'run' ? '›' : '·';
      li.innerHTML = `<span class="mark" aria-hidden="true">${mark}</span>${escapeHtml(t.text)}` +
        (t.extra ? '<span class="badge">not in plan</span>' : '');
      list.appendChild(li);
    }
  }

  // ── Drill-down sheets ────────────────────────────────────────
  const scrim = $('scrim');
  const sheet = $('sheet');
  const sheetClose = $('sheetclose');
  let lastFocus = null;

  function openSheet(kind, state) {
    lastFocus = document.activeElement;
    $('sheet-title').textContent = SHEET_TITLE[kind] || 'Details';
    $('sheet-body').innerHTML = '';
    $('sheet-body').appendChild(SHEET_BUILDERS[kind](state));
    document.body.classList.add('sheet-open');
    sheet.setAttribute('aria-hidden', 'false');
    sheetClose.focus();
  }

  function closeSheet() {
    document.body.classList.remove('sheet-open');
    sheet.setAttribute('aria-hidden', 'true');
    if (lastFocus) lastFocus.focus();
  }

  sheetClose.addEventListener('click', closeSheet);
  scrim.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('sheet-open')) closeSheet();
  });

  async function postAction(body) {
    await fetch('/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, ...body }),
    });
  }

  function el(html) {
    const div = document.createElement('div');
    div.innerHTML = html.trim();
    return div.firstElementChild;
  }

  const SHEET_TITLE = {
    offPlanWork: 'Off-plan work',
    rework: 'Rework',
    addedCode: 'Added code',
    tests: 'Tests',
    memory: 'Memory',
  };

  const SHEET_BUILDERS = {
    offPlanWork(state) {
      const h = state.health.offPlanWork;
      if (h.noPlan) {
        const wrap = el(`<div>
          <div class="drift-sum"><span class="v num">No plan</span></div>
          <p class="sheet-explain">Nothing to compare against — Claude hasn't written a task list and there is no plan.md</p>
        </div>`);
        return wrap;
      }
      const deltaText = h.deltaFromLastHour === null
        ? ''
        : `<p class="sheet-explain">${h.deltaFromLastHour >= 0 ? 'Up' : 'Down'} ${Math.abs(h.deltaFromLastHour)} points from an hour ago.</p>`;
      const files = h.files.map((f) => `
        <li>
          <div class="f-row"><span class="f-name">${escapeHtml(f.name)}</span><span class="f-loc num">+${f.loc} lines</span></div>
          <span class="f-why">${escapeHtml(f.why)}</span>
        </li>`).join('');
      const wrap = el(`<div>
        <div class="drift-sum"><span class="v num">${h.pct}%</span><span class="w">of changed code isn't covered by any plan task</span></div>
        ${deltaText}
        <ul class="drift-files">${files || '<li><span class="f-why">No off-plan files right now.</span></li>'}</ul>
        <div class="sheet-actions">
          <button class="btn primary" id="sheet-adopt">Add to plan</button>
          <button class="btn ghost" id="sheet-undo">Ask Claude to undo</button>
        </div>
        <p class="sheet-note">Actions send a message to the running session — you stay in the loop, Claude stays in the terminal.</p>
      </div>`);
      const adoptBtn = wrap.querySelector('#sheet-adopt');
      if (adoptBtn) adoptBtn.addEventListener('click', async () => {
        const taskText = h.files.length ? `Off-plan work: ${h.files.map((f) => f.name).join(', ')}` : 'Off-plan work';
        await postAction({ type: 'adopt-task', taskText });
        closeSheet();
      });
      const undoBtn = wrap.querySelector('#sheet-undo');
      if (undoBtn) undoBtn.addEventListener('click', async () => {
        const names = h.files.map((f) => f.name).join(', ') || 'the off-plan changes';
        await postAction({ type: 'directive', text: `Please undo the off-plan work in ${names}, or explain why it's needed before continuing.` });
        closeSheet();
      });
      return wrap;
    },

    rework(state) {
      const h = state.health.rework;
      const wrap = el(`<div>
        <div class="drift-sum"><span class="v num">${h.max}×</span><span class="w">rewrites on the most-touched file</span></div>
        <p class="sheet-explain">${h.topFile ? escapeHtml(baseName(h.topFile)) + ' has been rewritten ' + h.max + ' separate times this session.' : 'No file has been rewritten repeatedly.'} Three or more rewrites in one session often means the approach is still being found.</p>
        <div class="sheet-actions">
          <button class="btn primary" id="sheet-ask">Ask Claude about it</button>
          <button class="btn ghost" id="sheet-dismiss">Close</button>
        </div>
        <p class="sheet-note">Actions send a message to the running session — you stay in the loop, Claude stays in the terminal.</p>
      </div>`);
      wrap.querySelector('#sheet-ask').addEventListener('click', async () => {
        await postAction({ type: 'directive', text: `Why does ${baseName(h.topFile) || 'this file'} keep getting rewritten — is the approach still being figured out?` });
        closeSheet();
      });
      wrap.querySelector('#sheet-dismiss').addEventListener('click', closeSheet);
      return wrap;
    },

    addedCode(state) {
      const h = state.health.addedCode;
      const wrap = el(`<div>
        <div class="drift-sum"><span class="v num">${h.net >= 0 ? '+' : ''}${h.net}</span><span class="w">net lines changed this session</span></div>
        <p class="sheet-explain">${h.newDeps > 0 ? `${h.newDeps} new dependenc${h.newDeps === 1 ? 'y was' : 'ies were'} added to the project manifest.` : 'No new dependencies were added.'}</p>
        <div class="sheet-actions">
          <button class="btn primary" id="sheet-ask" ${h.newDeps > 0 ? '' : 'hidden'}>Ask why it's needed</button>
          <button class="btn ghost" id="sheet-dismiss">Close</button>
        </div>
        <p class="sheet-note">Actions send a message to the running session — you stay in the loop, Claude stays in the terminal.</p>
      </div>`);
      wrap.querySelector('#sheet-ask').addEventListener('click', async () => {
        await postAction({ type: 'directive', text: 'You added a new dependency — can you explain why it was necessary?' });
        closeSheet();
      });
      wrap.querySelector('#sheet-dismiss').addEventListener('click', closeSheet);
      return wrap;
    },

    tests(state) {
      const h = state.health.tests;
      const wrap = el(`<div>
        <div class="drift-sum"><span class="v num">${h.total === null ? '—' : `${h.pass}/${h.total}`}</span><span class="w">tests passing</span></div>
        <p class="sheet-explain">${h.total === null ? 'No test run has been captured yet this session.' : h.fail > 0 ? `${h.fail} test${h.fail === 1 ? ' is' : 's are'} currently failing.` : 'All captured tests are passing.'}</p>
        <div class="sheet-actions">
          <button class="btn primary" id="sheet-ask" ${h.fail > 0 ? '' : 'hidden'}>Ask Claude to fix</button>
          <button class="btn ghost" id="sheet-dismiss">Close</button>
        </div>
        <p class="sheet-note">Actions send a message to the running session — you stay in the loop, Claude stays in the terminal.</p>
      </div>`);
      wrap.querySelector('#sheet-ask').addEventListener('click', async () => {
        await postAction({ type: 'directive', text: `Please fix the ${h.fail} failing test(s) before continuing.` });
        closeSheet();
      });
      wrap.querySelector('#sheet-dismiss').addEventListener('click', closeSheet);
      return wrap;
    },

    memory(state) {
      const h = state.health.memory;
      const wrap = el(`<div>
        <div class="drift-sum"><span class="v num">${h.pct === null ? '—' : `${h.pct}%`}</span><span class="w">of the context window used</span></div>
        <p class="sheet-explain">${h.pct === null ? 'This session is not reporting context-window usage.' : h.level === 'watch' ? 'Getting full — Claude may summarize or lose earlier context soon.' : 'Plenty of headroom left.'}</p>
        <div class="sheet-actions">
          <button class="btn primary" id="sheet-ask" ${h.level === 'watch' ? '' : 'hidden'}>Suggest wrapping up</button>
          <button class="btn ghost" id="sheet-dismiss">Close</button>
        </div>
        <p class="sheet-note">Actions send a message to the running session — you stay in the loop, Claude stays in the terminal.</p>
      </div>`);
      wrap.querySelector('#sheet-ask').addEventListener('click', async () => {
        await postAction({ type: 'directive', text: 'Context is getting full — please wrap up or summarize soon.' });
        closeSheet();
      });
      wrap.querySelector('#sheet-dismiss').addEventListener('click', closeSheet);
      return wrap;
    },
  };

  $('ack').addEventListener('click', () => {
    if (!cwd) return;
    postAction({ type: 'ack' });
  });

  boot();
})();

'use strict';
// Regression coverage for the overview divider elements (#ov-stale-divider,
// #ov-never-divider) and the hooks-freshness line (#ov-hooks).
//
// renderOverview() in ui/app.js moves the two static divider <div>s in and
// out of #ov-cards on every 30s poll. A prior version re-fetched them with
// document.getElementById() on every render; once a poll with no matching
// rows detached a divider, the NEXT getElementById() call for it returned
// null (getElementById only finds elements still connected to the document
// — exactly like a real browser), and `divider.hidden = false` threw
// `TypeError: Cannot set properties of null` from inside an async function
// with no catch, silently killing the overview poll loop.
//
// This test drives the real, unmodified ui/app.js through a minimal DOM/
// window/fetch/setInterval stub via vm.runInContext, across multiple fetch
// cycles, so a regression of that detach bug fails here instead of only
// showing up as "the dashboard quietly stopped updating" in production.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS_PATH = path.join(__dirname, '..', 'ui', 'app.js');
const CODE = fs.readFileSync(APP_JS_PATH, 'utf8');

// ── Minimal DOM stub ──────────────────────────────────────────────────
// getElementById() deliberately only resolves elements connected to ROOT,
// mirroring real document.getElementById() semantics — this is what
// exposes the detach bug when app.js re-queries a moved element.
function makeHarness() {
  let ROOT;
  const byId = {};

  function isConnected(el) {
    let n = el;
    while (n) {
      if (n === ROOT) return true;
      n = n.parentNode;
    }
    return false;
  }

  function makeEl(id, tag) {
    const e = {
      id: id || null, tag: tag || 'div', children: [], parentNode: null,
      _classes: new Set(), _text: '', _html: '', hidden: false, dataset: {}, attrs: {},
    };
    Object.defineProperty(e, 'textContent', {
      get() { return e._text; },
      set(v) { e._text = String(v); },
    });
    Object.defineProperty(e, 'innerHTML', {
      get() { return e._html; },
      set(v) {
        for (const c of e.children) c.parentNode = null;
        e.children = [];
        e._html = v;
      },
    });
    Object.defineProperty(e, 'className', {
      get() { return [...e._classes].join(' '); },
      set(v) { e._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    });
    e.classList = {
      add: (...n) => n.forEach((x) => e._classes.add(x)),
      remove: (...n) => n.forEach((x) => e._classes.delete(x)),
      toggle: (n, force) => {
        const has = e._classes.has(n);
        const want = force === undefined ? !has : force;
        if (want) e._classes.add(n); else e._classes.delete(n);
        return want;
      },
      contains: (n) => e._classes.has(n),
    };
    e.appendChild = (node) => {
      if (node.parentNode) {
        const idx = node.parentNode.children.indexOf(node);
        if (idx !== -1) node.parentNode.children.splice(idx, 1);
      }
      node.parentNode = e;
      e.children.push(node);
      return node;
    };
    e.setAttribute = (k, v) => { e.attrs[k] = v; };
    e.getAttribute = (k) => e.attrs[k];
    e.focus = () => {};
    e.addEventListener = () => {};
    e.querySelector = () => null;
    if (id) byId[id] = e;
    return e;
  }

  ROOT = makeEl(null, 'root');
  const overview = makeEl('overview');
  const dashboard = makeEl('dashboard');
  const emptyState = makeEl('empty-state');
  const ovRefreshed = makeEl('ov-refreshed');
  const ovHooks = makeEl('ov-hooks');
  const ovSummary = makeEl('ov-summary');
  const ovStaleDivider = makeEl('ov-stale-divider');
  const ovNeverDivider = makeEl('ov-never-divider');
  const ovCards = makeEl('ov-cards');
  const themeToggleOv = makeEl('theme-toggle-ov');
  const scrim = makeEl('scrim');
  const sheet = makeEl('sheet');
  const sheetClose = makeEl('sheetclose');
  const ack = makeEl('ack');

  ROOT.appendChild(overview);
  ROOT.appendChild(dashboard);
  ROOT.appendChild(emptyState);
  ROOT.appendChild(scrim);
  ROOT.appendChild(sheet);
  ROOT.appendChild(sheetClose);
  ROOT.appendChild(ack);
  overview.appendChild(ovRefreshed);
  overview.appendChild(ovHooks);
  overview.appendChild(ovSummary);
  overview.appendChild(themeToggleOv);
  overview.appendChild(ovStaleDivider);
  overview.appendChild(ovNeverDivider);
  overview.appendChild(ovCards);

  const documentStub = {
    getElementById: (id) => {
      const el = byId[id];
      if (!el) return null;
      return isConnected(el) ? el : null;
    },
    createElement: (tag) => makeEl(null, tag),
    addEventListener: () => {},
    body: makeEl(null, 'body'),
    activeElement: null,
  };

  let fetchImpl = () => Promise.reject(new Error('no fetch configured'));
  let capturedInterval = null;

  const sandbox = {
    document: documentStub,
    window: { AttentionTheme: { getSetting: () => 'auto', cycleSetting: () => {}, evaluate: () => {} } },
    location: { search: '', pathname: '/' },
    fetch: (...args) => fetchImpl(...args),
    setInterval: (fn) => { capturedInterval = fn; return 1; },
    URLSearchParams,
    console,
  };
  vm.createContext(sandbox);

  function flush() {
    return new Promise((r) => setTimeout(r, 0));
  }

  function setList(list) {
    fetchImpl = () => Promise.resolve({ json: () => Promise.resolve(list) });
  }

  async function boot(list) {
    setList(list);
    vm.runInContext(CODE, sandbox, { filename: 'app.js' });
    await flush();
  }

  async function poll(list) {
    setList(list);
    capturedInterval();
    await flush();
  }

  return {
    isConnected,
    boot,
    poll,
    els: { ovSummary, ovHooks, ovStaleDivider, ovNeverDivider, ovCards },
  };
}

function proj(overrides) {
  return Object.assign({
    cwd: '/tmp/x', label: 'x',
    status: 'working', lastActivityAt: new Date().toISOString(), goal: 'Goal',
    now: { doing: 'coding', doneCount: 0, totalCount: 0 },
    plan: { hasPlan: false, openCount: 0, openTasks: [] },
    attention: { needsYou: false, pendingDirectives: 0, unseenCount: 0 },
    git: { isRepo: true, branch: 'main', changedFiles: 0, lastCommitSubject: null, lastCommitAt: null },
    flags: { stale: false, neverSeen: false, leftDirty: false },
  }, overrides);
}

const minAgo = (n) => new Date(Date.now() - n * 60000).toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

function cardLabel(cardEl) {
  const m = cardEl.innerHTML.match(/ov-label">([^<]*)</);
  return m ? m[1] : null;
}

describe('ui/app.js overview: divider elements and hooks-freshness line across polls', () => {
  test('cycle 1 — boot with 1 working + 1 stale + 2 never-seen: summary, both dividers visible, never-divider precedes first never-seen card', async () => {
    const h = makeHarness();
    let unhandled = null;
    const onRejection = (err) => { unhandled = err; };
    process.on('unhandledRejection', onRejection);
    try {
      const working = proj({ cwd: '/a', label: 'A', status: 'working', lastActivityAt: minAgo(10) });
      const stale = proj({ cwd: '/b', label: 'B', status: 'stale', lastActivityAt: daysAgo(10), flags: { stale: true, neverSeen: false, leftDirty: false } });
      const never1 = proj({ cwd: '/c', label: 'C', status: 'never_seen', lastActivityAt: null, flags: { stale: false, neverSeen: true, leftDirty: false } });
      const never2 = proj({ cwd: '/d', label: 'D', status: 'never_seen', lastActivityAt: null, flags: { stale: false, neverSeen: true, leftDirty: false } });

      await h.boot([working, stale, never1, never2]);

      assert.equal(unhandled, null);
      assert.match(h.els.ovSummary.textContent, /4 projects/);
      assert.match(h.els.ovSummary.textContent, /2 never seen/);
      assert.equal(h.els.ovStaleDivider.hidden, false);
      assert.equal(h.els.ovNeverDivider.hidden, false);

      const order = h.els.ovCards.children.map((c) => c.id || cardLabel(c));
      const neverDividerIdx = order.indexOf('ov-never-divider');
      const firstNeverCardIdx = order.findIndex((entry) => entry === 'C' || entry === 'D');
      assert.ok(neverDividerIdx !== -1, 'never divider should be in #ov-cards');
      assert.equal(neverDividerIdx, firstNeverCardIdx - 1, 'never divider must immediately precede the first never-seen card');

      // exactly one instance of each divider in the render, never duplicated
      assert.equal(order.filter((e) => e === 'ov-stale-divider').length, 1);
      assert.equal(order.filter((e) => e === 'ov-never-divider').length, 1);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
  });

  test('cycle 2 — hooks freshness warns and links to /plugin when the newest event is 3 days old', async () => {
    const h = makeHarness();
    let unhandled = null;
    const onRejection = (err) => { unhandled = err; };
    process.on('unhandledRejection', onRejection);
    try {
      const working = proj({ cwd: '/a', label: 'A', status: 'working', lastActivityAt: daysAgo(3) });
      await h.boot([working]);

      assert.equal(unhandled, null);
      assert.equal(h.els.ovHooks.classList.contains('ov-hooks-warn'), true);
      assert.match(h.els.ovHooks.textContent, /Run \/plugin/);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
  });

  test('cycle 3 — a poll with no stale/never-seen rows hides and detaches both dividers without throwing', async () => {
    const h = makeHarness();
    let unhandled = null;
    const onRejection = (err) => { unhandled = err; };
    process.on('unhandledRejection', onRejection);
    try {
      const working = proj({ cwd: '/a', label: 'A', status: 'working', lastActivityAt: minAgo(10) });
      const stale = proj({ cwd: '/b', label: 'B', status: 'stale', lastActivityAt: daysAgo(10), flags: { stale: true, neverSeen: false, leftDirty: false } });
      const never1 = proj({ cwd: '/c', label: 'C', status: 'never_seen', lastActivityAt: null, flags: { stale: false, neverSeen: true, leftDirty: false } });

      await h.boot([working, stale, never1]);
      assert.equal(h.els.ovStaleDivider.hidden, false);
      assert.equal(h.els.ovNeverDivider.hidden, false);

      await h.poll([working]);

      assert.equal(unhandled, null, 'a poll with no matching rows must not throw or reject');
      assert.equal(h.els.ovStaleDivider.hidden, true);
      assert.equal(h.els.ovNeverDivider.hidden, true);
      assert.equal(h.isConnected(h.els.ovStaleDivider), false, 'hidden divider is expected to be detached, not just hidden in place');
      assert.equal(h.isConnected(h.els.ovNeverDivider), false);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
  });

  test('cycle 4 — dividers resurrect (no crash, no unhandled rejection) once matching rows return after being hidden', async () => {
    const h = makeHarness();
    let unhandled = null;
    const onRejection = (err) => { unhandled = err; };
    process.on('unhandledRejection', onRejection);
    try {
      const working = proj({ cwd: '/a', label: 'A', status: 'working', lastActivityAt: minAgo(10) });
      const stale = proj({ cwd: '/b', label: 'B', status: 'stale', lastActivityAt: daysAgo(10), flags: { stale: true, neverSeen: false, leftDirty: false } });
      const never1 = proj({ cwd: '/c', label: 'C', status: 'never_seen', lastActivityAt: null, flags: { stale: false, neverSeen: true, leftDirty: false } });
      const never2 = proj({ cwd: '/d', label: 'D', status: 'never_seen', lastActivityAt: null, flags: { stale: false, neverSeen: true, leftDirty: false } });

      // Boot with rows present, then a poll with none (detaches both
      // dividers), then a poll where matching rows return — this third
      // step is exactly where the pre-fix code threw from inside an
      // unguarded async interval callback.
      await h.boot([working, stale, never1, never2]);
      await h.poll([working]);
      assert.equal(h.els.ovStaleDivider.hidden, true);
      assert.equal(h.els.ovNeverDivider.hidden, true);

      await h.poll([working, stale, never1, never2]);

      assert.equal(unhandled, null, 'resurrecting a divider after it was detached must not throw');
      assert.match(h.els.ovSummary.textContent, /4 projects/);
      assert.match(h.els.ovSummary.textContent, /2 never seen/);
      assert.equal(h.els.ovStaleDivider.hidden, false);
      assert.equal(h.els.ovNeverDivider.hidden, false);
      assert.equal(h.isConnected(h.els.ovStaleDivider), true);
      assert.equal(h.isConnected(h.els.ovNeverDivider), true);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
  });
});

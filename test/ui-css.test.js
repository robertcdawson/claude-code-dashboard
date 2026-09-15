'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS_PATH = path.join(__dirname, '..', 'ui', 'styles.css');
const APP_JS_PATH = path.join(__dirname, '..', 'ui', 'app.js');
const css = fs.readFileSync(CSS_PATH, 'utf8');
const appJs = fs.readFileSync(APP_JS_PATH, 'utf8');

// Extracts the declaration block for a top-level selector (not inside a
// @media query) by finding the selector followed by a `{`, then walking
// forward to the matching `}`.
function blockFor(text, selector) {
  const idx = text.indexOf(selector + '{');
  if (idx === -1) return null;
  const open = idx + selector.length;
  return text.slice(open, text.indexOf('}', open) + 1);
}

// Extracts the body of a @media query (min-width:720px) etc, then looks
// for a nested selector's block within it.
function blockWithinMedia(text, mediaSelector, innerSelector) {
  const mediaIdx = text.indexOf(mediaSelector);
  if (mediaIdx === -1) return null;
  const braceStart = text.indexOf('{', mediaIdx);
  // Walk to find the matching closing brace for the @media block, counting
  // nested braces from the inner rules.
  let depth = 1;
  let i = braceStart + 1;
  while (depth > 0 && i < text.length) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    i++;
  }
  const mediaBody = text.slice(braceStart + 1, i - 1);
  return blockFor(mediaBody, innerSelector);
}

describe('ui/styles.css: drill-down sheet visibility', () => {
  test('base #sheet rule is fully hidden (visibility + transform) when closed', () => {
    const block = blockFor(css, '#sheet');
    assert.ok(block, 'expected a base #sheet rule');
    assert.match(block, /visibility:hidden/);
    assert.match(block, /transform:translateY\(105%\)/);
  });

  test('body.sheet-open #sheet reveals the sheet and slides it into view', () => {
    const block = blockFor(css, 'body.sheet-open #sheet');
    assert.ok(block, 'expected a body.sheet-open #sheet rule');
    assert.match(block, /visibility:visible/);
    assert.match(block, /transform:translateY\(0\)/);
  });

  test('min-width:720px override still sizes the sheet as a floating panel', () => {
    const block = blockWithinMedia(css, '@media (min-width:720px)', '#sheet');
    assert.ok(block, 'expected #sheet rule inside the 720px media query');
    assert.match(block, /width:420px/);
  });

  test('#scrim and body.sheet-open #scrim still toggle pointer-events', () => {
    const base = blockFor(css, '#scrim');
    const open = blockFor(css, 'body.sheet-open #scrim');
    assert.ok(base, 'expected a base #scrim rule');
    assert.ok(open, 'expected a body.sheet-open #scrim rule');
    assert.match(base, /pointer-events:none/);
    assert.match(open, /pointer-events:auto/);
  });
});

describe('ui/app.js: drill-down sheet wiring', () => {
  test('defines openSheet exactly once', () => {
    const matches = appJs.match(/function openSheet\(/g) || [];
    assert.equal(matches.length, 1);
  });

  test('closeSheet is wired to sheetClose click, scrim click, and Escape', () => {
    assert.match(appJs, /sheetClose\.addEventListener\('click',\s*closeSheet\)/);
    assert.match(appJs, /scrim\.addEventListener\('click',\s*closeSheet\)/);
    assert.match(appJs, /e\.key === 'Escape'/);
    assert.match(appJs, /closeSheet\(\)/);
  });

  test('openSheet only opens on the per-project dashboard view', () => {
    assert.match(appJs, /function openSheet\(kind, state\) \{\s*\n\s*if \(currentView !== 'dashboard'\) return;/);
  });
});

'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { computeSunTimes, isDark, nextBoundary } = require('../ui/sun-math.js');
const { resolveTheme } = require('../ui/theme.js');

// NYC, summer solstice — well-known reference values (~05:25 / 20:31 EDT).
const NYC = { lat: 40.7128, lon: -74.006 };

describe('sun-math: computeSunTimes', () => {
  test('matches known sunrise/sunset for NYC on the summer solstice', () => {
    const { sunrise, sunset } = computeSunTimes(NYC.lat, NYC.lon, new Date('2026-06-21T12:00:00Z'));
    assert.equal(sunrise.toISOString().slice(0, 16), '2026-06-21T09:26');
    assert.equal(sunset.toISOString().slice(0, 16), '2026-06-22T00:31');
  });

  test('returns null for polar night at the pole in winter', () => {
    const result = computeSunTimes(89, 0, new Date('2026-12-21T12:00:00Z'));
    assert.equal(result, null);
  });
});

describe('sun-math: isDark', () => {
  test('noon is light, midnight is dark, for a known location/date', () => {
    assert.equal(isDark(new Date('2026-06-21T12:00:00Z'), NYC.lat, NYC.lon), false);
    assert.equal(isDark(new Date('2026-06-21T04:00:00Z'), NYC.lat, NYC.lon), true);
  });

  test('falls back to a fixed 19:00-07:00 window without coordinates', () => {
    assert.equal(isDark(new Date('2026-06-21T20:00:00'), null, null), true);
    assert.equal(isDark(new Date('2026-06-21T12:00:00'), null, null), false);
  });
});

describe('sun-math: nextBoundary', () => {
  test('schedules the next flip forward, not backward', () => {
    const now = new Date('2026-06-21T12:00:00Z');
    const next = nextBoundary(now, NYC.lat, NYC.lon);
    assert.ok(next > now);
    const { sunset } = computeSunTimes(NYC.lat, NYC.lon, now);
    assert.equal(next.getTime(), sunset.getTime());
  });

  test('rolls over to tomorrow after sunset', () => {
    const now = new Date('2026-06-22T02:00:00Z'); // after the 00:31 sunset
    const next = nextBoundary(now, NYC.lat, NYC.lon);
    assert.ok(next > now);
    assert.equal(next.toISOString().slice(0, 10), '2026-06-22');
  });
});

describe('theme: resolveTheme', () => {
  test('explicit light/dark settings always win over the sun', () => {
    const midday = new Date('2026-06-21T12:00:00Z');
    assert.equal(resolveTheme('dark', midday, NYC), 'dark');
    assert.equal(resolveTheme('light', midday, NYC), 'light');
  });

  test('auto follows the sun at the given coordinates', () => {
    assert.equal(resolveTheme('auto', new Date('2026-06-21T12:00:00Z'), NYC), 'light');
    assert.equal(resolveTheme('auto', new Date('2026-06-21T04:00:00Z'), NYC), 'dark');
  });

  test('auto without coordinates uses the fixed fallback window', () => {
    assert.equal(resolveTheme('auto', new Date('2026-06-21T20:00:00'), null), 'dark');
    assert.equal(resolveTheme('auto', new Date('2026-06-21T12:00:00'), null), 'light');
  });
});

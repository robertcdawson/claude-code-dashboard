// Sun position math (NOAA / Astronomical Almanac solar position formulas —
// the same equations behind NOAA's solar calculator, condensed to the
// handful of terms needed for sunrise/sunset). Pure functions, no DOM and no
// `Date.now()`/`new Date()` calls of its own, so it's usable from both the
// browser (as a plain <script>, exposing window.SunMath) and from node:test
// (via require) with a fully deterministic clock passed in by the caller.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SunMath = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const RAD = Math.PI / 180;
  const DAY_MS = 1000 * 60 * 60 * 24;
  const J1970 = 2440588;
  const J2000 = 2451545;
  const OBLIQUITY = RAD * 23.4397;

  const toJulian = (date) => date.valueOf() / DAY_MS - 0.5 + J1970;
  const fromJulian = (j) => new Date((j + 0.5 - J1970) * DAY_MS);
  const toDays = (date) => toJulian(date) - J2000;

  const declination = (l) => Math.asin(Math.sin(l) * Math.sin(OBLIQUITY));
  const solarMeanAnomaly = (d) => RAD * (357.5291 + 0.98560028 * d);
  const eclipticLongitude = (m) => {
    const c = RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m));
    const p = RAD * 102.9372;
    return m + c + p + Math.PI;
  };
  const julianCycle = (d, lw) => Math.round(d - 0.0009 - lw / (2 * Math.PI));
  const approxTransit = (ht, lw, n) => 0.0009 + (ht + lw) / (2 * Math.PI) + n;
  const solarTransitJ = (ds, m, l) => J2000 + ds + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l);
  const hourAngle = (h, phi, d) => Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d)));

  // Sunrise/sunset for the UTC calendar day containing `date`, at (lat, lon).
  // Returns null for polar day/night, where the sun never crosses the
  // -0.833° horizon altitude used for the standard sunrise/sunset definition.
  function computeSunTimes(lat, lon, date) {
    const lw = RAD * -lon;
    const phi = RAD * lat;
    const d = toDays(date);
    const n = julianCycle(d, lw);
    const ds = approxTransit(0, lw, n);
    const m = solarMeanAnomaly(ds);
    const l = eclipticLongitude(m);
    const dec = declination(l);

    const h0 = RAD * -0.833;
    const w0 = hourAngle(h0, phi, dec);
    if (Number.isNaN(w0)) return null;

    const aSet = approxTransit(w0, lw, n);
    const jSet = solarTransitJ(aSet, m, l);
    const jNoon = solarTransitJ(ds, m, l);
    const jRise = jNoon - (jSet - jNoon);

    return { sunrise: fromJulian(jRise), sunset: fromJulian(jSet) };
  }

  // Fallback window used when geolocation is unavailable or denied.
  function fallbackIsDark(date) {
    const h = date.getHours();
    return h >= 19 || h < 7;
  }

  function isDark(date, lat, lon) {
    if (lat == null || lon == null) return fallbackIsDark(date);
    const today = computeSunTimes(lat, lon, date);
    if (!today) return fallbackIsDark(date);
    return date < today.sunrise || date >= today.sunset;
  }

  // The next moment the day/night state flips, so callers can schedule a
  // single timer instead of polling.
  function nextBoundary(date, lat, lon) {
    if (lat == null || lon == null) {
      const next = new Date(date);
      next.setMinutes(0, 0, 0);
      const targetHour = fallbackIsDark(date) ? 7 : 19;
      next.setHours(targetHour);
      if (next <= date) next.setDate(next.getDate() + 1);
      return next;
    }
    const today = computeSunTimes(lat, lon, date);
    if (!today) return new Date(date.getTime() + DAY_MS); // polar day/night: re-check tomorrow
    if (date < today.sunrise) return today.sunrise;
    if (date < today.sunset) return today.sunset;
    const tomorrow = computeSunTimes(lat, lon, new Date(date.getTime() + DAY_MS));
    return tomorrow ? tomorrow.sunrise : new Date(date.getTime() + DAY_MS);
  }

  return { computeSunTimes, isDark, nextBoundary };
});

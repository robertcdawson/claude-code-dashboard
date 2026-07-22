// Three-way theme setting (Auto/Light/Dark) with a sun-scheduled Auto mode.
// The decision logic (resolveTheme) is a pure function so it's unit-testable
// without a browser; everything below it is DOM/localStorage wiring that
// only runs when a `window` exists.
(function (root, factory) {
  const mod = factory(typeof require === 'function' ? require('./sun-math.js') : root.SunMath);
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.AttentionTheme = mod;
  }
})(typeof self !== 'undefined' ? self : this, function (SunMath) {
  const SETTING_KEY = 'attention-router-theme';
  const COORDS_KEY = 'attention-router-coords';

  function resolveTheme(setting, date, coords) {
    if (setting === 'light' || setting === 'dark') return setting;
    const lat = coords ? coords.lat : null;
    const lon = coords ? coords.lon : null;
    return SunMath.isDark(date, lat, lon) ? 'dark' : 'light';
  }

  function api() {
    const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';
    let timer = null;

    function getSetting() {
      if (!hasDom) return 'auto';
      return window.localStorage.getItem(SETTING_KEY) || 'auto';
    }

    function setSetting(value) {
      if (!hasDom) return;
      window.localStorage.setItem(SETTING_KEY, value);
      evaluate();
    }

    function getCachedCoords() {
      if (!hasDom) return null;
      try {
        return JSON.parse(window.localStorage.getItem(COORDS_KEY) || 'null');
      } catch {
        return null;
      }
    }

    function requestCoords() {
      return new Promise((resolve) => {
        if (!hasDom || !navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
            window.localStorage.setItem(COORDS_KEY, JSON.stringify(coords));
            resolve(coords);
          },
          () => resolve(null),
          { timeout: 8000, maximumAge: 1000 * 60 * 60 * 24 }
        );
      });
    }

    function applyTheme(theme) {
      if (!hasDom) return;
      document.documentElement.setAttribute('data-theme', theme);
      const meta = document.querySelector('meta[name="color-scheme"]');
      if (meta) meta.setAttribute('content', theme === 'dark' ? 'dark light' : 'light dark');
      document.dispatchEvent(new CustomEvent('attention-theme-change', { detail: { theme } }));
    }

    async function evaluate() {
      const setting = getSetting();
      let coords = getCachedCoords();
      if (setting === 'auto' && !coords) coords = await requestCoords();
      const theme = resolveTheme(setting, new Date(), coords);
      applyTheme(theme);

      if (timer) clearTimeout(timer);
      if (setting === 'auto') {
        const next = SunMath.nextBoundary(new Date(), coords ? coords.lat : null, coords ? coords.lon : null);
        const delay = Math.max(1000, next.getTime() - Date.now());
        timer = setTimeout(evaluate, Math.min(delay, 2147483647));
      }
    }

    function cycleSetting() {
      const order = ['auto', 'light', 'dark'];
      const next = order[(order.indexOf(getSetting()) + 1) % order.length];
      setSetting(next);
      return next;
    }

    return { getSetting, setSetting, cycleSetting, evaluate, resolveTheme };
  }

  return Object.assign({ resolveTheme }, typeof window !== 'undefined' ? api() : {});
});

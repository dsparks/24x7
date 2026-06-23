/* Shared helpers for 24x7 and Ebb. Keep this small: only primitives that both
 * apps need and that are easy to drift when copied. */
(function(){
  const pad2 = n => String(n).padStart(2, '0');
  const ymdParts = p => `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;

  function forecastMeta(j){
    const offset = Number(j?.utc_offset_seconds);
    return {
      timezone: j?.timezone || null,
      offset: Number.isFinite(offset) ? offset : null,
    };
  }

  function partsInZone(date, timeZone){
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(date).reduce((out, p) => (out[p.type] = p.value, out), {});
    let hour = +parts.hour;
    if (hour === 24) hour = 0;
    return { year: +parts.year, month: +parts.month, day: +parts.day, hour, minute: +parts.minute };
  }

  function forecastNow(meta){
    const d = new Date();
    if (meta?.timezone){
      try {
        const p = partsInZone(d, meta.timezone);
        return { ...p, key: ymdParts(p) };
      } catch {}
    }
    if (Number.isFinite(meta?.offset)){
      const z = new Date(Date.now() + meta.offset * 1000);
      const p = { year: z.getUTCFullYear(), month: z.getUTCMonth() + 1, day: z.getUTCDate(), hour: z.getUTCHours(), minute: z.getUTCMinutes() };
      return { ...p, key: ymdParts(p) };
    }
    const p = { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
    return { ...p, key: ymdParts(p) };
  }

  function hourFromLocalIso(s){
    if (!s) return null;
    const h = +s.slice(11, 13), m = +s.slice(14, 16);
    return Number.isFinite(h) ? h + (Number.isFinite(m) ? m : 0) / 60 : null;
  }

  async function fetchJson(url, opts = {}){
    const { timeoutMs = 15000, label = 'Request', signal, ...fetchOpts } = opts;
    const ctrl = new AbortController();
    const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : 0;
    if (signal){
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    try {
      const res = await fetch(url, { ...fetchOpts, signal: ctrl.signal });
      if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function readJson(key){
    try { return JSON.parse(localStorage.getItem(key) || 'null'); }
    catch { return null; }
  }

  function writeJson(key, value){
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  }

  function coordsMatch(a, b, tol = 0.01){
    return !!(a && b && Number.isFinite(+a.lat) && Number.isFinite(+a.lon) &&
      Math.abs(+a.lat - +b.lat) < tol && Math.abs(+a.lon - +b.lon) < tol);
  }

  function cacheMatches(cache, lat, lon, tol = 0.01){
    return !!(cache?.json && coordsMatch(cache, { lat, lon }, tol));
  }

  function formatUpdated(t, prefix = 'Updated'){
    return t ? `${prefix} ${new Date(t).toLocaleString([], { weekday:'short', hour:'numeric', minute:'2-digit' })}` : `${prefix} -`;
  }

  function registerFreshServiceWorker(script = 'sw.js'){
    if (!('serviceWorker' in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || refreshing) return;
      refreshing = true;
      location.reload();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(script, { updateViaCache: 'none' })
        .then(reg => {
          reg.update().catch(() => {});
          if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          reg.addEventListener('updatefound', () => {
            const worker = reg.installing;
            if (!worker) return;
            worker.addEventListener('statechange', () => {
              if (worker.state === 'installed' && navigator.serviceWorker.controller){
                worker.postMessage({ type: 'SKIP_WAITING' });
              }
            });
          });
        })
        .catch(() => {});
    });
  }

  window.AppCore = {
    pad2, ymdParts, forecastMeta, forecastNow, hourFromLocalIso,
    fetchJson, readJson, writeJson, coordsMatch, cacheMatches,
    formatUpdated, registerFreshServiceWorker,
  };
})();

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

  function canvasBlob(canvas, type = 'image/png', quality){
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not create the image')), type, quality);
    });
  }

  function roundedRect(ctx, x, y, w, h, r){
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawSnapshotLabel(ctx, width, height, text){
    const size = Math.max(15, Math.min(26, Math.round(Math.min(width, height) * 0.035)));
    const padX = Math.round(size * 0.7), padY = Math.round(size * 0.42);
    const margin = Math.max(8, Math.round(size * 0.5));
    ctx.save();
    ctx.font = `700 ${size}px "Cascadia Mono","Cascadia Code",ui-monospace,monospace`;
    ctx.textBaseline = 'middle';
    const maxText = width - margin * 2 - padX * 2;
    let label = text;
    while (label.length > 4 && ctx.measureText(label + '…').width > maxText) label = label.slice(0, -1);
    if (label !== text) label += '…';
    const w = Math.min(width - margin * 2, Math.ceil(ctx.measureText(label).width + padX * 2));
    const h = Math.ceil(size + padY * 2);
    const x = width - margin - w, y = height - margin - h;
    ctx.shadowColor = 'rgba(0,0,0,.6)';
    ctx.shadowBlur = Math.round(size * 0.55);
    ctx.fillStyle = 'rgba(0,0,0,.78)';
    roundedRect(ctx, x, y, w, h, Math.round(size * 0.28));
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + padX, y + h / 2);
    ctx.restore();
  }

  function localizeStylesheets(){
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')){
      if (link.dataset.localStylesheet === '1') continue;
      try {
        const base = link.href;
        const css = [...link.sheet.cssRules].map(rule => rule.cssText).join('\n')
          .replace(/url\((['"]?)(?!data:|blob:|https?:|\/|#)([^'")]+)\1\)/gi,
            (_, quote, path) => `url("${new URL(path, base).href}")`);
        const style = document.createElement('style');
        style.dataset.localStylesheet = '1';
        style.textContent = css;
        link.before(style);
        link.dataset.localStylesheet = '1';
        link.disabled = true;
      } catch {
        // Leave cross-origin stylesheets alone; their cssRules are not readable.
      }
    }
  }

  function gridReadyForSnapshot(grid){
    if (!grid || grid.classList.contains('loading')) return false;
    const cells = grid.querySelectorAll('.cell');
    if (cells.length !== 168) return false;
    const rect = grid.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const hour = grid.querySelector('.head.hour');
    if (!hour) return false;
    const style = getComputedStyle(hour);
    return style.display !== 'inline' && parseFloat(style.fontSize) >= 7;
  }

  async function captureGridSnapshot(grid, overlays, label, snapshotClass, beforeCapture, afterCapture){
    if (!gridReadyForSnapshot(grid)) throw new Error('The grid is not ready yet');
    if (!window.html2canvas) throw new Error('Screenshot renderer unavailable');
    try {
      if (typeof beforeCapture === 'function') await beforeCapture();
      await document.fonts?.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!gridReadyForSnapshot(grid)) throw new Error('The grid changed while preparing the screenshot');
      const rect = grid.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      // CSS-pixel resolution is ample for a dense grid and is dramatically faster
      // than re-rendering the whole screen at a phone's 2x/3x device pixel ratio.
      const scale = 1;
      localizeStylesheets();
      const canvas = await window.html2canvas(grid, {
        backgroundColor: getComputedStyle(grid).backgroundColor || '#000',
        scale,
        logging: false,
        removeContainer: true,
        useCORS: true,
        onclone: clonedDoc => {
          if (!snapshotClass) return;
          const clonedGrid = grid.id ? clonedDoc.getElementById(grid.id) : null;
          clonedGrid?.classList.add(snapshotClass);
        },
      });
      const ctx = canvas.getContext('2d');
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      for (const overlay of overlays || []){
        if (!overlay?.width || !overlay?.height) continue;
        const r = overlay.getBoundingClientRect();
        ctx.drawImage(overlay, r.left - rect.left, r.top - rect.top, r.width, r.height);
      }
      drawSnapshotLabel(ctx, width, height, label);
      return canvasBlob(canvas);
    } finally {
      if (typeof afterCapture === 'function') await afterCapture();
    }
  }

  function safeFilename(value){
    return String(value || 'weather').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'weather';
  }

  function showToast(message){
    document.querySelector('.share-toast')?.remove();
    const toast = document.createElement('div');
    toast.className = 'share-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2600);
  }

  async function createGridSnapshotFile(opts){
    const { grid, overlays = [], appName, placeName, url, filenamePrefix = appName, snapshotClass = '', beforeCapture = null, afterCapture = null } = opts;
    const place = placeName && placeName !== '—' ? placeName : 'Current location';
    const label = `${appName} · ${place}`;
    const blob = await captureGridSnapshot(grid, overlays, label, snapshotClass, beforeCapture, afterCapture);
    return new File([blob], `${safeFilename(filenamePrefix)}-${safeFilename(place)}.png`, { type: 'image/png' });
  }

  async function shareSnapshotFile(file, opts){
    const { appName, placeName, url } = opts;
    const place = placeName && placeName !== '—' ? placeName : 'Current location';
    const label = `${appName} · ${place}`;
    const data = { files: [file], title: label, text: `${label}\n${url}`, url };
    if (navigator.share && navigator.canShare?.({ files: [file] })){
      await navigator.share(data);
      return 'shared';
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = file.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      showToast('Screenshot saved');
      return 'downloaded';
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }
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
    formatUpdated, createGridSnapshotFile, shareSnapshotFile, showToast, registerFreshServiceWorker,
  };
})();

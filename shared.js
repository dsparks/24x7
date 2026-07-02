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

  const zoneFormatters = new Map();          // timeZone -> Intl.DateTimeFormat (reused: creation is ~ms, format is ~µs)
  function zoneFormatter(timeZone){
    let f = zoneFormatters.get(timeZone);
    if (!f){
      f = new Intl.DateTimeFormat('en-US', {
        timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      zoneFormatters.set(timeZone, f);
    }
    return f;
  }
  function partsInZone(date, timeZone){
    const parts = zoneFormatter(timeZone).formatToParts(date)
      .reduce((out, p) => (out[p.type] = p.value, out), {});
    let hour = +parts.hour;
    if (hour === 24) hour = 0;
    return { year: +parts.year, month: +parts.month, day: +parts.day, hour, minute: +parts.minute };
  }

  /* Wall-clock parts of an instant in the forecast's zone. The IANA path tracks
   * DST correctly; the fixed-offset path is a fallback for engines without the
   * zone data (it can be an hour off across a transition — acceptable, rare). */
  function instantParts(date, meta){
    if (meta?.timezone){
      try {
        const p = partsInZone(date, meta.timezone);
        return { ...p, key: ymdParts(p) };
      } catch {}
    }
    if (Number.isFinite(meta?.offset)){
      const z = new Date(date.getTime() + meta.offset * 1000);
      const p = { year: z.getUTCFullYear(), month: z.getUTCMonth() + 1, day: z.getUTCDate(), hour: z.getUTCHours(), minute: z.getUTCMinutes() };
      return { ...p, key: ymdParts(p) };
    }
    const p = { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes() };
    return { ...p, key: ymdParts(p) };
  }
  function forecastNow(meta){ return instantParts(new Date(), meta); }
  const epochParts = (epochSec, meta) => instantParts(new Date(epochSec * 1000), meta);

  function hourFromLocalIso(s){
    if (!s) return null;
    const h = +s.slice(11, 13), m = +s.slice(14, 16);
    return Number.isFinite(h) ? h + (Number.isFinite(m) ? m : 0) / 60 : null;
  }

  async function fetchJson(url, opts = {}){
    const { timeoutMs = 15000, label = 'Request', signal, ...fetchOpts } = opts;
    const ctrl = new AbortController();
    // A timeout aborts with name 'TimeoutError' so callers can tell "the network
    // is slow" (worth surfacing) apart from "the caller cancelled" (silent).
    const timer = timeoutMs ? setTimeout(() => ctrl.abort(new DOMException(`${label} timed out`, 'TimeoutError')), timeoutMs) : 0;
    const onAbort = () => ctrl.abort(signal.reason);
    if (signal){
      if (signal.aborted) ctrl.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await fetch(url, { ...fetchOpts, signal: ctrl.signal });
      if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      // Some engines reject with a generic AbortError even when abort(reason)
      // carried one; normalize so the reason (and its name) always surfaces.
      if (err?.name === 'AbortError' && ctrl.signal.reason instanceof DOMException) throw ctrl.signal.reason;
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
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

  let screenshotRendererPromise = null;
  function ensureScreenshotRenderer(){
    if (window.html2canvas) return Promise.resolve();
    if (screenshotRendererPromise) return screenshotRendererPromise;
    screenshotRendererPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('html2canvas.min.js', document.baseURI).href;
      script.async = true;
      script.onload = () => window.html2canvas ? resolve() : reject(new Error('Screenshot renderer unavailable'));
      script.onerror = () => reject(new Error('Could not load screenshot renderer'));
      document.head.appendChild(script);
    }).catch(err => {
      screenshotRendererPromise = null;
      throw err;
    });
    return screenshotRendererPromise;
  }

  async function captureGridSnapshot(grid, overlays, label, snapshotClass, beforeCapture, afterCapture){
    if (!gridReadyForSnapshot(grid)) throw new Error('The grid is not ready yet');
    await ensureScreenshotRenderer();
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
      try {
        await navigator.share(data);
        return 'shared';
      } catch (err) {
        // Expired user activation (the snapshot build took too long) → save the
        // file instead of failing. A real user cancel stays an AbortError.
        if (err?.name !== 'NotAllowedError') throw err;
      }
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

  /* ---------- Movable popups (tip, legend) ----------
   * Drag to reposition; double-tap or long-press resets; single tap forwards to
   * onTap when provided. Position persistence is delegated to getSaved/save so
   * each app keeps its own settings shape. */
  function clampPopupPoint(el, x, y){
    const r = el.getBoundingClientRect(), m = 8;
    const halfW = Math.min(r.width / 2 || 0, Math.max(0, innerWidth / 2 - m));
    const halfH = Math.min(r.height / 2 || 0, Math.max(0, innerHeight / 2 - m));
    return { x: Math.max(m + halfW, Math.min(innerWidth - m - halfW, x)), y: Math.max(m + halfH, Math.min(innerHeight - m - halfH, y)) };
  }
  function setPopupPoint(el, x, y){
    const p = clampPopupPoint(el, x, y);
    el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
    el.style.right = 'auto'; el.style.bottom = 'auto';
    el.style.transform = 'translate(-50%,-50%)';
  }
  function rectsOverlap(a, b, pad = 0){
    return a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;
  }
  function keepPopupOffRect(el, avoidRect){
    if (!avoidRect) return;
    const pr = el.getBoundingClientRect();
    if (!rectsOverlap(pr, avoidRect, 8)) return;
    const current = { x: pr.left + pr.width / 2, y: pr.top + pr.height / 2 };
    const gap = 12, cx = avoidRect.left + avoidRect.width / 2, cy = avoidRect.top + avoidRect.height / 2;
    const raw = [
      { x: cx, y: avoidRect.top - pr.height / 2 - gap },
      { x: cx, y: avoidRect.bottom + pr.height / 2 + gap },
      { x: avoidRect.left - pr.width / 2 - gap, y: cy },
      { x: avoidRect.right + pr.width / 2 + gap, y: cy },
      { x: avoidRect.left - pr.width / 2 - gap, y: avoidRect.top - pr.height / 2 - gap },
      { x: avoidRect.right + pr.width / 2 + gap, y: avoidRect.top - pr.height / 2 - gap },
      { x: avoidRect.left - pr.width / 2 - gap, y: avoidRect.bottom + pr.height / 2 + gap },
      { x: avoidRect.right + pr.width / 2 + gap, y: avoidRect.bottom + pr.height / 2 + gap },
    ];
    const choices = raw.map(p => {
      const c = clampPopupPoint(el, p.x, p.y);
      const r = { left: c.x - pr.width / 2, right: c.x + pr.width / 2, top: c.y - pr.height / 2, bottom: c.y + pr.height / 2 };
      return { ...c, overlaps: rectsOverlap(r, avoidRect, 8), dist: Math.hypot(c.x - current.x, c.y - current.y) };
    });
    const best = choices.filter(c => !c.overlaps).sort((a, b) => a.dist - b.dist)[0] || choices.sort((a, b) => b.dist - a.dist)[0];
    if (best) setPopupPoint(el, best.x, best.y);
  }
  function makeDraggablePopup(opts){
    const { el, getSaved, save, fallback = null, beforeDrag = null, afterDrag = null, onTap = null } = opts;
    const TAP_SLOP = 8, HOLD_MS = 650;
    let drag = null, lastTap = 0, holdTimer = 0;
    function applyPosition(){
      const p = getSaved() || fallback;
      if (p) setPopupPoint(el, p.x * innerWidth, p.y * innerHeight);
    }
    function reset(){
      save(null);
      if (fallback) setPopupPoint(el, fallback.x * innerWidth, fallback.y * innerHeight);
      else { el.style.left = el.style.top = el.style.right = el.style.bottom = el.style.transform = ''; }
    }
    el.addEventListener('pointerdown', e => {
      if (e.button != null && e.button !== 0) return;
      beforeDrag?.();
      const r = el.getBoundingClientRect();
      drag = { sx: e.clientX, sy: e.clientY, dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2), moved: false, reset: false };
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => { if (!drag || drag.moved) return; reset(); drag.reset = true; lastTap = 0; }, HOLD_MS);
      el.classList.add('dragging'); el.setPointerCapture?.(e.pointerId);
      e.preventDefault(); e.stopPropagation();
    });
    el.addEventListener('pointermove', e => {
      if (!drag) return;
      if (drag.reset){ e.preventDefault(); e.stopPropagation(); return; }
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > TAP_SLOP){ drag.moved = true; clearTimeout(holdTimer); }
      if (!drag.moved){ e.preventDefault(); e.stopPropagation(); return; }
      setPopupPoint(el, e.clientX - drag.dx, e.clientY - drag.dy);
      e.preventDefault(); e.stopPropagation();
    });
    function finish(e){
      if (!drag) return;
      clearTimeout(holdTimer);
      const now = performance.now();
      const doubleTap = !onTap && !drag.moved && now - lastTap < 320;
      const tapped = !drag.moved && !drag.reset && !doubleTap;
      if (drag.reset){ /* long-press already reset it */ }
      else if (tapped && onTap) onTap();
      else if (doubleTap) reset();
      else {
        const r = el.getBoundingClientRect();
        save({ x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight });
      }
      el.classList.remove('dragging'); el.releasePointerCapture?.(e.pointerId);
      const moved = drag.moved, wasReset = drag.reset;
      drag = null;
      lastTap = wasReset || doubleTap || moved ? 0 : now;
      afterDrag?.(moved);
      e.preventDefault(); e.stopPropagation();
    }
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    el.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
    return { applyPosition, reset };
  }

  /* ---------- Grid gestures + swipe carousel ----------
   * One engine for both apps: tap → onTap(cell), optional long-press, and a real
   * drag-a-neighbor-in carousel. The axis is detected ONCE per gesture and stays
   * fixed; an axis the app doesn't support becomes a dead drag (never a tap on
   * release), which is what a vertical drag on Ebb should be.
   * mountGhost(axis, dir, rect) supplies a fully-mounted neighbor pane (or null);
   * the carousel owns every transform and removal. onCommit(axis, dir) performs
   * the app-level switch AFTER transforms are cleared, so the render that follows
   * measures clean, untranslated geometry. */
  function createGridCarousel(opts){
    const {
      gridEl, fxEls = () => [], axes = () => ['x'], canSwipe = () => true,
      mountGhost = () => null, onCommit, onTap = null, onLongPress = null,
    } = opts;
    const SWIPE_PREP_PX = 5, SWIPE_START_PX = 10, EASE = 'cubic-bezier(.22,.61,.36,1)', COMMIT_MS = 140;
    let lpTimer = 0, lpFired = false, swiped = false, pointerActive = false, sx = 0, sy = 0;
    let dragAxis = null, axisLive = false, dragOff = 0, dragSize = 0, cleanupT = 0, pendingFinish = null;
    let ghostPrev = null, ghostNext = null, suppressUntil = 0;

    const fxVisible = on => { for (const el of fxEls()) el.style.opacity = on ? '' : '0'; };
    function slideTransform(el, px, ms){
      el.style.transition = ms ? `transform ${ms}ms ${EASE}` : 'none';
      el.style.transform = dragAxis === 'x' ? `translate3d(${px}px,0,0)` : `translate3d(0,${px}px,0)`;
    }
    function applyDrag(off, ms){
      for (const el of [gridEl, ...fxEls()]) slideTransform(el, off, ms);
      if (ghostPrev) slideTransform(ghostPrev, -dragSize + off, ms);
      if (ghostNext) slideTransform(ghostNext, dragSize + off, ms);
    }
    function destroyGhosts(){ ghostPrev?.remove(); ghostNext?.remove(); ghostPrev = ghostNext = null; }
    function resetSlide(){
      dragAxis = null; axisLive = false;
      gridEl.classList.remove('swiping');
      for (const el of [gridEl, ...fxEls()]){ el.style.transition = ''; el.style.transform = ''; }
      destroyGhosts(); fxVisible(true); pendingFinish = null;
    }
    function buildCarousel(axis){
      const rect = gridEl.getBoundingClientRect();
      dragSize = axis === 'x' ? rect.width : rect.height;
      ghostPrev = mountGhost(axis, -1, rect);
      ghostNext = mountGhost(axis, 1, rect);
      if (ghostPrev) slideTransform(ghostPrev, -dragSize);
      if (ghostNext) slideTransform(ghostNext, dragSize);
    }
    function slideCommit(axis, dir){
      fxVisible(false);                            // current pane's particles exit quietly
      applyDrag(dir < 0 ? -dragSize : dragSize, COMMIT_MS);
      pendingFinish = () => {
        pendingFinish = null;
        resetSlide();                              // clear transforms FIRST so onCommit's render measures clean geometry
        onCommit(axis, dir);
      };
      clearTimeout(cleanupT);
      cleanupT = setTimeout(() => pendingFinish && pendingFinish(), COMMIT_MS + 10);
    }
    gridEl.addEventListener('pointerdown', e => {
      pointerActive = true;
      clearTimeout(cleanupT);
      if (pendingFinish) pendingFinish();          // re-touch mid-commit → finish the switch, don't drop it
      else if (ghostPrev || ghostNext) resetSlide();
      lpFired = false; swiped = false; dragAxis = null; axisLive = false; dragOff = 0;
      sx = e.clientX; sy = e.clientY;
      clearTimeout(lpTimer);
      if (onLongPress) lpTimer = setTimeout(() => { lpFired = true; onLongPress(); }, 480);
    });
    gridEl.addEventListener('pointermove', e => {
      if (!pointerActive) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!dragAxis){
        if (lpFired) return;
        if (Math.abs(dx) < SWIPE_PREP_PX && Math.abs(dy) < SWIPE_PREP_PX) return;
        clearTimeout(lpTimer);
        dragAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
        axisLive = axes().includes(dragAxis);       // unsupported axis: dead drag — no carousel, no tap on release
        if (axisLive){
          dragSize = dragAxis === 'x' ? gridEl.clientWidth : gridEl.clientHeight;
          if (canSwipe(dragAxis)) buildCarousel(dragAxis);
        }
      }
      if (!swiped){
        const primary = Math.abs(dragAxis === 'x' ? dx : dy);
        if (primary < SWIPE_START_PX) return;
        swiped = true;                             // suppress the tap-to-readout click
        gridEl.classList.add('swiping');
        try { gridEl.setPointerCapture(e.pointerId); } catch {}
      }
      if (!axisLive) return;
      let off = dragAxis === 'x' ? dx : dy;
      if (!canSwipe(dragAxis)) off *= 0.2;         // nowhere to go → rubber-band
      dragOff = off;
      applyDrag(off, 0);
    });
    function endDrag(e){
      if (!pointerActive) return;
      pointerActive = false;
      clearTimeout(lpTimer);
      try { gridEl.releasePointerCapture(e.pointerId); } catch {}
      if (!dragAxis){
        // Resolve the cell at release time. A tap can begin while slideCommit()
        // replaces the old grid, in which case browsers commonly discard `click`
        // because its pointerdown target no longer exists.
        if (!lpFired && onTap){
          const c = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cell');
          if (c && gridEl.contains(c) && !c.classList.contains('empty')){
            suppressUntil = performance.now() + 350;
            onTap(c);
          }
        }
        return;
      }
      if (!swiped){ resetSlide(); return; }
      // A drag's synthetic click (when the browser emits one) fires before the
      // next task. Clear the guard afterward too, so browsers that suppress that
      // click do not make the next real tap pay for the preceding swipe.
      setTimeout(() => { swiped = false; }, 0);
      if (!axisLive){ dragAxis = null; return; }
      const axis = dragAxis, off = dragOff;
      if (canSwipe(axis) && Math.abs(off) > Math.min(90, dragSize * 0.22)){
        slideCommit(axis, off < 0 ? -1 : 1);
      } else {
        applyDrag(0, COMMIT_MS);                   // spring back
        clearTimeout(cleanupT);
        cleanupT = setTimeout(resetSlide, COMMIT_MS + 20);
      }
    }
    gridEl.addEventListener('pointerup', endDrag);
    gridEl.addEventListener('pointercancel', endDrag);
    gridEl.addEventListener('click', e => {
      if (performance.now() < suppressUntil) return;
      if (lpFired || swiped){ lpFired = false; swiped = false; return; }   // long-press/swipe: not a tap
      const c = e.target.closest('.cell');
      if (!c || c.classList.contains('empty') || !onTap) return;
      onTap(c);
    });
    return {
      suppressTaps(ms = 350){ suppressUntil = performance.now() + ms; },
    };
  }

  /* ---------- Share manager ----------
   * Builds the html2canvas snapshot ON DEMAND (first Share tap) instead of on
   * every sheet open, caches it per revision, and shares or downloads it. */
  function createShareManager(opts){
    const {
      button, grid, appName, url, filenamePrefix, snapshotClass = '',
      overlays = () => [], placeName = () => '', ready = () => true,
      beforeCapture = null, afterCapture = null, onShareStart = null,
    } = opts;
    let file = null, revision = 0, builtRevision = -1, busy = false;
    const idleLabel = button.textContent;
    function sync(){ if (!busy) button.disabled = !ready(); }
    function invalidate(){ revision++; file = null; builtRevision = -1; sync(); }
    async function build(){
      if (file && builtRevision === revision) return file;
      const rev = revision;
      const built = await createGridSnapshotFile({
        grid, overlays: overlays(), appName, placeName: placeName(),
        filenamePrefix, snapshotClass, beforeCapture, afterCapture,
      });
      if (rev !== revision) return null;           // data changed mid-build → stale snapshot
      file = built; builtRevision = rev;
      return file;
    }
    button.addEventListener('click', async () => {
      if (busy || !ready()) return;
      busy = true;
      button.disabled = true;
      button.textContent = 'Preparing…';
      try {
        let snapshot = await build();
        if (!snapshot) snapshot = await build();   // one retry if a refresh landed mid-build
        if (!snapshot) throw new Error('Snapshot went stale');
        onShareStart?.();
        await shareSnapshotFile(snapshot, { appName, placeName: placeName(), url });
      } catch (err) {
        if (err?.name !== 'AbortError'){
          console.warn(err);
          showToast('Couldn’t create the screenshot');
        }
      } finally {
        busy = false;
        button.textContent = idleLabel;
        sync();
      }
    });
    sync();
    return { invalidate, sync };
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
    const register = () => {
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
    };
    window.addEventListener('load', () => {
      // Keep first paint, forecast fetches, and initial animation setup clear of
      // service-worker installation and app-shell prefetch work.
      setTimeout(() => {
        if ('requestIdleCallback' in window) requestIdleCallback(register, { timeout: 3000 });
        else register();
      }, 1500);
    });
  }

  window.AppCore = {
    pad2, ymdParts, forecastMeta, forecastNow, epochParts, hourFromLocalIso,
    fetchJson, readJson, writeJson, coordsMatch, cacheMatches,
    formatUpdated, createGridSnapshotFile, shareSnapshotFile, showToast, registerFreshServiceWorker,
    setPopupPoint, keepPopupOffRect, makeDraggablePopup, createGridCarousel, createShareManager,
  };
})();

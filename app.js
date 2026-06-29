/* 24×7 — your week of weather, one screen.
 * Single-serving, chrome-less hourly temperature + precip grid.
 * Data: Open-Meteo (keyless, global, single request). No build step, no deps.
 */

const APP_NAME = '24×7';          // ← alt names: 'hotmap', 'wgrid'. One-line swap.
const PAGE_PARAMS = new URLSearchParams(location.search);
const BOT_RENDER = PAGE_PARAMS.get('bot') === '1';
const BOT_LABEL = (PAGE_PARAMS.get('label') || '').trim();
if (BOT_RENDER){
  document.body.classList.add('bot-render');
  window.__24x7Bot = { status: 'loading' };
}
const LS = {
  settings: 'grid.settings',
  cache:    'grid.cache',         // last forecast payload, for instant paint
  coach:    'grid.coach',         // '1' once the first-run gesture hints are dismissed
};

/* ---------- Settings ---------- */
const DEFAULTS = {
  view: 'temp',         // 'temp' | 'run'
  palette: 'noaa',      // 'noaa' | 'inferno'  (temperature view)
  unit: 'auto',         // 'auto' | 'f' | 'c'
  clock: 'auto',        // 'auto' | '12' | '24'
  showNumbers: true,
  nightMax: 0.75,       // peak night-shade darkness (0–1)
  runCurves: null,      // per-dimension preference curves (validated in loadSettings)
  popupPos: null,       // remembered popup centers as viewport fractions: { legend:{x,y}, tip:{x,y} }
  places: [],           // saved locations [{ lat, lon, name, admin }]
  activeIdx: null,      // index into places, or null = use my location
};

/* ---------- Run Index model ----------
 * Each dimension maps a weather value to a 0–1 "score" via a user-drawn preference
 * curve (control points every `step` from min→max). The hourly run index is the
 * geometric mean of the available dimension scores, so any one "avoid" tanks it
 * while everything "fine" lands mid-scale. def[] are the 0–1 starting points. */
const RUN_DIMS = [
  { key: 'temp', label: 'Temperature', unit: '°F', min: 0, max: 100, step: 10,
    value: c => cToF(c.c), def: [0, 0, 0, 1/6, 4/6, 1, 1, 5/6, 3/6, 1/6, 0] },
  { key: 'dew', label: 'Dew point', unit: '°F', min: 30, max: 80, step: 5,
    value: c => c.dewF, def: [1, 1, 1, 1, 1, 1, 5/6, 4/6, 2/6, 1/6, 0] },
  { key: 'wind', label: 'Wind speed', unit: 'mph', min: 0, max: 40, step: 5,
    value: c => c.windMph, def: [1, 1, 5/6, 4/6, 2/6, 2/6, 1/6, 1/6, 0] },
  { key: 'pop', label: 'Precip chance', unit: '%', min: 0, max: 100, step: 10,
    value: c => c.pop, def: [1, 1, 1, 4/6, 3/6, 2/6, 2/6, 1/6, 1/6, 1/6, 0] },
  { key: 'intensity', label: 'Precip intensity', unit: '', min: 0, max: 5, step: 1,
    value: c => precipLevel(c), def: [1, 5/6, 1/6, 1/6, 1/6, 0],
    ticks: ['none', 'mist', 'driz', 'light', 'mod', 'heavy'] },
];
const dimPoints = d => (d.max - d.min) / d.step + 1;

/* Y-axis snap tiers (also drawn as guide lines). 7 detents 0–6; only 0/3/6 labeled.
 * `y` is the 0–1 score; edit this list to change snap points or labels. */
const TIERS = [
  { y: 0, l: 'avoid' }, { y: 1 / 6, l: '' }, { y: 2 / 6, l: '' }, { y: 3 / 6, l: 'fine' },
  { y: 4 / 6, l: '' }, { y: 5 / 6, l: '' }, { y: 1, l: 'great' },
];
function snapTier(y){
  let best = TIERS[0].y, bd = Infinity;
  for (const t of TIERS){ const d = Math.abs(t.y - y); if (d <= bd){ bd = d; best = t.y; } }  // ties → higher tier
  return best;
}

let settings = loadSettings();

function loadSettings(){
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS.settings) || '{}') }; }
  catch { s = { ...DEFAULTS }; }
  const curves = s.runCurves || {};
  s.runCurves = {};
  for (const d of RUN_DIMS){
    const c = curves[d.key];
    const raw = (Array.isArray(c) && c.length === dimPoints(d)) ? c.map(Number) : d.def;
    s.runCurves[d.key] = raw.map(snapTier);     // align stored values to the snap tiers
  }
  if (!s.popupPos || typeof s.popupPos !== 'object') s.popupPos = {};
  if (!Array.isArray(s.places)) s.places = [];
  if (s.loc){                                    // migrate legacy single manual location
    const dup = s.places.findIndex(p => p.lat === s.loc.lat && p.lon === s.loc.lon);
    if (dup < 0){ s.places.unshift({ lat: s.loc.lat, lon: s.loc.lon, name: s.loc.name, admin: s.loc.admin }); s.activeIdx = 0; }
    else s.activeIdx = dup;
    delete s.loc;
  }
  if (s.activeIdx != null && !(s.activeIdx >= 0 && s.activeIdx < s.places.length)) s.activeIdx = null;
  return s;
}
function saveSettings(){ try { localStorage.setItem(LS.settings, JSON.stringify(settings)); } catch {} }

function precipLevel(cell){ const k = precipKind(cell); return k ? k.level : 0; }
function curveScore(dim, curve, v){
  const t = (Math.max(dim.min, Math.min(dim.max, v)) - dim.min) / dim.step;
  const i = Math.floor(t), f = t - i;
  if (i >= curve.length - 1) return curve[curve.length - 1];
  return curve[i] * (1 - f) + curve[i + 1] * f;
}

/* ---------- Locale helpers ---------- */
const usLocale = () => {
  const l = (navigator.language || 'en-US');
  return /^en-US|^en-AS|^en-GU|^en-MP|^en-PR|^en-UM|^en-VI/i.test(l) || l === 'en';
};
function unitIsF(){ return settings.unit === 'f' || (settings.unit === 'auto' && usLocale()); }
function clock24(){ return settings.clock === '24' || (settings.clock === 'auto' && !usLocale()); }

/* ---------- Forecast-local time helpers ---------- */
const { forecastMeta, hourFromLocalIso } = AppCore;
function forecastNow(meta = currentForecastMeta){ return AppCore.forecastNow(meta); }

/* ---------- Temp conversion + palettes ---------- */
const cToF = c => c * 9 / 5 + 32;
const displayTemp = c => unitIsF() ? cToF(c) : c;
const unitGlyph = () => unitIsF() ? '°F' : '°C';
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const rgbStr = ([r,g,b]) => `rgb(${r},${g},${b})`;

/* Official NWS/NDFD temperature palette, decoded from the graphical-forecast
 * legend swatches (mapservices.weather.noaa.gov · NDFD_temp). [°F, [r,g,b]]. */
const NOAA_STOPS = [
  [-40,[255,230,255]],[-30,[255,222,255]],[-25,[255,201,255]],[-20,[255,148,255]],
  [-15,[255,92,255]],[-10,[255,0,255]],[-5,[204,0,255]],[0,[140,0,255]],
  [5,[81,0,255]],[10,[23,31,255]],[15,[51,88,255]],[20,[59,147,255]],
  [25,[51,194,255]],[30,[23,255,240]],[35,[46,255,182]],[40,[48,255,135]],
  [45,[38,255,78]],[50,[47,255,0]],[55,[119,255,0]],[60,[170,255,0]],
  [65,[221,255,0]],[70,[255,251,0]],[75,[255,217,0]],[80,[255,179,0]],
  [85,[255,149,0]],[90,[245,118,0]],[95,[217,94,0]],[100,[176,56,0]],
  [105,[153,36,0]],[110,[128,0,0]],
];
/* Perceptual colormaps (bids.github.io/colormap), 9 evenly-spaced anchors. */
const INFERNO = [[0,0,4],[31,12,72],[85,15,109],[136,34,106],[186,54,85],[227,89,51],[249,140,10],[249,201,50],[252,255,164]];
const VIRIDIS = [[68,1,84],[72,40,120],[62,73,137],[49,104,142],[38,130,142],[31,158,137],[53,183,121],[110,206,88],[253,231,37]];

function rampStops(stops, f){
  if (f <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (f >= last[0]) return last[1];
  for (let i = 0; i < stops.length - 1; i++){
    if (f >= stops[i][0] && f < stops[i+1][0]){
      const k = (f - stops[i][0]) / (stops[i+1][0] - stops[i][0]), a = stops[i][1], b = stops[i+1][1];
      return [lerp(a[0],b[0],k), lerp(a[1],b[1],k), lerp(a[2],b[2],k)];
    }
  }
  return last;
}
function sample(arr, x){                 // x in 0..1 across evenly-spaced anchors
  x = Math.max(0, Math.min(1, x));
  const n = arr.length - 1, f = x * n, i = Math.floor(f), k = f - i;
  if (i >= n) return arr[n];
  const a = arr[i], b = arr[i+1];
  return [lerp(a[0],b[0],k), lerp(a[1],b[1],k), lerp(a[2],b[2],k)];
}
const INF_LO = -20, INF_HI = 110;        // °F domain for the Inferno temp ramp
function tempRGB(f){
  if (f == null || Number.isNaN(f)) return [17,21,28];
  return settings.palette === 'inferno'
    ? sample(INFERNO, (f - INF_LO) / (INF_HI - INF_LO))
    : rampStops(NOAA_STOPS, f);
}
const runRGB = idx => idx == null ? [17,21,28] : sample(VIRIDIS, idx / 100);

/* Contrast: black by default, white only when it reads better (WCAG luminance). */
function pickInk([r,g,b]){
  const s = v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
  const L = 0.2126*s(r) + 0.7152*s(g) + 0.0722*s(b);
  return (1.05/(L+0.05)) > ((L+0.05)/0.05) ? '#fff' : '#000';
}
const inkRGB = ink => ink === '#fff' ? '255,255,255' : '0,0,0';

/* ---------- Precipitation: probability (opacity) + intensity (style) ---------- */
const mmToIn = mm => mm / 25.4;
// intensity levels 1–5; tuned in CSS via .l1–.l5
const RAIN_LABEL = { 1:'misty', 2:'drizzle', 3:'light rain', 4:'moderate rain', 5:'downpour' };
const SNOW_LABEL = { 1:'flurries', 2:'light snow', 3:'moderate snow', 4:'heavy snow', 5:'heavy snow' };
// WMO thunderstorm codes (95 = thunderstorm; 96/99 = with hail).
const THUNDER_CODES = new Set([95, 96, 99]);
const isThunder = cell => !!cell && THUNDER_CODES.has(cell.wcode);
// WMO freezing-rain codes (66 = light, 67 = heavy). Renders as rain, but flagged.
const FREEZING_RAIN_CODES = new Set([66, 67]);
const isFreezingRain = cell => !!cell && FREEZING_RAIN_CODES.has(cell.wcode);
function precipKind(cell){
  if (!cell) return null;
  const pop = cell.pop || 0;
  if (pop <= 10) return null;
  const inch = mmToIn(cell.precip || 0);
  const isSnow = (cell.snow || 0) > 0;
  const thunder = isThunder(cell);
  const freezing = isFreezingRain(cell);
  if (pop <= 0 && inch <= 0 && !thunder && !freezing) return null;   // nothing to show
  let level;
  if (isSnow){
    const r = inch * 10;                          // ~liquid→snow ratio
    level = r < 0.1 ? 1 : r < 0.3 ? 2 : r < 0.6 ? 3 : 4;
  } else if (inch <= 0){
    level = pop >= 60 ? 2 : 1;                    // chance but no forecast amount
  } else {
    level = inch < 0.02 ? 1 : inch < 0.04 ? 2 : inch < 0.06 ? 3 : inch < 0.10 ? 4 : 5;
  }
  if (thunder && inch <= 0) level = Math.max(level, 3);   // a storm with no forecast amount still reads as real rain
  // Label precedence: a thunderstorm, then freezing rain, then the plain intensity label.
  const label = thunder ? 'thunderstorm'
              : freezing ? 'freezing rain'
              : (isSnow ? SNOW_LABEL : RAIN_LABEL)[level];
  return { level, pop, snow: isSnow, thunder, freezing, label };
}

/* Run Index (stub — refined later). 0 (bad) → 100 (perfect run weather). */
function runIndex(cell){
  // Geometric mean of each dimension's preference score (skip dims with no data).
  // "Avoid" floors at 0.0001 so a single avoid bites hard, and the final score is
  // clamped to a minimum of 1 so the worst-possible hour reads 1 rather than 0.
  let logSum = 0, n = 0;
  for (const dim of RUN_DIMS){
    const v = dim.value(cell);
    if (v == null || Number.isNaN(v)) continue;
    const s = Math.max(0.0001, Math.min(1, curveScore(dim, settings.runCurves[dim.key], v)));
    logSum += Math.log(s); n++;
  }
  if (!n) return 50;
  return Math.max(1, Math.round(100 * Math.exp(logSum / n)));
}
// Debug: per-dimension value → score, for the tap popup.
function runBreakdown(cell){
  return RUN_DIMS.map(dim => {
    const v = dim.value(cell);
    if (v == null || Number.isNaN(v)) return { label: dim.label, val: '—', s: null };
    const s = Math.max(0, Math.min(1, curveScore(dim, settings.runCurves[dim.key], v)));
    const val = dim.ticks
      ? dim.ticks[Math.max(0, Math.min(dim.ticks.length - 1, Math.round(v)))]
      : `${Math.round(v)}${dim.unit || ''}`;
    return { label: dim.label, val, s };
  });
}

/* ---------- Time formatting ---------- */
const WD = ['Su','Mo','Tu','We','Th','Fr','Sa'];
function fmtHour(h){
  if (clock24()) return String(h).padStart(2,'0');
  if (h === 0) return '12a'; if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h-12}p`;
}
function fmtHourLong(h){
  if (clock24()) return `${String(h).padStart(2,'0')}:00`;
  if (h === 0) return '12 AM'; if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h-12} PM`;
}
function fmtClockMinute(hour, minute){
  const h = ((hour % 24) + 24) % 24;
  const m = String(Math.max(0, Math.min(59, Math.round(minute)))).padStart(2, '0');
  if (clock24()) return `${String(h).padStart(2, '0')}:${m}`;
  const ap = h < 12 ? 'AM' : 'PM';
  const hh = h % 12 || 12;
  return `${hh}:${m} ${ap}`;
}

/* ---------- State ---------- */
let currentForecastMeta = null;
let days = [];        // [{ date:Date, label, isToday, cells:[{c,pop,appF,windMph,rh,iso,past,now}|null x24] }]
let place = { name: '—', sub: '' };
let orientation = null;

/* ---------- DOM ---------- */
const $ = sel => document.querySelector(sel);
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));
const gridEl = $('#grid');
const tipEl = $('#tip');
const sheetEl = $('#settings');

function clampPopupPoint(el, x, y){
  const r = el.getBoundingClientRect();
  const margin = 8;
  const halfW = Math.min(r.width / 2 || 0, Math.max(0, innerWidth / 2 - margin));
  const halfH = Math.min(r.height / 2 || 0, Math.max(0, innerHeight / 2 - margin));
  return {
    x: Math.max(margin + halfW, Math.min(innerWidth - margin - halfW, x)),
    y: Math.max(margin + halfH, Math.min(innerHeight - margin - halfH, y)),
  };
}
function setPopupPoint(el, x, y){
  const p = clampPopupPoint(el, x, y);
  el.style.left = p.x + 'px';
  el.style.top = p.y + 'px';
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  el.style.transform = 'translate(-50%,-50%)';
}
function applyPopupPosition(kind, el, fallback){
  const saved = settings.popupPos?.[kind] || fallback;
  if (!saved) return;
  setPopupPoint(el, saved.x * innerWidth, saved.y * innerHeight);
}
function rectsOverlap(a, b, pad = 0){
  return a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;
}
function keepPopupOffRect(el, avoidRect){
  if (!avoidRect) return;
  let pr = el.getBoundingClientRect();
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
function resetPopupPosition(kind, el, fallback){
  delete settings.popupPos[kind];
  saveSettings();
  if (fallback) setPopupPoint(el, fallback.x * innerWidth, fallback.y * innerHeight);
  else {
    el.style.left = '';
    el.style.top = '';
    el.style.right = '';
    el.style.bottom = '';
    el.style.transform = '';
  }
}
function makeDraggablePopup(kind, el, afterDrag, beforeDrag, fallback, onTap){
  let drag = null, lastTap = 0, holdTimer = 0;
  const TAP_SLOP = 8;
  const HOLD_MS = 650;
  el.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return;
    beforeDrag?.();
    const r = el.getBoundingClientRect();
    drag = {
      sx: e.clientX,
      sy: e.clientY,
      dx: e.clientX - (r.left + r.width / 2),
      dy: e.clientY - (r.top + r.height / 2),
      moved: false,
      reset: false,
    };
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      if (!drag || drag.moved) return;
      resetPopupPosition(kind, el, fallback);
      drag.reset = true;
      lastTap = 0;
    }, HOLD_MS);
    el.classList.add('dragging');
    el.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });
  el.addEventListener('pointermove', e => {
    if (!drag) return;
    if (drag.reset){
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const dist = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy);
    if (dist > TAP_SLOP){
      drag.moved = true;
      clearTimeout(holdTimer);
    }
    if (!drag.moved){
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    setPopupPoint(el, e.clientX - drag.dx, e.clientY - drag.dy);
    e.preventDefault();
    e.stopPropagation();
  });
  function finishDrag(e){
    if (!drag) return;
    clearTimeout(holdTimer);
    const now = performance.now();
    const doubleTap = !onTap && !drag.moved && now - lastTap < 320;
    const tapped = !drag.moved && !drag.reset && !doubleTap;
    if (drag.reset) {
      // Already reset by long-press; just let the popup's normal timer resume.
    } else if (tapped && onTap) {
      onTap();
    } else if (doubleTap) resetPopupPosition(kind, el, fallback);
    else {
      const r = el.getBoundingClientRect();
      settings.popupPos[kind] = {
        x: (r.left + r.width / 2) / innerWidth,
        y: (r.top + r.height / 2) / innerHeight,
      };
      saveSettings();
    }
    el.classList.remove('dragging');
    el.releasePointerCapture?.(e.pointerId);
    const moved = drag.moved;
    const reset = drag.reset;
    drag = null;
    lastTap = reset || doubleTap || moved ? 0 : now;
    afterDrag?.(moved);
    e.preventDefault();
    e.stopPropagation();
  }
  el.addEventListener('pointerup', finishDrag);
  el.addEventListener('pointercancel', finishDrag);
  el.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
  });
}
function repositionVisiblePopups(){
  if (!legendEl.hidden) applyPopupPosition('legend', legendEl, LEGEND_DEFAULT_POS);
  if (!tipEl.hidden) applyPopupPosition('tip', tipEl);
}

const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

/* ---------- Data: Open-Meteo ---------- */
function buildUrl(lat, lon){
  const p = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: 'temperature_2m,precipitation_probability,precipitation,snowfall,apparent_temperature,dewpoint_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,cloud_cover,weather_code',
    daily: 'sunrise,sunset',
    wind_speed_unit: 'mph',
    timezone: 'auto',
    forecast_days: '7',
  });
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}

const forecastRequests = new Map();
function fetchForecast(lat, lon){
  const key = `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`;
  if (forecastRequests.has(key)) return forecastRequests.get(key);
  const request = AppCore.fetchJson(buildUrl(lat, lon), { label: 'Weather', timeoutMs: 15000 })
    .finally(() => forecastRequests.delete(key));
  forecastRequests.set(key, request);
  return request;
}

/* Parse Open-Meteo hourly arrays into day columns of 24 hours each. */
function toDays(j){
  const h = j.hourly || {};
  const time = h.time || [];
  const byDate = new Map();
  const todayKey = forecastNow(forecastMeta(j)).key;

  for (let i = 0; i < time.length; i++){
    const iso = time[i];
    const dateKey = iso.slice(0, 10);
    const hour = +iso.slice(11, 13);
    if (!byDate.has(dateKey)) byDate.set(dateKey, new Array(24).fill(null));
    byDate.get(dateKey)[hour] = {
      c: h.temperature_2m?.[i],
      pop: h.precipitation_probability?.[i] ?? 0,
      precip: h.precipitation?.[i] ?? 0,          // mm in this hour
      snow: h.snowfall?.[i] ?? 0,                 // cm in this hour
      appF: h.apparent_temperature != null ? cToF(h.apparent_temperature[i]) : null,
      dewF: h.dewpoint_2m != null ? cToF(h.dewpoint_2m[i]) : null,
      windMph: h.wind_speed_10m?.[i] ?? null,
      windDir: h.wind_direction_10m?.[i] ?? null,   // degrees the wind comes FROM (0=N, 90=E)
      rh: h.relative_humidity_2m?.[i] ?? null,
      cloud: h.cloud_cover?.[i] ?? null,          // % cloud cover
      wcode: h.weather_code?.[i] ?? null,         // WMO weather code (95/96/99 = thunderstorm)
      iso,
    };
  }

  // daily sunrise/sunset, keyed by date → fractional hour of day (0–24)
  const dly = j.daily || {};
  const sun = new Map();
  (dly.time || []).forEach((d, i) => {
    sun.set(d, { riseH: hourFromLocalIso(dly.sunrise?.[i]), setH: hourFromLocalIso(dly.sunset?.[i]) });
  });

  return [...byDate.entries()].slice(0, 7).map(([key]) => {
    const d = new Date(key + 'T00:00:00');
    const s = sun.get(key) || {};
    return {
      date: d,
      isToday: key === todayKey,
      dow: WD[d.getDay()],
      dnum: d.getDate(),
      cells: byDate.get(key),
      riseH: s.riseH ?? null,     // sunrise as fractional hour, or null
      setH: s.setH ?? null,
    };
  });
}
const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

/* Empty 7-day scaffold so the loading shimmer has cells to fill. */
function placeholderDays(){
  const out = [];
  const base = new Date(); base.setHours(0,0,0,0);
  for (let i = 0; i < 7; i++){
    const d = new Date(base.getTime() + i*86400000);
    out.push({ date:d, isToday:i===0, dow:WD[d.getDay()], dnum:d.getDate(), cells:new Array(24).fill(null) });
  }
  return out;
}

/* ---------- Rendering ---------- */
function isPortrait(){ return window.innerHeight >= window.innerWidth; }

function cellRGB(cell, view = settings.view){
  if (!cell || cell.c == null) return [17,21,28];
  return view === 'run' ? runRGB(runIndex(cell)) : tempRGB(cToF(cell.c));
}
function cellNumber(cell, view = settings.view){
  if (!settings.showNumbers || !cell || cell.c == null) return null;
  return view === 'run' ? String(runIndex(cell)) : String(Math.round(displayTemp(cell.c)));
}

let nowFrac = 0;
function nowLineEl(){
  const el = document.createElement('div');
  el.className = 'nowline';
  el.style.setProperty('--frac', nowFrac.toFixed(4));
  return el;
}
/* Smooth day/night darkness as a continuous function of fractional hour, fading
 * across a twilight band around sunrise/sunset — deliberately ignores cell edges. */
const TWI = 1.3;                          // twilight half-width (hours)
function smoothstep(e0, e1, x){ const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
function darknessAt(day, t){
  if (day?.riseH == null || day?.setH == null) return 0;
  let ss = day.setH;
  if (ss <= day.riseH) ss += 24;            // polar summer: sunset is after midnight
  const dayness = smoothstep(day.riseH - TWI, day.riseH + TWI, t) * (1 - smoothstep(ss - TWI, ss + TWI, t));
  return settings.nightMax * (1 - dayness);
}
function shadeGradient(day, portrait){
  const dir = portrait ? 'to bottom' : 'to right', stops = [], N = 48;
  for (let i = 0; i <= N; i++){
    const a = darknessAt(day, i / N * 24);
    stops.push(`rgba(0,0,0,${a.toFixed(3)}) ${(i / N * 100).toFixed(2)}%`);
  }
  return `linear-gradient(${dir}, ${stops.join(',')})`;
}
function dayShadeEl(day, di, portrait){
  if (day.riseH == null || day.setH == null) return null;
  const el = document.createElement('div');
  el.className = 'dayshade';
  el.dataset.di = di;
  // Explicit start AND end lines: an abspos grid item resolves an `auto` end line
  // to the container's padding edge, which made shades span downward and stack.
  if (portrait){ el.style.gridColumn = `${di + 2} / ${di + 3}`; el.style.gridRow = '2 / 26'; }
  else { el.style.gridRow = `${di + 2} / ${di + 3}`; el.style.gridColumn = '2 / 26'; }
  el.style.background = shadeGradient(day, portrait);
  return el;
}
// Ink that accounts for the night shade so numbers stay legible.
function inkFor(day, h, c){
  const d = darknessAt(day, h + 0.5);
  return d ? pickInk([c[0] * (1 - d), c[1] * (1 - d), c[2] * (1 - d)]) : pickInk(c);
}
function effInk(di, h, c){ return inkFor(days[di], h, c); }
// Re-placeable current-time line: located by data-attrs after the grid is in the DOM.
function placeNowLine(){
  gridEl.querySelectorAll('.nowline').forEach(n => n.remove());
  const di = days.findIndex(d => d.isToday);
  if (di < 0) return;
  const now = forecastNow();
  nowFrac = now.minute / 60;
  const cell = gridEl.querySelector(`.cell[data-di="${di}"][data-h="${now.hour}"]`);
  if (cell && !cell.classList.contains('empty')) cell.appendChild(nowLineEl());
}
function solarEventsForDay(day){
  const out = [];
  const eventFromHour = (type, label, value) => {
    const h = ((value % 24) + 24) % 24;
    return { type, label, hour: Math.floor(h), minute: (h % 1) * 60 };
  };
  if (Number.isFinite(day?.riseH)) out.push(eventFromHour('rise', 'Sunrise', day.riseH));
  if (Number.isFinite(day?.setH)){
    out.push(eventFromHour('set', 'Sunset', day.setH));
  }
  return out.filter(ev => ev.hour >= 0 && ev.hour < 24);
}
function solarEventsForHour(day, h){
  return solarEventsForDay(day).filter(ev => ev.hour === h);
}
function clearSunMarkers(){
  gridEl.querySelectorAll('.sunmark').forEach(el => el.remove());
}
function placeSunMarkers(di){
  clearSunMarkers();
  const day = days[di];
  if (!day) return;
  for (const ev of solarEventsForDay(day)){
    const cell = gridEl.querySelector(`.cell[data-di="${di}"][data-h="${ev.hour}"]`);
    if (!cell || cell.classList.contains('empty')) continue;
    const line = document.createElement('div');
    line.className = `sunmark ${ev.type}`;
    line.title = `${ev.label} ${fmtClockMinute(ev.hour, ev.minute)}`;
    line.style.setProperty('--frac', (Math.max(0, Math.min(59, ev.minute)) / 60).toFixed(4));
    cell.appendChild(line);
  }
}

function corner(){
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'corner';
  el.innerHTML = GEAR;
  el.title = 'Settings';
  el.setAttribute('aria-label', 'Settings');
  el.addEventListener('click', openSheet);
  return el;
}
function dayHead(day){
  const el = document.createElement('div');
  el.className = 'head day' + (day.isToday ? ' today' : '');
  el.innerHTML = `<span class="dow">${day.dow}</span><span class="dnum">${day.dnum}</span>`;
  return el;
}
function hourHead(h){
  const el = document.createElement('div');
  el.className = 'head hour';
  el.textContent = fmtHour(h);
  return el;
}
function cellEl(di, h){
  const cell = days[di].cells[h];
  const el = document.createElement('div');
  el.className = 'cell';
  el.dataset.di = di; el.dataset.h = h;
  if (!cell || cell.c == null){ el.classList.add('empty'); return el; }

  const c = cellRGB(cell);
  el.style.background = rgbStr(c);
  const ink = effInk(di, h, c);           // contrast vs the night-shaded color

  const kind = precipKind(cell);
  const showPrecipFx = kind && (kind.pop || 0) > 10;
  if (showPrecipFx) fx.cells.push({ el, kind, ink, wind: cell.windMph || 0, dir: cell.windDir });   // canvas layer draws the particles

  // ambient effects (measured + drawn by the fx layer)
  const thunder = showPrecipFx && isThunder(cell);
  const windy = !showPrecipFx && (cell.windMph || 0) >= WIND_MIN;   // dry + notably windy
  const hot = !showPrecipFx && !windy && cToF(cell.c) >= 95;        // wind wins over shimmer on hot, dry, windy hours
  if (thunder || hot || windy) fx.fxCells.push({ el, di, hour: h, ink, thunder, hot, windy, wind: cell.windMph || 0, dir: cell.windDir });

  const num = cellNumber(cell);
  if (num != null){
    const t = document.createElement('span');
    t.className = 't';
    t.style.color = ink;
    t.textContent = num;
    el.appendChild(t);
  }
  return el;
}

function render(){
  if (!days.length) return;
  const portrait = isPortrait();
  orientation = portrait ? 'p' : 'l';
  nowFrac = forecastNow().minute / 60;
  const n = days.length;
  const frag = document.createDocumentFragment();
  gridEl.className = 'grid ' + orientation;
  fx.cells = []; fx.fxCells = [];         // collected by cellEl, laid out after paint

  if (portrait){
    // days = columns, hours = rows
    gridEl.style.gridTemplateColumns = `var(--label) repeat(${n}, minmax(0,1fr))`;
    gridEl.style.gridTemplateRows = `var(--label-day) repeat(24, minmax(0,1fr))`;
    frag.appendChild(corner());
    days.forEach(d => frag.appendChild(dayHead(d)));
    for (let h = 0; h < 24; h++){
      frag.appendChild(hourHead(h));
      for (let di = 0; di < n; di++) frag.appendChild(cellEl(di, h));
    }
  } else {
    // hours = columns, days = rows
    gridEl.style.gridTemplateColumns = `var(--label-day) repeat(24, minmax(0,1fr))`;
    gridEl.style.gridTemplateRows = `var(--label) repeat(${n}, minmax(0,1fr))`;
    frag.appendChild(corner());
    for (let h = 0; h < 24; h++) frag.appendChild(hourHead(h));
    days.forEach((d, di) => {
      frag.appendChild(dayHead(d));
      for (let h = 0; h < 24; h++) frag.appendChild(cellEl(di, h));
    });
  }
  days.forEach((d, di) => { const s = dayShadeEl(d, di, portrait); if (s) frag.appendChild(s); });
  gridEl.replaceChildren(frag);
  placeNowLine();                         // now that cells are in the DOM
  layoutFx();                             // build precip in the same pass (getBoundingClientRect forces layout)
  refreshTip();                           // re-pin an open detail popup to the same cell with fresh data
  if (currentForecastMeta && !BOT_RENDER) invalidateShare();
}

function botForecastSummary(){
  return days.map(day => {
    const temps = day.cells.map(c => c?.c).filter(Number.isFinite).map(cToF);
    return temps.length ? `${day.dow} ${Math.round(Math.min(...temps))}-${Math.round(Math.max(...temps))}F` : null;
  }).filter(Boolean).join(', ');
}

function markBotReady(){
  if (!BOT_RENDER) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    window.__24x7Bot = {
      status: 'ready',
      place: place.name || BOT_LABEL || 'Weather',
      summary: botForecastSummary(),
    };
    document.body.dataset.botReady = '1';
  }));
}

/* ---------- Precipitation particle engine (canvas) ----------
 * One overlay canvas draws every rainy/snowy cell's particles. Probability sets
 * overall opacity; intensity sets drop count, fall speed and streak length. A
 * slow gusting wind angle shared across the grid keeps it alive and cohesive. */
const fx = { cells: [], canvas: null, ctx: null, dpr: 1, w: 0, h: 0, raf: 0, last: 0, t: 0, fogScale: 1, snowScale: 1, snowAtlas: null, snowCtx: null, snowIdx: 0, snowCap: 0,
  fxCells: [], hot: [], thunder: [], bolt: null, boltNext: 0 };
const FOG_BUDGET = 180;                   // max total mist strands across the whole grid
const SNOW_BUDGET = 380;                  // max total flakes (each gets its own generated crystal)
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// per-intensity tuning: seconds to cross a cell, drops-per-cell base, line width
const RAIN_T  = [0, 1.15, 0.85, 0.60, 0.44, 0.32];
const RAIN_N  = [0,    3,    5,    8,   11,   14];
const RAIN_LW = [0,  0.8,  0.9,  1.1,  1.3,  1.6];
const SNOW_T  = [0,    6,    5,    4,    3,    3];
const SNOW_N  = [0,    5,    9,   13,   17,   17];
const SNOW_R  = [0,  0.9,  1.1,  1.4,  1.7,  1.7];
const REF_AREA = 40 * 34;                 // a "typical" cell, for scaling counts
const FOG_AMP = 0.6;                      // mist wave height as a fraction of cell height
const FOG_WIDTH = 15, FOG_OPACITY = 0.04;  // mist strand line-width & opacity
// Wind tilts falling precip by the real slant angle: rain matches the wind's
// horizontal speed while falling at terminal velocity, so angle-from-vertical =
// atan(wind / terminal). V_TERM ≈ 15 mph (~6.7 m/s) for typical raindrops.
// (8mph→28°, 15→45°, 25→59°, 40→69°; asymptotes toward — but never reaches — horizontal.)
const V_TERM = 15;
// Physical slant is atan(wind/terminal); we dial it back to 80% because the true
// angle reads visually too aggressive on the small cells.
const SLANT_SCALE = 0.8;

// Open-Meteo gives wind direction as the compass bearing the wind comes FROM
// (0=N, 90=E). Convert to the on-screen unit vector it blows TOWARD, with
// north = top of cell: x is east(+)/west(−), y is south(+, downward)/north(−).
const windToward = deg => { const r = (deg || 0) * Math.PI / 180; return { x: -Math.sin(r), y: Math.cos(r) }; };

// Precip slant: only the EAST/WEST component tilts the fall (N/S is ignored —
// rain still falls down). Right (+) when blowing east, left (−) when west. When
// direction is unknown, fall back to the old full-speed rightward lean.
function precipSlantRad(mph, deg){
  const east = deg == null ? (mph || 0) : (mph || 0) * windToward(deg).x;
  return SLANT_SCALE * Math.atan(east / V_TERM);
}

// Dry-day wind: a hint.fm-style field of fine, trailing filaments combs across
// cells that are notably breezy and NOT precipitating (rain already encodes wind
// via its slant). All filaments flow one uniform direction; windier cells get
// more of them, moving faster and brighter. Intensity ramps WIND_MIN → WIND_REF.
const WIND_MIN = 16, WIND_REF = 40;
const windFrac = mph => Math.max(0, Math.min(1, ((mph || 0) - WIND_MIN) / (WIND_REF - WIND_MIN)));
const WIND_BUDGET = 1400;     // max filaments across the whole grid (perf cap)
const WIND_FADE = 0.06;       // per-frame trail erase — lower = longer, silkier trails

function rand(a, b){ return a + Math.random() * (b - a); }

/* Each snowflake is its own one-off 6-fold crystal (random branch count, spine
   positions, lengths, angle, line weight, tip) from a continuous parameter space —
   genuinely no two alike. Cheap to build: all flakes share ONE atlas canvas (no
   per-flake canvas, no shadow blur, a single stroke per crystal); each flake just
   blits its own atlas slot every frame. */
const SNOW_SLOT = 22, SNOW_COLS = 24;
function ensureSnowAtlas(){
  if (fx.snowAtlas) return;
  const rows = Math.ceil(SNOW_BUDGET / SNOW_COLS) + 1;
  fx.snowAtlas = document.createElement('canvas');
  fx.snowAtlas.width = SNOW_COLS * SNOW_SLOT;
  fx.snowAtlas.height = rows * SNOW_SLOT;
  fx.snowCtx = fx.snowAtlas.getContext('2d');
  fx.snowCap = SNOW_COLS * rows;
}
function drawFlakeSlot(color){
  ensureSnowAtlas();
  const slot = (fx.snowIdx++) % fx.snowCap;
  const sx = (slot % SNOW_COLS) * SNOW_SLOT, sy = ((slot / SNOW_COLS) | 0) * SNOW_SLOT;
  const x = fx.snowCtx;
  x.save();
  x.clearRect(sx, sy, SNOW_SLOT, SNOW_SLOT);
  x.translate(sx + SNOW_SLOT / 2, sy + SNOW_SLOT / 2);
  x.strokeStyle = color; x.fillStyle = color; x.lineCap = 'round'; x.lineJoin = 'round';
  x.lineWidth = rand(0.8, 1.35);
  const R = SNOW_SLOT / 2 - 2;
  const nb = Math.floor(rand(1, 4));                        // 1–3 side-branch pairs
  const bpos = Array.from({ length: nb }, () => rand(0.30, 0.88));
  const blen = Array.from({ length: nb }, () => rand(0.14, 0.42));
  const bang = rand(0.45, 1.1), dx = Math.sin(bang), dy = Math.cos(bang), tip = Math.random() < 0.6;
  x.beginPath();                                            // all six arms in one path → one stroke
  for (let a = 0; a < 6; a++){
    x.save(); x.rotate(a * Math.PI / 3);
    x.moveTo(0, 0); x.lineTo(0, -R);                        // spine
    for (let i = 0; i < nb; i++){
      const y = -R * bpos[i], L = R * blen[i];
      x.moveTo(0, y); x.lineTo(dx * L, y - dy * L);
      x.moveTo(0, y); x.lineTo(-dx * L, y - dy * L);
    }
    x.restore();
  }
  x.stroke();
  if (tip){
    x.beginPath();
    for (let a = 0; a < 6; a++){ x.save(); x.rotate(a * Math.PI / 3); x.moveTo(x.lineWidth, -R); x.arc(0, -R, x.lineWidth, 0, Math.PI * 2); x.restore(); }
    x.fill();
  }
  x.restore();
  return { sx, sy };
}

function buildParticles(cell){
  const { w, h, kind } = cell;
  cell.col = inkRGB(cell.ink);
  cell.alpha = 0.30 + 0.55 * Math.min(1, kind.pop / 100);
  cell.windRad = precipSlantRad(cell.wind, cell.dir);   // fall slant from this hour's E/W wind component
  const areaScale = Math.max(0.45, Math.min(2.4, (w * h) / REF_AREA));
  cell.type = kind.snow ? 'snow' : (kind.level === 1 ? 'fog' : 'rain');

  if (cell.type === 'fog'){
    // wavy drifting mist strands instead of falling streaks
    // opacity tracks precip probability: faint when unlikely, full at high chance.
    // Probability is the dominant factor (0.15→1.0); jitter is only a light texture.
    const probScale = 0.15 + 0.85 * Math.min(1, kind.pop / 100);
    const n = Math.max(1, Math.round(3.5 * areaScale * fx.fogScale));
    cell.parts = Array.from({ length: n }, () => ({
      by: rand(0.16 * h, 0.84 * h),
      ampF: rand(0.7, 1.3),                      // per-strand amplitude factor
      aF: rand(0.9, 1.1) * probScale,            // per-strand opacity factor (× FOG_OPACITY)
      k: (Math.PI * 2 / w) * rand(0.7, 1.7),     // ~1 wave across the cell
      ph: rand(0, Math.PI * 2),
      drift: rand(0.25, 0.8) * (Math.random() < 0.5 ? -1 : 1),  // wave travel
      vx: rand(6, 18) * (Math.random() < 0.5 ? -1 : 1),         // sideways slide px/s
      ox: rand(0, w),
      lw: rand(1.3, 3),
    }));
  } else if (cell.type === 'snow'){
    const lvl = Math.min(4, kind.level);
    const T = SNOW_T[lvl], n = Math.max(1, Math.round(SNOW_N[lvl] * areaScale * fx.snowScale));
    cell.parts = Array.from({ length: n }, () => {
      const s = drawFlakeSlot(cell.ink);                   // unique crystal → its own atlas slot
      return {
        bx: rand(0, w), y: rand(0, h), dr: SNOW_R[lvl] * rand(0.7, 1.3) * 2.3,   // drawn half-size
        vy: (h / T) * rand(0.75, 1.25), amp: w * rand(0.08, 0.22),
        freq: rand(0.5, 1.4), ph: rand(0, Math.PI * 2), a: rand(0.5, 1),
        sx: s.sx, sy: s.sy, rot: rand(0, Math.PI * 2), rotV: rand(-0.7, 0.7),
      };
    });
  } else {
    const lvl = Math.min(5, kind.level);
    const T = RAIN_T[lvl], n = Math.max(2, Math.round(RAIN_N[lvl] * areaScale));
    cell.parts = Array.from({ length: n }, () => {
      const vy = (h / T) * rand(0.82, 1.25);
      return { x: rand(0, w), y: rand(-h, h), vy,
        len: Math.min(h * 0.7, Math.max(3, vy * 0.05)), a: rand(0.45, 1) };
    });
  }
}

/* Grow the day/hour labels to the biggest type that fits their (fixed) header
   boxes. Tracks are sized independently (in ch of the grid font), so changing
   the label font here never reflows the grid — overflow:hidden clips any slop. */
const DAY_LABEL_SCALE = 0.8, HOUR_LABEL_SCALE = 1.1;   // tuned fill ratios
function fitHeaders(){
  const portrait = orientation === 'p';
  const CW = 0.62;                                  // approx glyph width / font-size
  const dayEl = gridEl.querySelector('.head.day');
  if (dayEl){
    const w = dayEl.clientWidth, h = dayEl.clientHeight;
    // portrait: one line "Fr19" (~4 glyphs); landscape: two stacked lines (~2 glyphs each)
    const px = (portrait ? Math.min(h * 0.86, w / (4 * CW))
                         : Math.min(h * 0.46, w / (2 * CW))) * DAY_LABEL_SCALE;
    gridEl.style.setProperty('--dayfs', Math.max(7, Math.round(px)) + 'px');
  }
  const hourEl = gridEl.querySelector('.head.hour');
  if (hourEl){
    const w = hourEl.clientWidth, h = hourEl.clientHeight;
    const len = clock24() ? 2 : 3;                  // "03" vs "12a"
    const lscale = portrait ? 1 : 0.85;             // time-axis labels read ~15% smaller in landscape
    const px = Math.min(h * 0.86, w / (len * CW)) * HOUR_LABEL_SCALE * lscale;
    gridEl.style.setProperty('--hourfs', Math.max(7, Math.round(px)) + 'px');
  }
}

function layoutFx(){
  fitHeaders();
  if (!fx.canvas){
    fx.canvas = document.getElementById('fx');
    fx.ctx = fx.canvas.getContext('2d');
    fx.wcanvas = document.getElementById('windfx');
    fx.wctx = fx.wcanvas.getContext('2d');
  }
  const g = gridEl.getBoundingClientRect();
  fx.w = g.width; fx.h = g.height;
  fx.dpr = Math.min(1.5, window.devicePixelRatio || 1);   // fog fill-rate: 1.5 is plenty
  for (const cv of [fx.canvas, fx.wcanvas]){               // both layers track the grid 1:1
    Object.assign(cv.style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px` });
    cv.width = Math.round(g.width * fx.dpr);               // (re)setting width also clears stale trails
    cv.height = Math.round(g.height * fx.dpr);
    cv.getContext('2d').setTransform(fx.dpr, 0, 0, fx.dpr, 0, 0);
  }
  for (const cell of fx.cells){                           // measure cell rects
    const r = cell.el.getBoundingClientRect();
    cell.x = r.left - g.left; cell.y = r.top - g.top; cell.w = r.width; cell.h = r.height;
  }
  // budget caps: spread a fixed total of mist strands / snow flakes across the grid
  // (snow uses the real projected count so the cap actually holds — see prior 827-flake bug)
  let fogCount = 0, snowRaw = 0;
  for (const cell of fx.cells){
    if (cell.kind.snow){
      const as = Math.max(0.45, Math.min(2.4, (cell.w * cell.h) / REF_AREA));
      snowRaw += Math.max(1, Math.round(SNOW_N[Math.min(4, cell.kind.level)] * as));
    } else if (cell.kind.level === 1) fogCount++;
  }
  fx.fogScale = fogCount ? Math.max(0.25, Math.min(1, FOG_BUDGET / (fogCount * 3.5))) : 1;
  fx.snowScale = snowRaw > SNOW_BUDGET ? SNOW_BUDGET / snowRaw : 1;
  fx.snowIdx = 0;
  for (const cell of fx.cells) buildParticles(cell);
  layoutAmbient(g);
  startFx();
}

/* Seed a windy cell with `n` filaments at random positions, each with its own
   speed (scaled by the cell's wind) and a short life so the field keeps renewing
   instead of settling into fixed tracks. */
function buildFilaments(fc, n){
  fc.wa = 0.10 + 0.22 * fc.wt;                  // base filament brightness, by wind
  const v = windToward(fc.dir);                 // true flow direction (north = up); null dir → blows east
  fc.fdx = fc.dir == null ? 1 : v.x; fc.fdy = fc.dir == null ? 0 : v.y;
  const span = (fc.w + fc.h) / 2;               // direction-neutral travel scale
  fc.parts = [];
  for (let i = 0; i < n; i++){
    const x = rand(0, fc.w), y = rand(0, fc.h), ml = rand(0.6, 1.7);
    fc.parts.push({
      x, y, px: x, py: y,
      life: rand(0, ml), ml,
      spd: span * (0.5 + 1.8 * fc.wt) * rand(0.8, 1.2),   // px/sec along the flow
      lw:  rand(0.5, 1.0),
    });
  }
}

/* Measure ambient-effect cells and bucket them: hot + independent thunderstorm
   cells (so lightning flickers cell-by-cell instead of region-by-region). Windy
   cells get a filament count proportional to wind & area, capped by a global
   budget so a fully-blustery week can't blow the per-frame stroke count up. */
function layoutAmbient(g){
  fx.hot = []; fx.thunder = []; fx.windy = [];
  let windRaw = 0;
  for (const fc of fx.fxCells){
    const r = fc.el.getBoundingClientRect();
    fc.x = r.left - g.left; fc.y = r.top - g.top; fc.w = r.width; fc.h = r.height;
    fc.col = inkRGB(fc.ink);
    if (fc.hot) fx.hot.push(fc);
    if (fc.thunder){
      const hour = fc.hour ?? 0;
      LightningFx.seedCell(fc, fc.di, hour);
      fx.thunder.push(fc);
    }
    if (fc.windy){
      fc.wt = windFrac(fc.wind);
      const as = Math.max(0.45, Math.min(2.4, (fc.w * fc.h) / REF_AREA));
      fc.wRaw = Math.max(2, Math.round((6 + 18 * fc.wt) * as));   // density: 6 (breezy) → 24 (howling)
      windRaw += fc.wRaw;
      fx.windy.push(fc);
    }
  }
  const wScale = windRaw > WIND_BUDGET ? WIND_BUDGET / windRaw : 1;
  for (const fc of fx.windy) buildFilaments(fc, Math.max(1, Math.round(fc.wRaw * wScale)));
}

function drawCell(cell, dt, gust){
  const ctx = fx.ctx;
  ctx.save();
  ctx.beginPath(); ctx.rect(cell.x, cell.y, cell.w, cell.h); ctx.clip();
  ctx.translate(cell.x, cell.y);
  if (cell.type === 'fog'){
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const step = Math.max(8, cell.w / 8);                     // wide soft lines tolerate coarse paths
    for (const p of cell.parts){
      p.ox += p.vx * dt + (Math.random() - 0.5) * 0.8;        // slide + Brownian jitter
      const ph = p.ph + fx.t * p.drift;
      const amp = cell.h * FOG_AMP * p.ampF;
      const a = FOG_OPACITY * p.aF;
      const lw = p.lw * FOG_WIDTH;
      ctx.beginPath();
      for (let x = 0; x <= cell.w; x += step){
        const s = p.k * (x + p.ox);
        const y = p.by + amp * Math.sin(s + ph) + amp * 0.45 * Math.sin(s * 2.1 + ph * 1.4);
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.lineWidth = lw;
      ctx.strokeStyle = `rgba(${cell.col},${a.toFixed(3)})`; ctx.stroke();
    }
  } else if (cell.type === 'snow'){
    const ang = cell.windRad + gust;
    const sinA = Math.sin(ang), cosA = Math.cos(ang);
    for (const p of cell.parts){
      p.bx += p.vy * sinA * dt;                       // blow sideways with the wind
      p.y += p.vy * cosA * dt;
      p.rot += p.rotV * dt;                           // gentle tumble
      if (p.y - p.dr > cell.h){ p.y = -p.dr; p.bx = rand(0, cell.w); }
      if (p.bx < -cell.w * 0.3) p.bx += cell.w * 1.6; else if (p.bx > cell.w * 1.3) p.bx -= cell.w * 1.6;
      const x = p.bx + Math.sin(fx.t * p.freq + p.ph) * p.amp;   // + flutter
      ctx.save();
      ctx.globalAlpha = p.a * cell.alpha;
      ctx.translate(x, p.y); ctx.rotate(p.rot);
      ctx.drawImage(fx.snowAtlas, p.sx, p.sy, SNOW_SLOT, SNOW_SLOT, -p.dr, -p.dr, p.dr * 2, p.dr * 2);
      ctx.restore();
    }
  } else {
    const lvl = Math.min(5, cell.kind.level);
    ctx.lineCap = 'round';
    ctx.lineWidth = RAIN_LW[lvl];
    const ang = cell.windRad + gust;                 // wind tilt (+ shared gust)
    const sinA = Math.sin(ang), cosA = Math.cos(ang);
    for (const p of cell.parts){
      p.x += p.vy * sinA * dt; p.y += p.vy * cosA * dt;   // rotate fall vector, keep speed
      if (p.y - p.len > cell.h){ p.y = rand(-cell.h * 0.4, 0); p.x = rand(0, cell.w); }
      if (p.x < -2) p.x += cell.w + 4; else if (p.x > cell.w + 2) p.x -= cell.w + 4;
      ctx.beginPath();                                // streak along the (tilted) fall direction
      ctx.strokeStyle = `rgba(${cell.col},${(p.a * cell.alpha).toFixed(3)})`;
      ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - sinA * p.len, p.y - cosA * p.len); ctx.stroke();
    }
  }
  ctx.restore();
}

/* ---------- Wind field (its own persistent canvas) ----------
 * hint.fm-style: many fine filaments comb across dry, windy cells in each cell's
 * TRUE wind direction (north = top). We DON'T clear this canvas each frame —
 * instead we erase a sliver of it (destination-out), so every filament smears
 * into a soft trailing wisp. That persistence is why it gets its own buffer
 * (the precip canvas hard-clears). */
function drawWindField(dt, gust){
  const ctx = fx.wctx;
  if (!ctx) return;
  ctx.globalCompositeOperation = 'destination-out';     // fade prior frame → trailing wisps
  ctx.fillStyle = `rgba(0,0,0,${WIND_FADE})`;
  ctx.fillRect(0, 0, fx.w, fx.h);
  ctx.globalCompositeOperation = 'source-over';
  if (!fx.windy || !fx.windy.length) return;
  const cg = Math.cos(gust), sg = Math.sin(gust);       // shared gust = small rotational wobble of the flow
  ctx.lineCap = 'round';
  for (const fc of fx.windy){
    const dx = fc.fdx * cg - fc.fdy * sg;               // this cell's flow, nudged by the gust
    const dy = fc.fdx * sg + fc.fdy * cg;
    ctx.save();
    ctx.beginPath(); ctx.rect(fc.x, fc.y, fc.w, fc.h); ctx.clip();
    for (const p of fc.parts){
      p.px = p.x; p.py = p.y;
      p.x += dx * p.spd * dt; p.y += dy * p.spd * dt;
      p.life -= dt;
      if (p.life <= 0 || p.x < -4 || p.x > fc.w + 4 || p.y < -4 || p.y > fc.h + 4){   // spent or off any edge → respawn
        const nx = rand(0, fc.w), ny = rand(0, fc.h);
        p.x = p.px = nx; p.y = p.py = ny; p.life = p.ml;
        continue;                                        // skip the streak across the cell on respawn
      }
      const lf = Math.min(1, p.life * 5, (p.ml - p.life) * 5);   // fade each filament in/out over its life
      const a = fc.wa * lf;
      if (a < 0.004) continue;
      ctx.beginPath();
      ctx.lineWidth = p.lw;
      ctx.strokeStyle = `rgba(${fc.col},${a.toFixed(3)})`;
      ctx.moveTo(fc.x + p.px, fc.y + p.py);
      ctx.lineTo(fc.x + p.x, fc.y + p.y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/* ---------- Ambient effects (heat shimmer / lightning) ---------- */
function drawHeatShimmer(){
  if (!fx.hot.length) return;
  const ctx = fx.ctx;
  ctx.save(); ctx.lineWidth = 2; ctx.lineCap = 'round';
  for (const fc of fx.hot){
    ctx.globalCompositeOperation = fc.ink === '#fff' ? 'lighter' : 'source-over';
    ctx.save(); ctx.beginPath(); ctx.rect(fc.x, fc.y, fc.w, fc.h); ctx.clip();
    for (let i = 0; i < 3; i++){
      const phase = i * 1.9 + fc.x * 0.05;
      const frac = (fx.t * 0.16 + i / 3) % 1;               // 0 at the bottom → 1 at the top (rises)
      const yB = fc.y + fc.h * (1 - frac);
      const amp = 1.4 + 1.4 * Math.sin(fx.t * 2 + phase);
      const a = 0.09 * (1 - frac) * Math.min(1, frac * 6);  // fade in low, fade to 0 toward the top
      if (a <= 0.003) continue;
      ctx.beginPath();
      for (let xx = 0; xx <= fc.w; xx += 4){
        const yy = yB + Math.sin(xx * 0.22 + fx.t * 3 + phase) * amp;
        xx === 0 ? ctx.moveTo(fc.x + xx, yy) : ctx.lineTo(fc.x + xx, yy);
      }
      ctx.strokeStyle = `rgba(${fc.col},${a.toFixed(3)})`; ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}
function drawLightning(now){
  if (!fx.thunder || !fx.thunder.length) return;
  const ctx = fx.ctx;
  for (const fc of fx.thunder){
    LightningFx.drawCell(ctx, fx.t, fc, { x: fc.x, y: fc.y, w: fc.w, h: fc.h }, { composite: 'lighter' });
  }
}
function drawAmbient(now){
  drawHeatShimmer();
  drawLightning(now);
}

function frame(now){
  const dt = Math.min(0.05, (now - fx.last) / 1000 || 0);
  fx.last = now; fx.t = now / 1000;
  fx.ctx.clearRect(0, 0, fx.w, fx.h);
  const gust = (6 * Math.sin(fx.t * 0.5)) * Math.PI / 180;   // ±6° shared gust wobble
  for (const cell of fx.cells) drawCell(cell, dt, gust);
  drawWindField(dt, gust);                                   // persistent wind layer (its own canvas)
  drawAmbient(now);
  fx.raf = requestAnimationFrame(frame);
}

function startFx(){
  cancelAnimationFrame(fx.raf); fx.raf = 0;
  fx.wctx?.clearRect(0, 0, fx.w, fx.h);                 // drop any leftover wind trails before (re)starting
  if (!fx.cells.length && !fx.fxCells.length){ fx.ctx?.clearRect(0, 0, fx.w, fx.h); return; }
  if (reduceMotion.matches){             // one calm static frame, no loop (wind needs motion → omitted)
    fx.ctx.clearRect(0, 0, fx.w, fx.h);
    fx.t = 1;
    for (const cell of fx.cells) drawCell(cell, 0, 0);   // static frame; wind tilt still applies
    return;
  }
  fx.last = performance.now();
  fx.raf = requestAnimationFrame(frame);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden){ cancelAnimationFrame(fx.raf); fx.raf = 0; return; }
  startFx();
  if (days.length) placeNowLine();
  if (lastCoords && Date.now() - lastLoadedAt > 10 * 60 * 1000) load(lastCoords.lat, lastCoords.lon);
});

/* ---------- Tap-a-cell readout ---------- */
let tipTimer = null, selEl = null, selDi = null, selH = null, suppressTipGridClickUntil = 0;
gridEl.addEventListener('click', e => {
  if (performance.now() < suppressTipGridClickUntil) return;
  if (lpFired || swiped){ lpFired = false; swiped = false; return; }   // long-press/swipe: not a tap
  const c = e.target.closest('.cell');
  if (!c || c.classList.contains('empty')) return;
  showTip(+c.dataset.di, +c.dataset.h, c);
});

/* ---------- Color legend ---------- */
const legendEl = $('#legend');
const LEGEND_DEFAULT_POS = { x: 0.5, y: 0.9 };
let legendTimer = 0;
function gradFrom(fn, n){
  const stops = [];
  for (let i = 0; i < n; i++) stops.push(rgbStr(fn(i / (n - 1))));
  return `linear-gradient(to right, ${stops.join(',')})`;
}
function legendInfo(){
  if (settings.view === 'run')
    return { grad: gradFrom(t => runRGB(Math.round(t * 100)), 8), lo: 'avoid', hi: 'great' };
  // span the palette's full domain so the cold pink/white and hot maroon ends show
  const loF = settings.palette === 'inferno' ? INF_LO : NOAA_STOPS[0][0];
  const hiF = settings.palette === 'inferno' ? INF_HI : NOAA_STOPS[NOAA_STOPS.length - 1][0];
  const lab = f => `${Math.round(unitIsF() ? f : (f - 32) * 5 / 9)}${unitGlyph()}`;
  return { grad: gradFrom(t => tempRGB(loF + t * (hiF - loF)), 32), lo: lab(loF), hi: lab(hiF) };
}
function legendPlace(){
  return place.name && place.name !== '—' ? place.name : 'Current location';
}
function showLegend(){
  const info = legendInfo();
  legendEl.querySelector('.legend-place').textContent = legendPlace();
  legendEl.querySelector('.legend-title').textContent = settings.view === 'run' ? 'Run Index' : 'Temperature';
  legendEl.querySelector('.bar').style.background = info.grad;
  legendEl.querySelector('.lo').textContent = info.lo;
  legendEl.querySelector('.hi').textContent = info.hi;
  legendEl.hidden = false;
  applyPopupPosition('legend', legendEl, LEGEND_DEFAULT_POS);
  clearTimeout(legendTimer);
  legendTimer = setTimeout(() => { legendEl.hidden = true; }, 4000);
}

makeDraggablePopup('legend', legendEl, () => {
  clearTimeout(legendTimer);
  legendTimer = setTimeout(() => { legendEl.hidden = true; }, 4000);
}, () => clearTimeout(legendTimer), LEGEND_DEFAULT_POS);

// Flip between Temp/Rain and Run Index.
function toggleView(){
  settings.view = settings.view === 'run' ? 'temp' : 'run';
  saveSettings();
  render();
  showLegend();                                  // shows the new scale so the switch is legible
  if (!sheetEl.hidden) syncSheet();
}
function cycleLocation(dir){
  const t = cycleStep(dir);
  if (t === undefined) return false;
  switchTo(t);                                    // t may be null ("my location") — that's valid
  showLegend();
  return true;
}

// Grid gestures: long-press → legend; horizontal swipe → location; vertical swipe → view.
// The swipe is a real carousel: the live grid (+ its two particle canvases) and a
// neighbor "ghost" pane on each side translate together under the finger, so you drag
// the next location/view into view instead of dragging onto black. On release it either
// completes (neighbor slides to centre, then becomes the real grid) or springs back.
// Ghosts are static colour grids (no particle layer) built from the prefetched forecast
// for an instant paint; an un-warmed neighbor falls back to a loading shimmer.
let lpTimer = 0, lpFired = false, swiped = false, lpX = 0, lpY = 0;
let dragAxis = null, dragOff = 0, dragSize = 0, slideCleanupT = 0, pendingFinish = null;
let ghostPrev = null, ghostNext = null;
const SWIPE_PREP_PX = 5;
const SWIPE_START_PX = 10;
const SWIPE_EASE = 'cubic-bezier(.22,.61,.36,1)';
const fxEls = () => [fx.canvas, fx.wcanvas].filter(Boolean);
function fxVisible(on){ for (const el of fxEls()) el.style.opacity = on ? '' : '0'; }
function canSwipe(axis){ return axis === 'x' ? cycleList().length > 1 : true; }

// One static, non-interactive colour grid for `data` painted in `view` — mirrors render()'s
// structure but skips the fx/particle wiring entirely.
function ghostCell(di, h, data, view){
  const cell = data[di]?.cells[h];
  const el = document.createElement('div');
  el.className = 'cell'; el.dataset.di = di; el.dataset.h = h;
  if (!cell || cell.c == null){ el.classList.add('empty'); return el; }
  const c = cellRGB(cell, view);
  el.style.background = rgbStr(c);
  const num = cellNumber(cell, view);
  if (num != null){
    const t = document.createElement('span');
    t.className = 't'; t.style.color = inkFor(data[di], h, c); t.textContent = num;
    el.appendChild(t);
  }
  return el;
}
function buildGhost(data, view){
  const portrait = isPortrait();
  const el = document.createElement('div');
  el.className = 'grid ghost ' + (portrait ? 'p' : 'l');
  const n = data.length;
  if (portrait){
    el.style.gridTemplateColumns = `var(--label) repeat(${n}, minmax(0,1fr))`;
    el.style.gridTemplateRows = `var(--label-day) repeat(24, minmax(0,1fr))`;
    el.appendChild(corner());
    data.forEach(d => el.appendChild(dayHead(d)));
    for (let h = 0; h < 24; h++){
      el.appendChild(hourHead(h));
      for (let di = 0; di < n; di++) el.appendChild(ghostCell(di, h, data, view));
    }
  } else {
    el.style.gridTemplateColumns = `var(--label-day) repeat(24, minmax(0,1fr))`;
    el.style.gridTemplateRows = `var(--label) repeat(${n}, minmax(0,1fr))`;
    el.appendChild(corner());
    for (let h = 0; h < 24; h++) el.appendChild(hourHead(h));
    data.forEach((d, di) => {
      el.appendChild(dayHead(d));
      for (let h = 0; h < 24; h++) el.appendChild(ghostCell(di, h, data, view));
    });
  }
  data.forEach((d, di) => { const s = dayShadeEl(d, di, portrait); if (s) el.appendChild(s); });
  return el;
}
function mountGhost(data, view, rect, side){
  const el = buildGhost(data || placeholderDays(), view);
  if (!data) el.classList.add('loading');     // un-warmed neighbor → shimmer rather than black
  el.style.setProperty('--dayfs', gridEl.style.getPropertyValue('--dayfs'));   // match fitted header sizes
  el.style.setProperty('--hourfs', gridEl.style.getPropertyValue('--hourfs'));
  Object.assign(el.style, {
    position: 'fixed', left: rect.left + 'px', top: rect.top + 'px',
    width: rect.width + 'px', height: rect.height + 'px',
    margin: '0', zIndex: '5', pointerEvents: 'none',
  });
  el.style.transform = dragAxis === 'x' ? `translate3d(${side * dragSize}px,0,0)` : `translate3d(0,${side * dragSize}px,0)`;
  document.body.appendChild(el);
  return el;
}
function buildCarousel(axis){
  const rect = gridEl.getBoundingClientRect();
  dragSize = axis === 'x' ? rect.width : rect.height;
  let prevData, nextData, view = settings.view;
  if (axis === 'x'){
    prevData = neighborDays(-1); nextData = neighborDays(1);
  } else {
    view = settings.view === 'run' ? 'temp' : 'run';   // the other view, both sides
    prevData = nextData = days;
  }
  ghostPrev = mountGhost(prevData, view, rect, -1);
  ghostNext = mountGhost(nextData, view, rect, 1);
}
function destroyGhosts(){ ghostPrev?.remove(); ghostNext?.remove(); ghostPrev = ghostNext = null; }
function slideTransform(el, px, ms){
  el.style.transition = ms ? `transform ${ms}ms ${SWIPE_EASE}` : 'none';
  el.style.transform = dragAxis === 'x' ? `translate3d(${px}px,0,0)` : `translate3d(0,${px}px,0)`;
}
// Move the live grid + canvases by `off`, and the two ghosts by their base ±size + off.
function applyDrag(off, ms){
  for (const el of [gridEl, ...fxEls()]) slideTransform(el, off, ms);
  if (ghostPrev) slideTransform(ghostPrev, -dragSize + off, ms);
  if (ghostNext) slideTransform(ghostNext, dragSize + off, ms);
}
function resetSlide(){
  dragAxis = null;
  for (const el of [gridEl, ...fxEls()]){ el.style.transition = ''; el.style.transform = ''; }
  destroyGhosts(); fxVisible(true); pendingFinish = null;
}
function slideCommit(axis, dir){
  const IN = 140;
  fxVisible(false);                          // current pane's particles exit quietly
  applyDrag(dir < 0 ? -dragSize : dragSize, IN);   // carry the target ghost to centre
  pendingFinish = () => {                    // the actual switch; run by the timer OR a pre-empting touch
    pendingFinish = null;
    if (axis === 'x'){
      const cycleDir = dir < 0 ? 1 : -1;     // swipe left → next location
      const nd = neighborDays(cycleDir);     // warm data for the target (real / my-location / test)
      cycleLocation(cycleDir);               // switch + start the background refresh
      if (nd){ days = nd; render(); gridEl.classList.remove('loading'); }   // instant, matches the ghost
      else { days = placeholderDays(); render(); gridEl.classList.add('loading'); }
    } else {
      toggleView();                          // Temp/Run share data — already coloured
    }
    resetSlide();                            // grid (now the new content) snaps to centre; ghosts gone
    layoutFx();                              // realign + restart particles for the new pane
  };
  clearTimeout(slideCleanupT);
  slideCleanupT = setTimeout(() => pendingFinish && pendingFinish(), IN + 10);
}

gridEl.addEventListener('pointerdown', e => {
  clearTimeout(slideCleanupT);
  if (pendingFinish) pendingFinish();          // re-touch mid-commit → finish the switch, don't drop it
  else if (ghostPrev || ghostNext) resetSlide();
  lpFired = false; swiped = false; dragAxis = null; dragOff = 0;
  lpX = e.clientX; lpY = e.clientY;
  try { gridEl.setPointerCapture(e.pointerId); } catch {}
  lpTimer = setTimeout(() => { lpFired = true; showLegend(); }, 480);
});
gridEl.addEventListener('pointermove', e => {
  const dx = e.clientX - lpX, dy = e.clientY - lpY;
  if (!dragAxis){
    if (lpFired) return;
    if (Math.abs(dx) < SWIPE_PREP_PX && Math.abs(dy) < SWIPE_PREP_PX) return;
    clearTimeout(lpTimer);
    dragAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    dragSize = dragAxis === 'x' ? gridEl.clientWidth : gridEl.clientHeight;
    if (canSwipe(dragAxis)) buildCarousel(dragAxis);
  }
  if (!swiped){
    const primary = Math.abs(dragAxis === 'x' ? dx : dy);
    if (primary < SWIPE_START_PX) return;
    swiped = true;                           // suppress the tap-to-readout click
  }
  let off = dragAxis === 'x' ? dx : dy;
  if (!canSwipe(dragAxis)) off *= 0.2;       // nowhere to go → rubber-band
  dragOff = off;
  applyDrag(off, 0);
});
function endDrag(e){
  clearTimeout(lpTimer);
  try { gridEl.releasePointerCapture(e.pointerId); } catch {}
  if (!dragAxis){
    // Resolve the cell at release time. A tap can begin while slideCommit() is
    // replacing the old grid, in which case browsers commonly discard `click`
    // because its pointerdown target no longer exists.
    if (!lpFired){
      const c = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cell');
      if (c && gridEl.contains(c) && !c.classList.contains('empty')){
        suppressTipGridClickUntil = performance.now() + 350;
        showTip(+c.dataset.di, +c.dataset.h, c);
      }
    }
    return;
  }
  if (!swiped){ resetSlide(); return; }
  // A drag's synthetic click (when the browser emits one) fires before the next
  // task. Clear the guard afterward too, so browsers that suppress that click do
  // not make the user's next real tap pay for the preceding swipe.
  setTimeout(() => { swiped = false; }, 0);
  const axis = dragAxis, off = dragOff;
  if (canSwipe(axis) && Math.abs(off) > Math.min(90, dragSize * 0.22)){
    slideCommit(axis, off < 0 ? -1 : 1);
  } else {
    applyDrag(0, 140);                        // spring back
    clearTimeout(slideCleanupT);
    slideCleanupT = setTimeout(resetSlide, 160);
  }
}
gridEl.addEventListener('pointerup', endDrag);
gridEl.addEventListener('pointercancel', endDrag);
function showTip(di, h, el){
  const cell = days[di]?.cells[h];
  if (!cell) return;
  if (selEl) selEl.classList.remove('sel');
  const c = cellRGB(cell);
  selEl = el; selDi = di; selH = h; el.classList.add('sel');
  placeSunMarkers(di);

  const color = rgbStr(c);
  const tF = Math.round(displayTemp(cell.c));
  const day = days[di];
  const kind = precipKind(cell);
  const precip = kind ? `${cell.pop | 0}% ${kind.label}` : 'Dry';
  const wind = cell.windMph == null ? '' : `Wind ${Math.round(cell.windMph)} mph`;
  const location = place.name && place.name !== '—' ? place.name : 'Current location';
  const head = `
    <span class="tip-place">${escapeHtml(location)}</span>
    <span class="tip-time">${day.dow} ${fmtHourLong(h)}</span>`;
  const facts = [precip, wind].filter(Boolean)
    .map(v => `<span>${v}</span>`)
    .join('');
  const primary = settings.view === 'run'
    ? `<span class="tip-primary"><span class="tip-primary-label">Run Index</span><strong>${runIndex(cell)}</strong><span class="swatch" style="background:${color}"></span></span>
       <span class="tip-facts"><span>${tF}${unitGlyph()}</span>${facts}</span>`
    : `<span class="tip-primary"><span class="swatch" style="background:${color}"></span><strong>${tF}${unitGlyph()}</strong></span>
       <span class="tip-facts">${facts}</span>`;
  let why = '';
  if (settings.view === 'run' && testActive){
    const rows = runBreakdown(cell)
      .map(r => `<span><span>${r.label}</span><span>${r.val}</span><b>${r.s == null ? '—' : r.s.toFixed(2)}</b></span>`)
      .join('');
    why = `<span class="tip-why">${rows}<span class="tip-calc-total"><span>Geometric mean</span><b>${runIndex(cell)}</b></span></span>`;
  }
  const solar = solarEventsForHour(day, h)
    .map(ev => `${ev.label} · ${fmtClockMinute(ev.hour, ev.minute)}`)
    .join(' · ');
  const event = solar ? `<span class="tip-event">${escapeHtml(solar)}</span>` : '';
  tipEl.innerHTML = head + primary + why + event;
  tipEl.classList.toggle('top', orientation === 'p');   // portrait: sit over the wee hours
  const cellH = gridEl.querySelector('.cell:not(.empty)')?.getBoundingClientRect().height || 0;
  tipEl.style.setProperty('--tip-shift', Math.round(cellH) + 'px');   // nudge up one rectangle
  tipEl.hidden = false;
  applyPopupPosition('tip', tipEl);
  keepPopupOffRect(tipEl, el?.getBoundingClientRect());
  clearTimeout(tipTimer);
  tipTimer = setTimeout(hideTip, 15000);
}
function hideTip(){
  clearTimeout(tipTimer);
  tipEl.hidden = true;
  if (selEl){ selEl.classList.remove('sel'); selEl = null; }
  clearSunMarkers();
  selDi = selH = null;
}
// After a re-render (location swipe, view toggle, refresh), re-pin the popup to the
// same cell in the freshly-rendered grid so it shows current data — or hide it if
// that cell no longer exists.
function refreshTip(){
  if (tipEl.hidden || selDi == null) return;
  const el = gridEl.querySelector(`.cell[data-di="${selDi}"][data-h="${selH}"]`);
  if (el && !el.classList.contains('empty')) showTip(selDi, selH, el);
  else hideTip();
}
function dismissTipFromPopup(){
  suppressTipGridClickUntil = performance.now() + 450;
  setTimeout(hideTip, 0);
}
document.addEventListener('click', e => {
  if (!e.target.closest('.cell') && !e.target.closest('.tip')) hideTip();
}, true);
makeDraggablePopup('tip', tipEl, () => {
  clearTimeout(tipTimer);
  if (!tipEl.hidden) tipTimer = setTimeout(hideTip, 15000);
}, () => clearTimeout(tipTimer), null, dismissTipFromPopup);

/* ---------- Settings sheet ---------- */
let shareFile = null, shareRevision = 0, shareBuiltRevision = -1;
let sharePreparing = false;
function setShareButtonReady(ready){
  const button = $('#shareView');
  button.disabled = !ready;
}
function invalidateShare(){
  shareRevision++;
  shareFile = null;
  shareBuiltRevision = -1;
  setShareButtonReady(false);
  if (!sheetEl.hidden) setTimeout(() => { if (!sheetEl.hidden) prepareShare(); }, 0);
}
async function prepareShare(){
  if (!currentForecastMeta || gridEl.classList.contains('loading')){
    setShareButtonReady(false);
    return;
  }
  if (shareFile && shareBuiltRevision === shareRevision){
    setShareButtonReady(true);
    return;
  }
  if (sharePreparing) return;
  const revision = shareRevision;
  sharePreparing = true;
  try {
    const file = await AppCore.createGridSnapshotFile({
      grid: gridEl,
      overlays: [fx.wcanvas, fx.canvas],
      appName: APP_NAME,
      placeName: place.name,
      filenamePrefix: '24x7',
      snapshotClass: 'snapshot-no-cell-borders',
    });
    if (revision !== shareRevision) return;
    shareFile = file;
    shareBuiltRevision = revision;
    setShareButtonReady(true);
  } catch (err) {
    if (revision !== shareRevision) return;
    console.warn(err);
  } finally {
    sharePreparing = false;
    if (revision !== shareRevision && !sheetEl.hidden){
      setTimeout(() => { if (!sheetEl.hidden) prepareShare(); }, 0);
    }
  }
}
function openSheet(){
  syncSheet();
  sheetEl.hidden = false;
  if (shareFile && shareBuiltRevision === shareRevision) setShareButtonReady(true);
  else { setShareButtonReady(false); prepareShare(); }
}
function closeSheet(){ sheetEl.hidden = true; }
sheetEl.addEventListener('click', e => { if (e.target.dataset.close !== undefined) closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSheet(); hideTip(); } });

$('#shareView').addEventListener('click', async () => {
  const button = $('#shareView');
  if (!shareFile) return;
  button.disabled = true;
  closeSheet();
  hideTip();
  legendEl.hidden = true;
  try {
    await AppCore.shareSnapshotFile(shareFile, {
      appName: APP_NAME,
      placeName: place.name,
      url: 'https://dsparks.github.io/24x7/',
    });
  } catch (err) {
    if (err?.name !== 'AbortError'){
      console.warn(err);
      AppCore.showToast('Couldn’t create the screenshot');
    }
  } finally {
    button.disabled = false;
  }
});

function syncSheet(){
  $('#appName').textContent = APP_NAME;
  $('#placeName').textContent = place.name;
  $('#placeSub').textContent = place.sub || '';
  document.querySelectorAll('.seg').forEach(seg => {
    const key = seg.dataset.setting;
    const val = String(settings[key]);
    seg.querySelectorAll('button').forEach(b =>
      b.classList.toggle('on', b.dataset.value === val));
  });
  document.querySelectorAll('[data-temp-only]').forEach(el =>
    el.style.display = settings.view === 'run' ? 'none' : '');
  $('#numbersLabel').textContent = settings.view === 'run' ? 'Show Run Index numbers' : 'Show temperature numbers';
  renderPlaceList();
}
document.querySelectorAll('.seg').forEach(seg => {
  seg.addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn) return;
    const key = seg.dataset.setting;
    let v = btn.dataset.value;
    if (v === 'true') v = true; else if (v === 'false') v = false;
    settings[key] = v;
    saveSettings();
    syncSheet();
    render();
    if (key === 'view' || key === 'palette' || key === 'unit') showLegend();
  });
});

/* ---------- Run Index curve editor ---------- */
const SVGNS = 'http://www.w3.org/2000/svg';
const VBW = 320, VBH = 124, PADL = 26, PADR = 10, PADT = 10, PADB = 22;
const PLOTW = VBW - PADL - PADR, PLOTH = VBH - PADT - PADB;
const pX = (i, n) => PADL + i * PLOTW / (n - 1);
const pY = y => PADT + (1 - y) * PLOTH;
const svgEl = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

function buildRunEditor(){
  const host = $('#runDims'); host.innerHTML = '';
  for (const dim of RUN_DIMS){
    const n = dimPoints(dim);
    const curve = settings.runCurves[dim.key];
    const wrap = document.createElement('div'); wrap.className = 'rdim';
    const lab = document.createElement('div'); lab.className = 'rdim-label';
    lab.innerHTML = `${dim.label}${dim.unit ? ` <span>${dim.unit}</span>` : ''}`;
    wrap.appendChild(lab);
    const svg = svgEl('svg', { class: 'curve', viewBox: `0 0 ${VBW} ${VBH}` });

    TIERS.forEach(({ y, l }) => {
      svg.appendChild(svgEl('line', { class: l ? 'guide' : 'guide minor', x1: PADL, y1: pY(y), x2: VBW - PADR, y2: pY(y) }));
      if (l){ const lx = svgEl('text', { class: 'guide-l', x: 2, y: pY(y) + 2 }); lx.textContent = l; svg.appendChild(lx); }
    });
    for (let i = 0; i < n; i++){
      const tx = svgEl('text', { class: 'xl', x: pX(i, n), y: VBH - 6, 'text-anchor': 'middle' });
      tx.textContent = dim.ticks ? dim.ticks[i] : (dim.min + i * dim.step);
      svg.appendChild(tx);
    }
    const poly = svgEl('polyline', { class: 'curve-line' }); svg.appendChild(poly);
    const knobs = [];
    for (let i = 0; i < n; i++){ const k = svgEl('circle', { class: 'knob', r: 6, cx: pX(i, n) }); knobs.push(k); svg.appendChild(k); }
    wrap.appendChild(svg); host.appendChild(wrap);

    const redraw = () => {
      poly.setAttribute('points', curve.map((y, i) => `${pX(i, n)},${pY(y)}`).join(' '));
      knobs.forEach((k, i) => k.setAttribute('cy', pY(curve[i])));
    };
    redraw();

    const yFromEvent = ev => {
      const r = svg.getBoundingClientRect();
      const sy = (ev.clientY - r.top) * (VBH / r.height);
      return Math.max(0, Math.min(1, (PADT + PLOTH - sy) / PLOTH));
    };
    const nearestIndex = ev => {
      const r = svg.getBoundingClientRect();
      const sx = (ev.clientX - r.left) * (VBW / r.width);
      let bi = 0, bd = Infinity;
      for (let i = 0; i < n; i++){ const d = Math.abs(sx - pX(i, n)); if (d < bd){ bd = d; bi = i; } }
      return bi;
    };
    let active = -1;
    const set = ev => { curve[active] = snapTier(yFromEvent(ev)); redraw(); scheduleRunApply(); };
    const move = ev => { if (active < 0) return; set(ev); ev.preventDefault(); };
    const up = () => { if (active < 0) return; active = -1; saveSettings(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    svg.addEventListener('pointerdown', ev => {
      active = nearestIndex(ev); set(ev);
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      ev.preventDefault();
    });
  }
}

let runApplyRaf = 0;
function scheduleRunApply(){
  if (settings.view !== 'run' || runApplyRaf) return;
  runApplyRaf = requestAnimationFrame(() => { runApplyRaf = 0; recolorRun(); });
}
function recolorRun(){       // live recolor without rebuilding the grid DOM
  gridEl.querySelectorAll('.cell').forEach(el => {
    if (el.classList.contains('empty')) return;
    const cell = days[+el.dataset.di]?.cells[+el.dataset.h];
    if (!cell) return;
    const c = cellRGB(cell); el.style.background = rgbStr(c);
    const t = el.querySelector('.t');
    if (t){ t.style.color = effInk(+el.dataset.di, +el.dataset.h, c); t.textContent = cellNumber(cell) ?? ''; }
  });
  invalidateShare();
}

const runEditorEl = $('#runEditor');
function openRunEditor(){
  if (settings.view !== 'run'){ settings.view = 'run'; saveSettings(); syncSheet(); render(); }
  buildRunEditor();
  sheetEl.hidden = true;
  runEditorEl.hidden = false;
}
function closeRunEditor(){ runEditorEl.hidden = true; }
$('#runEditBtn').addEventListener('click', openRunEditor);
$('#runBack').addEventListener('click', () => { closeRunEditor(); sheetEl.hidden = false; });
runEditorEl.addEventListener('click', e => { if (e.target.dataset.rclose !== undefined) closeRunEditor(); });
$('#runReset').addEventListener('click', () => {
  for (const d of RUN_DIMS) settings.runCurves[d.key] = d.def.map(snapTier);
  saveSettings(); buildRunEditor(); recolorRun();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !runEditorEl.hidden) closeRunEditor(); });

/* ---------- How to use / about ---------- */
const aboutEl = $('#aboutSheet');
$('#aboutBtn').addEventListener('click', () => { sheetEl.hidden = true; aboutEl.hidden = false; });
$('#aboutBack').addEventListener('click', () => { aboutEl.hidden = true; sheetEl.hidden = false; });
aboutEl.addEventListener('click', e => { if (e.target.dataset.aclose !== undefined) aboutEl.hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !aboutEl.hidden) aboutEl.hidden = true; });

/* ---------- First-run coach marks (shown once) ---------- */
const coachEl = $('#coach');
function closeCoach(){ coachEl.hidden = true; try { localStorage.setItem(LS.coach, '1'); } catch {} }
$('#coachGot').addEventListener('click', closeCoach);
$('#coachMore').addEventListener('click', () => { closeCoach(); aboutEl.hidden = false; });
coachEl.addEventListener('click', e => { if (e.target.dataset.coachclose !== undefined) closeCoach(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !coachEl.hidden) closeCoach(); });
(function maybeShowCoach(){
  if (BOT_RENDER) return;
  let seen = false; try { seen = localStorage.getItem(LS.coach) === '1'; } catch {}
  if (!seen) coachEl.hidden = false;                  // appears over the first (placeholder) paint
})();

/* ---------- Swipe a sheet down to dismiss it, like a drawer ---------- */
function enableSheetSwipe(card, onClose){
  if (!card) return;
  // Don't hijack drags that begin on something interactive (buttons, the city
  // search, the Run Index drag-points) — those need the gesture for themselves.
  const IGNORE = 'input,textarea,button,.seg,#runDims,.results,.placelist,a';
  const CLOSE_PX = 90, FLICK = 0.5;     // dismiss past 90px, or on a quick flick
  let startY = 0, startScroll = 0, startT = 0, dy = 0, dragging = false, tracking = false;

  const reset = () => { card.style.transition = ''; card.style.transform = ''; card.style.opacity = ''; };

  card.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || e.target.closest(IGNORE)) { tracking = false; return; }
    startY = e.touches[0].clientY; startScroll = card.scrollTop; startT = e.timeStamp;
    dy = 0; dragging = false; tracking = true;
  }, { passive: true });

  card.addEventListener('touchmove', e => {
    if (!tracking) return;
    const delta = e.touches[0].clientY - startY;
    if (!dragging){
      // engage only when pulling down from the very top of the scroll area
      if (delta > 6 && card.scrollTop <= 0 && startScroll <= 0){ dragging = true; card.style.transition = 'none'; }
      else if (delta < 0 || card.scrollTop > 0){ tracking = false; return; }   // it's a scroll
      else return;
    }
    dy = Math.max(0, delta);
    e.preventDefault();                 // stop the page/card from scrolling while we drag
    card.style.transform = `translate(-50%, ${dy}px)`;
    card.style.opacity = String(Math.max(0.4, 1 - dy / 600));
  }, { passive: false });

  const finish = e => {
    if (!tracking) return;
    const wasDrag = dragging; tracking = false; dragging = false;
    const vel = dy / ((e.timeStamp - startT) || 1);
    if (wasDrag && (dy > CLOSE_PX || vel > FLICK)){
      card.style.transition = 'transform .2s ease, opacity .2s ease';
      card.style.transform = `translate(-50%, ${card.offsetHeight}px)`;
      card.style.opacity = '0';
      setTimeout(() => { onClose(); reset(); }, 200);
    } else if (wasDrag){
      card.style.transition = 'transform .2s ease, opacity .2s ease';
      card.style.transform = ''; card.style.opacity = '';
      setTimeout(() => { card.style.transition = ''; }, 200);
    }
  };
  card.addEventListener('touchend', finish);
  card.addEventListener('touchcancel', finish);
}
enableSheetSwipe(sheetEl.querySelector('.sheet-card'), closeSheet);
enableSheetSwipe(runEditorEl.querySelector('.sheet-card'), closeRunEditor);
enableSheetSwipe(aboutEl.querySelector('.sheet-card'), () => { aboutEl.hidden = true; });

/* ---------- "Install as an app" tip ---------- */
(() => {
  const tip = $('#installTip'), link = $('#installLink'), hint = $('#installHint');
  if (!tip) return;
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (installed){ tip.hidden = true; return; }   // already running fullscreen — nothing to suggest

  let deferred = null;   // Chrome/Edge/Android fire this; we trigger it on click
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; });
  addEventListener('appinstalled', () => { tip.hidden = true; });

  const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  link.addEventListener('click', async e => {
    e.preventDefault();
    if (deferred){                       // native install prompt available
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
    } else {                             // no programmatic install (iOS Safari, etc.) — show how
      hint.hidden = false;
      hint.textContent = isiOS
        ? ' Tap the Share button, then “Add to Home Screen.”'
        : ' Open your browser menu and choose “Install” or “Add to Home Screen.”';
    }
  });
})();

/* ---------- Location: geolocation + Open-Meteo geocoding ---------- */
function setPlace(name, sub){
  place = { name, sub: sub || '' };
  if (BOT_RENDER){
    const botPlace = $('#botPlace');
    if (botPlace) botPlace.textContent = name || BOT_LABEL || 'Weather';
  }
  if (!sheetEl.hidden) syncSheet();
  if (!legendEl.hidden) legendEl.querySelector('.legend-place').textContent = legendPlace();
  if (currentForecastMeta) invalidateShare();
}

async function geocode(q, signal){
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en&format=json`;
  const j = await AppCore.fetchJson(url, { signal, label: 'Search', timeoutMs: 12000 });
  return j.results || [];
}
/* ---------- Saved locations ---------- */
// Monotonic intent token: late GPS/geocoder callbacks may cache their result, but
// only the location the user most recently chose is allowed to change the UI.
let locationIntent = 0;
function placeItem(name, active, onSelect, onDelete){
  const row = document.createElement('div');
  row.className = 'place-item' + (active ? ' on' : '');
  const label = document.createElement('button');
  label.type = 'button'; label.className = 'pi-name'; label.textContent = name;
  label.addEventListener('click', onSelect);
  row.appendChild(label);
  if (onDelete){
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'pi-del'; del.setAttribute('aria-label', 'Remove'); del.textContent = '✕';
    del.addEventListener('click', e => { e.stopPropagation(); onDelete(); });
    row.appendChild(del);
  }
  return row;
}
function currentLocationLabel(){
  const placeholder = new Set(['—', 'Locating…', 'Current location', 'Location unavailable', 'Location blocked']);
  if (settings.activeIdx == null && place.name && !placeholder.has(place.name)){
    return '📍 ' + place.name + (place.sub ? `, ${place.sub}` : '');
  }
  return '📍 My location';
}
function renderPlaceList(){
  const host = $('#placeList'); if (!host) return;
  host.innerHTML = '';
  host.appendChild(placeItem(currentLocationLabel(), settings.activeIdx == null, () => switchTo(null)));
  settings.places.forEach((p, i) =>
    host.appendChild(placeItem(
      p.name + (p.admin ? `, ${p.admin}` : ''),
      settings.activeIdx === i,
      () => switchTo(i),
      () => removePlace(i)
    )));
}
function switchTo(idx){
  const intent = ++locationIntent;
  settings.activeIdx = idx;
  saveSettings();
  renderPlaceList();
  const p = idx != null ? settings.places[idx] : null;
  if (p?.test){ loadTest(); }
  else if (p){ testActive = false; setPlace(p.name, p.admin || ''); load(p.lat, p.lon); }
  else if (myCoords){                                                       // skip GPS — coords already known
    testActive = false;
    setPlace(myPlace?.name || 'Current location', myPlace?.sub || '');      // show the cached name immediately
    load(myCoords.lat, myCoords.lon);
    reverseName(myCoords.lat, myCoords.lon, intent).then(p => { if (p) myPlace = p; });
  }
  else { testActive = false; setPlace('Locating…', ''); locate(intent); }
}
function removePlace(i){
  const wasActive = settings.activeIdx === i;
  settings.places.splice(i, 1);
  if (settings.activeIdx === i) settings.activeIdx = null;          // fall back to my-location
  else if (settings.activeIdx > i) settings.activeIdx--;            // keep pointing at same place
  saveSettings();
  if (wasActive) switchTo(settings.activeIdx); else renderPlaceList();
}
function addPlace(r){
  const np = { lat: r.latitude, lon: r.longitude, name: r.name, admin: [r.admin1, r.country_code].filter(Boolean).join(', ') };
  const dup = settings.places.findIndex(p => Math.abs(p.lat - np.lat) < 0.01 && Math.abs(p.lon - np.lon) < 0.01);
  switchTo(dup >= 0 ? dup : settings.places.push(np) - 1);
}

/* ---------- Hidden "test weather" location: type a magic string to add it; each
   load synthesizes a fresh, deliberately varied week so every state is visible. ---------- */
const TEST_QUERIES = ['!test', '!demo', '!random'];
const isTestQuery = q => TEST_QUERIES.includes(q.trim().toLowerCase());
let testActive = false;

function generateTestForecast(){
  const pad = n => String(n).padStart(2, '0');
  const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
  const hm = f => `${pad(Math.floor(f))}:${pad(Math.round((f % 1) * 60))}`;
  const dKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hKey = d => `${dKey(d)}T${pad(d.getHours())}:00`;

  const hourly = { time: [], temperature_2m: [], precipitation_probability: [], precipitation: [], snowfall: [], apparent_temperature: [], dewpoint_2m: [], relative_humidity_2m: [], wind_speed_10m: [], wind_direction_10m: [], cloud_cover: [], weather_code: [] };
  const daily = { time: [], sunrise: [], sunset: [] };
  const start = new Date(); start.setHours(0, 0, 0, 0);

  const weekBaseC = rand(-22, 30);          // wide band so loads range cold-pink → hot-maroon
  const weekRange = rand(10, 34);
  for (let day = 0; day < 7; day++){
    const d0 = new Date(start.getTime() + day * 86400000);
    daily.time.push(dKey(d0));
    daily.sunrise.push(`${dKey(d0)}T${hm(rand(4.5, 7))}`);
    daily.sunset.push(`${dKey(d0)}T${hm(rand(18, 21.5))}`);

    const dayMeanC = weekBaseC + (day / 6 - 0.5) * weekRange + rand(-3, 3);
    const amp = rand(4, 9);                  // diurnal swing
    const wet = Math.random() < 0.6;
    const thunder = wet && dayMeanC > 12 && Math.random() < 0.5;   // warm + wet day may storm
    const icy = wet && dayMeanC > -5 && dayMeanC < 2 && Math.random() < 0.5;   // near-freezing wet day → freezing rain
    const stormH = rand(0, 23), stormW = rand(2, 8), peakMm = rand(0.2, 4);
    const windBase = rand(2, 14), windGust = rand(0, 26), windPhase = rand(0, 6.28);
    const dirBase = rand(0, 360), dirDrift = rand(-40, 40);   // a slowly-veering wind direction across the day
    for (let h = 0; h < 24; h++){
      const t = new Date(d0.getTime() + h * 3600000);
      hourly.time.push(hKey(t));

      const diurnal = -Math.cos((h - 5) / 24 * 2 * Math.PI);   // coldest ~5am, warmest ~3pm
      const tempC = dayMeanC + diurnal * amp + rand(-1.2, 1.2);
      hourly.temperature_2m.push(r1(tempC));

      let mm = 0, pop = Math.round(cl(rand(-25, 40), 0, 100));
      const g = wet ? Math.exp(-((h - stormH) ** 2) / (2 * stormW * stormW)) : 0;
      if (wet){
        mm = peakMm * g * rand(0.4, 1.2);
        pop = Math.round(cl(40 + g * 60 + rand(-12, 12), 0, 100));
      }
      const snow = (!icy && tempC <= 0.5 && mm > 0) ? mm * rand(0.6, 1) : 0;   // icy days fall as freezing rain, not snow
      hourly.precipitation.push(r2(mm));
      hourly.snowfall.push(r2(snow));
      hourly.precipitation_probability.push(pop);

      const wind = cl(windBase + windGust * Math.max(0, Math.sin(h / 24 * 6.28 + windPhase)) * rand(0.4, 1) + rand(-2, 2), 0, 52);
      hourly.wind_speed_10m.push(r1(wind));
      hourly.wind_direction_10m.push(Math.round(((dirBase + dirDrift * (h / 23) + rand(-12, 12)) % 360 + 360) % 360));

      const rh = Math.round(cl(55 + (wet ? 18 : 0) + rand(-28, 28), 12, 100));
      hourly.relative_humidity_2m.push(rh);
      hourly.dewpoint_2m.push(r1(tempC - (100 - rh) / 5));
      const appC = tempC - (tempC < 10 ? wind * 0.08 : 0) + (tempC > 25 ? (rh - 50) / 12 : 0);
      hourly.apparent_temperature.push(r1(appC));

      // cloud cover: heavy where it's raining, clear on dry hours (→ clear nights for stars)
      hourly.cloud_cover.push(Math.round(cl(g * 90 + (wet ? 25 : 0) + rand(-18, 18), 0, 100)));
      // weather code: thunderstorm at a wet day's core, else rough sky/precip class
      let wc = 0;
      if (mm > 0.05) wc = icy ? (mm > 0.4 ? 67 : 66) : (snow > 0 ? 73 : (thunder && g > 0.72 ? 95 : (mm > 0.4 ? 65 : 61)));
      else wc = hourly.cloud_cover[hourly.cloud_cover.length - 1] > 60 ? 3 : (hourly.cloud_cover[hourly.cloud_cover.length - 1] > 25 ? 2 : 0);
      hourly.weather_code.push(wc);
    }
  }
  return { hourly, daily };
}
function loadTest(){
  ++loadSeq;                                // invalidate any older real forecast still in flight
  testActive = true; lastCoords = null;     // skip cache writes & auto-refresh for synthetic data
  setPlace('Test weather', 'randomized — re-tap to re-roll');
  applyForecast(testForecast(), Date.now());   // reuse the cached week so swipe-in matches the ghost & is instant
}
function addTestPlace(){
  testForecastCache = null;                 // explicit (re-)roll: regenerate the week
  let idx = settings.places.findIndex(p => p.test);
  if (idx < 0) idx = settings.places.push({ name: '🎲 Test weather', test: true }) - 1;
  switchTo(idx);                            // re-rolls even if it was already active
}

/* ---------- Location search: live, race-safe typeahead ---------- */
const searchBox = $('#searchBox'), searchInput = $('#searchInput'), searchClear = $('#searchClear'), resultsEl = $('#searchResults');
let searchSeq = 0;          // monotonic token: only the latest query may render
let searchAbort = null;     // cancels the in-flight fetch when a newer keystroke arrives
let searchTimer = 0;
let hits = [];              // current result objects
let activeIdx = -1;         // keyboard-highlighted row

const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const flagOf = cc => (cc && cc.length === 2)
  ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65))
  : '📍';
function highlightMatch(name, q){            // bold the matched run within the city name
  const i = name.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return escHtml(name);
  return escHtml(name.slice(0, i)) + '<b>' + escHtml(name.slice(i, i + q.length)) + '</b>' + escHtml(name.slice(i + q.length));
}
function openResults(){ resultsEl.hidden = false; searchBox.setAttribute('aria-expanded', 'true'); }
function closeResults(){
  resultsEl.hidden = true; resultsEl.innerHTML = ''; hits = []; activeIdx = -1;
  searchBox.setAttribute('aria-expanded', 'false');
  searchInput.removeAttribute('aria-activedescendant');
}
function showMsg(text){ openResults(); resultsEl.innerHTML = `<li class="result-msg">${escHtml(text)}</li>`; hits = []; activeIdx = -1; }

function renderHits(items, q){
  hits = items; activeIdx = -1;
  resultsEl.innerHTML = '';
  items.forEach((r, i) => {
    const sub = [r.admin1, r.country].filter(Boolean).join(', ');
    const li = document.createElement('li');
    li.className = 'result'; li.id = 'sr-' + i; li.setAttribute('role', 'option');
    li.innerHTML = `<span class="r-flag">${flagOf(r.country_code)}</span>`
      + `<span class="r-text"><span class="r-name">${highlightMatch(r.name, q)}</span>`
      + (sub ? `<span class="r-sub">${escHtml(sub)}</span>` : '') + `</span>`;
    li.addEventListener('pointerdown', e => { e.preventDefault(); choose(i); });   // pointerdown beats input blur
    resultsEl.appendChild(li);
  });
  openResults();
}
function setActive(i){
  const rows = resultsEl.querySelectorAll('.result');
  if (!rows.length) return;
  activeIdx = (i + rows.length) % rows.length;
  rows.forEach((el, j) => el.setAttribute('aria-selected', j === activeIdx ? 'true' : 'false'));
  const el = rows[activeIdx];
  el.scrollIntoView({ block: 'nearest' });
  searchInput.setAttribute('aria-activedescendant', el.id);
}
function choose(i){
  const r = hits[i]; if (!r) return;
  addPlace(r); resetSearch();
}
function resetSearch(){ searchInput.value = ''; searchClear.hidden = true; closeResults(); }

/* Soft re-ranking of geocoder hits. All weights are ADDITIVE nudges on top of the
   API's own relevance order — nothing is filtered out, things just surface sooner.
   Tweak these freely: bigger number = stronger pull to the top. */
const RANK = {
  apiOrderPenalty: 0.6,   // cost per step down the API's original order (keeps its relevance as a baseline)
  exactName:       6,     // result name exactly equals the query
  prefixName:      3,     // result name starts with the query
  popMax:          5,     // cap on the population boost (log-scaled: 10k→+1, 100k→+2, 1M→+4, 10M→+5)
  usBias:          2.5,   // extra weight for US results (soft, not a hard filter)
  usLocaleBonus:   1.0,   // a little more US weight when the device locale is US
  proxMax:         3,     // max boost for a result right on top of you
  proxDecayKm:     1500,  // distance at which the proximity boost falls to ~37%
};
function haversineKm(aLat, aLon, bLat, bLon){
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(bLat - aLat), dLon = toR(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function rankHits(items, q, ref){
  const ql = q.toLowerCase();
  const usW = RANK.usBias + (usLocale() ? RANK.usLocaleBonus : 0);
  return items.map((r, i) => {
    let s = -i * RANK.apiOrderPenalty;
    const nl = (r.name || '').toLowerCase();
    if (nl === ql) s += RANK.exactName;
    else if (nl.startsWith(ql)) s += RANK.prefixName;
    if (r.population > 0) s += Math.max(0, Math.min(RANK.popMax, Math.log10(r.population) - 2));
    if (r.country_code === 'US') s += usW;
    if (ref && r.latitude != null && r.longitude != null){
      s += RANK.proxMax * Math.exp(-haversineKm(ref.lat, ref.lon, r.latitude, r.longitude) / RANK.proxDecayKm);
    }
    return { r, s, i };
  }).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.r);
}

async function runSearch(q){
  const seq = ++searchSeq;
  searchAbort?.abort();
  searchAbort = new AbortController();
  showMsg('Searching…');
  try {
    const res = await geocode(q, searchAbort.signal);
    if (seq !== searchSeq) return;                 // a newer query superseded us
    if (!res.length) return showMsg('No matches');
    renderHits(rankHits(res, q, lastCoords), q);   // soft re-rank: closeness + US + population
  } catch (err) {
    if (err.name === 'AbortError' || seq !== searchSeq) return;
    showMsg('Search error — try again');
  }
}

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  searchClear.hidden = !searchInput.value;
  clearTimeout(searchTimer);
  if (isTestQuery(q)){                              // surface the hidden test location as a pickable row
    hits = []; activeIdx = -1; openResults();
    resultsEl.innerHTML = `<li class="result" id="sr-0" role="option"><span class="r-flag">🎲</span><span class="r-text"><span class="r-name">Add test weather</span><span class="r-sub">a randomly generated week</span></span></li>`;
    resultsEl.querySelector('.result').addEventListener('pointerdown', e => { e.preventDefault(); resetSearch(); addTestPlace(); });
    return;
  }
  if (q.length < 2){ closeResults(); return; }
  searchTimer = setTimeout(() => runSearch(q), 220);
});
searchInput.addEventListener('keydown', e => {
  const q = searchInput.value.trim();
  if (e.key === 'ArrowDown'){ if (!resultsEl.hidden) { setActive(activeIdx + 1); e.preventDefault(); } }
  else if (e.key === 'ArrowUp'){ if (!resultsEl.hidden) { setActive(activeIdx - 1); e.preventDefault(); } }
  else if (e.key === 'Enter'){
    e.preventDefault();
    if (isTestQuery(q)){ resetSearch(); addTestPlace(); return; }
    if (activeIdx >= 0) choose(activeIdx);
    else if (hits.length) choose(0);                // Enter picks the top hit
  } else if (e.key === 'Escape'){
    if (!resultsEl.hidden) closeResults(); else resetSearch();
  }
});
searchClear.addEventListener('click', () => { resetSearch(); searchInput.focus(); });
searchInput.addEventListener('blur', () => setTimeout(closeResults, 120));   // let a row's pointerdown land first
searchInput.addEventListener('focus', () => { if (hits.length || searchInput.value.trim().length >= 2) openResults(); });

function locate(intent = ++locationIntent){
  if (!('geolocation' in navigator)){
    if (intent === locationIntent) setPlace('Location unavailable', 'Search in settings');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      if (intent !== locationIntent) return;
      myCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      setPlace(myPlace?.name || 'Current location', myPlace?.sub || '');   // instant if we've named it before
      load(myCoords.lat, myCoords.lon);
      reverseName(myCoords.lat, myCoords.lon, intent).then(p => { if (p) myPlace = p; });
    },
    () => { if (intent === locationIntent) setPlace('Location blocked', 'Search in settings ⚙'); },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 }
  );
}
async function lookupName(lat, lon){             // reverse-geocode → { name, sub } | null (no UI change)
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`;
    const j = await AppCore.fetchJson(url, { label: 'Reverse geocode', timeoutMs: 12000 });
    const a = j.address || {};
    const name = a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || a.county || j.name;
    const country = a.country_code ? a.country_code.toUpperCase() : '';
    const sub = [a.state, country].filter(Boolean).join(', ');
    return name ? { name, sub } : null;
  } catch { return null; /* name is cosmetic; ignore */ }
}
async function reverseName(lat, lon, intent = locationIntent){  // …and reflect it in the header
  const p = await lookupName(lat, lon);
  if (intent !== locationIntent) return null;
  if (p) setPlace(p.name, p.sub);
  return p;
}

/* ---------- Load orchestration (instant cache → fresh) ---------- */
function readCache(){
  return AppCore.readJson(LS.cache);
}
function writeCache(lat, lon, json, t = Date.now()){
  AppCore.writeJson(LS.cache, { lat, lon, t, json });
}
function formatDataTimestamp(t, source = 'fresh'){
  const prefix = source === 'cached' ? 'Cached' : source === 'stale' ? 'Stale' : 'Updated';
  return AppCore.formatUpdated(t, prefix);
}
function applyForecast(json, fetchedAt = Date.now(), source = 'fresh'){
  currentForecastMeta = forecastMeta(json);
  days = toDays(json);
  render();
  $('#updatedAt').textContent = formatDataTimestamp(fetchedAt, source);
  if (source === 'fresh') markBotReady();
}

let loadSeq = 0, lastCoords = null, lastLoadedAt = 0;
function cacheMatches(cache, lat, lon){
  return AppCore.cacheMatches(cache, lat, lon);
}
function showLoadingScaffold(){
  currentForecastMeta = null;
  days = placeholderDays();
  render();
  gridEl.classList.add('loading');
}
async function load(lat, lon){
  testActive = false;
  const seq = ++loadSeq;
  lastCoords = { lat, lon };
  const warm = fcCache.get(fcKey(lat, lon));        // already have a recent forecast? paint it now
  if (warm) applyForecast(warm.json, warm.t, 'cached');
  else showLoadingScaffold();
  try {
    const json = await fetchForecast(lat, lon);
    if (seq !== loadSeq) return;          // a newer load superseded this one
    lastLoadedAt = Date.now();
    writeCache(lat, lon, json, lastLoadedAt);
    cacheForecast(lat, lon, json, lastLoadedAt);
    applyForecast(json, lastLoadedAt);
    prefetchNeighbors();                   // warm the panes one swipe to either side
  } catch (err) {
    if (warm) $('#updatedAt').textContent = formatDataTimestamp(warm.t, 'stale');
    else {
      setPlace('Couldn’t load forecast', 'Tap ⚙ to retry');
      $('#updatedAt').textContent = 'Forecast unavailable';
    }
    if (BOT_RENDER) window.__24x7Bot = { status: 'error', message: err?.message || 'Forecast unavailable' };
    console.warn(err);
  } finally {
    if (seq === loadSeq){
      gridEl.classList.remove('loading');
      invalidateShare();
    }
  }
}

/* ---------- Neighbor prefetch ----------
 * A swipe should reveal a real grid, not a blank pane. We keep recent forecasts in
 * memory and, after each load, quietly fetch the locations one swipe to either side
 * so the incoming pane paints instantly (the fresh load then refreshes it). The other
 * VIEW needs no prefetch — Temp and Run share the same data, just recolored. */
let myCoords = null, myPlace = null;              // last GPS fix + its resolved {name, sub}
const fcCache = new Map();                        // "lat,lon" -> { json, t }
const fcKey = (lat, lon) => `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`;
function cacheForecast(lat, lon, json, t = Date.now()){
  fcCache.set(fcKey(lat, lon), { json, t });
  while (fcCache.size > 8) fcCache.delete(fcCache.keys().next().value);   // bound it
}
const sameSpot = (a, b) => a && b && Math.abs(a.lat - b.lat) < 0.05 && Math.abs(a.lon - b.lon) < 0.05;
function cycleList(){                               // ordered cycle: "my location" (null) + saved places,
  const list = [];                                 // but "my location" is dropped when it duplicates a saved place
  const dup = myCoords && settings.places.some(p => !p.test && sameSpot(myCoords, p));
  if (!dup) list.push(null);
  settings.places.forEach((_, i) => list.push(i));
  return list;
}
function cycleStep(dir){                            // the slot one step (in `dir`) from the active one
  const list = cycleList();
  if (list.length <= 1) return undefined;
  let i = list.indexOf(settings.activeIdx == null ? null : settings.activeIdx);
  if (i < 0) i = 0;                                 // active slot was deduped out → start at the first
  return list[(i + dir + list.length) % list.length];
}
function targetIndex(dir){ return cycleStep(dir); }  // null = "my location", number = saved, undefined = no cycle
function coordsForIndex(idx){
  if (idx === undefined) return null;
  if (idx === null) return myCoords;               // may be null if never located
  const p = settings.places[idx];
  return p && !p.test && p.lat != null ? { lat: p.lat, lon: p.lon } : null;
}
let testForecastCache = null;                       // generated once; reused so the test pane is instant
function testForecast(){ return testForecastCache || (testForecastCache = generateTestForecast()); }
function neighborDays(dir){                          // warm `days` for the pane in `dir` (real / my-location / test), or null
  const idx = targetIndex(dir);
  if (idx === undefined) return null;
  const p = idx == null ? null : settings.places[idx];
  if (p?.test) return toDays(testForecast());        // synthetic week — generate-once, no fetch
  const c = coordsForIndex(idx);
  const j = c ? fcCache.get(fcKey(c.lat, c.lon))?.json : null;
  return j ? toDays(j) : null;
}
function prefetchNeighbors(){
  // Warm both adjacent panes AND Current Location (even when it isn't adjacent), so
  // swiping into it never waits on geolocation + fetch. Pre-generate the test week too.
  const coords = [coordsForIndex(targetIndex(1)), coordsForIndex(targetIndex(-1)), myCoords].filter(Boolean);
  const seen = new Set();
  for (const c of coords){
    const k = fcKey(c.lat, c.lon);
    if (seen.has(k) || fcCache.has(k)) continue;
    seen.add(k);
    fetchForecast(c.lat, c.lon).then(json => cacheForecast(c.lat, c.lon, json)).catch(() => {});
  }
  if (settings.places.some(p => p.test)) testForecast();
}

/* ---------- Boot ---------- */
function boot(){
  // 1) Read persisted cache, but only paint it after we know it matches the target.
  const cache = readCache();
  if (cache?.json && cache.lat != null && cache.lon != null) cacheForecast(cache.lat, cache.lon, cache.json, cache.t || Date.now());

  // 2) URL deep-link wins: ?lat=&lon= or ?q=city (handy for sharing & headless testing).
  const qlat = parseFloat(PAGE_PARAMS.get('lat')), qlon = parseFloat(PAGE_PARAMS.get('lon')), qq = PAGE_PARAMS.get('q');
  if (Number.isFinite(qlat) && Number.isFinite(qlon)){
    const intent = ++locationIntent;
    if (cacheMatches(cache, qlat, qlon)) applyForecast(cache.json, cache.t, 'cached'); else showLoadingScaffold();
    setPlace(BOT_LABEL || 'Pinned location', `${qlat.toFixed(2)}, ${qlon.toFixed(2)}`);
    load(qlat, qlon);
    if (!BOT_LABEL) reverseName(qlat, qlon, intent);
    return;
  }
  if (qq){
    const intent = ++locationIntent;
    if (isTestQuery(qq)){ loadTest(); return; }
    showLoadingScaffold();
    setPlace('Locating…', '');
    geocode(qq).then(res => {
      if (intent !== locationIntent) return;
      const r = res[0];
      if (r){ setPlace(r.name, [r.admin1, r.country_code].filter(Boolean).join(', ')); load(r.latitude, r.longitude); }
      else locate(intent);
    }).catch(() => { if (intent === locationIntent) locate(intent); });
    return;
  }

  // 3) Resolve location & fetch fresh.
  const active = settings.activeIdx != null ? settings.places[settings.activeIdx] : null;
  if (active?.test){ loadTest(); return; }
  if (active){
    if (cacheMatches(cache, active.lat, active.lon)) applyForecast(cache.json, cache.t, 'cached'); else showLoadingScaffold();
    setPlace(active.name || 'Saved location', active.admin || '');
    load(active.lat, active.lon);
  } else {
    if (cache?.json){ applyForecast(cache.json, cache.t, 'cached'); }
    else showLoadingScaffold();
    setPlace('Locating…', '');
    // If cache exists, refresh its coords first for instant continuity, then geolocate.
    if (cache?.lat != null) load(cache.lat, cache.lon);
    locate();
  }
}

// Re-render on orientation flip (1fr handles plain resizes for free).
let rT;
window.addEventListener('resize', () => {
  clearTimeout(rT);
  rT = setTimeout(() => {
    if ((isPortrait() ? 'p' : 'l') !== orientation) render();   // render() re-lays the canvas
    else layoutFx();                                            // same orientation: just re-measure
    repositionVisiblePopups();
  }, 120);
});
window.addEventListener('orientationchange', () => setTimeout(() => { render(); repositionVisiblePopups(); }, 150));

// Live now-line: nudge it along every 30s (hour rollover lands on a fresh refetch).
setInterval(() => { if (days.length) placeNowLine(); }, 30000);
// Auto-refresh the forecast every 15 min so it never goes stale while left open.
setInterval(() => { if (lastCoords) load(lastCoords.lat, lastCoords.lon); }, 15 * 60 * 1000);
// Re-acquire Current Location every 5 min so its pane stays current as you move. Silent
// and gated on myCoords, so it only runs once Current Location has actually been used
// (never prompts a saved-place-only user); a denied permission just no-ops.
function refreshMyCoords(){
  if (!myCoords || !('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(pos => {
    const lat = pos.coords.latitude, lon = pos.coords.longitude;
    const moved = haversineKm(myCoords.lat, myCoords.lon, lat, lon) > 1;   // ignore <1km jitter
    myCoords = { lat, lon };
    if (!moved) return;
    if (settings.activeIdx == null && !testActive){
      load(lat, lon);                                                        // viewing it now → update grid + header
      reverseName(lat, lon, locationIntent).then(p => { if (p) myPlace = p; });
    } else {
      fetchForecast(lat, lon).then(j => cacheForecast(lat, lon, j)).catch(() => {});   // keep forecast warm
      lookupName(lat, lon).then(p => { if (p) myPlace = p; });               // refresh cached name, no UI change
    }
  }, () => {}, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
}
setInterval(refreshMyCoords, 5 * 60 * 1000);

// Register service worker for offline / installable PWA (no-op on file://).
if (!BOT_RENDER) AppCore.registerFreshServiceWorker('sw.js');

boot();

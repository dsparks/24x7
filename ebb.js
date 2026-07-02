/* Ebb — a week of fishing conditions as an ocean cutaway.
 * Each cell: pure-black water (height = tide), a sky colored by cloud cover and
 * time-of-day (golden hour → night with stars), wind as surface chop, plus precip.
 * Borrows the grid/layout/search scaffolding from its sibling 24×7. */
const APP_NAME = 'Ebb';
const $ = sel => document.querySelector(sel);
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));
const LS = { settings: 'ebb.settings', cache: 'ebb.cache', stations: 'ebb.stations', coach: 'ebb.coach' };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const { forecastMeta } = AppCore;
function forecastNow(meta = currentForecastMeta){ return AppCore.forecastNow(meta); }
const offsetForCalc = offset => Number.isFinite(offset) ? offset : -new Date().getTimezoneOffset() * 60;
function haversineKm(aLat, aLon, bLat, bLon){
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(bLat - aLat), dLon = toR(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const cToF = c => c == null ? null : c * 9 / 5 + 32;

const WD = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const usLocale = () => /^en-US|^en$/.test(navigator.language || 'en-US') || (navigator.language || '') === 'en';
function clock24(){ return settings.clock === '24' || (settings.clock === 'auto' && !usLocale()); }
function fmtHour(h){
  if (clock24()) return pad(h);
  if (h === 0) return '12a'; if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h - 12}p`;
}
function fmtHourLong(h){
  if (clock24()) return `${pad(h)}:00`;
  if (h === 0) return '12 AM'; if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}
function fmtClockMinute(h, m){
  if (clock24()) return `${pad(h)}:${pad(m)}`;
  const ap = h < 12 ? 'AM' : 'PM';
  const hh = h % 12 || 12;
  return `${hh}:${pad(m)} ${ap}`;
}
const COMPASS = ['N','NE','E','SE','S','SW','W','NW'];
const compass8 = deg => deg == null ? '' : COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
const THUNDER_CODES = new Set([95, 96, 99]);
const isThunder = c => !!c && THUNDER_CODES.has(c.wcode);

/* ---------- Solar elevation (low-precision, ±~0.5°) ---------- */
function solarElevation(date, lat, lon){
  const rad = Math.PI / 180;
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;   // days since J2000 (UTC)
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = (357.528 + 0.9856003 * n) % 360;
  const lambda = (L + 1.915 * Math.sin(g * rad) + 0.020 * Math.sin(2 * g * rad)) % 360;
  const eps = 23.439 - 0.0000004 * n;
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  const lst = (gmst + lon) % 360;
  const ra = Math.atan2(Math.cos(eps * rad) * Math.sin(lambda * rad), Math.cos(lambda * rad)) / rad;
  let ha = (lst - ra) % 360; if (ha < -180) ha += 360; if (ha > 180) ha -= 360;
  const elev = Math.asin(Math.sin(lat * rad) * Math.sin(decl) + Math.cos(lat * rad) * Math.cos(decl) * Math.cos(ha * rad));
  return elev / rad;   // degrees above horizon
}

/* ---------- Sky palette by sun elevation + cloud cover ---------- */
// Anchor stops (elevation° → top color, horizon color, star strength, warm glow).
const SKY = [
  { e: 20,  top: [74, 144, 217], hor: [150, 192, 235], star: 0,    glow: 0 },
  { e: 6,   top: [70, 138, 212], hor: [172, 206, 240], star: 0,    glow: .05 },
  { e: 2,   top: [60, 100, 150], hor: [245, 172, 92],  star: 0,    glow: .55 },
  { e: -1,  top: [44, 70, 120],  hor: [222, 110, 78],  star: .05,  glow: .60 },
  { e: -6,  top: [24, 40, 76],   hor: [150, 78, 92],   star: .25,  glow: .30 },
  { e: -12, top: [12, 22, 48],   hor: [40, 56, 96],    star: .60,  glow: .08 },
  { e: -18, top: [8, 14, 34],    hor: [18, 28, 56],    star: .85,  glow: 0 },
  { e: -30, top: [5, 8, 20],     hor: [9, 14, 30],     star: 1,    glow: 0 },
];
const grayOf = c => { const y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]; return [y, y, y]; };
const lerpC = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const desat = (c, amt) => lerpC(c, grayOf(c), amt);
const rgb = c => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
function pickSky(elev){
  if (elev >= SKY[0].e) return SKY[0];
  for (let i = 0; i < SKY.length - 1; i++){
    const a = SKY[i], b = SKY[i + 1];
    if (elev <= a.e && elev >= b.e){
      const t = (a.e - elev) / (a.e - b.e);
      return { top: lerpC(a.top, b.top, t), hor: lerpC(a.hor, b.hor, t), star: lerp(a.star, b.star, t), glow: lerp(a.glow, b.glow, t) };
    }
  }
  return SKY[SKY.length - 1];
}
function skyStyle(elev, cloud){
  const s = pickSky(elev == null ? 30 : elev);
  const cf = clamp((cloud || 0) / 100, 0, 1);
  const dk = 1 - cf * 0.12;
  const top = desat(s.top, cf * 0.85).map(v => v * dk);
  const hor = desat(s.hor, cf * 0.85).map(v => v * dk);
  return {
    grad: `linear-gradient(to bottom, ${rgb(top)} 0%, ${rgb(hor)} 100%)`,
    hor, starA: s.star * (1 - cf * 0.85), glow: s.glow * (1 - cf * 0.7),
  };
}

/* ---------- Settings ---------- */
const DEFAULTS = { clock: 'auto', waves: 'roll', bite: 'on', desktopLayout: 'portrait', places: [], activeIdx: null, popupPos: {} };
let settings = loadSettings();
function loadSettings(){
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS.settings) || '{}') }; }
  catch { s = { ...DEFAULTS }; }
  if (!Array.isArray(s.places)) s.places = [];
  if (!s.popupPos || typeof s.popupPos !== 'object') s.popupPos = {};
  if (!['roll', 'still'].includes(s.waves)) s.waves = DEFAULTS.waves;
  if (!['on', 'off'].includes(s.bite)) s.bite = DEFAULTS.bite;
  if (!['portrait', 'landscape'].includes(s.desktopLayout)) s.desktopLayout = DEFAULTS.desktopLayout;
  if (s.activeIdx != null && !(s.activeIdx >= 0 && s.activeIdx < s.places.length)) s.activeIdx = null;
  return s;
}
function saveSettings(){ try { localStorage.setItem(LS.settings, JSON.stringify(settings)); } catch {} }

let place = { name: '—', sub: '' };
function setPlace(name, sub){
  place = { name, sub: sub || '' };
  $('#placeName').textContent = name;
  $('#placeSub').textContent = sub || '';
  if (currentForecastMeta) invalidateShare();
}
let tideSource = '—';
function setTideSrc(t){ tideSource = t; const el = $('#tideSrc'); if (el) el.textContent = t; }
function setUpdatedAt(t, source = 'fresh'){
  const el = $('#updatedAt');
  if (!el) return;
  if (source === 'loading' && !t){ el.textContent = 'Loading...'; return; }
  const prefix = source === 'cached' ? 'Cached' : source === 'stale' ? 'Stale' : source === 'loading' ? 'Loading' : 'Updated';
  el.textContent = AppCore.formatUpdated(t, prefix);
}

/* ---------- Open-Meteo forecast (sky / wind / precip) ---------- */
function buildUrl(lat, lon){
  const p = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4),
    hourly: 'temperature_2m,cloud_cover,precipitation,snowfall,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day',
    wind_speed_unit: 'mph', timezone: 'auto', forecast_days: '7',
    timeformat: 'unixtime',   // epochs, not wall-clock ISO: exact across DST transitions
  });
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}
async function geocode(q, signal){
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en&format=json`;
  return (await AppCore.fetchJson(url, { signal, label: 'Search', timeoutMs: 12000 })).results || [];
}
function toDays(j){
  const h = j.hourly || {}, time = h.time || [];
  const meta = forecastMeta(j);
  const todayKey = forecastNow(meta).key;
  const epochTime = typeof time[0] === 'number';
  const offset = offsetForCalc(meta.offset);
  const byDate = new Map();
  for (let i = 0; i < time.length; i++){
    // Fresh responses carry unixtime epochs (exact across DST); ISO strings from
    // a pre-upgrade localStorage cache or the test generator use the legacy path.
    let epochMs, dateKey, hour;
    if (epochTime){
      epochMs = time[i] * 1000;
      const p = AppCore.epochParts(time[i], meta);
      dateKey = p.key; hour = p.hour;
    } else {
      const iso = time[i];
      dateKey = iso.slice(0, 10); hour = +iso.slice(11, 13);
      epochMs = Date.parse(iso + 'Z') - offset * 1000;   // approximate near DST; fine for cache/test data
    }
    if (!byDate.has(dateKey)) byDate.set(dateKey, new Array(24).fill(null));
    byDate.get(dateKey)[hour] = {
      epochMs,
      tF: cToF(h.temperature_2m?.[i]),
      cloud: h.cloud_cover?.[i] ?? 0,
      precipMm: h.precipitation?.[i] ?? 0,
      snowCm: h.snowfall?.[i] ?? 0,
      pop: h.precipitation_probability?.[i] ?? 0,
      wcode: h.weather_code?.[i] ?? 0,
      windMph: h.wind_speed_10m?.[i] ?? 0,
      windDir: h.wind_direction_10m?.[i] ?? null,
      gust: h.wind_gusts_10m?.[i] ?? 0,
      isDay: h.is_day?.[i] ?? 1,
      tideFt: null,
      tideMark: null,
      moon: null,
    };
  }
  // Spring-forward: one wall-clock hour never happens; fill the black gap from
  // its neighbors so the cutaway stays continuous.
  for (const cells of byDate.values()){
    for (let hh = 1; hh < 23; hh++){
      const a = cells[hh - 1], b = cells[hh + 1];
      if (cells[hh] || !a || !b) continue;
      const mid = (x, y) => (x == null || y == null) ? (x ?? y) : (x + y) / 2;
      cells[hh] = {
        epochMs: (a.epochMs + b.epochMs) / 2,
        tF: mid(a.tF, b.tF), cloud: mid(a.cloud, b.cloud) ?? 0,
        precipMm: mid(a.precipMm, b.precipMm) ?? 0, snowCm: mid(a.snowCm, b.snowCm) ?? 0,
        pop: Math.round(mid(a.pop, b.pop) ?? 0), wcode: a.wcode ?? b.wcode ?? 0,
        windMph: mid(a.windMph, b.windMph) ?? 0, windDir: a.windDir ?? b.windDir,
        gust: mid(a.gust, b.gust) ?? 0, isDay: a.isDay || b.isDay ? 1 : 0,
        tideFt: null, tideMark: null, moon: null, synth: true,
      };
    }
  }
  const keys = [...byDate.keys()].sort().slice(0, 7);
  const days = keys.map(k => {
    const d = new Date(k + 'T00:00');
    return { date: d, key: k, dow: WD[d.getDay()], dnum: d.getDate(), isToday: k === todayKey, cells: byDate.get(k) };
  });
  return { days, offset: meta.offset, meta };
}

/* ---------- NOAA tides (US), with synthetic fallback ---------- */
const NOAA_STATIONS = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions';
let stationsMemo = null, stationsPromise = null;
async function getStations(){
  if (stationsMemo) return stationsMemo;
  const c = AppCore.readJson(LS.stations);
  if (c && Date.now() - c.t < 30 * 86400000) return (stationsMemo = c.list);
  if (stationsPromise) return stationsPromise;
  stationsPromise = AppCore.fetchJson(NOAA_STATIONS, { label: 'NOAA stations', timeoutMs: 9000 })
    .then(j => {
      const list = (j.stations || []).map(s => ({ id: s.id, name: s.name, state: s.state, lat: +s.lat, lon: +s.lng }))
        .filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon));
      AppCore.writeJson(LS.stations, { t: Date.now(), list });
      return (stationsMemo = list);
    })
    .finally(() => { stationsPromise = null; });
  return stationsPromise;
}
async function nearestStation(lat, lon){
  const list = await getStations();
  let best = null, bd = Infinity;
  for (const s of list){ const d = haversineKm(lat, lon, s.lat, s.lon); if (d < bd){ bd = d; best = s; } }
  return best && bd <= 250 ? { ...best, dist: bd } : null;
}
/* NOAA predictions are requested in GMT and matched to forecast hours by epoch,
 * so a station across a timezone (or DST) boundary from the forecast location
 * can no longer shift every tide by an hour. */
const epochHourKey = ms => Math.round(ms / 3600000);
const noaaEpochMs = t => Date.parse(t.replace(' ', 'T') + 'Z');   // "YYYY-MM-DD HH:mm" GMT
async function fetchTides(stationId, start){
  const bd = `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}`;
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=ebb&datum=MLLW&interval=h&units=english&time_zone=gmt&format=json&station=${stationId}&begin_date=${bd}&range=192`;
  const j = await AppCore.fetchJson(url, { label: 'NOAA tides', timeoutMs: 12000 });
  if (j.error) throw new Error(j.error.message || 'NOAA tide error');
  const map = new Map();
  (j.predictions || []).forEach(p => map.set(epochHourKey(noaaEpochMs(p.t)), +p.v));
  return map;
}
async function fetchTideMarks(stationId, start){
  const bd = `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}`;
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=ebb&datum=MLLW&interval=hilo&units=english&time_zone=gmt&format=json&station=${stationId}&begin_date=${bd}&range=192`;
  const j = await AppCore.fetchJson(url, { label: 'NOAA tide marks', timeoutMs: 12000 });
  if (j.error) throw new Error(j.error.message || 'NOAA tide mark error');
  const marks = [];
  (j.predictions || []).forEach(p => {
    const type = p.type === 'H' || p.type === 'L' ? p.type : null;
    const ms = p.t ? noaaEpochMs(p.t) : NaN;
    if (type && Number.isFinite(ms)) marks.push({ epochMs: ms, type });
  });
  return marks;
}
function applyTideMap(days, map){
  days.forEach(d => d.cells.forEach(c => { if (c) c.tideFt = map.get(epochHourKey(c.epochMs)) ?? null; }));
  // Bridge small NOAA gaps (DST edges, range shortfall) by interpolating between
  // known heights — and clamp the extremes to the nearest known value — instead
  // of painting a fake mid-tide waterline for missing hours.
  const flat = [];
  days.forEach(d => d.cells.forEach(c => { if (c) flat.push(c); }));
  let lastKnown = -1;
  for (let i = 0; i < flat.length; i++){
    if (flat[i].tideFt == null) continue;
    if (lastKnown < 0){
      for (let k = 0; k < i; k++) flat[k].tideFt = flat[i].tideFt;      // leading edge: clamp
    } else if (i - lastKnown > 1 && i - lastKnown <= 4){                // small interior gap: interpolate
      for (let k = lastKnown + 1; k < i; k++){
        const t = (k - lastKnown) / (i - lastKnown);
        flat[k].tideFt = flat[lastKnown].tideFt * (1 - t) + flat[i].tideFt * t;
      }
    }
    lastKnown = i;
  }
  if (lastKnown >= 0) for (let k = lastKnown + 1; k < flat.length; k++) flat[k].tideFt = flat[lastKnown].tideFt;   // trailing edge: clamp
}
function clearTideMarks(days){
  days.forEach(d => d.cells.forEach(c => { if (c) c.tideMark = null; }));
}
function applyTideMarks(days, marks){
  clearTideMarks(days);
  const byHour = new Map();
  days.forEach((d, di) => d.cells.forEach((c, h) => { if (c) byHour.set(epochHourKey(c.epochMs), { c, di, h }); }));
  marks.forEach(m => {
    // Bucket the mark into the forecast hour containing it, and keep the minute
    // within that hour (offsets NOAA serves are whole-hour, so this stays exact).
    const hit = byHour.get(Math.floor(m.epochMs / 3600000)) || byHour.get(epochHourKey(m.epochMs));
    if (hit) hit.c.tideMark = { type: m.type, minute: clamp(Math.round((m.epochMs - Math.floor(m.epochMs / 3600000) * 3600000) / 60000), 0, 59), di: hit.di, h: hit.h };
  });
}
function synthTides(days, seedLon){
  const ph = (seedLon || 0) * 0.7, amp = 2.0 + Math.abs((seedLon || 0) % 7) * 0.25;   // ~2–4 ft
  days.forEach((d, di) => d.cells.forEach((c, h) => {
    if (!c) return;
    const t = di * 24 + h;
    c.tideFt = amp + amp * Math.sin(2 * Math.PI * t / 12.42 + ph) + amp * 0.32 * Math.sin(2 * Math.PI * t / 12.0 + ph * 1.3);
  }));
}
function synthTideMarks(days){
  clearTideMarks(days);
  const flat = [];
  days.forEach((d, di) => d.cells.forEach((c, h) => { if (c && c.tideFt != null) flat.push({ c, di, h, v: c.tideFt }); }));
  for (let i = 1; i < flat.length - 1; i++){
    const a = flat[i - 1], b = flat[i], c = flat[i + 1];
    const high = b.v >= a.v && b.v > c.v, low = b.v <= a.v && b.v < c.v;
    if (!high && !low) continue;
    const denom = a.v - 2 * b.v + c.v;
    const offset = Math.abs(denom) > 0.0001 ? clamp(0.5 * (a.v - c.v) / denom, -0.49, 0.49) : 0;
    b.c.tideMark = { type: high ? 'H' : 'L', minute: clamp(Math.round((0.5 + offset) * 60), 0, 59), di: b.di, h: b.h };
  }
}
function refineTideDirectionFromMarks(days){
  const flat = [], marks = [];
  days.forEach((d, di) => d.cells.forEach((c, h) => {
    if (!c) return;
    const t = di * 24 + h;
    flat.push({ c, t });
    if (c.tideMark) marks.push({ t: t + (c.tideMark.minute || 0) / 60, type: c.tideMark.type });
  }));
  if (!marks.length) return;
  marks.sort((a, b) => a.t - b.t);
  let mi = 0;
  for (const f of flat){
    if (f.c.tideFt == null) continue;
    const sampleT = f.t + 0.5; // Label the cell by the middle of its represented hour.
    while (mi < marks.length && marks[mi].t < sampleT) mi++;
    const prev = marks[mi - 1], next = marks[mi];
    if (prev) f.c.rising = prev.type === 'L';
    else if (next) f.c.rising = next.type === 'H';
  }
}
function enrichTide(days){
  let lo = Infinity, hi = -Infinity;
  days.forEach(d => d.cells.forEach(c => { if (c && c.tideFt != null){ lo = Math.min(lo, c.tideFt); hi = Math.max(hi, c.tideFt); } }));
  const range = hi - lo;
  let prev = null;
  days.forEach(d => d.cells.forEach(c => {
    if (!c) return;
    if (c.tideFt == null || !(range > 0)){ c.waterFrac = 0.45; c.rising = null; }
    else { c.waterFrac = 0.16 + ((c.tideFt - lo) / range) * 0.66; c.rising = prev == null ? null : c.tideFt > prev; }
    if (c.tideFt != null) prev = c.tideFt;
  }));
  refineTideDirectionFromMarks(days);
  enrichBite(days);
}

/* ---------- Bite windows ----------
 * A light solunar-style score from ingredients the grid already computes:
 * proximity to a tide turn (the strongest driver), dawn/dusk twilight, and the
 * moon transit (the classic "major period"). Cells over the threshold get a
 * subtle marker plus a tip line naming the contributors. */
function enrichBite(days){
  const marks = [];
  days.forEach((d, di) => d.cells.forEach((c, h) => {
    if (c?.tideMark) marks.push(di * 24 + h + (c.tideMark.minute || 0) / 60);
  }));
  days.forEach((d, di) => {
    const transitH = d.cells.find(c => c?.moon)?.moon?.transitH ?? null;
    d.cells.forEach((c, h) => {
      if (!c){ return; }
      const t = di * 24 + h + 0.5;
      let tideTurn = 0;
      for (const m of marks) tideTurn = Math.max(tideTurn, 1 - Math.abs(t - m) / 1.5);
      tideTurn = Math.max(0, tideTurn);
      const twilight = c.elev == null ? 0 : Math.max(0, 1 - Math.abs(c.elev) / 8);
      const moon = transitH == null ? 0 : Math.max(0, 1 - Math.abs((h + 0.5) - transitH) / 1.5);
      c.bite = 0.5 * tideTurn + 0.3 * twilight + 0.2 * moon;
      c.biteOn = marks.length > 0 && c.bite >= 0.45;   // no real/synth marks at all → no windows
      c.biteWhy = c.biteOn
        ? [tideTurn > 0.5 && 'tide turn', twilight > 0.5 && (h < 12 ? 'dawn' : 'dusk'), moon > 0.5 && 'moon overhead'].filter(Boolean)
        : null;
    });
  });
}
function enrichSun(days, lat, lon){
  // Each cell carries its true epoch, so this is exact even when a DST
  // transition falls inside the forecast week.
  days.forEach(d => d.cells.forEach(c => {
    if (!c) return;
    c.elev = solarElevation(new Date(c.epochMs), lat, lon);
  }));
}
const SYNODIC_MONTH = 29.530588853;
const NEW_MOON_EPOCH = Date.UTC(2000, 0, 6, 18, 14); // Jan 6 2000 18:14 UTC
function moonPhaseAt(date){
  const daysSince = (date.getTime() - NEW_MOON_EPOCH) / 86400000;
  return ((daysSince / SYNODIC_MONTH) % 1 + 1) % 1;
}
function enrichMoon(days){
  days.forEach(d => {
    d.cells.forEach(c => { if (c) c.moon = null; });
    const noonCell = d.cells[12] || d.cells.find(Boolean);
    if (!noonCell) return;
    const phase = moonPhaseAt(new Date(noonCell.epochMs));
    const transitHour = (12 + phase * 24) % 24;
    const h = Math.round(transitHour) % 24;
    const c = d.cells[h];
    if (c) c.moon = { phase, transitH: transitHour };
  });
}

/* ---------- Load orchestration ---------- */
let days = [], orientation = 'p', loadSeq = 0, lastCoords = null, lastLoadedAt = 0, testMode = false, currentForecastMeta = null;
let myCoords = null, myPlace = null;
const fcCache = new Map();
const forecastRequests = new Map();
const fcKey = (lat, lon) => `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`;
function fetchForecast(lat, lon){
  const key = fcKey(lat, lon);
  if (forecastRequests.has(key)) return forecastRequests.get(key);
  const request = AppCore.fetchJson(buildUrl(lat, lon), { label: 'Weather', timeoutMs: 15000 })
    .finally(() => forecastRequests.delete(key));
  forecastRequests.set(key, request);
  return request;
}
function cacheForecast(lat, lon, json, t = Date.now()){
  fcCache.set(fcKey(lat, lon), { json, t });
  while (fcCache.size > 8) fcCache.delete(fcCache.keys().next().value);
}
function readCache(){ return AppCore.readJson(LS.cache); }
function writeCache(lat, lon, json, t = Date.now()){
  const prev = readCache();
  // Keep the last real tide payload when only the forecast refreshes.
  const tides = AppCore.coordsMatch(prev, { lat, lon }) ? prev?.tides : null;
  AppCore.writeJson(LS.cache, { lat, lon, t, json, tides: tides || null });
}
function writeTideCache(lat, lon, tides){
  const prev = readCache();
  if (!AppCore.coordsMatch(prev, { lat, lon })) return;   // only attach to the matching forecast
  AppCore.writeJson(LS.cache, { ...prev, tides });
}
function cacheMatches(cache, lat, lon){ return AppCore.cacheMatches(cache, lat, lon); }
/* Re-apply persisted NOAA predictions to the current `days` (offline / instant
 * repaint). True predictions from minutes ago beat a simulated curve. */
function applyCachedTides(cache){
  const t = cache?.tides;
  if (!t?.map?.length || Date.now() - (t.t || 0) > 36 * 3600000) return false;   // stale predictions age out
  applyTideMap(days, new Map(t.map));
  if (![...days].some(d => d.cells.some(c => c && c.tideFt != null))) return false;
  if (t.marks?.length) applyTideMarks(days, t.marks); else synthTideMarks(days);
  enrichTide(days);
  setTideSrc(`Tide: ${t.stationName || 'NOAA'} (cached)`);
  return true;
}
function previewDays(json, lat, lon){
  const parsed = toDays(json);
  const out = parsed.days;
  enrichSun(out, lat, lon);
  enrichMoon(out);
  synthTides(out, lon);
  synthTideMarks(out);
  enrichTide(out);
  return out;
}
function applyForecast(json, lat, lon, fetchedAt = Date.now(), source = 'fresh'){
  const parsed = toDays(json);
  currentForecastMeta = parsed.meta;
  days = parsed.days;
  enrichSun(days, lat, lon);
  enrichMoon(days);
  setUpdatedAt(fetchedAt, source);
  return parsed;
}
function showLoadingScaffold(){
  currentForecastMeta = null;
  days = placeholderDays();
  render();
  gridEl.classList.add('loading');
  setUpdatedAt(null, 'loading');
  setTideSrc('Tide: loading');
}
function applySimulatedTides(lon, label = 'Tide: simulated'){
  synthTides(days, lon);
  synthTideMarks(days);
  enrichTide(days);
  setTideSrc(label);
}
async function loadTides(lat, lon, start, seq, stationPromise = null){
  try {
    const st = await (stationPromise || nearestStation(lat, lon));
    if (!st) throw new Error('no station');
    const [mapResult, marksResult] = await Promise.allSettled([
      fetchTides(st.id, start),
      fetchTideMarks(st.id, start),
    ]);
    if (seq !== loadSeq) return false;
    if (mapResult.status !== 'fulfilled') throw mapResult.reason;
    applyTideMap(days, mapResult.value);
    if (marksResult.status === 'fulfilled') applyTideMarks(days, marksResult.value);
    else synthTideMarks(days);
    if (![...days].some(d => d.cells.some(c => c && c.tideFt != null))) throw new Error('empty');
    if (![...days].some(d => d.cells.some(c => c && c.tideMark))) synthTideMarks(days);
    setTideSrc(`Tide: ${st.name}`);
    writeTideCache(lat, lon, {
      t: Date.now(),
      stationName: st.name,
      map: [...mapResult.value],
      marks: marksResult.status === 'fulfilled' ? marksResult.value : null,
    });
  } catch {
    if (seq !== loadSeq) return false;
    applySimulatedTides(lon, 'Tide: simulated (NOAA unavailable)');
  }
  enrichTide(days);
  render();
  return true;
}
async function load(lat, lon){
  const seq = ++loadSeq;
  testMode = false;
  lastCoords = { lat, lon };
  const stationPromise = nearestStation(lat, lon).catch(() => null);
  const cache = readCache();
  const warm = fcCache.get(fcKey(lat, lon)) || (cacheMatches(cache, lat, lon) ? cache : null);
  const hadCache = !!warm;
  let usedCachedTides = false;
  if (hadCache){
    applyForecast(warm.json, lat, lon, warm.t, 'cached');
    // Real (persisted) NOAA predictions beat a simulated curve for the repaint.
    usedCachedTides = cacheMatches(cache, lat, lon) && applyCachedTides(cache);
    if (!usedCachedTides) applySimulatedTides(lon, 'Tide: simulated until NOAA refreshes');
    resetDelight();
    render();
  } else {
    showLoadingScaffold();
  }
  try {
    const fc = await fetchForecast(lat, lon);
    if (seq !== loadSeq) return;
    const fetchedAt = Date.now();
    lastLoadedAt = fetchedAt;
    writeCache(lat, lon, fc, fetchedAt);
    cacheForecast(lat, lon, fc, fetchedAt);
    applyForecast(fc, lat, lon, fetchedAt);
    const start = days[0]?.date || new Date();
    resetDelight();
    render();                                   // paint sky immediately; tides fill in next
    await loadTides(lat, lon, start, seq, stationPromise);
    if (seq === loadSeq) prefetchNeighbors();
  } catch {
    if (seq !== loadSeq) return;
    if (hadCache){
      setUpdatedAt(warm.t, 'stale');
      if (!usedCachedTides) setTideSrc('Tide: simulated (offline)');
      render();
    } else {
      setTideSrc('Forecast unavailable');
      setPlace('Couldn\'t load forecast', 'Search in settings');
    }
  } finally {
    if (seq === loadSeq){
      gridEl.classList.remove('loading');
      invalidateShare();
    }
  }
}
let testForecastCache = null;
function testForecast(){ return testForecastCache || (testForecastCache = genTestForecast()); }
function loadTest(){
  ++loadSeq;                                // invalidate any older real forecast still in flight
  testMode = true;
  applyForecast(testForecast(), 41.5, -71.3, Date.now());
  applySimulatedTides(-71.3, 'Tide: simulated (test)');
  lastCoords = null;
  resetDelight();
  render();
}

function placeholderDays(){
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start.getTime() + i * 86400000);
    const cells = Array.from({ length: 24 }, (_, h) => {
      const dayHr = h >= 6 && h <= 19;
      return { iso: `${ymd(d)}T${pad(h)}:00`, cloud: 35, elev: dayHr ? 30 : -25, windMph: 4, windDir: 270, gust: 6, precipMm: 0, snowCm: 0, pop: 0, wcode: 0, isDay: dayHr ? 1 : 0, tF: null, tideFt: null, moon: null };
    });
    return { date: d, dow: WD[d.getDay()], dnum: d.getDate(), isToday: i === 0, cells };
  });
}

/* ---------- Grid render ---------- */
const gridEl = $('#grid');
function corner(){
  const el = document.createElement('button');
  el.type = 'button'; el.className = 'corner'; el.setAttribute('aria-label', 'Settings');
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.1l2-1.6-2-3.5-2.4 1a7 7 0 0 0-1.9-1.1l-.4-2.6h-4l-.4 2.6a7 7 0 0 0-1.9 1.1l-2.4-1-2 3.5 2 1.6A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.1l-2 1.6 2 3.5 2.4-1a7 7 0 0 0 1.9 1.1l.4 2.6h4l.4-2.6a7 7 0 0 0 1.9-1.1l2.4 1 2-3.5-2-1.6A7 7 0 0 0 19 12z"/></svg>`;
  el.addEventListener('click', openSheet);
  return el;
}
function dayHead(d){
  const el = document.createElement('div');
  el.className = 'head day' + (d.isToday ? ' today' : '');
  el.innerHTML = `<span class="dow">${d.dow}</span><span class="dnum">${d.dnum}</span>`;
  return el;
}
function hourHead(h){ const el = document.createElement('div'); el.className = 'head hour'; el.textContent = fmtHour(h); return el; }
function cellEl(di, h){
  const c = days[di].cells[h];
  const el = document.createElement('div');
  el.className = 'cell'; el.dataset.di = di; el.dataset.h = h;
  if (!c){ el.classList.add('empty'); return el; }
  const sky = skyStyle(c.elev, c.cloud);
  el.style.background = sky.grad;
  c._starA = sky.starA; c._glow = sky.glow; c._hor = sky.hor;
  return el;
}
const PHI_INV = 0.6180339887498948;
function desktopFrameEnabled(){
  return innerWidth >= 700 && innerHeight >= 500
    && matchMedia('(hover:hover) and (pointer:fine)').matches;
}
function applyDesktopFrame(){
  const enabled = desktopFrameEnabled();
  document.body.classList.toggle('desktop-frame', enabled);
  if (!enabled) return;
  const longSide = Math.max(1, Math.min(innerWidth - 24, innerHeight - 24));
  const portrait = settings.desktopLayout !== 'landscape';
  const width = portrait ? longSide * PHI_INV : longSide;
  const height = portrait ? longSide : longSide * PHI_INV;
  document.body.style.setProperty('--frame-w', `${width}px`);
  document.body.style.setProperty('--frame-h', `${height}px`);
}
const isPortrait = () => desktopFrameEnabled() ? settings.desktopLayout !== 'landscape' : innerHeight >= innerWidth;
function render(){
  if (!days.length) return;
  orientation = isPortrait() ? 'p' : 'l';
  const n = days.length;
  const frag = document.createDocumentFragment();
  gridEl.className = 'grid ' + orientation;
  fx.cells = [];
  gridEl.style.gridTemplateColumns = `var(--label-day) repeat(24, minmax(0,1fr))`;
  gridEl.style.gridTemplateRows = `var(--label) repeat(${n}, minmax(0,1fr))`;
  frag.appendChild(corner());
  for (let h = 0; h < 24; h++) frag.appendChild(hourHead(h));
  days.forEach((d, di) => { frag.appendChild(dayHead(d)); for (let h = 0; h < 24; h++) frag.appendChild(cellEl(di, h)); });
  gridEl.replaceChildren(frag);
  layoutFx();
  refreshTip();                                 // keep an open popup pinned to its cell with fresh data
  if (currentForecastMeta) invalidateShare();
}

const DAY_SCALE = 0.8, HOUR_SCALE = 1.1, CW = 0.62;
function fitHeaders(){
  const d = gridEl.querySelector('.head.day');
  if (d){ const w = d.clientWidth, hh = d.clientHeight;
    const px = Math.min(hh * 0.46, w / (2 * CW)) * DAY_SCALE;
    gridEl.style.setProperty('--dayfs', Math.max(7, Math.round(px)) + 'px'); }
  const hr = gridEl.querySelector('.head.hour');
  if (hr){ const w = hr.clientWidth, hh = hr.clientHeight; const len = clock24() ? 2 : 3;
    const lscale = orientation === 'l' ? 0.85 : 1;   // time-axis labels read ~15% smaller in landscape
    gridEl.style.setProperty('--hourfs', Math.max(7, Math.round(Math.min(hh * 0.86, w / (len * CW)) * HOUR_SCALE * lscale)) + 'px'); }
}

/* ---------- Cutaway canvas: water + chop + precip + stars ---------- */
const fx = { cells: [], seams: [], canvas: null, ctx: null, dpr: 1, w: 0, h: 0, raf: 0, last: 0, t: 0, delights: [], delightStarted: false, delightTimer: 0 };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
function resetDelight(){
  clearTimeout(fx.delightTimer);
  fx.delights = [];
  fx.delightStarted = false;
  fx.delightTimer = 0;
}
const windToward = deg => { const r = (deg || 0) * Math.PI / 180; return { x: -Math.sin(r), y: Math.cos(r) }; };
// Horizontal roll direction the wind BLOWS the surface (rain/spray/whitecaps too).
// Open-Meteo wind_direction_10m is the bearing the wind comes FROM, so the wind
// blows toward (deg+180). Screen east = right ⇒ a westerly (from W) rolls right,
// an easterly (from E) rolls left. The toward-east component is −sin(deg).
function rollDir(deg){
  if (deg == null) return 1;
  const towardEast = -Math.sin(deg * Math.PI / 180);   // +: blowing east (right), −: blowing west (left)
  if (Math.abs(towardEast) > 0.15) return towardEast > 0 ? 1 : -1;
  return Math.cos(deg * Math.PI / 180) > 0 ? -1 : 1;   // pure N/S: no E/W info → from-N left, from-S right
}

function buildCellFx(fc){
  const c = fc.cell;
  fc.thunder = isThunder(c) && (c.pop || 0) > 10;
  if (fc.thunder) LightningFx.seedCell(fc, fc.di, fc.h);
  // Deterministic per-(cell, particle) values: re-running layoutFx (resize, tide
  // fill-in, opening the settings sheet) must NOT reshuffle the sky.
  const det = (salt, a = 0, b = 1) => a + (b - a) * hash01(fc.di, fc.h, salt);
  // stars
  fc.stars = [];
  if (c._starA > 0.02){
    const n = Math.round(4 + det(101) * 5);
    for (let i = 0; i < n; i++) fc.stars.push({
      x: det(110 + i * 7), y: det(111 + i * 7) * 0.8, r: det(112 + i * 7, 0.5, 1.4),
      tw: det(113 + i * 7, 0.7, 1.7), ph: det(114 + i * 7, 0, 6.28),
    });
  }
  // precip particles
  fc.precip = []; fc.snow = (c.snowCm || 0) > 0;
  const wet = (c.pop || 0) > 10 && ((c.precipMm || 0) > 0 || (fc.snow && c.snowCm > 0));
  if (wet){
    const intensity = clamp((fc.snow ? c.snowCm * 3 : c.precipMm * 6), 0.4, 6);
    const n = Math.round(3 + intensity * 2.2);
    for (let i = 0; i < n; i++) fc.precip.push({
      x: det(210 + i * 5), y: det(211 + i * 5), v: det(212 + i * 5, 0.6, 1.1), ph: det(213 + i * 5, 0, 6.28),
    });
  }
}
// Upper bound of the V2 wave amplitude for a cell (used to size seam covers so
// crests can't expose the cell border above the mean waterline in high wind).
function waveAmpOf(fc){
  const c = fc.cell;
  return clamp(0.5 + ((c.windMph || 0) + (c.gust || 0) * 0.4) * 0.16, 0.5, fc.hgt * 0.16);
}
function layoutFx({ still = false } = {}){
  fitHeaders();
  if (!fx.canvas){ fx.canvas = $('#fx'); fx.ctx = fx.canvas.getContext('2d'); }
  const g = gridEl.getBoundingClientRect();
  fx.w = g.width; fx.h = g.height;
  fx.dpr = Math.min(1.5, devicePixelRatio || 1);
  Object.assign(fx.canvas.style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px` });
  fx.canvas.width = Math.round(g.width * fx.dpr); fx.canvas.height = Math.round(g.height * fx.dpr);
  fx.ctx.setTransform(fx.dpr, 0, 0, fx.dpr, 0, 0);
  fx.cells = [];
  const borderless = gridEl.classList.contains('snapshot-rendering');
  let bw = 0, bh = 0, borderMeasured = borderless;   // cells are uniform: read the border once, not 168×
  gridEl.querySelectorAll('.cell').forEach(el => {
    if (el.classList.contains('empty')) return;
    const c = days[+el.dataset.di]?.cells[+el.dataset.h]; if (!c) return;
    const r = el.getBoundingClientRect();
    if (!borderMeasured){
      const cs = getComputedStyle(el);
      bw = parseFloat(cs.borderRightWidth) || 0;
      bh = parseFloat(cs.borderBottomWidth) || 0;
      borderMeasured = true;
    }
    const fc = { di: +el.dataset.di, h: +el.dataset.h, cell: c, x: r.left - g.left, y: r.top - g.top, w: Math.max(1, r.width - bw), hgt: Math.max(1, r.height - bh) };
    buildCellFx(fc); fx.cells.push(fc);
  });
  fx.seams = [];
  for (let di = 0; di < days.length; di++){
    const row = fx.cells.filter(c => c.di === di);
    for (let i = 0; i < row.length - 1; i++){
      const a = row[i], b = row[i + 1];
      fx.seams.push({
        x: (a.x + a.w + b.x) / 2,
        y: Math.min(waterTopOf(a) - waveAmpOf(a), waterTopOf(b) - waveAmpOf(b)) - 1,
        bottom: Math.max(a.y + a.hgt, b.y + b.hgt),
      });
    }
  }
  // Does anything actually move? Rolling water always does; otherwise only
  // twinkling stars, precip, or lightning need a live loop.
  fx.animated = settings.waves !== 'still'
    || fx.cells.some(fc => fc.stars.length || fc.precip.length || fc.thunder);
  scheduleDelight();
  if (still){
    cancelAnimationFrame(fx.raf); fx.raf = 0; clearTimeout(fx.stillT);
    drawFxStill();
  } else {
    startFx();
  }
}
function drawCell(fc, dt){
  const ctx = fx.ctx, c = fc.cell;
  const noBorders = gridEl.classList.contains('snapshot-rendering');
  const bleedX = noBorders ? 0.85 : 0;
  const left = fc.x - bleedX, top = fc.y, w = fc.w + bleedX * 2, h = fc.hgt, bottom = top + h;
  const waterTop = top + (1 - (c.waterFrac ?? 0.45)) * h;
  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, w, h); ctx.clip();

  // golden-hour / twilight glow near the horizon — the gradient is immutable
  // per layout, so build it once instead of allocating one every frame
  if (c._glow > 0.04){
    if (!fc.glowGrad){
      fc.glowGrad = ctx.createRadialGradient(left + w / 2, waterTop, 1, left + w / 2, waterTop, w * 0.9);
      fc.glowGrad.addColorStop(0, `rgba(255,178,96,${(c._glow * 0.45).toFixed(3)})`);
      fc.glowGrad.addColorStop(1, 'rgba(255,178,96,0)');
    }
    ctx.fillStyle = fc.glowGrad; ctx.fillRect(left, top, w, waterTop - top + 4);
  }
  // stars (in the sky band only)
  if (c._starA > 0.02 && fc.stars.length){
    const skyH = waterTop - top;
    for (const s of fc.stars){
      const a = c._starA * (0.8 + 0.2 * Math.sin(fx.t * s.tw + s.ph));
      if (a < 0.04) continue;
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(left + s.x * w, top + s.y * skyH, s.r, 0, 6.2832); ctx.fill();
    }
  }
  if (c.moon){
    const skyH = Math.max(2, waterTop - top);
    const r = clamp(Math.min(w, skyH) * 0.224, 3.4, 9.1);
    // The moon never changes within a layout: pre-render its ~25-scanline phase
    // mask to a small sprite once and blit it per frame.
    if (!fc.moonSprite || fc.moonR !== r){
      const scale = 3, size = Math.ceil((r + 1.5) * 2 * scale);
      const cv = document.createElement('canvas'); cv.width = cv.height = size;
      const mctx = cv.getContext('2d');
      mctx.scale(scale, scale);
      drawMoonPhase(mctx, size / (2 * scale), size / (2 * scale), r, c.moon.phase);
      fc.moonSprite = cv; fc.moonR = r;
    }
    const size = fc.moonSprite.width / 3;
    ctx.drawImage(fc.moonSprite, left + w * 0.5 - size / 2, top + skyH / 3 - size / 2, size, size);
  }
  // lightning flashes inside thunderstorm cells
  if (fc.thunder){
    const skyH = Math.max(2, waterTop - top);
    LightningFx.drawCell(ctx, fx.t, fc, { x: left, y: top, w, h: skyH });
  }
  // precip (sky band) — blown the SAME way the chop rolls (rollDir), strength ∝ wind
  if (fc.precip.length){
    const skyH = Math.max(2, waterTop - top);
    const roll = rollDir(c.windDir);                          // E→right, W→left, N→left, S→right
    const wmag = clamp((c.windMph || 0) / 22, 0, 1);
    if (fc.snow){
      const drift = roll * wmag * 0.55;                       // downwind horizontal drift as it falls
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      for (const p of fc.precip){
        p.y = (p.y + p.v * dt * 0.25) % 1;
        const px = left + (((p.x + p.y * drift + Math.sin(fx.t * 0.6 + p.ph) * 0.05) % 1 + 1) % 1) * w;
        ctx.beginPath(); ctx.arc(px, top + p.y * skyH, 1.3, 0, 6.2832); ctx.fill();
      }
    } else {
      const slant = roll * (0.15 + wmag * 0.5);                // positive slant ⇒ blows right (matches roll>0)
      ctx.strokeStyle = 'rgba(170,200,235,.55)'; ctx.lineWidth = 1; ctx.lineCap = 'round';
      for (const p of fc.precip){
        p.y = (p.y + p.v * dt * 0.9) % 1;
        const py = top + p.y * skyH;
        const sidePad = Math.abs(slant) * skyH;
        const px = left + p.x * w + slant * p.y * skyH;        // drift sideways as it falls — same slope as the streak
        const pxSide = left - sidePad + p.x * (w + sidePad * 2) + slant * p.y * skyH;
        const len = Math.min(6, skyH * 0.18);
        ctx.beginPath(); ctx.moveTo(pxSide, py); ctx.lineTo(pxSide - slant * len, py - len); ctx.stroke();
      }
    }
  }
  drawDelightBehindWater(fc);
  // black water surface (chop renderer chosen by CHOP_VERSION)
  drawWater(fc, waterTop);
  // bite window: a quiet aquamarine underline in the water column
  if (settings.bite === 'on' && c.biteOn){
    ctx.fillStyle = `rgba(127,255,212,${(0.16 + 0.22 * Math.min(1, c.bite)).toFixed(3)})`;
    ctx.fillRect(left + 1, bottom - 2.4, w - 2, 1.5);
  }
  ctx.restore();
}
function drawWaterSeams(){
  if (gridEl.classList.contains('snapshot-rendering')) return;
  const ctx = fx.ctx;
  ctx.save();
  ctx.fillStyle = '#000';
  for (const seam of fx.seams) ctx.fillRect(seam.x - 1, seam.y, 2, seam.bottom - seam.y);
  ctx.restore();
}

function drawFxStill(){
  if (!fx.ctx) return;
  fx.ctx.clearRect(0, 0, fx.w, fx.h);
  for (const fc of fx.cells) drawCell(fc, 0);
  drawWaterSeams();
  drawNowLine();
  drawSelectedCell();
  drawDelight();
}
/* ---------- Water-surface renderers ----------
 * Switch with CHOP_VERSION: 1 = gentle two-wave chop (the original "chop 1.0"),
 * 2 = directional wind-driven waves with whitecaps + spray that build with wind,
 * 3 = layered swell, chop, foam, and streaks. */
const CHOP_VERSION = 2;
const waveTime = () => settings.waves === 'still' ? 0 : fx.t;
function hash01(...vals){
  const n = Math.sin(vals.reduce((a, v, i) => a + (v + 1) * (37.719 + i * 19.913), 0)) * 43758.5453;
  return n - Math.floor(n);
}
function markRand(fc, salt){ return hash01(fc.di, fc.h, salt); }

function drawMoonPhase(ctx, x, y, r, phase){
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832);
  ctx.fillStyle = 'rgba(170,182,200,.22)'; ctx.fill();
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.clip();
  ctx.fillStyle = 'rgba(255,246,210,.94)';
  const k = Math.cos(phase * 2 * Math.PI);
  const waxing = phase < 0.5;
  for (let yy = -r; yy <= r; yy += 0.8){
    const xlim = Math.sqrt(Math.max(0, r * r - yy * yy));
    const xt = k * xlim;
    const x0 = waxing ? xt : -xlim;
    const x1 = waxing ? xlim : -xt;
    if (x1 > x0) ctx.fillRect(x + x0, y + yy - 0.45, x1 - x0, 0.9);
  }
  ctx.restore();
  ctx.restore();
}

function drawWater(fc, waterTop){
  if (CHOP_VERSION === 1) return drawWaterV1(fc, waterTop);
  if (CHOP_VERSION === 2) return drawWaterV2(fc, waterTop);
  return drawWaterV3(fc, waterTop);
}
function waterSurfaceAt(fc, waterTop, localX){
  const c = fc.cell, w = fc.w, h = fc.hgt;
  const wind = c.windMph || 0, gust = c.gust || 0;
  const t = waveTime();
  if (CHOP_VERSION === 2){
    const wf = clamp((wind + gust * 0.3) / 30, 0, 1);
    const roll = rollDir(c.windDir);
    const amp = clamp(0.5 + (wind + gust * 0.4) * 0.16, 0.5, h * 0.16);
    const k = (2 * Math.PI) / Math.max(14, w * (0.62 - wf * 0.34));
    const travel = t * (1.1 + wind * 0.12) * roll;
    const bob = t * 1.6;
    const sharp = 0.5 + wf * 0.45;
    const s = Math.sin(k * localX - travel);
    const peaked = Math.sign(s) * Math.pow(Math.abs(s), 1 / (1 + sharp));
    return waterTop + amp * (peaked * 0.82 + 0.3 * Math.sin(2.4 * k * localX + bob));
  }
  if (CHOP_VERSION === 3){
    const wf = clamp((wind + gust * 0.35) / 34, 0, 1);
    const roll = rollDir(c.windDir);
    const swellAmp = clamp(0.35 + wind * 0.06, 0.35, h * 0.075);
    const chopAmp = clamp(wf * h * 0.07, 0, h * 0.095);
    const swellK = (2 * Math.PI) / Math.max(26, w * 1.12);
    const chopK = (2 * Math.PI) / Math.max(8, w * (0.30 - wf * 0.12));
    const swell = Math.sin(swellK * localX - t * (0.75 + wind * 0.045) * roll);
    const chop = Math.sin(chopK * localX - t * (1.9 + wind * 0.15) * roll + Math.sin(swellK * localX) * 0.8);
    return waterTop + swellAmp * swell + chopAmp * Math.sign(chop) * Math.pow(Math.abs(chop), 0.62);
  }
  const dirSign = (c.windDir == null) ? 1 : (windToward(c.windDir).x >= 0 ? 1 : -1);
  const amp = clamp(0.4 + (wind + gust * 0.3) * 0.16, 0.4, h * 0.12);
  const k = (2 * Math.PI) / Math.max(18, w * 0.6);
  const spd = (0.5 + wind * 0.06) * dirSign;
  return waterTop + amp * Math.sin(k * localX + t * spd) + amp * 0.4 * Math.sin(2.2 * k * localX - t * spd * 1.4);
}

// chop 1.0 — preserved so we can flip back if we prefer it.
function drawWaterV1(fc, waterTop){
  const ctx = fx.ctx, c = fc.cell;
  const left = fc.x, w = fc.w, h = fc.hgt, bottom = fc.y + h;
  const wind = c.windMph || 0, gust = c.gust || 0;
  const dirSign = (c.windDir == null) ? 1 : (windToward(c.windDir).x >= 0 ? 1 : -1);
  const amp = clamp(0.4 + (wind + gust * 0.3) * 0.16, 0.4, h * 0.12);
  const k = (2 * Math.PI) / Math.max(18, w * 0.6);
  const spd = (0.5 + wind * 0.06) * dirSign;
  const t = waveTime();
  const surf = x => waterTop + amp * Math.sin(k * x + t * spd) + amp * 0.4 * Math.sin(2.2 * k * x - t * spd * 1.4);
  ctx.beginPath(); ctx.moveTo(left, bottom);
  for (let x = 0; x <= w; x += 4) ctx.lineTo(left + x, surf(x));
  ctx.lineTo(left + w, surf(w));
  ctx.lineTo(left + w, bottom); ctx.closePath();
  ctx.fillStyle = '#000'; ctx.fill();
  ctx.beginPath();
  for (let x = 0; x <= w; x += 4){ const y = surf(x); x === 0 ? ctx.moveTo(left, y) : ctx.lineTo(left + x, y); }
  ctx.lineTo(left + w, surf(w));
  ctx.strokeStyle = `rgba(150,190,225,${(0.18 + clamp(wind / 40, 0, 0.22)).toFixed(3)})`;
  ctx.lineWidth = 1; ctx.stroke();
}

// chop 2.0 — waves travel downwind, crests sharpen and shorten with wind, and
// whitecaps + spray appear and intensify as it blows harder. Calm = glassy black.
function drawWaterV2(fc, waterTop){
  const ctx = fx.ctx, c = fc.cell;
  const left = fc.x, w = fc.w, h = fc.hgt, bottom = fc.y + h;
  const wind = c.windMph || 0, gust = c.gust || 0;
  const wf = clamp((wind + gust * 0.3) / 30, 0, 1);                 // 0 calm → 1 howling
  const roll = rollDir(c.windDir);                                  // definite L/R side for every heading
  const amp = clamp(0.5 + (wind + gust * 0.4) * 0.16, 0.5, h * 0.16);
  const k = (2 * Math.PI) / Math.max(14, w * (0.62 - wf * 0.34));   // shorter waves when windy
  const t = waveTime();
  const travel = t * (1.1 + wind * 0.12) * roll;                    // horizontal travel; speed ∝ wind, side from roll
  const bob = t * 1.6;                                              // extra agitation on top of the travel
  const sharp = 0.5 + wf * 0.45;                                    // crest pointiness
  // Precompute the surface once: sharpened trochoid (pointy crests, flat troughs)
  // plus a cross-wave. sin(kx − ωt) ⇒ crests travel toward +x (right) when roll>0.
  const step = 3;
  const pointCount = Math.ceil(w / step) + 1;
  if (!fc.wavePoints || fc.wavePoints.length !== pointCount * 2) fc.wavePoints = new Float32Array(pointCount * 2);
  const pts = fc.wavePoints;
  for (let i = 0; i < pointCount; i++){
    const x = Math.min(w, i * step);
    const s = Math.sin(k * x - travel);
    const peaked = Math.sign(s) * Math.pow(Math.abs(s), 1 / (1 + sharp));
    pts[i * 2] = x;
    pts[i * 2 + 1] = waterTop + amp * (peaked * 0.82 + 0.3 * Math.sin(2.4 * k * x + bob));
  }
  ctx.beginPath(); ctx.moveTo(left, bottom);
  for (let i = 0; i < pointCount; i++) ctx.lineTo(left + pts[i * 2], pts[i * 2 + 1]);
  ctx.lineTo(left + w, bottom); ctx.closePath();
  ctx.fillStyle = '#000'; ctx.fill();
  // crest line, brighter as wind builds
  ctx.beginPath();
  for (let i = 0; i < pointCount; i++){
    const x = pts[i * 2], y = pts[i * 2 + 1];
    i === 0 ? ctx.moveTo(left, y) : ctx.lineTo(left + x, y);
  }
  ctx.strokeStyle = `rgba(150,190,225,${(0.16 + wf * 0.22).toFixed(3)})`;
  ctx.lineWidth = 1; ctx.stroke();
  // whitecaps + downwind spray on the crests, scaling with wind (none when calm)
  if (wf > 0.2){
    const fa = clamp((wf - 0.2) * 1.4, 0, 1);
    for (let i = 1; i < pointCount - 1; i++){
      const x = pts[i * 2], y = pts[i * 2 + 1];
      if (y < pts[(i - 1) * 2 + 1] && y <= pts[(i + 1) * 2 + 1]){    // local crest peak (smaller y = higher)
        const fw = 2 + wf * 3;
        ctx.fillStyle = `rgba(228,242,255,${(0.5 * fa).toFixed(3)})`;
        ctx.fillRect(roll > 0 ? left + x - 1 : left + x + 1 - fw, y - 0.6, fw, 1.4);   // foam streaks toward the blow
        if (fa > 0.4){                                              // spray flicking off downwind (deterministic)
          const n = 1 + Math.round(wf * 2);
          for (let j = 0; j < n; j++){
            const t2 = (t * (1.4 + j * 0.3) + x * 0.7) % 1;
            const sx = left + x + roll * t2 * (4 + wf * 8);        // same side as the wave travel
            const sy = y - Math.sin(t2 * Math.PI) * (2 + wf * 7);
            ctx.fillStyle = `rgba(228,242,255,${((1 - t2) * 0.5 * fa).toFixed(3)})`;
            ctx.beginPath(); ctx.arc(sx, sy, 0.8, 0, 6.2832); ctx.fill();
          }
        }
      }
    }
  }
}

// Seven underwater wind-texture auditions, one per day row. Each treatment uses
// the same normalized wind energy so the comparison is about visual language,
// not different thresholds. Keep the mark counts low: this runs for every cell.
const WATER_TEXTURES = [
  'Layered streaks',
  'Layered streaks',
  'Layered streaks',
  'Layered streaks',
  'Layered streaks',
  'Layered streaks',
  'Layered streaks',
];
// Selected: brighter Layered Streaks (8). Finalists retained below for an easy
// return: Caustic Ribbons (3) and Speed Dashes (6).
const WATER_TEXTURE_VARIANTS = [8, 8, 8, 8, 8, 8, 8];
function drawWindTexture(fc, waterTop, bottom, wf, roll, t){
  const { ctx } = fx, left = fc.x, w = fc.w, h = fc.hgt;
  const waterH = bottom - waterTop;
  if (waterH < 3) return;
  const energy = wf * wf;                         // calm stays truly quiet
  const alpha = 0.04 + energy * 0.23;
  const phase = t * (0.45 + wf * 2.1) * roll + fc.h * 0.73;
  const row = ((fc.di % WATER_TEXTURE_VARIANTS.length) + WATER_TEXTURE_VARIANTS.length) % WATER_TEXTURE_VARIANTS.length;
  const variant = WATER_TEXTURE_VARIANTS[row];
  ctx.save();
  ctx.beginPath(); ctx.rect(left, waterTop + 1, w, Math.max(0, waterH - 1)); ctx.clip();
  ctx.lineCap = 'round';

  if (variant === 0){                              // long, gently rolling layers
    for (let j = 0; j < 3; j++){
      const yy = waterTop + waterH * (0.18 + j * 0.24);
      ctx.beginPath();
      for (let x = -2; x <= w + 2; x += 5){
        const y = yy + Math.sin(x * 0.18 + phase * (0.7 + j * 0.22) + j) * (0.35 + energy * 1.5);
        x > -2 ? ctx.lineTo(left + x, y) : ctx.moveTo(left + x, y);
      }
      ctx.strokeStyle = `rgba(185,215,233,${(alpha * (1 - j * 0.2)).toFixed(3)})`;
      ctx.lineWidth = 0.75; ctx.stroke();
    }
  } else if (variant === 1){                       // two currents repeatedly braid and separate
    ctx.strokeStyle = `rgba(195,222,239,${alpha.toFixed(3)})`;
    ctx.lineWidth = 0.85;
    const mid = waterTop + waterH * 0.48;
    const spread = 0.8 + energy * Math.min(3.2, waterH * 0.16);
    for (let j = 0; j < 2; j++){
      ctx.beginPath();
      for (let x = -2; x <= w + 2; x += 3){
        const weave = Math.sin(x * (0.32 + energy * 0.16) - phase * 1.2) * spread;
        const y = mid + (j ? -weave : weave);
        x > -2 ? ctx.lineTo(left + x, y) : ctx.moveTo(left + x, y);
      }
      ctx.stroke();
    }
  } else if (variant === 2){                       // gusts register as stretched pulse rings
    ctx.strokeStyle = `rgba(215,235,247,${(alpha * 1.08).toFixed(3)})`;
    ctx.lineWidth = 0.8;
    for (let j = 0; j < 2; j++){
      const pulse = ((t * (0.24 + wf * 0.42) + fc.h * 0.19 + j * 0.5) % 1 + 1) % 1;
      const cx = left + w * (roll > 0 ? 0.25 : 0.75);
      const cy = waterTop + waterH * (0.34 + j * 0.24);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1.2 + energy * 1.8, 0.58 + energy * 0.2);
      ctx.beginPath(); ctx.arc(0, 0, 1.2 + pulse * (2.2 + energy * 3.8), 0, 6.2832); ctx.stroke();
      ctx.restore();
    }
  } else if (variant === 3){                       // wavering light ribbons / caustics
    for (let j = 0; j < 2; j++){
      ctx.beginPath();
      for (let x = -2; x <= w + 2; x += 3){
        const y = waterTop + waterH * (0.27 + j * 0.36)
          + Math.sin(x * 0.34 + phase * (1.1 + j * 0.35)) * (0.7 + energy * 2.2);
        x > -2 ? ctx.lineTo(left + x, y) : ctx.moveTo(left + x, y);
      }
      ctx.strokeStyle = `rgba(205,232,247,${(alpha * 1.15).toFixed(3)})`;
      ctx.lineWidth = 0.9 + energy * 0.7; ctx.stroke();
    }
  } else if (variant === 4){                       // moving surface crests cast pale vertical curtains
    const count = 1 + Math.round(energy * 2);
    for (let j = 0; j < count; j++){
      const x = left + (((j / count) * w + phase * roll * 2.4) % (w + 5) + w + 5) % (w + 5) - 2;
      const beamW = 1.1 + energy * 2.3;
      const beam = ctx.createLinearGradient(x, waterTop, x, bottom);
      beam.addColorStop(0, `rgba(210,232,245,${(alpha * 1.15).toFixed(3)})`);
      beam.addColorStop(1, 'rgba(165,195,215,0)');
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(x - beamW, waterTop);
      ctx.lineTo(x + beamW, waterTop);
      ctx.lineTo(x + beamW * 0.28, bottom);
      ctx.lineTo(x - beamW * 0.28, bottom);
      ctx.closePath();
      ctx.fill();
    }
  } else if (variant === 5){                       // little rotating eddies
    ctx.strokeStyle = `rgba(198,225,240,${(alpha * 1.05).toFixed(3)})`;
    ctx.lineWidth = 0.75;
    for (let j = 0; j < 2; j++){
      const cx = left + w * (0.28 + j * 0.48);
      const cy = waterTop + waterH * (0.3 + j * 0.28);
      const r = 1.5 + energy * 3 + j * 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r, phase + j * 2, phase + j * 2 + Math.PI * (1.15 + energy * 0.55), roll < 0);
      ctx.stroke();
    }
  } else if (variant === 6){                       // discrete directional speed marks
    ctx.strokeStyle = `rgba(215,235,247,${(alpha * 1.2).toFixed(3)})`;
    ctx.lineWidth = 0.85;
    const len = 1.5 + energy * Math.max(3, w * 0.34);
    for (let j = 0; j < 4; j++){
      const seed = fc.h * 7 + j * 13;
      const x = left + ((seed + phase * 4) % (w + len) + w + len) % (w + len) - len;
      const y = waterTop + waterH * (0.16 + j * 0.2);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + roll * len, y + roll * energy); ctx.stroke();
    }
  } else if (variant === 7){                       // caustics whose amplitude, light, and count all build with wind
    const count = 1 + Math.round(wf * 4);
    const amplitude = 0.45 + energy * Math.min(4, waterH * 0.24);
    const ribbonAlpha = alpha * (0.72 + energy * 0.78);
    ctx.strokeStyle = `rgba(215,237,249,${ribbonAlpha.toFixed(3)})`;
    ctx.lineWidth = 0.75 + energy * 1.05;
    for (let j = 0; j < count; j++){
      const lane = (j + 1) / (count + 1);
      ctx.beginPath();
      for (let x = -2; x <= w + 2; x += 3){
        const y = waterTop + waterH * lane
          + Math.sin(x * (0.3 + wf * 0.12) - phase * (1 + j * 0.1) + j * 1.7) * amplitude;
        x > -2 ? ctx.lineTo(left + x, y) : ctx.moveTo(left + x, y);
      }
      ctx.stroke();
    }
  } else {                                        // layered geometry, using the caustic light/amplitude encoding
    const amplitude = 0.7 + energy * 2.2;
    for (let j = 0; j < 3; j++){
      const yy = waterTop + waterH * (0.18 + j * 0.24);
      ctx.beginPath();
      for (let x = -2; x <= w + 2; x += 5){
        const y = yy + Math.sin(x * 0.18 + phase * (0.7 + j * 0.22) + j) * amplitude;
        x > -2 ? ctx.lineTo(left + x, y) : ctx.moveTo(left + x, y);
      }
      ctx.strokeStyle = `rgba(205,232,247,${(alpha * 1.15).toFixed(3)})`;
      ctx.lineWidth = 0.9 + energy * 0.7;
      ctx.stroke();
    }
  }
  ctx.restore();
}

// chop 3.0 — layered, directional water: long swell carries the tide line, short
// chop rides on top, foam appears on windward crests, and low translucent streaks
// make the black water feel like a surface instead of a flat fill.
function drawWaterV3(fc, waterTop){
  const ctx = fx.ctx, c = fc.cell;
  const left = fc.x, w = fc.w, h = fc.hgt, bottom = fc.y + h;
  const wind = c.windMph || 0, gust = c.gust || 0;
  const wf = clamp((wind + gust * 0.35) / 34, 0, 1);
  const roll = rollDir(c.windDir);
  const swellAmp = clamp(0.35 + wind * 0.06, 0.35, h * 0.075);
  const chopAmp = clamp(wf * h * 0.07, 0, h * 0.095);
  const swellK = (2 * Math.PI) / Math.max(26, w * 1.12);
  const chopK = (2 * Math.PI) / Math.max(8, w * (0.30 - wf * 0.12));
  const t = waveTime();
  const step = 2.5, pts = [];
  for (let x = 0; x <= w + step; x += step){
    const swell = Math.sin(swellK * x - t * (0.75 + wind * 0.045) * roll);
    const chop = Math.sin(chopK * x - t * (1.9 + wind * 0.15) * roll + Math.sin(swellK * x) * 0.8);
    const cap = Math.sign(chop) * Math.pow(Math.abs(chop), 0.62);
    pts.push({ x, y: waterTop + swellAmp * swell + chopAmp * cap });
  }

  ctx.beginPath(); ctx.moveTo(left, bottom);
  pts.forEach(p => ctx.lineTo(left + p.x, p.y));
  ctx.lineTo(left + pts[pts.length - 1].x, bottom); ctx.closePath();
  const water = ctx.createLinearGradient(0, waterTop, 0, bottom);
  water.addColorStop(0, '#010307');
  water.addColorStop(1, '#000');
  ctx.fillStyle = water; ctx.fill();

  ctx.beginPath();
  pts.forEach((p, i) => i ? ctx.lineTo(left + p.x, p.y) : ctx.moveTo(left + p.x, p.y));
  ctx.strokeStyle = `rgba(145,190,225,${(0.14 + wf * 0.23).toFixed(3)})`;
  ctx.lineWidth = 1;
  ctx.stroke();


  // Foam on energetic local crests, pushed downwind into short torn streaks.
  if (wf > 0.32){
    const fa = clamp((wf - 0.32) / 0.68, 0, 1);
    for (let i = 1; i < pts.length - 1; i++){
      const p = pts[i];
      if (!(p.y < pts[i - 1].y && p.y <= pts[i + 1].y)) continue;
      const gate = (Math.sin((p.x + fc.di * 31 + fc.h * 13) * 0.37) + 1) / 2;
      if (gate < 0.34 + (1 - fa) * 0.42) continue;
      const len = 2 + fa * 5 + gate * 2;
      const x0 = left + p.x;
      const y0 = p.y - 0.4;
      const alpha = 0.22 + fa * 0.35;
      ctx.strokeStyle = `rgba(230,244,255,${alpha.toFixed(3)})`;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(x0 - roll * len * 0.25, y0);
      ctx.lineTo(x0 + roll * len, y0 + 0.25 * Math.sin(t * 3 + p.x));
      ctx.stroke();
      if (fa > 0.55 && gate > 0.72){
        const sprayT = (t * 1.7 + p.x * 0.19) % 1;
        ctx.fillStyle = `rgba(230,244,255,${((1 - sprayT) * 0.32 * fa).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x0 + roll * sprayT * (5 + fa * 7), y0 - Math.sin(sprayT * Math.PI) * (2 + fa * 6), 0.75, 0, 6.2832);
        ctx.fill();
      }
    }
  }
}
const TIDE_MARK_STYLES = [
  'coral / aquamarine',
];
const TIDE_MARK_PALETTES = [
  { high: '#ff6f61', low: '#7fffd4' },
];
function colorParts(hex){
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function tideMarkColors(type, di = 0){
  const p = TIDE_MARK_PALETTES[((di % TIDE_MARK_PALETTES.length) + TIDE_MARK_PALETTES.length) % TIDE_MARK_PALETTES.length];
  const main = type === 'H' ? p.high : p.low;
  const [r, g, b] = colorParts(main);
  return { main, soft: `rgba(${r},${g},${b},.34)`, text: '#081018' };
}
function drawTideTapLocator(ctx, fc){
  const mark = fc.cell.tideMark;
  if (!mark) return;
  const c = tideMarkColors(mark.type, fc.di);
  const localX = clamp((mark.minute || 0) / 60, 0.04, 0.96) * fc.w;
  const x = fc.x + localX;
  const waterTop = fc.y + (1 - (fc.cell.waterFrac ?? 0.45)) * fc.hgt;
  const pulse = 0.5 + 0.5 * Math.sin(fx.t * 5.5);
  ctx.save();
  ctx.strokeStyle = c.main;
  ctx.lineWidth = 1.2 + pulse * 0.5;
  ctx.shadowColor = c.soft;
  ctx.shadowBlur = 8 + pulse * 5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(x, fc.y + 2); ctx.lineTo(x, fc.y + fc.hgt - 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = c.main;
  ctx.beginPath(); ctx.arc(x, waterTop, 2.2 + pulse * 1.5, 0, 6.2832); ctx.fill();
  ctx.restore();
}
function drawSelectedDayTideLocators(ctx, di){
  for (const fc of fx.cells){
    if (fc.di === di) drawTideTapLocator(ctx, fc);
  }
}
function drawNowLine(){
  const now = forecastNow();
  // Locate today by date key at draw time, so the line follows the clock past
  // midnight instead of pointing at yesterday's row until a refetch lands.
  const di = days.findIndex(d => (d.key ? d.key === now.key : d.isToday));
  if (di < 0) return;
  const fc = fx.cells.find(c => c.di === di && c.h === now.hour); if (!fc) return;
  const ctx = fx.ctx; ctx.save();
  ctx.strokeStyle = '#ff2b2b'; ctx.lineWidth = 2; ctx.shadowColor = 'rgba(255,43,43,.8)'; ctx.shadowBlur = 6;
  ctx.beginPath();
  const x = fc.x + (now.minute / 60) * fc.w; ctx.moveTo(x, fc.y); ctx.lineTo(x, fc.y + fc.hgt);
  ctx.stroke(); ctx.restore();
}
function drawSelectedCell(){
  if (!selectedCell) return;
  const fc = fx.cells.find(c => c.di === selectedCell.di && c.h === selectedCell.h);
  if (!fc) return;
  const ctx = fx.ctx;
  ctx.save();
  ctx.strokeStyle = '#ffd36a';
  ctx.lineWidth = 1.25;
  ctx.shadowColor = 'rgba(255,178,48,.55)';
  ctx.shadowBlur = 6;
  ctx.strokeRect(fc.x + 1, fc.y + 1, Math.max(0, fc.w - 2), Math.max(0, fc.hgt - 2));
  ctx.strokeStyle = 'rgba(255,246,202,.38)';
  ctx.lineWidth = 1;
  ctx.shadowBlur = 0;
  ctx.strokeRect(fc.x + 2.5, fc.y + 2.5, Math.max(0, fc.w - 5), Math.max(0, fc.hgt - 5));
  drawSelectedDayTideLocators(ctx, selectedCell.di);
  ctx.restore();
}
function rowCells(di){ return fx.cells.filter(c => c.di === di).sort((a, b) => a.h - b.h); }
function rowBounds(cells){
  const first = cells[0], last = cells[cells.length - 1];
  return first && last ? { x: first.x, y: first.y, w: last.x + last.w - first.x, h: first.hgt } : null;
}
function waterY(fc, frac = 0.5){ return fc.y + (1 - (fc.cell.waterFrac ?? 0.45)) * fc.hgt + fc.hgt * frac; }
function cellAtRowX(row, rb, x){
  if (!row?.length || !rb) return null;
  const i = clamp(Math.floor((x - rb.x) / (rb.w / row.length)), 0, row.length - 1);
  return row[i] || row[0];
}
function waterTopOf(fc){ return fc.y + (1 - (fc.cell.waterFrac ?? 0.45)) * fc.hgt; }
function fishBounds(fc){
  if (!fc) return null;
  const top = waterTopOf(fc), bottom = fc.y + fc.hgt;
  return { min: top + Math.max(4, fc.hgt * 0.12), max: bottom - Math.max(4, fc.hgt * 0.08), top, bottom };
}
function fishYFor(fc, lane = 0.58){
  const b = fishBounds(fc);
  if (!b) return 0;
  return clamp(b.top + (b.bottom - b.top) * lane, b.min, b.max);
}
function gullBounds(fc){
  if (!fc) return null;
  const waterTop = waterTopOf(fc);
  const minY = fc.y + Math.max(4, fc.hgt * 0.08);
  const maxY = waterTop - Math.max(5, fc.hgt * 0.08);
  return { min: minY, max: Math.max(minY, maxY) };
}
function gullYFor(fc, lane = 0.38){
  const b = gullBounds(fc);
  if (!b) return 0;
  return b.max > b.min ? lerp(b.min, b.max, lane) : b.min;
}
function smoothRowY(row, rb, x, lane, yFor, boundsFor){
  if (!row?.length || !rb) return 0;
  const raw = clamp((x - rb.x) / (rb.w / row.length), 0, row.length - 1);
  const i0 = Math.floor(raw), i1 = Math.min(row.length - 1, i0 + 1);
  const t = raw - i0, ss = t * t * (3 - 2 * t);
  const y = lerp(yFor(row[i0], lane), yFor(row[i1], lane), ss);
  const b = boundsFor(cellAtRowX(row, rb, x));
  return b ? clamp(y, b.min, b.max) : y;
}
function smoothFishY(row, rb, x, lane){ return smoothRowY(row, rb, x, lane, fishYFor, fishBounds); }
function smoothGullY(row, rb, x, lane){ return smoothRowY(row, rb, x, lane, gullYFor, gullBounds); }
function planFishJump(row){
  if (!row?.length) return null;
  const candidates = [];
  for (let low = 1; low < row.length - 1; low++){
    const lowCell = row[low];
    const markedLow = lowCell.cell.tideMark?.type === 'L';
    const directionTurnsUp = row[low - 1].cell.rising === false && row[low + 1].cell.rising === true;
    if (!markedLow && !directionTurnsUp) continue;
    for (let left = 1; left <= 3; left++){
      for (let right = 1; right <= 3; right++){
        const si = low - left, ei = low + right;
        if (si < 0 || ei >= row.length) continue;
        const span = ei - si;
        if (span < 3 || span > 6) continue;
        const a = row[si], b = row[ei];
        const startsFalling = a.cell.rising === false;
        const endsRising = b.cell.rising === true;
        const lowDrop = Math.max(0, Math.min(a.cell.waterFrac ?? 0.45, b.cell.waterFrac ?? 0.45) - (lowCell.cell.waterFrac ?? 0.45));
        candidates.push({ a, b, low: lowCell, span, score: (markedLow ? 4 : 2) + (startsFalling ? 2 : 0) + (endsRising ? 2 : 0) + lowDrop });
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const pick = candidates[Math.floor(Math.random() * Math.min(6, candidates.length))];
  const dir = pick.b.x >= pick.a.x ? 1 : -1;
  const x0 = pick.a.x + pick.a.w * (0.18 + Math.random() * 0.18);
  const x1 = pick.b.x + pick.b.w * (0.64 + Math.random() * 0.18);
  const y0 = waterTopOf(pick.a), y1 = waterTopOf(pick.b);
  const baseMid = (y0 + y1) / 2;
  const safeTop = pick.a.y + Math.max(8, pick.a.hgt * 0.14);
  const desiredArc = pick.a.hgt * (0.34 + Math.min(0.24, Math.abs(x1 - x0) / (pick.a.w * 28)));
  const arcH = clamp(Math.min(desiredArc, baseMid - safeTop), pick.a.hgt * 0.16, pick.a.hgt * 0.52);
  return {
    start: pick.a,
    end: pick.b,
    low: pick.low,
    dir,
    x0,
    x1,
    arcH,
  };
}
function chooseDelightEvent(row, forcedKind = ''){
  if (!fx.cells.length) return null;
  const rows = [...new Set(fx.cells.map(c => c.di))].map(di => rowCells(di)).filter(r => r.length);
  row = row?.length ? row : rows[Math.floor(Math.random() * rows.length)];
  const night = row.filter(c => (c.cell.elev ?? 0) < -6 || c.cell._starA > 0.18);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const fishColor = () => pick(['#f7fbff', '#7fffd4', '#ff6f61']);
  const buoyColor = () => pick(['#f7fbff', '#7fffd4', '#ff6f61']);
  const crossingSlowdown = orientation === 'l' ? 1.5 : 1;
  const variants = ['shootingStar', 'fishSwim', 'fishJump', 'gullFly', 'bubbleSeep', 'buoy'];
  const kind = variants.includes(forcedKind) ? forcedKind : pick(variants);
  const rb = rowBounds(row);
  const fc = pick(kind === 'shootingStar' && night.length ? night : row);
  const t0 = fx.t + 0.55 + (row[0]?.di || 0) * 0.16;
  if (kind === 'shootingStar'){
    const cell = pick(night.length ? night : fx.cells);
    return { kind, t0, dur: 1.05, cell, sx: 0.12 + Math.random() * 0.42, sy: 0.10 + Math.random() * 0.30, len: 0.42 + Math.random() * 0.20 };
  }
  if (kind === 'fishSwim' && rb) return { kind, t0, dur: (15.5 + Math.random() * 8) * crossingSlowdown, row, rb, dir: Math.random() < 0.5 ? -1 : 1, lane: 0.42 + Math.random() * 0.34, color: fishColor() };
  if (kind === 'fishJump'){
    const jump = planFishJump(row);
    if (jump) return { kind, t0, dur: 2.6 + Math.random() * 0.7, color: fishColor(), ...jump };
    return { kind: 'bubbleSeep', t0, dur: 5.8, riseDur: 3.6, gap: 0.38, cell: fc, xFrac: 0.24 + Math.random() * 0.52, count: 8, drift: Math.random() < 0.5 ? -1 : 1 };
  }
  if (kind === 'gullFly' && rb) return { kind, t0, dur: (13 + Math.random() * 6.5) * crossingSlowdown, row, rb, dir: Math.random() < 0.5 ? -1 : 1, lane: 0.22 + Math.random() * 0.45 };
  if (kind === 'bubbleSeep'){
    const count = 8 + Math.floor(Math.random() * 5);
    const riseDur = 3.4 + Math.random() * 0.8, gap = 0.34 + Math.random() * 0.08;
    return { kind, t0, dur: riseDur + gap * (count - 1) + 0.5, riseDur, gap, cell: fc, xFrac: 0.24 + Math.random() * 0.52, count, drift: Math.random() < 0.5 ? -1 : 1 };
  }
  if (kind === 'buoy') return { kind, t0, dur: 75, cell: fc, xFrac: 0.34 + Math.random() * 0.32, color: buoyColor(), phase: Math.random() * 6.2832 };
  return null;
}
function scheduleDelight(){
  if (fx.delightStarted || fx.delightTimer || reduceMotion.matches || !fx.cells.length) return;
  fx.delightStarted = true;
  if (!testMode && Math.random() >= 1 / 7) return;
  fx.delightTimer = setTimeout(() => {
    fx.delightTimer = 0;
    const ev = chooseDelightEvent();
    fx.delights = ev ? [ev] : [];
    startFx();
  }, 950);
}
function hexToRgb(hex){
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function drawTinyFish(ctx, x, y, s, dir, alpha = 1, color = '#f7fbff'){
  const [r, g, b] = hexToRgb(color);
  ctx.save(); ctx.translate(x, y); ctx.scale(dir, 1);
  ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
  ctx.beginPath(); ctx.ellipse(0, 0, s * 0.9, s * 0.34, 0, 0, 6.2832);
  ctx.moveTo(-s * 0.85, 0); ctx.lineTo(-s * 1.35, -s * 0.38); ctx.lineTo(-s * 1.22, 0); ctx.lineTo(-s * 1.35, s * 0.38); ctx.closePath();
  ctx.fill();
  ctx.fillStyle = `rgba(5,8,14,${(0.55 * alpha).toFixed(3)})`;
  ctx.beginPath(); ctx.arc(s * 0.42, -s * 0.06, Math.max(0.45, s * 0.06), 0, 6.2832); ctx.fill();
  ctx.restore();
}
function drawTinyGull(ctx, x, y, s, dir, phase, alpha = 1){
  const flap = Math.sin(phase), lift = s * (0.30 + flap * 0.18);
  ctx.save(); ctx.translate(x, y); ctx.scale(dir, 1);
  ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
  ctx.lineWidth = Math.max(1, s * 0.12); ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-s * 0.95, 0); ctx.quadraticCurveTo(-s * 0.42, -lift, 0, s * 0.04); ctx.quadraticCurveTo(s * 0.42, -lift, s * 0.95, 0);
  ctx.stroke();
  ctx.restore();
}
function drawTinyBuoy(ctx, x, surface, s, color, phase, tilt){
  ctx.save();
  ctx.translate(x, surface);
  ctx.rotate(tilt);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const shadow = 'rgba(8,12,18,.35)';
  ctx.strokeStyle = shadow;
  ctx.lineWidth = Math.max(1.2, s * 0.14);
  ctx.beginPath();
  ctx.moveTo(-s * 0.78, -s * 0.24); ctx.lineTo(-s * 0.34, -s * 2.15);
  ctx.moveTo(s * 0.78, -s * 0.24); ctx.lineTo(s * 0.34, -s * 2.15);
  ctx.moveTo(-s * 0.54, -s * 1.1); ctx.lineTo(s * 0.54, -s * 1.1);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, s * 0.09);
  ctx.beginPath();
  ctx.moveTo(-s * 0.78, -s * 0.24); ctx.lineTo(-s * 0.34, -s * 2.15);
  ctx.moveTo(s * 0.78, -s * 0.24); ctx.lineTo(s * 0.34, -s * 2.15);
  ctx.moveTo(-s * 0.5, -s * 1.1); ctx.lineTo(s * 0.5, -s * 1.1);
  ctx.moveTo(-s * 0.62, -s * 0.45); ctx.lineTo(s * 0.28, -s * 1.95);
  ctx.moveTo(s * 0.62, -s * 0.45); ctx.lineTo(-s * 0.28, -s * 1.95);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.strokeStyle = shadow;
  ctx.lineWidth = Math.max(0.7, s * 0.055);
  ctx.beginPath();
  ctx.ellipse(0, s * 0.18, s * 0.9, s * 0.36, 0, 0, 6.2832);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(0,0,0,.18)';
  ctx.fillRect(-s * 0.72, s * 0.18, s * 1.44, s * 0.2);
  ctx.fillStyle = color;
  ctx.fillRect(-s * 0.62, -s * 0.06, s * 1.24, s * 0.36);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-s * 0.34, -s * 2.15);
  ctx.lineTo(s * 0.34, -s * 2.15);
  ctx.lineTo(s * 0.44, -s * 1.62);
  ctx.lineTo(-s * 0.44, -s * 1.62);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -s * 2.72);
  ctx.lineTo(s * 0.42, -s * 2.18);
  ctx.lineTo(-s * 0.42, -s * 2.18);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(0, -s * 2.02, Math.max(0.8, s * 0.13), 0, 6.2832); ctx.fill();
  ctx.restore();
}
function drawFishJumpEvent(ev){
  const p = (fx.t - ev.t0) / ev.dur;
  if (p < 0 || p > 1) return;
  const ctx = fx.ctx;
  if (ev.start && ev.end){
    const y0 = waterTopOf(ev.start), y1 = waterTopOf(ev.end);
    const arc = Math.sin(Math.PI * p), x = lerp(ev.x0, ev.x1, p);
    const y = Math.max(ev.start.y + Math.max(7, ev.start.hgt * 0.12), lerp(y0, y1, p) - ev.arcH * arc);
    drawTinyFish(ctx, x, y, 4, ev.dir, 1, ev.color);
  } else {
    const c = ev.cell, waterTop = c.y + (1 - (c.cell.waterFrac ?? 0.45)) * c.hgt;
    const arc = Math.sin(Math.PI * p), x = c.x + c.w * ev.xFrac + ev.dir * c.w * 0.34 * (p - 0.5), y = waterTop - c.hgt * 0.36 * arc;
    drawTinyFish(ctx, x, y, 3.6, ev.dir, 1, ev.color);
  }
}
function drawBuoyEvent(ev, fc){
  const p = (fx.t - ev.t0) / ev.dur;
  if (p < 0 || p > 1) return;
  if (ev.cell !== fc) return;
  const ctx = fx.ctx;
  const x = fc.x + fc.w * ev.xFrac;
  const localX = clamp(x - fc.x, 0, fc.w);
  const surface = waterSurfaceAt(fc, waterTopOf(fc), localX);
  const leftY = waterSurfaceAt(fc, waterTopOf(fc), clamp(localX - 4, 0, fc.w));
  const rightY = waterSurfaceAt(fc, waterTopOf(fc), clamp(localX + 4, 0, fc.w));
  const waveTilt = clamp((rightY - leftY) * 0.08, -0.18, 0.18);
  const phase = fx.t * 1.7 + ev.phase;
  drawTinyBuoy(ctx, x, surface + Math.sin(phase) * 0.45, clamp(Math.min(fc.w, fc.hgt) * 0.18, 3.7, 7.4), ev.color, phase, waveTilt + Math.sin(phase * 0.7) * 0.055);
}
function drawDelightBehindWater(fc){
  if (!fx.delights?.length) return;
  for (const ev of fx.delights){
    const rowDi = ev.start?.di ?? ev.cell?.di ?? ev.row?.[0]?.di;
    if (rowDi !== fc.di) continue;
    if (ev.kind === 'fishJump') drawFishJumpEvent(ev);
    else if (ev.kind === 'buoy') drawBuoyEvent(ev, fc);
  }
}
function drawDelightEvent(ev){
  if (!ev) return;
  if (ev.kind === 'fishJump' || ev.kind === 'buoy') return;
  const p = (fx.t - ev.t0) / ev.dur;
  if (p < 0) return;
  if (p > 1) return;
  const ctx = fx.ctx;
  ctx.save();
  if (ev.kind === 'shootingStar'){
    const c = ev.cell, skyH = Math.max(2, (1 - (c.cell.waterFrac ?? 0.45)) * c.hgt);
    ctx.beginPath(); ctx.rect(c.x, c.y, c.w, skyH); ctx.clip();
    const x = c.x + c.w * (ev.sx + ev.len * p), y = c.y + skyH * (ev.sy + ev.len * 0.45 * p);
    const tx = c.w * 0.34, ty = skyH * 0.16, a = Math.sin(Math.PI * p);
    const g = ctx.createLinearGradient(x - tx, y - ty, x, y);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.75, `rgba(190,220,255,${(0.35 * a).toFixed(3)})`); g.addColorStop(1, `rgba(255,255,255,${(0.95 * a).toFixed(3)})`);
    ctx.strokeStyle = g; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - tx, y - ty); ctx.lineTo(x, y); ctx.stroke();
    ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`; ctx.beginPath(); ctx.arc(x, y, 1.2, 0, 6.2832); ctx.fill();
  } else if (ev.kind === 'fishSwim'){
    const x = ev.dir > 0 ? ev.rb.x - 12 + (ev.rb.w + 24) * p : ev.rb.x + ev.rb.w + 12 - (ev.rb.w + 24) * p;
    drawTinyFish(ctx, x, smoothFishY(ev.row, ev.rb, x, ev.lane) + Math.sin(fx.t * 2.2) * 0.8, 3.8, ev.dir, Math.sin(Math.PI * p), ev.color);
  } else if (ev.kind === 'gullFly'){
    const x = ev.dir > 0 ? ev.rb.x - 14 + (ev.rb.w + 28) * p : ev.rb.x + ev.rb.w + 14 - (ev.rb.w + 28) * p;
    drawTinyGull(ctx, x, smoothGullY(ev.row, ev.rb, x, ev.lane) + Math.sin(p * Math.PI * 2) * 1.2, 7, ev.dir, fx.t * 5.2, Math.sin(Math.PI * p));
  } else if (ev.kind === 'bubbleSeep'){
    const c = ev.cell, waterTop = waterTopOf(c), bottom = c.y + c.hgt - 2;
    const elapsed = fx.t - ev.t0;
    for (let i = 0; i < ev.count; i++){
      const q = (elapsed - i * ev.gap) / ev.riseDur;
      if (q < 0 || q > 1) continue;
      const ease = 1 - Math.pow(1 - q, 1.8);
      const wobble = Math.sin(q * 8 + i * 1.7) * c.w * 0.035;
      const x = c.x + c.w * ev.xFrac + wobble + ev.drift * q * c.w * 0.035;
      const y = lerp(bottom, waterTop + 2, ease);
      const surfacePop = q > 0.9 ? (1 - q) / 0.1 : 1;
      const fade = Math.min(1, q * 5, surfacePop);
      ctx.strokeStyle = `rgba(180,235,255,${(0.42 * fade).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 0.9 + i % 3 * 0.22 + q * 0.45, 0, 6.2832); ctx.stroke();
    }
  } else {
    const c = ev.cell, waterTop = c.y + (1 - (c.cell.waterFrac ?? 0.45)) * c.hgt;
    const x = c.x + c.w * ev.xFrac, a = Math.sin(Math.PI * p);
    ctx.strokeStyle = `rgba(255,244,190,${(0.45 * a).toFixed(3)})`; ctx.lineWidth = 1; ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++){ ctx.beginPath(); ctx.moveTo(x - 5 + i * 3, waterTop + 3 + i * 3); ctx.lineTo(x + 5 + i * 3, waterTop + 3 + i * 3); ctx.stroke(); }
  }
  ctx.restore();
}
function drawDelight(){
  if (!fx.delights?.length) return;
  fx.delights = fx.delights.filter(ev => (fx.t - ev.t0) / ev.dur <= 1);
  for (const ev of fx.delights) drawDelightEvent(ev);
}
function frame(now){
  const dt = Math.min(0.05, (now - fx.last) / 1000 || 0);
  fx.last = now; fx.t = now / 1000;
  fx.ctx.clearRect(0, 0, fx.w, fx.h);
  for (const fc of fx.cells) drawCell(fc, dt);
  drawWaterSeams();
  drawNowLine();
  drawSelectedCell();
  drawDelight();
  // A delight finishing (or the tip closing) can leave a fully static scene —
  // fall back to the idle repaint instead of burning 60fps on identical pixels.
  if (!fx.animated && !fx.delights.length && !selectedCell){
    fx.raf = 0;
    scheduleStillRepaint();
    return;
  }
  fx.raf = requestAnimationFrame(frame);
}
/* Static scenes (still water, clear daytime week) skip the RAF loop entirely;
 * a slow timer keeps the red now-line honest. */
function scheduleStillRepaint(){
  clearTimeout(fx.stillT);
  fx.stillT = setTimeout(() => {
    if (fx.raf || document.hidden) return;
    fx.t = performance.now() / 1000;
    drawFxStill();
    scheduleStillRepaint();
  }, 30000);
}
function startFx(){
  cancelAnimationFrame(fx.raf); fx.raf = 0;
  clearTimeout(fx.stillT);
  if (!fx.cells.length){ fx.ctx?.clearRect(0, 0, fx.w, fx.h); return; }
  const animate = !reduceMotion.matches && (fx.animated || fx.delights.length > 0 || !!selectedCell);
  if (!animate){
    fx.t = reduceMotion.matches ? 0 : performance.now() / 1000;
    drawFxStill();
    scheduleStillRepaint();
    return;
  }
  fx.last = performance.now(); fx.raf = requestAnimationFrame(frame);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden){
    cancelAnimationFrame(fx.raf);
    fx.raf = 0;
    clearTimeout(fx.stillT);
    return;
  }
  startFx();
  if (lastCoords && Date.now() - lastLoadedAt > 10 * 60 * 1000) load(lastCoords.lat, lastCoords.lon);
});
// Mid-session reduce-motion toggle: stop (or restart) the loop immediately.
reduceMotion.addEventListener?.('change', () => startFx());

/* ---------- Movable popups: shared dragger bound to this app's settings ---------- */
const { setPopupPoint, keepPopupOffRect } = AppCore;
function applyPopupPosition(kind, el){ const s = settings.popupPos?.[kind]; if (s) setPopupPoint(el, s.x * innerWidth, s.y * innerHeight); }
function popupDragger(kind, el, opts = {}){
  return AppCore.makeDraggablePopup({
    el,
    getSaved: () => settings.popupPos?.[kind] || null,
    save: p => { if (p) settings.popupPos[kind] = p; else delete settings.popupPos[kind]; saveSettings(); },
    ...opts,
  });
}

/* ---------- Grid gestures: tap → readout; horizontal swipe → preview/cycle locations ---------- */
const tipEl = $('#tip'); let tipTimer = 0, selectedCell = null;
const fxEls = () => [fx.canvas].filter(Boolean);
function cycleList(){
  const list = [null];
  settings.places.forEach((_, i) => list.push(i));
  return list;
}
function cycleStep(dir){
  const list = cycleList();
  if (list.length <= 1) return undefined;
  let i = list.indexOf(settings.activeIdx == null ? null : settings.activeIdx);
  if (i < 0) i = 0;
  return list[(i + dir + list.length) % list.length];
}
function coordsForIndex(idx){
  if (idx === undefined) return null;
  if (idx === null) return myCoords;
  const p = settings.places[idx];
  return p && !p.test && p.lat != null ? { lat: p.lat, lon: p.lon } : null;
}
function neighborPreview(dir){
  const idx = cycleStep(dir);
  if (idx === undefined) return null;
  const p = idx == null ? null : settings.places[idx];
  if (p?.test) return previewDays(testForecast(), 41.5, -71.3);
  const c = coordsForIndex(idx);
  const hit = c ? fcCache.get(fcKey(c.lat, c.lon)) : null;
  return hit ? previewDays(hit.json, c.lat, c.lon) : null;
}
function prefetchNeighbors(){
  const coords = [coordsForIndex(cycleStep(1)), coordsForIndex(cycleStep(-1))].filter(Boolean);
  const seen = new Set();
  for (const c of coords){
    const k = fcKey(c.lat, c.lon);
    if (seen.has(k) || fcCache.has(k)) continue;
    seen.add(k);
    fetchForecast(c.lat, c.lon)
      .then(json => cacheForecast(c.lat, c.lon, json))
      .catch(() => {});
  }
  if (settings.places.some(p => p.test)) testForecast();
}
function canSwipe(){ return cycleList().length > 1; }
function ghostCell(di, h, data){
  const c = data[di]?.cells[h];
  const el = document.createElement('div');
  el.className = 'cell';
  el.dataset.di = di; el.dataset.h = h;
  if (!c){ el.classList.add('empty'); return el; }
  const sky = skyStyle(c.elev, c.cloud);
  el.style.background = sky.grad;
  const water = document.createElement('div');
  water.className = 'ghost-water';
  water.style.height = `${clamp(c.waterFrac ?? 0.45, 0.05, 0.95) * 100}%`;
  el.appendChild(water);
  return el;
}
function buildGhost(data){
  const el = document.createElement('div');
  el.className = 'grid ghost';
  const n = data.length;
  el.style.gridTemplateColumns = `var(--label-day) repeat(24, minmax(0,1fr))`;
  el.style.gridTemplateRows = `var(--label) repeat(${n}, minmax(0,1fr))`;
  el.appendChild(corner());
  for (let h = 0; h < 24; h++) el.appendChild(hourHead(h));
  data.forEach((d, di) => {
    el.appendChild(dayHead(d));
    for (let h = 0; h < 24; h++) el.appendChild(ghostCell(di, h, data));
  });
  return el;
}
function mountGhost(data, rect){
  const el = buildGhost(data || placeholderDays());
  if (!data) el.classList.add('loading');
  el.style.setProperty('--dayfs', gridEl.style.getPropertyValue('--dayfs'));
  el.style.setProperty('--hourfs', gridEl.style.getPropertyValue('--hourfs'));
  Object.assign(el.style, {
    position: 'fixed', left: rect.left + 'px', top: rect.top + 'px',
    width: rect.width + 'px', height: rect.height + 'px',
    margin: '0', zIndex: '5', pointerEvents: 'none',
  });
  document.body.appendChild(el);
  return el;
}
// Drag/commit/tap mechanics come from AppCore.createGridCarousel. Ebb only
// swipes horizontally; a vertical drag is a dead gesture (fixed here: the old
// hand-rolled version re-detected the axis every move and could misread a big
// vertical drag as a tap on release).
const carousel = AppCore.createGridCarousel({
  gridEl,
  fxEls,
  axes: () => ['x'],
  canSwipe: () => canSwipe(),
  mountGhost: (axis, dir, rect) => mountGhost(neighborPreview(dir), rect),
  onCommit: (axis, dir) => {
    const cycleDir = dir < 0 ? 1 : -1;       // swipe left → next location
    const nd = neighborPreview(cycleDir);    // warm data for the target, matching the ghost
    cycleLocation(cycleDir);                 // switch + start the background refresh
    if (nd){ days = nd; resetDelight(); render(); gridEl.classList.remove('loading'); }
    else if (!days.length || !currentForecastMeta) showLoadingScaffold();
  },
  onTap: c => showTip(+c.dataset.di, +c.dataset.h, c),
});
document.addEventListener('click', e => { if (!e.target.closest('.cell') && !e.target.closest('.tip')) hideTip(); }, true);
function cycleLocation(dir){
  const next = cycleStep(dir);
  if (next === undefined) return false;
  switchTo(next);
  return true;
}
function hideTip(){
  clearTimeout(tipTimer); tipEl.hidden = true; selectedCell = null;
  startFx();                                 // may idle the loop again if the scene is static
}
// After a re-render (location change, tide fill-in), re-pin an open popup to the same
// cell so it shows the current location's data — or hide it if that cell is gone.
function refreshTip(){
  if (tipEl.hidden || !selectedCell) return;
  const { di, h } = selectedCell;
  const el = gridEl.querySelector(`.cell[data-di="${di}"][data-h="${h}"]`);
  if (el && !el.classList.contains('empty')) showTip(di, h, el);
  else hideTip();
}
function dismissTipFromPopup(){
  carousel.suppressTaps(450);
  setTimeout(hideTip, 0);
}
function showTip(di, h, el){
  if (gridEl.classList.contains('loading')) return;   // placeholder cells carry fabricated data — don't present it
  const c = days[di]?.cells[h]; if (!c) return;
  selectedCell = { di, h };
  const d = days[di];
  const location = place.name && place.name !== '—' ? place.name : 'Current location';
  const head = `
    <span class="tip-place">${escapeHtml(location)}</span>
    <span class="tip-time">${d.dow} ${fmtHourLong(h)}</span>`;
  let tide = '<span class="tip-primary"><span class="tip-primary-label">Tide</span><strong>Unavailable</strong></span>';
  if (c.tideFt != null){
    const trend = c.rising == null ? '' : (c.rising
      ? `<span class="tide-rise">▲ Rising</span>`
      : `<span class="tide-fall">▼ Falling</span>`);
    tide = `<span class="tip-primary"><span class="tip-primary-label">Tide</span><strong>${c.tideFt.toFixed(1)} ft</strong>${trend}</span>`;
  }
  const mark = c.tideMark
    ? `<span class="tip-event">${c.tideMark.type === 'H' ? 'High' : 'Low'} tide · ${fmtClockMinute(h, c.tideMark.minute || 0)}</span>`
    : '';
  const bite = settings.bite === 'on' && c.biteOn && c.biteWhy?.length
    ? `<span class="tip-bite">🎣 Bite window · ${escapeHtml(c.biteWhy.join(' + '))}</span>`
    : '';
  const facts = [
    `Wind${c.windDir != null ? ' ' + compass8(c.windDir) : ''} ${Math.round(c.windMph)} mph`,
  ];
  if ((c.pop || 0) > 10 && isThunder(c)) facts.push(`${c.pop | 0}% thunderstorm`);
  else if ((c.pop || 0) > 10 && ((c.precipMm || 0) > 0 || (c.snowCm || 0) > 0)) facts.push(`${c.pop | 0}% ${c.snowCm > 0 ? 'snow' : 'rain'}`);
  else facts.push('Dry');
  facts.push(`${c.cloud | 0}% cloud`);
  if (c.tF != null) facts.push(`${Math.round(c.tF)}°`);
  tipEl.innerHTML = head + tide + mark + bite
    + `<span class="tip-facts">${facts.map(v => `<span>${v}</span>`).join('')}</span>`;
  tipEl.classList.remove('top');
  const cellH = gridEl.querySelector('.cell:not(.empty)')?.getBoundingClientRect().height || 0;
  tipEl.style.setProperty('--tip-shift', Math.round(cellH) + 'px');
  tipEl.hidden = false;
  applyPopupPosition('tip', tipEl);                            // honor a saved dragged position
  keepPopupOffRect(tipEl, el?.getBoundingClientRect());
  startFx();                                 // selection pulse needs the loop (or a fresh still frame)
  clearTimeout(tipTimer); tipTimer = setTimeout(hideTip, 15000);
}
popupDragger('tip', tipEl, {
  beforeDrag: () => clearTimeout(tipTimer),
  afterDrag: () => { clearTimeout(tipTimer); if (!tipEl.hidden) tipTimer = setTimeout(hideTip, 15000); },
  onTap: dismissTipFromPopup,
});

/* ---------- Settings sheet ---------- */
const sheetEl = $('#settings');
function shareDataReady(){
  return !!currentForecastMeta && days.some(day => day.cells.some(cell => cell?.tideFt != null));
}
// The snapshot is built on the first Share tap (not on every sheet open).
// layoutFx({ still: true }) parks the animation on a drawn frame instead of the
// old cancel-then-immediately-restart, so the capture really is a still.
const shareManager = AppCore.createShareManager({
  button: $('#shareView'),
  grid: gridEl,
  appName: 'Ebb',
  url: 'https://dsparks.github.io/24x7/ebb.html',
  filenamePrefix: 'ebb',
  snapshotClass: 'snapshot-no-cell-borders',
  overlays: () => [fx.canvas],
  placeName: () => place.name,
  ready: () => shareDataReady() && !gridEl.classList.contains('loading'),
  beforeCapture: async () => { gridEl.classList.add('snapshot-rendering'); layoutFx({ still: true }); },
  afterCapture: async () => { gridEl.classList.remove('snapshot-rendering'); layoutFx(); },
  onShareStart: () => { closeSheet(); hideTip(); },
});
function invalidateShare(){ shareManager.invalidate(); }
function openSheet(){
  syncSheet();
  sheetEl.hidden = false;
  shareManager.sync();
}
function closeSheet(){ sheetEl.hidden = true; }
sheetEl.addEventListener('click', e => { if (e.target.dataset.close !== undefined) closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sheetEl.hidden) closeSheet(); });
function syncSheet(){
  $('#placeName').textContent = place.name; $('#placeSub').textContent = place.sub || '';
  document.querySelectorAll('.seg').forEach(seg => { const v = String(settings[seg.dataset.setting]); seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.value === v)); });
  document.querySelectorAll('[data-desktop-layout]').forEach(el => { el.hidden = !desktopFrameEnabled(); });
  renderPlaceList();
}
document.querySelectorAll('.seg').forEach(seg => seg.addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  settings[seg.dataset.setting] = btn.dataset.value; saveSettings(); applyDesktopFrame(); syncSheet(); render();
}));

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
function maybeShowCoach(){
  let seen = false; try { seen = localStorage.getItem(LS.coach) === '1'; } catch {}
  if (!seen) coachEl.hidden = false;
}

/* ---------- Saved locations ---------- */
// Prevent late GPS/reverse-geocoder callbacks from replacing a newer user choice.
let locationIntent = 0;
function placeItem(name, active, onSelect, onDelete){
  const row = document.createElement('div'); row.className = 'place-item' + (active ? ' on' : '');
  const label = document.createElement('button'); label.type = 'button'; label.className = 'pi-name'; label.textContent = name;
  label.addEventListener('click', onSelect); row.appendChild(label);
  if (onDelete){ const del = document.createElement('button'); del.type = 'button'; del.className = 'pi-del'; del.textContent = '✕'; del.setAttribute('aria-label', 'Remove'); del.addEventListener('click', ev => { ev.stopPropagation(); onDelete(); }); row.appendChild(del); }
  return row;
}
function renderPlaceList(){
  const host = $('#placeList'); if (!host) return; host.innerHTML = '';
  host.appendChild(placeItem('📍 My location', settings.activeIdx == null, () => switchTo(null)));
  settings.places.forEach((p, i) => host.appendChild(placeItem(p.name + (p.admin ? `, ${p.admin}` : ''), settings.activeIdx === i, () => switchTo(i), () => removePlace(i))));
}
function switchTo(idx){
  const intent = ++locationIntent;
  settings.activeIdx = idx; saveSettings(); renderPlaceList();
  const p = idx != null ? settings.places[idx] : null;
  if (p?.test) loadTest();
  else if (p){ setPlace(p.name, p.admin || ''); load(p.lat, p.lon); }
  else if (myCoords){
    setPlace(myPlace?.name || 'Current location', myPlace?.sub || '');
    load(myCoords.lat, myCoords.lon);
    reverseName(myCoords.lat, myCoords.lon, intent).then(p => { if (p) myPlace = p; });
  } else { setPlace('Locating...', ''); locate(intent); }
}
function removePlace(i){
  const was = settings.activeIdx === i;
  settings.places.splice(i, 1);
  if (settings.activeIdx === i) settings.activeIdx = null; else if (settings.activeIdx > i) settings.activeIdx--;
  saveSettings(); was ? switchTo(settings.activeIdx) : renderPlaceList();
}
function addPlace(r){
  const np = { lat: r.latitude, lon: r.longitude, name: r.name, admin: [r.admin1, r.country_code].filter(Boolean).join(', ') };
  const dup = settings.places.findIndex(p => Math.abs(p.lat - np.lat) < 0.01 && Math.abs(p.lon - np.lon) < 0.01);
  switchTo(dup >= 0 ? dup : settings.places.push(np) - 1);
}

/* ---------- Location search: live typeahead (borrowed from 24×7) ---------- */
const TEST_QUERIES = ['!test', '!demo'];
const isTestQuery = q => TEST_QUERIES.includes(q.trim().toLowerCase());
const searchBox = $('#searchBox'), searchInput = $('#searchInput'), searchClear = $('#searchClear'), resultsEl = $('#searchResults');
let searchSeq = 0, searchAbort = null, searchTimer = 0, hits = [], activeIdx = -1;
function cancelSearch(){
  ++searchSeq;
  clearTimeout(searchTimer);
  searchAbort?.abort();
  searchAbort = null;
}
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const flagOf = cc => (cc && cc.length === 2) ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '📍';
function hl(name, q){ const i = name.toLowerCase().indexOf(q.toLowerCase()); return i < 0 ? escHtml(name) : escHtml(name.slice(0, i)) + '<b>' + escHtml(name.slice(i, i + q.length)) + '</b>' + escHtml(name.slice(i + q.length)); }
function openResults(){ resultsEl.hidden = false; searchBox.setAttribute('aria-expanded', 'true'); }
function closeResults(){ resultsEl.hidden = true; resultsEl.innerHTML = ''; hits = []; activeIdx = -1; searchBox.setAttribute('aria-expanded', 'false'); searchInput.removeAttribute('aria-activedescendant'); }
function showMsg(t){ openResults(); resultsEl.innerHTML = `<li class="result-msg">${escHtml(t)}</li>`; hits = []; activeIdx = -1; }
const RANK = { apiOrder: 0.6, exact: 6, prefix: 3, popMax: 5, us: 2.5, usLocale: 1, proxMax: 3, proxKm: 1500 };
function rankHits(items, q, ref){
  const ql = q.toLowerCase(), usW = RANK.us + (usLocale() ? RANK.usLocale : 0);
  return items.map((r, i) => {
    let s = -i * RANK.apiOrder; const nl = (r.name || '').toLowerCase();
    if (nl === ql) s += RANK.exact; else if (nl.startsWith(ql)) s += RANK.prefix;
    if (r.population > 0) s += Math.max(0, Math.min(RANK.popMax, Math.log10(r.population) - 2));
    if (r.country_code === 'US') s += usW;
    if (ref && r.latitude != null) s += RANK.proxMax * Math.exp(-haversineKm(ref.lat, ref.lon, r.latitude, r.longitude) / RANK.proxKm);
    return { r, s, i };
  }).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.r);
}
function renderHits(items, q){
  hits = items; activeIdx = -1; resultsEl.innerHTML = '';
  items.forEach((r, i) => {
    const sub = [r.admin1, r.country].filter(Boolean).join(', ');
    const li = document.createElement('li');
    li.className = 'result'; li.id = 'sr-' + i; li.setAttribute('role', 'option');
    li.innerHTML = `<span class="r-flag">${flagOf(r.country_code)}</span><span class="r-text"><span class="r-name">${hl(r.name, q)}</span>${sub ? `<span class="r-sub">${escHtml(sub)}</span>` : ''}</span>`;
    li.addEventListener('pointerdown', e => { e.preventDefault(); choose(i); });
    resultsEl.appendChild(li);
  });
  openResults();
}
function setActive(i){ const rows = resultsEl.querySelectorAll('.result'); if (!rows.length) return; activeIdx = (i + rows.length) % rows.length; rows.forEach((el, j) => el.setAttribute('aria-selected', j === activeIdx ? 'true' : 'false')); rows[activeIdx].scrollIntoView({ block: 'nearest' }); searchInput.setAttribute('aria-activedescendant', rows[activeIdx].id); }
function choose(i){ const r = hits[i]; if (!r) return; addPlace(r); resetSearch(); }
function resetSearch(){ cancelSearch(); searchInput.value = ''; searchClear.hidden = true; closeResults(); }
async function runSearch(q){
  const seq = ++searchSeq; searchAbort?.abort(); searchAbort = new AbortController(); showMsg('Searching…');
  try { const res = await geocode(q, searchAbort.signal); if (seq !== searchSeq) return; if (!res.length) return showMsg('No matches'); renderHits(rankHits(res, q, lastCoords), q); }
  catch (err){ if (err.name === 'AbortError' || seq !== searchSeq) return; showMsg('Search error — try again'); }
}
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim(); searchClear.hidden = !searchInput.value; cancelSearch();
  if (isTestQuery(q)){ openResults(); resultsEl.innerHTML = `<li class="result" id="sr-0" role="option"><span class="r-flag">🎣</span><span class="r-text"><span class="r-name">Add test conditions</span><span class="r-sub">a simulated week</span></span></li>`; resultsEl.querySelector('.result').addEventListener('pointerdown', e => { e.preventDefault(); resetSearch(); addTestPlace(); }); return; }
  if (q.length < 2){ closeResults(); return; }
  searchTimer = setTimeout(() => runSearch(q), 220);
});
searchInput.addEventListener('keydown', e => {
  const q = searchInput.value.trim();
  if (e.key === 'ArrowDown'){ if (!resultsEl.hidden){ setActive(activeIdx + 1); e.preventDefault(); } }
  else if (e.key === 'ArrowUp'){ if (!resultsEl.hidden){ setActive(activeIdx - 1); e.preventDefault(); } }
  else if (e.key === 'Enter'){ e.preventDefault(); if (isTestQuery(q)){ resetSearch(); addTestPlace(); return; } if (activeIdx >= 0) choose(activeIdx); else if (hits.length) choose(0); }
  else if (e.key === 'Escape'){ if (!resultsEl.hidden) closeResults(); else resetSearch(); }
});
searchClear.addEventListener('click', () => { resetSearch(); searchInput.focus(); });
searchInput.addEventListener('blur', () => setTimeout(closeResults, 120));
searchInput.addEventListener('focus', () => {
  if (hits.length) openResults();
  else if (searchInput.value.trim().length >= 2) searchInput.dispatchEvent(new Event('input'));
});

function addTestPlace(){ testForecastCache = null; let i = settings.places.findIndex(p => p.test); if (i < 0) i = settings.places.push({ name: '🎣 Test conditions', test: true }) - 1; switchTo(i); }

/* ---------- Geolocation ---------- */
function locate(intent = ++locationIntent){
  // When a usable forecast is already on screen (boot painted the cached last
  // location and its refresh may already have landed), a denied/unavailable
  // geolocation must not stomp the header with "Location blocked".
  const failQuietlyIfShowingData = () => {
    if (!currentForecastMeta) return false;
    if (place.name === 'Last location' || place.name === 'Locating...') setPlace('Last known location', 'Search in settings to change');
    return true;
  };
  if (!('geolocation' in navigator)){
    if (intent === locationIntent && !failQuietlyIfShowingData()){
      setPlace('Location unavailable', 'Search in settings');
      gridEl.classList.remove('loading');
      $('#updatedAt').textContent = 'Choose a location';
      setTideSrc('Choose a location in settings');
    }
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      if (intent !== locationIntent) return;
      myCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      setPlace(myPlace?.name || 'Current location', myPlace?.sub || '');
      load(myCoords.lat, myCoords.lon);
      reverseName(myCoords.lat, myCoords.lon, intent).then(p => { if (p) myPlace = p; });
    },
    () => {
      if (intent !== locationIntent || failQuietlyIfShowingData()) return;
      setPlace('Location blocked', 'Search in settings ⚙');
      gridEl.classList.remove('loading');
      $('#updatedAt').textContent = 'Choose a location';
      setTideSrc('Choose a location in settings');
    },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 }
  );
}
async function reverseName(lat, lon, intent = locationIntent){
  try { const j = await AppCore.fetchJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10`, { label: 'Reverse geocode', timeoutMs: 12000 });
    const a = j.address || {}; const name = a.city || a.town || a.village || a.hamlet || a.county || j.name;
    const sub = [a.state, (a.country_code || '').toUpperCase()].filter(Boolean).join(', ');
    if (intent !== locationIntent) return null;
    if (name){ const p = { name, sub }; setPlace(name, sub); return p; } } catch {}
  return null;
}

/* ---------- Test forecast (varied sky/wind/precip) ---------- */
function genTestForecast(){
  const r1 = v => Math.round(v * 10) / 10;
  const hKey = d => `${ymd(d)}T${pad(d.getHours())}:00`;
  const hourly = { time: [], temperature_2m: [], cloud_cover: [], precipitation: [], snowfall: [], precipitation_probability: [], weather_code: [], wind_speed_10m: [], wind_direction_10m: [], wind_gusts_10m: [], is_day: [] };
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const baseC = rand(2, 26);
  for (let day = 0; day < 7; day++){
    const d0 = new Date(start.getTime() + day * 86400000);
    const dayMean = baseC + (day / 6 - 0.5) * rand(6, 16);
    const wet = Math.random() < 0.5, stormH = rand(0, 23), stormW = rand(2, 7);
    const windBase = rand(3, 16), windGust = rand(2, 24), dir0 = rand(0, 360), dirDrift = rand(-50, 50);
    const cloudBase = wet ? rand(50, 90) : rand(5, 50);
    for (let h = 0; h < 24; h++){
      const t = new Date(d0.getTime() + h * 3600000); hourly.time.push(hKey(t));
      const diurnal = -Math.cos((h - 5) / 24 * 2 * Math.PI);
      const tempC = dayMean + diurnal * rand(3, 7);
      hourly.temperature_2m.push(r1(tempC));
      const g = wet ? Math.exp(-((h - stormH) ** 2) / (2 * stormW * stormW)) : 0;
      const mm = wet ? rand(0.1, 3) * g : 0;
      const snow = (tempC <= 0.5 && mm > 0) ? mm * 0.8 : 0;
      hourly.precipitation.push(r1(mm)); hourly.snowfall.push(r1(snow));
      hourly.precipitation_probability.push(Math.round(clamp(40 * g + (wet ? 20 : 0) + rand(-10, 10), 0, 100)));
      hourly.cloud_cover.push(Math.round(clamp(cloudBase + g * 40 + rand(-15, 15), 0, 100)));
      hourly.weather_code.push(mm > 1.6 && Math.abs(h - stormH) < 1.5 ? 95 : (mm > 0.05 ? (snow > 0 ? 73 : 61) : 0));
      const wind = clamp(windBase + windGust * Math.max(0, Math.sin(h / 24 * 6.28)) + rand(-3, 3), 0, 48);
      hourly.wind_speed_10m.push(r1(wind)); hourly.wind_gusts_10m.push(r1(wind + rand(2, 12)));
      hourly.wind_direction_10m.push(Math.round(((dir0 + dirDrift * (h / 23) + rand(-15, 15)) % 360 + 360) % 360));
      hourly.is_day.push(h >= 6 && h <= 19 ? 1 : 0);
    }
  }
  return { hourly, utc_offset_seconds: -new Date().getTimezoneOffset() * 60 };
}

/* ---------- Resize ---------- */
let rT; addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(() => { applyDesktopFrame(); (isPortrait() ? 'p' : 'l') !== orientation ? render() : layoutFx(); }, 120); });

// Refresh only while visible; visibilitychange catches up after a sleeping PWA resumes.
setInterval(() => {
  if (!document.hidden && lastCoords && Date.now() - lastLoadedAt >= 15 * 60 * 1000){
    load(lastCoords.lat, lastCoords.lon);
  }
}, 15 * 60 * 1000);

/* ---------- Service worker (offline / installable PWA) ---------- */
AppCore.registerFreshServiceWorker('sw.js');

/* ---------- Boot ---------- */
function boot(){
  maybeShowCoach();
  const cache = readCache();
  if (cache?.json && cache.lat != null && cache.lon != null) cacheForecast(cache.lat, cache.lon, cache.json, cache.t || Date.now());
  const active = settings.activeIdx != null ? settings.places[settings.activeIdx] : null;
  if (active?.test) return loadTest();
  if (active){
    if (cacheMatches(cache, active.lat, active.lon)){
      applyForecast(cache.json, active.lat, active.lon, cache.t, 'cached');
      if (!applyCachedTides(cache)) applySimulatedTides(active.lon, 'Tide: simulated until NOAA refreshes');
      render();
    } else {
      showLoadingScaffold();
    }
    setPlace(active.name || 'Saved', active.admin || '');
    return load(active.lat, active.lon);
  }
  if (cache?.json && cache.lat != null && cache.lon != null){
    applyForecast(cache.json, cache.lat, cache.lon, cache.t, 'cached');
    if (!applyCachedTides(cache)) applySimulatedTides(cache.lon, 'Tide: simulated until location updates');
    render();
    setPlace('Last location', 'Updating current location...');
    load(cache.lat, cache.lon);
  } else {
    showLoadingScaffold();
    setPlace('Locating...', '');
  }
  locate();
}

applyDesktopFrame();
boot();

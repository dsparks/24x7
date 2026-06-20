/* Ebb — a week of fishing conditions as an ocean cutaway.
 * Each cell: pure-black water (height = tide), a sky colored by cloud cover and
 * time-of-day (golden hour → night with stars), wind as surface chop, plus precip.
 * Borrows the grid/layout/search scaffolding from its sibling 24×7. */
const APP_NAME = 'Ebb';
const $ = sel => document.querySelector(sel);
const LS = { settings: 'ebb.settings', cache: 'ebb.cache', stations: 'ebb.stations' };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
const COMPASS = ['N','NE','E','SE','S','SW','W','NW'];
const compass8 = deg => deg == null ? '' : COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

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
const DEFAULTS = { clock: 'auto', places: [], activeIdx: null, popupPos: {} };
let settings = loadSettings();
function loadSettings(){
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS.settings) || '{}') }; }
  catch { s = { ...DEFAULTS }; }
  if (!Array.isArray(s.places)) s.places = [];
  if (!s.popupPos || typeof s.popupPos !== 'object') s.popupPos = {};
  if (s.activeIdx != null && !(s.activeIdx >= 0 && s.activeIdx < s.places.length)) s.activeIdx = null;
  return s;
}
function saveSettings(){ try { localStorage.setItem(LS.settings, JSON.stringify(settings)); } catch {} }

let place = { name: '—', sub: '' };
function setPlace(name, sub){ place = { name, sub: sub || '' }; $('#placeName').textContent = name; $('#placeSub').textContent = sub || ''; }
let tideSource = '—';
function setTideSrc(t){ tideSource = t; const el = $('#tideSrc'); if (el) el.textContent = t; }

/* ---------- Open-Meteo forecast (sky / wind / precip) ---------- */
function buildUrl(lat, lon){
  const p = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4),
    hourly: 'temperature_2m,cloud_cover,precipitation,snowfall,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day',
    wind_speed_unit: 'mph', timezone: 'auto', forecast_days: '7',
  });
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}
async function geocode(q, signal){
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en&format=json`;
  const r = await fetch(url, signal ? { signal } : undefined);
  if (!r.ok) throw new Error('search failed');
  return (await r.json()).results || [];
}
function toDays(j){
  const h = j.hourly || {}, time = h.time || [];
  const offset = j.utc_offset_seconds || 0;
  const byDate = new Map();
  for (let i = 0; i < time.length; i++){
    const iso = time[i], dateKey = iso.slice(0, 10), hour = +iso.slice(11, 13);
    if (!byDate.has(dateKey)) byDate.set(dateKey, new Array(24).fill(null));
    byDate.get(dateKey)[hour] = {
      iso,
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
    };
  }
  const keys = [...byDate.keys()].sort().slice(0, 7);
  const days = keys.map(k => {
    const d = new Date(k + 'T00:00');
    return { date: d, dow: WD[d.getDay()], dnum: d.getDate(), isToday: ymd(d) === ymd(new Date()), cells: byDate.get(k) };
  });
  return { days, offset };
}

/* ---------- NOAA tides (US), with synthetic fallback ---------- */
const NOAA_STATIONS = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions';
async function getStations(){
  try { const c = JSON.parse(localStorage.getItem(LS.stations) || 'null'); if (c && Date.now() - c.t < 30 * 86400000) return c.list; } catch {}
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 9000);
  const j = await (await fetch(NOAA_STATIONS, { signal: ctrl.signal })).json();
  clearTimeout(to);
  const list = (j.stations || []).map(s => ({ id: s.id, name: s.name, state: s.state, lat: +s.lat, lon: +s.lng }))
    .filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  try { localStorage.setItem(LS.stations, JSON.stringify({ t: Date.now(), list })); } catch {}
  return list;
}
async function nearestStation(lat, lon){
  const list = await getStations();
  let best = null, bd = Infinity;
  for (const s of list){ const d = haversineKm(lat, lon, s.lat, s.lon); if (d < bd){ bd = d; best = s; } }
  return best && bd <= 250 ? { ...best, dist: bd } : null;
}
async function fetchTides(stationId, start){
  const bd = `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}`;
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=ebb&datum=MLLW&interval=h&units=english&time_zone=lst_ldt&format=json&station=${stationId}&begin_date=${bd}&range=168`;
  const j = await (await fetch(url)).json();
  const map = new Map();
  (j.predictions || []).forEach(p => map.set(p.t.replace(' ', 'T').slice(0, 13), +p.v));
  return map;
}
function applyTideMap(days, map){
  days.forEach(d => d.cells.forEach(c => { if (c) c.tideFt = map.get(c.iso.slice(0, 13)) ?? null; }));
}
function synthTides(days, seedLon){
  const ph = (seedLon || 0) * 0.7, amp = 2.0 + Math.abs((seedLon || 0) % 7) * 0.25;   // ~2–4 ft
  days.forEach((d, di) => d.cells.forEach((c, h) => {
    if (!c) return;
    const t = di * 24 + h;
    c.tideFt = amp + amp * Math.sin(2 * Math.PI * t / 12.42 + ph) + amp * 0.32 * Math.sin(2 * Math.PI * t / 12.0 + ph * 1.3);
  }));
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
}
function enrichSun(days, lat, lon, offset){
  days.forEach(d => d.cells.forEach(c => {
    if (!c) return;
    const utc = new Date(Date.parse(c.iso + 'Z') - offset * 1000);
    c.elev = solarElevation(utc, lat, lon);
  }));
}

/* ---------- Load orchestration ---------- */
let days = [], orientation = 'p', loadSeq = 0, lastCoords = null;
async function load(lat, lon){
  const seq = ++loadSeq;
  lastCoords = { lat, lon };
  const start = new Date(); start.setHours(0, 0, 0, 0);
  try {
    const fc = await (await fetch(buildUrl(lat, lon))).json();
    if (seq !== loadSeq) return;
    const parsed = toDays(fc);
    days = parsed.days;
    enrichSun(days, lat, lon, parsed.offset);
    render();                                   // paint sky immediately; tides fill in next
    // tides (async; may fail → synth)
    try {
      const st = await nearestStation(lat, lon);
      if (!st) throw new Error('no station');
      const map = await fetchTides(st.id, start);
      if (seq !== loadSeq) return;
      applyTideMap(days, map);
      if (![...days].some(d => d.cells.some(c => c && c.tideFt != null))) throw new Error('empty');
      setTideSrc(`Tide: ${st.name}`);
    } catch {
      synthTides(days, lon);
      setTideSrc('Tide: simulated (no NOAA station)');
    }
    enrichTide(days);
    render();
  } catch {
    setTideSrc('Forecast unavailable');
  }
}
function loadTest(){
  const parsed = toDays(genTestForecast());
  days = parsed.days;
  enrichSun(days, 41.5, -71.3, parsed.offset);    // Narragansett-ish, just for sun timing
  synthTides(days, -71.3);
  enrichTide(days);
  setTideSrc('Tide: simulated (test)');
  lastCoords = null;
  render();
}

function placeholderDays(){
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start.getTime() + i * 86400000);
    const cells = Array.from({ length: 24 }, (_, h) => {
      const dayHr = h >= 6 && h <= 19;
      return { iso: `${ymd(d)}T${pad(h)}:00`, cloud: 35, elev: dayHr ? 30 : -25, windMph: 4, windDir: 270, gust: 6, precipMm: 0, snowCm: 0, pop: 0, wcode: 0, isDay: dayHr ? 1 : 0, tF: null, tideFt: null };
    });
    return { date: d, dow: WD[d.getDay()], dnum: d.getDate(), isToday: i === 0, cells };
  });
}

/* ---------- Grid render ---------- */
const gridEl = $('#grid');
function corner(){
  const el = document.createElement('div');
  el.className = 'corner'; el.setAttribute('role', 'button'); el.setAttribute('aria-label', 'Settings');
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
const isPortrait = () => innerHeight >= innerWidth;
function render(){
  if (!days.length) return;
  const portrait = isPortrait();
  orientation = portrait ? 'p' : 'l';
  const n = days.length;
  const frag = document.createDocumentFragment();
  gridEl.className = 'grid ' + orientation;
  fx.cells = [];
  if (portrait){
    gridEl.style.gridTemplateColumns = `var(--label) repeat(${n}, minmax(0,1fr))`;
    gridEl.style.gridTemplateRows = `var(--label-day) repeat(24, minmax(0,1fr))`;
    frag.appendChild(corner());
    days.forEach(d => frag.appendChild(dayHead(d)));
    for (let h = 0; h < 24; h++){ frag.appendChild(hourHead(h)); for (let di = 0; di < n; di++) frag.appendChild(cellEl(di, h)); }
  } else {
    gridEl.style.gridTemplateColumns = `var(--label-day) repeat(24, minmax(0,1fr))`;
    gridEl.style.gridTemplateRows = `var(--label) repeat(${n}, minmax(0,1fr))`;
    frag.appendChild(corner());
    for (let h = 0; h < 24; h++) frag.appendChild(hourHead(h));
    days.forEach((d, di) => { frag.appendChild(dayHead(d)); for (let h = 0; h < 24; h++) frag.appendChild(cellEl(di, h)); });
  }
  gridEl.replaceChildren(frag);
  layoutFx();
}

const DAY_SCALE = 0.8, HOUR_SCALE = 1.1, CW = 0.62;
function fitHeaders(){
  const portrait = orientation === 'p';
  const d = gridEl.querySelector('.head.day');
  if (d){ const w = d.clientWidth, hh = d.clientHeight;
    const px = (portrait ? Math.min(hh * 0.86, w / (4 * CW)) : Math.min(hh * 0.46, w / (2 * CW))) * DAY_SCALE;
    gridEl.style.setProperty('--dayfs', Math.max(7, Math.round(px)) + 'px'); }
  const hr = gridEl.querySelector('.head.hour');
  if (hr){ const w = hr.clientWidth, hh = hr.clientHeight; const len = clock24() ? 2 : 3;
    gridEl.style.setProperty('--hourfs', Math.max(7, Math.round(Math.min(hh * 0.86, w / (len * CW)) * HOUR_SCALE)) + 'px'); }
}

/* ---------- Cutaway canvas: water + chop + precip + stars ---------- */
const fx = { cells: [], canvas: null, ctx: null, dpr: 1, w: 0, h: 0, raf: 0, last: 0, t: 0 };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
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
  // stars
  fc.stars = [];
  if (c._starA > 0.02){
    const n = Math.round(4 + Math.random() * 5);
    for (let i = 0; i < n; i++) fc.stars.push({ x: Math.random(), y: Math.random() * 0.8, r: rand(0.5, 1.4), tw: rand(0.7, 1.7), ph: rand(0, 6.28) });
  }
  // precip particles
  fc.precip = []; fc.snow = (c.snowCm || 0) > 0;
  const wet = (c.precipMm || 0) > 0 || (fc.snow && c.snowCm > 0);
  if (wet){
    const intensity = clamp((fc.snow ? c.snowCm * 3 : c.precipMm * 6), 0.4, 6);
    const n = Math.round(3 + intensity * 2.2);
    for (let i = 0; i < n; i++) fc.precip.push({ x: Math.random(), y: Math.random(), v: rand(0.6, 1.1), ph: rand(0, 6.28) });
  }
}
function layoutFx(){
  fitHeaders();
  if (!fx.canvas){ fx.canvas = $('#fx'); fx.ctx = fx.canvas.getContext('2d'); }
  const g = gridEl.getBoundingClientRect();
  fx.w = g.width; fx.h = g.height;
  fx.dpr = Math.min(1.5, devicePixelRatio || 1);
  Object.assign(fx.canvas.style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px` });
  fx.canvas.width = Math.round(g.width * fx.dpr); fx.canvas.height = Math.round(g.height * fx.dpr);
  fx.ctx.setTransform(fx.dpr, 0, 0, fx.dpr, 0, 0);
  fx.cells = [];
  gridEl.querySelectorAll('.cell').forEach(el => {
    if (el.classList.contains('empty')) return;
    const c = days[+el.dataset.di]?.cells[+el.dataset.h]; if (!c) return;
    const r = el.getBoundingClientRect();
    const fc = { di: +el.dataset.di, h: +el.dataset.h, cell: c, x: r.left - g.left, y: r.top - g.top, w: r.width, hgt: r.height };
    buildCellFx(fc); fx.cells.push(fc);
  });
  startFx();
}
function drawCell(fc, dt){
  const ctx = fx.ctx, c = fc.cell;
  const left = fc.x, top = fc.y, w = fc.w, h = fc.hgt, bottom = top + h;
  const waterTop = top + (1 - (c.waterFrac ?? 0.45)) * h;
  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, w, h); ctx.clip();

  // golden-hour / twilight glow near the horizon
  if (c._glow > 0.04){
    const gr = ctx.createRadialGradient(left + w / 2, waterTop, 1, left + w / 2, waterTop, w * 0.9);
    gr.addColorStop(0, `rgba(255,178,96,${(c._glow * 0.45).toFixed(3)})`);
    gr.addColorStop(1, 'rgba(255,178,96,0)');
    ctx.fillStyle = gr; ctx.fillRect(left, top, w, waterTop - top + 4);
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
        const px = left + p.x * w + slant * p.y * skyH;        // drift sideways as it falls — same slope as the streak
        const len = Math.min(6, skyH * 0.18);
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - slant * len, py - len); ctx.stroke();
      }
    }
  }
  // black water surface (chop renderer chosen by CHOP_VERSION)
  (CHOP_VERSION === 1 ? drawWaterV1 : drawWaterV2)(fc, waterTop);
  ctx.restore();
}

/* ---------- Water-surface renderers ----------
 * Switch with CHOP_VERSION: 1 = gentle two-wave chop (the original "chop 1.0"),
 * 2 = directional wind-driven waves with whitecaps + spray that build with wind. */
const CHOP_VERSION = 2;

// chop 1.0 — preserved so we can flip back if we prefer it.
function drawWaterV1(fc, waterTop){
  const ctx = fx.ctx, c = fc.cell;
  const left = fc.x, w = fc.w, h = fc.hgt, bottom = fc.y + h;
  const wind = c.windMph || 0, gust = c.gust || 0;
  const dirSign = (c.windDir == null) ? 1 : (windToward(c.windDir).x >= 0 ? 1 : -1);
  const amp = clamp(0.4 + (wind + gust * 0.3) * 0.16, 0.4, h * 0.12);
  const k = (2 * Math.PI) / Math.max(18, w * 0.6);
  const spd = (0.5 + wind * 0.06) * dirSign;
  const surf = x => waterTop + amp * Math.sin(k * x + fx.t * spd) + amp * 0.4 * Math.sin(2.2 * k * x - fx.t * spd * 1.4);
  ctx.beginPath(); ctx.moveTo(left, bottom);
  for (let x = 0; x <= w; x += 4) ctx.lineTo(left + x, surf(x));
  ctx.lineTo(left + w, bottom); ctx.closePath();
  ctx.fillStyle = '#000'; ctx.fill();
  ctx.beginPath();
  for (let x = 0; x <= w; x += 4){ const y = surf(x); x === 0 ? ctx.moveTo(left, y) : ctx.lineTo(left + x, y); }
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
  const travel = fx.t * (1.1 + wind * 0.12) * roll;                 // horizontal travel; speed ∝ wind, side from roll
  const bob = fx.t * 1.6;                                           // extra agitation on top of the travel
  const sharp = 0.5 + wf * 0.45;                                    // crest pointiness
  // Precompute the surface once: sharpened trochoid (pointy crests, flat troughs)
  // plus a cross-wave. sin(kx − ωt) ⇒ crests travel toward +x (right) when roll>0.
  const step = 3, ys = [];
  for (let x = 0; x <= w; x += step){
    const s = Math.sin(k * x - travel);
    const peaked = Math.sign(s) * Math.pow(Math.abs(s), 1 / (1 + sharp));
    ys.push(waterTop + amp * (peaked * 0.82 + 0.3 * Math.sin(2.4 * k * x + bob)));
  }
  ctx.beginPath(); ctx.moveTo(left, bottom);
  ys.forEach((y, i) => ctx.lineTo(left + i * step, y));
  ctx.lineTo(left + (ys.length - 1) * step, bottom); ctx.closePath();
  ctx.fillStyle = '#000'; ctx.fill();
  // crest line, brighter as wind builds
  ctx.beginPath();
  ys.forEach((y, i) => i === 0 ? ctx.moveTo(left, y) : ctx.lineTo(left + i * step, y));
  ctx.strokeStyle = `rgba(150,190,225,${(0.16 + wf * 0.22).toFixed(3)})`;
  ctx.lineWidth = 1; ctx.stroke();
  // whitecaps + downwind spray on the crests, scaling with wind (none when calm)
  if (wf > 0.2){
    const fa = clamp((wf - 0.2) * 1.4, 0, 1);
    for (let i = 1; i < ys.length - 1; i++){
      const y = ys[i];
      if (y < ys[i - 1] && y <= ys[i + 1]){                         // local crest peak (smaller y = higher)
        const x = i * step;
        const fw = 2 + wf * 3;
        ctx.fillStyle = `rgba(228,242,255,${(0.5 * fa).toFixed(3)})`;
        ctx.fillRect(roll > 0 ? left + x - 1 : left + x + 1 - fw, y - 0.6, fw, 1.4);   // foam streaks toward the blow
        if (fa > 0.4){                                              // spray flicking off downwind (deterministic)
          const n = 1 + Math.round(wf * 2);
          for (let j = 0; j < n; j++){
            const t2 = (fx.t * (1.4 + j * 0.3) + x * 0.7) % 1;
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
function drawNowLine(){
  const now = new Date(), hNow = now.getHours(), frac = now.getMinutes() / 60;
  const fc = fx.cells.find(c => c.di === 0 && c.h === hNow); if (!fc) return;
  const ctx = fx.ctx; ctx.save();
  ctx.strokeStyle = '#ff2b2b'; ctx.lineWidth = 2; ctx.shadowColor = 'rgba(255,43,43,.8)'; ctx.shadowBlur = 6;
  ctx.beginPath();
  if (orientation === 'p'){ const y = fc.y + frac * fc.hgt; ctx.moveTo(fc.x, y); ctx.lineTo(fc.x + fc.w, y); }
  else { const x = fc.x + frac * fc.w; ctx.moveTo(x, fc.y); ctx.lineTo(x, fc.y + fc.hgt); }
  ctx.stroke(); ctx.restore();
}
function frame(now){
  const dt = Math.min(0.05, (now - fx.last) / 1000 || 0);
  fx.last = now; fx.t = now / 1000;
  fx.ctx.clearRect(0, 0, fx.w, fx.h);
  for (const fc of fx.cells) drawCell(fc, dt);
  drawNowLine();
  fx.raf = requestAnimationFrame(frame);
}
function startFx(){
  cancelAnimationFrame(fx.raf); fx.raf = 0;
  if (!fx.cells.length){ fx.ctx?.clearRect(0, 0, fx.w, fx.h); return; }
  if (reduceMotion.matches){ fx.ctx.clearRect(0, 0, fx.w, fx.h); fx.t = 0; for (const fc of fx.cells) drawCell(fc, 0); drawNowLine(); return; }
  fx.last = performance.now(); fx.raf = requestAnimationFrame(frame);
}
document.addEventListener('visibilitychange', () => { if (document.hidden){ cancelAnimationFrame(fx.raf); fx.raf = 0; } else startFx(); });

/* ---------- Movable popups: drag to reposition; double-tap or long-press to reset ---------- */
function clampPopupPoint(el, x, y){
  const r = el.getBoundingClientRect(), m = 8;
  const halfW = Math.min(r.width / 2 || 0, Math.max(0, innerWidth / 2 - m));
  const halfH = Math.min(r.height / 2 || 0, Math.max(0, innerHeight / 2 - m));
  return { x: Math.max(m + halfW, Math.min(innerWidth - m - halfW, x)), y: Math.max(m + halfH, Math.min(innerHeight - m - halfH, y)) };
}
function setPopupPoint(el, x, y){ const p = clampPopupPoint(el, x, y); el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.transform = 'translate(-50%,-50%)'; }
function applyPopupPosition(kind, el){ const s = settings.popupPos?.[kind]; if (s) setPopupPoint(el, s.x * innerWidth, s.y * innerHeight); }
function resetPopupPosition(kind, el){ delete settings.popupPos[kind]; saveSettings(); el.style.left = el.style.top = el.style.right = el.style.bottom = el.style.transform = ''; }
function makeDraggablePopup(kind, el, afterDrag, beforeDrag){
  let drag = null, lastTap = 0, holdTimer = 0; const SLOP = 8, HOLD = 650;
  el.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return;
    beforeDrag?.();
    const r = el.getBoundingClientRect();
    drag = { sx: e.clientX, sy: e.clientY, dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2), moved: false, reset: false };
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { if (!drag || drag.moved) return; resetPopupPosition(kind, el); drag.reset = true; lastTap = 0; }, HOLD);
    el.classList.add('dragging'); el.setPointerCapture?.(e.pointerId); e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener('pointermove', e => {
    if (!drag) return;
    if (drag.reset){ e.preventDefault(); e.stopPropagation(); return; }
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > SLOP){ drag.moved = true; clearTimeout(holdTimer); }
    if (!drag.moved){ e.preventDefault(); e.stopPropagation(); return; }
    setPopupPoint(el, e.clientX - drag.dx, e.clientY - drag.dy); e.preventDefault(); e.stopPropagation();
  });
  function finish(e){
    if (!drag) return; clearTimeout(holdTimer);
    const now = performance.now(), dbl = !drag.moved && now - lastTap < 320;
    if (drag.reset){ /* already reset by long-press */ }
    else if (dbl) resetPopupPosition(kind, el);
    else { const r = el.getBoundingClientRect(); settings.popupPos[kind] = { x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight }; saveSettings(); }
    el.classList.remove('dragging'); el.releasePointerCapture?.(e.pointerId);
    const moved = drag.moved, reset = drag.reset; drag = null; lastTap = reset || dbl || moved ? 0 : now;
    afterDrag?.(moved); e.preventDefault(); e.stopPropagation();
  }
  el.addEventListener('pointerup', finish); el.addEventListener('pointercancel', finish);
  el.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
}

/* ---------- Grid gestures: tap → readout; horizontal swipe → cycle locations ---------- */
const tipEl = $('#tip'); let tipTimer = 0;
let gX = 0, gY = 0, swiped = false;
gridEl.addEventListener('pointerdown', e => { swiped = false; gX = e.clientX; gY = e.clientY; });
gridEl.addEventListener('pointerup', e => {
  const dx = e.clientX - gX, dy = e.clientY - gY, ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax > 55 && ax > ay * 1.4){ swiped = true; cycleLocation(dx < 0 ? 1 : -1); }
});
gridEl.addEventListener('click', e => {
  if (swiped){ swiped = false; return; }                       // a swipe is not a tap
  const c = e.target.closest('.cell'); if (!c || c.classList.contains('empty')) return;
  showTip(+c.dataset.di, +c.dataset.h);
});
document.addEventListener('click', e => { if (!e.target.closest('.cell') && !e.target.closest('.tip')) hideTip(); }, true);
function cycleLocation(dir){
  const count = settings.places.length + 1;                    // saved places + "my location"
  if (count <= 1) return;
  const cur = settings.activeIdx == null ? 0 : settings.activeIdx + 1;
  const next = (cur + dir + count) % count;
  switchTo(next === 0 ? null : next - 1);
}
function hideTip(){ tipEl.hidden = true; }
function showTip(di, h){
  const c = days[di]?.cells[h]; if (!c) return;
  const d = days[di];
  const bits = [`<b>${d.dow} ${fmtHourLong(h)}</b>`];
  if (c.tideFt != null){
    const arrow = c.rising == null ? '' : (c.rising ? `<span class="tide-rise">▲ rising</span>` : `<span class="tide-fall">▼ falling</span>`);
    bits.push(`· tide ${c.tideFt.toFixed(1)} ft ${arrow}`);
  }
  bits.push(`· wind ${Math.round(c.windMph)}${c.windDir != null ? ' ' + compass8(c.windDir) : ''} mph`);
  if ((c.precipMm || 0) > 0 || (c.snowCm || 0) > 0) bits.push(`· ${c.pop | 0}% ${c.snowCm > 0 ? 'snow' : 'rain'}`);
  bits.push(`· ${c.cloud | 0}% cloud`);
  if (c.tF != null) bits.push(`· ${Math.round(c.tF)}°`);
  const head = place.name && place.name !== '—' ? `<span class="tip-place">${place.name}</span>` : '';
  tipEl.innerHTML = head + bits.join(' ');
  tipEl.classList.toggle('top', orientation === 'p');
  const cellH = gridEl.querySelector('.cell:not(.empty)')?.getBoundingClientRect().height || 0;
  tipEl.style.setProperty('--tip-shift', Math.round(cellH) + 'px');
  tipEl.hidden = false;
  applyPopupPosition('tip', tipEl);                            // honor a saved dragged position
  clearTimeout(tipTimer); tipTimer = setTimeout(hideTip, 3600);
}
makeDraggablePopup('tip', tipEl, () => { clearTimeout(tipTimer); tipTimer = setTimeout(hideTip, 3600); }, () => clearTimeout(tipTimer));

/* ---------- Settings sheet ---------- */
const sheetEl = $('#settings');
function openSheet(){ syncSheet(); sheetEl.hidden = false; }
function closeSheet(){ sheetEl.hidden = true; }
sheetEl.addEventListener('click', e => { if (e.target.dataset.close !== undefined) closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sheetEl.hidden) closeSheet(); });
function syncSheet(){
  $('#placeName').textContent = place.name; $('#placeSub').textContent = place.sub || '';
  document.querySelectorAll('.seg').forEach(seg => { const v = String(settings[seg.dataset.setting]); seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.value === v)); });
  renderPlaceList();
}
document.querySelectorAll('.seg').forEach(seg => seg.addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  settings[seg.dataset.setting] = btn.dataset.value; saveSettings(); syncSheet(); render();
}));

/* ---------- Saved locations ---------- */
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
  settings.activeIdx = idx; saveSettings(); renderPlaceList();
  const p = idx != null ? settings.places[idx] : null;
  if (p?.test) loadTest();
  else if (p){ setPlace(p.name, p.admin || ''); load(p.lat, p.lon); }
  else { setPlace('Locating…', ''); locate(); }
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
function resetSearch(){ searchInput.value = ''; searchClear.hidden = true; closeResults(); }
async function runSearch(q){
  const seq = ++searchSeq; searchAbort?.abort(); searchAbort = new AbortController(); showMsg('Searching…');
  try { const res = await geocode(q, searchAbort.signal); if (seq !== searchSeq) return; if (!res.length) return showMsg('No matches'); renderHits(rankHits(res, q, lastCoords), q); }
  catch (err){ if (err.name === 'AbortError' || seq !== searchSeq) return; showMsg('Search error — try again'); }
}
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim(); searchClear.hidden = !searchInput.value; clearTimeout(searchTimer);
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

function addTestPlace(){ let i = settings.places.findIndex(p => p.test); if (i < 0) i = settings.places.push({ name: '🎣 Test conditions', test: true }) - 1; switchTo(i); }

/* ---------- Geolocation ---------- */
function locate(){
  if (!('geolocation' in navigator)){ setPlace('Location unavailable', 'Search in settings'); return; }
  navigator.geolocation.getCurrentPosition(
    pos => { setPlace('Current location', ''); load(pos.coords.latitude, pos.coords.longitude); reverseName(pos.coords.latitude, pos.coords.longitude); },
    () => setPlace('Location blocked', 'Search in settings ⚙'),
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 }
  );
}
async function reverseName(lat, lon){
  try { const j = await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10`)).json();
    const a = j.address || {}; const name = a.city || a.town || a.village || a.hamlet || a.county || j.name;
    if (name) setPlace(name, [a.state, (a.country_code || '').toUpperCase()].filter(Boolean).join(', ')); } catch {}
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
      hourly.weather_code.push(mm > 0.05 ? (snow > 0 ? 73 : 61) : 0);
      const wind = clamp(windBase + windGust * Math.max(0, Math.sin(h / 24 * 6.28)) + rand(-3, 3), 0, 48);
      hourly.wind_speed_10m.push(r1(wind)); hourly.wind_gusts_10m.push(r1(wind + rand(2, 12)));
      hourly.wind_direction_10m.push(Math.round(((dir0 + dirDrift * (h / 23) + rand(-15, 15)) % 360 + 360) % 360));
      hourly.is_day.push(h >= 6 && h <= 19 ? 1 : 0);
    }
  }
  return { hourly, utc_offset_seconds: -new Date().getTimezoneOffset() * 60 };
}

/* ---------- Resize ---------- */
let rT; addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(() => { (isPortrait() ? 'p' : 'l') !== orientation ? render() : layoutFx(); }, 120); });

/* ---------- Boot ---------- */
function boot(){
  days = placeholderDays(); render();             // instant, navigable UI (gear reachable) before data lands
  const active = settings.activeIdx != null ? settings.places[settings.activeIdx] : null;
  if (active?.test) return loadTest();
  if (active){ setPlace(active.name || 'Saved', active.admin || ''); return load(active.lat, active.lon); }
  setPlace('Locating…', ''); locate();
}
boot();

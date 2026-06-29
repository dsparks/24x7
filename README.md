# 24×7 and Ebb

Two mobile-first, installable weather views that put an entire week on one screen.
Both are framework-free static apps with no build step or API key.

## 24×7

`index.html` displays 168 hourly weather cells. Days run across the screen in
portrait; hours run across in landscape.

- Temperature uses the official NWS/NDFD palette or an optional Inferno palette.
- Animated rain, snow, fog, wind, heat shimmer, and lightning show expected conditions.
- Night shading, sunrise/sunset markers, and a live current-time line add context.
- Tap a cell for details; swipe horizontally between saved places.
- Swipe vertically between Temp / Rain and the customizable Run Index.
- Choose units, clock format, palette, and number visibility in Settings.
- Search and save multiple locations, or use the device's current location.
- Share the current grid as an image.

## Ebb

`ebb.html` is a companion fishing-conditions view. Its hourly ocean cutaway combines
sky, wind, precipitation, tide height and direction, chop, moonlight, and night stars.
It supports saved coastal locations, rolling or still water, cell details, and image
sharing. NOAA station predictions are used when available; a clearly labeled simulated
tide is the fallback and must not be used for navigation.

## Data and offline behavior

- [Open-Meteo](https://open-meteo.com/) provides global hourly forecasts.
- [NOAA Tides and Currents](https://tidesandcurrents.noaa.gov/) provides Ebb's US
  station predictions.
- OpenStreetMap Nominatim supplies friendly names for device coordinates.
- Forecasts are cached locally for instant repeat visits and offline fallback.
- `sw.js` caches both app shells. Each app has its own web manifest and can be installed
  as a full-screen PWA.

## Project layout

- `index.html`, `styles.css`, `app.js` — 24×7
- `ebb.html`, `ebb.css`, `ebb.js` — Ebb
- `shared.js`, `lightning.js` — shared browser utilities and effects
- `sw.js`, `manifest.json`, `ebb.webmanifest` — PWA support
- `fonts/`, `*.svg`, `html2canvas.min.js` — local assets and image sharing
- `bot/` — Node 22+ Bluesky mention bot and tests
- `BOT_SETUP.md` — bot deployment and configuration

## Running locally

Serve the repository with any static server:

```sh
npx serve .
```

Then open `/` for 24×7 or `/ebb.html` for Ebb. Device geolocation requires
`localhost` or HTTPS; city search remains available when location permission is denied.

The browser apps need no dependency installation. To work on the bot:

```sh
cd bot
npm install
npm test
```

## Release checklist

The service worker serves the app shell cache-first. Whenever any shipped HTML,
CSS, JavaScript, font, icon, or manifest changes, increment the `CACHE` name near
the top of `sw.js` before deploying. Without that bump, installed copies can
continue running the previous shell.

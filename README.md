# 24×7

Your week of weather, one screen.

A single-serving, mobile-first site: a **24×7 grid of hourly weather** fills the
entire screen with almost no UI chrome. Each square is color-coded by temperature
using the **official NWS/NDFD palette** (decoded from the graphical-forecast
legend). Precipitation is shown as an **animated overlay** whose opacity tracks the
*probability* of rain and whose density/speed tracks the *intensity* (misty →
drizzle → light → moderate → downpour, plus drifting snow).

- **Portrait:** days across the columns, hours down the rows.
- **Landscape:** swapped — hours across, days down.
- **Night hours are shaded**, with dashed sunrise (amber) / sunset (blue) markers.
- **A bright red line** marks the current time in today's column — it advances live,
  and the forecast auto-refreshes (every 15 min and on refocus).
- **Tap any square** for the exact time, temperature, rain chance, and intensity.
- **Long-press** the grid (or change palette) to flash a **color legend**.
- **Tap the gear** (where the row/column headers meet) for settings.

Installable as a **PWA**: add to home screen for a full-screen, offline-capable app
that paints the last forecast instantly (service worker + `manifest.json`).

No build step, no framework, no API key. Three static files — drop it on GitHub
Pages and go.

## Settings (saved locally)

- **View** — Temp / Rain (default) or **Run Index** (early stub; refined later).
  The Run Index view colors squares with the **Viridis** colormap.
- **Palette** — temperature view uses **NOAA** (default) or **Inferno**.
- **Units** — Auto (°F in the US, °C elsewhere), or force °F / °C.
- **Clock** — Auto, 12h, or 24h.
- **Numbers** — show/hide the temperature label (black, or white where it reads better).
- **Location** — use my location, or search any city.

## Data

[Open-Meteo](https://open-meteo.com/) — keyless, global, one request returns the
full 7-day hourly forecast (temperature, precip probability, apparent temp, wind,
humidity). The last response is cached in `localStorage` so repeat visits paint
instantly while a fresh forecast loads in the background.

## Running it

It's a static site. For the **auto-locate** feature, browsers require a secure
context, so serve it over `localhost` or `https` (e.g. GitHub Pages):

```sh
# any static server works, e.g.
npx serve .
```

Opening `index.html` directly via `file://` works too, but geolocation will be
blocked — use the search box in settings to pick a location instead.

## Renaming

The title lives in one place: the `APP_NAME` constant at the top of `app.js`
(alternatives considered: `hotmap`, `wgrid`).

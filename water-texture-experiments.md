# Ebb Underwater Wind-Texture Experiments

Saved after the seven-row comparison. The live direction is once again plain
black water below the animated surface; the experimental renderer remains
available in `ebb.js` but is not called.

## Goal

Add a second visual signal for wind strength below the waterline without
competing with tide height, weather, surface chop, foam, or Ebb's deliberately
quiet black-sea aesthetic.

The desired encoding was:

- Near-calm water should remain almost completely black.
- Stronger wind should increase texture amplitude, brightness, and potentially
  density or line weight.
- Underwater motion must travel in the same perceived direction as the surface
  waves.
- The effect must remain legible in narrow hourly cells and inexpensive across
  all 168 animated cells.

## Seven-Row Audition

We tried layered streaks, diagonal shear, suspended flecks, caustic ribbons,
depth bands, turbulent eddies, and speed dashes. Diagonal shear, suspended
flecks, and depth bands were rejected early. Later alternatives included
braided currents, gust rings, and crest shadows.

## Finalists

1. **Layered Streaks** — three gently moving horizontal layers. This was the
   favored shape because it reads as water, reinforces direction, and stays
   relatively calm.
2. **Caustic Ribbons** — brighter, thicker, higher-amplitude wavering light
   lines. These had the strongest visual pop.
3. **Speed Dashes** — discrete directional marks whose length increased with
   wind. Clear, but more diagrammatic than watery.

The preferred hybrid used Layered Streaks geometry with the Caustic Ribbons
encoding: cool-white `rgb(205,232,247)`, alpha based on
`0.04 + windEnergy² × 0.23` and multiplied by `1.15`, amplitude
`0.7 + windEnergy² × 2.2`, and line width `0.9 + windEnergy² × 0.7`.

We also tested wind-built ribbons where count increased from one to five along
with amplitude and brightness. It communicated intensity well but was not the
final preference.

## Current Direction

Use untextured black water. Surface-wave amplitude, crest light, whitecaps, and
spray remain the wind signals. If underwater texture returns, start with the
Layered Streaks / Caustic encoding hybrid and compare it against Caustic Ribbons
and Speed Dashes.

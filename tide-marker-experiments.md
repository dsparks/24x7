# Ebb Tide Marker Experiments

Saved for future reference after the seven-row sampler.

## Tried Concepts

- Gull/fish silhouette: low tide as a small white gull above the mean waterline; high tide as a small white fish below the waterline.
- Scene hairline: a very thin dashed vertical time marker rendered before weather and water, so the scene can obscure it.
- Tap locator: no always-on mark; tapping any cell in a day reveals all high/low turns for that day.
- Edge notch: a small top or bottom edge triangle, with high pointing upward and low pointing downward.
- Border segment: a small colored segment on the top edge for high tide or bottom edge for low tide.
- Minute hairline: a full-height dashed line with a short colored cap at the top or bottom.
- Dashed arrow: a 95%-height dashed line with an arrowhead; high points up, low points down.
- Flag experiment: a silver flagpole behind the water with a wind-responsive rectangular flag; abandoned because the physics felt too fussy at cell scale.
- Object experiment: exposed rocks/posts/crab at low tide and floating objects at high tide; abandoned because it competed with the waterline.

## Current Direction

The cleanest live direction is the tap locator: keep the grid quiet by default, then reveal all high/low tide turns for a tapped day. Each day can use its own high/low color pair while retaining the same interaction.

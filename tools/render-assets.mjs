#!/usr/bin/env node
/* Rasterizes the repo's SVG artwork into the PNGs referenced by the HTML:
 * social-card images (scrapers won't rasterize SVG or resolve relative URLs)
 * and apple-touch-icons (iOS ignores SVG there). Rerun after editing any SVG.
 *
 * Usage: node tools/render-assets.mjs   (needs bot/ deps: npm install in bot/)
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// playwright lives in bot/node_modules (the only npm tree in the repo)
const { chromium } = createRequire(join(root, 'bot', 'package.json'))('playwright');
const JOBS = [
  { svg: 'share-24x7.svg', png: 'share-24x7.png', width: 1200, height: 630 },
  { svg: 'share-ebb.svg', png: 'share-ebb.png', width: 1200, height: 630 },
  { svg: 'icon.svg', png: 'icon-24x7-180.png', width: 180, height: 180 },
  { svg: 'ebb.svg', png: 'icon-ebb-180.png', width: 180, height: 180 },
];

const browser = await chromium.launch();
try {
  for (const job of JOBS){
    const page = await browser.newPage({ viewport: { width: job.width, height: job.height } });
    // A page wrapping the SVG (rather than page.goto on the .svg) gives us exact
    // sizing control and a transparent backdrop for the icons.
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${job.width}px;height:${job.height}px}</style>${readFileSync(join(root, job.svg), 'utf8')}`);
    await page.screenshot({ path: join(root, job.png), omitBackground: true });
    await page.close();
    console.log(`${job.svg} -> ${job.png} (${job.width}x${job.height})`);
  }
} finally {
  await browser.close();
}

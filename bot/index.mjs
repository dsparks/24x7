import { AtpAgent, RichText } from '@atproto/api';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SITE_URL,
  gaveUpText,
  helpText,
  locationFromPost,
  missingPlaceText,
  pendingMentions,
  placeLabel,
  pruneState,
  replyRefs,
  replyRkey,
  replyText,
} from './lib.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SERVICE = process.env.BLUESKY_SERVICE_URL || 'https://bsky.social';
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function required(name){
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function geocode(query){
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.search = new URLSearchParams({
    name: query,
    count: '5',
    language: 'en',
    format: 'json',
  });
  const response = await fetch(url, {
    headers: { 'user-agent': '24x7-weather-bot/1.0 (dsparks.github.io/24x7)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Geocoding failed with HTTP ${response.status}`);
  const json = await response.json();
  return json.results?.[0] || null;
}

async function startStaticServer(){
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const file = resolve(ROOT, relative);
      if (file !== ROOT && !file.startsWith(ROOT + sep)) throw new Error('Invalid path');
      // Serve only app-shell file types; keeps .git/, docs, and configs unreachable.
      if (!MIME[extname(file)] || relative.split(/[\\/]/).some(part => part.startsWith('.'))) throw new Error('Not served');
      const bytes = await readFile(file);
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': MIME[extname(file)] || 'application/octet-stream',
      });
      response.end(bytes);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise(resolveClose => server.close(resolveClose)),
  };
}

class Renderer {
  async open(){
    this.server = await startStaticServer();
    this.browser = await chromium.launch({ headless: true });
  }

  async close(){
    await this.browser?.close();
    await this.server?.close();
  }

  async capture(place){
    const page = await this.browser.newPage({
      viewport: { width: 720, height: 1280 },
      deviceScaleFactor: 1,
      locale: 'en-US',
      reducedMotion: 'reduce',
    });
    const url = new URL(this.server.baseUrl);
    url.search = new URLSearchParams({
      bot: '1',
      lat: String(place.latitude),
      lon: String(place.longitude),
      label: placeLabel(place),
    });
    try {
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(
        () => ['ready', 'error'].includes(window.__24x7Bot?.status),
        null,
        { timeout: 30000 },
      );
      const state = await page.evaluate(() => window.__24x7Bot);
      if (state.status !== 'ready') throw new Error(state.message || 'The weather render failed');
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(150);
      const image = await page.screenshot({
        type: 'jpeg',
        quality: 91,
        fullPage: false,
      });
      if (image.byteLength > 950000) throw new Error(`Screenshot is too large (${image.byteLength} bytes)`);
      return { image, state };
    } finally {
      await page.close();
    }
  }
}

async function richRecord(agent, text, notification, embed){
  const richText = new RichText({ text });
  await richText.detectFacets(agent);
  const record = {
    $type: 'app.bsky.feed.post',
    text: richText.text,
    facets: richText.facets,
    reply: replyRefs(notification),
    createdAt: new Date().toISOString(),
  };
  if (embed) record.embed = embed;
  return record;
}

function alreadyExists(error){
  const text = [error?.error, error?.message, error?.cause?.message].filter(Boolean).join(' ');
  return /already exists|recordalreadyexists/i.test(text);
}

async function createReply(agent, notification, text, embed){
  const record = await richRecord(agent, text, notification, embed);
  try {
    await agent.com.atproto.repo.createRecord({
      repo: agent.session.did,
      collection: 'app.bsky.feed.post',
      rkey: replyRkey(notification),
      record,
    });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    console.log(`Reply already exists for ${notification.uri}; treating it as complete.`);
  }
}

async function uploadScreenshot(agent, image, alt){
  const upload = await agent.uploadBlob(image, { encoding: 'image/jpeg' });
  return {
    $type: 'app.bsky.embed.images',
    images: [{
      alt,
      image: upload.data.blob,
      aspectRatio: { width: 720, height: 1280 },
    }],
  };
}

/* ---------- Durable per-mention state ----------
 * Persisted across runs (actions/cache in CI). This — not Bluesky's isRead —
 * decides what still needs work, so one failing mention can't wedge the queue
 * (retry cap) and a >100-notification backlog can't silently drop mentions
 * (cursor pagination + our own dedup). */
const STATE_FILE = process.env.BOT_STATE_FILE || fileURLToPath(new URL('state.json', import.meta.url));
const MAX_ATTEMPTS = 3;
const LOOKBACK_MS = 3 * 86400000;
const MAX_PAGES = 5;

async function readState(){
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch { return { mentions: {} }; }
}
async function writeState(state){
  await writeFile(STATE_FILE, JSON.stringify(pruneState(state), null, 1));
}

/* All mention notifications inside the lookback window, cursor-paginated so a
 * backlog deeper than one page is still fully visible. */
async function listRecentMentions(agent){
  const out = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++){
    const response = await agent.app.bsky.notification.listNotifications({ limit: 100, reasons: ['mention'], cursor });
    const items = response.data.notifications || [];
    out.push(...items);
    cursor = response.data.cursor;
    const oldest = items[items.length - 1];
    if (!cursor || !items.length || (oldest && Date.now() - new Date(oldest.indexedAt) > LOOKBACK_MS)) break;
  }
  return out;
}

async function dryRun(query){
  const place = await geocode(query);
  if (!place) throw new Error(`No geocoding result for "${query}"`);
  const renderer = new Renderer();
  await renderer.open();
  try {
    const { image, state } = await renderer.capture(place);
    const output = process.env.BOT_DRY_RUN_OUTPUT || 'bot-output.jpg';
    await writeFile(output, image);
    console.log(`Rendered ${placeLabel(place)} to ${output}`);
    console.log(`Alt-text summary: ${state.summary}`);
  } finally {
    await renderer.close();
  }
}

async function runBot(){
  const agent = new AtpAgent({ service: SERVICE });
  await agent.login({
    identifier: required('BLUESKY_IDENTIFIER'),
    password: required('BLUESKY_APP_PASSWORD'),
  });

  const state = await readState();
  const notifications = await listRecentMentions(agent);
  const mentions = pendingMentions(notifications, state, {
    botDid: agent.session.did,
    maxAttempts: MAX_ATTEMPTS,
    lookbackMs: LOOKBACK_MS,
  });

  if (!mentions.length){
    console.log('No pending mentions.');
    return;
  }

  const renderer = new Renderer();
  await renderer.open();
  try {
    for (const notification of mentions){
      const entry = state.mentions[notification.uri] ||= { attempts: 0 };
      entry.attempts++;
      entry.lastAt = new Date().toISOString();
      const query = locationFromPost(notification.record?.text);
      try {
        if (!query){
          await createReply(agent, notification, helpText(agent.session.handle));
        } else {
          const place = await geocode(query);
          if (!place){
            await createReply(agent, notification, missingPlaceText(query));
          } else {
            const label = placeLabel(place);
            const { image, state: renderState } = await renderer.capture(place);
            const alt = `24x7 seven-day hourly weather grid for ${label}. Daily Fahrenheit ranges: ${renderState.summary}.`;
            const embed = await uploadScreenshot(agent, image, alt);
            await createReply(agent, notification, replyText(label), embed);
            console.log(`Replied to ${notification.uri} with ${label}. ${SITE_URL}`);
          }
        }
        entry.status = 'done';
      } catch (error) {
        // Move on to the next mention — one bad mention must not block the queue.
        console.error(`Could not process ${notification.uri} (attempt ${entry.attempts}/${MAX_ATTEMPTS}):`, error);
        if (entry.attempts >= MAX_ATTEMPTS){
          entry.status = 'gave-up';
          try { await createReply(agent, notification, gaveUpText(query)); }
          catch (replyError) { console.error(`Could not send the give-up reply for ${notification.uri}:`, replyError); }
        }
      }
      await writeState(state);          // after every mention, so a crash loses nothing
    }
  } finally {
    await renderer.close();
    // Clear the notification bell. Safe to be coarse: state.json (not isRead)
    // decides what still needs work on the next run.
    await agent.app.bsky.notification.updateSeen({ seenAt: new Date().toISOString() }).catch(() => {});
  }
}

const dryRunLocation = process.env.BOT_DRY_RUN_LOCATION?.trim();
if (dryRunLocation) await dryRun(dryRunLocation);
else await runBot();

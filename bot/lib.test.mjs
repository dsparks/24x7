import test from 'node:test';
import assert from 'node:assert/strict';
import {
  locationFromPost,
  pendingMentions,
  placeLabel,
  postRkey,
  pruneState,
  replyRefs,
  replyRkey,
} from './lib.mjs';

test('extracts a location after a mention', () => {
  assert.equal(locationFromPost('@24x7weather.bsky.social Boston, MA'), 'Boston, MA');
  assert.equal(locationFromPost('weather for @24x7weather.bsky.social London, UK'), 'London, UK');
});

test('removes links and command punctuation', () => {
  assert.equal(locationFromPost('@bot.example: forecast in Paris https://example.com'), 'Paris');
});

test('builds a concise geocoder label', () => {
  assert.equal(placeLabel({ name: 'Boston', admin1: 'Massachusetts', country_code: 'us' }), 'Boston, Massachusetts, US');
});

test('reuses the mentioned post rkey and reply root', () => {
  const root = { uri: 'at://did:plc:a/app.bsky.feed.post/root', cid: 'root-cid' };
  const notification = {
    uri: 'at://did:plc:b/app.bsky.feed.post/3abc',
    cid: 'parent-cid',
    record: { reply: { root } },
  };
  assert.equal(postRkey(notification.uri), '3abc');
  assert.deepEqual(replyRefs(notification), {
    parent: { uri: notification.uri, cid: notification.cid },
    root,
  });
});

test('reply rkey is stable per mention and distinct across authors', () => {
  const a = { uri: 'at://did:plc:a/app.bsky.feed.post/3abc', author: { did: 'did:plc:a' } };
  const b = { uri: 'at://did:plc:b/app.bsky.feed.post/3abc', author: { did: 'did:plc:b' } };
  assert.equal(replyRkey(a), replyRkey(a));
  assert.notEqual(replyRkey(a), replyRkey(b));
  assert.match(replyRkey(a), /^3abc-[a-z0-9]+$/);
});

test('pending mentions respect state, retry cap, and lookback', () => {
  const now = Date.parse('2026-07-01T12:00:00Z');
  const at = hoursAgo => new Date(now - hoursAgo * 3600000).toISOString();
  const mention = (uri, indexedAt) => ({ uri, reason: 'mention', indexedAt, author: { did: 'did:plc:user' } });
  const items = [
    mention('at://a', at(1)),
    mention('at://done', at(2)),
    mention('at://failing', at(3)),
    mention('at://exhausted', at(4)),
    mention('at://stale', at(100)),
    { ...mention('at://self', at(1)), author: { did: 'did:plc:bot' } },
  ];
  const state = { mentions: {
    'at://done': { status: 'done', attempts: 1 },
    'at://failing': { attempts: 1 },
    'at://exhausted': { attempts: 3 },
  } };
  const pending = pendingMentions(items, state, { botDid: 'did:plc:bot', now });
  // done/exhausted/stale/self excluded; survivors oldest first
  assert.deepEqual(pending.map(n => n.uri), ['at://failing', 'at://a']);
});

test('prune drops state entries past the retention window', () => {
  const now = Date.parse('2026-07-01T12:00:00Z');
  const state = { mentions: {
    'at://fresh': { status: 'done', lastAt: new Date(now - 86400000).toISOString() },
    'at://old': { status: 'done', lastAt: new Date(now - 20 * 86400000).toISOString() },
    'at://undated': { status: 'done' },
  } };
  assert.deepEqual(Object.keys(pruneState(state, { now }).mentions), ['at://fresh']);
});

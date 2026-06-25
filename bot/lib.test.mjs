import test from 'node:test';
import assert from 'node:assert/strict';
import {
  locationFromPost,
  placeLabel,
  postRkey,
  replyRefs,
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

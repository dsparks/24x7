export const SITE_URL = 'https://dsparks.github.io/24x7/';

export function locationFromPost(text){
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@[a-z0-9.-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:,-]+|[\s:,-]+$/g, '')
    .replace(/^\s*(?:weather|forecast)\s*(?:(?:for|in|at)\s+)?/i, '')
    .replace(/^\s*(?:for|in|at)\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:,-]+|[\s:,-]+$/g, '')
    .trim();
}

export function placeLabel(result){
  return [result?.name, result?.admin1, result?.country_code?.toUpperCase()]
    .filter(Boolean)
    .filter((part, i, all) => all.indexOf(part) === i)
    .join(', ');
}

export function postRkey(uri){
  const rkey = String(uri || '').split('/').pop();
  if (!rkey) throw new Error(`Could not find a record key in ${uri}`);
  return rkey;
}

/* Deterministic rkey for our reply, unique per (author, post). Using the
 * mentioned post's rkey alone can collide: TIDs are only unique per-repo, so
 * two different authors' posts may share one. Suffix a short FNV-1a hash of
 * the author DID; stays idempotent across retries, valid rkey charset. */
export function replyRkey(notification){
  const did = String(notification?.author?.did || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < did.length; i++){
    h ^= did.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${postRkey(notification.uri)}-${h.toString(36)}`;
}

export function replyRefs(notification){
  const parent = { uri: notification.uri, cid: notification.cid };
  return {
    parent,
    root: notification.record?.reply?.root || parent,
  };
}

export function replyText(label){
  return `${label} - the next seven days.\n\nOpen 24x7: ${SITE_URL}`;
}

export function helpText(handle){
  return `Mention me with a city or place, for example: @${handle} Boston, MA\n\n${SITE_URL}`;
}

export function missingPlaceText(query){
  return `I couldn't find "${query}". Try a city plus state, province, or country.\n\n${SITE_URL}`;
}

export function gaveUpText(query){
  return query
    ? `Sorry - I couldn't render a forecast for "${query}" after a few tries. You can browse it directly: ${SITE_URL}`
    : `Sorry - I couldn't process that mention after a few tries. ${SITE_URL}`;
}

/* Which unread work remains? State is the source of truth (not isRead —
 * updateSeen timestamps are coarse and can flip unprocessed mentions to read).
 * Returns mentions inside the lookback window that aren't done and haven't
 * exhausted their attempts, oldest first. */
export function pendingMentions(notifications, state, { botDid, maxAttempts = 3, lookbackMs = 3 * 86400000, now = Date.now() } = {}){
  const seen = new Set();
  return notifications
    .filter(n => n && n.reason === 'mention' && n.author?.did !== botDid)
    .filter(n => now - new Date(n.indexedAt) <= lookbackMs)
    .filter(n => {
      const entry = state.mentions?.[n.uri];
      return !entry || (entry.status !== 'done' && (entry.attempts || 0) < maxAttempts);
    })
    .filter(n => !seen.has(n.uri) && seen.add(n.uri))
    .sort((a, b) => new Date(a.indexedAt) - new Date(b.indexedAt));
}

/* Drop state entries old enough that their mentions have left the lookback
 * window; keeps the cached file from growing forever. */
export function pruneState(state, { maxAgeMs = 14 * 86400000, now = Date.now() } = {}){
  const mentions = {};
  for (const [uri, entry] of Object.entries(state.mentions || {})){
    if (entry?.lastAt && now - new Date(entry.lastAt) <= maxAgeMs) mentions[uri] = entry;
  }
  return { ...state, mentions };
}

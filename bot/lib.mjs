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

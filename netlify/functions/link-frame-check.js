// Public: tells the page whether a news article's site allows itself to be shown inside AVA's reading panel.
// Many sites forbid being framed; for those the panel shows AVA's summary and a button to open the site instead.
// Only addresses that are stored as published AVA news sources can be checked, so this cannot be used to probe other sites.
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
const OUR_ORIGINS = ['https://askvincy.com', 'https://www.askvincy.com'];
const CACHE_MS = 12 * 3600 * 1000;
const SHORT_MS = 10 * 60 * 1000;   // a failed check (timeout, block page) is remembered only briefly
const hostCache = new Map();   // host -> { at, ttl, embeddable }

const reply = (code, obj, extra) => ({ statusCode: code, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS, extra || {}), body: JSON.stringify(obj) });

// True when the response headers allow this page to be framed by askvincy.com.
function framingAllowed(headers) {
  const xfo = String(headers.get('x-frame-options') || '').trim().toLowerCase();
  if (xfo) return false;            // deny, sameorigin and allow-from all rule AVA out
  const csp = String(headers.get('content-security-policy') || '');
  const m = csp.match(/(?:^|;)\s*frame-ancestors\s+([^;]*)/i);
  if (m) {
    const tokens = m[1].trim().toLowerCase().split(/\s+/);
    if (tokens.includes("'none'")) return false;
    const ok = tokens.some(t => t === '*' || t === 'https:' || OUR_ORIGINS.includes(t) || t === 'https://*.askvincy.com');
    if (!ok) return false;
  }
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return reply(405, { error: 'GET only' });
  const raw = String((event.queryStringParameters && event.queryStringParameters.url) || '');
  let u;
  try { u = new URL(raw); } catch (e) { return reply(400, { error: 'Bad address.' }); }
  if (u.protocol !== 'https:') return reply(200, { embeddable: false, reason: 'not-https' }, { 'Cache-Control': 'public, max-age=3600' });

  const known = await supabase.from('knowledge_articles').select('id').eq('source_url', raw).eq('review_status', 'published').limit(1);
  if (!known.data || !known.data.length) return reply(404, { error: 'Unknown article.' });

  const hit = hostCache.get(u.host);
  if (hit && Date.now() - hit.at < hit.ttl) return reply(200, { embeddable: hit.embeddable, cached: true }, { 'Cache-Control': 'public, max-age=3600' });

  let embeddable = false;
  let definite = false;   // true only when the site answered normally, so its headers can be trusted for a long time
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(raw, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AVA link check; +https://askvincy.com)' } });
    definite = res.ok;
    embeddable = res.ok && framingAllowed(res.headers) && String(res.url || raw).startsWith('https://');
    try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (e) {}
  } catch (e) {
    embeddable = false;
  } finally { clearTimeout(timer); }

  hostCache.set(u.host, { at: Date.now(), ttl: definite ? CACHE_MS : SHORT_MS, embeddable });
  return reply(200, { embeddable }, { 'Cache-Control': 'public, max-age=3600' });
};

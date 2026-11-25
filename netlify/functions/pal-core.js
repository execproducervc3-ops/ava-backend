// Shared by the Pal Monitor (admin-monitor), AVA's watch (watch-run) and the watch Telegram bot.
// Reads each product's look-only monitor feed (counts and health only: no customer names, no money).
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const MODEL = 'claude-sonnet-5-5';

const FEEDS = {
  ep: { name: 'Event Pal', url: 'https://ogklumjigwdhlcfbllsv.supabase.co/functions/v1/monitor-feed' },
  rp: { name: 'Restaurant Pal', url: 'https://qpctzuwveswsstzhjrfn.supabase.co/functions/v1/monitor-feed' },
  tp: { name: 'Travel Pal', url: 'https://gtxmvazfuetokwyevxim.supabase.co/functions/v1/monitor-feed' },
};
// Sites checked from here. Restaurant Pal's address can be set with RP_SITE_URL in Netlify.
const SITES = [
  { key: 'rally', product: 'ep', name: 'Rally and Sports site (GitHub Pages)', url: 'https://execproducervc3-ops.github.io/ndp-rally/' },
  { key: 'rp', product: 'rp', name: 'Restaurant Pal site', url: process.env.RP_SITE_URL || '' },
  { key: 'tp', product: 'tp', name: 'travelpal784.netlify.app', url: 'https://travelpal784.netlify.app/' },
];

async function checkAuth(pw) {
  const { data } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  const hash = data ? data.password_hash : null;
  return !!(hash && pw && await bcrypt.compare(pw, hash));
}

async function timed(url, opts = {}, ms = 6000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms); const t0 = Date.now();
  try { const r = await fetch(url, { ...opts, signal: ctl.signal }); return { r, ms: Date.now() - t0 }; }
  finally { clearTimeout(t); }
}

async function feed(id) {
  const key = process.env.MONITOR_KEY;
  if (!key) return { ok: false, error: 'MONITOR_KEY not set in Netlify yet' };
  try {
    const { r, ms } = await timed(FEEDS[id].url, { headers: { 'x-monitor-key': key } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j.error || ('answered ' + r.status), status: r.status, ms };
    return { ok: true, ms, data: j.snapshot };
  } catch (e) { return { ok: false, error: e.name === 'AbortError' ? 'no answer in 6 s' : e.message }; }
}

async function site(s, ms = 6000) {
  if (!s.url) return { ...s, ok: null, note: 'address not set' };
  try { const { r, ms: took } = await timed(s.url, { method: 'GET', redirect: 'follow' }, ms); return { ...s, ok: r.ok, status: r.status, ms: took }; }
  catch (e) { return { ...s, ok: false, note: e.name === 'AbortError' ? 'no answer in ' + Math.round(ms / 1000) + ' s' : e.message }; }
}

async function avaUsage() {
  try {
    const { data, error } = await supabase.rpc('usage_summary');
    if (error) throw error;
    const w = (data && data.windows) || {}; const n = v => Number(v || 0);
    return { ok: true, questions_today: n(w.q_today), visitors_today: n(w.v_today), unanswered_today: n(w.fail_today), questions_week: n(w.q_week),
      tools_top: ((data && data.tools) || []).slice(0, 6).map(t => ({ tool: t.tool, uses: n(t.uses) })) };
  } catch (e) { return { ok: false, error: e.message }; }
}

const ago = (iso, now = Date.now()) => iso ? (now - Date.parse(iso)) / 1000 : Infinity;

// Plain warnings for the monitor's warning strip (the watch does its own, deeper checks).
function warnings(s) {
  const out = [];
  const add = (product, text, level = 'warn') => out.push({ product, text, level });
  for (const id of Object.keys(FEEDS)) if (!s[id].ok) add(id, `Can't read ${FEEDS[id].name}: ${s[id].error}`);
  for (const x of s.sites) if (x.ok === false) add(x.product, `${x.name} isn't answering (${x.note || 'error ' + x.status})`, 'down');
  const rp = s.rp.ok ? s.rp.data : null;
  if (rp) for (const b of rp.businesses || []) {
    if (b.open_tabs > 0 && b.tills > 0 && ago(b.till_seen) > 300) add('rp', `${b.name}: the till hasn't checked in for ${Math.round(ago(b.till_seen) / 60)} min, with ${b.open_tabs} open bill(s)`);
    if (b.guest_waiting > 0) add('rp', `${b.name}: ${b.guest_waiting} guest order(s) waiting to be accepted`);
    if (b.late_lines > 0) add('rp', `${b.name}: ${b.late_lines} kitchen item(s) late (over 25 min)`);
  }
  const tp = s.tp.ok ? s.tp.data : null;
  if (tp) {
    if (tp.reports_today && tp.reports_today.stuck > 0) add('tp', `${tp.reports_today.stuck} Coast Guard / company report(s) not sent after 15 min`);
    for (const v of tp.active || []) if (v.status === 'underway' && (!v.pos || ago(v.pos.at) > 600)) add('tp', `${v.vessel} is underway but hasn't sent a position for ${v.pos ? Math.round(ago(v.pos.at) / 60) + ' min' : 'this trip'}`);
  }
  const ep = s.ep.ok ? s.ep.data : null;
  if (ep) {
    const live = (ep.screens || []).filter(x => ago(x.last_seen) < 60);
    const dropped = (ep.screens || []).filter(x => ago(x.last_seen) >= 60 && ago(x.last_seen) < 3600);
    for (const x of dropped) if (live.length) add('ep', `Big screen ${x.out} (${x.name}) dropped off ${Math.round(ago(x.last_seen) / 60)} min ago`);
    const pending = (ep.photos && ep.photos.pending) || 0;
    if (pending >= 10) add('ep', `${pending} rally photos waiting for approval`);
  }
  if (s.ava.ok && s.ava.questions_today >= 10 && s.ava.unanswered_today / s.ava.questions_today > 0.1)
    add('ava', `AVA couldn't answer ${s.ava.unanswered_today} of ${s.ava.questions_today} questions today`);
  return out;
}

let cache = null;
async function snapshot(maxAgeMs = 10000) {
  if (cache && Date.now() - cache.t < maxAgeMs) return cache.s;
  const [ep, rp, tp, ava, ...sites] = await Promise.all([feed('ep'), feed('rp'), feed('tp'), avaUsage(), ...SITES.map(x => site(x))]);
  const s = { at: new Date().toISOString(), ep, rp, tp, ava, sites };
  s.warnings = warnings(s);
  cache = { t: Date.now(), s };
  return s;
}

// One call to Claude. Returns the text, or throws.
async function claude(system, user, { maxTokens = 500, ms = 25000 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('no ANTHROPIC_API_KEY');
  const { r } = await timed('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  }, ms);
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'AVA error ' + r.status);
  return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
}

const MONITOR_NOTES = [
  'Notes: Restaurant Pal "tills" counts registered tills; "devices" lists each till with its station and when it last checked in; "app_seen" is the last time any Restaurant Pal screen was open there.',
  'Event Pal screens are live if seen in the last minute. Travel Pal "active" lists ferries boarding or at sea, with passengers aboard as a count.',
  'Event Pal Boxes report in every 30 s; a box that has gone quiet for over 90 s is treated as down.',
].join('\n');

module.exports = { supabase, MODEL, FEEDS, SITES, checkAuth, timed, feed, site, avaUsage, ago, warnings, snapshot, claude, MONITOR_NOTES };

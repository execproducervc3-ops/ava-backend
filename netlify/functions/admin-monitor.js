// Admin API: Pal Monitor. One look-only snapshot across Event Pal, Restaurant Pal, Travel Pal and AVA,
// plus "Ask AVA" about it. Same admin password as the rest of the admin (X-Admin-Secret).
//
// Each product's Supabase project has a read-only "monitor-feed" function that returns counts and
// health only (no customer names, no money). They all check one shared key: MONITOR_KEY, set in
// Netlify (here) and as a function secret in each of the three Supabase projects.
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-5-5';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (statusCode, obj) => ({ statusCode, headers: { ...CORS, 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

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
    if (!r.ok) return { ok: false, error: j.error || ('answered ' + r.status), ms };
    return { ok: true, ms, data: j.snapshot };
  } catch (e) { return { ok: false, error: e.name === 'AbortError' ? 'no answer in 6 s' : e.message }; }
}

async function site(s) {
  if (!s.url) return { ...s, ok: null, note: 'address not set' };
  try { const { r, ms } = await timed(s.url, { method: 'GET', redirect: 'follow' }); return { ...s, ok: r.ok, status: r.status, ms }; }
  catch (e) { return { ...s, ok: false, note: e.name === 'AbortError' ? 'no answer in 6 s' : e.message }; }
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

const ago = iso => iso ? (Date.now() - Date.parse(iso)) / 1000 : Infinity;

// Turn the raw numbers into plain warnings.
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
async function snapshot() {
  if (cache && Date.now() - cache.t < 10000) return cache.s;
  const [ep, rp, tp, ava, ...sites] = await Promise.all([feed('ep'), feed('rp'), feed('tp'), avaUsage(), ...SITES.map(site)]);
  const s = { at: new Date().toISOString(), ep, rp, tp, ava, sites };
  s.warnings = warnings(s);
  cache = { t: Date.now(), s };
  return s;
}

async function ask(question, snap, extra) {
  if (!ANTHROPIC_KEY) return 'AVA isn\'t set up to answer here (no ANTHROPIC_API_KEY).';
  const system = [
    'You are AVA, looking at the Pal Monitor for Rohan, who runs Event Pal (live events, sports graphics, NDI boxes), Restaurant Pal (restaurant tills) and Travel Pal (ferry manifests), plus AVA itself.',
    'Answer only from the snapshot below. It holds counts and health only: no customer names and no money. If something isn\'t in it, say you can\'t see that from the monitor yet.',
    'Be brief and plain: a few short sentences, most important first. Say what needs attention and the simplest next step. Times are in St Vincent time (UTC-4). Don\'t invent numbers.',
    'Notes: Restaurant Pal "tills" counts registered tills; "app_seen" is the last time any Restaurant Pal screen was open there. Event Pal screens are live if seen in the last minute. Travel Pal "active" lists ferries boarding or at sea, with passengers aboard as a count.',
  ].join('\n');
  const user = `Snapshot (${snap.at}):\n${JSON.stringify({ ...snap, box: extra || undefined })}\n\nQuestion: ${question}`;
  const { r } = await timed('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, system, messages: [{ role: 'user', content: user }] }),
  }, 25000);
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'AVA error ' + r.status);
  return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const h = event.headers || {};
  if (!(await checkAuth(h['x-admin-secret'] || h['X-Admin-Secret']))) return json(401, { error: 'Unauthorized' });
  const action = (event.queryStringParameters || {}).action || 'snapshot';
  try {
    if (event.httpMethod === 'GET' && action === 'snapshot') return json(200, await snapshot());
    if (event.httpMethod === 'POST' && action === 'ask') {
      const body = JSON.parse(event.body || '{}');
      const q = String(body.question || '').slice(0, 500).trim() ||
        'Give me a short briefing: overall state, anything that needs me now, and one line per product.';
      // the page adds what it can see of the local Event Pal Box (it isn't reachable from here)
      const b = body.box && typeof body.box === 'object' ? body.box : null;
      const box = b ? { box: String(b.box || '').slice(0, 60), ndi: !!b.ndi, sources: (Array.isArray(b.sources) ? b.sources : []).slice(0, 8).map(x => ({
        name: String(x.name || '').slice(0, 40), size: String(x.size || '').slice(0, 12), fps: Number(x.fps) || 0, state: String(x.state || '').slice(0, 12),
        sendingFps: Number(x.sendingFps) || 0, receivers: Number(x.receivers) || 0 })) } : null;
      const snap = await snapshot();
      return json(200, { answer: await ask(q, snap, box), at: snap.at });
    }
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('admin-monitor error:', e);
    return json(500, { error: e.message });
  }
};

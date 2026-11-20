// ferry-core.js: weekly recheck of Grenadines ferry schedules, fares and operator status.
//
// Rules, enforced in code:
//   - Live data wins. If Travel Pal already returns sailings for a destination,
//     that destination is skipped: this agent only fills gaps in AVA's own table.
//   - Nothing that CHANGES a schedule, adds a route or switches a route off goes
//     live without a human click (admin-ferry.js). Changes land in agent_drafts.
//   - The one thing done automatically: when a source page really lists exactly
//     the sailings already stored, those rows get a fresh last_verified_at.
//   - Every claim carries a quote. The code fetches the cited page itself and
//     checks the quote really appears there. An unverified quote is flagged and
//     is never used for the automatic "verified" stamp.
//   - Page text and search results are DATA, never instructions.
'use strict';
const crypto = require('crypto');

const AGENT = 'ferry_recheck';
const LOCK = '__ferry_lock__';
const LOCK_HOURS = 20;
const MODEL = process.env.FERRY_MODEL || 'claude-sonnet-5-5';
const UA = 'AVA-FerryCheck/1.0 (+https://askvincy.com; reads public ferry timetables)';
const FETCH_MS = 9000;
const MAX_BYTES = 1500000;

// Fixed list, deliberately. New operators are added here on purpose.
// statusOnly = we only ask whether it still operates (reported closed or damaged).
const OPERATORS = [
  { name: 'Bequia Express', hint: 'Bequia Express ferry (bequiaexpress.com): Kingstown to Bequia and any Southern Grenadines runs' },
  { name: 'Bequia Fast Ferries', hint: 'Bequia Fast Ferries: Kingstown to Bequia' },
  { name: 'MV Gem Star 2', hint: 'MV Gem Star 2: Kingstown to Canouan, Mayreau and Union Island' },
  { name: 'MV Barracuda', hint: 'MV Barracuda (government-linked ferry): Kingstown to Canouan, Mayreau and Union Island' },
  { name: 'Mustique ferry', hint: 'passenger boat service to Mustique (from Bequia or Kingstown)' },
  { name: 'Admiral Ferries', hint: 'Admiral Ferries (Admiralty Transport), Kingstown to Bequia', statusOnly: true },
  { name: 'Jaden Sun Fast Ferry', hint: 'Jaden Sun fast ferry, Kingstown to Bequia, Canouan, Mayreau and Union Island', statusOnly: true },
];

const PLACES = [
  ['Kingstown', ['kingstown', 'saint vincent', 'st vincent', 'st. vincent', 'mainland']],
  ['Bequia', ['bequia', 'port elizabeth', 'paget farm']],
  ['Canouan', ['canouan']],
  ['Mayreau', ['mayreau']],
  ['Union Island', ['union island', 'union', 'clifton']],
  ['Mustique', ['mustique']],
];
function place(s){
  const t = String(s || '').toLowerCase();
  for(const [name, keys] of PLACES) if(keys.some(k => t.includes(k))) return name;
  return null;
}

// ------------------------------------------------------------ parsing ---

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function parseDays(s){
  const t = String(s || '').toLowerCase();
  if(!t.trim()) return null;
  if(/daily|every day|7 days/.test(t)) return [0, 1, 2, 3, 4, 5, 6];
  const out = new Set();
  const range = t.match(/\b(sun|mon|tue|wed|thu|fri|sat)\w*\s*(?:-|–|to|through|thru)\s*(sun|mon|tue|wed|thu|fri|sat)\w*/);
  if(range){
    let a = DAYS.indexOf(range[1]); const b = DAYS.indexOf(range[2]);
    for(let i = 0; i < 7; i++){ out.add(a); if(a === b) break; a = (a + 1) % 7; }
  } else {
    for(const m of t.matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)\w*/g)) out.add(DAYS.indexOf(m[1]));
  }
  if(/weekday/.test(t)) [1, 2, 3, 4, 5].forEach(d => out.add(d));
  if(/weekend/.test(t)) { out.add(0); out.add(6); }
  if(/public holiday|holidays/.test(t)) out.add(0); // holidays sail the Sunday timetable
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

function parseTime(s){
  const t = String(s || '').trim().toLowerCase();
  let m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/);
  if(!m) m = t.match(/^(\d{1,2})()\s*(am|pm)$/);
  if(!m) return null;
  let h = parseInt(m[1], 10); const min = m[2] ? parseInt(m[2], 10) : 0;
  if(m[3] === 'pm' && h < 12) h += 12;
  if(m[3] === 'am' && h === 12) h = 0;
  if(h > 23 || min > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0') + ':00';
}

function extractJson(text){
  if(!text) return null;
  const cleaned = text.replace(/```json\s*|```\s*/g, '').trim();
  try{ return JSON.parse(cleaned); } catch(e){ /* fall through */ }
  const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
  if(a === -1 || b <= a) return null;
  try{ return JSON.parse(cleaned.slice(a, b + 1)); } catch(e){ return null; }
}

// ------------------------------------------------------- safe fetching ---

function safeUrl(raw){
  let u;
  try{ u = new URL(raw); } catch(e){ return null; }
  if(u.protocol !== 'https:' || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if(!h || !h.includes('.') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.includes(':')) return null;
  if(/^\d+\.\d+\.\d+\.\d+$/.test(h)) return null;
  return u.toString();
}

function htmlToText(html){
  return String(html || '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ndash;|&mdash;/g, '-').replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const norm = s => String(s || '').toLowerCase().replace(/[‘’“”]/g, "'").replace(/[–—]/g, '-').replace(/[^a-z0-9$:\-' ]+/g, ' ').replace(/\s+/g, ' ').trim();

async function fetchText(fetchFn, url){
  const safe = safeUrl(url);
  if(!safe) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_MS);
  try{
    const res = await fetchFn(safe, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,text/plain;q=0.9' }, signal: controller.signal });
    if(!res.ok) return null;
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    if(!/text\/|html|xml/.test(type)) return null; // PDFs and images cannot be quote-checked here
    const buf = Buffer.from(await res.arrayBuffer());
    if(buf.length > MAX_BYTES) return null;
    return htmlToText(buf.toString('utf8'));
  } catch(e){ return null; }
  finally{ clearTimeout(timer); }
}

// A quote counts as verified only if its words really appear on the cited page.
async function verifyQuote(fetchFn, cache, url, quote){
  const q = norm(quote);
  if(q.length < 8 || !url) return false;
  if(!cache.has(url)) cache.set(url, await fetchText(fetchFn, url));
  const text = cache.get(url);
  return !!text && norm(text).includes(q);
}

// ----------------------------------------------------------- research ---

function researchPrompt(op){
  return `Research the CURRENT status and timetable of this ferry service in Saint Vincent and the Grenadines: ${op.hint}.

Use web search. Prefer the operator's own page, the Government of SVG, or SVG news outlets (Searchlight, iWitness News, News784). Rules:
- Only report what a source actually says. Do not guess, and do not fill gaps from older years.
- Prefer information published in the last 12 months. Ignore travel blogs unless nothing better exists.
- "operating": "yes" if a recent source shows it running, "no" ONLY if a source says it ceased, is suspended, or is inoperable, otherwise "unknown".
- Fares are one-way adult economy in EC dollars as a number. Use null if not stated.
- Times in 24-hour HH:MM. "days" in words like "daily", "Mon-Sat", "Sun and public holidays".
- Every sailing and the status need a "quote": words copied EXACTLY from the page, and the "source_url" of that page (https).
${op.statusOnly ? '- For this operator, give status only. Return an empty "sailings" list unless a source shows a current timetable.\n' : ''}
Return ONLY JSON, no other text:
{"operating":"yes|no|unknown","status_note":"one sentence","status_quote":"","status_source":"","sailings":[{"operator":"","origin":"","destination":"","days":"","departure_time":"","fare_economy":null,"quote":"","source_url":""}]}`;
}

// -------------------------------------------------------- store (db) ---

function makeStore(supabase){
  return {
    async routes(){
      const { data, error } = await supabase.from('ferry_routes').select('id, operator_name, origin_port, destination_port, active');
      if(error) throw error; return data || [];
    },
    async schedules(routeIds){
      if(!routeIds.length) return [];
      const { data, error } = await supabase.from('ferry_schedules').select('id, route_id, day_of_week, departure_time, fare_economy, last_verified_at').in('route_id', routeIds);
      if(error) throw error; return data || [];
    },
    async stamp(ids, at){
      if(!ids.length) return;
      const { error } = await supabase.from('ferry_schedules').update({ last_verified_at: at }).in('id', ids);
      if(error) throw error;
    },
    async insertRoute(row){
      const { data, error } = await supabase.from('ferry_routes').insert(row).select('id').single();
      if(error) throw error; return data.id;
    },
    async insertSchedules(rows){
      if(!rows.length) return [];
      const { data, error } = await supabase.from('ferry_schedules').insert(rows).select('id');
      if(error) throw error; return data || [];
    },
    async deleteSchedules(ids){
      if(!ids.length) return;
      const { error } = await supabase.from('ferry_schedules').delete().in('id', ids);
      if(error) throw error;
    },
    async setRouteActive(id, active){
      const { error } = await supabase.from('ferry_routes').update({ active }).eq('id', id);
      if(error) throw error;
    },
    async addDraft(subject, payload){
      const { data, error } = await supabase.from('agent_drafts')
        .upsert({ agent: AGENT, kind: 'finding', subject, payload, status: 'pending' }, { onConflict: 'agent,subject', ignoreDuplicates: true }).select('id');
      if(error) throw error; return !!(data && data.length);
    },
    async getDraft(id){
      const { data, error } = await supabase.from('agent_drafts').select('*').eq('id', id).eq('agent', AGENT).maybeSingle();
      if(error) throw error; return data;
    },
    async listDrafts(status){
      const { data, error } = await supabase.from('agent_drafts').select('*').eq('agent', AGENT).eq('status', status).neq('subject', LOCK).order('created_at', { ascending: false }).limit(100);
      if(error) throw error; return data || [];
    },
    async setDraftStatus(id, status){
      const { error } = await supabase.from('agent_drafts').update({ status, reviewed_at: new Date().toISOString() }).eq('id', id);
      if(error) throw error;
    },
    async getLock(){
      const { data } = await supabase.from('agent_drafts').select('payload').eq('agent', AGENT).eq('subject', LOCK).maybeSingle();
      return data ? data.payload || {} : {};
    },
    async setLock(payload){
      const { error } = await supabase.from('agent_drafts').upsert({ agent: AGENT, kind: 'finding', subject: LOCK, payload, status: 'rejected' }, { onConflict: 'agent,subject' });
      if(error) throw error;
    },
  };
}

// ------------------------------------------------------------- compare ---

const timesKey = list => list.map(x => x.time + '@' + (x.fare == null ? '' : x.fare)).sort().join('|');

// Turns verified/unverified sailings into proposals and "just re-verified" stamps.
function compare({ operator, sailings, routes, schedules }){
  const out = { proposals: [], stampIds: [], notes: [] };
  // group sailings by origin->destination
  const byRoute = new Map();
  for(const s of sailings){
    const k = s.origin + '>' + s.destination;
    if(!byRoute.has(k)) byRoute.set(k, { origin: s.origin, destination: s.destination, days: new Map(), evidence: [] });
    const g = byRoute.get(k);
    for(const d of s.days){
      if(!g.days.has(d)) g.days.set(d, []);
      g.days.get(d).push({ time: s.time, fare: s.fare });
    }
    g.evidence.push({ quote: s.quote, source_url: s.source_url, verified: s.verified });
  }
  for(const g of byRoute.values()){
    const route = routes.find(r =>
      norm(r.operator_name) === norm(operator) && place(r.origin_port) === g.origin && place(r.destination_port) === g.destination);
    const after = {};
    for(const [d, list] of g.days) after[d] = list.sort((a, b) => a.time.localeCompare(b.time));
    const allVerified = g.evidence.every(e => e.verified);
    if(!route){
      out.proposals.push({ type: 'new_route', operator, origin: g.origin, destination: g.destination, after, evidence: g.evidence });
      continue;
    }
    const mine = schedules.filter(s => s.route_id === route.id);
    const changed = {};
    for(const d of Object.keys(after)){
      const before = mine.filter(s => s.day_of_week === Number(d)).map(s => ({ time: s.departure_time, fare: s.fare_economy }));
      const same = timesKey(before) === timesKey(after[d].map(x => ({ time: x.time, fare: x.fare == null ? (before.find(b => b.time === x.time) || {}).fare : x.fare })));
      if(same && before.length && allVerified){
        out.stampIds.push(...mine.filter(s => s.day_of_week === Number(d)).map(s => s.id));
      } else if(!same){
        changed[d] = { before: before.sort((a, b) => a.time.localeCompare(b.time)), after: after[d] };
      }
    }
    if(Object.keys(changed).length){
      out.proposals.push({ type: 'schedule_change', operator, route_id: route.id, origin: g.origin, destination: g.destination, changed, evidence: g.evidence });
    }
  }
  return out;
}

// -------------------------------------------------------------- the run ---

async function lockedFor(store){
  const l = await store.getLock();
  if(!l.started_at) return 0;
  const hrs = (Date.now() - new Date(l.started_at).getTime()) / 3600000;
  return hrs < LOCK_HOURS ? Math.ceil((LOCK_HOURS - hrs) * 60) : 0;
}

async function run({ store, claude, fetchFn = fetch, travelPal = async () => false, operators = OPERATORS, force = false } = {}){
  const summary = { operators: [], proposals: 0, stamped: 0, skipped_live: [], errors: [] };
  const wait = force ? 0 : await lockedFor(store);
  if(wait){ summary.locked = true; summary.retry_in_minutes = wait; return summary; }
  const startedAt = new Date().toISOString();
  await store.setLock({ started_at: startedAt });

  const cache = new Map();
  const routes = await store.routes();
  const schedules = await store.schedules(routes.map(r => r.id));
  const now = new Date().toISOString();

  for(const op of operators){
    const entry = { operator: op.name, operating: 'unknown', sailings: 0, proposals: 0, stamped: 0 };
    try{
      const parsed = extractJson(await claude(researchPrompt(op)));
      if(!parsed){ entry.error = 'no usable answer'; summary.errors.push(op.name + ': no usable answer'); summary.operators.push(entry); continue; }
      entry.operating = ['yes', 'no', 'unknown'].includes(parsed.operating) ? parsed.operating : 'unknown';

      // Status: a reported closure becomes a proposal to switch the operator's routes off.
      if(entry.operating === 'no'){
        const url = safeUrl(parsed.status_source);
        const verified = url ? await verifyQuote(fetchFn, cache, url, parsed.status_quote) : false;
        const mine = routes.filter(r => norm(r.operator_name) === norm(op.name) && r.active !== false);
        const subject = `ferry:status:${norm(op.name)}:${crypto.createHash('sha1').update(String(parsed.status_source || '') + norm(parsed.status_quote)).digest('hex').slice(0, 10)}`;
        const created = await store.addDraft(subject, {
          ferry: true, type: 'operator_status', operator: op.name, title: `${op.name} reported not operating`,
          note: String(parsed.status_note || '').slice(0, 400), route_ids: mine.map(r => r.id),
          evidence: [{ quote: String(parsed.status_quote || '').slice(0, 400), source_url: url, verified }],
        });
        if(created){ entry.proposals++; summary.proposals++; }
      }
      if(op.statusOnly && !(parsed.sailings || []).length){ summary.operators.push(entry); continue; }

      // Sailings: clean, verify, skip destinations Travel Pal already covers live.
      const clean = [];
      for(const s of (Array.isArray(parsed.sailings) ? parsed.sailings : [])){
        const origin = place(s.origin) || 'Kingstown', destination = place(s.destination);
        const days = parseDays(s.days), time = parseTime(s.departure_time);
        const url = safeUrl(s.source_url);
        if(!destination || destination === origin || !days || !time || !url) continue;
        const fare = Number.isFinite(Number(s.fare_economy)) && s.fare_economy !== null && Number(s.fare_economy) > 0 && Number(s.fare_economy) < 1000 ? Number(s.fare_economy) : null;
        const verified = await verifyQuote(fetchFn, cache, url, s.quote);
        clean.push({ origin, destination, days, time, fare, quote: String(s.quote || '').slice(0, 400), source_url: url, verified });
      }
      entry.sailings = clean.length;
      const keep = [];
      for(const s of clean){
        if(await travelPal(s.destination)){ if(!summary.skipped_live.includes(s.destination)) summary.skipped_live.push(s.destination); continue; }
        keep.push(s);
      }
      if(!keep.length){ summary.operators.push(entry); continue; }

      const cmp = compare({ operator: op.name, sailings: keep, routes, schedules });
      for(const p of cmp.proposals){
        const hash = crypto.createHash('sha1').update(JSON.stringify([p.type, p.operator, p.origin, p.destination, p.after || p.changed])).digest('hex').slice(0, 10);
        const subject = `ferry:${p.type}:${norm(op.name)}:${norm(p.origin)}-${norm(p.destination)}:${hash}`;
        const title = p.type === 'new_route' ? `${op.name}: new route ${p.origin} to ${p.destination}` : `${op.name}: ${p.origin} to ${p.destination} timetable differs from AVA`;
        if(await store.addDraft(subject, Object.assign({ ferry: true, title }, p))){ entry.proposals++; summary.proposals++; }
      }
      if(cmp.stampIds.length){ await store.stamp([...new Set(cmp.stampIds)], now); entry.stamped = new Set(cmp.stampIds).size; summary.stamped += entry.stamped; }
    } catch(e){
      entry.error = e.message; summary.errors.push(`${op.name}: ${e.message}`);
    }
    summary.operators.push(entry);
  }
  await store.setLock({ started_at: startedAt, finished_at: new Date().toISOString(), summary });
  return summary;
}

// ------------------------------------------------- applying an approval ---

class ApplyError extends Error { constructor(status, message){ super(message); this.status = status; } }

async function applyProposal(store, draft){
  const p = draft.payload || {};
  if(!p.ferry) throw new ApplyError(400, 'Not a ferry proposal');
  const at = new Date().toISOString();
  if(p.type === 'operator_status'){
    const ids = Array.isArray(p.route_ids) ? p.route_ids : [];
    for(const id of ids) await store.setRouteActive(id, false);
    return { routes_switched_off: ids.length };
  }
  if(p.type === 'new_route'){
    const routes = await store.routes();
    let route = routes.find(r => norm(r.operator_name) === norm(p.operator) && place(r.origin_port) === p.origin && place(r.destination_port) === p.destination);
    if(route && route.active === false){ await store.setRouteActive(route.id, true); }
    const id = route ? route.id : await store.insertRoute({ operator_name: p.operator, origin_port: p.origin, destination_port: p.destination, active: true });
    const rows = [];
    for(const [d, list] of Object.entries(p.after || {})) for(const x of list) rows.push({ route_id: id, day_of_week: Number(d), departure_time: x.time, fare_economy: x.fare, last_verified_at: at });
    if(!rows.length) throw new ApplyError(400, 'Proposal has no sailings');
    const added = await store.insertSchedules(rows);
    return { route_id: id, sailings_added: added.length };
  }
  if(p.type === 'schedule_change'){
    const all = await store.schedules([p.route_id]);
    let added = 0, removed = 0;
    for(const [d, ch] of Object.entries(p.changed || {})){
      const rows = (ch.after || []).map(x => ({ route_id: p.route_id, day_of_week: Number(d), departure_time: x.time, fare_economy: x.fare, last_verified_at: at }));
      const oldIds = all.filter(s => s.day_of_week === Number(d)).map(s => s.id);
      const added_rows = await store.insertSchedules(rows);   // insert first, so a failure never leaves a day empty
      added += added_rows.length;
      await store.deleteSchedules(oldIds);
      removed += oldIds.length;
    }
    return { sailings_added: added, sailings_replaced: removed };
  }
  throw new ApplyError(400, 'Unknown proposal type');
}

// Used by the scheduled job: does Travel Pal already answer live for this destination?
function makeTravelPalCheck(fetchFn = fetch){
  const key = process.env.TRAVELPAL_API_KEY;
  const base = process.env.TRAVELPAL_API_URL || 'https://gtxmvazfuetokwyevxim.supabase.co/functions/v1/ava-api';
  return async function(dest){
    if(!key) return false;
    try{
      const day = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);
      const res = await fetchFn(`${base}/sailings?to=${encodeURIComponent(dest)}&date=${day}`, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(4000) });
      if(!res.ok) return false;
      const data = await res.json();
      return !!(data && Array.isArray(data.sailings) && data.sailings.length);
    } catch(e){ return false; }
  };
}

function makeClaude(apiKey, fetchFn = fetch){
  return async function(prompt){
    let messages = [{ role: 'user', content: prompt }];
    let text = '';
    for(let i = 0; i < 4; i++){
      const res = await fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: 2500, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }], messages }),
      });
      if(!res.ok) throw new Error(`Anthropic request failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const data = await res.json();
      text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      if(data.stop_reason === 'pause_turn'){ messages = messages.concat([{ role: 'assistant', content: data.content }]); continue; }
      break;
    }
    return text;
  };
}

module.exports = { run, applyProposal, ApplyError, makeStore, makeClaude, makeTravelPalCheck, lockedFor, compare, parseDays, parseTime, place, safeUrl, verifyQuote, OPERATORS, AGENT, LOCK, LOCK_HOURS };

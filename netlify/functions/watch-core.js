// AVA's watch: notice something is off, work out why, then report it (Pal Monitor) or alert (Telegram).
//
// detect()  - looks at one snapshot (+ box check-ins + the previous run) and returns findings. Each finding
//             has already been investigated by its playbook: what is happening, the evidence, the likely
//             cause, how sure we are, and the fix. Investigation is read-only.
// runWatch() - turns findings into incidents: opens, updates, repeats urgent ones until someone says
//             "Got it", escalates, and closes them when they clear. Store and senders are passed in so it
//             can be tested without Netlify or Telegram.
//
// Storage (Netlify Blobs, store "pal-watch"). Only the watch run writes state/open/inc/*; the bot writes
// ack/*, note/*, chat/*, user/*, mute; the box endpoint writes box/*. So no two writers share a key.
const { ago } = require('./pal-core');

const SEV_RANK = { info: 0, warn: 1, urgent: 2 };
const ICON = { info: 'ℹ️', warn: '⚠️', urgent: '🚨', ok: '✅' };
const min = s => Math.max(1, Math.round(s / 60));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------------------------- detect
function detect(snap, boxes, prev, now = Date.now()) {
  const out = [];
  const A = iso => ago(iso, now);
  const add = f => out.push({ need: 1, confidence: 'medium', evidence: [], ...f });
  const rp = snap.rp && snap.rp.ok ? snap.rp.data : null;
  const ep = snap.ep && snap.ep.ok ? snap.ep.data : null;
  const tp = snap.tp && snap.tp.ok ? snap.tp.data : null;
  const prevEp = prev && prev.ep;

  // --- the feeds themselves
  const feedNames = { ep: 'Event Pal', rp: 'Restaurant Pal', tp: 'Travel Pal' };
  const failing = Object.keys(feedNames).filter(k => snap[k] && !snap[k].ok);
  for (const k of failing) {
    const all = failing.length === 3;
    add({ key: 'feed:' + k, cls: 'feed', product: k, sev: 'warn', need: 2,
      title: `Can't read ${feedNames[k]}`,
      evidence: [`${feedNames[k]} feed: ${snap[k].error}`, all ? 'All three feeds are failing' : `The other feeds are fine`],
      cause: all ? 'The shared monitor key (MONITOR_KEY) is missing or was changed, or Netlify can\'t reach Supabase right now'
        : snap[k].status === 401 ? `${feedNames[k]}'s monitor key doesn't match the one in Netlify`
        : `${feedNames[k]}'s Supabase project or its monitor-feed function isn't answering`,
      confidence: all || snap[k].status === 401 ? 'high' : 'medium',
      fix: all ? 'Check MONITOR_KEY in Netlify (Production) matches the Supabase function secrets' : `Open ${feedNames[k]}'s Supabase project and check it's up` });
  }

  // --- sites (already re-checked once by the run before we get here)
  const rallyLive = !!(ep && (ep.phones_now > 0 || A(ep.control_seen) < 1800));
  for (const s of snap.sites || []) {
    if (s.ok !== false) continue;
    const others = (snap.sites || []).filter(x => x !== s && x.ok === true).length;
    add({ key: 'site:' + s.key, cls: 'site', product: s.product, sev: s.key === 'rally' && rallyLive ? 'urgent' : 'warn',
      title: `${s.name} isn't answering`,
      evidence: [s.note || `answered ${s.status}`, s.recheck ? 'Still down when checked again a few seconds later' : null, others ? `Our other sites answer fine` : 'None of our sites answer'].filter(Boolean),
      cause: !others ? 'Our checker may be the problem (Netlify networking), or a wider internet issue'
        : s.status >= 500 ? 'The host is having trouble (server error)' : s.status === 404 ? 'The page address no longer exists (deleted or renamed)' : 'The host is down or slow',
      confidence: others ? 'high' : 'low',
      fix: s.key === 'rally' ? 'Check GitHub Pages status and the last deploy of the rally site' : 'Open the site and check the host\'s status page' });
  }

  // --- Restaurant Pal, per business
  if (rp) for (const b of rp.businesses || []) {
    const devs = (b.devices || []).filter(d => d.last_seen && A(d.last_seen) < 3 * 3600); // used in the last 3 h
    const live = b.service_open || b.open_tabs > 0 || A(b.app_seen) < 600;
    if (live && devs.length) {
      const fresh = devs.filter(d => A(d.last_seen) < 120);
      const silent = devs.filter(d => A(d.last_seen) >= 300);
      if (silent.length && !fresh.length && silent.length === devs.length && b.open_tabs > 0) {
        add({ key: `rp:${b.name}:alltills`, cls: 'rp-alltills', product: 'rp', sev: 'urgent',
          title: `${b.name}: every till has gone quiet`,
          evidence: [`${plural(devs.length, 'till')} used today, none checked in for ${min(Math.min(...silent.map(d => A(d.last_seen))))}+ min`, `${plural(b.open_tabs, 'open bill')}`,
            A(b.app_seen) < 300 ? 'But a Restaurant Pal screen was open there in the last 5 min' : 'No Restaurant Pal screen open there either'],
          cause: A(b.app_seen) < 300 ? 'The tills are probably signed out or stuck on a screen (something is still open)' : 'Venue internet or power is down, or the tablets were closed',
          confidence: 'medium',
          fix: 'Check the venue wifi/router first. Tills keep selling offline; their sales sync when they reconnect' });   // no till notice: no till would get it
      } else for (const d of silent) {
        const mates = d.station ? devs.filter(x => x !== d && x.station === d.station) : [];
        const matesFresh = mates.filter(x => A(x.last_seen) < 120);
        const s = A(d.last_seen);
        const where = d.station ? `${d.name} (${d.station})` : d.name;
        add({ key: `rp:${b.name}:till:${d.id}`, cls: 'rp-till', product: 'rp', sev: s > 900 && (d.open_tabs > 0 || d.main) ? 'urgent' : 'warn',
          title: `${b.name}: ${where} hasn't checked in for ${min(s)} min`,
          evidence: [mates.length ? `${matesFresh.length} of ${mates.length} other till(s) at ${d.station} are fine` : `${fresh.length} other till(s) at ${b.name} are fine`,
            d.open_tabs ? `${plural(d.open_tabs, 'open bill')} at ${d.station}` : null, d.main ? 'This is the main till' : null].filter(Boolean),
          cause: (mates.length ? matesFresh.length : fresh.length) ? 'Just this tablet: its wifi dropped, the battery died, or the app was closed or locked' : 'This tablet and its neighbours are quiet: likely the wifi in that area',
          confidence: (mates.length ? matesFresh.length : fresh.length) ? 'high' : 'medium',
          fix: 'Check the tablet is on, unlocked and on wifi. If it is still selling, its sales are saved on it and sync when it reconnects',
          notice: b.id ? { business: b.id, target: d.station ? 'station' : 'main', station: d.station || null, skip: d.id, text: `${d.name} has gone quiet. Check it's on, unlocked and on wifi.` } : null });
      }
    }
    if (b.guest_waiting > 0) add({ key: `rp:${b.name}:guests`, cls: 'rp-guests', product: 'rp', sev: 'warn', need: 2,
      title: `${b.name}: ${plural(b.guest_waiting, 'guest order')} waiting to be accepted`,
      evidence: [`Waiting for at least 2 min`, A(b.app_seen) < 300 ? 'A Restaurant Pal screen is open there' : 'No Restaurant Pal screen is open there'],
      cause: A(b.app_seen) < 300 ? 'Staff haven\'t accepted them (busy, or the alert sound is off)' : 'Nobody has Restaurant Pal open, so nobody can see the orders',
      confidence: 'high', fix: 'Accept or reject them on the till',
      notice: b.id ? { business: b.id, target: 'main', text: `${plural(b.guest_waiting, 'phone order')} waiting to be accepted.` } : null });
    if (b.late_lines > 0) add({ key: `rp:${b.name}:late`, cls: 'rp-late', product: 'rp', sev: b.late_lines >= 5 ? 'urgent' : 'warn',
      title: `${b.name}: ${plural(b.late_lines, 'kitchen item')} over 25 min`,
      evidence: [`${b.late_lines} late`, b.ready_waiting ? `${b.ready_waiting} ready and waiting to be collected` : null].filter(Boolean),
      cause: b.ready_waiting > 3 ? 'Food is ready but not being run out, and the kitchen is backing up' : 'The kitchen is behind',
      confidence: 'medium', fix: b.ready_waiting > 3 ? 'Get someone running food' : 'Check the kitchen screen and tell the tables',
      notice: b.id ? { business: b.id, target: 'kitchen', text: `${plural(b.late_lines, 'item')} over 25 min.${b.ready_waiting > 3 ? ` ${b.ready_waiting} plates ready, need running.` : ''}` } : null });
  }

  // --- Event Pal screens, phones, photos
  if (ep) {
    const screens = ep.screens || [];
    const live = screens.filter(x => A(x.last_seen) < 60);
    const dropped = screens.filter(x => A(x.last_seen) >= 60 && A(x.last_seen) < 3600);
    const siteDown = (snap.sites || []).some(s => s.key === 'rally' && s.ok === false);
    if (dropped.length && !live.length && prevEp && (prevEp.screensLive || 0) > 0) {
      add({ key: 'ep:screens:all', cls: 'ep-allscreens', product: 'ep', sev: rallyLive ? 'urgent' : 'warn',
        title: `All big screens dropped off`,
        evidence: [`${prevEp.screensLive} were live on the last check, none now`, siteDown ? 'The rally site isn\'t answering' : 'The rally site is up'],
        cause: siteDown ? 'The rally site is down' : 'Venue internet, or the screen computers went to sleep',
        confidence: siteDown ? 'high' : 'medium', fix: 'Check the venue internet and the screen computers' });
    } else for (const x of dropped) if (live.length) {
      add({ key: 'ep:screen:' + x.out, cls: 'ep-screen', product: 'ep', sev: rallyLive ? 'urgent' : 'info',
        title: `Big screen ${x.out} (${x.name}) dropped off ${min(A(x.last_seen))} min ago`,
        evidence: [`${plural(live.length, 'other screen')} still live`],
        cause: 'Just that screen: its browser was closed, the computer slept, or its network dropped',
        confidence: 'high', fix: `Reopen the screen ${x.out} link on that computer and stop it sleeping` });
    }
    if (prevEp && prevEp.phones >= 20 && ep.phones_now < prevEp.phones * 0.5) {
      add({ key: 'ep:phones', cls: 'ep-phones', product: 'ep', sev: 'urgent',
        title: `Phones dropped off the game: ${prevEp.phones} → ${ep.phones_now}`,
        evidence: [siteDown ? 'The rally site isn\'t answering' : 'The rally site is up', live.length ? `${plural(live.length, 'screen')} still live` : 'No screens live either'],
        cause: siteDown ? 'The rally site is down' : live.length ? 'The live connection (Realtime) or the crowd\'s mobile data/venue wifi' : 'Venue internet',
        confidence: 'medium', fix: 'Check Supabase status (Realtime) and ask a few people if the page still loads' });
    }
    const pending = (ep.photos && ep.photos.pending) || 0;
    if (pending >= 10) add({ key: 'ep:photos', cls: 'ep-photos', product: 'ep', sev: 'warn',
      title: `${pending} rally photos waiting for approval`, evidence: [`${pending} pending`],
      cause: 'Nobody is approving photos on the control page', confidence: 'high', fix: 'Open the photo queue on the control page' });
  }

  // --- Travel Pal
  if (tp) {
    if (tp.reports_today && tp.reports_today.stuck > 0) add({ key: 'tp:reports', cls: 'tp-reports', product: 'tp', sev: 'warn',
      title: `${plural(tp.reports_today.stuck, 'Coast Guard / company report')} not sent after 15 min`, evidence: [`${tp.reports_today.stuck} stuck`],
      cause: 'Sending the report failed (email/send service)', confidence: 'medium', fix: 'Check the report send log in Travel Pal' });
    const under = (tp.active || []).filter(v => v.status === 'underway');
    const freshPos = under.filter(v => v.pos && A(v.pos.at) < 600);
    for (const v of under) {
      if (v.pos && A(v.pos.at) < 600) continue;
      const s = v.pos ? A(v.pos.at) : Infinity;
      add({ key: 'tp:pos:' + v.vessel, cls: 'tp-pos', product: 'tp', sev: s > 1800 ? 'urgent' : 'warn',
        title: `${v.vessel} is underway with no position for ${v.pos ? min(s) + ' min' : 'this trip'}`,
        evidence: [v.aboard != null ? `${v.aboard} aboard` : null, freshPos.length ? `${plural(freshPos.length, 'other ferry')} sending positions fine` : under.length > 1 ? 'No ferry is sending positions' : null].filter(Boolean),
        cause: freshPos.length || under.length === 1 ? 'The purser\'s phone: no signal at sea, low battery, or Travel Pal in the background' : 'Positions aren\'t reaching Travel Pal at all',
        confidence: freshPos.length ? 'high' : 'medium', fix: 'Message the purser to open Travel Pal; positions catch up when signal returns' });
    }
  }

  // --- AVA
  if (snap.ava && snap.ava.ok && snap.ava.questions_today >= 10 && snap.ava.unanswered_today / snap.ava.questions_today > 0.1)
    add({ key: 'ava:unanswered', cls: 'ava', product: 'ava', sev: 'info',
      title: `AVA couldn't answer ${snap.ava.unanswered_today} of ${snap.ava.questions_today} questions today`,
      evidence: [`${Math.round(100 * snap.ava.unanswered_today / snap.ava.questions_today)}% unanswered`], cause: 'Gaps in what AVA knows, or a tool failing',
      confidence: 'low', fix: 'Look at the unanswered list in AVA admin' });

  // --- Event Pal Boxes (they report in every 30 s)
  for (const bx of boxes || []) {
    const s = A(bx.last);
    if (s > 24 * 3600) continue;
    const st = bx.status || {};
    const srcs = (st.sources || []).filter(x => x.id !== '__setup');
    const wasSending = srcs.some(x => x.receivers > 0);
    const name = bx.name || st.box || 'Event Pal Box';
    if (s > 90) {
      const host = st.host || {};
      const busy = host.cpus && host.load / host.cpus > 0.9;
      add({ key: 'box:' + bx.id + ':silent', cls: 'box-silent', product: 'ep', sev: wasSending ? 'urgent' : 'warn',
        title: `${name} went quiet ${min(s)} min ago`,
        evidence: [wasSending ? `It was sending ${srcs.filter(x => x.receivers > 0).map(x => x.name).join(', ')} to ${plural(srcs.reduce((n, x) => n + x.receivers, 0), 'receiver')}` : 'Nothing was taking its feeds',
          busy ? `The computer was overloaded at its last check-in (load ${host.load} on ${host.cpus} cores)` : null].filter(Boolean),
        cause: busy ? 'The Box app probably crashed under load' : 'The Mac is asleep, off or offline, or the Box app stopped',
        confidence: busy ? 'medium' : 'low',
        fix: 'Check the Mac is awake and online. If it is, restart the box: launchctl kickstart -k gui/$(id -u)/com.eventpal.box' });
      continue;
    }
    if (st.ndi === false) add({ key: 'box:' + bx.id + ':ndi', cls: 'box-ndi', product: 'ep', sev: 'urgent',
      title: `${name}: NDI isn't loaded`, evidence: [st.ndiError || 'NDI library missing'], cause: 'The NDI runtime is missing or failed to load',
      confidence: 'high', fix: 'Reinstall NDI Tools on that Mac, then restart the box' });
    for (const x of srcs) {
      if (x.state === 'error' || (x.state === 'retrying' && bx.prevStates && bx.prevStates[x.id] === 'retrying'))
        add({ key: `box:${bx.id}:src:${x.id}`, cls: 'box-src', product: 'ep', sev: x.receivers > 0 ? 'urgent' : 'warn',
          title: `${name}: ${x.name} isn't drawing`, evidence: [x.error || x.state],
          cause: /load the page/i.test(x.error || '') ? 'The page couldn\'t load: internet at the box, or the link is wrong' : 'The page or NDI sender failed',
          confidence: 'medium', fix: 'Check the box\'s internet and the link in its settings' });
    }
    const hist = bx.hist || [];
    const lastTwo = hist.slice(-2);
    if (lastTwo.length === 2) {
      const slow = srcs.filter(x => x.state === 'live' && lastTwo.every(h => { const y = (h.src || {})[x.id]; return y && y.f < x.fps * 0.85; }));
      if (slow.length) {
        const host = st.host || {};
        const busy = host.cpus && host.load / host.cpus > 0.9;
        add({ key: `box:${bx.id}:fps`, cls: 'box-fps', product: 'ep', sev: 'warn',
          title: `${name}: ${slow.map(x => `${x.name} ${x.sendingFps}/${x.fps} fps`).join(', ')}`,
          evidence: ['Below 85% of the set frame rate for a minute', host.cpus ? `Computer load ${host.load} on ${host.cpus} cores, memory ${host.memUsed}% used` : null].filter(Boolean),
          cause: busy || slow.length > 1 ? 'The computer is overloaded' : `That page is heavy to draw`,
          confidence: busy ? 'high' : 'medium', fix: busy || slow.length > 1 ? 'Lower the size or frame rate of another source, or move one to a second box' : 'Lower that source\'s size or frame rate' });
      }
      for (const x of srcs) {
        const before = (hist[hist.length - 3] || {}).src;
        const had = before && before[x.id] && before[x.id].r > 0;
        if (had && x.receivers === 0 && lastTwo.every(h => ((h.src || {})[x.id] || {}).r === 0))
          add({ key: `box:${bx.id}:rx:${x.id}`, cls: 'box-rx', product: 'ep', sev: 'warn',
            title: `${name}: nothing is taking ${x.name} any more`, evidence: [`It had ${before[x.id].r} receiver(s) a minute ago, 0 now`],
            cause: 'mimoLive or the screen decoder disconnected or switched source', confidence: 'medium', fix: 'Check the NDI source selected in mimoLive / on the decoder' });
      }
    }
  }
  return out;
}

// A small memory of this run for the next one (phones and live screens), so drops can be spotted.
function prevOf(snap, now = Date.now()) {
  const ep = snap.ep && snap.ep.ok ? snap.ep.data : null;
  return { ep: ep ? { phones: ep.phones_now || 0, screensLive: (ep.screens || []).filter(x => ago(x.last_seen, now) < 60).length } : null };
}

// Is anything live right now (for hourly running updates)?
function liveSummary(snap, boxes, now = Date.now()) {
  const parts = [];
  const rp = snap.rp && snap.rp.ok ? snap.rp.data : null;
  const ep = snap.ep && snap.ep.ok ? snap.ep.data : null;
  const tp = snap.tp && snap.tp.ok ? snap.tp.data : null;
  if (ep && (ep.phones_now > 0 || (ep.screens || []).some(x => ago(x.last_seen, now) < 60) || ago(ep.control_seen, now) < 1800))
    parts.push(`Event Pal: ${plural(ep.phones_now || 0, 'phone')} on, ${(ep.screens || []).filter(x => ago(x.last_seen, now) < 60).length} screen(s) live`);
  for (const bx of boxes || []) if (ago(bx.last, now) < 90) {
    const srcs = ((bx.status || {}).sources || []).filter(x => x.id !== '__setup');
    if (srcs.length) parts.push(`${bx.name}: ${srcs.map(x => `${x.name} ${x.sendingFps}fps→${x.receivers}`).join(', ')}`);
  }
  if (rp) for (const b of rp.businesses || []) if (b.service_open || b.open_tabs > 0)
    parts.push(`${b.name}: ${plural(b.open_tabs, 'open bill')}, ${b.orders_today} orders today, ${(b.devices || []).filter(d => ago(d.last_seen, now) < 120).length}/${(b.devices || []).length} tills on`);
  if (tp && (tp.active || []).length) parts.push(`Travel Pal: ${(tp.active || []).map(v => `${v.vessel} ${v.status}${v.aboard != null ? ' (' + v.aboard + ' aboard)' : ''}`).join(', ')}`);
  return parts;
}

// ---------------------------------------------------------------------------------------------- wording
function plainAlert(f) {
  return [f.title, f.evidence.length ? f.evidence.join('. ') + '.' : '', `Likely: ${f.cause}. Fix: ${f.fix}.`, `Confidence: ${f.confidence}.`].filter(Boolean).join('\n');
}

async function wordAlert(f, notes, claude) {
  const system = [
    'You are AVA watching Rohan\'s systems (Event Pal, Restaurant Pal, Travel Pal). Write one Telegram alert from the finding below.',
    'At most 4 short lines, plain text, no markdown, no emoji: 1) what is happening, 2) the evidence, 3) likely cause and the fix, 4) "Confidence: high/medium/low".',
    'Use only the facts given. If a past note from the team matches this kind of problem, mention it first ("Last time this was …").',
  ].join('\n');
  const user = JSON.stringify({ finding: { title: f.title, evidence: f.evidence, cause: f.cause, confidence: f.confidence, fix: f.fix },
    past_notes: (notes || []).slice(0, 5).map(n => ({ when: n.at, said: n.text })) });
  try { return await claude(system, user, { maxTokens: 220, ms: 9000 }); }
  catch (e) { return (notes && notes.length ? `Last time: "${notes[0].text}"\n` : '') + plainAlert(f); }
}

// ---------------------------------------------------------------------------------------------- store
// A store is { get(key) -> json|null, set(key, json), del(key), list(prefix) -> [keys] }.
function blobStore(getStore) {
  const st = getStore({ name: 'pal-watch', consistency: 'strong' });
  return {
    get: k => st.get(k, { type: 'json' }).catch(() => null),
    set: (k, v) => st.setJSON(k, v),
    del: k => st.delete(k),
    list: async p => (await st.list({ prefix: p })).blobs.map(b => b.key),
  };
}
function memStore() {
  const m = new Map();
  return { m, get: async k => m.has(k) ? JSON.parse(m.get(k)) : null, set: async (k, v) => { m.set(k, JSON.stringify(v)); }, del: async k => { m.delete(k); },
    list: async p => [...m.keys()].filter(k => k.startsWith(p)).sort() };
}

const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
async function logEvent(store, ev) { const at = ev.at || new Date().toISOString(); await store.set(`log/${at}-${rid()}`, { ...ev, at }); }

async function boxesFrom(store) {
  const keys = await store.list('box/');
  return (await Promise.all(keys.map(k => store.get(k)))).filter(Boolean);
}
async function chatsFrom(store) {
  const keys = await store.list('chat/');
  return (await Promise.all(keys.map(k => store.get(k)))).filter(Boolean);
}
async function notesFor(store, cls) {
  const keys = (await store.list(`note/${cls}/`)).slice(-5).reverse();
  return (await Promise.all(keys.map(k => store.get(k)))).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------- telegram
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function telegram(token) {
  const api = (method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) })
    .then(r => r.json()).catch(e => ({ ok: false, description: e.message }));
  return {
    api,
    send: (chat, text, { replyTo, ackId } = {}) => api('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true,
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      ...(ackId ? { reply_markup: { inline_keyboard: [[{ text: '👍 Got it', callback_data: 'ack:' + ackId }]] } } : {}) }),
  };
}
const webhookSecret = token => require('crypto').createHash('sha256').update('pal-watch:' + token).digest('hex').slice(0, 48);

// ---------------------------------------------------------------------------------------------- the run
const REPEAT_MS = 5 * 60000;   // urgent and not acknowledged: say it again every 5 min
const ESCALATE_AFTER = 2;      // ...and after 2 repeats (~10 min) escalate to each admin directly
const MAX_REPEATS = 4;
const SUMMARY_MS = 60 * 60000; // running update while something is live

async function runWatch({ store, snap, now = Date.now(), claude, tg, escalate, till }) {
  const iso = new Date(now).toISOString();
  const state = (await store.get('state')) || { streak: {}, clear: {} };
  const open = (await store.get('open')) || {};
  const boxes = await boxesFrom(store);
  const chats = await chatsFrom(store);
  const mute = await store.get('mute');
  const muted = mute && Date.parse(mute.until) > now;
  const findings = detect(snap, boxes, state.prev, now);
  const seen = new Set();
  const sent = [];
  let budget = 8; // Telegram messages per run, at most

  const notify = async (inc, text, opts = {}) => {
    if (!tg || !chats.length || budget <= 0) return;
    if (muted && inc.sev !== 'urgent' && !opts.force) return;
    const head = `${ICON[opts.icon || inc.sev]} <b>${esc(opts.title || inc.title)}</b>`;
    for (const c of chats) {
      if (budget-- <= 0) break;
      const first = (inc.msgs || []).find(m => m.chat === c.chatId);
      const r = await tg.send(c.chatId, `${head}\n${esc(text)}`, { replyTo: opts.thread && first ? first.msg : undefined, ackId: opts.ack ? inc.id : undefined });
      if (r && r.ok) {
        sent.push({ chat: c.chatId, inc: inc.id });
        await store.set(`msg/${c.chatId}-${r.result.message_id}`, { inc: inc.id, cls: inc.cls });
        if (!first) (inc.msgs = inc.msgs || []).push({ chat: c.chatId, msg: r.result.message_id });
      }
    }
    inc.lastNotify = iso;
  };

  // notices staff have taken on a till (from the Restaurant Pal feed): ref = incident id
  const tillAcks = {};
  const rpData = snap.rp && snap.rp.ok ? snap.rp.data : null;
  if (rpData) for (const b of rpData.businesses || []) for (const n of b.notices || []) if (n.ack_at) tillAcks[n.ref] = n.ack_where || 'a till';
  const postNotice = async (inc, f) => {
    if (!till || !f.notice || inc.sev === 'info') return;
    const level = inc.sev === 'urgent' ? 'urgent' : 'warn';
    if (inc.notice && inc.notice.text === f.notice.text && inc.notice.level === level) return;
    const r = await till.post({ ...f.notice, ref: inc.id, level }).catch(e => ({ ok: false, error: e.message }));
    if (r && r.ok) inc.notice = { business: f.notice.business, text: f.notice.text, level };
  };

  for (const f of findings) {
    seen.add(f.key);
    state.streak[f.key] = (state.streak[f.key] || 0) + 1;
    delete state.clear[f.key];
    if (state.streak[f.key] < f.need) continue;
    let inc = open[f.key] ? await store.get('inc/' + open[f.key]) : null;
    if (!inc) {
      inc = { id: rid(), key: f.key, cls: f.cls, product: f.product, sev: f.sev, title: f.title, finding: f, opened: iso, updated: iso, msgs: [], repeats: 0 };
      if (f.sev !== 'info') {
        inc.text = await wordAlert(f, await notesFor(store, f.cls), claude);
        await notify(inc, inc.text, { ack: true });
      } else inc.text = plainAlert(f);
      await postNotice(inc, f);
      open[f.key] = inc.id;
      await logEvent(store, { at: iso, inc: inc.id, product: f.product, kind: 'opened', sev: f.sev, text: f.title });
    } else {
      const worse = SEV_RANK[f.sev] > SEV_RANK[inc.sev];
      inc.finding = f; inc.title = f.title; inc.updated = iso;
      if (worse) {
        inc.sev = f.sev;
        await notify(inc, plainAlert(f), { thread: true, ack: !inc.ackBy, title: 'Worse: ' + f.title });
        await logEvent(store, { at: iso, inc: inc.id, product: f.product, kind: 'worse', sev: f.sev, text: f.title });
      }
      await postNotice(inc, f);
      if (!inc.ackBy) {
        const ack = await store.get('ack/' + inc.id);
        if (ack) { inc.ackBy = ack.by; inc.ackAt = ack.at; await logEvent(store, { at: iso, inc: inc.id, product: inc.product, kind: 'ack', text: `${ack.by} has it` }); }
        else if (tillAcks[inc.id]) {
          inc.ackBy = `${tillAcks[inc.id]} (on the till)`; inc.ackAt = iso;
          await logEvent(store, { at: iso, inc: inc.id, product: inc.product, kind: 'ack', text: `${tillAcks[inc.id]} tapped OK on the till` });
          await notify(inc, `${tillAcks[inc.id]} tapped OK on the till, so someone there has it.`, { thread: true, icon: 'ok', title: inc.title, force: true });
        }
      }
      if (inc.sev === 'urgent' && !inc.ackBy && inc.lastNotify && now - Date.parse(inc.lastNotify) >= REPEAT_MS && inc.repeats < MAX_REPEATS) {
        inc.repeats++;
        await notify(inc, `Still happening (${min((now - Date.parse(inc.opened)) / 1000)} min). ${f.evidence[0] || ''}\nTap "Got it" so I stop repeating.`, { thread: true, ack: true, title: 'Still: ' + f.title });
        if (inc.repeats === ESCALATE_AFTER && !inc.escalated) {
          inc.escalated = iso;
          await logEvent(store, { at: iso, inc: inc.id, product: inc.product, kind: 'escalated', text: 'Nobody acknowledged in ~10 min' });
          if (escalate) await escalate(inc, chats);
        }
      }
    }
    await store.set('inc/' + inc.id, inc);
  }

  // things that cleared (two clean checks in a row before calling it fixed)
  for (const key of Object.keys(open)) {
    if (seen.has(key)) continue;
    delete state.streak[key];
    state.clear[key] = (state.clear[key] || 0) + 1;
    if (state.clear[key] < 2) continue;
    const inc = await store.get('inc/' + open[key]);
    delete open[key]; delete state.clear[key];
    if (!inc) continue;
    inc.resolved = iso; inc.updated = iso;
    if (till && inc.notice) await till.clear({ business: inc.notice.business, ref: inc.id }).catch(() => null);
    if ((inc.msgs || []).length) await notify(inc, `Back to normal after ${min((now - Date.parse(inc.opened)) / 1000)} min.`, { thread: true, icon: 'ok', title: inc.title, force: true });
    await store.set('inc/' + inc.id, inc);
    await logEvent(store, { at: iso, inc: inc.id, product: inc.product, kind: 'resolved', text: inc.title });
  }
  for (const key of Object.keys(state.streak)) if (!seen.has(key)) delete state.streak[key];

  // running update while something is live
  const live = liveSummary(snap, boxes, now);
  if (live.length && tg && chats.length && !muted && (!state.lastSummary || now - Date.parse(state.lastSummary) >= SUMMARY_MS)) {
    const openCount = Object.keys(open).length;
    for (const c of chats) if (budget-- > 0) await tg.send(c.chatId, `🟢 <b>Running update</b>\n${esc(live.join('\n'))}\n${openCount ? `${plural(openCount, 'open issue')} on the monitor.` : 'Nothing needs you.'}`);
    state.lastSummary = iso;
  }

  // tidy up once an hour: resolved incidents, timeline, notes and message links older than 7 days
  if (!state.lastPrune || now - Date.parse(state.lastPrune) > 3600e3) {
    const cutoff = new Date(now - 7 * 24 * 3600e3).toISOString();
    for (const k of await store.list('log/')) if (k.slice(4, 28) < cutoff) await store.del(k);
    for (const k of await store.list('inc/')) { const i = await store.get(k); if (i && i.resolved && i.resolved < cutoff) { await store.del(k); await store.del('ack/' + i.id); } }
    for (const k of await store.list('code/')) { const c = await store.get(k); if (!c || Date.parse(c.exp) < now) await store.del(k); }
    state.lastPrune = iso;
  }

  state.prev = prevOf(snap, now);
  state.lastRun = { at: iso, findings: findings.length, open: Object.keys(open).length, sent: sent.length };
  await store.set('open', open);
  await store.set('state', state);
  return { findings, open, sent };
}

// ---------------------------------------------------------------------------------------------- views
async function watchView(store, now = Date.now()) {
  const open = (await store.get('open')) || {};
  const state = (await store.get('state')) || {};
  const incKeys = (await store.list('inc/'));
  const incs = (await Promise.all(incKeys.map(k => store.get(k)))).filter(Boolean)
    .filter(i => !i.resolved || now - Date.parse(i.resolved) < 24 * 3600e3)
    .sort((a, b) => (!!a.resolved - !!b.resolved) || (SEV_RANK[b.sev] - SEV_RANK[a.sev]) || b.updated.localeCompare(a.updated))
    .map(i => ({ id: i.id, product: i.product, sev: i.sev, title: i.title, text: i.text, finding: i.finding, opened: i.opened, updated: i.updated, resolved: i.resolved || null, ackBy: i.ackBy || null, escalated: i.escalated || null }));
  const logKeys = (await store.list('log/')).slice(-60).reverse();
  const log = (await Promise.all(logKeys.map(k => store.get(k)))).filter(Boolean);
  const boxes = (await boxesFrom(store)).map(b => ({ id: b.id, name: b.name, last: b.last, first: b.first, status: b.status ? { ...b.status, ips: undefined } : null }));
  const chats = (await chatsFrom(store)).map(c => ({ title: c.title, kind: c.kind, by: c.by && c.by.name, at: c.at }));
  const mute = await store.get('mute');
  return { lastRun: state.lastRun || null, openCount: Object.keys(open).length, incidents: incs, log, boxes, chats,
    mute: mute && Date.parse(mute.until) > now ? mute : null, bot: !!process.env.WATCH_BOT_TOKEN };
}

module.exports = { detect, prevOf, liveSummary, plainAlert, wordAlert, blobStore, memStore, runWatch, watchView, telegram, webhookSecret, esc,
  logEvent, boxesFrom, chatsFrom, notesFor, rid, SEV_RANK, ICON };

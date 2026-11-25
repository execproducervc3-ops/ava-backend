// Admin API: Pal Monitor. One look-only snapshot across Event Pal, Restaurant Pal, Travel Pal and AVA,
// plus "Ask AVA" about it. Same admin password as the rest of the admin (X-Admin-Secret).
//
// Each product's Supabase project has a read-only "monitor-feed" function that returns counts and
// health only (no customer names, no money). They all check one shared key: MONITOR_KEY, set in
// Netlify (here) and as a function secret in each of the three Supabase projects.
const pal = require('./pal-core');
const watch = require('./watch-core');
const { getStore, connectLambda } = require('@netlify/blobs');
const { checkAuth, snapshot } = pal;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (statusCode, obj) => ({ statusCode, headers: { ...CORS, 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

async function ask(question, snap, extra, view) {
  if (!process.env.ANTHROPIC_API_KEY) return 'AVA isn\'t set up to answer here (no ANTHROPIC_API_KEY).';
  const system = [
    'You are AVA, looking at the Pal Monitor for Rohan, who runs Event Pal (live events, sports graphics, NDI boxes), Restaurant Pal (restaurant tills) and Travel Pal (ferry manifests), plus AVA itself.',
    'Answer only from the snapshot below. It holds counts and health only: no customer names and no money. If something isn\'t in it, say you can\'t see that from the monitor yet.',
    'Be brief and plain: a few short sentences, most important first. Say what needs attention and the simplest next step. Times are in St Vincent time (UTC-4). Don\'t invent numbers.',
    'open_issues are what your own watch has found and investigated; use them.',
    pal.MONITOR_NOTES,
  ].join('\n');
  const issues = view ? view.incidents.filter(i => !i.resolved).map(i => ({ sev: i.sev, title: i.title, finding: i.finding, ackBy: i.ackBy })) : undefined;
  const boxes = view ? view.boxes.map(b => ({ name: b.name, last_checkin: b.last, sources: b.status && b.status.sources, host: b.status && b.status.host })) : undefined;
  const user = `Snapshot (${snap.at}):\n${JSON.stringify({ ...snap, box: extra || undefined, boxes, open_issues: issues })}\n\nQuestion: ${question}`;
  return pal.claude(system, user, { maxTokens: 500, ms: 25000 });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  try { connectLambda(event); } catch (e) { /* blobs not available (local) */ }
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
      let view = null; try { view = await watch.watchView(watch.blobStore(getStore)); } catch (e) {}
      return json(200, { answer: await ask(q, snap, box, view), at: snap.at });
    }
    // ---- AVA's watch
    if (event.httpMethod === 'GET' && action === 'watch') return json(200, await watch.watchView(watch.blobStore(getStore)));
    if (event.httpMethod === 'POST' && action === 'link_code') {
      const store = watch.blobStore(getStore);
      const code = String(require('crypto').randomInt(100000, 1000000));
      await store.set('code/' + code, { exp: new Date(Date.now() + 10 * 60000).toISOString() });
      return json(200, { code, minutes: 10 });
    }
    if (event.httpMethod === 'POST' && action === 'tg_setup') {
      const token = process.env.WATCH_BOT_TOKEN;
      if (!token) return json(400, { error: 'Add WATCH_BOT_TOKEN in Netlify (Production) first, then redeploy.' });
      const tg = watch.telegram(token);
      const me = await tg.api('getMe', {});
      if (!me.ok) return json(400, { error: 'Telegram didn\'t accept the bot token: ' + me.description });
      const host = (event.headers && (event.headers['x-forwarded-host'] || event.headers.host)) || 'askvincy.com';
      const set = await tg.api('setWebhook', { url: `https://${host}/api/watch-telegram`, secret_token: watch.webhookSecret(token), allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
      if (!set.ok) return json(400, { error: 'Telegram: ' + set.description });
      await tg.api('setMyCommands', { commands: [{ command: 'status', description: 'Briefing on everything now' }, { command: 'mute', description: 'Quiet non-urgent alerts (minutes)' }, { command: 'unmute', description: 'Alerts back on' }, { command: 'help', description: 'What I can do' }] });
      return json(200, { ok: true, bot: me.result.username });
    }
    if (event.httpMethod === 'POST' && action === 'ack') {
      const id = String(JSON.parse(event.body || '{}').id || '').replace(/\W/g, '').slice(0, 30);
      const store = watch.blobStore(getStore);
      if (id && !(await store.get('ack/' + id))) await store.set('ack/' + id, { by: 'Pal Monitor', at: new Date().toISOString() });
      return json(200, { ok: true });
    }
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('admin-monitor error:', e);
    return json(500, { error: e.message });
  }
};

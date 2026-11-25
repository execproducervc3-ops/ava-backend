// AVA's watch: every 2 minutes, look at everything, investigate anything off, report or alert.
// Scheduled in netlify.toml (every 2 minutes).
const { getStore, connectLambda } = require('@netlify/blobs');
const pal = require('./pal-core');
const core = require('./watch-core');

exports.handler = async (event) => {
  const t0 = Date.now();
  connectLambda(event);
  const store = core.blobStore(getStore);
  const snap = await pal.snapshot(0);
  // a site that looks down gets one more try before it counts
  await Promise.all(snap.sites.map(async (s, i) => {
    if (s.ok !== false) return;
    await new Promise(r => setTimeout(r, 2000));
    const again = await pal.site(s, 5000);
    snap.sites[i] = again.ok ? again : { ...again, recheck: true };
  }));
  const token = process.env.WATCH_BOT_TOKEN;
  const tg = token ? core.telegram(token) : null;
  // escalation: message each linked person directly. (A phone call can be added here later.)
  const escalate = async (inc, chats) => {
    if (!tg) return;
    const people = [...new Set(chats.map(c => c.by && c.by.id).filter(Boolean))];
    for (const p of people) await tg.send(p, `🚨 <b>Nobody has picked this up in 10 min</b>\n${core.esc(inc.title)}\n${core.esc(inc.text || '')}`, { ackId: inc.id });
  };
  const r = await core.runWatch({ store, snap, claude: pal.claude, tg, escalate });
  console.log(`watch: ${r.findings.length} finding(s), ${Object.keys(r.open).length} open, ${r.sent.length} message(s), ${Date.now() - t0} ms`);
  return { statusCode: 200 };
};

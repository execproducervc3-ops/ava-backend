// Event Pal Boxes report in here every 30 s (see eventpal-box/main.js). Same status as the box's own
// /api/status: source names, sizes, fps, receivers. No links, no PIN. The first check-in from a box fixes
// its token; later ones must match, so nobody else can speak for that box.
const { getStore, connectLambda } = require('@netlify/blobs');
const crypto = require('crypto');
const core = require('./watch-core');
const res = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v, m) => String(v == null ? '' : v).slice(0, m);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return res(405, { error: 'POST only' });
  connectLambda(event);
  let b; try { b = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body); } catch { return res(400, { error: 'bad json' }); }
  const id = str(b.id, 40);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[a-f0-9]{64}$/.test(String(b.token || ''))) return res(400, { error: 'missing id or token' });
  const store = core.blobStore(getStore);
  const key = 'box/' + id;
  const old = await store.get(key);
  if (old && old.tokenHash !== hash(b.token)) return res(403, { error: 'token does not match this box' });
  const now = new Date().toISOString();
  const sources = (Array.isArray(b.sources) ? b.sources : []).slice(0, 8).map(x => ({
    id: str(x.id, 40), name: str(x.name, 40), size: str(x.size, 12), fps: n(x.fps), transparent: !!x.transparent, state: str(x.state, 12),
    error: x.error ? str(x.error, 160) : null, sendingFps: n(x.sendingFps), framesSent: n(x.framesSent), receivers: n(x.receivers) }));
  const h = b.host || {};
  const status = { box: str(b.box, 30), ndi: !!b.ndi, ndiError: b.ndiError ? str(b.ndiError, 160) : null, uptime: n(b.uptime), configured: !!b.configured, sources,
    host: { load: n(h.load), cpus: n(h.cpus), memUsed: n(h.memUsed), platform: str(h.platform, 12) } };
  const hist = ((old && old.hist) || []).concat({ at: now, src: Object.fromEntries(sources.map(x => [x.id, { f: x.sendingFps, r: x.receivers }])) }).slice(-20);
  const prevStates = old && old.status ? Object.fromEntries((old.status.sources || []).map(x => [x.id, x.state])) : {};
  await store.set(key, { id, tokenHash: old ? old.tokenHash : hash(b.token), name: status.box || (old && old.name) || 'Event Pal Box',
    first: (old && old.first) || now, last: now, status, prevStates, hist });
  return res(200, { ok: true });
};

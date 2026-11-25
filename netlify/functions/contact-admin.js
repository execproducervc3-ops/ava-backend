// "Contact admin": a message or voice note from an owner or manager reaches the administrator on the
// private watch bot (Telegram). One-way for now: the admin calls or messages them back.
//
// Who may send:
//   - the Pal Monitor (admin password, X-Admin-Secret)
//   - Restaurant Pal / Travel Pal, through their own contact-admin edge functions, which check the
//     sender is an owner or manager and then call here with the shared MONITOR_KEY (x-monitor-key).
// Body: { app, from: { name, role, business }, screen, text, voice: { b64, mime, seconds } | null }
const { getStore, connectLambda } = require('@netlify/blobs');
const pal = require('./pal-core');
const core = require('./watch-core');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret, x-monitor-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const res = (statusCode, obj) => ({ statusCode, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });
const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const same = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && require('crypto').timingSafeEqual(a, b); };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return res(405, { error: 'POST only' });
  const h = event.headers || {};
  const key = process.env.MONITOR_KEY || '';
  const byService = key.length >= 16 && h['x-monitor-key'] && same(h['x-monitor-key'], key);
  const byAdmin = !byService && h['x-admin-secret'] && await pal.checkAuth(h['x-admin-secret']);
  if (!byService && !byAdmin) return res(401, { error: 'Not allowed.' });
  const token = process.env.WATCH_BOT_TOKEN;
  if (!token) return res(503, { error: 'The admin\'s Telegram isn\'t connected yet.' });
  connectLambda(event);
  let b; try { b = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body); } catch { return res(400, { error: 'Bad request.' }); }

  const app = str(b.app, 30) || 'Pal Monitor', from = b.from || {};
  const name = str(from.name, 60) || (byAdmin ? 'Pal Monitor' : 'Someone'), role = str(from.role, 30), biz = str(from.business, 60);
  const screen = str(b.screen, 40), text = String(b.text || '').trim().slice(0, 1000);
  const v = b.voice && b.voice.b64 ? b.voice : null;
  if (!text && !v) return res(400, { error: 'Type a message or record a voice note.' });
  let audio = null;
  if (v) {
    audio = Buffer.from(String(v.b64), 'base64');
    if (audio.length > 1.5e6) return res(413, { error: 'That voice note is too long. Keep it under a minute.' });
  }

  const store = core.blobStore(getStore);
  // limit: 6 messages in 10 minutes from the same person and place
  const who = `${app}|${biz}|${name}`.toLowerCase().replace(/[^a-z0-9|]+/g, '-').slice(0, 120);
  const rl = (await store.get('rl/' + who)) || { n: 0, since: Date.now() };
  if (Date.now() - rl.since > 10 * 60000) { rl.n = 0; rl.since = Date.now(); }
  if (rl.n >= 6) return res(429, { error: 'Too many messages in a few minutes. Try again shortly, or call.' });
  rl.n++; await store.set('rl/' + who, rl);

  // the admin's own chats: linked people, privately
  const users = (await Promise.all((await store.list('user/')).map(async k => ({ id: k.slice(5), u: await store.get(k) })))).filter(x => x.u && x.u.role === 'admin');
  if (!users.length) return res(503, { error: 'The admin hasn\'t linked Telegram yet.' });
  const tg = core.telegram(token);
  const head = `📞 <b>Contact admin · ${core.esc(app)}</b>\nFrom: <b>${core.esc(name)}</b>${role ? ' · ' + core.esc(role) : ''}${biz ? '\n' + core.esc(biz) : ''}${screen ? '\nScreen: ' + core.esc(screen) : ''}${text ? '\n\n' + core.esc(text) : ''}${v ? `\n\n🎙 Voice note (${Number(v.seconds) || '?'}s) below` : ''}`;
  let delivered = 0;
  for (const { id } of users) {
    const r = await tg.send(id, head);
    if (!r || !r.ok) continue;
    delivered++;
    if (audio) {
      const mime = String(v.mime || '');
      const ogg = /ogg/.test(mime), ext = ogg ? 'ogg' : /mp4|m4a|aac/.test(mime) ? 'm4a' : /webm/.test(mime) ? 'webm' : 'mp3';
      const form = new FormData();
      form.append('chat_id', id);
      form.append('reply_parameters', JSON.stringify({ message_id: r.result.message_id, allow_sending_without_reply: true }));
      const file = new Blob([audio], { type: ogg ? 'audio/ogg' : mime || 'application/octet-stream' });
      let method = 'sendVoice';
      if (ogg) { form.append('voice', file, 'voice.ogg'); if (v.seconds) form.append('duration', String(Math.round(v.seconds))); }
      else if (ext === 'm4a') { method = 'sendAudio'; form.append('audio', file, 'voice-note.m4a'); form.append('title', 'Voice note from ' + name); }
      else { method = 'sendDocument'; form.append('document', file, 'voice-note.' + ext); }
      await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body: form, signal: AbortSignal.timeout(15000) }).catch(() => null);
    }
  }
  if (!delivered) return res(502, { error: 'Telegram didn\'t take the message. Try again, or call.' });
  await core.logEvent(store, { kind: 'contact', product: app === 'Restaurant Pal' ? 'rp' : app === 'Travel Pal' ? 'tp' : app === 'Event Pal' ? 'ep' : 'watch',
    text: `${name}${biz ? ' (' + biz + ')' : ''} contacted admin${v ? ' with a voice note' : ''}` });
  return res(200, { ok: true, delivered });
};

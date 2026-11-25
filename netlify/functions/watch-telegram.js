// AVA's watch bot on Telegram (its own private bot, separate from AVA's public vendor bot).
// Only people linked from the Pal Monitor (a one-time code) can use it. They can:
//   tap "Got it" on an alert          -> stops the repeats, shows who has it
//   reply to an alert with a note     -> saved; next time that kind of problem happens AVA checks it first
//   /status                           -> a short briefing of everything now
//   /mute 60 · /unmute                -> quiet non-urgent alerts for a while (urgent ones still come)
//   any question                      -> AVA answers from the monitor
// Changing things from chat (stock, sponsors, limits) is part 2 and is not here.
// Reached at /api/watch-telegram (redirect in netlify.toml).
const { getStore, connectLambda } = require('@netlify/blobs');
const pal = require('./pal-core');
const core = require('./watch-core');

const ok = () => ({ statusCode: 200, body: 'ok' });

exports.handler = async (event) => {
  const token = process.env.WATCH_BOT_TOKEN;
  if (!token || event.httpMethod !== 'POST') return ok();
  const h = event.headers || {};
  if (h['x-telegram-bot-api-secret-token'] !== core.webhookSecret(token)) return { statusCode: 401, body: 'no' };
  connectLambda(event);
  let u; try { u = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body); } catch { return ok(); }
  const tg = core.telegram(token);
  const store = core.blobStore(getStore);
  const nameOf = f => [f.first_name, f.last_name].filter(Boolean).join(' ') || f.username || String(f.id);

  try {
    // ---- "Got it" button
    if (u.callback_query) {
      const q = u.callback_query;
      const user = await store.get('user/' + q.from.id);
      if (!user) { await tg.api('answerCallbackQuery', { callback_query_id: q.id, text: 'You are not linked to this bot.' }); return ok(); }
      const m = /^ack:(\w+)$/.exec(q.data || '');
      if (m) {
        const inc = await store.get('inc/' + m[1]);
        if (!(await store.get('ack/' + m[1]))) await store.set('ack/' + m[1], { by: user.name, id: q.from.id, at: new Date().toISOString() });
        await tg.api('answerCallbackQuery', { callback_query_id: q.id, text: 'Got it. I\'ll stop repeating.' });
        if (q.message) {
          await tg.api('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
          await tg.send(q.message.chat.id, `👍 ${core.esc(user.name)} has it${inc ? ': ' + core.esc(inc.title) : ''}.\nReply to the alert with what it was, and I'll check that first next time.`, { replyTo: q.message.message_id });
        }
      }
      return ok();
    }

    const msg = u.message;
    if (!msg || !msg.text || !msg.from) return ok();
    const chat = msg.chat, text = msg.text.trim();
    const isPrivate = chat.type === 'private';

    // ---- /link CODE (code made on the Pal Monitor, good for 10 minutes, once)
    const link = /^\/(?:link|start)(?:@\w+)?\s+(\d{6})$/i.exec(text);
    if (link) {
      const code = await store.get('code/' + link[1]);
      if (!code || Date.parse(code.exp) < Date.now()) { await tg.send(chat.id, 'That code isn\'t valid any more. Make a new one on the Pal Monitor.'); return ok(); }
      await store.del('code/' + link[1]);
      const by = { id: msg.from.id, name: nameOf(msg.from) };
      await store.set('user/' + msg.from.id, { name: by.name, role: 'admin', at: new Date().toISOString() });
      await store.set('chat/' + chat.id, { chatId: chat.id, title: isPrivate ? by.name : (chat.title || 'group'), kind: chat.type, by, at: new Date().toISOString() });
      await core.logEvent(store, { kind: 'linked', product: 'watch', text: `${by.name} linked ${isPrivate ? 'their Telegram' : 'the group ' + (chat.title || '')}` });
      await tg.send(chat.id, `✅ Linked. I'll send alerts here, and a running update every hour while something is live.\n\n/status for a briefing · /mute 60 to quiet non-urgent alerts · ask me anything about the systems.`);
      return ok();
    }

    const user = await store.get('user/' + msg.from.id);
    if (!user) { if (isPrivate) await tg.send(chat.id, 'This is a private bot. Ask the admin for a link code from the Pal Monitor.'); return ok(); }

    if (/^\/(help|start)(@\w+)?$/i.test(text)) {
      await tg.send(chat.id, 'I watch Event Pal, Restaurant Pal, Travel Pal and AVA, and tell you when something is off and why.\n\n/status for a briefing · /mute 60 to quiet non-urgent alerts for 60 min · /unmute\nReply to an alert to tell me what it was. Tap "Got it" to stop repeats.');
      return ok();
    }
    const mute = /^\/mute(?:@\w+)?(?:\s+(\d+))?$/i.exec(text);
    if (mute) {
      const mins = Math.min(240, Math.max(5, Number(mute[1] || 60)));
      await store.set('mute', { until: new Date(Date.now() + mins * 60000).toISOString(), by: user.name });
      await tg.send(chat.id, `🔕 Non-urgent alerts quiet for ${mins} min. Urgent ones still come through.`);
      return ok();
    }
    if (/^\/unmute(@\w+)?$/i.test(text)) { await store.del('mute'); await tg.send(chat.id, '🔔 Alerts back on.'); return ok(); }

    // ---- a reply to one of AVA's alerts = a note on that incident
    const rt = msg.reply_to_message;
    if (rt && rt.from && rt.from.is_bot && !text.startsWith('/')) {
      const ref = await store.get(`msg/${chat.id}-${rt.message_id}`);
      if (ref) {
        const at = new Date().toISOString();
        await store.set(`note/${ref.cls}/${at}-${core.rid()}`, { inc: ref.inc, by: user.name, text: text.slice(0, 500), at });
        if (/^(got it|on it|ack|ok)\b/i.test(text) && !(await store.get('ack/' + ref.inc))) await store.set('ack/' + ref.inc, { by: user.name, id: msg.from.id, at });
        await core.logEvent(store, { inc: ref.inc, kind: 'note', product: 'watch', text: `${user.name}: ${text.slice(0, 200)}` });
        await tg.send(chat.id, '📝 Noted. Next time this kind of thing happens I\'ll check that first.', { replyTo: msg.message_id });
        return ok();
      }
    }

    // ---- /status or a question
    const question = /^\/status(@\w+)?$/i.test(text) ? 'Give me a short briefing: overall state, anything that needs me now, and one line per product.' : text.slice(0, 500);
    await tg.api('sendChatAction', { chat_id: chat.id, action: 'typing' });
    const [snap, view] = await Promise.all([pal.snapshot(), core.watchView(store)]);
    const system = [
      'You are AVA, watching the systems for Rohan\'s team: Event Pal (live events, big screens, NDI boxes), Restaurant Pal (tills), Travel Pal (ferry manifests), and AVA itself.',
      'Answer on Telegram: plain text, short, most important first, no markdown tables. Answer only from the data below; if something isn\'t in it, say you can\'t see that yet.',
      'The data is counts and health only: no customer names and no money. Times are St Vincent time (UTC-4). Don\'t invent numbers.',
      'You can\'t change anything from here yet; if asked to, say that will come later and tell them where to do it.',
      pal.MONITOR_NOTES,
    ].join('\n');
    const data = { snapshot: { ...snap, warnings: undefined }, open_issues: view.incidents.filter(i => !i.resolved).map(i => ({ sev: i.sev, title: i.title, finding: i.finding, ackBy: i.ackBy })),
      boxes: view.boxes.map(b => ({ name: b.name, last_checkin: b.last, sources: b.status && b.status.sources, host: b.status && b.status.host })),
      recent: view.log.slice(0, 15).map(l => ({ at: l.at, kind: l.kind, text: l.text })) };
    let answer;
    try { answer = await pal.claude(system, `Data (${snap.at}):\n${JSON.stringify(data)}\n\nFrom ${user.name}: ${question}`, { maxTokens: 450, ms: 20000 }); }
    catch (e) { answer = 'I couldn\'t think that through just now (' + e.message + '). Open issues: ' + (data.open_issues.map(i => i.title).join('; ') || 'none') + '.'; }
    await tg.send(chat.id, core.esc(answer), { replyTo: msg.message_id });
  } catch (e) { console.error('watch-telegram', e); }
  return ok();
};

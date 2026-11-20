// Opens AVA's Telegram bot with a start code, so other apps (Travel Pal's "Link a Telegram chat")
// can link to the bot without knowing its name: /.netlify/functions/tg-start?code=TP…
'use strict';
let cachedBot = null;
async function botUsername() {
  if (process.env.TELEGRAM_BOT_USERNAME) return process.env.TELEGRAM_BOT_USERNAME.replace(/^@/, '');
  if (cachedBot) return cachedBot;
  try {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`);
    const j = await r.json();
    if (j && j.ok && j.result && j.result.username) { cachedBot = j.result.username; return cachedBot; }
  } catch (e) { /* fall through */ }
  return null;
}

exports.handler = async (event) => {
  const code = String((event.queryStringParameters || {}).code || '').trim().toUpperCase();
  if (!/^TP[A-Z2-9]{10}$/.test(code)) {
    return { statusCode: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: "That link isn't complete. Make a new one in Travel Pal (Menu, then \"Link a Telegram chat\")." };
  }
  const bot = await botUsername();
  if (!bot) return { statusCode: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: `Telegram can't be reached right now. In Telegram, send AVA's bot this message: /start ${code}` };
  return { statusCode: 302, headers: { Location: `https://t.me/${bot}?start=${code}`, 'Cache-Control': 'no-store' }, body: '' };
};

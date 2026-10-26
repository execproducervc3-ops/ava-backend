// Admin: create, replace and cancel one-time vendor codes, and see who is connected.
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const { CODE_DAYS, randomCode } = require('./vendor-codes');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const reply = (code, obj) => ({ statusCode: code, headers: CORS, body: JSON.stringify(obj) });

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

async function describe(listing) {
  const { data: codes } = await supabase.from('vendor_codes').select('code, kind, status, created_at, expires_at, used_at')
    .eq('listing_id', String(listing.id)).order('created_at', { ascending: false }).limit(10);
  const now = Date.now();
  const active = (codes || []).find(c => c.status === 'active' && new Date(c.expires_at).getTime() > now) || null;
  return {
    id: listing.id, name: listing.name, island: listing.island, category: listing.category,
    connected: listing.claimed_by_telegram_id != null,
    active_code: active ? { code: active.code, expires_at: active.expires_at, kind: active.kind } : null,
    history: (codes || []).map(c => ({ code: c.code, kind: c.kind, status: (c.status === 'active' && new Date(c.expires_at).getTime() <= now) ? 'expired' : c.status, created_at: c.created_at, used_at: c.used_at })),
  };
}

async function linkFor(code) {
  const bot = await botUsername();
  return { bot, link: bot ? `https://t.me/${bot}?start=${code}` : null };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const provided = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'] || '';
  const { data: authRow } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  if (!authRow || !provided || !(await bcrypt.compare(provided, authRow.password_hash))) return reply(401, { error: 'Unauthorized' });

  const qs = event.queryStringParameters || {};
  let body = {};
  if (event.httpMethod === 'POST') { try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Bad request.' }); } }

  try {
    if (qs.action === 'search') {
      const q = String(qs.q || '').trim().replace(/[%,()]/g, ' ').slice(0, 60);
      if (q.length < 2) return reply(200, { listings: [] });
      const { data } = await supabase.from('directory_listings').select('id, name, island, category, claimed_by_telegram_id')
        .ilike('name', `%${q}%`).eq('status', 'active').order('name', { ascending: true }).limit(15);
      return reply(200, { listings: await Promise.all((data || []).map(describe)) });
    }

    const { data: listing } = await supabase.from('directory_listings').select('id, name, island, category, claimed_by_telegram_id')
      .eq('id', body.listing_id).maybeSingle();
    if (!listing) return reply(404, { error: 'Business not found.' });

    if (qs.action === 'create') {
      const reconnect = listing.claimed_by_telegram_id != null;
      if (reconnect && body.confirm_reconnect !== true) {
        return reply(409, { needs_confirm: true, error: `${listing.name} is already connected to a Telegram account. A reconnect code will move it to a new account when used.` });
      }
      // One active code per business: a new code replaces the old one.
      await supabase.from('vendor_codes').update({ status: 'cancelled' }).eq('listing_id', String(listing.id)).eq('status', 'active');
      const expires = new Date(Date.now() + CODE_DAYS * 86400000).toISOString();
      let code = null;
      for (let i = 0; i < 5 && !code; i++) {
        const c = randomCode();
        const { error } = await supabase.from('vendor_codes').insert({ code: c, listing_id: String(listing.id), kind: reconnect ? 'reconnect' : 'connect', expires_at: expires });
        if (!error) code = c;
      }
      if (!code) return reply(500, { error: 'Could not create a code. Please try again.' });
      const { bot, link } = await linkFor(code);
      const text = `Hello from AVA. Tap this link to connect ${listing.name} to AVA on Telegram: ${link || '(open AVA\'s Telegram bot and send: /start ' + code + ')'}\nIf the link does not work, open AVA's bot in Telegram and send: /start ${code}\nThe code works once and expires in ${CODE_DAYS} days.`;
      return reply(200, { ok: true, code, expires_at: expires, kind: reconnect ? 'reconnect' : 'connect', link, bot, message: text });
    }
    if (qs.action === 'cancel') {
      await supabase.from('vendor_codes').update({ status: 'cancelled' }).eq('listing_id', String(listing.id)).eq('status', 'active');
      return reply(200, { ok: true });
    }
    if (qs.action === 'disconnect') {
      if (listing.claimed_by_telegram_id == null) return reply(400, { error: 'This business is not connected.' });
      if (body.confirm !== true) return reply(409, { needs_confirm: true, error: `Disconnect ${listing.name} from its Telegram account? Its prices and events stay on the listing, but that Telegram account will no longer be linked to it.` });
      await supabase.from('retailer_profile').update({ directory_listing_id: null }).eq('telegram_user_id', listing.claimed_by_telegram_id);
      await supabase.from('directory_listings').update({ claimed_by_telegram_id: null }).eq('id', listing.id);
      return reply(200, { ok: true });
    }
    return reply(400, { error: 'Unknown action.' });
  } catch (e) {
    console.error('admin-vendor-codes error:', e.message);
    return reply(500, { error: 'Something went wrong. Check the Netlify function logs for admin-vendor-codes.' });
  }
};

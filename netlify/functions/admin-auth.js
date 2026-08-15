const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ADMIN_SECRET = process.env.ADMIN_SECRET; // setup/recovery key only — never the day-to-day password

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

async function getStoredHash(){
  const { data } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  return data ? data.password_hash : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  try {
    const params = event.queryStringParameters || {};
    const action = params.action;

    // No auth required — the page needs to know which screen to show
    // (set a password for the first time, or log in with an existing one)
    // before any credentials have been provided.
    if (event.httpMethod === 'GET' && action === 'status') {
      const hash = await getStoredHash();
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ hasPassword: !!hash }) };
    }

    if (event.httpMethod === 'POST' && action === 'login') {
      const body = JSON.parse(event.body || '{}');
      const hash = await getStoredHash();
      if (!hash) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No password set yet — use setup first.' }) };
      const valid = await bcrypt.compare(body.password || '', hash);
      return { statusCode: valid ? 200 : 401, headers: CORS, body: JSON.stringify({ ok: valid }) };
    }

    // Setup doubles as recovery: works to claim a password for the first
    // time, AND to reset a forgotten one later — both cases just need the
    // real ADMIN_SECRET, which only the real admin has via Netlify.
    if (event.httpMethod === 'POST' && action === 'setup') {
      const body = JSON.parse(event.body || '{}');
      if (!ADMIN_SECRET || body.bootstrap_secret !== ADMIN_SECRET) {
        return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Incorrect setup key.' }) };
      }
      if (!body.new_password || body.new_password.length < 8) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Password must be at least 8 characters.' }) };
      }
      const newHash = await bcrypt.hash(body.new_password, 10);
      await supabase.from('admin_auth').update({ password_hash: newHash, updated_at: new Date().toISOString() }).eq('id', 1);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // Pure self-service — proves identity with the CURRENT password, no
    // Netlify access needed at all.
    if (event.httpMethod === 'POST' && action === 'change') {
      const body = JSON.parse(event.body || '{}');
      const hash = await getStoredHash();
      if (!hash) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No password set yet.' }) };
      const valid = await bcrypt.compare(body.current_password || '', hash);
      if (!valid) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Current password is incorrect.' }) };
      if (!body.new_password || body.new_password.length < 8) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'New password must be at least 8 characters.' }) };
      }
      const newHash = await bcrypt.hash(body.new_password, 10);
      await supabase.from('admin_auth').update({ password_hash: newHash, updated_at: new Date().toISOString() }).eq('id', 1);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    console.error('admin-auth error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

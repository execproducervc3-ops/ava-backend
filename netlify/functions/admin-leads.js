// Admin: businesses that asked to be listed on AVA (from the "List my business" form).
// GET  ?action=list                       -> the newest 300 sign-ups
// POST ?action=update  {id, status, notes} -> mark one as new / contacted / onboarded / declined
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const STATUSES = ['new', 'contacted', 'onboarded', 'declined'];
const reply = (code, obj) => ({ statusCode: code, headers: CORS, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const provided = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'];
  const { data: authRow } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  const hash = authRow ? authRow.password_hash : null;
  if (!(hash && provided && await bcrypt.compare(provided, hash))) return reply(401, { error: 'Unauthorized' });

  const action = (event.queryStringParameters || {}).action || 'list';
  try {
    if (action === 'list') {
      const { data, error } = await supabase.from('business_leads')
        .select('id, created_at, business_name, contact_name, phone, email, island, offering, status, notes')
        .order('created_at', { ascending: false }).limit(300);
      if (error) throw error;
      return reply(200, { results: data || [] });
    }
    if (action === 'update' && event.httpMethod === 'POST') {
      let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Bad request.' }); }
      if (!/^[0-9a-f-]{36}$/i.test(String(b.id || ''))) return reply(400, { error: 'Bad id.' });
      const patch = {};
      if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) return reply(400, { error: 'Bad status.' });
        patch.status = b.status;
      }
      if (b.notes !== undefined) patch.notes = String(b.notes).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, 1000);
      if (!Object.keys(patch).length) return reply(400, { error: 'Nothing to change.' });
      const { error } = await supabase.from('business_leads').update(patch).eq('id', b.id);
      if (error) throw error;
      return reply(200, { ok: true });
    }
    return reply(400, { error: 'Unknown action.' });
  } catch (err) {
    console.error('admin-leads error:', err.message);
    return reply(500, { error: 'Something went wrong.' });
  }
};

const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  // Every action requires the admin's own chosen password, checked against
  // its stored hash — not a raw env-var comparison anymore.
  const providedPassword = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'];
  const { data: authRow } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  const storedHash = authRow ? authRow.password_hash : null;
  const isValid = storedHash && providedPassword && await bcrypt.compare(providedPassword, storedHash);
  if (!isValid) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const params = event.queryStringParameters || {};
    const action = params.action;

    if (event.httpMethod === 'GET' && action === 'search') {
      const q = (params.q || '').trim();
      if (!q) return { statusCode: 200, headers: CORS, body: JSON.stringify({ results: [] }) };
      const { data, error } = await supabase
        .from('directory_listings')
        .select('id, name, island, category, is_top_pick, top_pick_note')
        .ilike('name', `%${q}%`)
        .limit(10);
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ results: data || [] }) };
    }

    if (event.httpMethod === 'GET' && action === 'list') {
      const { data, error } = await supabase
        .from('sponsored_placements')
        .select('id, listing_id, photo_url, blurb, target_url, active, created_at, directory_listings(name, island)')
        .order('active', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ results: data || [] }) };
    }

    if (event.httpMethod === 'POST' && action === 'create') {
      const body = JSON.parse(event.body || '{}');
      if (!body.listing_id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'listing_id is required' }) };
      }
      const { data, error } = await supabase.from('sponsored_placements').insert({
        listing_id: body.listing_id,
        photo_url: body.photo_url || null,
        blurb: body.blurb || null,
        target_url: body.target_url || null,
        active: true,
      }).select().single();
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ created: data }) };
    }

    if (event.httpMethod === 'POST' && action === 'toggle') {
      const body = JSON.parse(event.body || '{}');
      if (!body.id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };
      }
      const { error } = await supabase.from('sponsored_placements').update({ active: !!body.active }).eq('id', body.id);
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    if (event.httpMethod === 'POST' && action === 'delete') {
      const body = JSON.parse(event.body || '{}');
      if (!body.id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };
      }
      const { error } = await supabase.from('sponsored_placements').delete().eq('id', body.id);
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    console.error('admin-sponsors error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

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

  const providedPassword = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'];
  const { data: authRow } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  const storedHash = authRow ? authRow.password_hash : null;
  const isValid = storedHash && providedPassword && await bcrypt.compare(providedPassword, storedHash);
  if (!isValid) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const params = event.queryStringParameters || {};
  const action = params.action;

  try {
    if (event.httpMethod === 'POST' && action === 'add') {
      const body = JSON.parse(event.body || '{}');
      const { category, name, address, island, phone, website } = body;
      if (!category || !name) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'category and name are required' }) };
      }

      const { data, error } = await supabase.from('directory_listings').insert({
        category, name,
        address: address || null,
        island: island || null,
        phone: phone || null,
        website: website || null,
        source: 'curated',
        status: 'active',
        verified_by: 'human',
        last_verified_at: new Date().toISOString(),
      }).select();
      if (error) throw error;

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, listing: data[0] }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    console.error('admin-directory error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

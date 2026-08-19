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
    if (event.httpMethod === 'GET' && action === 'list_empty') {
      // Businesses added but with zero linked price submissions — invisible
      // to the "Edit retail listings" search specifically because that
      // searches through retail_offers, not directory_listings directly.
      const { data: allListings, error: listErr } = await supabase
        .from('directory_listings')
        .select('id, name, category, island, address, phone, source, created_at')
        .eq('status', 'active')
        .order('created_at', { ascending: false });
      if (listErr) throw listErr;

      const { data: offerListingIds, error: offerErr } = await supabase
        .from('retail_offers')
        .select('listing_id');
      if (offerErr) throw offerErr;

      const hasOffers = new Set((offerListingIds || []).map(o => o.listing_id));
      const emptyListings = (allListings || []).filter(l => !hasOffers.has(l.id));

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ results: emptyListings }) };
    }

    if (event.httpMethod === 'POST' && action === 'delete_empty') {
      const body = JSON.parse(event.body || '{}');
      if (!body.listing_id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'listing_id is required' }) };
      }

      // Real safety check, not just trusting the frontend's list was
      // accurate at click time — refuse to delete if this listing has
      // picked up a submission since the list was last loaded.
      const { data: offers } = await supabase.from('retail_offers').select('id').eq('listing_id', body.listing_id).limit(1);
      if (offers && offers.length) {
        return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'This business now has price submissions — refresh the list and use "Delete entire retailer" instead.' }) };
      }

      const { error: delErr } = await supabase.from('directory_listings').delete().eq('id', body.listing_id);
      if (delErr) throw delErr;

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

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

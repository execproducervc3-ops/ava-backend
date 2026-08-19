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

  try {
    const params = event.queryStringParameters || {};
    const action = params.action;

    if (event.httpMethod === 'GET' && action === 'list') {
      const { data: queueRows, error: queueErr } = await supabase
        .from('review_queue')
        .select('id, reference_id, reason, status, created_at')
        .eq('item_type', 'submission')
        .eq('status', 'pending')
        .order('created_at', { ascending: true });
      if (queueErr) throw queueErr;
      if (!queueRows || !queueRows.length) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ results: [] }) };
      }

      const offerIds = queueRows.map(q => q.reference_id);
      const { data: offers } = await supabase
        .from('retail_offers')
        .select('id, item_name, price, unit, standard_unit_type, price_per_standard_unit, listing_id, review_status')
        .in('id', offerIds);
      const offerMap = Object.fromEntries((offers || []).map(o => [o.id, o]));

      const listingIds = [...new Set((offers || []).map(o => o.listing_id))];
      const { data: listings } = await supabase.from('directory_listings').select('id, name, category, subscription_tier').in('id', listingIds);
      const listingMap = Object.fromEntries((listings || []).map(l => [l.id, l]));

      const results = queueRows
        .filter(q => offerMap[q.reference_id]) // guard against a stale queue row whose offer somehow doesn't exist
        .map(q => {
          const offer = offerMap[q.reference_id];
          const listing = listingMap[offer.listing_id];
          return {
            queue_id: q.id,
            offer_id: offer.id,
            listing_id: offer.listing_id,
            reason: q.reason,
            retailer: (listing && listing.name) || 'Unknown retailer',
            category: listing ? listing.category : null,
            subscription_tier: listing ? listing.subscription_tier : 'free',
            item_name: offer.item_name,
            price: offer.price,
            unit: offer.unit,
          };
        });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ results }) };
    }

    if (event.httpMethod === 'POST' && action === 'publish') {
      const body = JSON.parse(event.body || '{}');
      if (!body.queue_id || !body.offer_id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'queue_id and offer_id are required' }) };
      }
      // Corrections happen quietly — the retailer's own item_name/price/unit
      // just gets updated in place, no notification, no separate audit log.
      const updates = { review_status: 'approved' };
      if (body.item_name !== undefined) updates.item_name = body.item_name;
      if (body.price !== undefined) updates.price = body.price;
      if (body.unit !== undefined) updates.unit = body.unit;

      const { error: updateErr } = await supabase.from('retail_offers').update(updates).eq('id', body.offer_id);
      if (updateErr) throw updateErr;

      await supabase.from('review_queue').update({ status: 'approved', resolved_at: new Date().toISOString() }).eq('id', body.queue_id);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    if (event.httpMethod === 'POST' && action === 'reject') {
      const body = JSON.parse(event.body || '{}');
      if (!body.queue_id || !body.offer_id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'queue_id and offer_id are required' }) };
      }
      await supabase.from('retail_offers').update({ review_status: 'rejected' }).eq('id', body.offer_id);
      await supabase.from('review_queue').update({ status: 'rejected', resolved_at: new Date().toISOString() }).eq('id', body.queue_id);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    console.error('admin-review error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

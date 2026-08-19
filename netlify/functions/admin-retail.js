const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// Same tested conversion tables and logic as telegram-webhook.js's
// computeNormalization — duplicated intentionally, matching this codebase's
// existing pattern of small, self-contained functions per file.
const WEIGHT_TO_LB = { lb:1, lbs:1, pound:1, pounds:1, kg:2.20462, kgs:2.20462, kilogram:2.20462, kilograms:2.20462, g:0.00220462, gram:0.00220462, grams:0.00220462, oz:0.0625, ounce:0.0625, ounces:0.0625 };
const VOLUME_TO_GALLON = { gallon:1, gallons:1, gal:1, liter:0.264172, liters:0.264172, litre:0.264172, litres:0.264172, l:0.264172, floz:0.0078125 };

function parseQuantityUnit(unitText){
  if(!unitText) return null;
  const text = unitText.toLowerCase().trim();
  const match = text.match(/(\d+(?:\.\d+)?)\s*(lbs?|pounds?|kgs?|kilograms?|g|grams?|oz|ounces?|gallons?|gal|liters?|litres?|l|fl\s*oz)\b/);
  if(!match) return null;
  const qty = parseFloat(match[1]);
  const unitToken = match[2].replace(/\s+/g, '');
  if(WEIGHT_TO_LB[unitToken] !== undefined) return { type: 'weight_lb', qtyInStandardUnit: qty * WEIGHT_TO_LB[unitToken] };
  if(VOLUME_TO_GALLON[unitToken] !== undefined) return { type: 'volume_gallon', qtyInStandardUnit: qty * VOLUME_TO_GALLON[unitToken] };
  return null;
}

function computeNormalization(price, unitText){
  const parsed = parseQuantityUnit(unitText);
  if(!parsed || !parsed.qtyInStandardUnit || parsed.qtyInStandardUnit <= 0) return { standard_unit_type: null, price_per_standard_unit: null };
  return { standard_unit_type: parsed.type, price_per_standard_unit: +(price / parsed.qtyInStandardUnit).toFixed(4) };
}

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

    if (event.httpMethod === 'GET' && action === 'list_photos') {
      // Tracks retailer-uploaded photos specifically — mainly promotional
      // submissions (sale events, back-to-school, etc.), not a full product
      // catalog. Joined with directory_listings for the retailer name, most
      // recent first, so admins can see what's actually been coming in.
      const { data, error } = await supabase
        .from('retail_offers')
        .select('id, item_name, price, unit, photo_url, created_at, valid_until, directory_listings(name, island)')
        .not('photo_url', 'is', null)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;

      const results = (data || []).map(r => ({
        id: r.id,
        item_name: r.item_name,
        price: r.price,
        unit: r.unit,
        photo_url: r.photo_url,
        created_at: r.created_at,
        valid_until: r.valid_until,
        retailer_name: r.directory_listings ? r.directory_listings.name : null,
        island: r.directory_listings ? r.directory_listings.island : null,
      }));

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ results }) };
    }

    if (event.httpMethod === 'GET' && action === 'search') {
      const q = (params.q || '').trim();
      if (!q) return { statusCode: 200, headers: CORS, body: JSON.stringify({ results: [] }) };

      const { data: offers, error } = await supabase
        .from('retail_offers')
        .select('id, listing_id, item_name, price, unit, standard_unit_type, price_per_standard_unit, review_status, created_at')
        .or(`item_name.ilike.%${q}%`)
        .order('created_at', { ascending: false })
        .limit(25);
      if (error) throw error;
      if (!offers || !offers.length) return { statusCode: 200, headers: CORS, body: JSON.stringify({ results: [] }) };

      // Also allow searching by retailer name, not just item name — merge both result sets
      const { data: listingMatches } = await supabase
        .from('directory_listings')
        .select('id, name')
        .ilike('name', `%${q}%`);
      let extraOffers = [];
      if (listingMatches && listingMatches.length) {
        const ids = listingMatches.map(l => l.id);
        const { data: byRetailer } = await supabase
          .from('retail_offers')
          .select('id, listing_id, item_name, price, unit, standard_unit_type, price_per_standard_unit, review_status, created_at')
          .in('listing_id', ids)
          .order('created_at', { ascending: false })
          .limit(25);
        extraOffers = byRetailer || [];
      }

      const merged = [...offers, ...extraOffers.filter(e => !offers.some(o => o.id === e.id))];
      const listingIds = [...new Set(merged.map(o => o.listing_id))];
      const { data: listings } = await supabase.from('directory_listings').select('id, name').in('id', listingIds);
      const listingMap = Object.fromEntries((listings || []).map(l => [l.id, l.name]));

      const results = merged.map(o => ({ ...o, retailer: listingMap[o.listing_id] || 'Unknown retailer' }));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ results }) };
    }

    if (event.httpMethod === 'POST' && action === 'update') {
      const body = JSON.parse(event.body || '{}');
      if (!body.id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };
      }
      const updates = {};
      if (body.item_name !== undefined) updates.item_name = body.item_name;
      if (body.price !== undefined) updates.price = body.price;
      if (body.unit !== undefined) updates.unit = body.unit;

      // Recompute the normalized comparison whenever price or unit changes —
      // an edited entry should never silently carry a stale per-lb figure.
      if (body.price !== undefined || body.unit !== undefined) {
        const { data: current } = await supabase.from('retail_offers').select('price, unit').eq('id', body.id).maybeSingle();
        const effectivePrice = body.price !== undefined ? body.price : (current ? current.price : null);
        const effectiveUnit = body.unit !== undefined ? body.unit : (current ? current.unit : null);
        const normalized = computeNormalization(effectivePrice, effectiveUnit);
        updates.standard_unit_type = normalized.standard_unit_type;
        updates.price_per_standard_unit = normalized.price_per_standard_unit;
      }

      const { error } = await supabase.from('retail_offers').update(updates).eq('id', body.id);
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    if (event.httpMethod === 'POST' && action === 'delete') {
      const body = JSON.parse(event.body || '{}');
      if (!body.id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };
      }
      const { error } = await supabase.from('retail_offers').delete().eq('id', body.id);
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    if (event.httpMethod === 'POST' && action === 'delete_retailer') {
      const body = JSON.parse(event.body || '{}');
      if (!body.listing_id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'listing_id is required' }) };
      }

      // Full real dependency chain, none of it cascading automatically:
      // submission_draft -> retailer_profile -> directory_listings.
      // "Completely remove them and all their data" means actually deleting
      // retailer_profile, not just disconnecting it — which means clearing
      // submission_draft first, since IT references retailer_profile without
      // cascade too. Get this order wrong and the delete fails outright.
      const { data: profiles, error: profileFetchErr } = await supabase
        .from('retailer_profile')
        .select('telegram_user_id')
        .eq('directory_listing_id', body.listing_id);
      if (profileFetchErr) throw profileFetchErr;

      for (const profile of (profiles || [])) {
        const { error: draftErr } = await supabase.from('submission_draft').delete().eq('retailer_telegram_id', profile.telegram_user_id);
        if (draftErr) throw draftErr;
      }

      const { error: profileDeleteErr } = await supabase.from('retailer_profile').delete().eq('directory_listing_id', body.listing_id);
      if (profileDeleteErr) throw profileDeleteErr;

      // Everything else (retail_offers, sponsored_placements, taxi_service_details,
      // showings, item_listings) cascades automatically on this delete.
      const { error } = await supabase.from('directory_listings').delete().eq('id', body.listing_id);
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    console.error('admin-retail error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

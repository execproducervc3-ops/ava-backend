const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { type, product_name } = body;

  if (type !== 'retail_price') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unsupported query type. Currently only "retail_price" is implemented.' }) };
  }
  if (!product_name || !product_name.trim()) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'product_name is required' }) };
  }

  try {
    // Step 1: find canonical products matching the name (fuzzy, since "chicken tacos"
    // and "Chicken Taco" should both resolve to the same thing)
    const { data: products, error: prodErr } = await supabase
      .from('canonical_products')
      .select('id, name')
      .ilike('name', `%${product_name.trim()}%`);
    if (prodErr) throw prodErr;

    if (!products || !products.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ results: [], note: "No matching product found in AVA's database yet — this may not have been submitted by any retailer." }) };
    }
    const productIds = products.map(p => p.id);

    // Step 2: all current offers for those products, cheapest-per-standard-unit
    // first — matching the exact same normalization already proven in
    // queryRetailPriceDB, so a 10kg bag and a 5lb bag compare fairly rather
    // than just sorting by raw price. Also restricted to vetted listings only,
    // excluding anything still pending review or already rejected.
    const { data: offers, error: offerErr } = await supabase
      .from('retail_offers')
      .select('item_name, price, unit, standard_unit_type, price_per_standard_unit, photo_url, listing_id, created_at')
      .in('canonical_product_id', productIds)
      .in('review_status', ['auto_published', 'approved'])
      .order('price_per_standard_unit', { ascending: true, nullsFirst: false })
      .order('price', { ascending: true });
    if (offerErr) throw offerErr;

    if (!offers || !offers.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ results: [], note: 'That product exists in the database but no retailer currently has an offer for it.' }) };
    }

    // Step 3: attach retailer names/locations
    const listingIds = [...new Set(offers.map(o => o.listing_id))];
    const { data: listings, error: listErr } = await supabase
      .from('directory_listings')
      .select('id, name, island, parish, address, phone')
      .in('id', listingIds);
    if (listErr) throw listErr;
    const listingMap = Object.fromEntries((listings || []).map(l => [l.id, l]));

    const results = offers.map(o => ({
      retailer: (listingMap[o.listing_id] && listingMap[o.listing_id].name) || 'Unknown retailer',
      island: (listingMap[o.listing_id] && listingMap[o.listing_id].island) || null,
      parish: (listingMap[o.listing_id] && listingMap[o.listing_id].parish) || null,
      address: (listingMap[o.listing_id] && listingMap[o.listing_id].address) || null,
      phone: (listingMap[o.listing_id] && listingMap[o.listing_id].phone) || null,
      item_name: o.item_name,
      price: o.price,
      unit: o.unit,
      standard_unit_type: o.standard_unit_type,
      price_per_standard_unit: o.price_per_standard_unit,
      photo_url: o.photo_url,
      submitted_at: o.created_at,
    }));

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ results }) };
  } catch (err) {
    console.error('query-data error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal error looking up that data.' }) };
  }
};

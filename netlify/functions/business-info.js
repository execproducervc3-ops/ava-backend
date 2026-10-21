// Public: details and current postings for one business (the panel on the main page).
const { createClient } = require('@supabase/supabase-js');
const { getBusinessPostings } = require('./business-data');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const H = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' };

exports.handler = async (event) => {
  const id = String((event.queryStringParameters || {}).id || '');
  if (!/^[0-9A-Za-z-]{1,64}$/.test(id)) return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'not found' }) };
  try {
    const { data: l, error } = await supabase.from('directory_listings')
      .select('id, name, address, island, parish, phone, website, category, photo_url, is_top_pick, top_pick_note, subscribed_until')
      .eq('id', id).eq('status', 'active').maybeSingle();
    if (error) throw error;
    if (!l) return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'not found' }) };
    const posts = await getBusinessPostings(supabase, l);
    const { subscribed_until, ...business } = l;
    return { statusCode: 200, headers: H, body: JSON.stringify({ business, ...posts }) };
  } catch (e) {
    console.error('business-info error:', e.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'Could not load this business right now.' }) };
  }
};

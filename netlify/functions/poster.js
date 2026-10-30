// Public: a printable poster (PNG) with a QR code to one business's AVA page.
//   /.netlify/functions/poster?id=<listing id>&size=a4|square
const { createClient } = require('@supabase/supabase-js');
const { renderPoster } = require('./poster-core');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const text = (code, msg) => ({ statusCode: code, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: msg });

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const id = String(q.id || '');
  if (!/^[0-9A-Za-z-]{1,64}$/.test(id)) return text(404, 'Not found');
  const size = q.size === 'square' ? 'square' : 'a4';
  try {
    const { data: l, error } = await supabase.from('directory_listings')
      .select('id, name, logo_url, menu_image_url, subscribed_until').eq('id', id).eq('status', 'active').maybeSingle();
    if (error) throw error;
    if (!l) return text(404, 'Not found');
    const { count } = await supabase.from('retail_offers').select('id', { count: 'exact', head: true }).eq('listing_id', id).in('review_status', ['auto_published', 'approved']);
    const png = await renderPoster({ id: l.id, name: l.name, logo_url: l.logo_url, hasMenu: !!l.menu_image_url, hasPrices: (count || 0) > 0 }, size);
    return { statusCode: 200, isBase64Encoded: true, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', 'Content-Disposition': `inline; filename="ava-poster-${size}.png"` }, body: png.toString('base64') };
  } catch (e) {
    console.error('poster error:', e.message);
    return text(500, 'Could not make the poster right now.');
  }
};

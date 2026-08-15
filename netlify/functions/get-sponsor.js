const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async () => {
  try {
    const { data: placement } = await supabase
      .from('sponsored_placements')
      .select('id, listing_id, photo_url, blurb, target_url')
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // No active sponsor — this is a normal, expected state, not an error.
    // The homepage should just not render the card at all.
    if (!placement) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ sponsor: null }) };
    }

    const { data: listing } = await supabase
      .from('directory_listings')
      .select('name, island, address')
      .eq('id', placement.listing_id)
      .maybeSingle();

    // Photo priority: a dedicated ad photo if one was submitted, otherwise
    // fall back to this business's most recent price-tag photo — so nobody
    // is required to do a second upload just to appear here.
    let photoUrl = placement.photo_url;
    if (!photoUrl) {
      const { data: recentOffer } = await supabase
        .from('retail_offers')
        .select('photo_url')
        .eq('listing_id', placement.listing_id)
        .not('photo_url', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      photoUrl = recentOffer ? recentOffer.photo_url : null;
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        sponsor: {
          name: listing ? listing.name : 'Local Business',
          location: listing ? [listing.address, listing.island].filter(Boolean).join(', ') : null,
          blurb: placement.blurb,
          photoUrl,
          targetUrl: placement.target_url,
        },
      }),
    };
  } catch (err) {
    console.error('get-sponsor error:', err);
    // A broken sponsor lookup should never break the homepage itself —
    // fail quiet, same as "no active sponsor."
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ sponsor: null }) };
  }
};

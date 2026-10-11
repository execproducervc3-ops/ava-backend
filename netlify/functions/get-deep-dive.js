const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// Read-only, public, and deliberately boring: returns one already-reviewed,
// published long-form document by its slug. It never calls Claude, so it can't
// time out the way a conversational "tell me the whole story" request can.
// Draft and pending_review documents can never be returned from here.
exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if(event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const slug = ((event.queryStringParameters || {}).slug || '').trim();
  if(!/^[a-z0-9-]{1,100}$/.test(slug)){
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'A valid slug is required.' }) };
  }

  try{
    const { data, error } = await supabase
      .from('knowledge_deep_dives')
      .select('slug, title, body, source_url, last_verified_at')
      .eq('slug', slug)
      .eq('review_status', 'published')
      .maybeSingle();
    if(error) throw error;
    if(!data) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'No published document found.' }) };
    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=300' },
      body: JSON.stringify({ document: data }),
    };
  } catch(err){
    console.error('get-deep-dive error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not load that document right now.' }) };
  }
};

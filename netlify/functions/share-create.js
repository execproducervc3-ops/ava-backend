// POST { payload, sig } -> { id, url }
// Stores a shared answer, but only if the server itself signed it when AVA wrote it.
const { createClient } = require('@supabase/supabase-js');
const core = require('./share-core');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (statusCode, obj) => ({ statusCode, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if(event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  try{
    if((event.body || '').length > 200000) return reply(413, { error: 'Too large to share.' });
    const { payload, sig } = JSON.parse(event.body || '{}');
    if(typeof payload !== 'string' || !core.verifySig(payload, sig)) return reply(400, { error: 'This answer cannot be shared.' });
    let data;
    try{ data = JSON.parse(payload); } catch(e){ return reply(400, { error: 'This answer cannot be shared.' }); }
    if(!data || typeof data.text !== 'string') return reply(400, { error: 'This answer cannot be shared.' });

    const id = core.shareId(sig);
    const { error } = await supabase.from('shared_answers')
      .upsert({ id, question: String(data.q || '').slice(0, 300) || null, payload: data }, { onConflict: 'id', ignoreDuplicates: true });
    if(error) throw error;
    return reply(200, { id, url: `${core.SITE}/a/${id}` });
  } catch(err){
    console.error('share-create error:', err);
    return reply(500, { error: 'Could not create a share link right now.' });
  }
};

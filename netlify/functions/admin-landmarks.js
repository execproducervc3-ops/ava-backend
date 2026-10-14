// Admin API for the landmarks AVA uses when giving directions.
// Add a landmark by name; the place is found on the map automatically.
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });
const KINDS = ['bank', 'church', 'gas_station', 'school', 'supermarket', 'shop', 'restaurant', 'bar', 'pharmacy', 'police', 'clinic', 'hospital', 'market', 'post_office', 'hotel', 'junction', 'bridge', 'roundabout', 'other'];
const ISLANDS = ['Saint Vincent', 'Bequia', 'Mustique', 'Canouan', 'Mayreau', 'Union Island', 'Palm Island', 'Petit Saint Vincent', 'Tobago Cays'];
const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;

async function checkAuth(pw){
  const { data } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  const hash = data ? data.password_hash : null;
  return !!(hash && pw && await bcrypt.compare(pw, hash));
}

async function geocode(query){
  if(!GOOGLE_KEY) throw new Error('Map lookup is not configured.');
  const params = new URLSearchParams({
    input: query, inputtype: 'textquery', fields: 'geometry,name,formatted_address',
    locationbias: 'circle:60000@13.25,-61.20', key: GOOGLE_KEY,
  });
  const res = await fetch(`https://maps.googleapis.com/maps/api/place/findplacefromtext/json?${params}`);
  const data = await res.json();
  const c = data.candidates && data.candidates[0];
  if(!c) return null;
  const { lat, lng } = c.geometry.location;
  // SVG sanity box, so a wrong match elsewhere in the world is refused.
  if(lat < 12.5 || lat > 13.5 || lng < -61.6 || lng > -60.9) return null;
  return { lat, lng, found_as: c.name, address: c.formatted_address };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const pw = (event.headers || {})['x-admin-secret'] || (event.headers || {})['X-Admin-Secret'];
  if (!(await checkAuth(pw))) return json(401, { error: 'Unauthorized' });

  try {
    const params = event.queryStringParameters || {};
    const action = params.action;

    if (event.httpMethod === 'GET' && action === 'list') {
      const { data, error } = await supabase.from('landmarks').select('id, name, kind, island, lat, lng, notes, active, created_at')
        .order('created_at', { ascending: false }).limit(500);
      if (error) throw error;
      return json(200, { landmarks: data || [], kinds: KINDS, islands: ISLANDS });
    }

    if (event.httpMethod === 'POST' && action === 'add') {
      const body = JSON.parse(event.body || '{}');
      const name = String(body.name || '').trim();
      const kind = KINDS.includes(body.kind) ? body.kind : null;
      const island = ISLANDS.includes(body.island) ? body.island : null;
      if (!name || name.length > 120) return json(400, { error: 'A name is required.' });
      if (!kind) return json(400, { error: 'Pick what kind of landmark it is.' });
      if (!island) return json(400, { error: 'Pick the island.' });

      let lat = Number(body.lat), lng = Number(body.lng);
      let found = null;
      if (!(Number.isFinite(lat) && Number.isFinite(lng) && body.lat !== '' && body.lng !== '')) {
        const where = String(body.near || '').trim();
        found = await geocode(`${name}${where ? ', ' + where : ''}, ${island}, Saint Vincent and the Grenadines`);
        if (!found) return json(404, { error: `Could not find "${name}" on the map. Add a nearby town or street in the "near" box, or enter latitude and longitude.` });
        lat = found.lat; lng = found.lng;
      }
      const { data, error } = await supabase.from('landmarks')
        .insert({ name, kind, island, lat, lng, notes: body.notes ? String(body.notes).slice(0, 300) : null })
        .select('id, name, kind, island, lat, lng').single();
      if (error) {
        if (/duplicate|unique/i.test(error.message)) return json(409, { error: 'That landmark is already saved for this island.' });
        throw error;
      }
      return json(200, { ok: true, landmark: data, found_as: found ? `${found.found_as} (${found.address})` : null });
    }

    if (event.httpMethod === 'POST' && action === 'delete') {
      const body = JSON.parse(event.body || '{}');
      if (!body.id) return json(400, { error: 'id is required' });
      const { error } = await supabase.from('landmarks').delete().eq('id', body.id);
      if (error) throw error;
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('admin-landmarks error:', err);
    return json(500, { error: err.message });
  }
};

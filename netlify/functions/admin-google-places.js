// Admin API: search Google Maps for places and save the ones AVA should use as direction landmarks.
// Saved for good: Google's place ID and your own label. Coordinates are refreshed at least every 30 days.
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const KEY = process.env.GOOGLE_PLACES_API_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });
const KINDS = ['bank', 'church', 'gas_station', 'school', 'supermarket', 'shop', 'restaurant', 'bar', 'pharmacy', 'police', 'clinic', 'hospital', 'market', 'post_office', 'hotel', 'junction', 'bridge', 'roundabout', 'other'];
const ISLANDS = ['Saint Vincent', 'Bequia', 'Mustique', 'Canouan', 'Mayreau', 'Union Island', 'Palm Island', 'Petit Saint Vincent', 'Tobago Cays'];
const BOX = { low: { latitude: 12.50, longitude: -61.50 }, high: { latitude: 13.40, longitude: -61.05 } };
const DAY = 86400000;

async function checkAuth(pw){
  const { data } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  const hash = data ? data.password_hash : null;
  return !!(hash && pw && await bcrypt.compare(pw, hash));
}

async function searchGoogle(query, island){
  if(!KEY) throw new Error('Google Places is not configured (GOOGLE_PLACES_API_KEY).');
  const q = /svg|vincent|grenadines/i.test(query) || (island && query.toLowerCase().includes(island.toLowerCase())) ? query : `${query}${island ? ', ' + island : ''}, Saint Vincent and the Grenadines`;
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.primaryTypeDisplayName,places.businessStatus' },
    body: JSON.stringify({ textQuery: q, maxResultCount: 10, locationRestriction: { rectangle: BOX } }),
  });
  if(!res.ok) throw new Error('Google replied ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 160));
  const data = await res.json();
  return (data.places || []).filter(p => p.businessStatus !== 'CLOSED_PERMANENTLY').map(p => ({
    place_id: p.id, name: p.displayName && p.displayName.text, address: p.formattedAddress,
    type: p.primaryTypeDisplayName && p.primaryTypeDisplayName.text, maps_url: p.googleMapsUri,
    lat: p.location && p.location.latitude, lng: p.location && p.location.longitude,
  }));
}

async function placeLocation(placeId){
  const res = await fetch('https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId), {
    headers: { 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'location,businessStatus' },
  });
  if(res.status === 404) return { gone: true };
  if(!res.ok) throw new Error('Google replied ' + res.status);
  const d = await res.json();
  if(d.businessStatus === 'CLOSED_PERMANENTLY') return { gone: true };
  return d.location ? { lat: d.location.latitude, lng: d.location.longitude } : null;
}

exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const pw = (event.headers || {})['x-admin-secret'] || (event.headers || {})['X-Admin-Secret'];
  if(!(await checkAuth(pw))) return json(401, { error: 'Unauthorized' });
  try{
    const action = (event.queryStringParameters || {}).action;
    const body = event.httpMethod === 'POST' ? JSON.parse(event.body || '{}') : {};

    if(event.httpMethod === 'GET' && action === 'list'){
      const { data, error } = await supabase.from('google_place_refs').select('id, place_id, label, kind, island, active, coords_fetched_at, created_at').order('created_at', { ascending: false }).limit(500);
      if(error) throw error;
      const cutoff = Date.now() - 25 * DAY;
      const expiring = (data || []).filter(r => r.active && (!r.coords_fetched_at || new Date(r.coords_fetched_at).getTime() < cutoff)).length;
      return json(200, { places: data || [], expiring, kinds: KINDS, islands: ISLANDS });
    }
    if(event.httpMethod === 'POST' && action === 'search'){
      const query = String(body.query || '').trim().slice(0, 120);
      if(query.length < 3) return json(400, { error: 'Type at least 3 letters.' });
      const island = ISLANDS.includes(body.island) ? body.island : '';
      const results = await searchGoogle(query, island);
      const { data: have } = await supabase.from('google_place_refs').select('place_id').in('place_id', results.map(r => r.place_id).concat(['-']));
      const saved = new Set((have || []).map(h => h.place_id));
      return json(200, { results: results.map(r => ({ ...r, saved: saved.has(r.place_id) })) });
    }
    if(event.httpMethod === 'POST' && action === 'add'){
      const label = String(body.label || '').trim().slice(0, 120);
      const placeId = String(body.place_id || '').trim();
      if(!label) return json(400, { error: 'Give it your own short label, e.g. "RBC bank on Halifax Street".' });
      if(!/^[\w-]{10,200}$/.test(placeId)) return json(400, { error: 'Missing Google place ID.' });
      const lat = Number(body.lat), lng = Number(body.lng);
      if(!(lat >= 12.5 && lat <= 13.5 && lng >= -61.6 && lng <= -60.9)) return json(400, { error: 'That place is outside Saint Vincent and the Grenadines.' });
      const row = { place_id: placeId, label, kind: KINDS.includes(body.kind) ? body.kind : 'other', island: ISLANDS.includes(body.island) ? body.island : null, lat, lng, coords_fetched_at: new Date().toISOString(), active: true };
      const { error } = await supabase.from('google_place_refs').upsert(row, { onConflict: 'place_id' });
      if(error) throw error;
      return json(200, { ok: true });
    }
    if(event.httpMethod === 'POST' && action === 'toggle'){
      const { error } = await supabase.from('google_place_refs').update({ active: !!body.active }).eq('id', Number(body.id));
      if(error) throw error;
      return json(200, { ok: true });
    }
    if(event.httpMethod === 'POST' && action === 'delete'){
      const { error } = await supabase.from('google_place_refs').delete().eq('id', Number(body.id));
      if(error) throw error;
      return json(200, { ok: true });
    }
    if(event.httpMethod === 'POST' && action === 'refresh'){
      if(!KEY) return json(500, { error: 'Google Places is not configured.' });
      const cutoff = new Date(Date.now() - 20 * DAY).toISOString();
      const { data: stale } = await supabase.from('google_place_refs').select('id, place_id').eq('active', true).or(`coords_fetched_at.is.null,coords_fetched_at.lt.${cutoff}`).limit(40);
      let updated = 0, closed = 0, failed = 0;
      for(const r of (stale || [])){
        try{
          const loc = await placeLocation(r.place_id);
          if(loc && loc.gone){ await supabase.from('google_place_refs').update({ active: false }).eq('id', r.id); closed++; }
          else if(loc){ await supabase.from('google_place_refs').update({ lat: loc.lat, lng: loc.lng, coords_fetched_at: new Date().toISOString() }).eq('id', r.id); updated++; }
          else failed++;
        }catch(e){ failed++; }
      }
      return json(200, { updated, closed, failed, checked: (stale || []).length });
    }
    return json(400, { error: 'Unknown action' });
  }catch(err){
    console.error('admin-google-places error:', err);
    return json(500, { error: String(err.message || err).slice(0, 300) });
  }
};

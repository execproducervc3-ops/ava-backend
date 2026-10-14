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
const osm = require('./osm-core');
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

    if (event.httpMethod === 'GET' && action === 'osm_query') {
      if (!osm.ISLAND_BOXES[params.island] || !osm.GROUPS[params.group]) return json(400, { error: 'Unknown island or group.' });
      return json(200, { query: osm.buildQuery(params.island, params.group, params.tile), tiles: osm.tileCount(params.island), endpoints: osm.OVERPASS, groups: osm.GROUP_NAMES });
    }

    if (event.httpMethod === 'POST' && action === 'osm_import') {
      const body = JSON.parse(event.body || '{}');
      const island = body.island, group = body.group;
      if (!osm.ISLAND_BOXES[island]) return json(400, { error: 'Pick an island that can be imported.' });
      if (!osm.GROUPS[group]) return json(400, { error: 'Unknown group.' });
      // The admin page normally fetches from OpenStreetMap itself and sends the
      // elements here; the server only fetches when none are supplied.
      const data = Array.isArray(body.elements)
        ? { elements: body.elements.slice(0, 1000) }
        : await osm.fetchOverpass(osm.buildQuery(island, group, body.tile));
      const rows = osm.parseElements(data, island);
      // Leave out what is already saved, and what was decided before.
      const { data: have } = await supabase.from('landmarks').select('name').eq('island', island);
      const haveSet = new Set((have || []).map(r => String(r.name).toLowerCase()));
      const fresh = rows.filter(r => !haveSet.has(r.name.toLowerCase()));
      let added = 0;
      if (fresh.length) {
        const { data: ins, error } = await supabase.from('landmark_candidates')
          .upsert(fresh, { onConflict: 'osm_ref', ignoreDuplicates: true }).select('id');
        if (error) throw error;
        added = (ins || []).length;
      }
      return json(200, { ok: true, found: rows.length, already_saved: rows.length - fresh.length, new_candidates: added });
    }

    if (event.httpMethod === 'GET' && action === 'osm_list') {
      let q = supabase.from('landmark_candidates').select('id, osm_ref, name, kind, island, lat, lng')
        .eq('status', 'pending').order('island').order('kind').order('name').limit(300);
      if (params.island) q = q.eq('island', params.island);
      if (params.kind) q = q.eq('kind', params.kind);
      const { data, error } = await q;
      if (error) throw error;
      const { count } = await supabase.from('landmark_candidates').select('id', { count: 'exact', head: true }).eq('status', 'pending');
      return json(200, { candidates: (data || []).map(c => ({ ...c, source_url: osm.osmUrl(c.osm_ref) })), pending_total: count || 0, import_islands: osm.IMPORT_ISLANDS, groups: osm.GROUP_NAMES });
    }

    if (event.httpMethod === 'POST' && (action === 'osm_approve' || action === 'osm_reject')) {
      const body = JSON.parse(event.body || '{}');
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Number.isFinite).slice(0, 300);
      if (!ids.length) return json(400, { error: 'Nothing selected.' });
      if (action === 'osm_reject') {
        const { error } = await supabase.from('landmark_candidates').update({ status: 'rejected' }).in('id', ids);
        if (error) throw error;
        return json(200, { ok: true, rejected: ids.length });
      }
      const { data: cands, error: ce } = await supabase.from('landmark_candidates').select('*').in('id', ids).eq('status', 'pending');
      if (ce) throw ce;
      let approved = 0, skipped = 0;
      for (const c of cands || []) {
        const { error } = await supabase.from('landmarks').insert({
          name: c.name, kind: c.kind, island: c.island, lat: c.lat, lng: c.lng,
          notes: `Source: (c) OpenStreetMap contributors (ODbL), ${osm.osmUrl(c.osm_ref)}`,
        });
        if (error && !/duplicate|unique/i.test(error.message)) throw error;
        if (error) skipped++; else approved++;
        await supabase.from('landmark_candidates').update({ status: 'approved' }).eq('id', c.id);
      }
      return json(200, { ok: true, approved, already_saved: skipped });
    }

    if (event.httpMethod === 'POST' && action === 'update') {
      const body = JSON.parse(event.body || '{}');
      if (!body.id) return json(400, { error: 'id is required' });
      const patch = {};
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name || name.length > 120) return json(400, { error: 'A name is required.' });
        patch.name = name;
      }
      if (body.kind !== undefined) { if (!KINDS.includes(body.kind)) return json(400, { error: 'Unknown kind.' }); patch.kind = body.kind; }
      if (body.island !== undefined) { if (!ISLANDS.includes(body.island)) return json(400, { error: 'Unknown island.' }); patch.island = body.island; }
      if (body.lat !== undefined || body.lng !== undefined) {
        const lat = Number(body.lat), lng = Number(body.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 12.5 || lat > 13.5 || lng < -61.6 || lng > -60.9) {
          return json(400, { error: 'Latitude and longitude must both be numbers inside Saint Vincent and the Grenadines.' });
        }
        patch.lat = lat; patch.lng = lng;
      }
      if (body.notes !== undefined) patch.notes = body.notes ? String(body.notes).slice(0, 300) : null;
      if (body.active !== undefined) patch.active = !!body.active;
      if (!Object.keys(patch).length) return json(400, { error: 'Nothing to change.' });
      const { data, error } = await supabase.from('landmarks').update(patch).eq('id', body.id)
        .select('id, name, kind, island, lat, lng, notes, active').maybeSingle();
      if (error) {
        if (/duplicate|unique/i.test(error.message)) return json(409, { error: 'Another landmark on that island already has that name.' });
        throw error;
      }
      if (!data) return json(404, { error: 'That landmark no longer exists.' });
      return json(200, { ok: true, landmark: data });
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

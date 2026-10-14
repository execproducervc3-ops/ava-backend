const bcrypt = require('bcryptjs');
const { runFinder, getSupabase } = require('./photo-core');
const supabase = getSupabase();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const AUTO_APPROVE_MIN_SCORE = 0.9;

function keyColumn(table) { return table === 'knowledge_deep_dives' ? 'slug' : 'id'; }
const TARGET_TABLES = ['points_of_interest', 'knowledge_deep_dives', 'guide_species'];

async function approveCandidate(c) {
  const col = keyColumn(c.target_table);
  const { error } = await supabase.from(c.target_table).update({
    photo_url: c.image_url, photo_credit: c.credit, photo_license: c.license, photo_source_url: c.source_url,
  }).eq(col, c.target_key);
  if (error) throw error;
  const now = new Date().toISOString();
  await supabase.from('photo_candidates').update({ status: 'approved', reviewed_at: now }).eq('id', c.id);
  await supabase.from('photo_candidates').update({ status: 'superseded', reviewed_at: now })
    .eq('target_table', c.target_table).eq('target_key', c.target_key).eq('status', 'pending');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const provided = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'];
  const { data: authRow } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  const hash = authRow ? authRow.password_hash : null;
  if (!(hash && provided && await bcrypt.compare(provided, hash))) return json(401, { error: 'Unauthorized' });

  try {
    const params = event.queryStringParameters || {};
    const action = params.action;

    if (event.httpMethod === 'GET' && action === 'list') {
      const page = Math.max(0, parseInt(params.page, 10) || 0);
      const size = 12;
      const { data: pend, error } = await supabase.from('photo_candidates').select('*').eq('status', 'pending').order('score', { ascending: false }).limit(1000);
      if (error) throw error;
      const groups = new Map();
      for (const c of pend || []) {
        const k = `${c.target_table}|${c.target_key}`;
        if (!groups.has(k)) groups.set(k, { target_table: c.target_table, target_key: c.target_key, candidates: [] });
        groups.get(k).candidates.push(c);
      }
      const all = [...groups.values()].sort((a, b) => b.candidates[0].score - a.candidates[0].score);
      const slice = all.slice(page * size, page * size + size);
      const poiIds = slice.filter(g => g.target_table === 'points_of_interest').map(g => g.target_key);
      const slugs = slice.filter(g => g.target_table === 'knowledge_deep_dives').map(g => g.target_key);
      const spIds = slice.filter(g => g.target_table === 'guide_species').map(g => g.target_key);
      const names = {};
      if (spIds.length) {
        const { data } = await supabase.from('guide_species').select('id, common_name, scientific_name').in('id', spIds);
        for (const r of data || []) names[`guide_species|${r.id}`] = { name: r.common_name, island: r.scientific_name };
      }
      if (poiIds.length) {
        const { data } = await supabase.from('points_of_interest').select('id, name, island').in('id', poiIds);
        for (const r of data || []) names[`points_of_interest|${r.id}`] = { name: r.name, island: r.island };
      }
      if (slugs.length) {
        const { data } = await supabase.from('knowledge_deep_dives').select('slug, title').in('slug', slugs);
        for (const r of data || []) names[`knowledge_deep_dives|${r.slug}`] = { name: r.title, island: null };
      }
      const results = slice.map(g => ({ ...g, ...(names[`${g.target_table}|${g.target_key}`] || { name: g.target_key, island: null }) }));
      return json(200, { total: all.length, page, page_size: size, results });
    }

    if (event.httpMethod === 'GET' && action === 'stats') {
      const count = async (table, build) => { const { count: n } = await build(supabase.from(table).select('*', { count: 'exact', head: true })); return n || 0; };
      const placesTotal = await count('points_of_interest', q => q.eq('active', true));
      const placesWith = await count('points_of_interest', q => q.eq('active', true).not('photo_url', 'is', null));
      const pending = await count('photo_candidates', q => q.eq('status', 'pending'));
      let speciesTotal = 0, speciesWith = 0;
      try {
        speciesTotal = await count('guide_species', q => q.eq('active', true));
        speciesWith = await count('guide_species', q => q.eq('active', true).not('photo_url', 'is', null));
      } catch (e) { /* before migration-054 */ }
      return json(200, { places_total: placesTotal, places_with_photo: placesWith, pending_candidates: pending, species_total: speciesTotal, species_with_photo: speciesWith });
    }

    if (event.httpMethod === 'POST' && action === 'run') {
      const body = JSON.parse(event.body || '{}');
      const limit = Math.min(10, Math.max(1, parseInt(body.limit, 10) || 8));
      const summary = await runFinder(supabase, fetch, { limit, budgetMs: 18000 });
      return json(200, { ok: true, ...summary });
    }

    if (event.httpMethod === 'POST' && (action === 'approve' || action === 'reject')) {
      const body = JSON.parse(event.body || '{}');
      if (!body.candidate_id) return json(400, { error: 'candidate_id is required' });
      const { data: c } = await supabase.from('photo_candidates').select('*').eq('id', body.candidate_id).maybeSingle();
      if (!c) return json(404, { error: 'Candidate not found' });
      if (c.status !== 'pending') return json(409, { error: 'That candidate was already handled.' });
      if (action === 'approve') await approveCandidate(c);
      else await supabase.from('photo_candidates').update({ status: 'rejected', reviewed_at: new Date().toISOString() }).eq('id', c.id);
      return json(200, { ok: true });
    }

    if (event.httpMethod === 'POST' && action === 'approve_best') {
      // One click for the strong matches: the top candidate per place, only if its score is high.
      const { data: pend } = await supabase.from('photo_candidates').select('*').eq('status', 'pending').gte('score', AUTO_APPROVE_MIN_SCORE).order('score', { ascending: false }).limit(1000);
      const done = new Set();
      let approved = 0;
      for (const c of pend || []) {
        const k = `${c.target_table}|${c.target_key}`;
        if (done.has(k)) continue;
        done.add(k);
        await approveCandidate(c);
        approved++;
      }
      return json(200, { ok: true, approved, min_score: AUTO_APPROVE_MIN_SCORE });
    }

    if (event.httpMethod === 'POST' && action === 'remove_photo') {
      const body = JSON.parse(event.body || '{}');
      if (!TARGET_TABLES.includes(body.target_table) || !body.target_key) return json(400, { error: 'target_table and target_key are required' });
      const { error } = await supabase.from(body.target_table).update({ photo_url: null, photo_credit: null, photo_license: null, photo_source_url: null }).eq(keyColumn(body.target_table), body.target_key);
      if (error) throw error;
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('admin-photos error:', err);
    return json(500, { error: err.message });
  }
};

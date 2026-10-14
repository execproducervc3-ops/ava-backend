const bcrypt = require('bcryptjs');
const { runFinder, getSupabase } = require('./photo-core');
const mirror = require('./photo-mirror');
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
  let url = c.image_url, mirrored = false;
  // Photos from sources other than Wikimedia are copied into AVA's own storage.
  if (c.provider && c.provider !== 'wikimedia') {
    try { url = await mirror.mirrorRemote(supabase, fetch, c.image_url, `${c.target_table}/${c.target_key}`); mirrored = true; }
    catch (e) { console.error('mirror failed, keeping the original link:', e.message); }
  }
  const { error } = await supabase.from(c.target_table).update({
    photo_url: url, photo_credit: c.credit, photo_license: c.license, photo_source_url: c.source_url,
  }).eq(col, c.target_key);
  if (error) throw error;
  const now = new Date().toISOString();
  await supabase.from('photo_candidates').update({ status: 'approved', reviewed_at: now }).eq('id', c.id);
  await supabase.from('photo_candidates').update({ status: 'superseded', reviewed_at: now })
    .eq('target_table', c.target_table).eq('target_key', c.target_key).eq('status', 'pending');
  return { mirrored };
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

    if (event.httpMethod === 'POST' && action === 'recheck') {
      // Search again, with every source, for everything that still has no photo.
      const cleared = {};
      for (const [table, label] of [['points_of_interest', 'places'], ['guide_species', 'species']]) {
        const { data, error } = await supabase.from(table).select('id').is('photo_url', null).not('photo_checked_at', 'is', null).limit(2000);
        if (error) { cleared[label] = 0; continue; }
        const ids = (data || []).map(r => r.id);
        if (ids.length) await supabase.from(table).update({ photo_checked_at: null }).in('id', ids);
        cleared[label] = ids.length;
      }
      return json(200, { ok: true, ...cleared });
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
      let extra = {};
      if (action === 'approve') extra = await approveCandidate(c);
      else await supabase.from('photo_candidates').update({ status: 'rejected', reviewed_at: new Date().toISOString() }).eq('id', c.id);
      return json(200, { ok: true, ...extra });
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

    if (event.httpMethod === 'GET' && action === 'targets') {
      const term = String(params.q || '').trim().replace(/[%,()]/g, ' ').slice(0, 60);
      if (term.length < 2) return json(200, { targets: [] });
      const [pois, spp] = await Promise.all([
        supabase.from('points_of_interest').select('id, name, island').eq('active', true).ilike('name', `%${term}%`).limit(10),
        supabase.from('guide_species').select('id, common_name, scientific_name').eq('active', true).or(`common_name.ilike.%${term}%,scientific_name.ilike.%${term}%`).limit(10),
      ]);
      const targets = [
        ...((pois.data) || []).map(r => ({ target_table: 'points_of_interest', target_key: r.id, name: r.name, sub: r.island })),
        ...((spp.data) || []).map(r => ({ target_table: 'guide_species', target_key: r.id, name: r.common_name, sub: r.scientific_name })),
      ];
      return json(200, { targets });
    }

    if (event.httpMethod === 'POST' && action === 'add_manual') {
      // Your own photo (or one you have permission to use). You supply the credit and the
      // licence or permission note; AVA shows the credit under the picture.
      const body = JSON.parse(event.body || '{}');
      if (!['points_of_interest', 'guide_species'].includes(body.target_table) || !body.target_key) return json(400, { error: 'Choose a place or species first.' });
      const credit = String(body.credit || '').trim();
      const licenseNote = String(body.license_note || '').trim();
      if (credit.length < 3 || credit.length > 200) return json(400, { error: 'Enter the credit to show under the photo (for example "Photo: Jane Doe").' });
      if (licenseNote.length < 3 || licenseNote.length > 200) return json(400, { error: 'Enter the licence or permission (for example "CC BY 4.0" or "Permission from the photographer, 13 Oct 2026").' });
      const sourceUrl = mirror.isPublicHttpUrl(String(body.source_url || '').trim()) ? String(body.source_url).trim() : null;
      let buf;
      try {
        if (body.image_base64) {
          buf = Buffer.from(String(body.image_base64).replace(/^data:[^,]*,/, ''), 'base64');
          if (buf.length > mirror.MAX_BYTES) return json(400, { error: 'That photo is too large. Use one under 4 MB.' });
        } else if (body.image_url) {
          buf = await mirror.downloadImage(fetch, String(body.image_url).trim(), { finderOnly: false });
        } else return json(400, { error: 'Choose a photo file or paste an image link.' });
        const col = keyColumn(body.target_table);
        const { data: target } = await supabase.from(body.target_table).select(col).eq(col, body.target_key).maybeSingle();
        if (!target) return json(404, { error: 'That place or species was not found.' });
        const url = await mirror.storeBuffer(supabase, buf, `${body.target_table}/${body.target_key}`);
        const { error } = await supabase.from(body.target_table).update({
          photo_url: url, photo_credit: credit, photo_license: licenseNote, photo_source_url: sourceUrl,
        }).eq(col, body.target_key);
        if (error) throw error;
        const now = new Date().toISOString();
        await supabase.from('photo_candidates').update({ status: 'superseded', reviewed_at: now }).eq('target_table', body.target_table).eq('target_key', body.target_key).eq('status', 'pending');
        const audit = { target_table: body.target_table, target_key: String(body.target_key), image_url: url, credit, license: licenseNote, source_url: sourceUrl || url, file_title: 'Added by you', score: 1, status: 'approved', reviewed_at: now, provider: 'manual' };
        let { error: aErr } = await supabase.from('photo_candidates').upsert(audit, { onConflict: 'target_table,target_key,image_url', ignoreDuplicates: true });
        if (aErr && /provider/i.test(aErr.message || '')) { delete audit.provider; await supabase.from('photo_candidates').upsert(audit, { onConflict: 'target_table,target_key,image_url', ignoreDuplicates: true }); }
        return json(200, { ok: true, photo_url: url });
      } catch (e) {
        return json(400, { error: e.message });
      }
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

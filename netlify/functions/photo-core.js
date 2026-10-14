const { createClient } = require('@supabase/supabase-js');
const { findCandidates } = require('./commons-photos');

// Species photos are capped below the 90% auto-approve line: a species photo always needs your click.
const SPECIES_SCORE_CAP = 0.85;
const RECHECK_DAYS = 30;

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function saveCandidates(supabase, table, key, list) {
  if (!list.length) return 0;
  const rows = list.map(c => ({ target_table: table, target_key: String(key), ...c, status: 'pending' }));
  const { error } = await supabase.from('photo_candidates').upsert(rows, { onConflict: 'target_table,target_key,image_url', ignoreDuplicates: true });
  if (error) throw error;
  return rows.length;
}

// Looks for photos for places/guides that have none. Stops at the time budget so it is safe
// inside a Netlify function. Returns counts for the admin page.
async function runFinder(supabase, fetchFn, { limit = 8, budgetMs = 20000 } = {}) {
  const started = Date.now();
  const summary = { checked: 0, with_candidates: 0, candidates: 0, errors: 0 };
  const cutoff = new Date(Date.now() - RECHECK_DAYS * 86400000).toISOString();
  const stale = 'photo_checked_at.is.null,photo_checked_at.lt.' + cutoff;

  const { data: places, error: pErr } = await supabase.from('points_of_interest')
    .select('id, name, island').eq('active', true).is('photo_url', null).or(stale).order('photo_checked_at', { ascending: true, nullsFirst: true }).limit(limit);
  if (pErr) throw pErr;
  const { data: species } = await supabase.from('guide_species')
    .select('id, common_name, scientific_name, queries, must_match').eq('active', true).is('photo_url', null).or(stale)
    .order('photo_checked_at', { ascending: true, nullsFirst: true }).limit(limit);

  const speciesJobs = [];
  for (const sp of species || []) {
    let re;
    try { re = new RegExp(sp.must_match, 'i'); } catch (e) { continue; }
    speciesJobs.push({ table: 'guide_species', key: sp.id, cap: SPECIES_SCORE_CAP, target: { name: sp.common_name, queries: sp.queries, mustMatch: re } });
  }
  // Keep a few slots for species so they are not starved while places are still being worked through.
  const speciesSlots = Math.min(speciesJobs.length, Math.max(2, Math.floor(limit / 3)));
  const jobs = [
    ...(places || []).slice(0, limit - speciesSlots).map(p => ({ table: 'points_of_interest', key: p.id, target: { name: p.name, island: p.island } })),
    ...speciesJobs.slice(0, speciesSlots),
  ];

  for (const job of jobs) {
    if (Date.now() - started > budgetMs) break;
    summary.checked++;
    try {
      let found = await findCandidates(job.target, fetchFn, 3);
      if (job.cap) found = found.map(c => ({ ...c, score: Math.min(c.score, job.cap) }));
      const n = await saveCandidates(supabase, job.table, job.key, found);
      if (n) { summary.with_candidates++; summary.candidates += n; }
      const keyCol = 'id';
      await supabase.from(job.table).update({ photo_checked_at: new Date().toISOString() }).eq(keyCol, job.key);
    } catch (e) {
      summary.errors++;
      console.error('photo finder error for', job.target.name, e.message);
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return summary;
}

module.exports = { runFinder, saveCandidates, SPECIES_SCORE_CAP, getSupabase };

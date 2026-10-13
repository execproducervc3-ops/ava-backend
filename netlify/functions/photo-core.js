const { createClient } = require('@supabase/supabase-js');
const { findCandidates } = require('./commons-photos');

// Wildlife guides cover many species, so each gets a hero photo of its best-known subject.
const SPECIES = {
  'wildlife-birds-svg': { queries: ['Amazona guildingii', 'Saint Vincent amazon'], mustMatch: /guildingii|vincent'?s? (amazon|parrot)/i },
  'wildlife-reptiles-amphibians-svg': { queries: ['Gonatodes daudini', 'Union Island gecko'], mustMatch: /daudini|union island gecko/i },
  'wildlife-marine-whales-turtles-svg': { queries: ['Tobago Cays turtle', 'Tobago Cays green turtle'], mustMatch: /tobago cays/i },
};
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
  const { data: guides } = await supabase.from('knowledge_deep_dives')
    .select('slug, title').in('slug', Object.keys(SPECIES)).is('photo_url', null).or(stale).limit(limit);

  const jobs = [
    ...(places || []).map(p => ({ table: 'points_of_interest', key: p.id, target: { name: p.name, island: p.island } })),
    ...(guides || []).map(g => ({ table: 'knowledge_deep_dives', key: g.slug, target: { name: g.title, ...SPECIES[g.slug] } })),
  ].slice(0, limit);

  for (const job of jobs) {
    if (Date.now() - started > budgetMs) break;
    summary.checked++;
    try {
      const found = await findCandidates(job.target, fetchFn, 3);
      const n = await saveCandidates(supabase, job.table, job.key, found);
      if (n) { summary.with_candidates++; summary.candidates += n; }
      const keyCol = job.table === 'points_of_interest' ? 'id' : 'slug';
      await supabase.from(job.table).update({ photo_checked_at: new Date().toISOString() }).eq(keyCol, job.key);
    } catch (e) {
      summary.errors++;
      console.error('photo finder error for', job.target.name, e.message);
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return summary;
}

module.exports = { runFinder, saveCandidates, SPECIES, getSupabase };

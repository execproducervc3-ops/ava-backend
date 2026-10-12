// Scheduled daily. Removes photo FILES older than the retention window and
// clears their links. Prices are never touched. Skips photos on items still
// awaiting review, promotions whose end date has not passed, and photos used
// by a sponsored placement.
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const RETENTION_DAYS = Math.max(14, parseInt(process.env.PHOTO_RETENTION_DAYS, 10) || 90);
const MAX_PHOTOS_PER_RUN = 150;

exports.handler = async () => {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
    const today = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10); // SVG date

    const { data: old, error } = await supabase.from('retail_offers')
      .select('id, photo_url, review_status, valid_until')
      .not('photo_url', 'is', null)
      .or(`photo_added_at.lt.${cutoff},and(photo_added_at.is.null,created_at.lt.${cutoff})`)
      .limit(2000);
    if (error) throw error;

    // A file can be shared by several items; it is only removed when none of
    // them is protected.
    const byUrl = new Map();
    for (const o of (old || [])) {
      const g = byUrl.get(o.photo_url) || { ids: [], protectedRow: false };
      g.ids.push(o.id);
      if (o.review_status === 'pending_review' || (o.valid_until && o.valid_until >= today)) g.protectedRow = true;
      byUrl.set(o.photo_url, g);
    }

    let removed = 0, skipped = 0;
    for (const [url, g] of byUrl) {
      if (removed >= MAX_PHOTOS_PER_RUN) break;
      if (g.protectedRow) { skipped++; continue; }
      // Items sharing this file that are NOT old (a newer item kept the same photo) protect it too.
      const { data: sharing } = await supabase.from('retail_offers').select('id').eq('photo_url', url).limit(500);
      if ((sharing || []).some(s => !g.ids.includes(s.id))) { skipped++; continue; }
      const { data: sp } = await supabase.from('sponsored_placements').select('id').eq('photo_url', url).limit(1);
      if (sp && sp.length) { skipped++; continue; }

      const match = url.match(/submission-photos\/([^?#]+)/);
      if (match) {
        const { error: rmErr } = await supabase.storage.from('submission-photos').remove([decodeURIComponent(match[1])]);
        if (rmErr) { console.error('photo-retention: remove failed:', rmErr.message); continue; }
      }
      await supabase.from('retail_offers').update({ photo_url: null }).eq('photo_url', url);
      removed++;
    }
    console.log(`photo-retention: retention ${RETENTION_DAYS} days, removed ${removed} photo(s), skipped ${skipped}`);
    return { statusCode: 200, body: JSON.stringify({ removed, skipped }) };
  } catch (err) {
    console.error('photo-retention failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};

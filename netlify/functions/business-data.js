// What one business has posted. Shared by the main-page panel (business-info.js)
// and the shareable /l/<id> page (share-page.js), so both follow the same rules:
//   - only approved listings (review_status auto_published or approved)
//   - only while the business's subscription is current (same as AVA's search)
//   - events: hidden once finished
//   - prices: shown with their age; older than STALE_DAYS are greyed; older than HIDE_DAYS are hidden
const STALE_DAYS = 14;
const HIDE_DAYS = 60;
const svgToday = () => new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);

async function getBusinessPostings(supabase, listing) {
  const out = { subscribed: false, offers: [], events: [] };
  if (!listing || !listing.subscribed_until || listing.subscribed_until < svgToday()) return out;
  out.subscribed = true;
  const now = Date.now();

  const { data: offers, error: oErr } = await supabase.from('retail_offers')
    .select('id, item_name, price, unit, photo_url, created_at')
    .eq('listing_id', listing.id).in('review_status', ['auto_published', 'approved'])
    .order('created_at', { ascending: false }).limit(80);
  if (oErr) throw oErr;
  out.offers = (offers || []).map(o => {
    const age = Math.max(0, Math.floor((now - new Date(o.created_at).getTime()) / 86400000));
    return { item_name: o.item_name, price: o.price, unit: o.unit, photo_url: o.photo_url, age_days: age, stale: age > STALE_DAYS };
  }).filter(o => o.age_days <= HIDE_DAYS).slice(0, 60);

  const { data: events, error: eErr } = await supabase.from('events')
    .select('title, description, starts_at, ends_at, time_known, venue, island, ticket_price, ticket_info, flyer_url')
    .eq('listing_id', listing.id).in('review_status', ['auto_published', 'approved'])
    .gte('starts_at', new Date(now - 24 * 3600 * 1000).toISOString())
    .order('starts_at', { ascending: true }).limit(30);
  if (eErr) throw eErr;
  out.events = (events || []).filter(r => {
    const end = r.ends_at ? new Date(r.ends_at) : new Date(new Date(r.starts_at).getTime() + 8 * 3600 * 1000);
    return end.getTime() >= now;
  }).slice(0, 15).map(r => ({
    title: r.title, description: r.description || null, venue: r.venue || null,
    when: formatWhen(r.starts_at, r.ends_at, r.time_known), ticket_price: r.ticket_price, ticket_info: r.ticket_info || null, flyer_url: r.flyer_url || null,
  }));
  return out;
}

function formatWhen(startsAt, endsAt, timeKnown) {
  const tz = 'America/St_Vincent';
  const start = new Date(startsAt);
  const day = start.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (!timeKnown) return `${day} (time not listed)`;
  const t = d => d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  return `${day}, ${t(start)}${endsAt ? ' to ' + t(new Date(endsAt)) : ''}`;
}

function ageText(days) { return days <= 0 ? 'updated today' : days === 1 ? 'updated yesterday' : `updated ${days} days ago`; }

module.exports = { getBusinessPostings, ageText, STALE_DAYS, HIDE_DAYS };

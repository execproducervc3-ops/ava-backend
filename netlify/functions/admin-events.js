// Admin API for events and promoter subscriptions.
// Auth is the same admin password check the other admin functions use.
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });
const ISLANDS = ['Saint Vincent', 'Bequia', 'Mustique', 'Canouan', 'Mayreau', 'Union Island', 'Palm Island', 'Petit Saint Vincent', 'Tobago Cays'];
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(new Date(s + 'T12:00:00-04:00').getTime());
const isTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');

async function checkAuth(pw){
  const { data } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  const hash = data ? data.password_hash : null;
  return !!(hash && pw && await bcrypt.compare(pw, hash));
}

const EVENT_COLS = 'id, title, description, starts_at, ends_at, time_known, venue, island, ticket_price, ticket_info, flyer_url, review_status, flag_reason, created_at, directory_listings(name, island, subscribed_until)';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const pw = (event.headers || {})['x-admin-secret'] || (event.headers || {})['X-Admin-Secret'];
  if (!(await checkAuth(pw))) return json(401, { error: 'Unauthorized' });

  try {
    const params = event.queryStringParameters || {};
    const action = params.action;

    if (event.httpMethod === 'GET' && action === 'list_events') {
      const view = params.view === 'upcoming' ? 'upcoming' : 'pending';
      let q = supabase.from('events').select(EVENT_COLS);
      if (view === 'pending') q = q.eq('review_status', 'pending_review').order('created_at', { ascending: true });
      else q = q.in('review_status', ['auto_published', 'approved']).gte('starts_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()).order('starts_at', { ascending: true });
      const { data, error } = await q.limit(200);
      if (error) throw error;
      return json(200, { events: data || [], islands: ISLANDS });
    }

    if (event.httpMethod === 'GET' && action === 'list_subscribers') {
      const { data, error } = await supabase.from('directory_listings')
        .select('id, name, category, island, subscribed_until').not('subscribed_until', 'is', null).order('subscribed_until', { ascending: true }).limit(300);
      if (error) throw error;
      return json(200, { subscribers: data || [] });
    }

    if (event.httpMethod === 'GET' && action === 'search_listings') {
      const term = String(params.q || '').trim();
      if (term.length < 2) return json(200, { results: [] });
      const { data, error } = await supabase.from('directory_listings')
        .select('id, name, category, island, subscribed_until').ilike('name', `%${term}%`).limit(15);
      if (error) throw error;
      return json(200, { results: data || [] });
    }

    if (event.httpMethod === 'POST' && action === 'set_subscription') {
      const body = JSON.parse(event.body || '{}');
      if (!body.listing_id) return json(400, { error: 'listing_id is required' });
      let until = null;
      if (body.subscribed_until) {
        if (!isDate(body.subscribed_until)) return json(400, { error: 'subscribed_until must be a date like 2026-12-31' });
        until = body.subscribed_until;
      }
      const { data: listing } = await supabase.from('directory_listings').select('id').eq('id', body.listing_id).maybeSingle();
      if (!listing) return json(404, { error: 'Listing not found' });
      const { error } = await supabase.from('directory_listings').update({ subscribed_until: until }).eq('id', body.listing_id);
      if (error) throw error;
      return json(200, { ok: true });
    }

    if (event.httpMethod === 'POST' && (action === 'approve_event' || action === 'reject_event')) {
      const body = JSON.parse(event.body || '{}');
      const { data: ev } = await supabase.from('events').select('id, review_status').eq('id', body.id).maybeSingle();
      if (!ev) return json(404, { error: 'Event not found' });

      if (action === 'reject_event') {
        await supabase.from('events').update({ review_status: 'rejected' }).eq('id', ev.id);
        return json(200, { ok: true });
      }
      if (ev.review_status === 'rejected') return json(409, { error: 'This event was rejected.' });

      const edits = body.edits || {};
      const update = { review_status: 'approved', flag_reason: null };
      if (edits.title !== undefined) {
        const t = String(edits.title).trim().slice(0, 150);
        if (!t) return json(400, { error: 'Title cannot be empty' });
        update.title = t;
      }
      if (edits.date !== undefined) {
        if (!isDate(edits.date)) return json(400, { error: 'A valid date is required' });
        const time = isTime(edits.time) ? edits.time : null;
        update.starts_at = new Date(`${edits.date}T${time || '12:00'}:00-04:00`).toISOString();
        update.time_known = !!time;
        update.ends_at = null;
        if (time && isTime(edits.end_time)) {
          const endDate = edits.end_time > time ? edits.date : new Date(new Date(edits.date + 'T12:00:00-04:00').getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
          update.ends_at = new Date(`${endDate}T${edits.end_time}:00-04:00`).toISOString();
        }
      }
      if (edits.venue !== undefined) update.venue = String(edits.venue).trim().slice(0, 150) || null;
      if (edits.description !== undefined) update.description = String(edits.description).trim().slice(0, 400) || null;
      if (edits.ticket_info !== undefined) update.ticket_info = String(edits.ticket_info).trim().slice(0, 200) || null;
      if (edits.ticket_price !== undefined) {
        if (edits.ticket_price === '' || edits.ticket_price === null) update.ticket_price = null;
        else {
          const n = Number(edits.ticket_price);
          if (!isFinite(n) || n < 0 || n >= 100000) return json(400, { error: 'Ticket price must be a number' });
          update.ticket_price = n;
        }
      }
      if (edits.island !== undefined) {
        const isl = ISLANDS.find(i => i.toLowerCase() === String(edits.island).trim().toLowerCase());
        if (edits.island && !isl) return json(400, { error: 'Island must be one of: ' + ISLANDS.join(', ') });
        update.island = isl || null;
      }
      const { error } = await supabase.from('events').update(update).eq('id', ev.id);
      if (error) throw error;
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('admin-events error:', err);
    return json(500, { error: err.message });
  }
};

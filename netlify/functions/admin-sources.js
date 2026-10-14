// Admin API for the source watcher. Needs the admin password. It never changes
// AVA's live content: "noted" and "dismissed" only mark your review of a change.
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const core = require('./source-core');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });
const PAGE = 25;

async function checkAuth(pw){
  const { data } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  const hash = data ? data.password_hash : null;
  return !!(hash && pw && await bcrypt.compare(pw, hash));
}

function cleanSource(b){
  const url = String(b.url || '').trim();
  if(!core.isSafeUrl(url)) return { error: `"${url.slice(0, 80)}" is not a valid public http(s) address.` };
  const name = String(b.name || '').trim().slice(0, 160) || new URL(url).hostname;
  const area = core.AREAS.includes(b.area) ? b.area : 'general';
  const days = Math.min(90, Math.max(1, parseInt(b.check_every_days, 10) || 7));
  return { row: { url, name, area, check_every_days: days, origin: b.origin || 'admin' } };
}

exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const pw = (event.headers || {})['x-admin-secret'] || (event.headers || {})['X-Admin-Secret'];
  if(!(await checkAuth(pw))) return json(401, { error: 'Unauthorized' });
  try{
    const params = event.queryStringParameters || {};
    const action = params.action;

    if(event.httpMethod === 'GET' && action === 'stats'){
      const head = q => q.then(r => r.count || 0);
      const [total, active, pending, failing, blocked, unanalysed] = await Promise.all([
        head(supabase.from('watched_sources').select('id', { count: 'exact', head: true })),
        head(supabase.from('watched_sources').select('id', { count: 'exact', head: true }).eq('active', true)),
        head(supabase.from('source_changes').select('id', { count: 'exact', head: true }).eq('status', 'pending')),
        head(supabase.from('watched_sources').select('id', { count: 'exact', head: true }).eq('active', true).gte('fail_count', 3)),
        head(supabase.from('watched_sources').select('id', { count: 'exact', head: true }).eq('last_status', 'blocked_by_robots')),
        head(supabase.from('source_changes').select('id', { count: 'exact', head: true }).eq('status', 'pending').neq('analysis_status', 'analysed')),
      ]);
      return json(200, { total, active, pending_changes: pending, failing, blocked, unanalysed });
    }

    if(event.httpMethod === 'GET' && action === 'changes'){
      const status = ['pending', 'noted', 'dismissed'].includes(params.status) ? params.status : 'pending';
      const page = Math.max(0, parseInt(params.page, 10) || 0);
      const { data, count, error } = await supabase.from('source_changes')
        .select('id, source_id, detected_at, kind, added_text, removed_text, summary, relevant, facts, relevant_to, analysis_status, status, note', { count: 'exact' })
        .eq('status', status).order('detected_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
      if(error) throw error;
      const ids = [...new Set((data || []).map(c => c.source_id))];
      const { data: srcs } = ids.length ? await supabase.from('watched_sources').select('id, name, url, area').in('id', ids) : { data: [] };
      const byId = new Map((srcs || []).map(s => [s.id, s]));
      return json(200, { total: count || 0, page_size: PAGE, changes: (data || []).map(c => Object.assign({}, c, { source: byId.get(c.source_id) || null })) });
    }

    if(event.httpMethod === 'GET' && action === 'sources'){
      const page = Math.max(0, parseInt(params.page, 10) || 0);
      let q = supabase.from('watched_sources')
        .select('id, url, name, area, check_every_days, active, last_checked_at, last_changed_at, last_status, last_error, fail_count', { count: 'exact' });
      if(params.filter === 'failing') q = q.gte('fail_count', 3);
      else if(params.filter === 'blocked') q = q.eq('last_status', 'blocked_by_robots');
      else if(params.filter === 'inactive') q = q.eq('active', false);
      const term = String(params.q || '').trim().replace(/[%,()]/g, ' ').slice(0, 60);
      if(term) q = q.or(`name.ilike.%${term}%,url.ilike.%${term}%`);
      const { data, count, error } = await q.order('name', { ascending: true }).range(page * PAGE, page * PAGE + PAGE - 1);
      if(error) throw error;
      return json(200, { total: count || 0, page_size: PAGE, sources: data || [], areas: core.AREAS });
    }

    if(event.httpMethod !== 'POST') return json(400, { error: 'Unknown action' });
    const body = JSON.parse(event.body || '{}');

    if(action === 'add_source' || action === 'add_many'){
      const items = action === 'add_many' ? (Array.isArray(body.items) ? body.items.slice(0, 100) : []) : [body];
      const rows = [], bad = [];
      for(const it of items){
        const c = cleanSource(Object.assign({}, it, { area: it.area || body.area, check_every_days: it.check_every_days || body.check_every_days }));
        if(c.error) bad.push(c.error); else rows.push(c.row);
      }
      if(!rows.length) return json(400, { error: bad[0] || 'Nothing to add' });
      const urls = rows.map(r => r.url);
      const { data: existing } = await supabase.from('watched_sources').select('url').in('url', urls);
      const have = new Set((existing || []).map(r => r.url));
      const fresh = rows.filter(r => !have.has(r.url));
      if(fresh.length){
        const { error } = await supabase.from('watched_sources').upsert(fresh, { onConflict: 'url', ignoreDuplicates: true });
        if(error) throw error;
      }
      return json(200, { ok: true, added: fresh.length, already_watched: rows.length - fresh.length, rejected: bad.length });
    }

    if(action === 'update_source'){
      const patch = {};
      if(typeof body.active === 'boolean') patch.active = body.active;
      if(body.check_every_days !== undefined) patch.check_every_days = Math.min(90, Math.max(1, parseInt(body.check_every_days, 10) || 7));
      if(typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 160);
      if(core.AREAS.includes(body.area)) patch.area = body.area;
      if(body.active === true) patch.fail_count = 0;
      if(!Object.keys(patch).length) return json(400, { error: 'Nothing to update' });
      const { error } = await supabase.from('watched_sources').update(patch).eq('id', body.id);
      if(error) throw error;
      return json(200, { ok: true });
    }

    if(action === 'delete_source'){
      // Removes the page from the watch list (and its change history). Confirmed in the UI.
      const { error } = await supabase.from('watched_sources').delete().eq('id', body.id);
      if(error) throw error;
      return json(200, { ok: true });
    }

    if(action === 'check_now' || action === 'run'){
      if(action === 'check_now'){
        const { data: src } = await supabase.from('watched_sources')
          .select('id, url, name, last_hash, last_text, last_checked_at, check_every_days, fail_count').eq('id', body.id).maybeSingle();
        if(!src) return json(404, { error: 'Source not found' });
        const ctx = { supabase, fetchFn: fetch, apiKey: process.env.ANTHROPIC_API_KEY, robots: new Map(), claudeLeft: 1 };
        const r = await core.checkSource(ctx, src);
        return json(200, { ok: true, result: r });
      }
      const limit = Math.min(10, Math.max(1, parseInt(body.limit, 10) || 8));
      const out = await core.runWatcher(supabase, fetch, { limit, budgetMs: 18000, claudeMax: 3, apiKey: process.env.ANTHROPIC_API_KEY });
      delete out.results;
      return json(200, { ok: true, summary: out });
    }

    if(action === 'discover'){
      let url = body.url;
      if(body.id){
        const { data: src } = await supabase.from('watched_sources').select('url').eq('id', body.id).maybeSingle();
        if(!src) return json(404, { error: 'Source not found' });
        url = src.url;
      }
      const links = await core.discoverLinks(fetch, String(url || ''), 80);
      const { data: existing } = links.length ? await supabase.from('watched_sources').select('url').in('url', links.map(l => l.url)) : { data: [] };
      const have = new Set((existing || []).map(r => r.url));
      return json(200, { ok: true, from: url, candidates: links.filter(l => !have.has(l.url)) });
    }

    if(action === 'review_change'){
      if(!['noted', 'dismissed', 'pending'].includes(body.status)) return json(400, { error: 'Bad status' });
      const { error } = await supabase.from('source_changes').update({
        status: body.status, note: typeof body.note === 'string' ? body.note.slice(0, 500) : null,
        reviewed_at: body.status === 'pending' ? null : new Date().toISOString(),
      }).eq('id', body.id);
      if(error) throw error;
      return json(200, { ok: true });
    }

    if(action === 'analyse_change'){
      const { data: ch } = await supabase.from('source_changes').select('*').eq('id', body.id).maybeSingle();
      if(!ch) return json(404, { error: 'Change not found' });
      if(ch.kind !== 'text' || !ch.added_text) return json(400, { error: 'Nothing to analyse for this change' });
      const { data: src } = await supabase.from('watched_sources').select('name, url').eq('id', ch.source_id).maybeSingle();
      const a = await core.analyseChange(fetch, process.env.ANTHROPIC_API_KEY, src || { name: '', url: '' }, ch.added_text.split('\n'), (ch.removed_text || '').split('\n').filter(Boolean));
      if(!a) return json(502, { error: 'The analysis did not return a usable answer. Try again.' });
      const patch = { analysis_status: 'analysed', relevant: a.relevant, summary: a.summary, facts: a.facts, relevant_to: a.relevant_to };
      const { error } = await supabase.from('source_changes').update(patch).eq('id', ch.id);
      if(error) throw error;
      return json(200, { ok: true, analysis: a });
    }

    return json(400, { error: 'Unknown action' });
  } catch(err){
    console.error('admin-sources error:', err);
    return json(500, { error: err.message });
  }
};

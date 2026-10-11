// Review API for agent drafts. Agents only write to agent_drafts; nothing
// reaches live tables except through "approve" here, which needs the admin password.
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const core = require('./agent-core');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

async function checkAuth(pw){
  const { data } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  const hash = data ? data.password_hash : null;
  return !!(hash && pw && await bcrypt.compare(pw, hash));
}

async function resolveGap(text){
  if(text) await supabase.from('unanswered_queries').update({ resolved: true }).ilike('query_text', text);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const pw = (event.headers || {})['x-admin-secret'] || (event.headers || {})['X-Admin-Secret'];
  if (!(await checkAuth(pw))) return json(401, { error: 'Unauthorized' });

  try {
    const params = event.queryStringParameters || {};
    const action = params.action;

    if (event.httpMethod === 'GET' && action === 'list') {
      const status = ['pending', 'approved', 'rejected'].includes(params.status) ? params.status : 'pending';
      const { data, error } = await supabase.from('agent_drafts').select('*')
        .eq('status', status).order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      return json(200, { drafts: data || [], categories: { poi: core.POI_CATEGORIES, reference: core.REFERENCE_CATEGORIES }, islands: core.ISLANDS });
    }

    if (event.httpMethod === 'POST' && ['approve', 'reject', 'run'].includes(action)) {
      const body = JSON.parse(event.body || '{}');

      if (action === 'run') {
        if (body.agent === 'data_quality') {
          return json(200, { ok: true, summary: await core.runDataQuality() });
        }
        if (body.agent === 'gap_research') {
          await core.triggerBackground('agent-gap-research-background');
          return json(200, { ok: true, message: 'Gap research started. New drafts appear here in a few minutes.' });
        }
        return json(400, { error: 'Unknown agent' });
      }

      const { data: draft, error: gErr } = await supabase.from('agent_drafts').select('*').eq('id', body.id).maybeSingle();
      if (gErr) throw gErr;
      if (!draft) return json(404, { error: 'Draft not found' });
      if (draft.status !== 'pending') return json(409, { error: `Draft already ${draft.status}` });
      const payload = draft.payload || {};
      const now = new Date().toISOString();

      if (action === 'reject') {
        if (body.dismiss_gap) await resolveGap(payload.resolve_gap_text || draft.subject);
        await supabase.from('agent_drafts').update({ status: 'rejected', reviewed_at: now }).eq('id', draft.id);
        return json(200, { ok: true });
      }

      // approve
      let published = 0;
      if (draft.kind === 'poi') {
        // Reviewer may have edited the places; validate again on the server.
        const places = Array.isArray(body.places) ? body.places : payload.places || [];
        const keep = body.include_only ? places.filter((_, i) => body.include_only.includes(i)) : places;
        if (!keep.length) return json(400, { error: 'No places selected' });
        for (const p of keep) {
          const island = core.islandOf(p.island);
          const name = String(p.name || '').trim();
          const description = String(p.description || '').trim();
          if (!name || !island || !core.POI_CATEGORIES.includes(p.category) || description.length < 40) {
            return json(400, { error: `Invalid place "${name || '(no name)'}": needs name, valid island and category, and a description of at least 40 characters.` });
          }
        }
        for (const p of keep) {
          const island = core.islandOf(p.island);
          const name = String(p.name).trim();
          const row = {
            name, category: p.category, island, description: String(p.description).trim(),
            source_url: core.cleanSources(p.sources)[0] || null, last_verified_at: now, active: true,
          };
          const { data: existing } = await supabase.from('points_of_interest').select('id').ilike('name', name).eq('island', island).maybeSingle();
          const { error } = existing
            ? await supabase.from('points_of_interest').update(row).eq('id', existing.id)
            : await supabase.from('points_of_interest').insert(row);
          if (error) throw error;
          published++;
        }
        await resolveGap(draft.subject);
      } else if (draft.kind === 'reference') {
        const category = body.category || payload.category;
        const title = String(body.title || payload.title || '').trim();
        const summary = String(body.summary || payload.summary || '').trim();
        if (!core.REFERENCE_CATEGORIES.includes(category) || !title || !summary) return json(400, { error: 'Valid category, title and summary are required' });
        // Never overwrite an existing active overview.
        const { data: exists } = await supabase.from('reference_knowledge').select('category, active').eq('category', category).maybeSingle();
        if (exists && exists.active !== false) return json(409, { error: `A "${category}" overview already exists; approving would replace it. Reject this draft or write a deep dive instead.` });
        const source = core.cleanSources(payload.sources)[0] || null;
        const { error } = await supabase.from('reference_knowledge')
          .upsert({ category, title, summary, source_url: source, last_verified_at: now, active: true }, { onConflict: 'category' });
        if (error) throw error;
        published = 1;
        await resolveGap(draft.subject);
      } else {
        // finding: acknowledge only; no data changes
        await resolveGap(payload.resolve_gap_text);
      }

      await supabase.from('agent_drafts').update({ status: 'approved', reviewed_at: now }).eq('id', draft.id);
      return json(200, { ok: true, published });
    }

    return json(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('admin-agent error:', err);
    return json(500, { error: err.message });
  }
};
